(function () {
  "use strict";

  const SELECTORS = {
    messageItem: "li.user-messages",
    agentMessage: ".fc-agent-message",
    userMessage: ".user-message",
  };

  const CONTEXTO = `Você é um assistente especializado em SUPORTE TÉCNICO de um sistema de gestão para academias (NextFit). Abaixo está a transcrição completa de um atendimento, lida diretamente da tela do agente no Freshchat. As mensagens estão em ordem cronológica, identificadas por "Cliente:", "Agente:" ou "Sistema:".

Seu trabalho é ajudar um atendente que vai assumir ou revisar esse atendimento a entender rapidamente o que foi conversado. Baseie-se SOMENTE no conteúdo da transcrição — não invente informações que não estão presentes.

NÃO inclua informações que o atendente já tem disponíveis em outro lugar, como: canal/plataforma do atendimento, nome do cliente que abriu o contato, nome do agente, ou qualquer dado de sistema/metadado. O foco é o CONTEÚDO do que foi discutido: qual módulo do sistema foi abordado, nome do aluno/dados informados pelo cliente (quando fizerem parte do problema relatado), dúvidas levantadas, respostas e soluções dadas.

Responda em português do Brasil, de forma clara e objetiva. Não use saudações nem despedidas, vá direto ao resumo.`;

  const PROMPTS = {
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

  const ROTULOS_TIPO = {
    breve: "Resumo breve",
    normal: "Resumo normal",
    detalhado: "Resumo detalhado",
  };

  let painelEl = null;
  let botaoEl = null;
  let tipoEmAndamento = null;
  let urlAtual = location.href;

  function limparTexto(txt) {
    return (txt || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  }

  function classificarAutor(item) {
    if (item.matches(SELECTORS.agentMessage) || item.querySelector(SELECTORS.agentMessage))
      return "Agente";
    if (item.matches(SELECTORS.userMessage) || item.querySelector(SELECTORS.userMessage))
      return "Cliente";
    return "Sistema";
  }

  function encontrarTextoMensagem(item) {
    const candidatos = item.querySelectorAll(
      "[class*='message-text'], [class*='conv-message'], [class*='msg-text'], p"
    );
    for (const c of candidatos) {
      const t = limparTexto(c.textContent);
      if (t) return t;
    }
    return limparTexto(item.textContent);
  }

  function encontrarUrlAudio(item) {
    const audioEl = item.querySelector("audio");
    if (!audioEl) return null;
    if (audioEl.currentSrc) return audioEl.currentSrc;
    if (audioEl.src) return audioEl.src;
    const source = audioEl.querySelector("source[src]");
    return source ? source.src : null;
  }

  function coletarMensagensPrimario() {
    const itens = document.querySelectorAll(SELECTORS.messageItem);
    const mensagens = [];
    itens.forEach((item) => {
      const autor = classificarAutor(item);
      const urlAudio = encontrarUrlAudio(item);
      if (urlAudio) {
        mensagens.push({ autor, tipo: "audio", url: urlAudio });
        return;
      }
      const texto = encontrarTextoMensagem(item);
      if (texto) mensagens.push({ autor, tipo: "texto", texto });
    });
    return mensagens;
  }

  function coletarMensagensFallback() {
    const candidatos = document.querySelectorAll("[class*='message']");
    const mensagens = [];
    const vistos = new Set();
    candidatos.forEach((el) => {
      if (el.children.length > 2 || vistos.has(el)) return;
      const urlAudio = encontrarUrlAudio(el);
      const texto = urlAudio ? "" : limparTexto(el.textContent);
      if (!urlAudio && !texto) return;
      vistos.add(el);
      const ehAgente = !!el.closest("[class*='agent']");
      const ehCliente = !ehAgente && el.closest("[class*='user'],[class*='customer'],[class*='contact']");
      const autor = ehAgente ? "Agente" : ehCliente ? "Cliente" : "Sistema";
      if (urlAudio) mensagens.push({ autor, tipo: "audio", url: urlAudio });
      else mensagens.push({ autor, tipo: "texto", texto });
    });
    return mensagens;
  }

  function coletarMensagens() {
    const primario = coletarMensagensPrimario();
    if (primario.length) return primario;
    return coletarMensagensFallback();
  }

  function encontrarContainerDeRolagem() {
    const item =
      document.querySelector(SELECTORS.messageItem) || document.querySelector("[class*='message']");
    if (!item) return null;
    let el = item.parentElement;
    while (el && el !== document.body) {
      const estilo = getComputedStyle(el);
      if (/(auto|scroll)/.test(estilo.overflowY) && el.scrollHeight > el.clientHeight + 10) return el;
      el = el.parentElement;
    }
    return null;
  }

  function esperar(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function chaveMensagem(m) {
    return m.tipo === "audio" ? `${m.autor}::audio::${m.url}` : `${m.autor}::${m.texto}`;
  }

  function mesclarMensagens(existentes, novasMsgs) {
    const contagemExistentes = new Map();
    existentes.forEach((m) => {
      const chave = chaveMensagem(m);
      contagemExistentes.set(chave, (contagemExistentes.get(chave) || 0) + 1);
    });

    const contagemNovas = new Map();
    const ineditas = [];
    novasMsgs.forEach((m) => {
      const chave = chaveMensagem(m);
      const antes = contagemExistentes.get(chave) || 0;
      const agora = (contagemNovas.get(chave) || 0) + 1;
      contagemNovas.set(chave, agora);
      if (agora > antes) ineditas.push(m);
    });

    return [...ineditas, ...existentes];
  }

  async function carregarConversaCompleta() {
    let mensagens = coletarMensagens();
    const container = encontrarContainerDeRolagem();
    if (!container) return mensagens;

    let tentativasSemNovidade = 0;
    for (let i = 0; i < 25 && tentativasSemNovidade < 3; i++) {
      const totalAntes = mensagens.length;
      container.scrollTop = 0;
      await esperar(450);
      mensagens = mesclarMensagens(mensagens, coletarMensagens());
      if (mensagens.length === totalAntes) tentativasSemNovidade++;
      else tentativasSemNovidade = 0;
    }
    return mensagens;
  }

  function montarPartesPrompt(tipo, mensagens) {
    const partes = [];
    let bufferTexto = `${CONTEXTO}\n\n${PROMPTS[tipo]}\n\n=== TRANSCRIÇÃO DO ATENDIMENTO ===\n`;

    mensagens.forEach((m) => {
      if (m.tipo === "audio") {
        bufferTexto += `${m.autor} (mensagem de áudio a seguir — ouça e leve o conteúdo em conta no resumo):\n`;
        partes.push({ text: bufferTexto });
        partes.push({ audioUrl: m.url });
        bufferTexto = "\n";
      } else {
        bufferTexto += `${m.autor}: ${m.texto}\n`;
      }
    });

    bufferTexto += "=== FIM DA TRANSCRIÇÃO ===";
    partes.push({ text: bufferTexto });
    return partes;
  }

  function formatarSaida(texto) {
    const escapado = texto
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return escapado.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }

  function criarPainel() {
    const painel = document.createElement("div");
    painel.id = "rwc-panel";
    painel.innerHTML = `
      <div class="rwc-header">
        <div class="rwc-brand">
          <span class="rwc-brand-name">Rewind<span class="rwc-brand-accent"> Chat</span></span>
          <span class="rwc-brand-by">por Next Fit</span>
        </div>
        <div class="rwc-header-actions">
          <button type="button" class="rwc-icon-btn" id="rwc-settings-toggle" title="Configurações" aria-label="Configurações">⚙</button>
          <button type="button" class="rwc-icon-btn" id="rwc-close" title="Fechar" aria-label="Fechar">✕</button>
        </div>
      </div>

      <div class="rwc-settings rwc-hidden" id="rwc-settings">
        <label class="rwc-field-label" for="rwc-gemini-key">Chave da API do Gemini</label>
        <input type="password" id="rwc-gemini-key" class="rwc-input" placeholder="Cole sua chave aqui" autocomplete="off" />
        <button type="button" class="rwc-btn-primary" id="rwc-save-key">Salvar</button>
        <span class="rwc-settings-status rwc-hidden" id="rwc-settings-status"></span>
      </div>

      <div class="rwc-body">
        <span class="rwc-field-label">Tipo de resumo</span>
        <div class="rwc-segmented" id="rwc-type-selector" role="tablist">
          <button type="button" class="rwc-seg-btn" data-type="breve" role="tab">Breve</button>
          <button type="button" class="rwc-seg-btn" data-type="normal" role="tab">Normal</button>
          <button type="button" class="rwc-seg-btn" data-type="detalhado" role="tab">Detalhado</button>
        </div>

        <div id="rwc-status" class="rwc-status rwc-hidden"></div>

        <section id="rwc-result" class="rwc-result rwc-hidden">
          <div class="rwc-result-header">
            <span id="rwc-result-tag" class="rwc-result-tag">Resumo</span>
            <button type="button" class="rwc-copy-btn" id="rwc-copy">Copiar</button>
          </div>
          <div id="rwc-result-text" class="rwc-result-text"></div>
        </section>
      </div>
    `;
    document.body.appendChild(painel);

    painel.querySelector("#rwc-close").addEventListener("click", fecharPainel);
    painel.querySelector("#rwc-settings-toggle").addEventListener("click", alternarConfiguracoes);
    painel.querySelector("#rwc-save-key").addEventListener("click", salvarChave);
    painel.querySelector("#rwc-copy").addEventListener("click", copiarResultado);
    painel.querySelector("#rwc-type-selector").addEventListener("click", (e) => {
      const btn = e.target.closest(".rwc-seg-btn");
      if (!btn || btn.disabled) return;
      gerarResumo(btn.dataset.type);
    });

    return painel;
  }

  function garantirPainel() {
    if (!painelEl) painelEl = criarPainel();
    return painelEl;
  }

  function abrirPainel() {
    const painel = garantirPainel();
    painel.classList.add("rwc-panel--open");
    inicializarConfiguracoes();
  }

  function fecharPainel() {
    if (painelEl) painelEl.classList.remove("rwc-panel--open");
  }

  function alternarPainel() {
    const painel = garantirPainel();
    if (painel.classList.contains("rwc-panel--open")) fecharPainel();
    else abrirPainel();
  }

  function alternarConfiguracoes() {
    painelEl.querySelector("#rwc-settings").classList.toggle("rwc-hidden");
  }

  async function inicializarConfiguracoes() {
    const campo = painelEl.querySelector("#rwc-gemini-key");
    const { geminiKey } = await chrome.storage.local.get("geminiKey");
    if (geminiKey) {
      campo.value = geminiKey;
      return;
    }
    const resposta = await chrome.runtime
      .sendMessage({ type: "rwc-obter-config-inicial" })
      .catch(() => null);
    if (resposta && resposta.geminiKey) {
      campo.value = resposta.geminiKey;
    } else {
      painelEl.querySelector("#rwc-settings").classList.remove("rwc-hidden");
      mostrarStatusConfig("Cole sua chave da API do Gemini para começar.", false);
    }
  }

  function mostrarStatusConfig(msg, sucesso) {
    const el = painelEl.querySelector("#rwc-settings-status");
    el.textContent = msg;
    el.classList.remove("rwc-hidden");
    el.classList.toggle("rwc-settings-status--ok", !!sucesso);
  }

  async function salvarChave() {
    const campo = painelEl.querySelector("#rwc-gemini-key");
    const valor = campo.value.trim();
    if (!valor) return;
    await chrome.storage.local.set({ geminiKey: valor });
    mostrarStatusConfig("Chave salva!", true);
    setTimeout(() => painelEl.querySelector("#rwc-settings-status").classList.add("rwc-hidden"), 2000);
  }

  function mostrarStatus(tipo, mensagem) {
    const el = painelEl.querySelector("#rwc-status");
    el.className = `rwc-status rwc-status--${tipo}`;
    if (tipo === "loading") {
      el.innerHTML = `<span class="rwc-spinner"></span><span>${mensagem}</span>`;
    } else {
      el.textContent = mensagem;
    }
  }
  function esconderStatus() {
    painelEl.querySelector("#rwc-status").classList.add("rwc-hidden");
  }

  function marcarTipoAtivo(tipo) {
    painelEl.querySelectorAll(".rwc-seg-btn").forEach((b) => {
      b.classList.toggle("rwc-seg-btn--active", b.dataset.type === tipo);
    });
  }

  function definirCarregando(carregando) {
    painelEl.querySelectorAll(".rwc-seg-btn").forEach((b) => (b.disabled = carregando));
    if (botaoEl) botaoEl.classList.toggle("rwc-btn--loading", carregando);
  }

  async function gerarResumo(tipo) {
    abrirPainel();
    marcarTipoAtivo(tipo);
    tipoEmAndamento = tipo;
    painelEl.querySelector("#rwc-result").classList.add("rwc-hidden");
    esconderStatus();

    const { geminiKey } = await chrome.storage.local.get("geminiKey");
    if (!geminiKey) {
      painelEl.querySelector("#rwc-settings").classList.remove("rwc-hidden");
      mostrarStatus("error", "Configure a chave da API do Gemini primeiro.");
      return;
    }

    definirCarregando(true);
    try {
      mostrarStatus("loading", "Lendo a conversa da tela...");
      const mensagens = await carregarConversaCompleta();
      if (!mensagens.length) {
        throw new Error(
          "Nenhuma mensagem encontrada nesta tela. Abra um atendimento e tente novamente."
        );
      }
      const temAudio = mensagens.some((m) => m.tipo === "audio");

      mostrarStatus(
        "loading",
        temAudio ? "Baixando os áudios e gerando o resumo (pode demorar um pouco mais)..." : "Gerando o resumo..."
      );
      const parts = montarPartesPrompt(tipo, mensagens);
      const resposta = await chrome.runtime.sendMessage({
        type: "rwc-gerar-resumo",
        apiKey: geminiKey,
        parts,
      });

      if (tipo !== tipoEmAndamento) return; // agente trocou de tipo antes da resposta chegar
      if (!resposta || !resposta.ok) {
        throw new Error((resposta && resposta.error) || "Ocorreu um erro inesperado.");
      }

      esconderStatus();
      painelEl.querySelector("#rwc-result-tag").textContent = ROTULOS_TIPO[tipo];
      const resultText = painelEl.querySelector("#rwc-result-text");
      resultText.innerHTML = formatarSaida(resposta.text);
      resultText.dataset.raw = resposta.text;
      painelEl.querySelector("#rwc-result").classList.remove("rwc-hidden");
    } catch (erro) {
      if (tipo !== tipoEmAndamento) return;
      mostrarStatus("error", erro.message || "Ocorreu um erro inesperado.");
    } finally {
      if (tipo === tipoEmAndamento) definirCarregando(false);
    }
  }

  async function copiarResultado() {
    const resultText = painelEl.querySelector("#rwc-result-text");
    const texto = resultText.dataset.raw || resultText.textContent;
    try {
      await navigator.clipboard.writeText(texto);
      const btn = painelEl.querySelector("#rwc-copy");
      const original = btn.textContent;
      btn.textContent = "Copiado!";
      setTimeout(() => (btn.textContent = original), 1500);
    } catch (_) {
    }
  }

  const ICONE_RESUMO = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm1 7V3.5L20.5 9H15ZM8 13h8v1.5H8V13Zm0 4h6v1.5H8V17Z"/></svg>`;

  function criarBotaoInline() {
    const botao = document.createElement("button");
    botao.id = "rwc-launcher-button";
    botao.type = "button";
    botao.className = "rwc-inline-btn";
    botao.title = "Rewind Chat — gerar resumo do atendimento";
    botao.setAttribute("aria-label", "Gerar resumo do atendimento");
    botao.innerHTML = ICONE_RESUMO;
    const acionar = (e) => {
      e.preventDefault();
      e.stopPropagation();
      alternarPainel();
    };
    botao.addEventListener("click", acionar);
    botao.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") acionar(e);
    });
    return botao;
  }

  function encontrarPontoDeInsercao() {
    const porId = document.getElementById("fd-copy-ai-conversation");
    if (porId) return { referencia: porId, posicao: "afterend" };

    const menu = document.querySelector('[data-test-id="hamburger-menu"]');
    if (menu && menu.parentElement) {
      return { referencia: menu.parentElement, posicao: "beforebegin" };
    }

    return null;
  }

  function posicionarBotao() {
    const ponto = encontrarPontoDeInsercao();
    if (!ponto) {
      if (botaoEl) botaoEl.style.display = "none";
      return;
    }

    if (!botaoEl || !botaoEl.isConnected) {
      botaoEl = criarBotaoInline();
    }
    botaoEl.style.display = "inline-flex";

    const { referencia, posicao } = ponto;
    const estaNoLugar =
      posicao === "afterend"
        ? botaoEl.previousElementSibling === referencia
        : botaoEl.nextElementSibling === referencia;

    if (!estaNoLugar) {
      referencia.insertAdjacentElement(posicao, botaoEl);
    }
  }

  function verificarTrocaDeUrl() {
    if (location.href === urlAtual) return;
    urlAtual = location.href;
    tipoEmAndamento = null;
    if (painelEl) {
      painelEl.querySelector("#rwc-result").classList.add("rwc-hidden");
      esconderStatus();
      painelEl.querySelectorAll(".rwc-seg-btn").forEach((b) => b.classList.remove("rwc-seg-btn--active"));
    }
  }

  function iniciar() {
    posicionarBotao();
    setInterval(() => {
      verificarTrocaDeUrl();
      posicionarBotao();
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
  } else {
    iniciar();
  }
})();
