/* Gabarito: estado, nuvem (Firebase) ou modo local, e telas. */

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const novoId = () => Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 7);
const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
const agora = () => new Date().toISOString();
const dataCurta = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");

const S = { turmas: {}, avaliacoes: {}, resultados: {}, perfil: {} };
const ui = { aba: "turmas", avSel: null, turmaFiltro: "", leituras: [], carregando: true, camera: null };
const ABAS = [
  ["turmas", "Turmas"],
  ["avaliacoes", "Avaliações"],
  ["folhas", "Folhas"],
  ["corrigir", "Corrigir"],
  ["notas", "Notas"],
  ["escola", "Escola"],
];

/* ===================== Armazenamento ===================== */
const KINDS = ["turmas", "avaliacoes", "resultados"];
/* Na nuvem, as coleções ficam com o prefixo gab_ para não se misturar com outros dados do mesmo projeto Firebase */
const COL = (k) => (window.GABARITO_PREFIXO ?? "gab_") + k;
const Nuvem = {
  modo: "local",
  usuario: null,
  db: null,
  auth: null,
  subs: [],
  tokenSheets: null,

  async iniciar() {
    const cfg = window.GABARITO_FIREBASE;
    if (!cfg) return this.iniciarLocal();
    try {
      for (const f of ["firebase-app-compat.js", "firebase-auth-compat.js", "firebase-firestore-compat.js"]) await carregarScript("https://cdn.jsdelivr.net/npm/firebase@10.12.2/" + f);
    } catch (e) {
      toast("Não consegui carregar o Firebase. Verifique a internet.");
      return this.iniciarLocal();
    }
    this.modo = "nuvem";
    firebase.initializeApp(cfg);
    this.auth = firebase.auth();
    this.db = firebase.firestore();
    try { await this.db.enablePersistence({ synchronizeTabs: true }); } catch (e) { /* sem cache offline neste navegador */ }
    this.auth.getRedirectResult().catch((e) => toast(msgErroLogin(e)));
    this.auth.onAuthStateChanged((u) => {
      this.usuario = u;
      ui.semAcesso = false;
      this.subs.forEach((f) => f()); this.subs = [];
      KINDS.forEach((k) => (S[k] = {})); S.perfil = {};
      if (!u) { ui.carregando = false; render(); return; }
      ui.carregando = true; render();
      let pendentes = KINDS.length + 1;
      const pronto = () => { if (--pendentes === 0) { ui.carregando = false; } render(); };
      for (const k of KINDS) {
        let primeira = true;
        this.subs.push(this.db.collection(COL(k)).where("dono", "==", u.uid).onSnapshot((snap) => {
          const m = {};
          snap.forEach((d) => (m[d.id] = { ...d.data(), id: d.id }));
          S[k] = m;
          if (primeira) { primeira = false; pronto(); } else render();
        }, (e) => { erroSync(e); if (primeira) { primeira = false; pronto(); } }));
      }
      let primeiraP = true;
      this.subs.push(this.db.collection(COL("perfis")).doc(u.uid).onSnapshot((d) => {
        S.perfil = d.exists ? d.data() : {};
        if (primeiraP) { primeiraP = false; pronto(); } else render();
      }, () => { if (primeiraP) { primeiraP = false; pronto(); } }));
    });
  },

  iniciarLocal() {
    this.modo = "local";
    try {
      const o = JSON.parse(localStorage.getItem("gabarito-local-v1") || "{}");
      KINDS.forEach((k) => (S[k] = o[k] || {}));
      S.perfil = o.perfil || {};
    } catch (e) { /* armazenamento indisponível */ }
    ui.carregando = false;
    render();
  },
  salvarLocal() {
    try { localStorage.setItem("gabarito-local-v1", JSON.stringify({ turmas: S.turmas, avaliacoes: S.avaliacoes, resultados: S.resultados, perfil: S.perfil })); }
    catch (e) { toast("Não consegui salvar neste aparelho (armazenamento cheio ou bloqueado)."); }
  },

  put(kind, id, obj) {
    const dados = { ...obj, id, atualizadoEm: agora() };
    if (this.modo === "local") { S[kind] = { ...S[kind], [id]: dados }; this.salvarLocal(); render(); return Promise.resolve(); }
    dados.dono = this.usuario.uid;
    return this.db.collection(COL(kind)).doc(id).set(dados).catch((e) => toast("Não foi possível salvar: " + e.message));
  },
  del(kind, id) {
    if (this.modo === "local") { const m = { ...S[kind] }; delete m[id]; S[kind] = m; this.salvarLocal(); render(); return Promise.resolve(); }
    return this.db.collection(COL(kind)).doc(id).delete().catch((e) => toast("Não foi possível excluir: " + e.message));
  },
  salvarPerfil(p) {
    S.perfil = { ...S.perfil, ...p };
    if (this.modo === "local") { this.salvarLocal(); render(); return Promise.resolve(); }
    return this.db.collection(COL("perfis")).doc(this.usuario.uid).set({ ...S.perfil, dono: this.usuario.uid }).catch((e) => toast("Não foi possível salvar: " + e.message));
  },

  entrar() {
    const p = new firebase.auth.GoogleAuthProvider();
    p.setCustomParameters({ prompt: "select_account" });
    this.auth.signInWithPopup(p).catch((e) => {
      if (/popup|cancelled|operation-not-supported/i.test(e.code || "")) return this.auth.signInWithRedirect(p);
      toast(msgErroLogin(e));
    });
  },
  sair() { return this.auth.signOut(); },

  /* Token para criar e atualizar planilhas no Google Drive do professor */
  async tokenGoogle() {
    if (this.tokenSheets && this.tokenSheets.ate > Date.now()) return this.tokenSheets.v;
    const p = new firebase.auth.GoogleAuthProvider();
    p.addScope("https://www.googleapis.com/auth/drive.file");
    p.setCustomParameters({ login_hint: this.usuario.email || "" });
    const r = await this.usuario.reauthenticateWithPopup(p);
    const v = r.credential && r.credential.accessToken;
    if (!v) throw new Error("O Google não liberou o acesso às planilhas.");
    this.tokenSheets = { v, ate: Date.now() + 50 * 60 * 1000 };
    return v;
  },
};

function erroSync(e) {
  if (e && e.code === "permission-denied") { ui.semAcesso = true; render(); }
  else toast("Erro ao sincronizar: " + ((e && e.message) || e));
}
function msgErroLogin(e) {
  const c = (e && e.code) || "";
  if (c.includes("unauthorized-domain")) return "Este endereço ainda não foi autorizado no Firebase (Authentication > Configurações > Domínios autorizados).";
  if (c.includes("popup-closed")) return "A janela de login foi fechada antes de terminar.";
  return "Não foi possível entrar: " + ((e && e.message) || c);
}

function carregarScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("falha ao carregar " + src));
    document.head.appendChild(s);
  });
}
async function garantirPdfJs() {
  if (window.pdfjsLib) return;
  await carregarScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

/* ===================== Utilidades de tela ===================== */
let _toastT = null;
function toast(msg, ms = 3800) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(_toastT);
  _toastT = setTimeout(() => (t.hidden = true), ms);
}

function salvarArquivo(blob, nome) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
}
const nomeArquivo = (s) => String(s).replace(/[ºª°]/g, "o").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w .()+-]+/g, "-").replace(/\s+/g, " ").trim();

/* Botão de excluir em dois toques (sem confirm(), que alguns navegadores bloqueiam) */
function armar(btn, acao) {
  if (btn.classList.contains("armado")) { acao(); return; }
  btn.classList.add("armado");
  const txt = btn.textContent;
  btn.textContent = "Toque de novo para confirmar";
  setTimeout(() => { btn.classList.remove("armado"); btn.textContent = txt; }, 3500);
}

const ordenarTurmas = (ts) => ts.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR", { numeric: true }));
const listaTurmas = () => ordenarTurmas(Object.values(S.turmas));
const listaAvaliacoes = () => Object.values(S.avaliacoes).map(normAv).sort((a, b) => (b.criadoEm || "").localeCompare(a.criadoEm || ""));

/* Avaliações antigas (uma só seção, nQ/nAlt/valor/gabarito) viram o formato com seções e versões */
function normAv(av) {
  if (!av) return av;
  if (av.secoes && av.gabaritos) return av;
  const nQ = +av.nQ || 20, nAlt = +av.nAlt || 4;
  return {
    ...av,
    versoes: av.versoes || 1,
    secoes: av.secoes || [{ nome: "", tipo: String(nAlt), n: nQ, certo: Math.round(((+av.valor || 10) / nQ) * 1000) / 1000, errado: 0 }],
    gabaritos: av.gabaritos || { A: av.gabarito || "" },
  };
}
const AV = (id) => normAv(S.avaliacoes[id]);
const totalQ = (av) => av.secoes.reduce((s, x) => s + (+x.n || 0), 0);
const NOME_TIPO = Object.fromEntries(TIPOS);
/* Dados de cada questão: seção, letras possíveis e pontos para certo e para errado */
function infoQ(av) {
  const out = [];
  av.secoes.forEach((s, si) => {
    for (let i = 0; i < +s.n; i++) {
      const q = out.length;
      const certo = av.pontoPorQuestao && av.pontos && av.pontos[q] != null && av.pontos[q] !== "" ? +av.pontos[q] : +s.certo || 0;
      out.push({ si, i, tipo: String(s.tipo), letras: letrasTipo(String(s.tipo)), certo, errado: av.anulaErrada ? certo : +s.errado || 0 });
    }
  });
  return out;
}
const gabDe = (av, ver) => (av.gabaritos && av.gabaritos[ver || "A"]) || "";
function gabCompleto(av) {
  const n = totalQ(av);
  for (let v = 0; v < (+av.versoes || 1); v++) {
    const g = gabDe(av, VERSOES[v]);
    if (g.length < n || g.slice(0, n).includes("-")) return false;
  }
  return true;
}
/* Correção: acerto soma os pontos da questão; erro desconta (se configurado); em branco e marcação dupla valem zero */
function corrigir(av, resp, ver) {
  const g = gabDe(av, ver), Q = infoQ(av);
  let ac = 0, er = 0, tot = 0, total = 0, pts = 0;
  Q.forEach((x, q) => {
    const k = g[q];
    if (!k || k === "-") return;
    tot++; total += x.certo;
    const v = (resp || "")[q] || "-";
    if (k === "X" || v === k) { ac++; pts += x.certo; }
    else if (v !== "-" && v !== "*") { er++; pts -= x.errado; }
  });
  pts = Math.round(pts * 1000) / 1000;
  return { ac, er, tot, total: Math.round(total * 1000) / 1000, nota: Math.max(0, pts), bruto: pts };
}
function resultadosDe(avId) { return Object.values(S.resultados).filter((r) => r.avaliacaoId === avId); }

