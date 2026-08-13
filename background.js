"use strict";

/* ==========================================================================
   Rewind Chat — Next Fit
   Service worker: única ponte com a internet da extensão. O content script
   não pode chamar a API do Gemini diretamente (CSP da página do Freshchat),
   então ele manda mensagem para cá e a gente faz o fetch por aqui.
   ========================================================================== */

async function obterChaveSalva() {
  const { geminiKey } = await chrome.storage.local.get("geminiKey");
  return geminiKey || "";
}

// Se o agente ainda não configurou a chave pelo painel, tenta usar o valor
// padrão de config.local.js (arquivo local, fora do git) como conveniência.
// Falha em silêncio se o arquivo não existir — não é obrigatório.
async function semearChaveDoConfigLocal() {
  try {
    const resp = await fetch(chrome.runtime.getURL("config.local.js"));
    if (!resp.ok) return "";
    const texto = await resp.text();
    const match = texto.match(/iaKey\s*:\s*["']([^"']+)["']/);
    if (!match || !match[1]) return "";
    await chrome.storage.local.set({ geminiKey: match[1] });
    return match[1];
  } catch (_) {
    return "";
  }
}

// Converte em base64 sem usar spread (arquivos de áudio maiores estourariam
// a pilha de chamadas do String.fromCharCode(...bytes)).
function arrayBufferParaBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const TAMANHO_BLOCO = 0x8000;
  let binario = "";
  for (let i = 0; i < bytes.length; i += TAMANHO_BLOCO) {
    binario += String.fromCharCode.apply(null, bytes.subarray(i, i + TAMANHO_BLOCO));
  }
  return btoa(binario);
}

// O content script só manda a URL do áudio (placeholder {audioUrl}); o
// download precisa acontecer aqui porque um fetch cross-origin feito pelo
// content script ainda esbarra no CSP/CORS da própria página do Freshchat.
async function baixarAudioBase64(url) {
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  const mimeType = resp.headers.get("content-type") || "audio/ogg";
  return { base64: arrayBufferParaBase64(buffer), mimeType };
}

async function resolverPartes(partes) {
  return Promise.all(
    (partes || []).map(async (parte) => {
      if (!parte.audioUrl) return parte;
      try {
        const { base64, mimeType } = await baixarAudioBase64(parte.audioUrl);
        return { inlineData: { mimeType, data: base64 } };
      } catch (erro) {
        return { text: "[Não foi possível baixar este áudio para transcrição]" };
      }
    })
  );
}

async function gerarResumoIA(apiKey, partes) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
    apiKey
  )}`;

  const partesResolvidas = await resolverPartes(partes);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: partesResolvidas }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
    }),
  });

  if (!resp.ok) {
    const corpo = await resp.text().catch(() => "");
    let dica = "";
    if (resp.status === 400) dica = " (chave da API do Gemini inválida)";
    if (resp.status === 429)
      dica = " (limite de uso da IA atingido, tente novamente em instantes)";
    throw new Error(`A IA retornou ${resp.status}${dica}. ${corpo}`);
  }

  const dados = await resp.json();
  const cand = dados.candidates && dados.candidates[0];
  if (!cand) {
    throw new Error("A IA não retornou nenhum resultado. Tente novamente.");
  }

  const texto = ((cand.content && cand.content.parts) || [])
    .map((p) => p.text || "")
    .join("")
    .trim();

  if (!texto) {
    const motivo = cand.finishReason ? ` (motivo: ${cand.finishReason})` : "";
    throw new Error(`A IA não gerou texto${motivo}.`);
  }
  return texto;
}

chrome.runtime.onMessage.addListener((mensagem, _sender, sendResponse) => {
  if (mensagem?.type === "rwc-obter-config-inicial") {
    (async () => {
      const existente = await obterChaveSalva();
      const geminiKey = existente || (await semearChaveDoConfigLocal());
      sendResponse({ geminiKey });
    })();
    return true; // resposta assíncrona
  }

  if (mensagem?.type === "rwc-gerar-resumo") {
    (async () => {
      try {
        const apiKey = mensagem.apiKey || (await obterChaveSalva());
        if (!apiKey) {
          sendResponse({
            ok: false,
            error: "Nenhuma chave de API do Gemini configurada.",
          });
          return;
        }
        const texto = await gerarResumoIA(apiKey, mensagem.parts);
        sendResponse({ ok: true, text: texto });
      } catch (erro) {
        sendResponse({
          ok: false,
          error: erro.message || "Ocorreu um erro inesperado.",
        });
      }
    })();
    return true; // resposta assíncrona
  }

  return false;
});
