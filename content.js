(function () {
  "use strict";

  /* ==========================================================================
     Rewind Chat — Next Fit
     Content script: injeta o botão flutuante na tela de atendimento, lê a
     conversa direto do DOM (sem API do Freshchat) e abre o painel de resumo
     com IA.
     ========================================================================== */

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

  /* ==========================================================================
     Leitura da conversa (DOM)
     ========================================================================== */
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

  // Mensagens de áudio (nota de voz) não têm texto na bolha, só um player.
  // O <audio> real fica escondido atrás do player customizado; pega a URL
  // de lá (direto no src ou num <source> filho).
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

  // Rede de segurança caso a tela troque as classes do widget de conversa:
  // procura qualquer bolha com "message" no nome da classe e tenta inferir o
  // autor pelas classes dos elementos ancestrais.
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

  // Ao rolar para cima, mensagens antigas são pré-carregadas no topo do DOM.
  // Como a posição de cada bolha muda a cada nova coleta, a dedupe usa
  // autor+conteúdo (contando repetições) em vez de um índice de posição.
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

  // Monta as "parts" do pedido ao Gemini intercalando texto com os áudios na
  // ordem em que aparecem na conversa — cada áudio vira uma part separada
  // (o download/base64 real é feito no background, aqui só fica um
  // placeholder com a URL) e o texto ao redor dá contexto pra IA sobre de
  // quem é a mensagem antes de "ouvir" o áudio.
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

  /* ==========================================================================
     Formatação de saída (negrito seguro)
     ========================================================================== */
  function formatarSaida(texto) {
    const escapado = texto
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return escapado.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }

  /* ==========================================================================
     Painel — criação e controle
     ========================================================================== */
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

  /* ==========================================================================
     Configurações (chave do Gemini)
     ========================================================================== */
  async function inicializarConfiguracoes() {
    const campo = painelEl.querySelector("#rwc-gemini-key");
    const { geminiKey } = await chrome.storage.local.get("geminiKey");
    if (geminiKey) {
      campo.value = geminiKey;
      return;
    }
    // Sem chave salva ainda: tenta semear a partir de config.local.js (via
    // background) e, se não achar nada, avisa o agente na área de config.
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

  /* ==========================================================================
     Estados de tela
     ========================================================================== */
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

  /* ==========================================================================
     Fluxo principal
     ========================================================================== */
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
      /* ignora falha de clipboard */
    }
  }

  /* ==========================================================================
     Botão — injetado na barra de ações do atendimento (ao lado do lápis/
     reticências/"Abrir"), com a mesma estética dos ícones nativos.
     ========================================================================== */
  const ICONE_RESUMO = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>`;

  // Usa <div role="button"> em vez de <button>: em atendimentos resolvidos a
  // barra de ações fica dentro de um contêiner desabilitado (fieldset/CSS),
  // o que bloquearia cliques num <button> nativo mesmo com o nosso próprio
  // listener. Uma div não sofre esse bloqueio automático do navegador.
  function criarBotaoInline() {
    const botao = document.createElement("div");
    botao.id = "rwc-launcher-button";
    botao.className = "rwc-inline-btn";
    botao.title = "Rewind Chat — gerar resumo do atendimento";
    botao.setAttribute("role", "button");
    botao.setAttribute("tabindex", "0");
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

  // O dropdown de status (ao lado do lápis/reticências) é o elemento mais
  // estável pra achar a barra de ações. O texto dele muda conforme o estado
  // da conversa ("Abrir", "Resolvidos", "Fechados", "Pendentes"...), então a
  // busca é por uma lista de rótulos conhecidos, não por um texto fixo. Pega
  // o último da tela porque pode haver conversas antigas acima da ativa.
  const ROTULOS_BOTAO_STATUS = [
    "abrir",
    "aberto",
    "abertos",
    "resolvido",
    "resolvidos",
    "fechado",
    "fechados",
    "pendente",
    "pendentes",
  ];

  function encontrarBotaoStatus() {
    const candidatos = document.querySelectorAll("button, [role='button']");
    let ultimo = null;
    candidatos.forEach((b) => {
      const texto = limparTexto(b.textContent).toLowerCase();
      if (ROTULOS_BOTAO_STATUS.includes(texto)) ultimo = b;
    });
    return ultimo;
  }

  // Entre os botões da MESMA linha (mesmo topo na tela, tolerância apertada)
  // à esquerda do botão de status, pega o mais à esquerda de todos — que é
  // sempre o lápis. Só considera candidatos do tamanho de um ícone (evita
  // pegar algo grande/errado de outra parte da tela por coincidência).
  function encontrarPrimeiroIconeDaBarra(statusBtn) {
    const rectStatus = statusBtn.getBoundingClientRect();
    const candidatos = document.querySelectorAll("button, [role='button']");
    let alvo = statusBtn;
    let menorLeft = rectStatus.left;
    candidatos.forEach((el) => {
      if (el === botaoEl || el === statusBtn || el.contains(statusBtn) || statusBtn.contains(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.width > 60 || r.height > 60) return;
      const mesmaLinha = Math.abs(r.top - rectStatus.top) < 4;
      const dentroDoAlcance = rectStatus.left - r.left < 250;
      if (mesmaLinha && r.left < menorLeft && dentroDoAlcance) {
        menorLeft = r.left;
        alvo = el;
      }
    });
    return alvo;
  }

  const LARGURA_BOTAO = 30;
  const ESPACO_BOTAO = 6;

  function posicionarBotao() {
    const statusBtn = encontrarBotaoStatus();
    if (!statusBtn) {
      if (botaoEl) botaoEl.style.display = "none";
      return;
    }

    if (!botaoEl || !botaoEl.isConnected) {
      botaoEl = criarBotaoInline();
      document.body.appendChild(botaoEl);
    }

    const alvo = encontrarPrimeiroIconeDaBarra(statusBtn);
    const rect = alvo.getBoundingClientRect();
    botaoEl.style.display = "inline-flex";
    botaoEl.style.top = `${rect.top}px`;
    botaoEl.style.left = `${rect.left - LARGURA_BOTAO - ESPACO_BOTAO}px`;
  }

  /* ==========================================================================
     Detecção de troca de conversa (SPA) — limpa resultado antigo
     ========================================================================== */
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

  /* ==========================================================================
     Inicialização
     ========================================================================== */
  function iniciar() {
    posicionarBotao();
    setInterval(() => {
      posicionarBotao();
      verificarTrocaDeUrl();
    }, 1000);
    document.addEventListener("scroll", posicionarBotao, true);
    window.addEventListener("resize", posicionarBotao);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
  } else {
    iniciar();
  }
})();