/* ===================== Render ===================== */
function render() {
  const nuvem = Nuvem.modo === "nuvem";
  $("#faixaLocal").hidden = nuvem || ui.carregando;
  // topo
  const logado = !nuvem || Nuvem.usuario;
  $("#etapas").innerHTML = logado ? ABAS.map(([id, nome], i) => `<button class="etapa" data-aba="${id}" ${ui.aba === id ? 'aria-current="page"' : ""}>${i < 5 ? `<b>${i + 1}</b>` : ""}${nome}</button>`).join("") : "";
  const u = Nuvem.usuario;
  $("#conta").innerHTML = nuvem && u ? `<button class="avatar" data-aba="escola" title="${esc(u.email)}">${u.photoURL ? `<img src="${esc(u.photoURL)}" alt="">` : esc((u.displayName || u.email || "?")[0])}</button>` : "";

  const m = $("#main");
  if (ui.carregando) { m.innerHTML = `<div class="vazio"><strong>Carregando seus dados…</strong></div>`; return; }
  if (nuvem && !u) { m.innerHTML = telaEntrar(); return; }
  if (nuvem && ui.semAcesso) { m.innerHTML = `<div class="entrar"><div class="bloco"><h2>Conta ainda não liberada</h2><p class="muted" style="margin:0">Você entrou como <strong>${esc(u.email)}</strong>, mas este e-mail ainda não está na lista de professores liberados. Peça ao administrador para incluir seu e-mail e depois recarregue a página.</p><button class="btn" data-acao="sair">Sair</button></div></div>`; return; }
  const telas = { turmas: telaTurmas, avaliacoes: telaAvaliacoes, folhas: telaFolhas, corrigir: telaCorrigir, notas: telaNotas, escola: telaEscola };
  m.innerHTML = (telas[ui.aba] || telaTurmas)();
  if (ui.aba === "folhas") desenharPrevia();
  const atual = $(".etapa[aria-current=page]");
  if (atual && atual.scrollIntoView) atual.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (ui.aba === "corrigir" && ui.camera) $("#camSlot") && $("#camSlot").appendChild(ui.camera.el);
}

function telaEntrar() {
  return `<div class="entrar"><div class="bloco">
    <svg width="56" height="56" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="var(--accent)"/><circle cx="11" cy="16" r="4.5" fill="var(--accent-ink)"/><circle cx="22" cy="16" r="4.5" fill="none" stroke="var(--accent-ink)" stroke-width="2"/></svg>
    <h2>Gabarito</h2>
    <p class="muted" style="margin:0">Folhas de resposta por aluno, correção pela câmera do celular e notas sincronizadas entre seus aparelhos.</p>
    <button class="btn pri" data-acao="entrar">Entrar com Google</button>
    <small class="muted">Cada professor vê apenas as próprias turmas, avaliações e notas.</small>
  </div></div>`;
}

/* ---------- Turmas ---------- */
function telaTurmas() {
  const ts = listaTurmas();
  const total = ts.reduce((s, t) => s + (t.alunos || []).length, 0);
  return `<div class="cab"><div><h2>Turmas</h2><p>Importe as atas das turmas (.docx da escola, Excel, CSV ou PDF). Cada aluno fica identificado pelo R.A., que vira o código de barras da folha.</p></div>
    <div class="acoes"><button class="btn pri" data-acao="importar-atas">Importar atas</button><button class="btn" data-acao="nova-turma">Nova turma</button></div></div>
    ${ts.length ? `<p class="muted" style="margin:-6px 0 14px">${ts.length} turma${ts.length > 1 ? "s" : ""} · ${total} alunos</p>
    <div class="lista">${ts.map((t) => `<button class="cartao clicavel" data-acao="editar-turma" data-id="${t.id}">
      <h3>${esc(t.nome)}</h3>
      <div class="meta"><span class="chip acc">${(t.alunos || []).length} alunos</span>${t.turno ? `<span class="chip">${esc(t.turno)}</span>` : ""}</div>
      <small class="muted">${esc((t.alunos || []).slice(0, 3).map((a) => a.nome.split(" ")[0]).join(", "))}${(t.alunos || []).length > 3 ? "…" : ""}</small>
    </button>`).join("")}</div>`
    : `<div class="vazio"><strong>Nenhuma turma ainda</strong>Importe as atas de uma vez: o site reconhece a turma, o número, o R.A. e o nome de cada aluno.<button class="btn pri" data-acao="importar-atas">Importar atas</button></div>`}`;
}

/* ---------- Avaliações ---------- */
function telaAvaliacoes() {
  const avs = listaAvaliacoes();
  return `<div class="cab"><div><h2>Avaliações</h2><p>Cadastre a prova, o gabarito e as turmas que vão fazê-la. A folha pode ser nominal (um por aluno) ou neutra (sem nome).</p></div>
    <div class="acoes"><button class="btn pri" data-acao="nova-av">Nova avaliação</button></div></div>
    ${avs.length ? `<div class="lista">${avs.map((av) => {
      const gabOk = gabCompleto(av);
      const lidas = resultadosDe(av.id).length;
      const tipos = [...new Set(av.secoes.map((s) => (s.tipo === "C" ? "C/E" : "A–" + LETRAS[+s.tipo - 1])))].join(", ");
      const total = corrigir(av, "", "A").total;
      return `<button class="cartao clicavel" data-acao="editar-av" data-id="${av.id}">
        <h3>${esc(av.titulo || "Sem título")}</h3>
        <small class="muted">${esc(av.componente || "")}</small>
        <div class="meta"><span class="chip ${av.tipo === "neutra" ? "" : "acc"}">${av.tipo === "neutra" ? "Folha neutra" : "Folha nominal"}</span>
          <span class="chip">${totalQ(av)} questões · ${tipos}</span>
          ${total ? `<span class="chip">vale ${fmt(total)}</span>` : ""}
          ${+av.versoes > 1 ? `<span class="chip">${av.versoes} versões</span>` : ""}
          ${av.anulaErrada ? `<span class="chip">errada anula certa</span>` : ""}
          <span class="chip ${gabOk ? "ok" : "warn"}">${gabOk ? "Gabarito completo" : "Gabarito incompleto"}</span>
          ${lidas ? `<span class="chip ok">${lidas} lida${lidas > 1 ? "s" : ""}</span>` : ""}</div>
        <small class="muted">${esc((av.turmas || []).map((id) => S.turmas[id] && S.turmas[id].nome).filter(Boolean).join(" · ") || "Nenhuma turma selecionada")}</small>
      </button>`;
    }).join("")}</div>`
    : `<div class="vazio"><strong>Nenhuma avaliação ainda</strong>Crie a primeira: título, componente, número de questões, alternativas e gabarito.<button class="btn pri" data-acao="nova-av">Nova avaliação</button></div>`}`;
}

/* ---------- Folhas ---------- */
function avAtual() {
  const avs = listaAvaliacoes();
  if (!ui.avSel || !S.avaliacoes[ui.avSel]) ui.avSel = avs[0] ? avs[0].id : null;
  return ui.avSel ? AV(ui.avSel) : null;
}
function seletorAv() {
  const avs = listaAvaliacoes();
  return `<label class="campo" style="max-width:420px"><span>Avaliação</span><select id="selAv" data-muda="av">${avs.map((a) => `<option value="${a.id}" ${a.id === ui.avSel ? "selected" : ""}>${esc(a.titulo || "Sem título")}${a.componente ? " · " + esc(a.componente) : ""}</option>`).join("")}</select></label>`;
}
function telaFolhas() {
  const av = avAtual();
  if (!av) return `<div class="cab"><div><h2>Folhas de resposta</h2></div></div><div class="vazio"><strong>Crie uma avaliação primeiro</strong>As folhas usam o número de questões, as alternativas e as turmas da avaliação.<button class="btn pri" data-acao="nova-av">Nova avaliação</button></div>`;
  const ts = (av.turmas || []).map((id) => S.turmas[id]).filter(Boolean);
  const neutra = av.tipo === "neutra";
  return `<div class="cab"><div><h2>Folhas de resposta</h2><p>${neutra ? "Folha neutra: sem nome do aluno. O QR code identifica a avaliação e a turma." : "Folha nominal: uma por aluno, com nome, Nº, código de barras do R.A. e QR code."} Imprima em A4, sem ajustar à página (escala 100%).</p></div></div>
    <div class="duas">
      <div class="bloco">
        ${seletorAv()}
        <div>
          ${ts.length ? ts.map((t) => `<div class="linha-turma"><span class="nome">${esc(t.nome)} <small class="muted">· ${neutra ? "" : (t.alunos || []).length + " folhas"}</small></span>
            ${neutra ? `<label class="check" title="Cópias">Cópias <input type="number" min="1" max="200" value="${(t.alunos || []).length || 30}" id="cop-${t.id}" style="width:84px"></label>` : ""}
            <button class="btn peq" data-acao="gerar" data-fmt="pdf" data-turma="${t.id}">PDF</button>
            <button class="btn peq" data-acao="gerar" data-fmt="docx" data-turma="${t.id}">Word</button></div>`).join("")
          : `<div class="aviso">Esta avaliação ainda não tem turmas. Abra a avaliação e marque as turmas.</div>`}
          ${neutra ? `<div class="linha-turma"><span class="nome">Sem turma <small class="muted">· identifica só a avaliação</small></span>
            <label class="check">Cópias <input type="number" min="1" max="200" value="30" id="cop--" style="width:84px"></label>
            <button class="btn peq" data-acao="gerar" data-fmt="pdf" data-turma="">PDF</button><button class="btn peq" data-acao="gerar" data-fmt="docx" data-turma="">Word</button></div>` : ""}
        </div>
        ${ts.length > 1 && !neutra ? `<div class="acoes"><button class="btn pri" data-acao="gerar" data-fmt="pdf" data-turma="*">PDF de todas as turmas</button></div>` : ""}
        <div id="progGerar" hidden><div class="progresso"><i></i></div><small class="muted"></small></div>
        ${+av.versoes > 1 ? `<div class="aviso info">Esta prova tem ${av.versoes} versões (${VERSOES.slice(0, av.versoes).split("").join(", ")}). As folhas saem alternando as versões, e a versão vai no QR code de cada folha.</div>` : ""}
        ${gabCompleto(av) ? "" : `<div class="aviso">O gabarito ainda está incompleto. Você pode imprimir as folhas agora e completar o gabarito antes de corrigir.</div>`}
      </div>
      <div><canvas id="previa" class="previa-folha" width="630" height="891" aria-label="Prévia da folha"></canvas><p class="muted" style="text-align:center;font-size:.85rem">Prévia da primeira folha</p></div>
    </div>`;
}
async function desenharPrevia() {
  const cv = $("#previa"), av = avAtual();
  if (!cv || !av) return;
  const t = (av.turmas || []).map((id) => S.turmas[id]).filter(Boolean)[0] || null;
  const aluno = av.tipo === "neutra" ? null : (t && t.alunos && t.alunos[0]) || { id: "00000000", ra: "00000000", nome: "NOME DO ALUNO", num: 1 };
  const imgs = await carregarImagens([S.perfil.logo]);
  desenharCanvas(cv.getContext("2d"), opsFolha({ av, perfil: S.perfil, turma: t, aluno, ver: "A" }), cv.width / A4.w, imgs);
}

/* ---------- Corrigir ---------- */
function telaCorrigir() {
  const ls = ui.leituras;
  return `<div class="cab"><div><h2>Corrigir</h2><p>Aponte o celular para a folha preenchida. O site acha os quadrados dos cantos, lê o QR code, identifica a avaliação, a turma e o aluno, e lança a nota.</p></div></div>
    ${ui.camera ? `<div id="camSlot"></div>` : `<div class="grandes">
      <button class="grande" data-acao="camera"><span class="ic"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8h3l2-3h8l2 3h3v12H3z"/><circle cx="12" cy="13.5" r="3.8"/></svg></span><span><strong>Câmera ao vivo</strong><small>Lê automaticamente quando a folha inteira aparece</small></span></button>
      <button class="grande" data-acao="foto"><span class="ic"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m3 16 5-5 4 4 3-3 6 6"/></svg></span><span><strong>Tirar foto</strong><small>Usa a câmera do celular, com mais resolução</small></span></button>
      <button class="grande" data-acao="galeria"><span class="ic"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h10l6 6v10H4z"/><path d="M14 4v6h6"/></svg></span><span><strong>Enviar imagens</strong><small>Várias fotos ou digitalizações de uma vez</small></span></button>
    </div>`}
    <div class="aviso info" style="margin-top:14px">Dicas: folha apoiada numa mesa, os 4 quadrados pretos aparecendo, boa luz e sem sombra do celular sobre a folha.</div>
    <div style="display:grid;gap:12px;margin-top:16px">${ls.map(cartaoLeitura).join("")}</div>`;
}

