"use strict";

/* ==========================================================================
   Rewind Chat — Next Fit
   Painel lateral: lê um atendimento e gera o resumo com IA.
   ========================================================================== */

/* ==========================================================================
   Elementos
   ========================================================================== */
const el = {
  linkInput: document.getElementById("linkInput"),
  typeSelector: document.getElementById("typeSelector"),
  generateBtn: document.getElementById("generateBtn"),
  status: document.getElementById("status"),
  resultCard: document.getElementById("resultCard"),
  resultTag: document.getElementById("resultTag"),
  resultText: document.getElementById("resultText"),
  copyBtn: document.getElementById("copyBtn"),
};

let tipoSelecionado = "breve";

/* ==========================================================================
   Configurações (salvas em chrome.storage.local)
   ========================================================================== */
async function carregarConfig() {
  const cfg = await chrome.storage.local.get([
    "iaKey",
    "atendimentoToken",
    "atendimentoBase",
  ]);

  // Primeira vez (nada salvo ainda): usa os valores de config.local.js como padrão.
  const nadaSalvo =
    !cfg.iaKey && !cfg.atendimentoToken && !cfg.atendimentoBase;
  if (nadaSalvo && window.APP_CONFIG) {
    const padrao = window.APP_CONFIG;
    const base = padrao.atendimentoDomain
      ? `https://${padrao.atendimentoDomain.trim().replace(/\/+$/, "")}/v2`
      : "";
    if (padrao.iaKey || padrao.atendimentoToken || base) {
      cfg.iaKey = padrao.iaKey || "";
      cfg.atendimentoToken = padrao.atendimentoToken || "";
      cfg.atendimentoBase = base;
      await chrome.storage.local.set(cfg);
    }
  }

  return cfg;
}

/* ==========================================================================
   Atendimento: extrair ID e buscar mensagens
   ========================================================================== */
function extrairConversationId(entrada) {
  const txt = (entrada || "").trim();
  // Procura um UUID no link (formato padrão de conversation_id do atendimento)
  const uuid = txt.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  );
  if (uuid) return uuid[0];

  // Se não achou UUID, tenta o último trecho da URL
  try {
    const url = new URL(txt);
    const partes = url.pathname.split("/").filter(Boolean);
    if (partes.length) return partes[partes.length - 1];
  } catch (_) {
    /* não é URL — segue */
  }
  // Como último recurso, assume que o usuário colou o próprio ID
  return txt;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Links do CRM (myfreshworks.com/crm/messaging/...) trazem o ID interno
