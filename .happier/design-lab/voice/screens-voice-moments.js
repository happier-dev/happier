// Voice moments lab (2026-10-02, lane C `voice-moments`). One concept: five moments where voice earns its place —
//   Try voice (first run) · Brief me · Hold to talk · Continue on this device · Needs you, read aloud.
// Product truth: VoiceComposerPlanet(+Mount) tap-only; registry/readiness.ts (ready|needs_setup|unavailable|installing|
// incompatible, recovery actions); en.ts voice + status strings; voiceHooks.onAgentRequest (permission read-aloud);
// voiceAgentPrompt.ts (spoken yes never decides); actionSpecs voice tools; AccountSessionReadState (read cursor);
// sessionRecap.ts (synopsis/headline, "no summarizer"); voiceConversationSession.ts (history on the server, voice_home |
// session_root); phone-nav round 2c (bar gesture map). Decision record: lanes/2026-10-02/lab-voice-moments.md.
// Lab-only HTML. IIFE; namespace vm-* (voice-moments.css). Reuses window.WS (workspace shell, top rail tabs + theme),
// window.SS (session shell, phone session, cockpit bar), window.HI (composer, Home index). Every desktop frame has a 390 twin.
(() => {
const { wsApp, G, D, hd } = window.WS;
const { actionRail, phoneSession } = window.SS;
const { composer, indexPage } = window.HI;

Object.assign(P, {
  vmPause: '<path d="M8 5.5v13M16 5.5v13"/>',
  vmSkip: '<path d="M6 6v12l9-6-9-6ZM18 6v12"/>',
  vmSpeaker: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4v-5Z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
  vmHand: '<path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11M12 10V4.5a1.5 1.5 0 0 1 3 0V11M15 10.5V6.5a1.5 1.5 0 0 1 3 0v7.5a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.6-2.2L3.6 15.9a1.6 1.6 0 0 1 2.4-2.1L9 16.5V7.5a1.5 1.5 0 0 0-3 0"/>',
  vmSwap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  vmSend: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  vmEar: '<path d="M7 9a5 5 0 0 1 10 0c0 3-3 3.5-3 6.5a2.5 2.5 0 0 1-5 0"/><path d="M10 9.5a2 2 0 0 1 4 0"/>',
  vmBolt: '<path d="M13 3 5 13h6l-1 8 8-10h-6l1-8Z"/>',
  vmTile: '<rect x="4" y="4" width="16" height="16" rx="4"/><rect x="9" y="7.5" width="6" height="7" rx="3"/><path d="M12 16.5v1"/>',
  vmBtnSide: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M5 8v3"/>',
});

/* ═══ the planet: the ONE voice planet = the Daybreak dot planet (window.VP over ../daybreak engine + scenes; lane A).
   VP states bind the Daybreak grammar: ready (Light, still) · listening / hearing / speaking (Atmosphere = the real level)
   · connecting / eclipse / shade (Shadow) · dawn. This page adds no renderer and no palette. ═══ */
function planet(s = 20, o = {}) { return window.VP.planet(s, { st: o.meter ? 'hearing' : o.st, label: o.label }); }
/* The moments' own bindings, as small scenes over the shared engine (D.animate + D.drawPlanet, one clock):
   vmTry    Light = readiness steps really done (0, 1/3, 2/3, 1), plus Atmosphere while you are heard / it speaks;
            data-gather="1": the first successful turn — dots gather into the planet once (Signature, 1.2 s).
   vmLeave  Dots leaving = this device let the conversation go (Event, 1.2 s), settles dim and still.
   vmGather Dots gathering = the conversation arrived here (Event, 1.2 s), settles full and still. */
const vmLevel = (st, t) => { const ph = Math.sin(t * 0.9) > -0.3 ? 1 : 0.08; return st === 'speaking' ? ph * (0.45 + 0.55 * Math.abs(Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1))) : st === 'hearing' ? ph * 0.75 * Math.abs(Math.sin(t * 9.1) * Math.sin(t * 2.3 + 0.4)) : 0; };
function ensureScenes() {
  const D = window.DB; if (!D || !D.SC || D.SC.vmTry) return;
  const { clamp, mix, easeOut, easeInOut, lightForProgress } = D;
  const TINT = { hearing: [169, 140, 245, 0.14], speaking: [255, 177, 74, 0.10] };
  D.SC.vmTry = (el, o) => {
    const p = Number(el.dataset.progress || 0), v = el.dataset.voice || '', g = el.dataset.gather === '1';
    let env = 0;
    const frame = (t) => {
      env = env * 0.72 + vmLevel(v, t) * 0.28;
      const k = g ? easeOut(clamp(t / 1.2)) : 1;
      D.drawPlanet(el, { ...o, light: lightForProgress(p), reveal: 1, scatter: g ? (1 - k) * 0.9 : 0, pulse: env * 1.1 + (g ? Math.sin(k * Math.PI) * 0.3 : 0), halo: 0.8 + env * 0.7, tint: TINT[v] });
      if (!v && t > 1.3) return false;
    };
    if (!v && !g) { frame(2); return null; } // nothing to show: one frame, zero scheduled frames
    return D.animate(el, frame, { fps: 30, settle: 1.2 });
  };
  D.SC.vmLeave = (el, o) => D.animate(el, (t) => { const k = easeInOut(clamp(t / 1.2)); D.drawPlanet(el, { ...o, reveal: mix(1, 0.4, k), halo: mix(1, 0.35, k), scatter: k * 0.7 }); if (k >= 1) return false; }, { fps: 60, settle: 1.2 });
  D.SC.vmGather = (el, o) => D.animate(el, (t) => { const k = easeOut(clamp(t / 1.2)); D.drawPlanet(el, { ...o, reveal: 1, scatter: (1 - k) * 0.9, pulse: Math.sin(k * Math.PI) * 0.3 }); if (k >= 1) return false; }, { fps: 60, settle: 1.2 });
}
function dp(scene, s, o = {}, attrs = '') {
  ensureScenes();
  const pitch = Math.max(1.3, Math.min(3.2, s / 13)); // the same size→pitch rule VP uses
  return `<span class="vp" style="width:${s}px;height:${s}px" aria-hidden="true"><canvas class="db-cv" data-db="${scene}" data-o='${JSON.stringify({ radius: 0.625, pitch, spin: 0.9, ...o })}' ${attrs}></canvas></span>`;
}
const cell = (k, sz = '') => window.VP.cell(k, sz);
const NEW = (t = 'new') => `<span class="vm-new" title="Needs new data, UI or capability">${t}</span>`;
const sep = '<span class="vm-sep">·</span>';
const b = (t) => `<b style="color:var(--text);font-weight:560">${t}</b>`;
const btn = (label, v = 'sec', icon = '', cls = '') => `<button class="vm-btn vm-${v.split(' ').join(' vm-')} ${cls}">${icon ? ic(icon) : ''}${label}</button>`;
const kbd = (k) => `<span class="vm-kbd">${k}</span>`;
const lvl = (n, on) => `<span class="vm-lvl" aria-hidden="true">${Array.from({ length: n }, (_, i) => `<i class="${i < on ? '' : 'o'}" style="height:${[5, 9, 13, 16, 11, 7, 12, 15, 9, 6, 10, 14][i % 12]}px"></i>`).join('')}</span>`;
const okTool = (t, n) => `<div class="hi-tool">${ic('hiCheckC', 'ok')}${t} <span style="color:var(--text3)">· ${n}</span></div>`;
const vmark = (who = 'Spoken', where = '') => `<div class="vm-vm">${planet(12)}${who}${where ? ` · ${where}` : ''}</div>`;
const uSaid = (t, where) => `<div class="hi-ub">${vmark('Spoken', where)}${t}</div>`;
const vSaid = (t, where) => `<div>${vmark('Voice', where)}${t}</div>`;

/* ═══ desktop shell: the R1 cluster + workspace tabs (theme switcher in the cluster), rail, column, pane ═══ */
D.home = { k: 'builtin', t: 'Home', mk: () => ic('house'), line: '' };
D.pg = { k: 'session', t: 'Upgrade postgres to 17', mk: () => BRAND.claude(14), st: 'work', line: 'Working', where: 'infra · devbox', machine: 'devbox' };
const TABS = [['fix', { active: true }], ['rev'], ['relay'], ['docs', { prev: true }]];
function desk(state, o = {}) {
  const tabs = o.tabs || TABS;
  return wsApp(state, { root: { g: G(tabs, o.view, { focused: true }) }, stripOver: o.pill || '', over: o.over || '', active: o.rail, col: o.col, colHtml: o.colHtml });
}
// the composer as specified: dictation in the field's top-right corner, the planet left of Send (spec §2.3)
function pComp(o = {}) {
  let c = composer({ ph: o.ph || 'Message this session…', compact: true, text: o.text, machine: o.machine });
  c = c.replace(/<button class="hi-ib" aria-label="Dictate">[\s\S]*?<\/button>/, `<button class="vm-pbtn ${o.hold ? 'hold' : ''}" aria-label="${o.planetLabel || 'Start Voice'}">${planet(30, { st: o.pst || 'mic', meter: o.pmeter })}</button>`);
  c = c.replace('<div class="bar">', `${o.fmic === false ? '' : `<button class="vm-fmic" aria-label="Dictate">${ic('mic')}</button>`}<div class="bar">`);
  if (o.hud) c = c.replace(/<div class="tx[^"]*">[\s\S]*?<\/div>/, `<div class="vm-hud">${o.hud}</div>`).replace('class="hi-comp', 'class="hi-comp vm-holding');
  if (o.text) c = c.replace('<span class="hi-caret"></span>', '');
  return `<div class="vm-comp">${c}</div>`;
}
const companion = (items) => `<aside class="wt-comp cn-comp" aria-label="Companion"><div class="wt-comph"><b>Companion</b><span class="grow"></span><button class="hi-ib wt-ib" aria-label="Companion options" aria-haspopup="menu">${ic('more')}</button></div><div class="cn-col">${items.join('')}</div></aside>`;
function sView(o = {}) {
  const d = o.d || D.fix;
  const tx = `<div class="ss-tx"><div class="col">${o.tx || ''}</div></div>`;
  const mid = o.comp2 ? `<div class="wt-mrow">${tx}${o.comp2}</div>` : tx;
  return `<div class="ss"><div class="ss-main hi-sm">${hd(d)}${mid}${pComp(o.c || {})}</div>${actionRail(o.active, { git: 4 })}</div>`;
}
// the live pill in the top rail (lane A `voice-presence` owns its design; drawn here only to put the moments in context)
// the live pill: lane A's anatomy and CSS (voice-presence.css .vo-pill / .vo-ppill), consumed with this page's labels
const pill = (o = {}) => `<div class="vo-pill ${o.need ? 't-need' : ''}" style="right:${o.right || 56}px" role="group" aria-label="Voice, ${o.st || 'Listening'}"><button class="main">${o.pl || planet(20, { st: o.pst || 'listening' })}<span class="l">${o.st || 'Listening'}</span>${o.need ? cell('attn') : ''}${o.wh ? `<span class="tm">${o.wh}</span>` : ''}</button>${o.end === false ? '' : `<span class="dv"></span><button class="ib" aria-label="Mute">${ic('vpMic')}</button><button class="ib end" aria-label="End Voice">${ic('vpEnd')}</button>`}</div>`;
// the Voice glance in the Companion (lane A owns it; F1 Plain section)
const glance = (o = {}) => `<section class="vm-gl" aria-label="Voice"><div class="vm-glh">${planet(18, { st: o.pst || 'listening' })}<b>Voice</b><span class="m ${o.need ? '' : ''}" style="${o.need ? 'color:var(--vm-need);font-weight:600' : ''}">${o.st || 'Listening'}</span><span class="m vm-num">${o.tm || '2:14'}</span><span class="grow"></span><button class="hi-ib wt-ib" aria-label="Mute">${ic('mic')}</button><button class="hi-ib wt-ib" aria-label="End Voice" style="color:var(--danger)">${ic('vpEnd')}</button></div>${o.body || ''}</section>`;

/* ═══ phone shell: the session as it ships (header, transcript, composer above the cockpit bar) ═══ */
function pComposerAbs(o = {}) { return `<div class="vm-pcomp" style="${o.style || ''}">${pComp({ ph: o.ph || 'Message Claude…', ...o })}</div>`; }
function phone(o = {}) {
  const body = `<div class="ss-tx" style="padding-top:12px"><div class="col" style="padding:0 20px;font-size:15px;line-height:22px">${o.tx || ''}</div></div>${o.comp === false ? '' : pComposerAbs(o.c || {})}`;
  return phoneSession({ title: o.title, body: o.body || body, on: o.on || 'chat', over: o.over || '', machine: o.machine });
}
const ppill = (o = {}) => `<div class="vo-ppill ${o.need ? 't-need' : ''}" style="bottom:${o.bottom || 178}px" role="group" aria-label="Voice, ${o.st || 'Listening'}"><button class="main">${o.pl || planet(24, { st: o.pst || 'listening' })}<span class="l">${o.st || 'Listening'}</span>${o.need ? cell('attn', 'lg') : ''}${o.wh ? `<span class="tm">${o.wh}</span>` : ''}</button>${o.end === false ? '' : `<button class="ib" aria-label="Mute">${ic('vpMic')}</button><button class="ib end" aria-label="End Voice">${ic('vpEnd')}</button>`}</div>`;
const sheet = (inner) => `<div class="vm-pscrim"></div><div class="vm-psheet" role="dialog"><div class="grab"></div>${inner}</div>`;
const mini = (html, z = 0.62, cls = '') => `<div class="phone vm-minip ${cls}" style="zoom:${z}"><div class="status"><span>9:41</span><span>●●● ▮</span></div><div class="scroll">${html}</div></div>`;

/* ═══════════════════════ 1 · TRY VOICE (first run) ═══════════════════════ */
// The planet is the entry: a recoverable "needs setup" planet stays present (spec §2.5) and its first tap unfolds this card
// from the planet itself. Three steps, each skipped when already true (readiness.ts decides; nothing is asked twice).
// provider marks: lane B's (voice-settings) MK when it is exported, so the lab has one set of marks
const PMK = (k, sz = 18) => (window.VS && window.VS.MK && window.VS.MK[k]) ? window.VS.MK[k](sz) : BRAND.mono(k[0].toUpperCase(), 'transparent', 'var(--text)', sz);
const PROV = [
  { mk: () => PMK('eleven'), t: 'ElevenLabs', s: 'Through Happier, or your own ElevenLabs account', rd: '<span class="vm-dot need"></span>Needs Happier Pro or a key' },
  { mk: () => PMK('openai'), t: 'OpenAI Realtime', s: 'Your OpenAI account · connected', rd: '<span class="vm-dot ok"></span>Ready', on: true },
  { mk: () => PMK('xai'), t: 'Grok Voice', s: 'Your xAI key', rd: 'Add a key' },
  { mk: () => PMK('local'), t: 'Local voice', s: 'Runs on a machine you choose', rd: 'Choose a machine', dim: true },
];
const provList = (n = 4) => `<div class="vm-prov" role="radiogroup" aria-label="Who listens">${PROV.slice(0, n).map((p) => `<div class="vm-po ${p.on ? 'on' : ''} ${p.dim ? 'dim' : ''}" role="radio" aria-checked="${!!p.on}"><span class="mk">${p.mk()}</span><div><div class="t">${p.t}</div><div class="s">${p.s}</div></div><span class="rd">${p.rd}</span></div>`).join('')}</div>`;
const step = (n, cls, t, s, r = '', body = '') => `<div class="vm-step ${cls}"><span class="n">${cls === 'ok' ? ic('check') : cls === 'bad' ? '!' : n}</span><div><div class="t">${t}</div>${s ? `<div class="s">${s}</div>` : ''}</div>${r ? `<span class="r">${r}</span>` : '<span></span>'}${body ? `<div class="body">${body}</div>` : ''}</div>`;
const phrase = (o = {}) => `<div class="vm-phrase"><div style="font-size:12px;color:var(--text2);margin-bottom:4px">${o.lead || 'Say it out loud'}</div><div class="q"><span class="hh">${o.heard ?? 'What are my'}</span> <span class="rr">${o.rest ?? 'sessions doing?'}</span></div><div class="mt2">${ic('mic')}<span>${o.mic || 'MacBook Pro Microphone'}</span><span class="grow" style="flex:1"></span><span>${o.state || 'Hearing you'}</span></div></div>`;
function tryHero(o, beat) {
  const p = o.reply ? 1 : [0, 0, 0.34, 0.67][beat];
  return dp('vmTry', 44, {}, `data-progress="${p}" data-voice="${o.reply ? 'speaking' : beat === 3 ? 'hearing' : ''}" data-gather="${o.reply ? 1 : 0}"`);
}
function tryCard(o = {}) {
  const beat = o.beat || 3;
  const s1 = beat > 1 ? step(1, 'ok', 'OpenAI Realtime', 'Your OpenAI account · connected', `<a style="color:var(--text2)">Change</a>`) : step(1, 'now', 'Choose who listens', 'Pick what hears you and speaks back. You can change it any time.', '', provList());
  const s2 = beat > 2 ? step(2, 'ok', 'Microphone', o.micOk || 'Allowed on this Mac') : beat === 2 ? step(2, 'now', 'Allow the microphone', 'macOS asks once. Happier only listens while Voice is on, and you can always see when it is.', '', `<div style="display:flex;gap:8px">${btn('Allow microphone', 'pri', 'mic')}</div>`) : step(2, 'later', 'Microphone', '');
  const s3 = beat === 3 ? step(3, 'now', 'Say hello', '', '', `${phrase(o.ph || {})}${o.reply ? `<div class="vm-reply"><div><div class="vm-vm" style="margin-bottom:2px">Voice</div>${o.reply}</div></div>` : ''}`) : step(3, 'later', 'Say hello', '');
  const ft = beat === 3
    ? `<div class="ft"><span class="q">${o.foot || 'This is already your conversation with this session.'}</span><span class="grow"></span>${btn('Done', 'sec')}</div>`
    : `<div class="ft"><span class="q">Nothing is sent until you speak.</span><span class="grow"></span>${btn('Not now', 'ter')}${beat === 1 ? btn('Continue', 'pri') : ''}</div>`;
  return `<div class="vm-try ${o.cls || ''}" role="dialog" aria-label="Try voice" style="${o.style || ''}"><div class="top">${tryHero(o, beat)}<div><h2>${o.h || 'Talk to your sessions'}</h2><div class="p">${o.p || 'Ask what’s happening, start work, or think out loud. Your words show up in the chat like any message.'}</div></div></div><div class="vm-steps">${s1}${s2}${s3}</div>${ft}</div>`;
}
const TX_FIX = () => `<div class="hi-ub">The settings modal flickers when the window resizes. Find out why and fix it.</div>
  <div>It remounts because <code class="vm-code">SettingsModal</code>’s key includes the window width, so every resize throws its state away. I’ll key it by route instead and add a test.</div>
  ${okTool(`Edited ${b('SettingsModal.tsx')}`, '+4 −2')}${okTool(`Ran ${b('yarn test settings')}`, '24 passed')}
  <div>Fixed. The modal keeps its scroll position and draft while the window resizes.</div>`;
const T1 = (s) => desk(s, { view: sView({ tx: TX_FIX(), c: { pst: 'ready', planetLabel: 'Voice, open above' } }), over: tryCard({ beat: 3, style: 'right:284px;bottom:150px', ph: { heard: 'What are my sessions', rest: 'doing?', lvl: 9 }, reply: `<span class="vm-mut">Heard you.</span> Two are working: ${b('Upgrade postgres to 17')} on devbox is migrating fixtures, and ${b('Relay retry')} is running its soak test. One needs you — ${b('Review #2481')} wants to run <code class="vm-code">yarn test:e2e</code>.` }) });
const T1p = () => phone({ tx: TX_FIX(), c: { pst: 'ready' }, over: sheet(tryCard({ beat: 3, cls: 'inpage', ph: { heard: 'What are my', rest: 'sessions doing?', lvl: 7, mic: 'iPhone Microphone' }, micOk: 'Allowed on this iPhone', reply: `<span class="vm-mut">Heard you.</span> Two are working and one needs you — ${b('Review #2481')} on Studio.` })) });

// beat board
function TB(s) {
  const card = (k, h, p, inner) => `<div class="vm-card"><div class="k">${k}</div><h3>${h}</h3><p>${p}</p><div class="stage" style="margin:14px -4px -4px;padding:14px;display:grid;place-items:center">${inner}</div></div>`;
  const small = (o) => `<div style="zoom:.6">${tryCard({ ...o, style: 'position:relative' })}</div>`;
  const done = `<div style="zoom:.62;width:440px">${pComp({ pst: 'listening' })}</div><div style="margin-top:10px;width:100%">${pill({}).replace('class="vo-pill', 'class="vo-pill inl').replace(/style="right:\d+px"/, '')}</div>`;
  return `<div class="vm-board"><h1>Try voice, beat by beat</h1><p class="lede">One card, unfolded from the planet the first time it is tapped. Its planet speaks the Daybreak grammar: <b>Light</b> advances only when a readiness step really finishes (0 → ⅓ → ⅔ → full), <b>Atmosphere</b> follows your real voice while you say the phrase, and the <b>dots gather</b> once when the first reply arrives. Every step is skipped when it is already true. The test phrase is the first real conversation, in the chat you were in.</p>
  <div class="vm-grid c4">${card('Beat 1 · only when no provider is ready', 'Choose who listens', 'Providers with readiness from <code>readiness.ts</code>. The ready one is preselected; the others say exactly what they need.', small({ beat: 1 }))}${card('Beat 2 · only before the first grant', 'Ask before the system asks', 'A one-line reason, then the OS prompt. Today the prompt fires cold on the first <code>getUserMedia</code>. ' + NEW(), small({ beat: 2 }))}${card('Beat 3 · the signature', 'Say hello', 'The phrase lights up word by word as it is heard; the planet’s atmosphere follows your real voice (no meter, no rings). The reply is spoken and lands in the chat.', small({ beat: 3, ph: { heard: 'What are my sessions', rest: 'doing?' } }))}${card('After · Signature, once', 'The first reply: dots gather', 'When the first answer starts, the light reaches 3 of 3 and the dots gather into the planet once (1.2 s). Done folds the card back into the composer planet; the live pill takes over in the top rail.', `<div style="display:flex;gap:14px;justify-content:center;width:100%;margin-bottom:12px">${[0.85, 0.45, 0].map((sc) => `<span class="vp" style="width:64px;height:64px"><canvas class="db-cv" data-db="still" data-o='${JSON.stringify({ radius: 0.625, pitch: 2.4, spin: 0.9, scatter: sc })}'></canvas></span>`).join('')}</div>${done}`)}</div>
  <h2>Motion</h2><p class="lede" style="margin:0">Light: each finished step moves the terminator (0.9 s ease, the shared <code>SC.daybreak</code> rule); nothing advances on a timer. Open: the card grows out of the planet (scale .92 → 1 from the planet’s centre, 240 ms, ease-out, no overshoot). Step change: the finished step collapses to its one-line summary while the next one expands (200 ms). Heard words fill from 32% to full ink as the transcript streams. Done: the card shrinks back into the planet along the same path. Reduced motion: cross-fades only; the phrase fills in without the sweep.</p></div>`;
}
const TBp = () => phone({ tx: TX_FIX(), over: sheet(tryCard({ beat: 1, cls: 'inpage' })) });

// states
function TS() {
  const st = (k, h, inner, why, vis = '') => `<div class="vm-card"><div class="k">${k}</div><h3>${vis}${h}</h3>${inner}<p style="margin-top:10px">${why}</p></div>`;
  const shell = (inner) => `<div class="vm-try" style="position:relative;width:auto;box-shadow:none;padding:0;background:transparent">${inner}</div>`;
  return `<div class="vm-board"><h1>Try voice · when it can’t work yet</h1><p class="lede">Each state names the cause and offers the one next action. The card never shows a step that cannot succeed; the reasons are the shipped readiness codes in plain words.</p><div class="vm-grid c3">
  ${st('mic_permission_denied', 'The microphone is off', shell(`${step(2, 'bad', 'The microphone is off for Happier', 'Turn it on in your system settings, then come back here.', '', `<div style="display:flex;gap:8px">${btn('Open settings', 'pri')}${btn('Check again', 'sec')}</div>`)}`), 'Shipped setup copy (<code>setupMicrophoneDenied*</code>, Open settings, Check again): the person checks again when they come back; no automatic retry is promised. Planet: Shadow — waiting on a setting outside Happier.', planet(28, { st: 'shade' }))}
  ${st('needs_setup · credential', 'No provider is ready', shell(`${step(1, 'bad', 'Choose who listens', 'ElevenLabs through Happier needs Happier Pro. OpenAI Realtime can use your OpenAI account.', '', `<div style="display:flex;gap:8px">${btn('Connect OpenAI', 'pri')}${btn('See Happier Pro', 'sec')}</div>`)}`), 'Recovery actions <code>configure_credential</code> / <code>switch_provider</code>. Connecting happens in Connected services and returns here. Planet: Light at 0 — nothing is ready yet.', dp('daybreak', 28, {}, 'data-progress="0"'))}
  ${st('microphone missing', 'No microphone found', shell(`${step(2, 'bad', 'No microphone found', 'Connect a microphone or headset, then check again.', '', `<div style="display:flex;gap:8px">${btn('Check again', 'pri')}</div>`)}`), 'A real readiness fact (<code>setupMicrophoneMissing*</code>). The card has no silence deadline: the existing capture and provider lifecycle decides when no input becomes an end or an error (PLAN §4.6 Try). No input-device name or microphone switcher is shown, because no owner supplies one. Planet: Shadow, still.', planet(28, { st: 'shade' }))}
  ${st('error · Connection Error', 'Couldn’t connect', shell(`${step(3, 'bad', 'OpenAI didn’t answer', 'The connection closed before the first reply. Nothing was sent to your session.', '', `<div style="display:flex;gap:8px">${btn('Try again', 'pri', 'refresh')}${btn('Use ElevenLabs', 'ter')}</div>`)}`), 'Retry keeps the session target (audit finding 2 says retry falls back to Global today; fix in the owner). Planet: partial shade, rose — a failure, not progress.', planet(28, { st: 'shade' }))}
  ${st('needs_setup · execution_machine / endpoint', 'Local voice isn’t set up', shell(`${step(1, 'bad', 'Local voice needs a machine', 'Pick where speech runs. devbox has a speech model; MacBook Pro would download one (1.4 GB).', '', `<div style="display:flex;gap:8px">${btn('Use devbox', 'pri')}${btn('Other machines', 'ter')}</div>`)}`), 'Audit C-06: choosing Local voice today leaves empty endpoints. The card only offers it with the prerequisite in words. Planet: Light stays at step 1.', dp('daybreak', 28, {}, 'data-progress="0"'))}
  ${st('installing', 'Getting ready', shell(`${step(1, 'now', 'Downloading the speech model on devbox', '0.9 of 1.4 GB · about 1 min', '', `<div class="vm-prog" style="margin-top:4px"><i class="dn"></i><i class="dn"></i><i class="dn"></i><i class="nw"></i><i></i></div>`)}`), 'Readiness <code>installing</code>. The card stays open and continues to step 2 by itself; closing it keeps the download going. Planet: Light advances per finished install step; the terminator shimmers while working.', dp('daybreak', 28, {}, 'data-progress="0.2" data-state="working"'))}
  </div></div>`;
}
const TSp = () => phone({ tx: TX_FIX(), over: sheet(`<div class="vm-try inpage"><div class="top">${planet(44, { st: 'shade' })}<div><h2>Talk to your sessions</h2><div class="p">Ask what’s happening, start work, or think out loud.</div></div></div><div class="vm-steps">${step(1, 'ok', 'OpenAI Realtime', 'Your OpenAI account · connected')}${step(2, 'bad', 'Microphone is off for Happier', 'Settings › Happier › Microphone. Voice picks up when you come back.', '', `<div style="display:flex;gap:8px">${btn('Open Settings', 'pri lg')}</div>`)}${step(3, 'later', 'Say hello', '')}</div><div class="ft" style="margin-top:14px;display:flex"><span class="grow" style="flex:1"></span>${btn('Use text instead', 'ter')}</div></div>`) });

// TX (T2 sheet / T3 settings-first alternatives) deleted 2026-11-07 (VOICE-LAB-CLEANUP-1107, NIP): T1 was chosen;
// its rationale lives in T1's notes.

/* ═══════════════════════ 2 · BRIEF ME ═══════════════════════ */
// Facts only from what exists: the per-account read cursor (AccountSessionReadState.lastViewedSessionSeq / unreadSince),
// Inbox attention (Needs you / Failed), awareness status (presentSessionAwarenessV1) and the Recap headline
// (session_synopsis.v1 or the latest worker update). Where no Recap exists the row says the status only.
const BRIEF = [
  { g: 'Needs you', k: 'need', mk: () => BRAND.claude(15), t: 'Review #2481', w: 'Studio', s: 'Wants to run <code class="vm-code">yarn test:e2e</code>.', a: true },
  { g: 'Failed', k: 'fail', mk: () => ic('wsFlow'), t: 'Nightly release · run 214', w: '07:12', s: 'Failed at Publish: npm can’t publish over 0.3.0-preview.14.', a2: 'Open run' },
  { g: 'Ready', k: 'ok', mk: () => BRAND.codex(15), t: 'Relay retry with backoff', w: 'devbox', s: 'Backoff with jitter, 18 tests pass. Opened #2493 for review.' },
  { g: 'Ready', k: 'ok', mk: () => BRAND.claude(15), t: 'Fix settings modal remount', w: 'MacBook Pro', s: 'Keyed by route; 24 tests pass.' },
  { g: 'Still working', k: 'work', mk: () => BRAND.claude(15), t: 'Upgrade postgres to 17', w: 'devbox', s: 'Step 3 of 5 · migrating fixtures.' },
];
// The request card: the session's own permission card, shared with Presence (window.VPR.reqCard), so the lab has one card.
const req = (o = {}) => (window.VPR ? window.VPR.reqCard(o) : '');
// One sheet in one rhythm: sentence-case group headings Needs you → Failed → Ready (presentation order, not a classifier),
// each row one known item with a status dot in Home's tones and its exact destination; a needs-you row carries the
// session's real request card beneath it. No “Still working” group, no row being read, no progress (VoiceBrief.tsx).
function briefList(o = {}) {
  let last = '';
  return BRIEF.filter((r) => r.k !== 'work').map((r) => {
    const head = r.g !== last ? `<div class="vm-bgrp">${r.g}</div>` : ''; last = r.g;
    const card = r.a ? `<div class="vm-bcard">${req({ note: o.note, lg: o.ph })}</div>` : '';
    return `${head}<div class="vm-bi ${r.k === 'need' ? 'need' : ''}" role="link"><span class="g"><span class="vm-dot ${r.k}"></span></span><div><div class="t">${r.t}<span class="w">${r.w}</span></div><div class="s">${r.s}</div></div><span class="vm-chev">${ic('chevR')}</span></div>${card}`;
  }).join('');
}
// The head row: why it is silent and its one action (only when it cannot read aloud), Stop while a reply can be stopped
// (cancels the reply, never ends the call or approves anything), close. Pause / Next appear only where a provider admits
// the control; none of today's services do, so none are drawn.
const briefHead = (o = {}) => `<div class="vm-bhead">${o.silent ? `<span class="n">Voice can’t read this aloud right now.</span>${btn('Retry', 'sec')}` : '<span class="grow"></span>'}${o.stop === false ? '' : btn('Stop', 'sec')}<button class="hi-ib" aria-label="Close">${ic('x')}</button></div>`;
function briefBlock(o = {}) {
  return `<section class="vm-brief ${o.ph ? 'ph' : ''}" aria-label="Brief">${briefHead(o)}${o.incomplete ? '<div class="vm-bnote">Some work hasn’t loaded yet, so this may not be everything.</div>' : ''}<div class="vm-bl vm-bsheet">${briefList(o)}</div></section>`;
}
function homeView(o = {}) {
  const sub = o.sub || `<span>Since you were last here at 09:12</span><span><span class="dot" style="background:var(--orange)"></span>1 needs you</span><span>1 failed</span><span>2 ready</span>`;
  const head = `<div class="hi-head"><div class="t"><h1>Welcome back, Leeroy</h1><div class="hi-sub">${sub}</div></div>${o.brief ? '' : `<button class="vm-btn vm-sec vm-lg" aria-label="Brief me: Voice reads what happened since 09:12">${planet(20)}Brief me</button>`}</div>`;
  const page = indexPage({ blocks: [head, o.brief ? `<div style="margin-top:22px">${o.brief}</div>` : composer({}), ...(o.rest || [])], attention: false });
  return `<div style="flex:1;min-width:0;overflow:hidden">${page}</div>`;
}
// The call's own status lives in the presence (an ordinary Speaking pill with its clock), not in the brief.
const B1 = (s) => desk(s, { tabs: [['home', { active: true }], ['fix'], ['rev'], ['relay']], view: homeView({ brief: briefBlock({}) }), pill: pill({ st: 'Speaking', wh: '0:12', pst: 'speaking' }) });
const B1p = () => `<div class="z-ph hi-ph"><div class="hdr"><span class="z-av">LB</span><span class="hm"><span class="dot ok" style="width:6px;height:6px"></span>Personal Home</span><span class="grow"></span></div><div class="hi-pb" style="padding:4px 12px 140px"><div style="padding:0 8px"><div style="font:660 26px/32px InterLab;letter-spacing:-.02em;margin-top:14px">Welcome back, Leeroy</div><div style="margin-top:6px;font-size:13.5px;color:var(--text2)">Since 09:12 ${sep} 1 needs you ${sep} 1 failed ${sep} 2 ready</div></div>${briefBlock({ ph: true })}</div>${ppill({ st: 'Speaking', wh: '0:12', bottom: 84, pst: 'speaking' })}<div class="tabbar">${['bubble', 'inbox', 'folder', 'gear'].map((i) => ic(i, i === 'bubble' ? 'on' : '')).join('')}</div></div>`;
const B0 = (s) => desk(s, { tabs: [['home', { active: true }], ['fix'], ['rev'], ['relay']], view: homeView({ rest: [] }) });
const B0p = () => `<div class="z-ph hi-ph"><div class="hdr"><span class="z-av">LB</span><span class="hm"><span class="dot ok" style="width:6px;height:6px"></span>Personal Home</span><span class="grow"></span></div><div class="hi-pb" style="padding:4px 20px 0"><div style="font:660 26px/32px InterLab;letter-spacing:-.02em;margin-top:14px">Welcome back, Leeroy</div><div class="hi-sub" style="margin-top:6px">Since 09:12 ${sep} 1 needs you ${sep} 1 failed ${sep} 2 ready</div><button class="vm-btn vm-sec vm-lg" style="margin-top:16px;width:100%;justify-content:center">${planet(20)}Brief me</button><div style="margin-top:16px">${composer({ compact: true })}</div></div><div class="tabbar">${['bubble', 'inbox', 'folder', 'gear'].map((i) => ic(i, i === 'bubble' ? 'on' : '')).join('')}</div></div>`;

function BX(s) {
  const card = (v, h, p, inner, hgt = 330) => `<div class="vm-card"><div class="stage" style="height:${hgt}px;padding:0">${inner}</div><h3>${h}<span class="vm-verdict ${v}">${v === 'rec' ? 'Recommended' : v === 'no' ? 'Not proposed' : 'Alternative'}</span></h3><p>${p}</p></div>`;
  const deskMini = (inner) => `<div style="zoom:.3;width:1440px;height:1100px;position:relative">${inner}</div>`;
  const ask = sView({ d: D.home, tx: `${uSaid('What happened while I was away?', 'MacBook Pro')}${vSaid('Since 9:12: <b>Review #2481</b> needs you — it wants to run <code class="vm-code">yarn test:e2e</code>. The nightly release failed at Publish. Relay retry and the settings fix are ready, and the postgres upgrade is still going.')}<div style="max-width:420px">${req({})}</div>` });
  const stateCard = (h, inner) => `<div class="vm-card"><h3>${h}</h3>${inner}</div>`;
  return `<div class="vm-board"><h1>Brief me · where it starts, and its states</h1><p class="lede">The brief is the same list everywhere: what changed since you last looked (your per-account read cursor), grouped Needs you → Failed → Ready → Still working, each row one fact from its session’s Recap or status. Voice reads it; the screen keeps it, so nothing depends on hearing it. Approvals in it are buttons.</p><div class="vm-grid c3">
  ${card('rec', 'B1 · “Brief me” on Home', 'The greeting already knows the present. One button turns that line into the brief, in place; the pill follows it while it reads. Also in the Inbox header and the command palette.', deskMini(B1(s)))}
  ${card('alt', 'B2 · Just ask', '“What happened while I was away?” in any conversation. Same facts, as voice turns; the needs-you item arrives as a card. Works today once the brief tool exists — B1 is the button for it.', deskMini(desk(s, { tabs: [['home', { active: true }], ['fix']], view: ask, pill: pill({ st: 'Speaking', pst: 'speaking' }) })))}
  ${card('no', 'B3 · Brief automatically on return', 'Voice starts talking when you open the app after a while. Sound you didn’t ask for, and it opens a mic session without intent. Not proposed.', `<div style="display:grid;place-items:center;height:100%;color:var(--text3);font-size:13px">${planet(56)}</div>`)}
  </div><h2>States</h2><div class="vm-grid c3">
  ${stateCard('Nothing new', `<div class="vm-say">${planet(16)}<div>Nothing changed since 09:12. <span class="w">Upgrade postgres to 17 is still working, step 3 of 5.</span></div></div><p style="margin-top:10px">One sentence, then Voice stays listening. The button reads “Brief me” only when there is something since your last look; otherwise “What’s running?”.</p>`)}
  ${stateCard('A session without a Recap', `<div class="vm-bi"><span class="g"><span style="color:var(--success)">${ic('check')}</span></span><div><div class="t">Docs search index<span class="w">MacBook Pro</span></div><div class="s">Ready · 14 new messages</div></div></div><p style="margin-top:6px">No summarizer exists (sessionRecap.ts). The row says status and how much is new — never invented prose. “Tell me more” makes Voice read the session’s last turn.</p>`)}
  ${stateCard('Offline or a machine away', `<div class="vm-bi"><span class="g"><span class="vm-dot"></span></span><div><div class="t">Rotate relay certs<span class="w">Studio · away since 08:40</span></div><div class="s">Last known: waiting for input.</div></div></div><p style="margin-top:6px">Last-known facts with “as of”. Voice says “Studio is away, so this may be out of date.”</p>`)}
  </div></div>`;
}

/* ═══════════════════════ 3 · HOLD TO TALK ═══════════════════════ */
const hudTxt = (heard, rest, k) => `<div class="ln"><span class="live">${heard}<em>${rest ? ` ${rest}` : ''}</em></span></div><span class="k">${k}</span>`;
function pttHud(o = {}) {
  return `<div class="vm-ptt ${o.cls || ''}" style="${o.style || ''}" role="status" aria-live="polite">${planet(28, { st: 'hearing' })}<div class="c"><div class="to">${o.to || `To ${b('Fix settings modal remount')}`}</div><div class="w">${o.w || 'and add the regression test to the CI matrix'}<em>${o.em || ''}</em></div></div><div class="k">${o.k || `Release to send<br>${kbd('esc')} cancels`}</div></div>`;
}
// Shipped: VoiceComposerPlanet onLongPress → beginHoldToTalk, only with Voice → Advanced → Hold to talk on and a service
// that admits it (canHoldToTalk); hint “Hold for one turn; release to send. Drag away to cancel.”
const H1 = (s) => desk(s, { view: sView({ tx: TX_FIX(), c: { hud: hudTxt('Also run it on Windows and add the regression test', 'to the CI matrix…', `Release to send ${sep} drag away to cancel`), pst: 'hearing', hold: true, fmic: false } }), over: `<div class="vm-gtag v" style="left:1040px;bottom:178px">Holding the Voice mark <span class="s">· 2.4 s</span></div>` });
// H2: no composer on screen. ⌥⌘V (voice.toggle, rebindable) is a toggle, not a hold: it starts Global Voice here and the
// same shortcut ends it; key repeat is ignored. Nothing is re-targeted later.
const H1b = (s) => desk(s, { tabs: [['prs', { active: true }], ['fix'], ['rev']], view: `<div style="flex:1;padding:40px 56px;overflow:hidden"><div style="font:660 24px/30px InterLab;letter-spacing:-.02em">PRs &amp; Issues</div><div style="color:var(--text2);margin-top:6px;font-size:13.5px">happier-dev/happier ${sep} 4 open ${sep} 2 need review</div>${['#2493 Retry relay handshake on 503', '#2481 Collection grid keeps selection on resize', '#2477 Docs: local voice providers', '#2470 Bump expo to 54'].map((t, i) => `<div style="display:flex;gap:12px;padding:14px 4px;border-bottom:1px solid var(--hair);font-size:14px">${ic('gitpr')}<span>${t}</span><span style="margin-left:auto;color:var(--text3)">${['2h', '5h', '1d', '2d'][i]}</span></div>`).join('')}</div>`, pill: pill({ st: 'Listening', wh: '0:02' }), over: `<div class="vm-gtag v" style="right:300px;top:46px">${kbd('⌥⌘V')} pressed <span class="s">· starts Global Voice</span></div>` });
// phone: hold the composer planet. The thumb covers it, so the composer itself becomes the readout above the thumb.
const H1p = () => phone({ tx: TX_FIX(), c: { hud: `<div class="ln"><span class="live">Also run it on Windows<em> and add…</em></span></div>`, pst: 'hearing', hold: true, fmic: false }, over: `<div class="vm-thumb" style="right:52px;bottom:107px"></div><div class="vm-ptt ph" role="status"><div class="c"><div class="to">To ${b('Fix settings modal remount')}</div><div class="w" style="font-size:13px;color:var(--text2)">Release to send ${sep} slide left to cancel</div></div></div>` });

function HG() {
  const gn = (n, x, y, v) => `<span class="vm-gn ${v ? 'v' : ''}" style="left:${x - 11}px;top:${y - 11}px">${n}</span>`;
  const map = `<div class="phone" style="zoom:.78;flex:none"><div class="status"><span>9:41</span><span>●●● ▮</span></div><div class="scroll">${phone({ tx: TX_FIX(), c: {} })}${gn(1, 300, 47)}${gn(2, 195, 745)}${gn(3, 334, 660, 1)}${gn(4, 362, 618)}</div></div>`;
  const row = (where, g, does, ours = false, n = '') => `<div class="vm-gr ${ours ? 'ours' : ''}"><b>${n ? `<span class="vm-gn ${ours ? 'v' : ''}" style="position:static;display:inline-grid;margin-right:7px">${n}</span>` : ''}${where}</b><span>${g}</span><span class="o">${does}</span></div>`;
  return `<div class="vm-board"><h1>Hold to talk, mapped against the phone’s gestures</h1><p class="lede">The bar already owns sideways, drag-up and hold (phone-nav round 2c: hold 320 ms and let go docks the switcher). A long-press there would fight the dock, so the optional hold-to-talk lives on the Voice mark, which sits in the composer above the bar. Only in-app gestures are offered.</p>
  <div style="display:flex;gap:40px;align-items:flex-start">${map}<div style="flex:1;min-width:0"><div class="vm-glist">
  <div class="vm-gr h"><span>Where</span><span>Gesture</span><span>Does</span></div>
  ${row('Cockpit bar', 'Tap a tool', 'Opens it', false, 2)}${row('Cockpit bar', 'Sideways (tools fit)', 'Directional session switcher, pre-selected', false, 2)}${row('Cockpit bar', 'Drag up / flick', 'Ghost switcher, lock at 120 pt / next, previous', false, 2)}${row('Cockpit bar', 'Hold 320 ms, let go', 'Docked switcher', false, 2)}${row('Session title', 'Pull down 64 pt', 'All tabs', false, 1)}
  ${row('Composer voice button', 'Tap', 'Start Voice; tap again to end (a toggle). At rest it is the line waveform; live, it becomes the planet', false, 3)}${row('Composer voice button', 'Hold (opt-in)', 'With Hold to talk on and a service that supports it: one turn while held; release sends, drag away cancels. Otherwise it says the service can’t, and tap still works', true, 3)}${row('Field mic', 'Tap', 'Dictate into the field (today)', false, 4)}${row('Live pill', 'Tap · Mute · End', 'Opens the Voice sheet (lane A) · Mute stops listening and stays connected · End finishes')}${row('Live pill', `Hold ${NEW()}`, 'Talk while held, when the conversation is muted', true)}

  </div><h2>Rejected</h2><div class="vm-glist">${row('Cockpit bar', 'Long-press Chat', '<span style="color:var(--danger)">Collides with hold-to-dock (same 320 ms hold on the same surface)</span>')}${row('Composer', 'Swipe up from the field', '<span style="color:var(--danger)">Reads as drag-up from the bar right below it</span>')}${row('Volume buttons', 'Hold', '<span style="color:var(--danger)">Not available to apps on iOS; changes volume on Android</span>')}${row('Outside the app', 'Action button, Shortcut, Quick Settings tile', 'Not offered: no App Intent, global OS hook or tile is promised (PLAN §4.4)')}</div>
  <h2>Desktop</h2><div class="vm-glist">${row('In the app', `${kbd('⌥⌘V')}`, 'Start or end Voice anywhere in the window (a toggle; key repeat ignored). Rebind in Settings → Keyboard: “Start or end Voice”', true)}${row('Composer voice button', 'Hold (opt-in)', 'The same one-turn hold as the phone, with the pointer')}${row('Outside the app', 'Global OS hotkey', 'Out of scope (spec §15: a separate program needing its own authorization)')}</div></div></div></div>`;
}
// HX (H-b dictate / H-c both-by-modifier alternatives) deleted 2026-11-07 (VOICE-LAB-CLEANUP-1107, NIP): H-a,
// holding talks to Voice, was chosen; its rationale lives in H1's notes.

/* ═══════════════════════ 4 · CONTINUE ON THIS DEVICE ═══════════════════════ */
// Product truth: a Voice conversation's history and provider conversation id live on the server (voiceConversationSession,
// scope voice_home | session_root). The live audio is device-local and the plan rejects cross-device foreground lookups
// and command queues (PLAN:455). So the offer comes from the shared transcript itself; nothing is pushed between devices.
const TX_HAND = (here) => `<div class="hi-ub">The settings modal flickers when the window resizes. Find out why and fix it.</div>
  <div>Fixed. The modal keeps its scroll position and draft while the window resizes.</div>
  ${uSaid('Can you also run it on Windows before I go?', 'MacBook Pro')}
  ${vSaid('Sure — I asked the session to run the settings tests on the Windows runner. I’ll tell you when they finish.', 'MacBook Pro')}
  ${here ? `${uSaid('How did Windows go?', 'iPhone')}${vSaid('All 24 passed on Windows. Nothing else is waiting for you here.', 'iPhone')}` : ''}`;
const handOffer = (o = {}) => `<div class="vm-hand" role="group" aria-label="Continue the voice conversation here">${planet(22)}<div class="c"><div class="t">${o.t || 'Continue talking here'}</div><div class="s">${o.s || 'You were talking on MacBook Pro · 1 min ago'}</div></div>${btn(o.b || 'Continue', 'pri')}<button class="hi-ib" aria-label="Dismiss">${ic('x')}</button></div>`;
const C1p = () => phone({ tx: TX_HAND(false), c: {}, over: `<div style="position:absolute;left:12px;right:12px;bottom:194px;z-index:6">${handOffer()}</div>` });
const C2p = () => phone({ tx: TX_HAND(true), c: { pst: 'ready' }, over: ppill({ st: 'Listening', wh: '0:42', pl: dp('vmGather', 24) }) });
const C1 = (s) => desk(s, { view: sView({ tx: TX_HAND(true), c: {} }), pill: pill({ pl: dp('vmLeave', 20), st: 'Continued on iPhone', wh: 'just now', end: false }) });
const C0 = (s) => desk(s, { view: sView({ tx: TX_HAND(false), c: { pst: 'ready', planetLabel: 'End Voice' } }), pill: pill({ st: 'Listening', wh: '3:08' }) });
// CX (C2 send-from-Mac / C3 follow-me alternatives) deleted 2026-11-07 (VOICE-LAB-CLEANUP-1107, NIP): C1, the synced
// transcript is the signal, was chosen; its rules live in C1's notes.

/* ═══════════════════════ 5 · NEEDS YOU, READ ALOUD ═══════════════════════ */
// voiceHooks.onAgentRequest already speaks a summary (gated by privacy.sharePermissionRequests, default on);
// voiceAgentPrompt.ts: a spoken yes never decides a permission request. The card is the one place it is decided.
// VI-04 (amended 2026-10-25): by default the Voice agent may answer a pending request for the person during a Voice
// conversation, after reading it out and asking, through the session's own approval custody (shipped setting
// c17e473fdc “Voice agent can approve requests”, default on; attribution “Approved by the Voice agent for {name}”).
// Off: approvals stay tap-only and Voice says so. The card is the session's own permission card (`req`, above).
const ask = (o = {}) => req(o);
const N_SAY = `<b style="font-weight:560">Review #2481 on Studio wants to run yarn test:e2e. Should I allow it?</b> <span class="w">Say yes or no, or tap.</span>`;
const N1 = (s) => desk(s, { view: sView({ tx: TX_FIX(), c: { pst: 'ready', planetLabel: 'End Voice' }, comp2: companion([glance({ st: 'Needs you', need: true, pst: 'speaking', tm: '4:51', body: `<div class="vm-gls" style="color:var(--text)">${N_SAY}</div>${req()}` })]) }), pill: pill({ st: 'Needs you', need: true }) });
const N1p = () => phone({ tx: TX_FIX(), c: { pst: 'ready' }, over: sheet(`<div class="vm-glh" style="height:34px">${planet(22, { st: 'speaking' })}<b style="font-size:16px">Voice</b><span class="m" style="color:var(--vm-need);font-weight:600">Needs you</span><span class="grow"></span><button class="vm-btn vm-sec" aria-label="End Voice" style="color:var(--danger)">${ic('vpEnd')}End</button></div><div class="vm-say" style="margin:8px 0 14px;font-size:15px;line-height:21px"><div>${N_SAY}</div></div>${req({ lg: true })}`) });
// A spoken yes, with the setting on (the default): the Voice agent answers the request for the person; the card shows the outcome.
const N2 = (s) => desk(s, { view: sView({ c: { pst: 'ready', planetLabel: 'End Voice' }, tx: `${TX_FIX()}${uSaid('Yeah, go ahead.', 'MacBook Pro')}${vSaid('Done — I allowed it. Review #2481 is running the end-to-end suite now.')}`, comp2: companion([glance({ st: 'Listening', tm: '5:03', body: `${req({ done: 'Approved by the Voice agent for Leeroy', note: false })}` })]) }), pill: pill({ st: 'Listening', wh: '5:03' }) });
// Locked phone: the existing attention notification, which opens the request in Happier. No lock-screen Allow / Deny,
// no authenticated action and no Voice Live Activity (PLAN §4.7: deferred, separate native vertical).
const N2p = () => `<div class="vm-lock"><div class="tm">9:41</div><div class="dt">Thursday, 2 October</div><div class="vm-note" style="margin-bottom:150px"><div class="h"><span class="ap">${planet(14)}</span>HAPPIER<span class="grow"></span>now</div><div class="t">Review #2481 needs you</div><div class="s">Claude wants to run yarn test:e2e on Studio</div></div></div>`;
function NX(s) {
  const card = (v, h, p, inner) => `<div class="vm-card"><div class="stage">${inner}</div><h3>${h}<span class="vm-verdict ${v}">${v === 'rec' ? 'Recommended' : v === 'no' ? 'Not proposed' : 'Alternative'}</span></h3><p>${p}</p></div>`;
  return `<div class="vm-board"><h1>Needs you · what is read aloud, and how it is decided</h1><p class="lede">Voice reads who, what and where, and asks. By default you can answer aloud and the Voice agent decides the request for you through the session’s own approval, or you tap the card (VI-04, amended 2026-10-25). One setting, “Voice agent can approve requests” (Voice → Conversations → During a conversation, default on), turns this off; then approvals stay a tap and Voice says so. The card is the same component in the Companion glance, the phone sheet, the brief and the Inbox. Ending Voice neither approves nor denies.</p><div class="vm-grid c3">
  ${card('rec', 'N-a · Who, what, where, then ask', 'Reads the session, the action in plain words and asks whether to allow it. Short enough not to interrupt a thought; enough to decide without looking first.', `<div class="vm-say">${planet(16, { st: 'speaking' })}<div>${N_SAY}</div></div>`)}
  ${card('alt', 'N-b · Read the exact command', 'Reads the full command and path. Precise, but long commands become noise, and secrets in arguments would be spoken out loud.', `<div class="vm-say">${planet(16, { st: 'speaking' })}<div><b style="font-weight:560">Review #2481 wants to run: yarn test colon e2e, in tilde slash Developer slash happier, on Studio.</b></div></div>`)}
  ${card('alt', 'N-c · A tone, then the card', 'No words: one soft tone and the pill turns to Needs you. Quietest, but you have to look to know what it is — the opposite of why you are talking.', `<div class="vm-say">${planet(16, { st: 'speaking' })}<div class="w">(one tone)</div></div><div style="margin-top:10px">${pill({ st: 'Needs you', need: true, wh: 'Review #2481', end: false }).replace('class="vo-pill', 'class="vo-pill inl').replace(/style="right:\d+px"/, '')}</div>`)}
  </div><h2>States</h2><div class="vm-grid c3">
  <div class="vm-card"><h3>Answered by voice</h3>${req({ done: 'Approved by the Voice agent for Leeroy', note: false })}<p style="margin-top:10px">The card turns into its outcome, attributed to the Voice agent acting for you (shipped copy). Decided on another device, it shows the outcome without inventing which device.</p></div>
  <div class="vm-card"><h3>Voice approvals off</h3>${req({ note: 'Read aloud · tap to decide here' })}<div class="vm-say" style="margin-top:10px">${planet(16)}<div><span class="w">I can’t answer requests by voice — that’s off in Voice settings. Tap Yes on the card to allow it.</span></div></div></div>
  <div class="vm-card"><h3>Voice ends while it’s pending</h3><div class="vm-say">${planet(16)}<div>An approval is still waiting.</div></div><div style="margin-top:10px">${btn('Review request', 'sec')}</div><p style="margin-top:10px">Shipped (<code>needsYouEnded</code>, <code>needsYouReview</code>). The request stays reachable in the Companion, Inbox and session.</p></div>
  <div class="vm-card"><h3>Sharing requests is off</h3><div class="vm-say">${planet(16)}<div><span class="w">Something needs you in another session.</span></div></div><p style="margin-top:10px">With Privacy → “Share permission requests” off, Voice says only that something needs you and passes no command to the provider; the card still shows on screen.</p></div>
  </div></div>`;
}

/* ═══════════════════════ 0 · SET UP VOICE (Get set up block) ═══════════════════════ */
// The Home "Get set up" owner as it ships (SetupBlockGrid: a tile that grows in place into its panel; SetupSteps: the one
// numbered-step anatomy), drawn with the Home index lab's own tile/panel classes. One setup item (`useVoiceSetupItem`, new)
// with two hosts: Home → Get set up, and the top of Settings → Voice; the planet's first tap (T1) opens the same steps.
// The planet beside the steps is the Daybreak Light: it advances only when a step has really finished.
const { sec: hsec, tile: htile, tiles: htiles } = window.HI;
const SVP = [ // step 1's choices: one per service, its readiness in words (provider ≠ billing: ElevenLabs once)
  { k: 'eleven', t: 'ElevenLabs', s: 'Through Happier with Happier Pro, or your own ElevenLabs account', r: 'Needs Happier Pro or a key' },
  { k: 'openai', t: 'OpenAI Realtime', s: 'Uses your OpenAI account', r: '<span class="vm-dot ok"></span>Account connected', on: 1 },
  { k: 'xai', t: 'Grok Voice', s: 'Uses your xAI key', r: 'Add a key' },
  { k: 'local', t: 'Local voice', s: 'Runs on devbox. Free and private', r: 'Downloads 1.4 GB' },
];
const svPaths = (sel = 'openai') => `<div class="af-paths vm-svpaths" role="radiogroup" aria-label="Who listens">${SVP.map((p) => `<div class="af-path ${p.k === sel ? 'on' : ''}" role="radio" aria-checked="${p.k === sel}"><span class="gl">${PMK(p.k, 17)}</span><div><div class="t">${p.t}</div><div class="s">${p.s}</div><div class="s vm-svr">${p.r}</div></div></div>`).join('')}</div>`;
// SetupSteps anatomy: done = check, current = ringed number, upcoming = number
const sstep = (n, st, t, d = '', body = '') => `<li class="vm-ss ${st}" ${st === 'current' ? 'aria-current="step"' : ''}><i>${st === 'done' ? ic('check') : n}</i><div class="c"><div class="t">${t}</div>${d ? `<div class="d">${d}</div>` : ''}${body ? `<div class="b">${body}</div>` : ''}</div></li>`;
function svSteps(o) {
  const at = o.at; // 1..4 current step, 5 = done
  const st = (n) => (n < at ? 'done' : n === at ? 'current' : 'upcoming');
  const local = o.path === 'local';
  const s1 = at > 1 ? sstep(1, 'done', local ? 'Local voice on devbox' : 'OpenAI Realtime', local ? 'Free and private · Change' : 'Uses your OpenAI account · <a>Change</a>') : sstep(1, 'current', 'Choose who listens', 'What hears you and speaks back. You can change it later.', svPaths(o.sel));
  const s2 = local
    ? sstep(2, st(2), at > 2 ? 'Speech models installed on devbox' : 'Install the speech models on devbox', at === 2 ? 'Whisper to hear, Kokoro to speak · 0.9 of 1.4 GB · about 1 min' : '', at === 2 ? `<div class="vm-prog" style="max-width:280px"><i class="dn"></i><i class="dn"></i><i class="dn"></i><i class="nw"></i><i></i></div><div class="vm-svnote">You can close this; it keeps going and the step finishes by itself.</div>` : '')
    : sstep(2, st(2), at > 2 ? 'OpenAI account connected' : 'Connect your OpenAI account', at > 2 ? 'leeroy@… · from Connected services' : 'Opens Connected services and comes back here.', at === 2 ? btn('Connect OpenAI', 'pri') : '');
  const s3 = sstep(3, st(3), at > 3 ? 'Microphone allowed' : 'Allow the microphone', at === 3 ? `${o.phone ? 'iOS' : 'macOS'} asks once. Happier listens only while Voice is on, and you can always see when it is.` : '', at === 3 ? btn('Allow microphone', 'pri', 'vpMic') : '');
  const s4 = at === 4
    ? sstep(4, 'current', 'Try it', '', `${phrase({ heard: 'What are my', rest: 'sessions doing?', mic: o.phone ? 'iPhone Microphone' : 'MacBook Pro Microphone' })}`)
    : sstep(4, st(4), at > 4 ? 'Tried it' : 'Try it', at > 4 ? '“What are my sessions doing?” — two working, one needs you' : '');
  return `<ol class="vm-sslist" aria-label="Steps">${s1}${s2}${s3}${s4}</ol>`;
}
const svLight = (o) => ({ 1: 0, 2: 0.25, 3: 0.5, 4: 0.75, 5: 1 })[o.at];
function svPanel(o = {}) {
  const done = o.at === 5;
  const vis = done ? dp('vmGather', o.phone ? 96 : 168) : dp('daybreak', o.phone ? 96 : 168, {}, `data-progress="${svLight(o)}" ${o.path === 'local' && o.at === 2 ? 'data-state="working"' : ''}`);
  const cap = done ? 'Ready' : `${o.at - 1} of 4 ready`;
  const head = done
    ? `<h3>Voice is ready</h3><p>Tap the voice button in any chat to start talking, and tap it again to end. Mute sits beside End while you talk.</p>`
    : `<h3>Set up voice</h3><p>Talk to your sessions out loud: ask what’s happening, start work, decide from anywhere. Four steps; you can leave and come back.</p>`;
  // Shipped VoiceSetupPanel (done): Tap start · end, and the resolved voice.toggle label (⌥⌘V by default, rebindable in
  // Settings → Keyboard) start · end anywhere, desktop only. Hold is opt-in elsewhere, so the panel does not teach it.
  const how = done ? `<div class="vm-svhow"><span>${kbd('Tap')} start · end</span>${o.phone ? '' : `<span>${kbd('⌥⌘V')} start · end anywhere</span>`}</div>` : '';
  const foot = done ? `<div class="hi-qrrow">${btn('Done', 'pri')}${btn('Voice settings', 'ter')}</div>` : '';
  return `<div class="hi-qrp vm-svp ${o.phone ? 'ph' : ''}" role="region" aria-label="Set up voice"><div class="vm-svis">${vis}<div class="cap">${cap}</div></div><div class="hi-qrb">${head}${done ? how : svSteps(o)}${foot}</div><button class="hi-x" style="top:12px;right:12px" aria-label="Close">${ic('x')}</button></div>`;
}
const svTile = (o = {}) => htile({ g: dp('daybreak', 24, {}, `data-progress="${o.at ? svLight(o) : 0}"`), t: 'Set up voice', d: o.at ? `${o.at - 1} of 4 done · ${o.next || 'allow the microphone next'}` : 'Talk to your sessions out loud. Four short steps.', a: [h.btn(o.at ? 'Continue' : 'Set up', 'secondary', '', 'sm')] }, { cls: o.cls || '' });
const svHome = (inner) => homeView({ sub: `<span>2 sessions working</span><span><span class="dot" style="background:var(--orange)"></span>1 needs you</span>`, rest: [hsec('Get set up', htiles(inner), { menu: true })] }).replace(/<button class="vm-btn vm-sec vm-lg"[\s\S]*?Brief me<\/button>/, '');
const svOthers = () => ['phone', 'machine'].map((k) => htile(k)).join('');
const SA = (s) => desk(s, { tabs: [['home', { active: true }], ['fix'], ['rev']], view: svHome(`${svTile()}${svOthers()}`) });
const SB = (s) => desk(s, { tabs: [['home', { active: true }], ['fix'], ['rev']], view: svHome(`${svPanel({ at: 1 })}${svOthers()}`) });
const SC = (s) => desk(s, { tabs: [['home', { active: true }], ['fix'], ['rev']], view: svHome(`${svPanel({ at: 3 })}${svOthers()}`) });
const SD = (s) => desk(s, { tabs: [['home', { active: true }], ['fix'], ['rev']], view: svHome(`${svPanel({ at: 5 })}${svOthers()}`) });
const pHome = (inner) => `<div class="z-ph hi-ph"><div class="hdr"><span class="z-av">LB</span><span class="hm"><span class="dot ok" style="width:6px;height:6px"></span>Personal Home</span><span class="grow"></span></div><div class="hi-pb" style="padding:4px 16px 120px"><div style="font:660 26px/32px InterLab;letter-spacing:-.02em;margin:14px 4px 4px">Good afternoon, Leeroy</div><div style="margin:0 4px 10px;font-size:13.5px;color:var(--text2)">2 sessions working ${sep} 1 needs you</div>${hsec('Get set up', `<div class="hi-tiles vm-ptiles">${inner}</div>`, { menu: true })}</div><div class="tabbar">${['bubble', 'inbox', 'folder', 'gear'].map((i) => ic(i, i === 'bubble' ? 'on' : '')).join('')}</div></div>`;
const SAp = () => pHome(`${svTile({ cls: 'wide' })}${htile('pcomputer', { cls: 'wide' })}`);
const SBp = () => pHome(svPanel({ at: 1, phone: true }));
const SCp = () => pHome(svPanel({ at: 2, path: 'local', phone: true }));
const SDp = () => pHome(svPanel({ at: 5, phone: true }));
// top of Settings → Voice: the same item, as a wide tile until voice is ready (then it leaves)
// the settings column (channels-lab.css ch-*, the same markup the voice-settings page uses)
const setCol = () => `<div class="ch-col cs-scol" role="navigation" aria-label="Settings"><div class="ch-colh"><b>Settings</b></div><div class="ch-find">${ic('search')}<span>Search settings</span></div><div class="ch-list">${NAV.map((n) => (n.g ? `<div class="ch-lbl">${n.g.charAt(0) + n.g.slice(1).toLowerCase()}</div>` : `<div class="ch-row ${n.k === 'voice' ? 'on' : ''}"><span class="g">${ic(n.i)}</span><div class="c"><div class="t">${n.k === 'voice' ? 'Voice' : n.t}</div></div></div>`)).join('')}</div></div>`;
function svSettings(s, o = {}) {
  const page = `<div class="page vm-svset"><header class="ph"><div class="t" style="display:flex;gap:14px;align-items:center">${planet(36)}<div><h1>Voice</h1><p>Talk with your agents out loud, and dictate into any message.</p></div></div></header><div class="hi-tiles" style="margin-bottom:28px">${o.open ? svPanel({ at: 3 }) : svTile({ at: 3, cls: 'wide' })}</div>${h.sec('Two ways to use your voice', '', `<div class="vm-svghost"><div></div><div></div></div>`)}</div>`;
  return desk(s, { tabs: [['fix'], ['rev'], ['vsHub', { active: true }]], rail: 'settings', colHtml: setCol(), view: `<div style="flex:1;min-width:0;overflow:hidden">${page}</div>` });
}
const SV = (s) => svSettings(s);
const SVp = () => `<div class="z-ph hi-ph">${window.HI.pnav('Settings')}<div class="hi-pb" style="padding:4px 16px 40px"><div class="hi-pt" style="padding:0 4px">Voice</div><div style="margin:2px 4px 14px;font-size:14px;color:var(--text2)">Talk with your agents out loud, and dictate into any message.</div><div class="hi-tiles vm-ptiles">${svTile({ at: 3, cls: 'wide' })}</div><div class="vm-svghost ph"><div></div><div></div></div></div></div>`;

/* ═══ notes ═══ */
const N_TRY = `<h3>T1 · Try voice, in place (recommended, signature)</h3><ul><li><b>Entry:</b> a recoverable planet stays in the composer (spec §2.5) — today it is hidden when Voice is unavailable, which removes the very way in (finding). Its first tap unfolds this card from the planet.</li><li><b>Steps</b> are the readiness owner’s, in words: 1 who listens (only if nothing is ready), 2 the microphone (only before the first grant; a reason before the OS prompt ${NEW()}), 3 say hello.</li><li><b>Signature:</b> “What are my sessions doing?” lights up word by word as it is heard, the planet’s atmosphere is the real input level ${NEW()}, and the reply is real — it uses <code>listSessions</code>. The test is the first conversation, in this session, so Done just folds the card back into the composer planet.</li><li><b>Daybreak grammar:</b> Light = readiness (0 → ⅓ → ⅔ as steps really finish), Atmosphere = your voice while you are heard and its voice while it answers, dots gather once when the first reply arrives (Signature, 1.2 s). Idle is still. The composer planet stays still while the card (the planet, expanded) is open, so only one planet moves.</li></ul>`;
const V = {
  SA: { label: 'SA · Set up voice, collapsed', html: SA, notes: `<h3>SA · “Set up voice” in Get set up</h3><ul><li>The Home <b>Get set up</b> owner as it ships (<code>SetupBlockGrid</code> tile → in-place panel; <code>SetupSteps</code>), not a new card. The tile’s mark is the Daybreak planet at its current light (none yet), its action <b>Set up</b>, and × hides it (restore from Customize), like every setup tile.</li><li>Shown until voice is ready, here and at the top of Settings → Voice (SV). One setup item ${NEW('new · useVoiceSetupItem')} with two hosts; the planet’s first tap (T1) opens the same steps.</li></ul>` },
  SAp: { label: 'SA · 390', phone: true, html: SAp, notes: `<h3>SA · 390</h3><p>Phone Get set up: wide tiles in one column, same item.</p>` },
  SB: { label: 'SB · Expanded: choose (rec.)', html: SB, notes: `<h3>SB · The tile grows into the panel — step 1</h3><ul><li>In place, the row’s full width (the pairing panel’s morph and Esc). Left: the planet, its <b>Light</b> at 0 of 4 — it moves only when a step really finishes. Right: four steps in the <code>SetupSteps</code> anatomy.</li><li>Step 1’s choices are the services with readiness in words; the one already usable (your OpenAI account is connected) is preselected, so step 2 finishes itself.</li><li>Steps already true are shown done, never asked twice (readiness owner).</li></ul>` },
  SBp: { label: 'SB · 390', phone: true, html: SBp, notes: `<h3>SB · 390</h3><p>The panel stacks: planet above, steps below, choices one per row.</p>` },
  SC: { label: 'SC · In progress', html: SC, notes: `<h3>SC · In progress — step 3</h3><p>Two steps done collapse to one line each with Change; the light stands at 2 of 4. The current step asks for one thing (Allow microphone) with the reason before the system prompt ${NEW()}.</p>` },
  SCp: { label: 'SC · 390 (installing)', phone: true, html: SCp, notes: `<h3>SC · 390, Local voice installing</h3><p>The install path: step 2 downloads the speech models on devbox (readiness <code>installing</code>). The light stays at 1 of 4 and the terminator shimmers while working; it advances when the download finishes, not before. Closing the panel keeps it going; the tile says “1 of 4 done · installing”.</p>` },
  SD: { label: 'SD · Done', html: SD, notes: `<h3>SD · Done</h3><ul><li>The fourth step finished (it heard you and answered): the light reaches full and the dots gather once (Signature, 1.2 s).</li><li>The panel teaches the shipped gestures: <b>Tap</b> start · end, and on desktop the resolved shortcut <b>⌥⌘V</b> start · end anywhere — rebindable in Settings → Keyboard (“Start or end Voice”), so the label follows a rebinding (<code>VoiceSetupPanel</code> + <code>useKeyboardShortcutLabel('voice.toggle')</code>). Hold to talk is opt-in in Voice → Advanced and is not taught here. Done closes it and the item leaves Get set up; Voice settings is beside it.</li></ul>` },
  SDp: { label: 'SD · 390', phone: true, html: SDp, notes: `<h3>SD · 390</h3><p>Same done state; no keyboard line on the phone.</p>` },
  SV: { label: 'SV · Top of Settings → Voice', html: SV, notes: `<h3>SV · The same item at the top of Settings → Voice</h3><p>Until voice is ready, the Voice settings page opens with the setup tile (wide), showing where you are (“2 of 4 done · allow the microphone next”). Continue grows it in place exactly as on Home. Lane B owns the page below it (drawn as a placeholder here).</p>` },
  SVp: { label: 'SV · 390', phone: true, html: SVp, notes: `<h3>SV · 390</h3><p>Phone Settings → Voice with the same wide tile on top.</p>` },
  T1: { label: 'T1 · Try voice in place (rec.)', html: T1, notes: `${N_TRY}<h3>Why in place (chosen over T2 / T3)</h3><p>The tapped mark becomes the setup, then the conversation, without leaving the chat; the test is the first real turn. A centred setup sheet (T2) and a settings-first jump (T3) were honest but moved you away from your work; both were deleted from the lab on 2026-11-07 (not in the plan).</p>` },
  T1p: { label: 'T1 · 390', phone: true, html: T1p, notes: `<h3>T1 · 390</h3><p>The same card as a sheet rising from the composer, so the planet stays visible beneath it. Big targets; the reply is short because the phone is held, not read from a desk.</p>` },
  TB: { label: 'TB · Beats + motion', zboard: true, html: TB, notes: `<h3>TB · The four beats</h3><p>Each step collapses to a one-line summary when it is done, so the card never grows past three rows. The after-state hands over to the live pill (lane A).</p>` },
  TBp: { label: 'TB · 390 (beat 1)', phone: true, html: TBp, notes: `<h3>TB · 390, beat 1</h3><p>Who listens, with readiness per provider in words. ElevenLabs appears once; through Happier or your own account sits beneath it (lane B’s provider ≠ billing rule). Only a ready provider is preselected.</p>` },
  TS: { label: 'TS · States', zboard: true, html: TS, notes: `<h3>TS · States</h3><p>Real readiness codes and runtime errors, each with its one action, in the shipped setup copy. No fixed silence deadline (the capture/provider lifecycle decides no-input), no input-device name or microphone switcher, no automatic retry on focus: no owner supplies those facts (PLAN §4.6 Try; VOICE-GAP-1107 PC).</p>` },
  TSp: { label: 'TS · 390 (mic off)', phone: true, html: TSp, notes: `<h3>TS · 390</h3><p>iOS: “Settings › Happier › Microphone”, and the card resumes on return.</p>` },
  B0: { label: 'B0 · Brief me, at rest', html: B0, notes: `<h3>B0 · The entry</h3><ul><li>Home’s greeting line already summarizes the present. “Welcome back” and “Since you were last here at 09:12” come from the per-account read cursor (<code>AccountSessionReadState</code>) ${NEW('new derivation')}.</li><li>One quiet button: <b>Brief me</b>. Also in the Inbox header and the command palette.</li></ul>` },
  B0p: { label: 'B0 · 390', phone: true, html: B0p, notes: `<h3>B0 · 390</h3><p>Phone Home: the same line, the button full width under it.</p>` },
  B1: { label: 'B1 · Brief me, open (rec.)', html: B1, notes: `<h3>B1 · Brief me, open</h3><ul><li>Brief me sits on Home’s greeting line; opening it replaces Needs your attention with the brief in place (shipped 77938f8786). The call’s status lives in the presence: an ordinary Speaking pill with its clock.</li><li>The head carries only what the brief adds: <b>Stop</b> while a reply can be stopped (cancels the reply, never ends the call or approves work) and close. When Voice can’t read aloud it says so with its one action (“Voice can’t read this aloud right now.” + Retry or Set up; 9c1a8aa903).</li><li>One sheet: Needs you → Failed → Ready, a status dot per row in Home’s tones, each row opening its exact destination; a needs-you row carries the session’s real request card. Incomplete and caught-up facts read in the head (“Some work hasn’t loaded yet…”, “Nothing needs you right now.”).</li><li>No Pause / Next and no row-by-row progress: they appear only where a provider admits the control (PLAN §4.6), and none does today. No “Still working” group.</li></ul>` },
  B1p: { label: 'B1 · 390', phone: true, html: B1p, notes: `<h3>B1 · 390</h3><p>The same brief in Home’s column: Stop and close in the head, one sheet, the request card full width. The pill above the bar is the ordinary call presence (Speaking · clock); no brief progress.</p>` },
  BX: { label: 'BX · Alternatives + states', zboard: true, html: BX, notes: `<h3>BX</h3><p>B1 (recommended) is a button for B2’s question. B3 (automatic) is not proposed: unrequested sound and mic.</p>` },
  H1: { label: 'H1 · Hold the Voice mark (opt-in)', html: H1, notes: `<h3>H1 · Hold to talk on desktop (opt-in)</h3><ul><li>With <b>Hold to talk</b> on (Voice → Advanced → How you talk) and a service that admits it, holding the composer’s Voice mark talks for one turn: the composer becomes the readout in place, the planet’s atmosphere following your voice. Release sends; drag away cancels (shipped hint). Releasing never ends Voice or approves anything.</li><li>A service without hold says so (“… doesn’t support holding to talk. Tap to talk instead.”); tap still works.</li><li>The keyboard is a toggle, not a hold: <b>⌥⌘V</b> starts or ends Voice (rebindable). No ⌥Space and no second keyboard system.</li><li><b>Why holding talks to Voice (H-a, chosen):</b> one meaning per gesture, decided by the canonical targeting rule — in a session you talk to that session’s Voice; a running conversation is never re-targeted. Hold-to-dictate (H-b) and both-by-modifier (H-c) were deleted from the lab on 2026-11-07 (not in the plan); Dictation keeps its field mic.</li></ul>` },
  H1p: { label: 'H1 · 390 (hold the planet)', phone: true, html: H1p, notes: `<h3>H1 · 390</h3><ul><li>Hold the composer planet ≥ 250 ms ${NEW()}. The thumb covers it, so the readout sits above the thumb; the field shows the words.</li><li>Release sends, slide left cancels (iMessage voice-note grammar). One firm haptic at start, a light one on send.</li><li>No collision with the bar (HG).</li></ul>` },
  H2: { label: 'H2 · ⌥⌘V, no composer', html: H1b, notes: `<h3>H2 · The shortcut anywhere</h3><p>On a page with no session (PRs &amp; Issues), <b>⌥⌘V</b> starts Global Voice and the top bar shows the live pill; the same shortcut ends it. It is the registered <code>voice.toggle</code> command (default Mod+Alt+V, rebindable in Settings → Keyboard), never one handler per composer; key repeat is ignored. Nothing is re-targeted later.</p>` },
  HG: { label: 'HG · Gesture map', zboard: true, html: HG, notes: `<h3>HG · Gesture map</h3><p>Only in-app gestures: tap to start/end on the Voice mark and the presence marks, opt-in hold on the composer’s Voice mark, ⌥⌘V on desktop. No Action button, Shortcut, App Intent or Android Quick Settings tile is promised (PLAN §4.4).</p>` },
  C0: { label: 'C0 · Talking on the Mac', html: C0, notes: `<h3>C0 · Before leaving</h3><p>A conversation running on MacBook Pro; voice turns are ordinary messages with a quiet “Spoken · MacBook Pro” marker.</p>` },
  C1p: { label: 'C1 · 390 offer (rec.)', phone: true, html: C1p, notes: `<h3>C1 · 390, the offer</h3><ul><li>Opening the session on the phone: the last voice turn came from MacBook Pro a minute ago, so “Continue talking here” sits above the composer. One tap, no sound.</li><li>It reads only the synced session (turns carry their device ${NEW()}).</li></ul>` },
  C2p: { label: 'C1 · 390 continued', phone: true, html: C2p, notes: `<h3>C1 · 390, continued</h3><p>Voice runs here on the same conversation (history and provider conversation id are on the server), so it knows what “Windows” means.</p>` },
  C1: { label: 'C1 · The Mac lets go', html: C1, notes: `<h3>C1 · The Mac lets go</h3><p>The Mac sees a newer voice turn from another device in its own conversation and ends its mic; the pill reads “Continued on iPhone · just now”, then disappears ${NEW()}.</p><h3>Why the transcript is the signal (chosen over C2 / C3)</h3><p>The conversation already lives on the server; only the microphone is local. The phone offers to continue from the synced conversation and the Mac ends its own mic when it sees the newer turn — no lease, no push. Sending it from the Mac (C2) was a device-to-device command the plan rules out; following you automatically (C3) needed presence signals Happier does not have. Both were deleted from the lab on 2026-11-07 (not in the plan). The Mac ends only for its own conversation; a different session’s Voice is untouched, and an asleep Mac simply ends later.</p>` },
  N1: { label: 'N1 · Needs you, read aloud (rec.)', html: N1, notes: `<h3>N1 · Needs you, read aloud</h3><ul><li>Voice says who, what and where, and asks; the Companion glance shows the session’s own permission card (Yes · No · Stop); the pill turns amber “Needs you”.</li><li><b>VI-04 (amended 2026-10-25):</b> by default you can answer aloud — the Voice agent decides the request for you through the session’s approval custody — or tap. One setting turns voice answers off (shipped c17e473fdc, default on).</li><li>With Privacy → “Share permission requests” off, Voice says only that something needs you.</li><li>Product note: the shipped line under the card still reads “Read aloud · tap to decide here” with the setting on; that copy is the product owner’s follow-up.</li></ul>` },
  N1p: { label: 'N1 · 390', phone: true, html: N1p, notes: `<h3>N1 · 390</h3><p>The Voice sheet with the same permission card, full-width Yes. Answer aloud or tap.</p>` },
  N2: { label: 'N2 · A spoken “yes”', html: N2, notes: `<h3>N2 · A spoken yes</h3><ul><li>“Yeah, go ahead.” With “Voice agent can approve requests” on (the default), the Voice agent allows the request through the session’s own approval and says so; the card shows “Approved by the Voice agent for Leeroy” (shipped copy, c17e473fdc).</li><li>With the setting off, Voice says it can’t answer by voice and points to the card (NX).</li><li>No turn-binding or freshness machinery (VI-04). Supersedes the earlier “a spoken yes never decides” rule.</li></ul>` },
  N2p: { label: 'N2 · 390 locked', phone: true, html: N2p, notes: `<h3>N2 · 390, phone locked</h3><p>The existing attention notification, unchanged: it says what needs you and opens the request in Happier. No lock-screen Allow / Deny, no authenticated notification action and no Voice Live Activity (PLAN §4.7 defers a dedicated iOS Voice activity). While a conversation keeps running in the background, Voice can still read the request and take a spoken answer (VI-04).</p>` },
  NX: { label: 'NX · What is read + states', zboard: true, html: NX, notes: `<h3>NX</h3><p>N-a recommended. States: answered by voice, voice approvals off, Voice ended while pending (shipped), sharing off.</p>` },
};
S['voice-moments'] = { title: 'Voice moments', subtitle: 'Set up voice · Try voice · Brief me · Hold to talk · Continue here · Needs you, read aloud', def: 'SB', variants: V };
window.VM = { planet, pill, glance, ask };
})();