function cartaoLeitura(l) {
  if (l.erro) return `<div class="bloco"><div class="aviso erro"><strong>${esc(l.arquivo || "Leitura")}:</strong> ${esc(l.erro)}</div></div>`;
  const r = S.resultados[l.resId] || l.res;
  const av = AV(r.avaliacaoId);
  if (!av) return "";
  const { ac, er, nota, total } = corrigir(av, r.respostas, r.versao);
  const turma = S.turmas[r.turmaId];
  const brancos = (r.respostas.match(/-/g) || []).length, duplas = (r.respostas.match(/\*/g) || []).length;
  const titulo = r.alunoId ? `${esc(r.nome)}` : `Folha neutra${r.seq ? " nº " + r.seq : ""}${r.nome ? " · " + esc(r.nome) : ""}`;
  return `<div class="bloco"><div class="leitura">
    <img src="${l.previa}" alt="Folha lida">
    <div style="display:grid;gap:10px;min-width:0;align-content:start">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start">
        <div style="min-width:0"><h3>${titulo}</h3><small class="muted">${esc(av.titulo)} · ${esc(turma ? turma.nome : "sem turma")}${r.ra ? " · R.A. " + esc(r.ra) : ""}</small></div>
        <div style="text-align:right"><div class="nota-grande">${fmt(nota)}</div><small class="muted">de ${fmt(total)} · ${ac} certa${ac !== 1 ? "s" : ""}, ${er} errada${er !== 1 ? "s" : ""}</small></div>
      </div>
      <div class="meta" style="display:flex;gap:6px;flex-wrap:wrap"><span class="chip ok">Salvo nas notas</span>${+av.versoes > 1 ? `<span class="chip acc">Versão ${esc(r.versao || "A")}</span>` : ""}${l.substituiu ? `<span class="chip warn">Substituiu leitura anterior</span>` : ""}${l.aviso ? `<span class="chip warn">${esc(l.aviso)}</span>` : ""}${brancos ? `<span class="chip warn">${brancos} em branco</span>` : ""}${duplas ? `<span class="chip bad">${duplas} com marcação dupla</span>` : ""}</div>
      ${!r.alunoId && turma ? `<label class="campo"><span>Vincular a um aluno <small>(opcional)</small></span><select data-muda="vincular" data-res="${r.id}"><option value="">Não vincular</option>${(turma.alunos || []).map((a) => `<option value="${a.id}">${String(a.num).padStart(2, "0")} · ${esc(a.nome)}</option>`).join("")}</select></label>` : ""}
      <details><summary class="muted" style="cursor:pointer">Conferir e corrigir respostas</summary><div style="margin-top:10px">${gradeRespostas(av, r)}</div></details>
    </div></div></div>`;
}

const classeResp = (v, k) => (v === "*" ? "warn" : !k || k === "-" ? "" : k === "X" || v === k ? "ok" : v === "-" ? "" : "bad");
function gradeRespostas(av, r) {
  const g = gabDe(av, r.versao), Q = infoQ(av);
  let h = "", si = -1;
  Q.forEach((x, q) => {
    if (x.si !== si) {
      if (si >= 0) h += `</div>`;
      si = x.si;
      const s = av.secoes[si];
      if (av.secoes.length > 1) h += `<div class="sec-titulo">${esc(s.nome || "Seção " + (si + 1))} <small class="muted">· ${esc(NOME_TIPO[s.tipo])}</small></div>`;
      h += `<div class="resps">`;
    }
    const v = (r.respostas || "")[q] || "-";
    h += `<label class="rq ${classeResp(v, g[q])}"><b>${q + 1}</b><select data-muda="resp" data-res="${r.id}" data-q="${q}">${["-", ...x.letras, "*"].map((o) => `<option value="${o}" ${o === v ? "selected" : ""}>${o === "-" ? "—" : o === "*" ? "2+" : o}</option>`).join("")}</select></label>`;
  });
  return h + `</div><small class="muted">— em branco · 2+ mais de uma marcação (vale zero). Verde: acerto, vermelho: erro.</small>`;
}

/* ---------- Notas ---------- */
function telaNotas() {
  const av = avAtual();
  if (!av) return `<div class="cab"><div><h2>Notas</h2></div></div><div class="vazio"><strong>Nenhuma avaliação ainda</strong>As notas aparecem aqui assim que as folhas forem lidas.</div>`;
  const ts = (av.turmas || []).map((id) => S.turmas[id]).filter(Boolean);
  const res = resultadosDe(av.id);
  const filtro = ui.turmaFiltro && (ts.some((t) => t.id === ui.turmaFiltro) || ui.turmaFiltro === "_neutras") ? ui.turmaFiltro : "";
  const linhas = linhasNotas(av, filtro);
  const lidas = linhas.filter((l) => l.r);
  const notas = lidas.map((l) => l.c.nota);
  const media = notas.length ? notas.reduce((a, b) => a + b, 0) / notas.length : 0;
  const esperadas = linhas.filter((l) => l.aluno).length;
  // acertos por questão (cada folha comparada com o gabarito da sua versão)
  const porQ = Array.from({ length: totalQ(av) }, (_, q) => {
    const vale = lidas.filter((l) => { const k = gabDe(av, l.r.versao)[q]; return k && k !== "-"; });
    if (!vale.length) return null;
    return vale.filter((l) => { const k = gabDe(av, l.r.versao)[q]; return k === "X" || l.r.respostas[q] === k; }).length / vale.length;
  });
  const valeProva = corrigir(av, "", "A").total;
  const multiVer = +av.versoes > 1;
  const nuvem = Nuvem.modo === "nuvem";
  return `<div class="cab"><div><h2>Notas</h2><p>Atualiza sozinha a cada folha lida, em qualquer aparelho conectado à sua conta. Toque numa linha para conferir ou lançar respostas à mão.</p></div>
    <div class="acoes"><button class="btn" data-acao="exp-xlsx">Excel</button>${nuvem ? `<button class="btn" data-acao="exp-sheets">Google Planilhas</button>` : ""}<button class="btn" data-acao="copiar-tabela">Copiar tabela</button></div></div>
    <div class="grade-campos" style="margin-bottom:14px">${seletorAv()}
      <label class="campo"><span>Turma</span><select data-muda="filtro"><option value="">Todas as turmas</option>${ts.map((t) => `<option value="${t.id}" ${filtro === t.id ? "selected" : ""}>${esc(t.nome)}</option>`).join("")}${res.some((r) => !r.alunoId) ? `<option value="_neutras" ${filtro === "_neutras" ? "selected" : ""}>Só folhas neutras</option>` : ""}</select></label></div>
    ${av.planilhaId ? `<p style="margin:-4px 0 14px"><a href="https://docs.google.com/spreadsheets/d/${esc(av.planilhaId)}" target="_blank" rel="noopener">Abrir a planilha no Google Planilhas</a> <small class="muted">· atualizada em ${dataCurta(av.planilhaEm)}</small></p>` : ""}
    <div class="resumo">
      <div><b>${lidas.length}${esperadas ? `<small class="muted" style="font-size:1rem"> / ${esperadas}</small>` : ""}</b><span>folhas lidas</span></div>
      <div><b>${lidas.length ? fmt(media) : "–"}</b><span>média (de ${fmt(valeProva)})</span></div>
      <div><b>${notas.length ? fmt(Math.max(...notas)) : "–"}</b><span>maior nota</span></div>
      <div><b>${notas.length ? fmt(Math.min(...notas)) : "–"}</b><span>menor nota</span></div>
    </div>
    ${lidas.length ? `<div class="bloco" style="margin-bottom:14px"><h3>Acertos por questão</h3><div class="barras">${porQ.map((p, q) => `<div class="barra" title="Questão ${q + 1}: ${p == null ? "sem gabarito" : Math.round(p * 100) + "% de acerto"}"><i style="--p:${p == null ? 0 : Math.round(p * 100)}%;--c:${p == null ? "var(--line)" : p < 0.4 ? "var(--bad)" : p < 0.7 ? "var(--warn)" : "var(--ok)"}"></i>${q + 1}</div>`).join("")}</div></div>` : ""}
    <div class="tabela-wrap"><table><thead><tr><th>Turma</th><th>Nº</th><th>Aluno</th><th>R.A.</th>${multiVer ? "<th>Versão</th>" : ""}<th class="num">Certas</th><th class="num">Erradas</th><th class="num">Nota</th><th>Lida em</th><th>Respostas</th></tr></thead><tbody>
    ${linhas.map((l) => `<tr data-acao="abrir-res" data-av="${av.id}" data-turma="${l.turma ? l.turma.id : ""}" data-aluno="${l.aluno ? l.aluno.id : ""}" data-res="${l.r ? l.r.id : ""}">
      <td>${esc(l.turma ? l.turma.nome : "—")}</td><td class="num">${l.aluno ? String(l.aluno.num).padStart(2, "0") : l.r && l.r.seq ? "#" + l.r.seq : ""}</td>
      <td>${l.aluno ? esc(l.aluno.nome) : `<em>Folha neutra${l.r.nome ? " · " + esc(l.r.nome) : ""}</em>`}</td><td class="mono">${esc(l.aluno ? l.aluno.ra : "")}</td>
      ${multiVer ? `<td>${l.r ? esc(l.r.versao || "A") : ""}</td>` : ""}
      <td class="num">${l.r ? `${l.c.ac}/${l.c.tot}` : ""}</td><td class="num">${l.r ? l.c.er : ""}</td><td class="num nota">${l.r ? fmt(l.c.nota) : `<span class="chip">pendente</span>`}</td>
      <td>${l.r ? dataCurta(l.r.lidoEm) : ""}</td><td class="resp">${l.r ? esc(l.r.respostas) : ""}</td></tr>`).join("") || `<tr><td colspan="10" class="muted">Nenhum aluno nesta seleção.</td></tr>`}
    </tbody></table></div>`;
}

/* Linhas da planilha: todos os alunos das turmas (lidos ou pendentes) + folhas neutras */
function linhasNotas(av, filtro) {
  const res = resultadosDe(av.id);
  const ts = (av.turmas || []).map((id) => S.turmas[id]).filter(Boolean);
  const linhas = [];
  if (filtro !== "_neutras") for (const t of ts) {
    if (filtro && filtro !== t.id) continue;
    for (const a of t.alunos || []) {
      const r = res.find((x) => x.alunoId === a.id && x.turmaId === t.id);
      linhas.push({ turma: t, aluno: a, r, c: r ? corrigir(av, r.respostas, r.versao) : null });
    }
  }
  for (const r of res.filter((x) => !x.alunoId).sort((a, b) => (a.seq || 0) - (b.seq || 0))) {
    if (filtro && filtro !== "_neutras" && filtro !== r.turmaId) continue;
    linhas.push({ turma: S.turmas[r.turmaId] || null, aluno: null, r, c: corrigir(av, r.respostas, r.versao) });
  }
  // resultados de alunos que saíram da turma
  for (const r of res.filter((x) => x.alunoId && !linhas.some((l) => l.r === x))) {
    if (filtro && filtro !== r.turmaId) continue;
    linhas.push({ turma: S.turmas[r.turmaId] || null, aluno: { id: r.alunoId, nome: r.nome, ra: r.ra, num: r.num }, r, c: corrigir(av, r.respostas, r.versao) });
  }
  return linhas;
}