// numérico da conversa, não o UUID que a API de mensagens exige. O endpoint
// GET /conversations/{id} aceita os dois formatos e devolve o UUID real.
async function resolverConversationId(base, token, idBruto) {
  if (UUID_RE.test(idBruto)) return idBruto;

  const resp = await fetch(`${base}/conversations/${idBruto}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!resp.ok) {
    const corpo = await resp.text().catch(() => "");
    throw new Error(
      `Não foi possível localizar a conversa (${resp.status}). ${corpo}`
    );
  }

  const dados = await resp.json();
  if (!dados.conversation_id) {
    throw new Error(
      "A conversa foi encontrada, mas sem conversation_id na resposta."
    );
  }
  return dados.conversation_id;
}

async function buscarConversa(base, token, conversationIdBruto) {
  const conversationId = await resolverConversationId(
    base,
    token,
    conversationIdBruto
  );

  let pagina = 1;
  let todas = [];
  let continuar = true;
  const porPagina = 50;

  while (continuar && pagina <= 30) {
    const url = `${base}/conversations/${conversationId}/messages?page=${pagina}&items_per_page=${porPagina}`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!resp.ok) {
      const corpo = await resp.text().catch(() => "");
      let dica = "";
      if (resp.status === 401 || resp.status === 403)
        dica = " (token de atendimento inválido ou sem permissão)";
      if (resp.status === 404)
        dica = " (conversa não encontrada — confira o link e a URL base)";
      throw new Error(`A plataforma retornou ${resp.status}${dica}. ${corpo}`);
    }

    const dados = await resp.json();
    const msgs = dados.messages || [];
    todas = todas.concat(msgs);

    if (msgs.length < porPagina) continuar = false;
    else pagina++;
  }

  if (!todas.length) {
    throw new Error(
      "Nenhuma mensagem encontrada nessa conversa. Verifique se o link/ID está correto."
    );
  }
  return todas;
}

function montarTranscricao(mensagens) {
  const ordenadas = mensagens.slice().sort((a, b) => {
    return new Date(a.created_time || 0) - new Date(b.created_time || 0);
  });

  const linhas = ordenadas
    .map((m) => {
      let quem;
      if (m.actor_type === "agent") quem = "Agente";
      else if (m.actor_type === "user") quem = "Cliente";
      else if (m.actor_type === "system") quem = "Sistema";
      else quem = m.actor_type || "Desconhecido";

      const partes = (m.message_parts || [])
        .map((p) => {
          if (p.text && p.text.content) return p.text.content;
          if (p.image) return "[imagem]";
          if (p.file) return `[arquivo: ${p.file.name || "anexo"}]`;
          if (p.url && p.url.url) return p.url.url;
          if (p.reply) return p.reply.label || "";
          return "";
        })
        .filter(Boolean)
        .join(" ");

      return partes ? `${quem}: ${partes}` : null;
    })
    .filter(Boolean);

  return linhas.join("\n");
}

/* ==========================================================================
   Prompts
   ========================================================================== */
function montarPrompt(tipo, transcricao) {
  const contexto = `Você é um assistente especializado em SUPORTE TÉCNICO de um sistema de gestão para academias (NextFit). Abaixo está a transcrição completa de um atendimento anterior feito no suporte. As mensagens estão em ordem cronológica, identificadas por "Cliente:", "Agente:" ou "Sistema:".

Seu trabalho é ajudar um atendente que vai assumir ou revisar esse atendimento a entender rapidamente o que foi conversado. Baseie-se SOMENTE no conteúdo da transcrição — não invente informações que não estão presentes.

NÃO inclua informações que o atendente já tem disponíveis em outro lugar, como: canal/plataforma do atendimento, nome do cliente que abriu o contato, nome do agente, ou qualquer dado de sistema/metadado. O foco é o CONTEÚDO do que foi discutido: qual módulo do sistema foi abordado, nome do aluno/dados informados pelo cliente (quando fizerem parte do problema relatado), dúvidas levantadas, respostas e soluções dadas.

Responda em português do Brasil, de forma clara e objetiva. Não use saudações nem despedidas, vá direto ao resumo.`;

  const instrucoes = {
    breve: `TIPO DE RESUMO: BREVE
Em tópicos curtos, para o atendente bater o olho e entender na hora. Use exatamente esta estrutura:
- **Dor do cliente:** qual o problema/necessidade relatado (inclua módulo do sistema e dados relevantes, ex: nome do aluno, se citados).
- **O que foi abordado:** o que já foi discutido, verificado ou orientado até agora.
- **O que falta resolver:** pendência, status atual ou próximo passo.
Frases curtas e diretas, sem floreios. No máximo ~15 palavras por tópico.`,

    normal: `TIPO DE RESUMO: NORMAL
Resumo objetivo do atendimento, informando o necessário para quem for continuar o caso. Use exatamente esta estrutura (mesmo padrão usado pela IA da empresa):
- **Motivo do contato:** o que o cliente queria/qual o problema, com o módulo do sistema e dados relevantes (ex: nome do aluno) quando fizerem parte do relato.
- **O que já foi feito:** as principais ações e orientações do agente durante o atendimento.
- **Pendências:** o que ainda falta resolver ou aguardar.
- **Tom do usuário:** como o cliente se comportou/expressou (ex: neutro, insatisfeito, satisfeito, impaciente).
Seja conciso — sem repetir informação.`,

    detalhado: `TIPO DE RESUMO: DETALHADO
O foco aqui é detalhar tudo o que foi discutido no atendimento, para outro atendente entender o caso a fundo sem reler a conversa inteira. Organize assim:
- **Motivo do contato:** o problema/dúvida inicial, com módulo do sistema e dados relevantes (ex: nome do aluno) quando citados.
- **Assuntos abordados:** cada dúvida ou ponto tratado na conversa, com detalhe do que foi perguntado.
- **Como foi resolvido/orientado:** a resposta, solução ou instrução dada para cada ponto acima.
- **Pendências:** o que ficou em aberto, sem solução, ou aguardando algo/alguém.
Traga o máximo de detalhe relevante sobre o CONTEÚDO conversado. Se algum tópico não tiver informação na conversa, escreva "Não informado".`,
  };

  return `${contexto}

${instrucoes[tipo]}

=== TRANSCRIÇÃO DO ATENDIMENTO ===
${transcricao}
=== FIM DA TRANSCRIÇÃO ===`;
}

/* ==========================================================================
   Geração do resumo (IA)
   ========================================================================== */
async function gerarResumoIA(iaKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
    iaKey
  )}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
    }),
  });

  if (!resp.ok) {
    const corpo = await resp.text().catch(() => "");
    let dica = "";
    if (resp.status === 400)
      dica = " (chave de IA inválida ou requisição incorreta)";
    if (resp.status === 429) dica = " (limite de uso da IA atingido)";
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

/* ==========================================================================
   Formatação simples de **negrito** para exibição
   ========================================================================== */
function formatarSaida(texto) {
  const escapado = texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escapado.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

/* ==========================================================================
   Estados de tela
   ========================================================================== */
function mostrarStatus(tipo, mensagem) {
  el.status.className = `status-area ${tipo}`;
  el.status.classList.remove("hidden");
  if (tipo === "loading") {
    el.status.innerHTML = `<span class="spinner"></span><span>${mensagem}</span>`;
  } else {
    el.status.textContent = mensagem;
  }
}
function esconderStatus() {
  el.status.classList.add("hidden");
}

/* ==========================================================================
   Fluxo principal
   ========================================================================== */
async function gerar() {
  esconderStatus();
  el.resultCard.classList.add("hidden");

  const cfg = await chrome.storage.local.get([
    "iaKey",
    "atendimentoToken",
    "atendimentoBase",
  ]);

  if (!cfg.iaKey || !cfg.atendimentoToken || !cfg.atendimentoBase) {
    mostrarStatus(
      "error",
      "Chaves não configuradas. Preencha config.local.js e recarregue a extensão."
    );
    return;
  }

  const link = el.linkInput.value.trim();
  if (!link) {
    mostrarStatus("error", "Cole o link do atendimento.");
    return;
  }

  const conversationId = extrairConversationId(link);

  el.generateBtn.disabled = true;
  try {
    mostrarStatus("loading", "Lendo a conversa do atendimento...");
    const mensagens = await buscarConversa(
      cfg.atendimentoBase,
      cfg.atendimentoToken,
      conversationId
    );
    const transcricao = montarTranscricao(mensagens);

    mostrarStatus("loading", "Gerando o resumo...");
    const prompt = montarPrompt(tipoSelecionado, transcricao);
    const resumo = await gerarResumoIA(cfg.iaKey, prompt);

    esconderStatus();
    const rotulos = {
      breve: "Resumo breve",
      normal: "Resumo normal",
      detalhado: "Resumo detalhado",
    };
    el.resultTag.textContent = rotulos[tipoSelecionado];
    el.resultText.innerHTML = formatarSaida(resumo);
    el.resultText.dataset.raw = resumo;
    el.resultCard.classList.remove("hidden");
  } catch (erro) {
    console.error(erro);
    mostrarStatus("error", erro.message || "Ocorreu um erro inesperado.");
  } finally {
    el.generateBtn.disabled = false;
  }
}

/* ==========================================================================
   Eventos
   ========================================================================== */
el.typeSelector.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  [...el.typeSelector.children].forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  tipoSelecionado = btn.dataset.type;
});

el.generateBtn.addEventListener("click", gerar);
el.linkInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") gerar();
});

el.copyBtn.addEventListener("click", async () => {
  const texto = el.resultText.dataset.raw || el.resultText.textContent;
  try {
    await navigator.clipboard.writeText(texto);
    const original = el.copyBtn.querySelector("span").textContent;
    el.copyBtn.querySelector("span").textContent = "Copiado!";
    setTimeout(
      () => (el.copyBtn.querySelector("span").textContent = original),
      1500
    );
  } catch (_) {
    /* ignora */
  }
});

carregarConfig();
