// Voice presence lab (2026-10-02, lane A `voice-presence`). Concept `voice-presence`.
// Lead (orchestrator direction the user approved): no tinted vessel in the sidebar and no default floating orb. While a
// conversation runs, a live pill sits in the top rail (planet · state · meter · mute · end) and opens the conversation as
// a Voice glance in the Companion (F1 frame, Plain). Phone: the pill docks above the bar and opens a sheet with the same
// glance. Alternatives: Companion-first (B), pill + popover only / top island on phones (C), the opt-in orb (O).
// Product truth: resolveVoiceSurfaceState/StatusPresentation (states + tones), voiceLabModel (basis ledger),
// VoiceAttemptControlProjection (spec §2.5), useVoiceEnergy (§2.4a breathing = capture fact), VoiceAnnouncer (§5.4a),
// voice_agent_turn.v1 (transcript marker), HappierFocusLiveActivity + the Android voice FGS (lock screen, `new` kind).
// Shell: window.WS (workspace top rail + tabs, session header), window.SS (session shell, action rail, phone session),
// window.HI (composer); Companion classes from companion-nav.css; planet from ../voice-planet.js (window.VP). IIFE.
(() => {
const { planet, meter, cell } = window.VP;
const { composer } = window.HI;
const { actionRail, phoneSession, TX } = window.SS;
const WS = window.WS; const D = WS.D;
const NEW = (t = 'new') => `<span class="ch-new" title="Needs new data or capability">${t}</span>`;
const SEP = '<span style="color:var(--text3)">·</span>';
const B = (t) => `<b style="color:var(--text);font-weight:560">${t}</b>`;

/* ═══ the state vocabulary (shared session presenter words; basis per voiceLabModel / spec §8) ═══ */
// pl: the Daybreak pose/scene (VP.planet st). cell: the 2×4 dot-cell status glyph. m/lv: only for the bar-meter comparison.
const ST = {
  preparing:   { l: 'Preparing', cap: 'Getting the microphone ready', tone: 'pending', pl: 'connecting', m: null, basis: 'derivable', src: 'runtime `acquiring_mic` (collapsed into connecting today)', say: 'Voice is starting' },
  connecting:  { l: 'Connecting…', cap: 'Opening the audio channel to OpenAI', tone: 'pending', pl: 'connecting', m: null, basis: 'model', say: 'Connecting' },
  listening:   { l: 'Listening', cap: 'Go ahead', tone: 'active', pl: 'listening', m: 'in', lv: [0.12, 0.18, 0.1, 0.16, 0.12], basis: 'model', say: 'Listening', time: '0:08' },
  hearing:     { l: 'Listening', cap: 'Hearing you', tone: 'active', pl: 'hearing', m: 'in', live: true, lv: [0.5, 0.9, 0.65, 1, 0.55], basis: 'model', note: 'Label stays “Listening”: your voice thickens the atmosphere only. A semantic “You’re speaking” waits for a provider-neutral VAD fact (§8.1).', say: '—', time: '0:12' },
  transcribing:{ l: 'Transcribing…', cap: 'Turning that into text', tone: 'pending', pl: 'thinking', cell: 'think', m: null, basis: 'model', say: 'Transcribing', time: '0:14' },
  thinking:    { l: 'Thinking…', cap: 'Working out an answer', tone: 'pending', pl: 'thinking', cell: 'think', m: null, basis: 'model', say: 'Thinking', time: '0:15' },
  speaking:    { l: 'Speaking', cap: 'You can interrupt any time', tone: 'active', pl: 'speaking', m: 'out', live: true, lv: [0.45, 0.85, 0.6, 1, 0.7, 0.4, 0.8], basis: 'model', say: '— (the speech is the output)', time: '2:14' },
  interrupted: { l: 'Interrupted', cap: 'Go ahead', tone: 'pending', pl: 'listening', m: 'in', lv: [0.2, 0.3, 0.15, 0.25, 0.2], basis: 'model', say: 'Interrupted', time: '2:20' },
  working:     { l: 'Working', cap: 'Codex is running yarn test relay · still listening', tone: 'active', pl: 'listening', cell: 'working', m: null, basis: 'derivable', src: '`delegatedWork` projection (§8.2): Session.thinking + display_status', say: 'Codex is working on Relay retry', time: '3:02' },
  needs:       { l: 'Needs you', cap: 'Waiting for your decision', tone: 'need', pl: 'listening', cell: 'attn', m: null, basis: 'derivable', src: 'the target session’s attention state (shared presenter `needs_you`)', say: 'Claude in Review #2481 wants to run yarn test:e2e. Should I allow it?', time: '3:40' },
  muted:       { l: 'Muted', cap: 'Unmute to talk · Voice can still speak', tone: 'neutral', pl: 'muted', m: null, muted: true, basis: 'model', src: '`isMuted` (capture stays open, input gated)', say: 'Microphone muted', time: '2:31' },
  blocked:     { l: 'Microphone blocked', cap: 'Allow microphone access for Happier in System Settings', tone: 'error', pl: 'shade', m: null, act: 'Allow', basis: 'model', say: 'Microphone blocked. Allow access to talk.' },
  reconnecting:{ l: 'Reconnecting…', cap: 'Lost the connection to OpenAI · trying again', tone: 'pending', pl: 'eclipse', m: null, act: 'Retry', basis: 'model', note: 'Retry must stay available while reconnecting (audit A-F1: it disappears today).', say: 'Reconnecting', time: '4:02' },
  failed:      { l: 'Couldn’t connect', cap: 'OpenAI Realtime isn’t set up on this device', tone: 'error', pl: 'shade', m: null, act: 'Retry', act2: 'Set up', ended: true, basis: 'model', note: 'Retry must restart the same conversation and Home (audit #2: it starts a targetless one today).', say: 'Couldn’t connect. OpenAI Realtime isn’t set up on this device.' },
  ended:       { l: 'Voice ended', cap: '4:12 · the conversation is saved', tone: 'neutral', pl: 'ended', m: null, ended: true, basis: 'derivable', src: 'runtime `ending` (collapsed into connecting today) — a local exit transition only, never a durable state (§8.3)', say: 'Voice ended' },
};
const ORDER = ['preparing', 'connecting', 'listening', 'hearing', 'transcribing', 'thinking', 'speaking', 'interrupted', 'working', 'needs', 'muted', 'blocked', 'reconnecting', 'failed', 'ended'];

/* ═══ the live pill (desktop top rail) ═══ */
function pill(k, o = {}) {
  const s = ST[k];
  const glyph = s.cell ? cell(s.cell) : '';
  const main = `<button class="mk" aria-label="End Voice">${planet(20, { st: s.pl })}</button><button class="main" aria-label="Voice, ${s.l}${s.time ? `, ${s.time}` : ''}. Open the conversation" aria-expanded="${!!o.open}"><span class="l">${s.l}</span>${glyph}${s.time ? `<span class="tm">${s.time}</span>` : ''}</button>`;
  let tail;
  if (k === 'ended') tail = '';
  else if (s.act) tail = `<button class="tb">${s.act}</button><button class="ib" aria-label="${s.ended ? 'Dismiss' : 'End Voice'}">${ic(s.ended ? 'x' : 'vpEnd')}</button>`;
  else tail = `<span class="dv"></span><button class="ib ${s.muted ? 'on' : ''}" aria-label="${s.muted ? 'Unmute' : 'Mute'}" aria-pressed="${!!s.muted}">${ic(s.muted ? 'vpMicOff' : 'vpMic')}</button><button class="ib end" aria-label="End Voice">${ic('vpEnd')}</button>`;
  return `<div class="vo-pill t-${s.tone} ${o.open ? 'open' : ''} ${o.inl ? 'inl' : ''}" role="group" aria-label="Voice">${main}${tail}</div>`;
}
/* the phone pill (docked above the bar; same content at touch size) */
function ppill(k, o = {}) {
  const s = ST[k];
  const glyph = s.cell ? cell(s.cell, 'lg') : '';
  let tail;
  if (k === 'ended') tail = '';
  else if (s.act) tail = `<button class="tb">${s.act}</button><button class="ib" aria-label="${s.ended ? 'Dismiss' : 'End Voice'}">${ic(s.ended ? 'x' : 'vpEnd')}</button>`;
  else tail = `<button class="ib ${s.muted ? 'on' : ''}" aria-label="${s.muted ? 'Unmute' : 'Mute'}">${ic(s.muted ? 'vpMicOff' : 'vpMic')}</button><button class="ib end" aria-label="End Voice">${ic('vpEnd')}</button>`;
  return `<div class="vo-ppill t-${s.tone} ${o.top ? 'top' : ''} ${o.inl ? 'inl' : ''}" role="group" aria-label="Voice, ${s.l}"><button class="main">${planet(24, { st: s.pl })}<span class="l">${s.l}</span>${glyph}${s.time && !o.noTime ? `<span class="tm">${s.time}</span>` : ''}</button>${tail}</div>`;
}

/* ═══ the Voice glance: one component, three hosts (Companion · popover · phone sheet) ═══ */
const ROWS = {
  speaking: [
    ['u', 'Where are we on the relay retry?'],
    ['a', 'Codex finished the backoff and two of five relay tests pass. It’s running the rest now — want me to tell you when they’re done?', true],
  ],
  needs: [
    ['u', 'Run the end-to-end suite on the review too.'],
    ['a', 'Claude in Review #2481 wants to run yarn test:e2e on Studio. Should I allow it?'],
  ],
  listening: [
    ['u', 'Where are we on the relay retry?'],
    ['a', 'Two of five relay tests pass; Codex is running the rest.'],
  ],
};
const dlRow = (o = {}) => `<div class="vo-dl" role="link" aria-label="Open Relay retry with backoff">${BRAND.codex(15)}<b>Relay retry with backoff</b><span class="s">${o.done ? `${cell('done')}5 of 5 passed` : `${cell('working')}Working · 40 s`}</span></div>`;
/* The request card is the session's own permission card (SessionPendingPromptCards chrome="card", reused by
   VoiceNeedsYouPrompts; seen live in VOICE-DESIGN-INCALL-1106 on 08c7b40e96): neutral fill, the command, Yes · No · Stop.
   Under it one quiet line. VI-04 (amended 2026-10-25, shipped setting c17e473fdc "Voice agent can approve requests",
   default on): Voice reads the request out and asks; the person answers aloud or taps. Off: tap only, and Voice says so. */
const reqCard = (o = {}) => `<div class="vo-req ${o.lg ? 'lg' : ''}" role="group" aria-label="Claude needs your approval: run yarn test:e2e"><div class="h">${ic('lock')}<b>${o.title || 'Run yarn test:e2e'}</b><span class="grow"></span><button class="ext" aria-label="Open in Review #2481">${ic('ext')}</button></div><div class="cmd"><span class="ps">$</span>${o.cmd || 'yarn test:e2e'}</div>${o.done ? `<div class="out">${ic('check')}${o.done}</div>` : `<div class="a"><button class="btn primary sm">Yes</button><button class="vo-q">No</button><button class="vo-q">Stop</button></div>`}</div>${o.note === false ? '' : `<div class="vo-reqnote">${o.note || 'Read aloud · say yes or no, or tap'}</div>`}`;
const approval = (o = {}) => reqCard(o);
window.VPR = { reqCard };
function glance(k, o = {}) {
  const s = ST[k];
  const rows = (o.rows || ROWS[k] || ROWS.listening);
  const head = `<div class="ih"><span class="t">${o.title || 'Voice'}</span><span class="m">${s.time || ''}</span><span class="grow"></span>${o.sheet ? `<button class="hi-ib" aria-label="Collapse">${ic('chevD')}</button>` : `<button class="hi-ib cn-im" aria-label="Voice options: open the conversation, settings">${ic('more')}</button>`}</div><div class="k">${o.title ? (o.provider || 'OpenAI Realtime') : `${o.target || 'Global Voice'} ${SEP} ${o.provider || 'OpenAI Realtime'}`}</div>`;
  const stl = `<div class="vo-hero">${planet(o.sheet ? 64 : 44, { st: s.pl })}<div class="c"><div class="st"><b>${s.l}</b>${s.cell ? cell(s.cell, 'lg') : ''}</div><div class="cap">${s.cap}</div></div></div>`;
  const tx = s.ended || s.act ? '' : `<div class="vo-tx">${rows.map(([w, t, live]) => w === 'u' ? `<div class="u"><span class="who">You · </span>${t}</div>` : `<div class="a ${live && k === 'speaking' ? 'live' : ''}">${t}</div>`).join('')}${o.dl === false ? '' : dlRow()}</div>`;
  const need = k === 'needs' ? approval() : '';
  let ctl;
  if (k === 'ended') ctl = `<div class="vo-ctl"><button class="vo-cb">${ic('arrowR')}Open the conversation</button><span class="grow"></span><button class="vo-cb">${planet(14)}Start again</button></div>`;
  else if (s.act) ctl = `<div class="vo-ctl"><button class="vo-cb pri">${ic(s.act === 'Retry' ? 'vpRetry' : 'vpMic')}${s.act === 'Allow' ? 'Allow microphone' : s.act}</button>${s.act2 ? `<button class="vo-cb">${ic('gear')}${s.act2}</button>` : ''}<span class="grow"></span>${s.ended ? '' : `<button class="vo-cb end">${ic('vpEnd')}End</button>`}</div>`;
  else ctl = `<div class="vo-ctl"><button class="vo-cb ${s.muted ? 'on' : ''}" aria-pressed="${!!s.muted}">${ic(s.muted ? 'vpMicOff' : 'vpMic')}${s.muted ? 'Unmute' : 'Mute'}</button>${k === 'speaking' ? `<button class="vo-cb">${ic('vpHand')}Interrupt</button>` : ''}<span class="grow"></span><button class="vo-cb end">${ic('vpEnd')}End</button></div>`;
  return `<section class="cn-item vo-gl t-${s.tone}" aria-label="Voice, ${s.l}">${head}${stl}${need}${tx}${ctl}</section>`;
}

/* ═══ Companion (F1 Plain): the glance leads while live; the session's own items follow ═══ */
const PLAN = [['done', 'Find why the modal remounts'], ['done', 'Key the modal by route'], ['now', 'Add a resize test at 3 widths'], ['todo', 'Run the full UI suite']];
const planItem = () => `<section class="cn-item" aria-label="Plan"><div class="ih"><span class="t">Plan</span><span class="m">2 of 4</span><span class="grow"></span><button class="hi-ib cn-im" aria-label="Plan options">${ic('more')}</button></div><div class="k">Claude’s to-do list for this session</div><div class="cn-prog">${PLAN.map(([s]) => `<i class="${s === 'now' ? 'now run' : s}"></i>`).join('')}</div><ol class="cn-todo">${PLAN.map(([s, t]) => `<li class="${s}">${s === 'done' ? ic('check') : s === 'now' ? '<span class="z-work"></span>' : '<i></i>'}<span>${t}</span></li>`).join('')}</ol></section>`;
const companion = (items) => `<aside class="wt-comp cn-comp" aria-label="Companion"><div class="wt-comph"><b>Companion</b><span class="grow"></span><button class="hi-ib" aria-label="Companion options">${ic('more')}</button></div><div class="cn-col">${items.join('')}</div></aside>`;

/* ═══ composer with the planet left of Send and dictation in the field corner (spec §2.3) ═══ */
function comp(k, o = {}) {
  const s = k ? ST[k] : null;
  const tip = o.tip === 'voice' ? '<span class="vo-tip" role="tooltip">Talk with Voice <kbd>⌥⌘V</kbd></span>' : '';
  const pl = `<button class="vo-cpl" aria-label="${s ? 'End Voice' : (o.global ? 'Talk with Global Voice' : 'Talk with Voice')}" aria-keyshortcuts="Alt+Meta+V">${planet(26, { st: s ? s.pl : 'mic' })}${tip}</button>`;
  const ftip = o.tip === 'dictate' ? '<span class="vo-tip" role="tooltip">Dictate</span>' : '';
  return composer({ ph: o.ph || 'Message this session…', compact: true, machine: o.machine })
    .replace(`<button class="hi-ib" aria-label="Dictate">${ic('mic')}</button>`, pl)
    .replace('<div class="hi-comp ', `<div class="hi-comp vo-hc ${o.noChips ? 'vo-nochips' : ''} `)
    .replace(/(<div class="tx">)/, `<button class="vo-fmic ${o.tip === 'dictate' ? 'hov' : ''}" aria-label="Dictate">${ic('vpMic')}${ftip}</button>$1`);
}

/* ═══ shell frames ═══ */
const TABS = (on = 'fix') => [['fix', { active: on === 'fix' }], ['rev', { active: on === 'rev' }], ['relay', { active: on === 'relay' }], ['wf', { active: on === 'wf' }]];
const PILL_W = { rest: -10, preparing: 132, connecting: 140, listening: 190, hearing: 190, transcribing: 170, thinking: 160, speaking: 210, interrupted: 170, working: 190, needs: 190, muted: 150, blocked: 230, reconnecting: 210, failed: 210, ended: 120 };
function shell(state, o) {
  const tabsKey = o.tab || 'fix';
  const view = o.view;
  const pins = tabsKey === 'prs' ? [['prs', { active: true }], ['prj']] : [['prs'], ['prj']];
  let html = WS.wsApp(state, { root: { g: WS.G(TABS(tabsKey), view, { focused: true, pins }) }, stripOver: o.pill || '', over: o.over || '', colHtml: o.colHtml });
  if (o.pill) { // the tab segment yields the pill's width (the rail keeps one row; tabs overflow into “+N” first)
    const pw = (PILL_W[o.pillKey] || 200) + 46;
    html = html.replace(/(class="ws-seg"[^>]*style="left:\d+px;width:)(\d+)px/, (m0, a, w) => `${a}${Number(w) - pw}px`);
  }
  return html;
}
function sessionView(d, o = {}) {
  const tx = o.tx || TX();
  const mid = o.companion ? `<div class="wt-mrow">${tx}${o.companion}</div>` : tx;
  return `<div class="ss"><div class="ss-main hi-sm">${WS.hd(d)}${mid}${o.comp || comp(null)}</div>${actionRail(o.active, { git: 4 })}</div>`;
}
const TX_FIX = () => `<div class="ss-tx"><div class="col">
  <div class="hi-ub">The settings modal flickers when the window resizes. Find out why and fix it.</div>
  <div>It remounts because <code class="mono">SettingsModal</code>’s key includes the window width, so every resize throws its state away. I’ll key it by route instead and add a test.</div>
  <div class="hi-tool">${ic('hiCheckC', 'ok')}Edited ${B('SettingsModal.tsx')} <span style="color:var(--text3)">+4 −2</span></div>
  <div class="hi-tool"><span class="z-work" style="width:11px;height:11px"></span>Writing ${B('SettingsModal.test.tsx')}</div></div></div>`;

/* P1 · lead: pill + Companion glance */
function P1(state, k = 'speaking') {
  const view = sessionView(D.fix, { tx: TX_FIX(), companion: companion([glance(k), planItem()]) });
  return shell(state, { view, pill: pill(k, { open: true }), pillKey: k });
}
/* NY · needs you */
function NY(state) {
  const view = sessionView(D.fix, { tx: TX_FIX(), companion: companion([glance('needs', { title: 'Talking to Review #2481' }), planItem()]) });
  return shell(state, { view, pill: pill('needs', { open: true }), pillKey: 'needs' });
}
/* B · Companion-first: no pill; the glance is the only presence, a planet mark rides the Companion's rail button */
/* C · pill + popover only (also lead A's host on views without a Companion) */
function Cv(state) {
  const prs = `<div class="ws-pg"><header class="ws-ph"><span class="ws-pmk">${ic('gitpr')}</span><div><h1>PRs &amp; Issues</h1><p>happier-dev/happier · 3 need review</p></div></header><div class="ws-rows">${[['#2481', 'Fix settings modal remount', 'Review requested · 2 checks failing', 'warn'], ['#2479', 'Codex rollout identity matching', 'Approved · ready to merge', 'ok'], ['#2476', 'Mail readiness requires a link target', 'Draft', 'off'], ['#912', 'Sidebar margins feel inconsistent', 'Issue · design', 'off'], ['#907', 'Home popover shows raw host', 'Issue · bug', 'off']].map(([n, t, s, dot]) => `<div class="ws-r"><span class="g">${ic('gitpr')}</span><div class="c"><div class="t"><span style="color:var(--text3);font-variant-numeric:tabular-nums;margin-right:6px">${n}</span>${t}</div><div class="s"><span class="dot ${dot}" style="width:6px;height:6px"></span>${s}</div></div></div>`).join('')}</div></div>`;
  return shell(state, { view: `<div style="flex:1;min-width:0;display:flex">${prs}</div>`, tab: 'prs', pill: pill('speaking', { open: true }), pillKey: 'speaking', over: `<div class="vo-pop" role="dialog" aria-label="Voice">${glance('speaking')}</div>` });
}
/* O · the opt-in orb (replaces the pill when chosen; one presence at a time) */
function Ov(state) {
  const prs = `<div class="ws-pg"><header class="ws-ph"><span class="ws-pmk">${ic('gitpr')}</span><div><h1>PRs &amp; Issues</h1><p>happier-dev/happier · 3 need review</p></div></header><div class="ws-rows">${[['#2481', 'Fix settings modal remount', 'Review requested · 2 checks failing', 'warn'], ['#2479', 'Codex rollout identity matching', 'Approved · ready to merge', 'ok'], ['#2476', 'Mail readiness requires a link target', 'Draft', 'off']].map(([n, t, s, dot]) => `<div class="ws-r"><span class="g">${ic('gitpr')}</span><div class="c"><div class="t"><span style="color:var(--text3);font-variant-numeric:tabular-nums;margin-right:6px">${n}</span>${t}</div><div class="s"><span class="dot ${dot}" style="width:6px;height:6px"></span>${s}</div></div></div>`).join('')}</div></div>`;
  const orb = orbEl('speaking', { style: 'right:22px;bottom:22px' });
  return shell(state, { view: `<div style="flex:1;min-width:0;display:flex">${prs}</div>`, tab: 'prs', over: orb });
}
/* TX · voice turns are ordinary session messages with a voice marker */
function TXv(state) {
  const mk = (t, r) => `<div class="vo-mk ${r ? 'r' : ''}">${planet(11)}${t}</div>`;
  const tx = `<div class="ss-tx"><div class="col">
    <div class="hi-ub">Where are we on the relay retry?</div>${mk('Spoken · 10:41', true)}
    <div>Codex finished the backoff and two of five relay tests pass. It’s running the rest now.</div>${mk('Spoken aloud')}
    <div class="vo-tcard">${BRAND.codex(16)}<div class="c"><b>Asked Codex in Relay retry with backoff</b><span>“Run the relay tests again and tell me what fails.”</span></div><span class="s">${cell('working')}Working</span></div>
    <div class="hi-ub">Run the end-to-end suite on the review too.</div>${mk('Spoken · 10:43', true)}
    <div>Claude wants to run <code class="mono">yarn test:e2e</code> on Studio for Review #2481. Approve it with a tap.</div>${mk('Spoken aloud')}
    <div class="vo-tcard">${BRAND.claude(16)}<div class="c"><b>Review #2481 needs you</b><span>Run yarn test:e2e · Studio · about 4 min</span></div><span class="s">${cell('attn')}Needs you</span>${h.btn('Open', 'secondary', '', 'sm')}</div>
    <div class="hi-ub">Thanks — that’s all for now.</div>${mk('Spoken · 10:44', true)}
    <div class="hi-tool" style="color:var(--text3)">${planet(13, { st: 'ended' })}Voice ended · 4:12</div></div></div>`;
  const vd = { t: 'Voice conversation', mk: () => planet(14), where: 'Global Voice · MacBook Pro', machine: 'MacBook Pro' };
  const view = `<div class="ss"><div class="ss-main hi-sm">${WS.hd(vd).replace(/<span class="d">.*?<\/span><span class="d">.*?<\/span>/, `<span class="d">Global Voice</span><span class="d">OpenAI Realtime</span>`)}${tx}${comp(null, { ph: 'Type to Voice…', global: true, noChips: true })}</div>${actionRail(null, {})}</div>`;
  let html = WS.wsApp(state, { root: { g: WS.G([['fix'], ['rev'], ['relay'], ['wf']], view, { focused: true, pins: [['prs'], ['prj']] }) } });
  // the voice conversation is an ordinary tab: give it the active slot
  return html.replace(/(<div class="ws-seg"[^>]*>)/, `$1<span class="ws-tab up" role="tab" aria-selected="true" aria-label="Voice conversation"><span class="ld">${planet(14)}</span><span class="t">Voice conversation</span><span class="tr">${ic('x')}</span></span>`);
}

/* ═══ phone frames ═══ */
const P_TX = () => `<div class="wt-ph390"><div class="ss-tx"><div class="col">
  <div class="hi-ub">The settings modal flickers when the window resizes. Find out why and fix it.</div>
  <div>It remounts because <code class="mono">SettingsModal</code>’s key includes the window width, so every resize throws its state away. I’ll key it by route instead and add a test.</div>
  <div class="hi-tool">${ic('hiCheckC', 'ok')}Edited ${B('SettingsModal.tsx')} <span style="color:var(--text3)">+4 −2</span></div>
  <div class="hi-tool"><span class="z-work" style="width:11px;height:11px"></span>Writing ${B('SettingsModal.test.tsx')}</div></div></div></div>`;
const pcomp = (k, o = {}) => `<div class="vo-pcomp"><div class="fld"><span class="tx">Message Claude…</span><button class="fmic" aria-label="Dictate">${ic('vpMic')}</button></div><span class="vo-cpl" aria-label="${k ? 'End Voice' : 'Talk with Voice'}">${planet(28, { st: k ? ST[k].pl : (o.st || 'mic'), p: o.p })}</span><span class="send">${ic('send')}</span></div>`;
const pwrap = (inner, cls = '') => `<div class="vo-ph ${cls}" style="position:absolute;inset:0">${inner}</div>`;
function phoneLive(k, o = {}) {
  const over = `${pcomp(k)}${o.pill === false ? '' : ppill(k, { top: o.top })}${o.sheet || ''}`;
  return pwrap(phoneSession({ title: 'Fix settings modal remount', body: P_TX(), on: 'chat', over }), `${o.pill === false ? '' : (o.top ? 'island' : 'haspill')}`);
}
const sheet = (k, o = {}) => `<div class="vo-sheet" role="dialog" aria-label="Voice"><div class="grab"></div>${glance(k, { sheet: true, ...o })}</div>`;
function P1p() { return phoneLive('speaking'); }
function P1s() { return phoneLive('speaking', { pill: false, sheet: sheet('speaking') }); }
function NYp() { return phoneLive('needs', { pill: false, sheet: sheet('needs', { title: 'Talking to Review #2481' }) }); }
function Op() {
  const orb = orbEl('speaking', { style: 'right:14px;bottom:146px' });
  return pwrap(phoneSession({ title: 'Fix settings modal remount', body: P_TX(), on: 'chat', over: `${pcomp('speaking')}${orb}` }));
}
function TXp() {
  const mk = (t, r) => `<div class="vo-mk ${r ? 'r' : ''}">${planet(11)}${t}</div>`;
  const body = `<div class="wt-ph390"><div class="ss-tx"><div class="col">
    <div class="hi-ub">Where are we on the relay retry?</div>${mk('Spoken · 10:41', true)}
    <div>Codex finished the backoff and two of five relay tests pass. It’s running the rest now.</div>${mk('Spoken aloud')}
    <div class="vo-tcard">${BRAND.codex(16)}<div class="c"><b>Asked Codex in Relay retry</b><span>“Run the relay tests again…”</span></div><span class="s">${cell('working')}Working</span></div>
    <div class="hi-ub">Run the end-to-end suite on the review too.</div>${mk('Spoken · 10:43', true)}
    <div class="vo-tcard">${BRAND.claude(16)}<div class="c"><b>Review #2481 needs you</b><span>Run yarn test:e2e · Studio</span></div><span class="s">${cell('attn')}Needs you</span></div></div></div></div>`;
  const nav = `<div class="ss-pnav"><span class="bk">${ic('back')}</span><span class="ag">${planet(18)}</span><div class="tt"><b>Voice conversation</b><span>Global Voice · OpenAI Realtime</span></div><button class="z-ib" aria-label="Actions">${ic('more')}</button></div>`;
  return pwrap(phoneSession({ nav, body, on: 'chat', over: `<div class="vo-pcomp"><div class="fld"><span class="tx">Type to Voice…</span></div><span class="vo-cpl">${planet(28, { st: 'mic' })}</span><span class="send">${ic('send')}</span></div>` }));
}
function STp() {
  const caps = { connecting: 'Opening the audio channel to OpenAI', speaking: '“…two of five relay tests pass.”', working: 'Codex is running yarn test relay', needs: 'Claude wants to run yarn test:e2e', muted: 'Unmute to talk · Voice can still speak', blocked: 'Allow access in System Settings', reconnecting: 'Lost the connection · trying again', failed: 'OpenAI Realtime isn’t set up here', ended: '4:12 · the conversation is saved' };
  const rows = ['connecting', 'speaking', 'working', 'needs', 'muted', 'blocked', 'reconnecting', 'failed', 'ended'].map((k) => `<div class="r"><span class="n">${ST[k].l.replace('…', '')} <span class="vo-basis ${ST[k].basis}">${ST[k].basis}</span></span>${islandEl(k, { cls: 'ph inl', cap: caps[k] })}</div>`).join('');
  return `<div class="z-ph hi-ph" style="overflow:hidden"><div class="ss-pt" style="padding-top:10px;font-size:22px">Island · 390</div><div class="vo-pstack">${rows}</div></div>`;
}
function LA(state) {
  const isl = `<div class="vo-isl" aria-label="Voice, Speaking, 4:12">${planet(22, { st: 'ready' })}<span class="t">4:12</span></div>`;
  const card = `<div class="vo-la" role="group" aria-label="Happier Voice Live Activity"><div class="h">${planet(34, { st: 'ready' })}<div><b>Speaking</b><div class="m">Global Voice · 4:12</div></div><span class="grow"></span></div><div class="ln">“Codex finished the backoff and two of five relay tests pass…”</div><div class="need"><span class="nd"></span><span>Review #2481 needs you · tap to approve in Happier</span></div><div class="a"><span>${ic('vpMic')}Mute</span><span class="end">${ic('vpEnd')}End</span></div></div>`;
  return `<div class="vo-lock">${isl}<div class="dt">Friday 2 October</div><div class="tm" style="margin-top:4px">10:44</div>${card}</div>`;
}
function LAa() {
  // PLAN §4.7 (Android in scope): the existing voice foreground-service notification, content only. Shipped strings
  // (packages/audio-stream-native res/values/strings.xml, 23c2940acd): title = the app label, text "Voice is using the
  // microphone. Tap to open Happier.", channel "Voice conversation". Ongoing while the call holds the microphone; tap
  // opens Happier. No Mute/End actions, no transcript, no elapsed time (a separate approved native vertical would add them).
  const nt = `<div class="nt" role="group" aria-label="Happier: Voice is using the microphone"><div class="ap">${ic('mic')}<b>Happier</b> · Voice conversation</div><div class="t">Happier</div><div class="x">Voice is using the microphone. Tap to open Happier.</div></div>`;
  // approvals keep their own existing attention notification, unchanged by Voice: it opens the request in Happier
  const nt2 = `<div class="nt dim"><div class="ap">${BRAND.claude(14)}<b>Happier</b> · Review #2481 · now</div><div class="t">Needs you</div><div class="x">Claude wants to run yarn test:e2e on Studio</div></div>`;
  return `<div class="vo-and"><div class="qs"><i class="on"></i><i></i><i class="on"></i><i></i></div>${nt}${nt2}</div>`;
}

/* ═══ states board (desktop) ═══ */
const GRAMMAR = {"preparing": "Shadow · crescent, still", "connecting": "Shadow · crescent, still → dawn once on connect", "listening": "Atmosphere · follows the mic level (still in silence)", "hearing": "Atmosphere · your voice, violet", "transcribing": "Light, still · think cell", "thinking": "Light, still · think cell", "speaking": "Atmosphere · the assistant’s level, warm", "interrupted": "Atmosphere collapses to yours (Event)", "working": "Atmosphere (listening) · working cell", "needs": "Atmosphere (listening) · needs-you cell", "muted": "Light, no atmosphere · mute pip", "blocked": "Partial shade, rose", "reconnecting": "Shadow · eclipse; dawn once when back", "failed": "Partial shade, rose", "ended": "Atmosphere eases out, still, then leaves"};
function stBoard() {
  const rows = ORDER.map((k) => {
    const s = ST[k];
    const nm = k === 'hearing' ? 'You’re speaking' : s.l.replace('…', '');
    const gl = `<div class="vo-gl t-${s.tone}" style="padding:0"><div class="vo-hero">${planet(36, { st: s.pl })}<div class="c"><div class="st"><b>${s.l}</b>${s.cell ? cell(s.cell, 'lg') : ''}</div><div class="cap">${s.cap}</div>${s.act ? `<div class="vo-ctl" style="margin-top:8px"><button class="vo-cb pri">${ic(s.act === 'Retry' ? 'vpRetry' : 'vpMic')}${s.act === 'Allow' ? 'Allow microphone' : s.act}</button>${s.act2 ? `<button class="vo-cb">${s.act2}</button>` : ''}</div>` : ''}</div></div></div>`;
    return `<tr><td class="nm"><b>${nm}</b><span class="vo-basis ${s.basis}">${s.basis}</span>${s.src ? `<span style="display:block;margin-top:4px">${s.src}</span>` : ''}${s.note ? `<span style="display:block;margin-top:4px;color:var(--text2)">${s.note}</span>` : ''}</td><td class="an" style="color:var(--text)">${GRAMMAR[k]}</td><td>${pill(k, { inl: true })}</td><td class="gl">${gl}</td><td><span class="vo-cpl" style="display:inline-grid">${planet(26, { st: s.pl })}</span></td><td class="an">${s.say}</td></tr>`;
  }).join('');
  return `<div class="vo-board"><h1>Every state, one planet grammar</h1><p class="lede">The pill, the glance and the composer planet read one projection (<code>resolveVoiceSurfaceStatusPresentation</code> + <code>VoiceAttemptControlProjection</code>), so they never disagree; the words are the shared session presenter’s. The planet is the Daybreak dot planet and speaks its grammar: <b>light</b> = ready, <b>atmosphere</b> = the real audio level (yours or the assistant’s — this replaces the timer breath of spec §2.4a, so silence is still), <b>shadow</b> = waiting on something outside, <b>dawn</b> = one Event when the connection lands, the <b>2×4 dot cell</b> = thinking / working / needs you. Basis: <span class="vo-basis model">model</span> exists today · <span class="vo-basis derivable">derivable</span> the signal exists, the projection is missing.</p>
  <table class="vo-tbl"><thead><tr><th style="width:220px">State</th><th style="width:190px">Planet grammar</th><th style="width:250px">Top-rail pill</th><th>Glance status</th><th style="width:50px">Composer</th><th style="width:210px">Announced once</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/* ═══ ROUND 2 · one presence model, shared primitives, three containers ═══
   Model: VoiceAttemptControlProjection (state, time, target, canMute, canEnd, captions). Primitives: Mark (waveform ↔
   planet), Status line (word · dot cell · time), Transport (Mute · End, always separate), Compact transcript (last line).
   Containers: anchored pill (+ popover) · floating island · floating orb. The Companion section is not a container: it
   stays in every mode. */
const PRIM = {
  mark: (k, sz = 24) => planet(sz, { st: k === 'rest' ? 'mic' : ST[k].pl }),
  status: (k, o = {}) => k === 'rest' ? `<span class="vo-sl"><b>Voice</b><span class="tm">${o.rest || 'Tap to talk'}</span></span>` : `<span class="vo-sl t-${ST[k].tone}"><b>${ST[k].l}</b>${ST[k].cell ? cell(ST[k].cell) : ''}${ST[k].time ? `<span class="tm">${ST[k].time}</span>` : ''}</span>`,
  transport: (k, o = {}) => ST[k].act ? `<span class="vo-tp"><button class="tb">${ST[k].act}</button><button class="ib" aria-label="End Voice">${ic('vpEnd')}</button></span>` : `<span class="vo-tp ${o.lg ? 'lg' : ''}"><button class="ib ${ST[k].muted ? 'on' : ''}" aria-label="${ST[k].muted ? 'Unmute' : 'Mute'}">${ic(ST[k].muted ? 'vpMicOff' : 'vpMic')}</button><button class="ib end" aria-label="End Voice">${ic('vpEnd')}</button></span>`,
  caption: (t = '“…two of five relay tests pass. It’s running the rest now.”') => `<span class="vo-cap1">${t}</span>`,
};
// Floating island: mark · status · one caption line · transport. Draggable (data-island), same physics as the orb.
const islandEl = (k, o = {}) => `<div class="vo-isl2 ${o.lift ? 'lift' : ''} ${o.tuck ? 'tuck' : ''} ${o.cls || ''}" data-island role="group" aria-label="Voice, ${ST[k].l}. Drag to move" style="${o.style || ''}"><button class="mk" aria-label="${k === 'rest' ? 'Talk with Voice' : 'End Voice'}">${PRIM.mark(k, o.tuck ? 30 : 26)}</button>${o.tuck ? '' : `<div class="c">${PRIM.status(k)}${PRIM.caption(o.cap)}</div>${PRIM.transport(k)}`}</div>`;
const orbEl = (k, o = {}) => `<div class="vo-orb" style="${o.style || ''}" role="group" aria-label="Voice${k === 'rest' ? '' : `, ${ST[k].l}`}">${o.cap === false || k === 'rest' ? '' : `<span class="cap">${ST[k].l} <span class="tm">${ST[k].time || ''}</span></span>`}<button class="body" aria-label="${k === 'rest' ? 'Talk with Voice' : 'Voice. Tap to end, drag to move'}">${PRIM.mark(k, 30)}</button></div>`;
const railMic = (o = {}) => `<div class="vo-railmic" style="${o.style || ''}"><button class="b" aria-label="Talk with Voice" aria-keyshortcuts="Alt+Meta+V">${planet(20, { st: o.st || 'mic', p: o.p })}</button>${o.tip ? '<span class="vo-tip dn" role="tooltip">Talk with Voice <kbd>⌥⌘V</kbd></span>' : ''}</div>`;

/* the island's drag physics (lab prototype): momentum projection d = 0.998 (0.499 s), critically damped spring
   (response 0.4 s, damping 1), two independent axes, release velocity handed to the spring, snap to the nearest anchor */
function mountIsland(root, anchorsFor) {
  root.querySelectorAll('[data-island]').forEach((el) => {
    const host = el.offsetParent; if (!host) return;
    let drag = null, anim = 0;
    const place = (x, y) => { el.style.left = `${x}px`; el.style.top = `${y}px`; el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.transform = 'none'; };
    el.addEventListener('pointerdown', (e) => { if (e.target.closest('.ib,.tb')) return; cancelAnimationFrame(anim); const r = el.getBoundingClientRect(), hr = host.getBoundingClientRect(); const z = r.width / el.offsetWidth || 1; drag = { z, ox: (e.clientX - r.left) / z, oy: (e.clientY - r.top) / z, hx: hr.left, hy: hr.top, pts: [] }; el.setPointerCapture(e.pointerId); el.classList.add('lift'); });
    el.addEventListener('pointermove', (e) => { if (!drag) return; const x = (e.clientX - drag.hx) / drag.z - drag.ox, y = (e.clientY - drag.hy) / drag.z - drag.oy; place(x, y); drag.pts.push([performance.now(), x, y]); if (drag.pts.length > 6) drag.pts.shift(); });
    el.addEventListener('pointerup', () => {
      if (!drag) return; el.classList.remove('lift'); const p = drag.pts; drag = null; if (p.length < 2) return;
      const [t0, x0, y0] = p[0], [t1, x1, y1] = p[p.length - 1]; const dt = Math.max(0.016, (t1 - t0) / 1000);
      const vx = (x1 - x0) / dt, vy = (y1 - y0) / dt;
      const px = x1 + vx * 0.499, py = y1 + vy * 0.499; // where the throw was going
      const A = anchorsFor(host, el); let best = A[0], bd = Infinity; A.forEach((a) => { const d = Math.hypot(a.x - px, a.y - py); if (d < bd) { bd = d; best = a; } });
      el.classList.toggle('tuck', !!best.tuck);
      const w = 2 * Math.PI / 0.4, start = performance.now(), ax = [x1 - best.x, vx], ay = [y1 - best.y, vy];
      const step = () => { const t = (performance.now() - start) / 1000; const f = (a) => (a[0] + (a[1] + w * a[0]) * t) * Math.exp(-w * t); place(best.x + f(ax), best.y + f(ay)); if (t < 1.2) anim = requestAnimationFrame(step); else place(best.x, best.y); };
      step();
    });
  });
}
const deskAnchors = (host, el) => { const W = host.clientWidth, H = host.clientHeight, w = el.offsetWidth, h = el.offsetHeight, m = 16, low = H - h - 120; const hi = 80; return [[m, hi], [(W - w) / 2, hi], [W - w - m, hi], [m, low], [(W - w) / 2, low], [W - w - m, low]].map(([x, y]) => ({ x, y })); }; // inside the main area, bottom row clears the composer
const phoneAnchors = (host, el) => { const W = host.clientWidth, H = host.clientHeight, w = el.offsetWidth, h = el.offsetHeight; return [{ x: (W - w) / 2, y: H - 84 - h - 52 }, { x: (W - w) / 2, y: 54 }, { x: -w + 46, y: H * 0.42, tuck: true }, { x: W - 46, y: H * 0.42, tuck: true }]; };

/* M · the mark: rest mic ↔ live planet, size ladder, Voice vs Dictation, interaction */
function markBoard() {
  const sizes = [16, 20, 24, 32, 48];
  const rows = sizes.map((sz) => { const T = window.VP.tier(sz); return `<tr><td class="nm"><b>${sz} pt</b><span>glyph ${T.glyph} pt · planet pitch ${T.pitch.toFixed(1)}</span></td>${[['mic'], ['morph', 0.35], ['morph', 0.7], ['listening'], ['speaking'], ['muted'], ['shade']].map(([st, p]) => `<td class="mk"><span class="vo-mkcell" style="width:${Math.max(sz * 1.7, 40)}px;height:${Math.max(sz * 1.7, 40)}px">${planet(sz, { st, p })}</span></td>`).join('')}</tr>`; }).join('');
  const dictV = `<div class="vo-cmp"><div class="lb">Voice — the line waveform, composer icon tint, before Send</div>${comp(null, { tip: 'voice' })}</div>`;
  const dictD = `<div class="vo-cmp"><div class="lb">Dictation — plain line mic, inside the field, top-right</div>${comp(null, { tip: 'dictate' })}</div>`;
  const step = (st, p, t, d) => `<div class="vo-step"><span class="vo-mkcell" style="width:76px;height:76px">${planet(44, { st, p })}</span><b>${t}</b><span>${d}</span></div>`;
  return `<div class="vo-board"><h1>The mark: a waveform at rest, the planet when live</h1><p class="lede">At rest the control is the app’s line <b>waveform</b> glyph, in the same tint as the composer’s other icons (owner amendment VE-02, 2026-10-10: the coloured dot microphone was too bulky at icon size; shipped in <code>VoiceMark.tsx</code>). Tap it and the glyph hands over to dots that stream out of its bars onto the planet (one-shot, ≈0.55 s); while live the planet’s atmosphere follows the real audio; End regathers it into the glyph. Reduced motion switches instantly. The five size tiers stay; below ~24 pt the planet uses fewer, larger dots.</p>
  <table class="vo-tbl vo-ladder"><thead><tr><th style="width:190px">Size</th><th>Rest · waveform</th><th>Tap · 35 %</th><th>Tap · 70 %</th><th>Live · listening</th><th>Live · speaking</th><th>Muted</th><th>Failed</th></tr></thead><tbody>${rows}</tbody></table>
  <h2 class="vo-h2">Voice is not Dictation</h2><div class="vo-cmps">${dictV}${dictD}</div>
  <h2 class="vo-h2">One gesture everywhere: composer button, top-bar mark, island, orb, and ⌥⌘V (rebindable)</h2><div class="vo-steps">${step('mic', null, 'Tap or ⌥⌘V', 'Voice starts: the waveform hands over to the planet’s dots.')}${step('morph', 0.6, '…0.55 s', 'One-shot, then the atmosphere takes over.')}${step('regather', 0.5, 'Tap again or ⌥⌘V', 'Voice ends: the planet regathers into the waveform.')}${step('hearing', null, 'Hold (opt-in)', 'Only with Hold to talk on and a service that supports it: one turn while held, release to send.')}${step('muted', null, 'Mute', 'Always its own button. Muting never ends; End never mutes.')}</div></div>`;
}

/* K · primitives → containers → setting */
function kitBoard() {
  const k = 'speaking';
  const prim = (t, d, body) => `<div class="vo-prim"><div class="pv">${body}</div><b>${t}</b><span>${d}</span></div>`;
  const prims = `${prim('Mark', 'Waveform at rest, planet when live. Every size tier.', `${PRIM.mark('rest', 32)}<span style="width:16px"></span>${PRIM.mark(k, 32)}`)}${prim('Status line', 'The shared presenter word · dot cell · elapsed time.', PRIM.status('working'))}${prim('Transport', 'Mute · End, always two buttons. Retry / Allow replace Mute when needed.', PRIM.transport(k))}${prim('Compact transcript', 'The last line said, either side. Full captions live in the glance.', PRIM.caption())}`;
  const win = (inner, lbl, on) => `<div class="vo-ctn ${on ? 'on' : ''}"><div class="mini">${inner}</div><b>${lbl}</b></div>`;
  const pillMini = `<div class="vo-mini-top"><span class="vo-tabsbar"></span>${pill(k)}</div><div class="vo-mini-pop">${glance(k, { dl: false })}</div>`;
  const islMini = `<div class="vo-mini-body"></div>${islandEl(k, { style: 'position:absolute;right:16px;bottom:16px' })}`;
  const orbMini = `<div class="vo-mini-body"></div>${orbEl(k, { style: 'right:16px;bottom:16px' })}`;
  const ctns = `<div class="vo-ctns">${win(pillMini, 'Top bar · anchored pill, opens a popover', true)}${win(islMini, 'Island · floating capsule, draggable')}${win(orbMini, 'Orb · floating mark, draggable')}</div>`;
  const tile = (lbl, inner, on) => `<button class="vo-tile ${on ? 'on' : ''}" role="radio" aria-checked="${on}"><span class="pv">${inner}</span><span class="t">${lbl}</span></button>`;
  const setting = (dev, on) => `<div class="vo-set"><div class="hd"><b>Show live Voice as</b><span>${dev} · this device only. The Companion’s Voice section stays in every mode.</span></div><div class="tiles">${tile('Top bar', `<span class="tb"></span>${PRIM.mark(k, 14)}`, on === 0)}${tile('Island', `<span class="isl">${PRIM.mark(k, 14)}<i></i></span>`, on === 1)}${tile('Orb', `<span class="orb">${PRIM.mark(k, 18)}</span>`, on === 2)}</div></div>`;
  return `<div class="vo-board"><h1>One presence model, three containers</h1><p class="lede">Every container is composed from the same four primitives over one projection (<code>VoiceAttemptControlProjection</code>), so a state renders identically in all of them and switching containers changes placement, never behaviour. Taps toggle (start / end), hold is the optional one-turn talk, Mute is always separate from End. The Companion’s Voice section is not a container: it shows in every mode.</p>
  <h2 class="vo-h2">Shared primitives</h2><div class="vo-prims">${prims}</div>
  <h2 class="vo-h2">Containers</h2>${ctns}
  <h2 class="vo-h2">The setting (Settings → Voice → Conversations)</h2><div class="vo-sets">${setting('Desktop default: Top bar', 0)}${setting('Phone default: Island, docked above the bar', 1)}</div></div>`;
}

/* rest in the shell: the top-rail mic and the composer, with tooltips */
function restDesk(state) {
  const view = sessionView(D.fix, { tx: TX_FIX(), comp: comp(null, { tip: 'voice' }) });
  return shell(state, { view, pill: railMic(), pillKey: 'rest' });
}
function restPhone() {
  return pwrap(phoneSession({ title: 'Fix settings modal remount', body: P_TX(), on: 'chat', over: `${pcomp(null)}` }));
}
/* the island: desktop floating, phone docked; lifted mid-drag frames show the snap anchors */
function Iv(state) {
  const view = sessionView(D.fix, { tx: TX_FIX(), companion: companion([glance('speaking'), planItem()]), comp: comp('speaking') });
  return shell(state, { view, over: `<div class="vo-float desk">${islandEl('speaking', { style: 'right:16px;bottom:120px' })}</div>` });
}
function Idv(state) {
  const view = sessionView(D.fix, { tx: TX_FIX(), comp: comp('speaking') });
  const anchors = [['16px', 'left', 'top'], ['', 'center', 'top'], ['16px', 'right', 'top'], ['16px', 'left', 'bottom'], ['', 'center', 'bottom'], ['16px', 'right', 'bottom']].map(([x, side, v]) => `<span class="vo-anc" style="${side === 'center' ? 'left:50%;transform:translateX(-50%)' : `${side}:${x}`};${v}:${v === 'top' ? '80px' : '120px'}"></span>`).join('');
  const throwLine = `<svg class="vo-throw" viewBox="0 0 1095 892" preserveAspectRatio="none"><path d="M545 358 L914 744" /><circle cx="914" cy="744" r="5"/></svg>`;
  return shell(state, { view, over: `<div class="vo-float desk">${anchors}${throwLine}${islandEl('speaking', { lift: true, style: 'left:380px;top:330px' })}<span class="vo-dragnote" style="left:700px;top:600px">projected landing → nearest anchor</span></div>` });
}
function Ip() { return pwrap(phoneSession({ title: 'Fix settings modal remount', body: P_TX(), on: 'chat', over: `${pcomp('speaking')}${islandEl('speaking', { cls: 'ph docked' })}` }), 'hasisl'); }
function Idp() { // composer stays at its resting place while the island is lifted

  const anc = `<span class="vo-anc ph" style="left:16px;right:16px;bottom:84px"></span><span class="vo-anc ph" style="left:16px;right:16px;top:54px"></span><span class="vo-anc ph tuck" style="left:-2px;top:44%"></span><span class="vo-anc ph tuck" style="right:-2px;top:44%"></span>`;
  return pwrap(phoneSession({ title: 'Fix settings modal remount', body: P_TX(), on: 'chat', over: `${pcomp('speaking')}${anc}${islandEl('speaking', { cls: 'ph', lift: true, style: 'left:16px;top:470px' })}${islandEl('speaking', { cls: 'ph', tuck: true, style: 'right:-2px;top:44%;opacity:.5' })}` }), 'hasisl');
}

/* ═══ notes ═══ */
const N_MARK = `<h3>M · A waveform at rest, the planet when live</h3><ul>
<li><b>Rest (VE-02, owner amendment 2026-10-10):</b> the app icon family’s line <b>waveform</b> glyph in the composer’s ordinary icon tint, sized max(16, 0.62 × the mark). Shipped: <code>VoiceMark.tsx</code> <code>VoiceMarkRestGlyph</code> (Phosphor Waveform, <code>button.secondary.tint</code>); same glyph in the composer, the top-bar rest mark, the island and the orb. Nothing moves at rest.</li>
<li><b>Tap:</b> the glyph hands over to dots that stream out of its bars onto the planet (one-shot ≈0.55 s). <b>Live:</b> the atmosphere follows the real audio. <b>End:</b> the planet regathers into the glyph. Reduced motion switches instantly.</li>
<li><b>Size tiers</b> (rows on the ladder): the five approved tiers stay; the planet uses 9 / 11 / 14 / 19 rows of dots so a 16 pt planet keeps large dots.</li>
<li><b>Voice vs Dictation:</b> Dictation is the monochrome line mic inside the text field (top-right), tooltip “Dictate”. Voice is the waveform in the action row before Send, tooltip “Talk with Voice ⌥⌘V” — the resolved shortcut label, so a rebinding in Settings → Keyboard shows here (<code>voice.toggle</code>, default Mod+Alt+V, <code>keyboard/commands.ts</code>).</li>
<li><b>One gesture:</b> tap = start, tap again = end, on the composer button, the top-bar mark, the island and orb marks, and the shortcut. Hold is opt-in (Voice → Advanced → How you talk → Hold to talk) and only where the service supports it; release sends one turn and never ends Voice or approves anything. Mute is always a separate button.</li>
<li>Lab: the morph is a 2D dot tween from the glyph’s bars at the planet’s pitch; production is <code>VoiceMark</code>’s morph.</li></ul>`;
const N_REST = `<h3>R · At rest</h3><ul><li>Desktop: the composer’s action row shows the line waveform before Send in the composer icon tint (hover: “Talk with Voice ⌥⌘V”, the resolved, rebindable shortcut); the field’s top-right keeps the line mic for Dictation. In <b>Top bar</b> mode the title strip also carries the same quiet waveform at its trailing end — tap it (or the shortcut) anywhere and it becomes the live pill in place (shipped <code>VoiceTopBarPresence.tsx</code> rest mark).</li><li>Phone: Dictation sits inside the field; the waveform sits outside it, before Send. No floating chrome at rest; the island appears only while Voice is live.</li><li>Nothing animates at rest (zero frames). VE-02 amendment 2026-10-10 replaced the earlier dot microphone.</li></ul>`;
const N_KIT = `<h3>K · One model, shared primitives, three containers</h3><ul><li>Primitives: <b>Mark</b> (waveform ↔ planet), <b>Status line</b> (word · dot cell · time), <b>Transport</b> (Mute · End), <b>Compact transcript</b> (last line). Each container composes them over <code>VoiceAttemptControlProjection</code>; none owns state.</li><li><b>Top bar</b>: anchored pill; its label opens the popover (the Companion section component); its mark toggles.</li><li><b>Island</b>: floating capsule (mark · status · caption · transport), draggable with the orb’s physics; tap opens the popover / sheet.</li><li><b>Orb</b>: the mark alone, draggable; a short caption on state changes; tap toggles, long-press or click-and-hold-still opens the popover / sheet.</li><li><b>Setting</b> (device-local): “Show live Voice as: Top bar · Island · Orb” as visual tiles; defaults desktop Top bar, phone Island docked above the bar. Replaces today’s <code>voiceOrbEnabled</code> boolean. The Companion’s Voice section shows in every mode.</li></ul>`;
const N_LEAD = `<h3>A · Top bar (desktop default)</h3><ul><li>The rest waveform at the right end of the top rail grew into the live pill: dot planet (its atmosphere is the meter), state word (+ dot cell when thinking / working / needs you), time, Mute, End. The tab strip yields its width.</li><li>The pill’s <b>mark</b> toggles (tap = end, dots regather into the waveform). Its <b>label</b> opens the popover (C).</li><li>The <b>Companion’s Voice section</b> leads the Companion of whatever session you are beside, in every mode: 44 pt planet, status, captions, the handoff with its live dot cell, Mute · Interrupt · End.</li><li>Composer: the waveform is now the live planet (tap again = end).</li></ul>`;
const N_POP = `<h3>Top bar · popover</h3><p>On a view without a Companion (PRs &amp; Issues here) the pill’s label opens the same section as a popover anchored under the pill. The island and the orb open the same popover anchored to themselves.</p>`;
const N_ISL = `<h3>I · Island (desktop, opt-in)</h3><ul><li>A floating capsule: mark · status · the last line said · Mute · End. It sits over the work (bottom-right here) and keeps the Companion section beside your chat.</li><li><b>Draggable</b> with the orb’s physics: 1:1 with the pointer (+6 % lift), momentum projection (d = 0.998 → 0.499 s), a critically damped spring (response 0.4 s, damping 1), two independent axes, release velocity handed to the spring. Snaps to six anchors (top/bottom × left/centre/right).</li><li>Tap the mark = end; tap the rest = popover.</li></ul>`;
const N_ISLP = `<h3>I · 390: Island (phone default)</h3><ul><li>Docked above the bar, the composer lifts by its height. Same capsule as desktop at touch size; Mute and End are 34 pt in 44 pt targets.</li><li><b>Live prototype in this frame:</b> drag it (pointer) — it projects your throw and springs to an anchor: above the bar, under the status bar, or tucked to either edge (it shrinks to its mark, like picture-in-picture; tap the mark to bring it back).</li><li>Hidden during the drag-up switcher (the switcher owns that space) and with the keyboard up (the composer mark still shows the state).</li></ul>`;
const N_DRAG = `<h3>Island · mid-drag</h3><ul><li>Lifted 6 % with a deeper shadow while it follows the finger/pointer 1:1. The dashed line is the momentum projection of the throw; it lands on the anchor nearest the projected point, not the release point.</li><li>Anchors: desktop six (top/bottom × left/centre/right, inside the window below the top rail); phone four (above the bar, under the status bar, tucked left, tucked right). The faint outlines appear only while dragging.</li><li>No bounce: critically damped, so it settles without overshoot but leaves the hand at the speed it was thrown.</li></ul>`;
const N_ORB = `<h3>O · Orb (opt-in)</h3><ul><li>The mark alone, 30 pt: waveform at rest, planet when live, no rings, no bars, no sheet, no floor. Tap toggles; a short caption appears beside it on state changes (3 s; Needs you and errors persist).</li><li>Drag: the island’s physics (same code), snapping to the screen edges.</li><li>Open the conversation: long-press (phone) or the caption (desktop) → the same popover / sheet.</li><li>Unlike Top bar and Island, the orb stays at rest (as the mic) — it is the always-there entry point for people who choose it. Off: renders nothing (§2.2).</li></ul>`;

S['voice-presence'] = {
  title: 'Voice · Presence', subtitle: 'Round 2 (rest glyph updated to the VE-02 waveform, 2026-11-07): the waveform at rest, one presence model, three containers (top bar, island, orb), the Companion section, lock screen',
  def: 'M',
  variants: {
    M: { label: 'Mark', board: true, html: markBoard, notes: N_MARK },
    R: { label: 'Rest', html: restDesk, notes: N_REST },
    Rp: { label: 'Rest · 390', phone: true, html: restPhone, notes: N_REST },
    K: { label: 'Primitives', board: true, html: kitBoard, notes: N_KIT },
    A: { label: 'Top bar', html: (st) => P1(st), notes: N_LEAD },
    C: { label: 'Top bar · popover', html: Cv, notes: N_POP },
    I: { label: 'Island', html: Iv, mount: (r) => mountIsland(r, deskAnchors), notes: N_ISL },
    Ip: { label: 'Island · 390', phone: true, html: Ip, mount: (r) => mountIsland(r, phoneAnchors), notes: N_ISLP },
    Id: { label: 'Island · drag', html: Idv, notes: N_DRAG },
    Idp: { label: 'Island · drag 390', phone: true, html: Idp, notes: N_DRAG },
    As: { label: 'Sheet · 390', phone: true, html: P1s, notes: `<h3>Tap the island → the sheet</h3><ul><li>The island grows into the sheet in place; same glance (Companion section component), 64 pt hero, full-width 44 pt controls. <b>No scrim</b>: the transcript above stays live.</li><li>End stays reachable at every text size (§2.7). “Relay retry with backoff · Working” opens that session.</li></ul>` },
    O: { label: 'Orb', html: Ov, notes: N_ORB },
    Op: { label: 'Orb · 390', phone: true, html: Op, notes: N_ORB },
    ST: { label: 'States', board: true, html: stBoard, notes: `<h3>States</h3><ul><li>Every row is the same projection rendered by the shared primitives. Copy changes from today: “Connection Error” → “Couldn’t connect”, “Microphone access required” → “Microphone blocked”.</li><li><b>Working</b> / <b>Needs you</b> describe the session Voice handed work to (dot cell), while the planet’s atmosphere still says “listening”.</li><li>§2.4a reconciled: the atmosphere follows the real mic level, so silence is still — no timer breath.</li><li><b>Needs you</b> (VI-04, amended 2026-10-25): Voice reads the request out and asks; by default you can answer aloud and the Voice agent decides it for you through the session’s own approval, or tap the card. With “Voice agent can approve requests” off (Voice → Conversations → During a conversation; shipped c17e473fdc) approvals stay tap-only and Voice says so. The caption is “Waiting for your decision” (shipped 08c7b40e96).</li><li><b>Voice ended</b>: the planet regathers into the waveform (Event); a pending request stays reachable in the Companion, Inbox and session.</li></ul>` },
    STp: { label: 'States · 390', phone: true, html: STp, notes: `<h3>The island in every state</h3><p>Status line + one caption line + transport. The longest (“Microphone blocked” + Allow + End) fits at 390 at default text size; at large Dynamic Type the caption drops first, never the action.</p>` },
    NY: { label: 'Needs you', html: NY, notes: `<h3>Needs you: read aloud, answered aloud or with a tap</h3><ul><li>Voice reads who, what and where once and asks; the pill turns amber with the needs-you dot cell (not colour alone); the hero caption is “Waiting for your decision”.</li><li>The glance carries the session’s own permission card (Yes · No · Stop, neutral fill) — the same component the session shows, decided through its approval custody (shipped 08c7b40e96, seen live in VOICE-DESIGN-INCALL-1106). The glance is bound to that session: “Talking to Review #2481 · 3:40 / OpenAI Realtime”.</li><li><b>VI-04 (amended 2026-10-25):</b> by default you can say “yes, go ahead” and the Voice agent answers the request for you; the card then reads “Approved by the Voice agent for Leeroy”. One setting turns this off (shipped c17e473fdc, default on); then the line reads “Read aloud · tap to decide here” and Voice says it can’t decide by voice.</li><li>Product note: the shipped line under the card (<code>needsYouTapToDecide</code>) still says “tap to decide here” with the setting on; that copy is the product owner’s follow-up, not drawn here.</li></ul>` },
    NYp: { label: 'Needs you · 390', phone: true, html: NYp, notes: `<h3>Needs you · 390</h3><p>Tapping the island opens the sheet: the same session-bound glance and the same permission card with full-width Yes, plus Mute · End below. Answer aloud or tap (VI-04 default on). The phone’s existing attention notification still opens the request; no lock-screen approval is drawn.</p>` },
    TX: { label: 'Transcript', html: TXv, notes: `<h3>Voice turns are ordinary messages</h3><ul><li>The Global Voice conversation opens as an ordinary tab: spoken turns are bubbles, replies agent text, each with a quiet marker from <code>voice_agent_turn.v1</code>; handoffs are cards with live dot cells.</li><li>Its composer carries the waveform (tap to talk) and typing still works.</li><li>Prompts Voice sends into a coding session get a “Sent by Voice” marker (<code>new</code>).</li></ul>` },
    TXp: { label: 'Transcript · 390', phone: true, html: TXp, notes: `<h3>Transcript · 390</h3><p>Same session on a phone.</p>` },
    L: { label: 'Lock screen', phone: true, html: LA, notes: `<h3>Live Activity + Dynamic Island <span class="ch-new">new</span></h3><ul><li>A voice kind on the existing <code>HappierFocusLiveActivity</code>: pre-rendered planet pose per state, state, timer, last line, Mute / End (App Intents to the canonical attempt).</li><li>Needs you is a line that opens the app; never a lock-screen approval.</li></ul>` },
    La: { label: 'Android', phone: true, html: LAa, notes: `<h3>Android ongoing notification</h3><ul><li>Only the existing voice foreground-service notification, with its content refined (PLAN §4.7): it says Voice is using the microphone, stays ongoing while the call holds it, and tapping opens Happier. Shipped strings 23c2940acd: “Voice is using the microphone. Tap to open Happier.”, channel “Voice conversation”.</li><li>No Mute / End actions, no live transcript and no elapsed time: those need a separate approved native vertical. App controls stay one tap away after Open.</li><li>Approvals keep their own existing attention notification, unchanged; it opens the request in Happier.</li></ul>` },
  },
};
})();