/* ---------- Escola ---------- */
function telaEscola() {
  const p = S.perfil, u = Nuvem.usuario;
  return `<div class="cab"><div><h2>Escola e conta</h2><p>Estes dados aparecem no cabeçalho de todas as suas folhas.</p></div></div>
    <div class="bloco">
      <div class="grade-campos">
        <label class="campo" style="grid-column:1/-1"><span>Escola</span><input type="text" id="pfEscola" value="${esc(p.escola)}" placeholder="Ex.: CENTRO DE ATIVIDADES ENG ROBERTO EGIDIO DE AZEVEDO"></label>
        <label class="campo"><span>Município</span><input type="text" id="pfMunicipio" value="${esc(p.municipio)}"></label>
        <label class="campo"><span>Regional</span><input type="text" id="pfRegional" value="${esc(p.regional)}" placeholder="Ex.: PE"></label>
      </div>
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
        ${p.logo ? `<img src="${esc(p.logo)}" alt="Logo" style="max-height:56px;max-width:180px;background:#fff;padding:4px;border-radius:6px;border:1px solid var(--line)">` : `<span class="muted">Sem logo</span>`}
        <button class="btn peq" data-acao="logo">${p.logo ? "Trocar logo" : "Enviar logo"}</button>
        ${p.logo ? `<button class="btn peq perigo" data-acao="tirar-logo">Remover</button>` : ""}
      </div>
      <div class="acoes"><button class="btn pri" data-acao="salvar-perfil">Salvar</button></div>
    </div>
    <div class="bloco">
      <h3>Conta</h3>
      ${Nuvem.modo === "nuvem" && u ? `<p style="margin:0">Conectado como <strong>${esc(u.displayName || "")}</strong> <span class="muted">${esc(u.email)}</span>. Seus dados ficam na nuvem e sincronizam entre o celular e o computador.</p><div class="acoes"><button class="btn" data-acao="sair">Sair</button></div>`
      : `<p style="margin:0" class="muted">Modo demonstração: os dados ficam salvos só neste navegador. Para usar login e sincronizar entre aparelhos, preencha o arquivo js/config.js com a configuração do Firebase.</p>
      <div class="acoes"><button class="btn" data-acao="exemplo">Carregar dados de exemplo</button></div>`}
    </div>`;
}

/* ===================== Painéis ===================== */
let painelAtual = null;
function abrirPainel(html, ao) {
  $("#painel").innerHTML = html;
  $("#painelFundo").hidden = false;
  document.body.style.overflow = "hidden";
  painelAtual = ao || {};
  const f = $("#painel input, #painel select, #painel textarea");
  if (f && window.matchMedia("(min-width: 700px)").matches) f.focus();
}
function fecharPainel() {
  $("#painelFundo").hidden = true;
  $("#painel").innerHTML = "";
  document.body.style.overflow = "";
  painelAtual = null;
}
const cabPainel = (t) => `<div class="painel-cab"><h2>${t}</h2><button class="btn peq" data-acao="fechar">Fechar</button></div>`;

/* --- Turma --- */
function painelTurma(t) {
  const novo = !t;
  t = t || { id: novoId(), nome: "", turno: "", alunos: [] };
  const linhas = (t.alunos || []).map((a) => `${String(a.num).padStart(2, "0")} | ${a.ra || ""} | ${a.nome}`).join("\n");
  abrirPainel(`${cabPainel(novo ? "Nova turma" : esc(t.nome))}
    <div class="painel-corpo">
      <div class="grade-campos">
        <label class="campo"><span>Nome da turma</span><input type="text" id="tNome" value="${esc(t.nome)}" placeholder="Ex.: 6º A - BILÍNGUE"></label>
        <label class="campo"><span>Turno <small>(opcional)</small></span><input type="text" id="tTurno" value="${esc(t.turno)}" placeholder="Ex.: Manhã"></label>
      </div>
      <label class="campo"><span>Alunos <small>— um por linha: Nº | R.A. | Nome</small></span><textarea id="tAlunos" rows="16" class="mono" spellcheck="false" placeholder="01 | 00327116 | AMANDA VALENTHYNA DE CARVALHO">${esc(linhas)}</textarea></label>
      <small class="muted">O R.A. é o código de barras do aluno. Se ficar vazio, o site cria um código. Mudar o nome não muda o código, então folhas já impressas continuam valendo.</small>
    </div>
    <div class="painel-rodape">${novo ? "" : `<button class="btn perigo" data-acao="excluir-turma" data-id="${t.id}" style="margin-right:auto">Excluir turma</button>`}<button class="btn" data-acao="fechar">Cancelar</button><button class="btn pri" data-acao="salvar-turma">Salvar</button></div>`, { turma: t });
}
function lerTextoAlunos(txt, antigos) {
  const out = [];
  let ult = 0;
  for (const linha of txt.split("\n")) {
    if (!linha.trim()) continue;
    let partes = linha.split(/\s*[|;\t]\s*/).map((s) => s.trim()).filter((s) => s !== "");
    let num = null, ra = "", nome = "";
    if (partes.length >= 3) [num, ra, nome] = [partes[0], partes[1], partes.slice(2).join(" ")];
    else if (partes.length === 2) { if (/^\d{5,}$/.test(partes[0])) [ra, nome] = partes; else [num, nome] = partes; }
    else nome = partes[0];
    const m = /^(\d{1,3})\s*[-.)]?\s+(.+)$/.exec(nome);
    if (num == null && m) { num = m[1]; nome = m[2]; }
    num = num != null && /^\d+$/.test(num) ? +num : ult + 1;
    ult = num;
    ra = /^\d+$/.test(ra) ? ra : "";
    nome = normalizarNome(nome).toUpperCase();
    if (!nome) continue;
    const ant = antigos.find((a) => (ra && a.ra === ra) || a.nome === nome);
    out.push({ id: ra || (ant && ant.id) || "X" + novoId().toUpperCase(), ra, nome, num });
  }
  return out;
}

/* --- Importação de atas --- */
async function importarArquivos(files) {
  toast("Lendo " + files.length + " arquivo(s)…");
  const lidas = [];
  for (const f of files) {
    try {
      if (/\.pdf$/i.test(f.name)) await garantirPdfJs();
      lidas.push(...(await importarAta(f)));
    } catch (e) { lidas.push({ arquivo: f.name, erro: e.message }); }
  }
  // avisos que dependem das outras atas e das turmas já cadastradas
  const vistos = new Map();
  for (const l of lidas) {
    if (l.erro) continue;
    for (const a of l.alunos) {
      if (vistos.has(a.ra) && a.ra) l.avisos.push(`${a.nome} (R.A. ${a.ra}) também está em ${vistos.get(a.ra)}.`);
      else if (a.ra) vistos.set(a.ra, l.turma);
    }
  }
  const nomes = lidas.filter((l) => !l.erro).map((l) => l.turma);
  lidas.forEach((l) => { if (!l.erro && nomes.filter((n) => n === l.turma).length > 1) l.avisos.unshift(`Outra ata também se chama "${l.turma}". Confira o nome da turma antes de salvar.`); });
  painelImportacao(lidas);
}
function painelImportacao(lidas) {
  const existentes = listaTurmas();
  const escolaAta = (lidas.find((l) => l.escola && l.escola.length) || {}).escola || [];
  const sugestaoEscola = escolaAta.find((s) => /unidade|escola|centro|col[eé]gio/i.test(s)) || "";
  abrirPainel(`${cabPainel("Conferir atas")}
    <div class="painel-corpo">
      <p class="muted" style="margin:0">Confira o nome de cada turma e os avisos. Se a turma já existir, os alunos são atualizados pelo R.A. e as folhas já impressas continuam valendo.</p>
      ${lidas.map((l, i) => l.erro ? `<div class="aviso erro"><strong>${esc(l.arquivo)}:</strong> ${esc(l.erro)}</div>` : `
        <div class="bloco">
          <div class="grade-campos">
            <label class="campo"><span>Turma <small>· ${esc(l.arquivo)}</small></span><input type="text" id="imp-nome-${i}" value="${esc(l.turma)}"></label>
            <label class="campo"><span>Salvar como</span><select id="imp-dest-${i}"><option value="novo">Turma nova</option>${existentes.map((t) => `<option value="${t.id}" ${t.nome === l.turma ? "selected" : ""}>Atualizar ${esc(t.nome)}</option>`).join("")}<option value="pular">Não importar</option></select></label>
          </div>
          <div class="meta" style="display:flex;gap:6px;flex-wrap:wrap"><span class="chip acc">${l.alunos.length} alunos</span>${l.avisos.length ? `<span class="chip warn">${l.avisos.length} aviso${l.avisos.length > 1 ? "s" : ""}</span>` : `<span class="chip ok">Sem problemas</span>`}</div>
          ${l.avisos.length ? `<div class="aviso">${l.avisos.map(esc).join("<br>")}</div>` : ""}
          <details><summary class="muted" style="cursor:pointer">Ver alunos</summary><div class="mono" style="font-size:.82rem;margin-top:8px;line-height:1.7">${l.alunos.map((a) => `${String(a.num).padStart(2, "0")} · ${esc(a.ra)} · ${esc(a.nome)}`).join("<br>")}</div></details>
        </div>`).join("")}
      ${sugestaoEscola && !S.perfil.escola ? `<label class="check"><input type="checkbox" id="impEscola" checked> Usar "${esc(sugestaoEscola)}" como nome da escola nas folhas</label>` : ""}
    </div>
    <div class="painel-rodape"><button class="btn" data-acao="fechar">Cancelar</button><button class="btn pri" data-acao="confirmar-importacao">Salvar turmas</button></div>`, { lidas, sugestaoEscola });
}
async function confirmarImportacao() {
  const { lidas, sugestaoEscola } = painelAtual;
  let n = 0;
  for (let i = 0; i < lidas.length; i++) {
    const l = lidas[i];
    if (l.erro) continue;
    const dest = $("#imp-dest-" + i).value;
    if (dest === "pular") continue;
    const nome = $("#imp-nome-" + i).value.trim() || l.turma;
    const base = dest === "novo" ? { id: novoId(), alunos: [] } : { ...S.turmas[dest] };
    const antigos = base.alunos || [];
    const alunos = l.alunos.map((a) => {
      const ant = antigos.find((x) => (a.ra && x.ra === a.ra) || x.nome === a.nome);
      return { id: a.ra || (ant && ant.id) || "X" + novoId().toUpperCase(), ra: a.ra, nome: a.nome, num: a.num };
    });
    await Nuvem.put("turmas", base.id, { ...base, nome, alunos, criadoEm: base.criadoEm || agora() });
    n++;
  }
  if ($("#impEscola") && $("#impEscola").checked) await Nuvem.salvarPerfil({ escola: sugestaoEscola });
  fecharPainel();
  toast(`${n} turma${n !== 1 ? "s" : ""} salva${n !== 1 ? "s" : ""}.`);
}

/* --- Avaliação --- */
function painelAvaliacao(av0) {
  const novo = !av0;
  const av = av0 ? normAv({ ...av0 }) : { id: novoId(), titulo: "", componente: "", subtitulo: "ENSINO FUNDAMENTAL - ANOS FINAIS", turno: "", tipo: "nominal", versoes: 1, secoes: [{ nome: "", tipo: "4", n: 20, certo: 0.5, errado: 0 }], gabaritos: { A: "" }, anulaErrada: false, pontoPorQuestao: false, pontos: [], numChamada: false, turmas: [], transcricao: false, transcricaoTexto: "", instrucoes: "" };
  const ts = listaTurmas();
  // estado do editor: gabarito e pontos guardados por seção, para não embaralhar quando a quantidade muda
  const secs = av.secoes.map((s) => ({ nome: s.nome || "", tipo: String(s.tipo), n: +s.n, certo: +s.certo || 0, errado: +s.errado || 0 }));
  const porSecao = (str) => { const out = []; let k = 0; for (const s of secs) { out.push((str || "").slice(k, k + s.n).padEnd(s.n, "-").split("")); k += s.n; } return out; };
  const gabs = {};
  for (const v of VERSOES) gabs[v] = porSecao(gabDe(av, v));
  const pts = []; { let k = 0; for (const s of secs) { pts.push(Array.from({ length: s.n }, (_, i) => (av.pontos && av.pontos[k + i] != null ? av.pontos[k + i] : ""))); k += s.n; } }
  abrirPainel(`${cabPainel(novo ? "Nova avaliação" : "Editar avaliação")}
    <div class="painel-corpo">
      <div class="grade-campos">
        <label class="campo" style="grid-column:1/-1"><span>Título</span><input type="text" id="avTitulo" value="${esc(av.titulo)}" placeholder="Ex.: AVALIA II - 2026"></label>
        <label class="campo"><span>Componente</span><input type="text" id="avComp" value="${esc(av.componente)}" placeholder="Ex.: LINGUAGENS"></label>
        <label class="campo"><span>Turno <small>(opcional)</small></span><input type="text" id="avTurno" value="${esc(av.turno)}" placeholder="Ex.: Manhã"></label>
        <label class="campo" style="grid-column:1/-1"><span>Linha abaixo do componente <small>(a série vem da turma)</small></span><input type="text" id="avSub" value="${esc(av.subtitulo)}"></label>
      </div>
      <fieldset style="border:0;padding:0;margin:0;display:grid;gap:8px"><legend class="campo" style="margin-bottom:6px;font-weight:700;color:var(--muted);font-size:.9rem">Tipo de folha</legend>
        <div class="opcoes-tipo">
          <label class="opcao"><input type="radio" name="avTipo" value="nominal" ${av.tipo !== "neutra" ? "checked" : ""} data-muda="av-tipo"><span><strong>Nominal</strong><small>Uma folha por aluno, com nome, Nº, código de barras do R.A. e QR code. A nota vai direto para a planilha da turma.</small></span></label>
          <label class="opcao"><input type="radio" name="avTipo" value="neutra" ${av.tipo === "neutra" ? "checked" : ""} data-muda="av-tipo"><span><strong>Neutra</strong><small>Sem nome, para pôr dentro da prova. O QR code identifica a avaliação e a turma; o site mostra o resultado na hora.</small></span></label>
        </div>
        <label class="check" id="avNumLinha" ${av.tipo === "neutra" ? "" : "hidden"}><input type="checkbox" id="avNum" ${av.numChamada ? "checked" : ""}> Grade para o aluno pintar o Nº de chamada <small class="muted">(a nota vai para o aluno certo da turma)</small></label>
      </fieldset>
      <div class="campo"><span>Turmas</span>${ts.length ? `<div style="display:flex;flex-wrap:wrap;gap:8px 18px">${ts.map((t) => `<label class="check"><input type="checkbox" class="avTurma" value="${t.id}" ${(av.turmas || []).includes(t.id) ? "checked" : ""}> ${esc(t.nome)}</label>`).join("")}</div>` : `<span class="muted" style="font-weight:400">Importe as turmas primeiro (aba Turmas).</span>`}</div>
      <div class="bloco">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h3>Questões e pontuação</h3><span class="chip" id="secResumo"></span></div>
        <small class="muted">Divida a prova em seções se quiser misturar tipos (por exemplo, 20 de A a E e 30 de Certo/Errado). De ${LIMITES.min} a ${LIMITES.maxEscolha} questões de alternativas e até ${LIMITES.maxTotal} no total.</small>
        <div id="avSecoes"></div>
        <div class="acoes" style="justify-content:flex-start"><button type="button" class="btn peq" data-acao="sec-add">Adicionar seção</button>
          <span style="display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap"><span class="muted">Valor total</span><input type="number" id="avValorTotal" min="0" step="0.5" value="10" style="width:84px"><button type="button" class="btn peq" data-acao="distribuir">Dividir igualmente</button></span></div>
        <label class="check"><input type="checkbox" id="avAnula" data-muda="av-anula" ${av.anulaErrada ? "checked" : ""}> Uma errada anula uma certa <small class="muted">(cada erro desconta o valor de uma questão; em branco vale zero; a nota não fica negativa)</small></label>
        <label class="check"><input type="checkbox" id="avPPQ" data-muda="av-ppq" ${av.pontoPorQuestao ? "checked" : ""}> Pontuação diferente por questão <small class="muted">(campo de pontos ao lado de cada questão no gabarito)</small></label>
      </div>
      <div class="bloco">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h3>Gabarito</h3>
          <label class="check">Versões da prova <select id="avVersoes" data-muda="av-versoes">${[1, 2, 3, 4].map((n) => `<option value="${n}" ${+av.versoes === n ? "selected" : ""}>${n === 1 ? "Só uma" : VERSOES.slice(0, n).split("").join(", ")}</option>`).join("")}</select></label></div>
        <div id="avGabTopo"></div><div id="avGabGrade"></div>
      </div>
      <details class="bloco"><summary style="cursor:pointer;font-weight:700">Mais opções da folha</summary>
        <label class="check"><input type="checkbox" id="avTrans" ${av.transcricao ? "checked" : ""}> Incluir quadro para o aluno transcrever uma frase</label>
        <label class="campo"><span>Texto do quadro</span><input type="text" id="avTransTxt" value="${esc(av.transcricaoTexto)}" placeholder="ATENÇÃO: TRANSCREVA AQUI, COM A SUA CALIGRAFIA USUAL, A FRASE APRESENTADA NA CAPA DO SEU CADERNO DE QUESTÕES."></label>
        <label class="campo"><span>Instruções <small>(uma por linha; vazio usa o padrão)</small></span><textarea id="avInstr" rows="5" placeholder="${esc(INSTRUCOES_PADRAO.join("\n"))}">${esc(av.instrucoes)}</textarea></label>
      </details>
    </div>
    <div class="painel-rodape">${novo ? "" : `<button class="btn perigo" data-acao="excluir-av" data-id="${av.id}" style="margin-right:auto">Excluir</button>`}<button class="btn" data-acao="fechar">Cancelar</button><button class="btn pri" data-acao="salvar-av">Salvar</button></div>`, { av, novo, secs, gabs, pts, ver: "A" });
  desenharSecoes();
}

const arred = (n) => Math.round(n * 10000) / 10000;
function validarSecoes(secs) {
  const tot = secs.reduce((s, x) => s + x.n, 0), esc_ = secs.filter((x) => x.tipo !== "C").reduce((s, x) => s + x.n, 0);
  if (secs.some((x) => !(x.n >= 1))) return "Cada seção precisa ter pelo menos 1 questão.";
  if (tot < LIMITES.min) return `A prova precisa ter pelo menos ${LIMITES.min} questões.`;
  if (esc_ > LIMITES.maxEscolha) return `Questões de alternativas: no máximo ${LIMITES.maxEscolha} (agora são ${esc_}).`;
  if (tot > LIMITES.maxTotal) return `No máximo ${LIMITES.maxTotal} questões no total (agora são ${tot}).`;
  return "";
}
/* Pontos de cada questão, como ficariam se salvasse agora */
function pontosEditor() {
  const p = painelAtual, ppq = $("#avPPQ").checked, anula = $("#avAnula").checked;
  const out = [];
  p.secs.forEach((s, si) => { for (let i = 0; i < s.n; i++) { const v = ppq && p.pts[si][i] !== "" && p.pts[si][i] != null ? +p.pts[si][i] : s.certo; out.push({ certo: v, errado: anula ? v : s.errado }); } });
  return out;
}
let _desenhando = false;
function desenharSecoes() {
  // trocar o HTML tira o foco do campo, o que dispara outro "change"; evita redesenhar dentro do redesenho
  if (_desenhando || !painelAtual) return;
  _desenhando = true;
  try { desenharSecoes_(); } finally { _desenhando = false; }
}
function desenharSecoes_() {
  const p = painelAtual, anula = $("#avAnula").checked, ppq = $("#avPPQ").checked;
  const varias = p.secs.length > 1;
  $("#avSecoes").innerHTML = p.secs.map((s, si) => `<div class="secao">
    ${varias ? `<label class="campo nome"><span>Seção ${si + 1}</span><input type="text" value="${esc(s.nome)}" placeholder="Ex.: Matemática" data-muda="sec" data-si="${si}" data-k="nome"></label>` : ""}
    <label class="campo"><span>Tipo</span><select data-muda="sec" data-si="${si}" data-k="tipo">${TIPOS.map(([v, n]) => `<option value="${v}" ${s.tipo === v ? "selected" : ""}>${n}</option>`).join("")}</select></label>
    <label class="campo"><span>Questões</span><input type="number" min="1" max="${LIMITES.maxTotal}" value="${s.n}" data-muda="sec" data-si="${si}" data-k="n"></label>
    <label class="campo"><span>${ppq ? "Pontos (padrão)" : "Pontos por certa"}</span><input type="number" min="0" step="0.05" value="${arred(s.certo)}" data-muda="sec" data-si="${si}" data-k="certo"></label>
    <label class="campo"><span>Desconto por errada</span><input type="number" min="0" step="0.05" value="${anula ? "" : arred(s.errado)}" ${anula ? `disabled placeholder="= valor da questão"` : ""} data-muda="sec" data-si="${si}" data-k="errado"></label>
    ${varias ? `<button type="button" class="btn peq perigo" data-acao="sec-del" data-si="${si}" title="Remover seção">Remover</button>` : ""}
  </div>`).join("");
  const erro = validarSecoes(p.secs);
  const tot = p.secs.reduce((s, x) => s + x.n, 0);
  const valor = pontosEditor().reduce((s, x) => s + x.certo, 0);
  const st = $("#secResumo");
  st.textContent = erro || `${tot} questões · vale ${fmt(valor)}`;
  st.className = "chip " + (erro ? "bad" : "ok");
  desenharGabarito();
}
function desenharGabarito(soGrade) {
  const p = painelAtual, nv = +$("#avVersoes").value, ppq = $("#avPPQ").checked;
  if (VERSOES.indexOf(p.ver) >= nv) p.ver = "A";
  const g = p.gabs[p.ver], vs = VERSOES.slice(0, nv).split("");
  const falta = (v) => p.secs.reduce((s, x, si) => s + p.gabs[v][si].slice(0, x.n).filter((c) => c !== "X" && !letrasTipo(x.tipo).includes(c)).length, 0);
  let h = nv > 1 ? `<div class="abas-ver" role="tablist">${vs.map((v) => { const f = falta(v); return `<button type="button" role="tab" class="aba-ver" data-acao="ver-gab" data-v="${v}" aria-selected="${v === p.ver}">Versão ${v} <small class="${f ? "warn" : "ok"}">${f ? "faltam " + f : "completo"}</small></button>`; }).join("")}</div>` : "";
  const texto = p.secs.map((x, si) => g[si].slice(0, x.n).map((c) => (c === "X" || letrasTipo(x.tipo).includes(c) ? c : ".")).join("")).join("");
  const temCE = p.secs.some((x) => x.tipo === "C");
  if (!soGrade) $("#avGabTopo").innerHTML = h + `<label class="campo"><span>Digitar ou colar ${nv > 1 ? "a versão " + p.ver : ""} de uma vez <small>(ex.: ABCDA BCDAB${temCE ? "; Certo/Errado: C e E, ou V e F" : ""}; X anula a questão)</small></span><input type="text" id="avGabTexto" class="mono" value="${esc(texto)}" data-muda="gab-texto" autocomplete="off" spellcheck="false"></label>`;
  else $("#avGabTopo .abas-ver") && ($("#avGabTopo .abas-ver").outerHTML = h);
  h = "";
  let q = 0;
  p.secs.forEach((x, si) => {
    const L = letrasTipo(x.tipo);
    if (p.secs.length > 1 || x.tipo === "C") h += `<div class="sec-titulo">${esc(x.nome || (p.secs.length > 1 ? "Seção " + (si + 1) : ""))} <small class="muted">· ${esc(NOME_TIPO[x.tipo])}${x.tipo === "C" ? " (C = Certo, E = Errado)" : ""}</small></div>`;
    h += `<div class="gab">`;
    for (let i = 0; i < x.n; i++, q++) {
      h += `<div class="gq"><span>${q + 1}</span>`;
      for (const a of L) h += `<button type="button" class="bol" data-acao="gab" data-si="${si}" data-i="${i}" data-v="${a}" aria-pressed="${g[si][i] === a}">${a}</button>`;
      h += `<button type="button" class="bol anula" data-acao="gab" data-si="${si}" data-i="${i}" data-v="X" aria-pressed="${g[si][i] === "X"}" title="Anular questão (todos ganham o ponto)">X</button>`;
      if (ppq) h += `<input type="number" class="pq" min="0" step="0.05" value="${p.pts[si][i] === "" || p.pts[si][i] == null ? "" : p.pts[si][i]}" placeholder="${arred(x.certo)}" data-muda="pq" data-si="${si}" data-i="${i}" title="Pontos da questão ${q + 1}" aria-label="Pontos da questão ${q + 1}">`;
      h += `</div>`;
    }
    h += `</div>`;
  });
  const f = falta(p.ver);
  h += `<small class="muted">${f ? `Faltam ${f} questões${nv > 1 ? " na versão " + p.ver : ""}.` : `Gabarito${nv > 1 ? " da versão " + p.ver : ""} completo.`}</small>`;
  $("#avGabGrade").innerHTML = h;
}
function ajustarSecoes() {
  // garante que os vetores de gabarito e pontos acompanhem o número de questões de cada seção
  const p = painelAtual;
  p.secs.forEach((s, si) => {
    for (const v of VERSOES) { const a = p.gabs[v][si] || (p.gabs[v][si] = []); while (a.length < s.n) a.push("-"); }
    const a = p.pts[si] || (p.pts[si] = []); while (a.length < s.n) a.push("");
  });
}
function salvarAvaliacao() {
  const p = painelAtual, { av } = p;
  const erro = validarSecoes(p.secs);
  if (erro) { toast(erro); return; }
  const nv = +$("#avVersoes").value, ppq = $("#avPPQ").checked;
  const gabaritos = {};
  for (const v of VERSOES.slice(0, nv)) gabaritos[v] = p.secs.map((x, si) => p.gabs[v][si].slice(0, x.n).map((c) => (c === "X" || letrasTipo(x.tipo).includes(c) ? c : "-")).join("")).join("");
  const pontos = ppq ? p.secs.flatMap((x, si) => p.pts[si].slice(0, x.n).map((v) => (v === "" || v == null ? null : +v))) : [];
  const dados = {
    ...av,
    titulo: $("#avTitulo").value.trim(), componente: $("#avComp").value.trim(), subtitulo: $("#avSub").value.trim(), turno: $("#avTurno").value.trim(),
    tipo: document.querySelector("input[name=avTipo]:checked").value,
    secoes: p.secs.map((s) => ({ nome: s.nome.trim(), tipo: s.tipo, n: s.n, certo: s.certo, errado: s.errado })),
    versoes: nv, gabaritos, anulaErrada: $("#avAnula").checked, pontoPorQuestao: ppq, pontos,
    numChamada: $("#avNum").checked,
    turmas: [...document.querySelectorAll(".avTurma:checked")].map((c) => c.value),
    transcricao: $("#avTrans").checked, transcricaoTexto: $("#avTransTxt").value.trim(), instrucoes: $("#avInstr").value.trim(),
    criadoEm: av.criadoEm || agora(),
  };
  ["nQ", "nAlt", "valor", "gabarito"].forEach((k) => delete dados[k]);
  if (!dados.titulo) { toast("Dê um título à avaliação."); $("#avTitulo").focus(); return; }
  Nuvem.put("avaliacoes", av.id, dados);
  ui.avSel = av.id;
  fecharPainel();
  toast("Avaliação salva.");
}

/* --- Resultado (conferir ou lançar à mão) --- */
function painelResultado(avId, turmaId, alunoId, resId) {
  const av = AV(avId);
  const turma = S.turmas[turmaId];
  let r = resId && S.resultados[resId];
  const aluno = turma && alunoId ? (turma.alunos || []).find((a) => a.id === alunoId) : null;
  const novo = !r;
  if (!r) r = { id: `${avId}__${turmaId}__${alunoId}`, avaliacaoId: avId, turmaId, alunoId, nome: aluno ? aluno.nome : "", ra: aluno ? aluno.ra : "", num: aluno ? aluno.num : null, respostas: "-".repeat(totalQ(av)), versao: "A", origem: "manual", tipo: "nominal" };
  const c = corrigir(av, r.respostas, r.versao);
  abrirPainel(`${cabPainel(esc(aluno ? aluno.nome : r.nome || "Folha neutra" + (r.seq ? " nº " + r.seq : "")))}
    <div class="painel-corpo">
      <p class="muted" style="margin:0">${esc(av.titulo)} · ${esc(turma ? turma.nome : "sem turma")}${r.lidoEm ? " · lida em " + dataCurta(r.lidoEm) : novo ? " · ainda não lida: lance as respostas à mão se precisar" : ""}${r.origem === "manual" && !novo ? " · lançada/ajustada à mão" : ""}</p>
      <div class="resumo"><div><b id="resNota">${fmt(c.nota)}</b><span>nota (de ${fmt(c.total)})</span></div><div><b id="resAc">${c.ac}/${c.tot}</b><span>certas</span></div><div><b id="resEr">${c.er}</b><span>erradas</span></div></div>
      ${+av.versoes > 1 ? `<label class="campo" style="max-width:220px"><span>Versão da prova</span><select data-muda="ver-painel">${VERSOES.slice(0, av.versoes).split("").map((v) => `<option value="${v}" ${(r.versao || "A") === v ? "selected" : ""}>Versão ${v}</option>`).join("")}</select></label>` : ""}
      ${!r.alunoId ? `<label class="campo"><span>Nome <small>(opcional)</small></span><input type="text" id="resNome" value="${esc(r.nome || "")}"></label>` : ""}
      <div id="resGrade">${gradeRespostas(av, r).replaceAll('data-muda="resp"', 'data-muda="resp-painel"')}</div>
    </div>
    <div class="painel-rodape">${novo ? "" : `<button class="btn perigo" data-acao="excluir-res" data-id="${r.id}" style="margin-right:auto">Apagar leitura</button>`}<button class="btn" data-acao="fechar">Cancelar</button><button class="btn pri" data-acao="salvar-res">Salvar</button></div>`, { r: { ...r }, av });
}
function atualizarPainelResultado() {
  const { r, av } = painelAtual;
  const c = corrigir(av, r.respostas, r.versao);
  $("#resNota").textContent = fmt(c.nota); $("#resAc").textContent = `${c.ac}/${c.tot}`; $("#resEr").textContent = c.er;
}

/* ===================== Leitura ===================== */
async function processarCanvas(canvas, arquivo) {
  let L;
  try { L = lerFolha(canvas); }
  catch (e) { return { erro: e.message, arquivo, codigo: e.codigo }; }
  const info = L.info;
  const av = AV(info.avId);
  if (!av) return { erro: "Esta folha é de uma avaliação que não está na sua conta (pode ter sido excluída ou ser de outro professor).", arquivo };
  const turma = info.turmaId ? S.turmas[info.turmaId] : null;
  const versao = info.ver || "A";
  const previa = previaLeitura(canvas, L, gabDe(av, versao), 360).toDataURL("image/jpeg", 0.72);
  const n = totalQ(av);
  const respostas = (L.resp + "-".repeat(n)).slice(0, Math.max(n, L.resp.length));
  let res, substituiu = false, aviso = "";
  // folha neutra com o Nº de chamada pintado: a nota vai para o aluno daquele número
  const porNumero = !info.alunoId && info.L.num && turma && L.numero != null ? (turma.alunos || []).find((a) => +a.num === L.numero) : null;
  if (!info.alunoId && info.L.num) {
    if (L.numero == null) aviso = "Nº de chamada em branco ou ilegível";
    else if (!turma) aviso = `Nº ${L.numero} lido, mas a folha não tem turma`;
    else if (!porNumero) aviso = `Nº ${L.numero} não está na turma`;
  }
  const alunoId = info.alunoId || (porNumero && porNumero.id);
  if (alunoId) {
    const aluno = turma && (turma.alunos || []).find((a) => a.id === alunoId);
    const id = `${av.id}__${info.turmaId}__${alunoId}`;
    substituiu = !!S.resultados[id];
    res = { id, avaliacaoId: av.id, turmaId: info.turmaId, alunoId, nome: aluno ? aluno.nome : "(aluno removido da turma)", ra: aluno ? aluno.ra : "", num: aluno ? aluno.num : null, respostas, versao, lidoEm: agora(), origem: "leitura", tipo: info.alunoId ? "nominal" : "neutra-numero" };
  } else {
    const seq = resultadosDe(av.id).filter((r) => !r.alunoId && r.turmaId === info.turmaId).reduce((m, r) => Math.max(m, r.seq || 0), 0) + 1;
    res = { id: `${av.id}__n__${novoId()}`, avaliacaoId: av.id, turmaId: info.turmaId, alunoId: null, nome: "", seq, respostas, versao, lidoEm: agora(), origem: "leitura", tipo: "neutra" };
    if (L.numero != null) res.numLido = L.numero;
  }
  await Nuvem.put("resultados", res.id, res);
  return { resId: res.id, res, previa, substituiu, arquivo, aviso };
}

async function processarArquivos(files) {
  for (const f of files) {
    toast("Lendo " + f.name + "…", 10000);
    try {
      const cv = await arquivoParaCanvas(f);
      ui.leituras.unshift(await processarCanvas(cv, f.name));
    } catch (e) { ui.leituras.unshift({ erro: e.message, arquivo: f.name }); }
    render();
  }
  const ultimo = ui.leituras[0];
  toast(ultimo && !ultimo.erro ? "Folha lida e nota salva." : "Não foi possível ler a folha.");
}

/* Câmera ao vivo: tenta ler um quadro a cada ~0,4 s; ao ler, pausa até o professor pedir a próxima */
async function abrirCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast("Este navegador não libera a câmera aqui. Use 'Tirar foto'."); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }); }
  catch (e) { toast("Não consegui abrir a câmera. Verifique a permissão do navegador ou use 'Tirar foto'."); return; }
  const el = document.createElement("div");
  el.className = "camera";
  el.innerHTML = `<video playsinline muted autoplay></video><div class="guias"><i></i><i></i><i></i><i></i></div><button class="btn peq fechar" data-acao="fechar-camera">Fechar câmera</button><div class="status">Encaixe os 4 quadrados pretos da folha nas marcas dos cantos.</div>`;
  const video = el.querySelector("video");
  video.srcObject = stream;
  ui.camera = { el, stream, video, pausada: false, timer: null };
  render();
  let wake = null;
  try { wake = await navigator.wakeLock.request("screen"); } catch (e) { /* opcional */ }
  ui.camera.wake = wake;
  const cv = document.createElement("canvas");
  const status = el.querySelector(".status");
  const ciclo = async () => {
    const cam = ui.camera;
    if (!cam || cam.el !== el) return;
    if (!cam.pausada && video.videoWidth) {
      const k = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
      cv.width = Math.round(video.videoWidth * k); cv.height = Math.round(video.videoHeight * k);
      cv.getContext("2d", { willReadFrequently: true }).drawImage(video, 0, 0, cv.width, cv.height);
      const r = await processarCanvas(cv, "Câmera");
      el.querySelector(".guias").classList.toggle("ok", !r.erro || r.codigo === "qr");
      if (!r.erro) {
        cam.pausada = true;
        if (navigator.vibrate) navigator.vibrate(120);
        ui.leituras.unshift(r);
        const res = S.resultados[r.resId] || r.res, av = AV(res.avaliacaoId);
        status.innerHTML = `<strong>${esc(res.alunoId ? res.nome : "Folha neutra")}: ${fmt(corrigir(av, res.respostas, res.versao).nota)}</strong> · salvo${r.aviso ? " · " + esc(r.aviso) : ""}. <button class="btn peq pri" data-acao="proxima" style="margin-left:8px">Próxima folha</button>`;
        render();
      } else if (r.codigo === "qr") status.textContent = "Folha encontrada. Aproxime um pouco para ler o QR code.";
      else if (r.codigo === "cantos") status.textContent = "Encaixe os 4 quadrados pretos da folha nas marcas dos cantos.";
      else status.textContent = r.erro;
    }
    cam.timer = setTimeout(ciclo, 400);
  };
  ciclo();
}
function fecharCamera() {
  const c = ui.camera;
  if (!c) return;
  clearTimeout(c.timer);
  c.stream.getTracks().forEach((t) => t.stop());
  if (c.wake) c.wake.release().catch(() => {});
  ui.camera = null;
  render();
}

/* ===================== Exportação ===================== */
function tabelaNotas(av, turmaId) {
  const n = totalQ(av), multiVer = +av.versoes > 1;
  const cab = ["Turma", "Nº", "R.A.", "Aluno", ...(multiVer ? ["Versão"] : []), "Certas", "Erradas", "Questões válidas", "Nota", "Valor da prova", "Situação", "Lida em", ...Array.from({ length: n }, (_, i) => "Q" + (i + 1))];
  const linhas = linhasNotas(av, turmaId).map((l) => [
    l.turma ? l.turma.nome : "",
    l.aluno ? l.aluno.num : l.r && l.r.seq ? "#" + l.r.seq : "",
    l.aluno ? l.aluno.ra || "" : "",
    l.aluno ? l.aluno.nome : "Folha neutra" + (l.r.nome ? " · " + l.r.nome : ""),
    ...(multiVer ? [l.r ? l.r.versao || "A" : ""] : []),
    l.r ? l.c.ac : "", l.r ? l.c.er : "", l.r ? l.c.tot : "", l.r ? Math.round(l.c.nota * 100) / 100 : "", l.r ? l.c.total : "",
    l.r ? "Corrigida" : "Pendente", l.r ? dataCurta(l.r.lidoEm) : "",
    ...Array.from({ length: n }, (_, q) => (l.r ? (l.r.respostas[q] || "-").replace("*", "2+").replace("-", "") : "")),
  ]);
  return [cab, ...linhas];
}
function nomeAba(s, usados) {
  let n = String(s).replace(/[\[\]:*?/\\]/g, "-").slice(0, 31) || "Turma";
  let k = 2;
  while (usados.has(n)) n = n.slice(0, 28) + " " + k++;
  usados.add(n);
  return n;
}
function abasExportacao(av) {
  const ts = (av.turmas || []).map((id) => S.turmas[id]).filter(Boolean);
  const abas = ts.map((t) => ({ titulo: t.nome, dados: tabelaNotas(av, t.id) }));
  if (resultadosDe(av.id).some((r) => !r.alunoId)) abas.push({ titulo: "Folhas neutras", dados: tabelaNotas(av, "_neutras") });
  const Q = infoQ(av), nv = +av.versoes || 1;
  const g = [["Questão", ...Q.map((_, i) => i + 1)]];
  if (av.secoes.length > 1) g.push(["Seção", ...Q.map((x) => av.secoes[x.si].nome || "Seção " + (x.si + 1))]);
  g.push(["Tipo", ...Q.map((x) => (x.tipo === "C" ? "Certo/Errado" : "A-" + LETRAS[+x.tipo - 1]))]);
  for (const v of VERSOES.slice(0, nv)) g.push([nv > 1 ? "Gabarito " + v : "Gabarito", ...Q.map((_, q) => { const c = gabDe(av, v)[q] || "-"; return c === "X" ? "Anulada" : c === "-" ? "" : c; })]);
  g.push(["Pontos (certa)", ...Q.map((x) => x.certo)], ["Desconto (errada)", ...Q.map((x) => x.errado)]);
  abas.push({ titulo: "Gabarito", dados: g });
  return abas;
}
function exportarXLSX() {
  const av = avAtual();
  if (!av) return;
  const wb = XLSX.utils.book_new(), usados = new Set();
  for (const a of abasExportacao(av)) {
    const ws = XLSX.utils.aoa_to_sheet(a.dados);
    ws["!cols"] = a.dados[0].map((c, i) => ({ wch: /^Q\d+$/.test(c) || typeof c === "number" ? 5 : i === 3 ? 42 : i === 0 ? 18 : 11 }));
    XLSX.utils.book_append_sheet(wb, ws, nomeAba(a.titulo, usados));
  }
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  salvarArquivo(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), nomeArquivo(`Notas - ${av.titulo}${av.componente ? " - " + av.componente : ""}.xlsx`));
}
async function exportarSheets() {
  const av = avAtual();
  if (!av) return;
  let token;
  try { token = await Nuvem.tokenGoogle(); } catch (e) { toast("Sem acesso ao Google Planilhas: " + e.message); return; }
  toast("Enviando para o Google Planilhas…", 15000);
  const api = async (url, metodo = "GET", corpo) => {
    const r = await fetch(url, { method: metodo, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: corpo ? JSON.stringify(corpo) : undefined });
    if (!r.ok) { const e = new Error((await r.json().catch(() => ({}))).error?.message || r.statusText); e.status = r.status; throw e; }
    return r.json();
  };
  const usados = new Set();
  const abas = abasExportacao(av).map((a) => ({ ...a, nome: nomeAba(a.titulo, usados) }));
  try {
    let sid = av.planilhaId;
    let existentes = [];
    if (sid) {
      try { existentes = (await api(`https://sheets.googleapis.com/v4/spreadsheets/${sid}?fields=sheets.properties`)).sheets.map((s) => s.properties); }
      catch (e) { if (e.status === 404 || e.status === 403) sid = null; else throw e; }
    }
    if (!sid) {
      const nova = await api("https://sheets.googleapis.com/v4/spreadsheets", "POST", { properties: { title: `Notas - ${av.titulo}${av.componente ? " - " + av.componente : ""}`, locale: "pt_BR" }, sheets: abas.map((a) => ({ properties: { title: a.nome } })) });
      sid = nova.spreadsheetId;
      existentes = nova.sheets.map((s) => s.properties);
    }
    const faltam = abas.filter((a) => !existentes.some((e) => e.title === a.nome));
    if (faltam.length) await api(`https://sheets.googleapis.com/v4/spreadsheets/${sid}:batchUpdate`, "POST", { requests: faltam.map((a) => ({ addSheet: { properties: { title: a.nome } } })) });
    await api(`https://sheets.googleapis.com/v4/spreadsheets/${sid}/values:batchClear`, "POST", { ranges: abas.map((a) => `'${a.nome}'`) });
    await api(`https://sheets.googleapis.com/v4/spreadsheets/${sid}/values:batchUpdate`, "POST", { valueInputOption: "RAW", data: abas.map((a) => ({ range: `'${a.nome}'!A1`, values: a.dados.map((l) => l.map((v) => (v === "" || v == null ? "" : v))) })) });
    await Nuvem.put("avaliacoes", av.id, { ...av, planilhaId: sid, planilhaEm: agora() });
    toast("Planilha atualizada no seu Google Drive.");
  } catch (e) { toast("Não foi possível enviar para o Google Planilhas: " + e.message, 7000); }
}
function copiarTabela() {
  const av = avAtual();
  if (!av) return;
  const txt = tabelaNotas(av, ui.turmaFiltro).map((l) => l.join("\t")).join("\n");
  navigator.clipboard.writeText(txt).then(() => toast("Tabela copiada. Cole no Excel ou no Google Planilhas."), () => toast("Não consegui copiar automaticamente neste navegador."));
}

/* ===================== Geração das folhas ===================== */
async function gerarFolhas(fmtArq, turmaId) {
  const av = avAtual();
  if (!av) return;
  const neutra = av.tipo === "neutra";
  let folhas = [], rotulo;
  if (turmaId === "*") {
    for (const id of av.turmas || []) if (S.turmas[id]) folhas.push(...folhasPara(av, S.turmas[id], S.perfil));
    rotulo = "todas as turmas";
  } else {
    const t = turmaId ? S.turmas[turmaId] : null;
    const cop = neutra ? +($("#cop-" + (turmaId || "-")) || {}).value || 1 : 0;
    folhas = folhasPara(av, t, S.perfil, cop);
    rotulo = t ? t.nome : "sem turma";
  }
  if (!folhas.length) { toast("Esta turma não tem alunos."); return; }
  const prog = $("#progGerar");
  prog.hidden = false;
  const mostrar = (i, n) => { prog.querySelector("i").style.width = (100 * i) / n + "%"; prog.querySelector("small").textContent = `Gerando folha ${i} de ${n}…`; };
  document.querySelectorAll("[data-acao=gerar]").forEach((b) => (b.disabled = true));
  try {
    const blob = fmtArq === "pdf" ? await gerarPDF(folhas, mostrar) : await gerarDOCX(folhas, mostrar);
    salvarArquivo(blob, nomeArquivo(`Folhas - ${av.titulo} - ${rotulo}.${fmtArq}`));
    prog.querySelector("small").textContent = `${folhas.length} folha${folhas.length > 1 ? "s" : ""} gerada${folhas.length > 1 ? "s" : ""}.`;
  } catch (e) { toast("Erro ao gerar: " + e.message); prog.hidden = true; }
  document.querySelectorAll("[data-acao=gerar]").forEach((b) => (b.disabled = false));
}

/* ===================== Dados de exemplo (modo demonstração) ===================== */
function carregarExemplo() {
  const nomes = ["ANA CLARA SOUZA", "BRUNO HENRIQUE LIMA", "CAMILA FERREIRA", "DAVI SANTOS COSTA", "EDUARDA MELO", "FELIPE ARAÚJO", "GABRIELA NUNES", "HEITOR CAVALCANTI"];
  const t = { id: "exemplo6a", nome: "6º A - EXEMPLO", turno: "Manhã", alunos: nomes.map((n, i) => ({ id: String(91000001 + i).padStart(8, "0"), ra: String(91000001 + i).padStart(8, "0"), nome: n, num: i + 1 })), criadoEm: agora() };
  Nuvem.put("turmas", t.id, t);
  Nuvem.put("avaliacoes", "exemploav", { id: "exemploav", titulo: "SIMULADO - EXEMPLO", componente: "LINGUAGENS", subtitulo: "ENSINO FUNDAMENTAL - ANOS FINAIS", tipo: "nominal", versoes: 1, secoes: [{ nome: "", tipo: "4", n: 20, certo: 0.5, errado: 0 }], gabaritos: { A: "ABCDABCDABCDABCDABCD" }, anulaErrada: false, pontoPorQuestao: false, pontos: [], turmas: [t.id], transcricao: false, criadoEm: agora() });
  ui.avSel = "exemploav";
  toast("Exemplo carregado: 1 turma e 1 avaliação.");
}

/* ===================== Eventos ===================== */
const acoes = {
  entrar: () => Nuvem.entrar(),
  sair: () => Nuvem.sair(),
  fechar: fecharPainel,
  "importar-atas": () => $("#arqAtas").click(),
  "nova-turma": () => painelTurma(null),
  "editar-turma": (el) => painelTurma(S.turmas[el.dataset.id]),
  "salvar-turma": () => {
    const { turma } = painelAtual;
    const nome = $("#tNome").value.trim();
    if (!nome) { toast("Dê um nome à turma."); return; }
    const alunos = lerTextoAlunos($("#tAlunos").value, turma.alunos || []);
    Nuvem.put("turmas", turma.id, { ...turma, nome, turno: $("#tTurno").value.trim(), alunos, criadoEm: turma.criadoEm || agora() });
    fecharPainel(); toast("Turma salva.");
  },
  "excluir-turma": (el) => armar(el, () => { Nuvem.del("turmas", el.dataset.id); fecharPainel(); toast("Turma excluída."); }),
  "confirmar-importacao": confirmarImportacao,
  "nova-av": () => painelAvaliacao(null),
  "editar-av": (el) => painelAvaliacao(AV(el.dataset.id)),
  "salvar-av": salvarAvaliacao,
  "excluir-av": (el) => armar(el, () => { Nuvem.del("avaliacoes", el.dataset.id); fecharPainel(); toast("Avaliação excluída. As notas lidas continuam guardadas."); }),
  gab: (el) => {
    const p = painelAtual, si = +el.dataset.si, i = +el.dataset.i, v = el.dataset.v;
    const a = p.gabs[p.ver][si];
    a[i] = a[i] === v ? "-" : v;
    desenharGabarito();
  },
  "ver-gab": (el) => { painelAtual.ver = el.dataset.v; desenharGabarito(); },
  "sec-add": () => {
    const p = painelAtual, ult = p.secs[p.secs.length - 1];
    p.secs.push({ nome: "", tipo: "C", n: 10, certo: ult ? ult.certo : 1, errado: 0 });
    ajustarSecoes(); desenharSecoes();
  },
  "sec-del": (el) => {
    const p = painelAtual, si = +el.dataset.si;
    p.secs.splice(si, 1); p.pts.splice(si, 1);
    for (const v of VERSOES) p.gabs[v].splice(si, 1);
    desenharSecoes();
  },
  distribuir: () => {
    const p = painelAtual, valor = +$("#avValorTotal").value;
    const n = p.secs.reduce((s, x) => s + x.n, 0);
    if (!(valor > 0) || !n) { toast("Informe o valor total da prova."); return; }
    p.secs.forEach((s) => (s.certo = valor / n));
    p.pts.forEach((a) => a.fill(""));
    desenharSecoes();
    toast(`Cada questão vale ${fmt(valor / n)}.`);
  },
  gerar: (el) => gerarFolhas(el.dataset.fmt, el.dataset.turma),
  camera: abrirCamera,
  "fechar-camera": fecharCamera,
  proxima: () => {
    if (!ui.camera) return;
    ui.camera.pausada = false;
    ui.camera.el.querySelector(".status").textContent = "Enquadre a próxima folha, com os 4 quadrados pretos dentro das marcas.";
  },
  foto: () => $("#arqFotos").click(),
  galeria: () => $("#arqGaleria").click(),
  "abrir-res": (el) => painelResultado(el.dataset.av, el.dataset.turma, el.dataset.aluno, el.dataset.res),
  "salvar-res": () => {
    const { r } = painelAtual;
    if ($("#resNome")) r.nome = $("#resNome").value.trim();
    if (r.origem !== "leitura" || r._editado) r.origem = "manual";
    delete r._editado;
    if (!r.lidoEm) r.lidoEm = agora();
    Nuvem.put("resultados", r.id, r);
    fecharPainel(); toast("Respostas salvas.");
  },
  "excluir-res": (el) => armar(el, () => { Nuvem.del("resultados", el.dataset.id); fecharPainel(); toast("Leitura apagada."); }),
  "exp-xlsx": exportarXLSX,
  "exp-sheets": exportarSheets,
  "copiar-tabela": copiarTabela,
  logo: () => $("#arqLogo").click(),
  "tirar-logo": () => Nuvem.salvarPerfil({ logo: "" }),
  "salvar-perfil": () => { Nuvem.salvarPerfil({ escola: $("#pfEscola").value.trim(), municipio: $("#pfMunicipio").value.trim(), regional: $("#pfRegional").value.trim() }); toast("Dados da escola salvos."); },
  exemplo: carregarExemplo,
};

document.addEventListener("click", (e) => {
  const aba = e.target.closest("[data-aba]");
  if (aba) { ui.aba = aba.dataset.aba; if (ui.aba !== "corrigir" && ui.camera) fecharCamera(); location.hash = ui.aba; render(); window.scrollTo(0, 0); return; }
  const el = e.target.closest("[data-acao]");
  if (el && acoes[el.dataset.acao]) { e.preventDefault(); acoes[el.dataset.acao](el); return; }
  if (e.target.id === "painelFundo") fecharPainel();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && painelAtual) fecharPainel(); });

document.addEventListener("change", (e) => {
  const el = e.target, m = el.dataset.muda;
  if (m === "av") { ui.avSel = el.value; render(); }
  else if (m === "filtro") { ui.turmaFiltro = el.value; render(); }
  else if (m === "sec") {
    const p = painelAtual, sec = p.secs[+el.dataset.si], k = el.dataset.k;
    if (k === "nome" || k === "tipo") sec[k] = el.value;
    else if (k === "n") sec.n = Math.max(1, Math.min(LIMITES.maxTotal, Math.round(+el.value || 1)));
    else sec[k] = Math.max(0, +el.value || 0);
    ajustarSecoes();
    if (k !== "nome") desenharSecoes(); else desenharGabarito();
  } else if (m === "av-anula" || m === "av-ppq") desenharSecoes();
  else if (m === "av-versoes") desenharGabarito();
  else if (m === "av-tipo") $("#avNumLinha").hidden = document.querySelector("input[name=avTipo]:checked").value !== "neutra";
  else if (m === "pq") {
    painelAtual.pts[+el.dataset.si][+el.dataset.i] = el.value === "" ? "" : Math.max(0, +el.value || 0);
    desenharSecoes();
  }
  else if (m === "resp") {
    const r = { ...S.resultados[el.dataset.res] };
    const arr = r.respostas.split(""); arr[+el.dataset.q] = el.value; r.respostas = arr.join(""); r.origem = "manual";
    Nuvem.put("resultados", r.id, r);
    const l = ui.leituras.find((x) => x.resId === r.id); if (l) l.res = r;
  } else if (m === "resp-painel") {
    const { r, av } = painelAtual;
    const n = totalQ(av);
    const arr = (r.respostas + "-".repeat(n)).split(""); arr[+el.dataset.q] = el.value; r.respostas = arr.join("").slice(0, Math.max(n, r.respostas.length)); r._editado = true;
    atualizarPainelResultado();
    el.parentElement.className = "rq " + classeResp(el.value, gabDe(av, r.versao)[+el.dataset.q]);
  } else if (m === "ver-painel") {
    const { r, av } = painelAtual;
    r.versao = el.value; r._editado = true;
    atualizarPainelResultado();
    $("#resGrade").innerHTML = gradeRespostas(av, r).replaceAll('data-muda="resp"', 'data-muda="resp-painel"');
  } else if (m === "vincular") {
    const r = { ...S.resultados[el.dataset.res] };
    const t = S.turmas[r.turmaId], a = el.value && t && t.alunos.find((x) => x.id === el.value);
    if (!a) return;
    const novo = { ...r, id: `${r.avaliacaoId}__${r.turmaId}__${a.id}`, alunoId: a.id, nome: a.nome, ra: a.ra, num: a.num, tipo: "neutra-vinculada" };
    delete novo.seq;
    Nuvem.put("resultados", novo.id, novo).then(() => Nuvem.del("resultados", r.id));
    const l = ui.leituras.find((x) => x.resId === r.id); if (l) { l.resId = novo.id; l.res = novo; }
    toast(`Leitura vinculada a ${a.nome}.`);
  }
});
document.addEventListener("input", (e) => {
  if (e.target.dataset.muda !== "gab-texto") return;
  const p = painelAtual;
  const v = e.target.value.toUpperCase().replace(/[^A-EXVF.\-_?]/g, "").split("");
  let k = 0;
  p.secs.forEach((x, si) => {
    const L = letrasTipo(x.tipo), a = p.gabs[p.ver][si];
    for (let i = 0; i < x.n; i++, k++) {
      let c = v[k];
      if (x.tipo === "C") c = c === "V" ? "C" : c === "F" ? "E" : c;
      a[i] = c && (c === "X" || L.includes(c)) ? c : "-";
    }
  });
  desenharGabarito(true);
});

$("#arqAtas").addEventListener("change", (e) => { const fs = [...e.target.files]; e.target.value = ""; if (fs.length) importarArquivos(fs); });
$("#arqFotos").addEventListener("change", (e) => { const fs = [...e.target.files]; e.target.value = ""; if (fs.length) processarArquivos(fs); });
$("#arqGaleria").addEventListener("change", (e) => { const fs = [...e.target.files]; e.target.value = ""; if (fs.length) processarArquivos(fs); });
$("#arqLogo").addEventListener("change", (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  const im = new Image(), url = URL.createObjectURL(f);
  im.onload = () => {
    const k = Math.min(1, 600 / im.width, 240 / im.height);
    const cv = document.createElement("canvas");
    cv.width = Math.round(im.width * k); cv.height = Math.round(im.height * k);
    const ctx = cv.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(im, 0, 0, cv.width, cv.height);
    URL.revokeObjectURL(url);
    Nuvem.salvarPerfil({ logo: cv.toDataURL("image/jpeg", 0.9) });
    toast("Logo salva.");
  };
  im.src = url;
});
window.addEventListener("hashchange", () => { const h = location.hash.slice(1); if (ABAS.some(([id]) => id === h) && h !== ui.aba) { ui.aba = h; render(); } });

{ const h = location.hash.slice(1); if (ABAS.some(([id]) => id === h)) ui.aba = h; }
render();
Nuvem.iniciar();
