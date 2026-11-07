// Voice settings lab (concept `voice-settings`, lab lane B, 2026-10-02). Settings → Voice on the paper settings shell.
// Product truth: apps/ui/sources/voice/settings/** (4 intents, panels, voiceSettingsDeclarations, passiveSetup),
// voice/registry/readiness.ts (per-role status + reasonKey + recoveryAction), provider manifests (openai, xai,
// elevenlabs, codex, google, openai-compat) and the audit inventory C-settings-ux.md. Decision record:
// .project/plans/2026-07-20-voice-convergence-and-program-completion/lanes/2026-10-02/lab-voice-settings.md
// Drawn in the shipped shell through the shared owners: window.WS (workspace top strip + theme switch + tabs),
// window.HI (R1 rail, phone kit), the settings column markup (ch-*), and the kit's h.* page/section/row builders.
// IIFE; namespace vs-*; every desktop frame has a 390 twin ("…p").
(() => {
const WS = window.WS, HI = window.HI;
const NEW = (t = 'new') => `<span class="ch-new" title="Needs new data or capability">${t}</span>`;
const DER = () => '<span class="vs-der" title="Derived in the UI from data that exists">der</span>';
const EXP = () => '<span class="vs-exp">Experimental</span>';
const SEP = '<span style="color:var(--text3)">·</span>';
const dot = (c) => `<span class="dot ${c}"></span>`;

Object.assign(P, {
  vsWave: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>',
  vsBrain: '<path d="M9 4.5a3 3 0 0 0-3 3v.2A3 3 0 0 0 4.5 13 3 3 0 0 0 7 17.8 3 3 0 0 0 12 19V6a2.5 2.5 0 0 0-3-1.5Z"/><path d="M15 4.5a3 3 0 0 1 3 3v.2a3 3 0 0 1 1.5 5.3 3 3 0 0 1-2.5 4.8A3 3 0 0 1 12 19"/>',
  vsSpeaker: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  vsChevR: '<path d="m9 6 6 6-6 6"/>',
  vsArrow: '<path d="M5 12h13M13 7l5 5-5 5"/>',
  vsPlay: '<path d="M8 5.5v13l10.5-6.5z"/>',
  vsMinus: '<path d="M6 12h12"/>',
  vsCpu: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/><path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3"/>',
  vsCheck: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  vsClock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  vsDl: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  vsText: '<path d="M5 6.5h14M5 11h14M5 15.5h9"/>',
  vsCursor: '<path d="M9 4.5h6M9 19.5h6M12 4.5v15"/>',
  vsHand: '<path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11.5V5a1.5 1.5 0 0 1 3 0v6.5M14 11.5V6.5a1.5 1.5 0 0 1 3 0V14c0 3.6-2.4 6-6 6-2.6 0-4.1-1.3-5.3-3.4L4.4 14a1.5 1.5 0 0 1 2.5-1.6L8 14"/>',
});

/* ═══ marks: the voice planet and provider marks ═══ */
// Voice identity = the Daybreak dot planet (user input 2026-10-02). Settings use only STATIC frames of it (zero scheduled
// frames, no breath, no rings, no tile): the page mark, and sparingly in readiness — Light = ready, Shadow = waiting on
// something outside (eclipse), the 2×4 dot cell (daybreak.css .db-cell) = working. The frame is a CPU projection of the
// daybreak model (engine.js: PALETTES, gradient, lightFor, bayer, hash2 — reused, not copied), drawn as SVG dots so it is
// identical in every shot. The per-dot body below mirrors engine.js brailleFrame (renderer E); product owner: one model.
if (!window.DB) document.write('<script src="../daybreak/engine.js"><\/script><script>window.DB && !window.DB.mountScenes && (window.DB.mountScenes = function () {});<\/script>');
function dotPlanet(px, o = {}) {
  const D = window.DB; if (!D) return '';
  const th = o.theme || (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'); const pal = D.PALETTES[th];
  const pitch = o.pitch || (px >= 28 ? 1.55 : 1.2); const N = Math.max(8, Math.round(px / pitch)); const cx = N / 2, cy = N / 2;
  const R = (o.radius || 0.74) * N / 2; const reveal = o.reveal != null ? o.reveal : 1; const light = D.lightFor(reveal);
  const ct = Math.cos(0.38), st = Math.sin(0.38), spin = o.spin != null ? o.spin : 0.9; let dots = '';
  const put = (x, y, c) => { dots += `<circle cx="${x + 0.5}" cy="${y + 0.5}" r=".4" fill="rgb(${c.map(Math.round)})"/>`; };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const px2 = (x + 0.5 - cx) / R, py = (y + 0.5 - cy) / R; const r2 = px2 * px2 + py * py; const thr = D.bayer(x, y);
    if (r2 >= 1) {
      const d = Math.sqrt(r2) - 1; const facing = D.clamp((px2 * light[0] + py * light[1]) / Math.sqrt(r2) * 0.8 + 0.35);
      const dens = facing * Math.exp(-d * 7) * 0.9 * D.clamp(reveal * 1.4);
      if (dens > thr + 0.02) put(x, y, D.mixRgb(pal.bg, D.gradient(pal.halo, D.clamp((py + 1) / 2 - px2 * 0.2)), 0.45 + 0.55 * Math.exp(-d * 5)));
      continue;
    }
    const pz = Math.sqrt(1 - r2); const lambert = px2 * light[0] + py * light[1] + pz * light[2];
    const day = D.smooth((lambert + 0.42) / 1.05); const fres = (1 - pz) ** 2.6;
    const rim = fres * D.clamp((px2 * light[0] + py * light[1]) / Math.max(0.2, Math.sqrt(r2)) * 1.2 + 0.1) * (0.6 + 0.4 * reveal);
    const qy = py * ct - px2 * st, qx = px2 * ct + py * st; const lon = Math.atan2(qx, pz) + spin, lat = Math.asin(D.clamp(qy, -1, 1));
    const grain = D.hash2(Math.floor((lon / (Math.PI * 2)) * 180 + 1000), Math.floor(lat * 40 + 100));
    let c = D.gradient(pal.body, D.clamp(0.44 + py * 0.6 - px2 * 0.12)); c = D.mixRgb(c, [196, 58, 132], D.clamp(-px2 * 0.35) * (1 - Math.abs(py)));
    c = D.mixRgb(pal.bg, c, D.clamp(day)); c = D.mixRgb(c, pal.rim, D.clamp(rim * 1.1));
    if (D.clamp(day * 1.25 + rim * 2) - (grain < 0.06 ? 0.5 : 0) < thr) continue; put(x, y, c);
  }
  return `<svg class="vs-dp" width="${px}" height="${px}" viewBox="0 0 ${N} ${N}" ${o.label ? `role="img" aria-label="${o.label}"` : 'aria-hidden="true"'}>${dots}</svg>`;
}
const planet = (s = 44) => dotPlanet(s, { label: 'Voice', radius: 0.8 });
const shadow = (s = 15) => dotPlanet(s, { reveal: 0.3, radius: 0.94, pitch: 1.1 });
const lit = (s = 15) => dotPlanet(s, { radius: 0.94, pitch: 1.1 });
const glyph = (k) => (k === 'lit' ? lit(14) : k === 'shadow' ? shadow(14) : k === 'work' ? cell('working') : k === 'warn' ? dot('warn') : '');
const cell = (kind = 'working') => `<span class="db-cell ${kind} lg" aria-hidden="true">${'<i></i>'.repeat(8)}</span>`;
const MK = {
  local: (s = 18) => ic('vsWave', '', `width="${s}" height="${s}"`),
  eleven: (s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7.5" y="4" width="3" height="16" rx=".6"/><rect x="13.5" y="4" width="3" height="16" rx=".6"/></svg>`,
  openai: (s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${[0, 60, 120].map((a) => `<ellipse cx="12" cy="12" rx="8.6" ry="3.9" transform="rotate(${a} 12 12)"/>`).join('')}</svg>`,
  xai: (s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 4.5 19 19.5M19 4.5l-5.5 6M10.5 13.5 5 19.5"/></svg>`,
  codex: (s = 18) => BRAND.codex(s),
  google: (s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 12.2c0-.6 0-1.2-.2-1.8H12v3.4h4.8a4.2 4.2 0 0 1-1.8 2.7v2.2h2.9c1.7-1.5 2.6-3.8 2.6-6.5Z" fill="#4285F4"/><path d="M12 21c2.4 0 4.4-.8 5.9-2.2L15 16.6c-.8.5-1.8.9-3 .9-2.3 0-4.3-1.6-5-3.7H4v2.3A9 9 0 0 0 12 21Z" fill="#34A853"/><path d="M7 13.8a5.4 5.4 0 0 1 0-3.5V8H4a9 9 0 0 0 0 8.1l3-2.3Z" fill="#FBBC05"/><path d="M12 6.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 4 8l3 2.3c.7-2.1 2.7-3.7 5-3.7Z" fill="#EA4335"/></svg>`,
  device: (s = 18) => ic('phone', '', `width="${s}" height="${s}"`),
  endpoint: (s = 18) => ic('globe', '', `width="${s}" height="${s}"`),
  neural: (s = 18) => ic('vsCpu', '', `width="${s}" height="${s}"`),
  session: (s = 18) => BRAND.claude(s),
  agent: (s = 18) => BRAND.claude(s),
};

/* ═══ shared bits ═══ */
const play = (label) => `<button class="vs-play" aria-label="Preview ${label}">${ic('vsPlay')}</button>`;
const stepper = (v, label) => `<span class="vs-step-in" role="group" aria-label="${label}"><button aria-label="Fewer">${ic('vsMinus')}</button><span>${v}</span><button aria-label="More">${ic('plus')}</button></span>`;
const slider = (pct, v, label) => `<span class="vs-slider" role="slider" aria-label="${label}" aria-valuetext="${v}"><span class="tr"><i style="width:${pct}%"></i><b style="left:${pct}%"></b></span><span>${v}</span></span>`;
const input = (v, o = {}) => `<span class="input ${o.ph ? 'phd' : ''}" style="min-width:${o.w || 260}px">${v}</span>`;
const chip = (o = {}) => `<span class="vs-chip" role="button" aria-haspopup="menu" aria-label="Voice computer: ${o.m || 'devbox'}">${ic(o.icon || 'desktop')}<span class="q">${o.q || 'Runs on'}</span>${o.m || 'devbox'}${dot(o.d || 'ok')}${ic('chevD', 'cv')}</span>`;
const why = (t, a = '') => `<div class="vs-why">${dot('warn')}<span>${t}${a ? ` <a>${a}</a>` : ''}</span></div>`;
const note = (icon, t) => `<div class="vs-note">${ic(icon)}<span>${t}</span></div>`;
const head = (title, desc, o = {}) => `${o.crumb ? `<div class="vs-crumb">${ic('back')}Voice</div>` : ''}<header class="vs-ph">${o.mark ? `<span class="mk">${o.mark}</span>` : ''}<div class="t"><h1>${title}</h1><p>${desc}</p>${o.meta ? `<div class="meta">${o.meta}</div>` : ''}</div>${o.actions ? `<div class="actions">${o.actions}</div>` : ''}</header>`;
const arrow = () => `<span class="vs-arrow" aria-hidden="true">${ic('vsArrow')}</span>`;

// one pipeline step. s: { k, icon, mark, name, where, wIcon, r: { t, a, tone, bar }, warn, sel, tag }
function step(s) {
  const g = s.r && (s.r.spin ? cell('working') : s.r.tone === 'shadow' ? shadow(14) : s.r.tone === 'info' ? ic('info', '', 'width="13" height="13" style="flex:none"') : dot(s.r.tone === 'bad' ? 'bad' : 'warn'));
  const r = s.r ? `<div class="r ${s.r.tone || ''}">${g}<span class="msg">${s.r.t}</span>${s.r.a ? h.btn(s.r.a, 'secondary', '', 'sm') : ''}</div>${s.r.bar != null ? `<div class="bar"><i style="width:${s.r.bar}%"></i></div>` : ''}` : '';
  return `<div class="vs-step ${s.warn ? 'warn' : ''} ${s.sel ? 'vs-on' : ''}" role="group" aria-label="${s.k}: ${s.name}"><div class="k">${s.k}<span class="grow"></span>${s.tag || ''}</div><div class="e">${s.mark}<span class="nm">${s.name}</span></div><div class="w">${ic(s.wIcon || 'desktop')}<span>${s.where}</span></div>${r}</div>`;
}
// pipeline card. o: { title, status, steps: [step…], one, two, foot, action }
function pipe(o) {
  const parts = o.steps.map((s, i) => (i ? arrow() : '') + step(s)).join('');
  return `<div class="vs-pipe ${o.cls || ''}" role="group" aria-label="${o.title}"><div class="vs-pipe-h"><div style="min-width:0"><div class="tt">${o.title}</div><div class="st">${glyph(o.glyph)}${o.status}</div></div><span class="grow"></span>${o.action || ''}</div><div class="vs-steps ${o.steps.length === 1 ? 'one' : o.steps.length === 2 ? 'two' : ''}">${parts}</div>${o.foot ? `<div class="vs-pipe-f">${o.foot}</div>` : ''}</div>`;
}
// vertical (phone) pipeline rows
function vpipe(o) {
  const rows = o.steps.map((s) => `<div class="vs-vr"><div class="k">${s.k.replace(/ · /g, '<br>')}</div><div class="c"><div class="e">${s.mark}<span>${s.name}</span></div><div class="w">${s.where}</div>${s.r ? `<div class="r ${s.r.tone || ''}">${s.r.spin ? cell('working') : s.r.tone === 'shadow' ? shadow(14) : dot('warn')}${s.r.t}</div>` : ''}</div>${s.r && s.r.a ? `<div class="ctl">${h.btn(s.r.a, 'secondary', '', 'sm')}</div>` : ''}</div>`).join('');
  return `<div class="vs-pipe" role="group" aria-label="${o.title}"><div class="vs-pipe-h"><div style="min-width:0"><div class="tt">${o.title}</div><div class="st">${glyph(o.glyph)}${o.status}</div></div><span class="grow"></span>${o.action || ''}</div><div class="vs-vrows" style="border-top:1px solid var(--p-divider)">${rows}</div></div>`;
}

/* ═══ the data (one consistent Account): MacBook Pro (this computer), devbox (online), Studio (offline) ═══ */
const ST = {
  hearWhisper: { k: 'Hear', mark: MK.endpoint(17), name: 'Whisper endpoint', where: 'On devbox · localhost:8000', wIcon: 'desktop' },
  hearDevice: { k: 'Hear', mark: ic('laptop', '', 'width="17" height="17"'), name: 'This device’s speech', where: 'MacBook Pro · may use Apple’s servers', wIcon: 'laptop' },
  thinkAgent: { k: 'Think', mark: MK.agent(17), name: 'Claude Code', where: 'Voice agent on devbox · asks first', wIcon: 'desktop' },
  thinkSession: { k: 'Think', mark: MK.session(17), name: 'The session you’re in', where: 'Its own agent answers, in the transcript', wIcon: 'chat' },
  speakKokoro: { k: 'Speak', mark: MK.neural(17), name: 'Kokoro · Heart', where: 'On devbox · 1.0×', wIcon: 'desktop' },
};
const kokoroMissing = { ...ST.speakKokoro, warn: true, r: { t: 'Install the voice model on devbox (82 MB)', a: 'Install' } };

/* ═══ settings column (the shipped catalog + Voice), and the desktop shell ═══ */
const COL_NAV = NAV.map((n) => (n.k === 'voice' ? { ...n, t: 'Voice' } : n));
function scol(o = {}) {
  let out = '';
  for (const n of COL_NAV) { if (n.g) out += `<div class="ch-lbl">${({ 'AI & Agents': 'AI & agents' }[n.g] || n.g.charAt(0) + n.g.slice(1).toLowerCase())}</div>`; else out += `<div class="ch-row ${n.k === 'voice' ? 'on' : ''}" role="link" aria-current="${n.k === 'voice' ? 'page' : 'false'}"><span class="g">${ic(n.i)}</span><div class="c"><div class="t">${n.t}</div></div></div>`; }
  const find = o.q ? `<div class="ch-find vs-q" role="searchbox" aria-label="Search settings">${ic('search')}<span>${o.q}</span><span class="caret"></span><span class="grow"></span>${ic('x', 'x')}</div>` : `<div class="ch-find">${ic('search')}<span>Search settings</span></div>`;
  return `<div class="ch-col cs-scol" role="navigation" aria-label="Settings"><div class="ch-colh"><b>Settings</b></div>${find}<div class="ch-list">${o.results || out}</div></div>`;
}
Object.assign(WS.D, {
  fix: WS.D.fix,
  vsHub: { k: 'settings', t: 'Voice', mk: () => ic('mic', '', 'width="14" height="14"'), line: 'Settings' },
  vsConv: { k: 'settings', t: 'Voice conversations', mk: () => ic('mic', '', 'width="14" height="14"'), line: 'Settings' },
  vsDict: { k: 'settings', t: 'Dictation', mk: () => ic('mic', '', 'width="14" height="14"'), line: 'Settings' },
  vsPriv: { k: 'settings', t: 'Voice · Privacy & data', mk: () => ic('mic', '', 'width="14" height="14"'), line: 'Settings' },
  vsAdv: { k: 'settings', t: 'Voice · Advanced', mk: () => ic('mic', '', 'width="14" height="14"'), line: 'Settings' },
});
const desk = (st, tabKey, page, o = {}) => WS.wsApp(st, { active: 'settings', colHtml: scol(o), root: { g: WS.G([['fix'], ['rev'], [tabKey, { active: true }]], `<div class="vs-view">${page}</div>`, { focused: true }) }, over: o.over });
const ph = (title, body, o = {}) => HI.phone({ nav: HI.pnav(o.back || 'Settings', o.navRight || ''), body: `${title ? `<div class="hi-pt">${title}</div>` : ''}${o.lede ? `<div class="vs-pp">${o.lede}</div>` : ''}<div class="vs-pb">${body}</div>`, tab: false });

/* ═══ H · Voice hub ═══ */
const dictPipe = (o = {}) => pipe({ cls: 'vs-mode', title: `Dictation`, glyph: 'lit', status: 'Ready · the mic in the composer turns your speech into text you can edit', action: ic('chevR', 'chev', 'width="16" height="16" style="color:var(--text3)"'),
  steps: [{ ...ST.hearDevice, k: 'Hear' }, { k: 'Write', mark: ic('vsText', '', 'width="17" height="17"'), name: 'Into your message', where: 'Language: automatic', wIcon: 'translate' }] });
const convPipe = (o = {}) => pipe({ cls: 'vs-mode', title: 'Voice conversations', glyph: o.ready ? 'lit' : 'warn', status: `${o.ready ? 'Ready' : 'One step needs you'} ${SEP} Local voice, talking with a Voice agent about your sessions`, action: ic('chevR', 'chev', 'width="16" height="16" style="color:var(--text3)"'),
  steps: [ST.hearWhisper, ST.thinkAgent, o.ready ? ST.speakKokoro : kokoroMissing] });
function hubPage() {
  const rows = h.sheet(
    h.row({ lead: `<span class="xrow-lead" style="color:var(--text2)">${ic('shieldcheck', '', 'width="18" height="18"')}</span>`, t: 'Privacy & data', d: 'Shares session summaries and your last 3 messages · Voice agent forgets after each talk', chev: true })
    + h.row({ lead: `<span class="xrow-lead" style="color:var(--text2)">${ic('sliders', '', 'width="18" height="18"')}</span>`, t: 'Advanced', d: 'Voice computer: devbox · transcript while talking · 1 speech model', chev: true })
    + h.row({ lead: `<span class="xrow-lead" style="color:var(--text2)">${ic('history', '', 'width="18" height="18"')}</span>`, t: 'Voice history', d: '38 conversations · latest today at 10:12', chev: true }));
  return `<div class="page">${head('Voice', 'Talk with your agents out loud, and dictate into any message.', { mark: planet(), actions: h.btn('Try voice', 'secondary', 'mic', 'sm') })}
    ${h.sec('Two ways to use your voice', '', `<div class="vs-modes">${dictPipe()}${convPipe()}</div>`)}
    ${h.sec('More', '', rows)}</div>`;
}
function hubPhone() {
  const card = (title, s, rows) => `<div class="vs-pipe" style="margin-bottom:10px"><div class="vs-pmode"><div class="c"><div class="t">${title}</div><div class="s">${s}</div></div>${ic('chevR', 'chev')}</div><div class="vs-vrows" style="border-top:1px solid var(--p-divider)">${rows}</div></div>`;
  const vr = (k, mark, e, w, r) => `<div class="vs-vr"><div class="k">${k}</div><div class="c"><div class="e">${mark}<span>${e}</span></div><div class="w">${w}</div>${r ? `<div class="r">${dot('warn')}${r}</div>` : ''}</div></div>`;
  return ph('', `${card('Dictation', 'Speech into the message you’re writing.', vr('Hear', MK.device(16), 'This phone’s speech', 'iPhone · may use Apple’s servers'))}
    ${card('Voice conversations', 'Local voice · Voice agent', vr('Hear', MK.endpoint(16), 'Whisper endpoint', 'On devbox') + vr('Think', MK.agent(16), 'Voice agent · Claude Code', 'On devbox') + vr('Speak', MK.neural(16), 'Kokoro · Heart', 'On this iPhone', 'Not on this iPhone yet · 82 MB'))}
    ${h.sheet(h.row({ t: 'Privacy & data', d: 'Summaries + last 3 messages', chev: true }) + h.row({ t: 'Advanced', d: 'Voice computer: devbox', chev: true }) + h.row({ t: 'Voice history', d: '38 conversations', chev: true }))}`,
  { lede: '' }).replace('<div class="vs-pb">', `<div class="vs-phead"><span style="flex:none">${planet(40)}</span><div class="hi-pt">Voice</div></div><div class="vs-pp">Talk with your agents, and dictate into any message.</div><div class="vs-pb">`);
}

/* ═══ provider gallery ═══ */
const PROV = [
  { id: 'local', mk: MK.local, t: 'Local voice', d: 'You pick how it hears and speaks. Talk to a session, or to a Voice agent.', ft: `${ic('desktop')}Your computers and this device`, },
  { id: 'eleven', mk: MK.eleven, t: 'ElevenLabs', d: 'Natural voices with low latency. Talks to your sessions for you.', ft: `${ic('key')}Through Happier, or your own account` },
  { id: 'openai', mk: MK.openai, t: 'OpenAI Realtime', d: 'One model hears, thinks and speaks.', ft: `${ic('key')}Your OpenAI key or account` },
  { id: 'xai', mk: MK.xai, t: 'xAI Grok Voice', d: 'Fast replies with adjustable reasoning.', ft: `${ic('key')}Your xAI API key` },
  { id: 'codex', mk: MK.codex, t: 'Codex Live', d: 'Talk to Codex with your ChatGPT plan.', ft: `${ic('desktop')}Needs Codex running on a computer`, exp: true },
  { id: 'off', mk: (s) => ic('x', '', `width="${s}" height="${s}"`), t: 'Off', d: 'No voice conversations. Dictation stays available.', quiet: true },
];
function tiles(sel, o = {}) {
  const st = o.state || {};
  return `<div class="vs-tiles" role="radiogroup" aria-label="Voice conversation service">${PROV.filter((p) => !o.only || o.only.includes(p.id)).map((p) => {
    const s = st[p.id];
    const ft = s ? `<div class="ft ${s.warn ? 'warn' : ''}">${s.warn ? dot('warn') : ''}${s.t}</div>` : p.ft ? `<div class="ft">${p.ft}</div>` : '';
    return `<div class="vs-tile ${sel === p.id ? 'on' : ''} ${p.quiet ? 'quiet' : ''}" role="radio" aria-checked="${sel === p.id}"><div class="hd">${p.mk(18)}<span class="ttl">${p.t}</span>${p.exp ? EXP() : ''}<span class="grow"></span>${sel === p.id ? `<span class="ck">${ic('vsCheck')}</span>` : '<span class="rd"></span>'}</div><div class="dsc">${p.d}</div>${ft}</div>`;
  }).join('')}</div>`;
}
const READY = { eleven: { t: 'Ready · through Happier' }, openai: { t: 'Connect an OpenAI account first', warn: true }, xai: { t: 'Add an xAI API key first', warn: true }, codex: { t: 'Needs Codex 0.43 or newer on devbox', warn: true } };

/* ═══ C1 · Conversations · Local voice (lead) ═══ */
const langSec = (o = {}) => h.sec('Language', o.desc || 'Each line says what it changes for the service you chose.', h.sheet(
  h.row({ t: 'I speak', d: o.speak || 'Helps Whisper understand you. Automatic detects it each time.', c: h.sel('English (US)') })
  + h.row({ t: o.replyStatic ? 'Reply in' : `Reply in ${NEW()}`, d: o.reply || 'The Voice agent answers in this language, even if you switch.', c: o.replyStatic ? `<span class="val">${o.replyStatic}</span>` : h.sel('Same as I speak') })
  + (o.noVoice ? '' : h.row({ t: 'Voice', d: o.voice || 'Warm, mid-pitched · from Kokoro, the engine in Speak.', c: `${play('Heart')}${h.sel('Heart')}` }))));
function convLocal(o = {}) {
  const hear = h.sec('Hear', 'How your speech becomes text before the agent reads it.', h.sheet(
    h.row({ t: 'Speech recognition', d: 'OpenAI-compatible endpoint on devbox', c: h.sel('Whisper endpoint', MK.endpoint(15)) })
    + h.row({ cls: 'stack', t: 'Endpoint', d: 'Plain http is allowed for localhost on devbox (you confirmed it on Sep 28).', c: `<div style="display:flex;gap:8px;align-items:center">${input('http://localhost:8000/v1', { w: 300 })}${h.sel('whisper-1')}</div>` })
    + h.row({ t: 'API key', d: '<span class="vs-ident">None · this server doesn’t ask for one</span>', c: h.btn('Add key', 'ghost', '', 'sm') })
    + h.row({ cls: 'vs-dis', t: 'How you talk', d: why('Hands-free needs speech recognition on a device or a Happier model.', 'Use this device’s speech').replace('<div class="vs-why">', '<div class="vs-why" style="margin-top:2px">'), c: h.seg(['Hold to talk', 'Hands-free'], 0) })
    + h.row({ t: 'Interrupt by speaking', d: 'Talking over a reply stops it.', c: h.sw(true) })));
  const think = h.sec('Think', '', h.sheet(
    h.row({ t: 'Talk to', d: 'A Voice agent reads your sessions and acts on them for you.', c: h.seg(['The session', 'A Voice agent'], 1) })
    + h.row({ t: 'Agent', d: 'Claude Code on devbox · asks first · Sonnet 4.5', c: h.sel('Claude Code', BRAND.claude(14)) })));
  const speak = h.sec('Speak', 'How replies are read aloud.', h.sheet(
    h.row({ t: 'Voice engine', d: 'Happier’s on-device voice model', c: h.sel('Kokoro', MK.neural(15)) })
    + h.row({ t: 'Kokoro model', d: why('Not on devbox yet · 82 MB · Apache 2.0'), c: h.btn('Install', 'secondary', 'vsDl', 'sm') })
    + h.row({ t: 'Runs on', d: 'In the desktop app and browser, Automatic uses your Voice computer. Phones use their own chip.', c: h.seg(['Automatic', 'devbox'], 0) })
    + h.row({ t: 'Speed', c: slider(40, '1.0×', 'Speech speed') })
    + h.row({ t: 'Speak replies automatically', d: 'Off: replies stay as text until you tap play.', c: h.sw(true) })));
  return `<div class="page">${head('Voice conversations', 'Talk to your agents out loud, hands on the keyboard or not.', { crumb: true, actions: `${chip()}${h.btn('Test', 'secondary', 'mic', 'sm')}` })}
    ${pipe({ title: 'Local voice', glyph: 'warn', status: `Speak needs its voice model ${SEP} runs on devbox; nothing leaves your computers ${DER()}`, steps: [ST.hearWhisper, ST.thinkAgent, { ...kokoroMissing, sel: o.sel }], foot: `${ic('info')}<span>Ready once Kokoro is on devbox. Until then the Voice agent answers in text.</span>` })}
    ${h.sec('Service', 'Who hears you, thinks and speaks. You can switch any time; each keeps its own setup.', tiles('local', { state: READY }))}
    ${langSec({ desc: 'Each line says what it changes for Local voice.' })}${hear}${think}${speak}</div>`;
}
function convLocalPhone() {
  return ph('Voice conversations', `${vpipe({ title: 'Local voice', glyph: 'warn', status: 'Speak needs its voice model', steps: [ST.hearWhisper, ST.thinkAgent, { ...kokoroMissing, where: 'On this iPhone · 1.0×', r: { t: 'Not on this iPhone yet · 82 MB', a: 'Install' } }] })}
    ${h.sec('Service', '', h.sheet(h.row({ lead: `<span class="xrow-lead">${MK.local(20)}</span>`, t: 'Local voice', d: 'You pick how it hears and speaks', chev: true })))}
    ${h.sec('Think', '', h.sheet(h.row({ cls: 'stack', t: 'Talk to', c: h.seg(['The session', 'A Voice agent'], 1) }) + h.row({ t: 'Agent', d: 'Claude Code on devbox', chev: true }) + h.row({ t: 'It may', d: 'Ask first', chev: true })))}`, { back: 'Voice', navRight: chip({ q: '', m: 'devbox' }).replace('vs-chip', 'vs-chip" style="height:30px') });
}

/* ═══ C2 · Conversations · ElevenLabs ═══ */
function convEleven() {
  const acct = h.sec('Account', 'ElevenLabs is the same service either way; this only changes who pays.', h.sheet(
    h.row({ t: 'Pay with', d: 'Your Happier plan covers it. No ElevenLabs account needed.', c: h.seg(['Happier', 'My ElevenLabs account'], 0) })
    + h.row({ t: 'Included this month', d: `<span class="vs-ident">42 of 120 min used · resets Oct 31 ${NEW()}</span>`, c: h.btn('Plans', 'ghost', '', 'sm') })));
  const voice = h.sec('Voice', 'How the ElevenLabs agent sounds.', h.sheet(
    h.row({ t: 'Voice', d: 'Happier default · calm, clear', c: `${play('Happier default')}${h.sel('Happier default')}` })
    + h.row({ t: 'Voice model', c: h.sel('Recommended') })
    + h.row({ t: 'Stability', d: 'Lower sounds livelier; higher stays even.', c: slider(50, 'Default', 'Stability') })
    + h.row({ t: 'Similarity', c: slider(75, 'Default', 'Similarity') })
    + h.row({ t: 'Speed', c: slider(45, '1.0×', 'Speed') })));
  const talk = h.sec('Conversation', '', h.sheet(
    h.row({ t: `Greeting ${NEW('fix')}`, d: 'Today this choice is ignored by ElevenLabs (audit C-02). It ships together with the fix.', c: h.seg(['Off', 'Right away', 'After I speak'], 1) })));
  return `<div class="page">${head('Voice conversations', 'Talk to your agents out loud, hands on the keyboard or not.', { crumb: true, actions: h.btn('Test', 'secondary', 'mic', 'sm') })}
    ${pipe({ title: 'ElevenLabs', glyph: 'lit', status: 'Ready · through your Happier plan', steps: [{ k: 'Hear · Think · Speak', mark: MK.eleven(17), name: 'ElevenLabs agent', where: 'ElevenLabs cloud, straight from this device · reads your sessions through Happier', wIcon: 'cloud' }], foot: `${ic('shieldcheck')}<span>Your audio and the context you allow go to ElevenLabs.</span><span class="grow"></span><a>What’s shared</a>` })}
    ${h.sec('Service', 'Who hears you, thinks and speaks. You can switch any time; each keeps its own setup.', tiles('eleven', { state: READY }))}
    ${acct}${voice}${talk}
    ${langSec({ desc: 'ElevenLabs listens and replies in one language.', speak: `ElevenLabs listens for this language and replies in it ${NEW('fix')}.`, reply: 'ElevenLabs uses one language for both.', replyStatic: 'Same as I speak', noVoice: true })}</div>`;
}
function convElevenPhone() {
  return ph('Voice conversations', `${vpipe({ title: 'ElevenLabs', glyph: 'lit', status: 'Ready · through your Happier plan', steps: [{ k: 'Hear · Think · Speak', mark: MK.eleven(16), name: 'ElevenLabs agent', where: 'ElevenLabs cloud, from this phone' }] })}
    ${h.sec('Account', 'Same service either way; this changes who pays.', h.sheet(h.row({ cls: 'stack', t: 'Pay with', c: h.seg(['Happier', 'My ElevenLabs account'], 0) })))}
    ${h.sec('Voice', '', h.sheet(h.row({ t: 'Voice', d: 'Happier default', c: play('Happier default'), chev: true }) + h.row({ t: 'Speed', d: '1.0×', chev: true })))}`, { back: 'Voice' });
}

/* ═══ C3 · Advanced agent behaviour, opened in place ═══ */
function agentAdvanced() {
  return h.sheet(
    h.row({ t: 'Talk to', d: 'A Voice agent reads your sessions and acts on them for you.', c: h.seg(['The session', 'A Voice agent'], 1) })
    + h.row({ t: 'Agent', d: 'Claude Code on devbox · its own folder', c: h.sel('Claude Code', BRAND.claude(14)) })
    + h.row({ t: 'It may', d: 'Every change asks you first. A spoken “yes” never approves; you tap.', c: h.seg(['Read only', 'Ask first', 'Safe changes', 'Anything'], 1) })
    + h.row({ t: 'Model', d: 'Sonnet 4.5 through your Claude account', c: h.sel('Same as Claude Code') })
    + h.row({ t: 'Replies', c: h.seg(['Short', 'Balanced'], 0) })
    + h.row({ t: 'Greeting', d: 'Says hello as soon as you connect.', c: h.seg(['Off', 'Right away', 'After I speak'], 1) })
    + `<div class="disc open"><div class="dhead" data-disc>${ic('chevR', 'car')}<div><div class="ttl">Advanced agent behaviour</div></div><span class="sum"></span></div><div class="dbody"><div><div class="inner">${[
      h.row({ t: 'Keep recent Voice agents ready', d: 'Faster to pick up again; each one stays on devbox.', c: h.seg(['One at a time', 'Keep up to 3'], 0) }),
      h.row({ t: 'Close an idle Voice agent after', d: '1 minute to 6 hours.', c: h.sel('30 minutes') }),
      h.row({ t: 'Get ready as soon as I connect', d: 'Starts the agent before you speak.', c: h.sw(true) }),
      h.row({ t: 'Go to the session it’s working on', d: 'When you ask about a session, the Voice agent can move there.', c: h.sw(true) }),
      h.row({ t: 'Always stay in its own folder', d: 'Keeps it out of your projects, even when asked.', c: h.sw(false) }),
      h.row({ t: 'Model for messages it sends', d: 'Used when it writes into one of your sessions.', c: h.seg(['Same as above', 'Session’s model', 'Choose'], 0) }),
      h.row({ t: 'Work in a separate session', d: 'Sends changes through a session of its own instead of yours.', c: h.sw(false) }),
      h.row({ t: 'Stream replies', d: 'Shows the reply as it’s written.', c: h.sw(true) }),
      h.row({ t: 'Start speaking before the reply is finished', c: h.sw(true) }),
      h.row({ t: 'Speak in pieces of', d: 'Smaller starts sooner; larger sounds smoother.', c: stepper('200 chars', 'Characters per spoken piece') }),
      h.row({ t: 'Memory and restoring', d: 'Whether it remembers past talks lives in Privacy & data.', chev: true }),
    ].join('')}</div></div></div></div>`);
}
function convAgent() {
  return `<div class="page">${head('Voice conversations', 'Talk to your agents out loud, hands on the keyboard or not.', { crumb: true, actions: `${chip()}${h.btn('Test', 'secondary', 'mic', 'sm')}` })}
    ${pipe({ title: 'Local voice', glyph: 'lit', status: 'Ready · everything runs on devbox', steps: [ST.hearWhisper, { ...ST.thinkAgent, sel: true }, ST.speakKokoro] })}
    ${h.sec('Think', 'What happens to what you say.', agentAdvanced())}</div>`;
}
function convAgentPhone() {
  return ph('Advanced agent behaviour', h.sheet([
    h.row({ cls: 'stack', t: 'Keep recent Voice agents ready', c: h.seg(['One at a time', 'Keep up to 3'], 0) }),
    h.row({ t: 'Close when idle after', d: '30 minutes', chev: true }),
    h.row({ t: 'Get ready when I connect', c: h.sw(true) }),
    h.row({ t: 'Go to the session it’s working on', c: h.sw(true) }),
    h.row({ t: 'Always stay in its own folder', c: h.sw(false) }),
    h.row({ t: 'Model for messages it sends', d: 'Same as above', chev: true }),
    h.row({ t: 'Work in a separate session', c: h.sw(false) }),
    h.row({ t: 'Stream replies', c: h.sw(true) }),
    h.row({ t: 'Speak before it’s finished', c: h.sw(true) }),
  ].join('')), { back: 'Conversations', lede: 'How the Voice agent starts, waits and answers. Defaults suit most people.' });
}

/* ═══ ST · readiness states board ═══ */
function statesBoard() {
  const bcell = (cap, body, full) => `<div class="vs-bcell ${full ? 'full' : ''}"><div class="cap">${cap}</div>${body}</div>`;
  const fresh = pipe({ title: 'Local voice', glyph: 'warn', status: 'Two steps need you: nothing is set up yet', steps: [
    { k: 'Hear', mark: MK.endpoint(17), name: 'OpenAI-compatible endpoint', where: 'Not set', warn: true, r: { t: 'Needs an endpoint address', a: 'Set up' } },
    { k: 'Think', mark: MK.session(17), name: 'The session you’re in', where: 'Its own agent answers' },
    { k: 'Speak', mark: MK.endpoint(17), name: 'OpenAI-compatible endpoint', where: 'Not set', warn: true, r: { t: 'Needs an endpoint address', a: 'Set up' } }], foot: `${ic('sparkle')}<span>Quickest start: use this Mac’s own speech for both.</span><span class="grow"></span><a>Use this Mac’s speech</a>` });
  const installing = pipe({ title: 'Local voice', glyph: 'work', status: 'Installing the voice model on devbox', steps: [ST.hearWhisper, ST.thinkAgent, { ...ST.speakKokoro, r: { t: 'Installing on devbox · 28 of 82 MB', a: 'Cancel', tone: 'info', spin: true, bar: 34 } }] });
  const offline = pipe({ title: 'Local voice', glyph: 'shadow', status: 'Waiting for devbox · last seen at 09:12', steps: [{ ...ST.hearWhisper, r: { t: 'devbox is offline', a: 'Choose another computer', tone: 'shadow' } }, { ...ST.thinkAgent, r: { t: 'Waits for devbox', tone: 'shadow' } }, { ...ST.speakKokoro, r: { t: 'Waits for devbox', tone: 'shadow' } }] });
  const agentOff = pipe({ title: 'Local voice', glyph: 'shadow', status: 'Waiting on your Home owner', steps: [ST.hearWhisper, { ...ST.thinkAgent, r: { t: 'Voice agent is turned off on this server. Your Home owner can turn it on.', a: 'Talk to the session instead', tone: 'shadow' } }, ST.speakKokoro] });
  const openai = pipe({ title: 'OpenAI Realtime', glyph: 'warn', status: 'Needs an account', steps: [{ k: 'Hear · Think · Speak', mark: MK.openai(17), name: 'gpt-realtime-2.1 · Marin', where: 'OpenAI cloud, from this device', wIcon: 'cloud', warn: true, r: { t: 'Connect your OpenAI account, or save an API key', a: 'Connect' } }] });
  const codex = pipe({ title: 'Codex Live', glyph: 'warn', status: `Experimental ${SEP} uses a running Codex session`, steps: [{ k: 'Hear · Think · Speak', mark: MK.codex(17), name: 'Codex Live', where: 'OpenAI, through Codex on devbox · ChatGPT “Personal”', wIcon: 'desktop', warn: true, r: { t: 'Needs Codex 0.43 or newer on devbox (0.41 installed)', a: 'Update Codex' } }] });
  const plugin = pipe({ title: 'Acme Voice (plugin)', glyph: 'warn', status: 'Needs your approval', steps: [{ k: 'Hear · Think · Speak', mark: ic('puzzle', '', 'width="17" height="17"'), name: 'Acme Voice', where: 'acme.example · from this device', wIcon: 'globe', warn: true, r: { t: 'Approve what this plugin may receive: audio, your key', a: 'Review' } }] });
  const checking = `<div class="vs-pipe"><div class="vs-pipe-h"><div><div class="tt">Local voice</div><div class="st">${cell('working')}Checking devbox… showing the check from 10:40</div></div></div><div class="vs-steps">${step(ST.hearWhisper)}${arrow()}${step(ST.thinkAgent)}${arrow()}${step(ST.speakKokoro)}</div></div>`;
  const vertical = vpipe({ title: 'Local voice', glyph: 'warn', status: 'Same card, vertical form (Q3 alternative)', steps: [ST.hearWhisper, ST.thinkAgent, kokoroMissing] });
  return `<div class="vs-board"><h2>Pipeline card · every readiness state</h2><p>One card per mode. Each step reads its own role readiness (<code>voice/registry/readiness.ts</code>: status, reasonKey, recoveryAction) and shows the exact reason with the one action that fixes it. Healthy steps stay quiet. The stored choice is never changed for you.</p>
    <div class="vs-bgrid">${bcell('<b>Fresh</b> · today’s default Local setup (audit C-06)', fresh, true)}${bcell('<b>Installing</b> · install_model, in place', installing)}${bcell('<b>Checking</b> · last-known data while refreshing', checking)}${bcell('<b>Computer offline</b> · select_execution_machine', offline)}${bcell('<b>Feature off</b> · server_feature_disabled (voice.agent)', agentOff)}${bcell('<b>Needs account</b> · configure_credential', openai)}${bcell('<b>Experimental</b> · runtime_incompatible', codex)}${bcell('<b>Plugin</b> · credential_approval_required', plugin)}${bcell('<b>Q3 alternative</b> · vertical rows (phone uses this form)', vertical)}</div></div>`;
}

/* ═══ D · Dictation ═══ */
const engOpt = (o) => `<div class="vs-opt ${o.on ? 'on' : ''} ${o.dis ? 'dis' : ''}" role="radio" aria-checked="${!!o.on}"><span class="rd"></span><span style="flex:none;margin-top:1px">${o.mk}</span><div class="lbl"><div class="ttl">${o.t}${o.tag || ''}</div><div class="dsc">${o.d}</div>${o.req ? `<div class="req">${dot('warn')}${o.req}</div>` : ''}</div><div class="side">${o.side || ''}</div></div>`;
function dictPage() {
  const engines = h.sheet([
    engOpt({ on: true, mk: ic('laptop', '', 'width="18" height="18"'), t: 'This device’s speech', d: 'Fast and free. macOS may send audio to Apple to recognise it.', side: 'Ready' }),
    engOpt({ mk: MK.neural(18), t: 'Happier speech model', d: 'Zipformer, English. Runs on devbox; audio stays on your computers.', side: 'Ready' }),
    engOpt({ mk: MK.local(18), t: 'Same as voice conversations', d: 'Uses the Whisper endpoint on devbox.', side: 'Ready' }),
    engOpt({ mk: MK.endpoint(18), t: 'OpenAI-compatible endpoint', d: 'Any Whisper-style server you run.', req: 'Needs an endpoint address' }),
    engOpt({ mk: MK.google(18), t: 'Google Gemini', d: 'gemini-2.5-flash. Audio goes to Google.', req: 'Needs a Google API key' }),
  ].join(''));
  return `<div class="page">${head('Dictation', 'The mic in the composer turns your speech into text you can edit before sending.', { crumb: true, actions: h.btn('Test', 'secondary', 'mic', 'sm') })}
    ${pipe({ title: 'Dictation', glyph: 'lit', status: 'Ready · works even when voice conversations are off', steps: [{ ...ST.hearDevice }, { k: 'Write', mark: ic('vsText', '', 'width="17" height="17"'), name: 'Into your message', where: 'You review it before sending', wIcon: 'chat' }] })}
    ${h.sec('Speech engine', 'Each engine says where your audio goes.', engines)}
    ${h.sec('Language', '', h.sheet(h.row({ t: 'I dictate in', d: 'Automatic uses the engine’s default. This doesn’t follow your conversation language.', c: h.sel('Automatic') })))}
    ${h.sec('This device’s speech', 'Options for the engine you picked.', h.sheet(h.row({ t: 'Add punctuation', d: `Lets macOS add commas and full stops ${NEW()}.`, c: h.sw(true) })))}</div>`;
}
function dictPhone() {
  return ph('Dictation', `${vpipe({ title: 'Dictation', glyph: 'lit', status: 'Ready · works when conversations are off', steps: [{ k: 'Hear', mark: MK.device(16), name: 'This phone’s speech', where: 'iOS may use Apple’s servers' }, { k: 'Write', mark: ic('vsText', '', 'width="16" height="16"'), name: 'Into your message', where: 'You review it first' }] })}
    ${h.sec('Speech engine', '', h.sheet([engOpt({ on: true, mk: MK.device(18), t: 'This phone’s speech', d: 'Fast and free.' }), engOpt({ mk: MK.neural(18), t: 'Happier speech model', d: 'Stays on this phone.', req: 'Download (44 MB)' }), engOpt({ mk: MK.local(18), t: 'Same as conversations', d: 'Whisper on devbox' })].join('')))}
    ${h.sec('Language', '', h.sheet(h.row({ t: 'I dictate in', d: 'Automatic', chev: true })))}`, { back: 'Voice' });
}

/* ═══ P · Privacy & data ═══ */
function privPage() {
  const flow = `<div class="sheet"><div class="vs-flow">
    <span class="k">Your audio</span><span class="v">${ic('laptop')}This Mac ${ic('vsArrow')} ${ic('desktop')}<b>devbox</b> (Whisper, Kokoro) · never leaves your computers</span>
    <span class="k">What it reads</span><span class="v">${ic('desktop')}<b>Claude Code on devbox</b> ${ic('vsArrow')} Anthropic, under your Claude account</span>
    <span class="k">Recordings</span><span class="v">None · diagnostic recording is off</span></div></div>`;
  const start = h.sec('When a conversation starts', 'What the voice service can read about your work.', h.sheet(
    h.row({ t: 'What’s on your screen', d: 'Which session or page you’re looking at.', c: h.seg(['Never', 'When asked', 'Always'], 1) })
    + h.row({ t: 'Session summaries', c: h.sw(true) })
    + h.row({ t: 'Your recent messages', d: 'The last messages of a session, when it asks for context.', c: `${stepper('3', 'Recent messages')}${h.sw(true)}` })
    + h.row({ t: 'Tool names', d: 'Like “Edited file”. Arguments and file paths are never shared.', c: h.sw(true) })
    + h.row({ t: 'Permission requests', d: 'So it can tell you what needs you. You still approve with a tap.', c: h.sw(true) })
    + h.row({ t: 'Your machines and devices', d: 'Names and online state, to start sessions where you ask.', c: h.sw(true) })));
  const live = h.sec('While you talk', 'Updates sent as your sessions change during a conversation.', h.sheet(
    h.row({ t: 'From the session you’re in', c: h.seg(['Nothing', 'Activity', 'Summaries', 'Messages'], 3) })
    + h.row({ t: 'From your other sessions', c: h.seg(['Nothing', 'Activity', 'Summaries', 'Messages'], 1) })
    + h.row({ t: 'Messages per update', c: stepper('3', 'Messages per update') })
    + h.row({ t: 'Include what you wrote', d: 'Off: only the agent’s side is sent.', c: h.sw(false) })
    + h.row({ cls: 'vs-dis', t: 'Messages from other sessions', d: 'Choose “Messages” for other sessions to change this.', c: h.seg(['When asked', 'Automatically'], 0) })));
  const mem = h.sec('Voice agent memory', 'Only for Local voice with a Voice agent.', h.sheet(
    h.row({ t: 'Remember past conversations', d: 'Off: it forgets everything when you hang up.', c: h.sw(false) })
    + h.row({ cls: 'vs-dis', t: 'Restore memory by', d: 'Turn on “Remember” to choose.', c: h.seg(['Recent messages', 'Summary + recent', 'Resuming the agent'], 0) })
    + h.row({ cls: 'vs-dis', t: 'Messages to restore', c: stepper('16', 'Messages to restore') })
    + h.row({ t: 'Forget everything now', d: 'Starts the Voice agent fresh. Your sessions are not touched.', c: h.btn('Forget', 'ghost', '', 'sm') })));
  const diag = h.sec('Diagnostic recordings', 'Off by default. For troubleshooting speech; stays on devbox until you export it.', h.sheet(
    h.row({ t: 'Save diagnostic audio on devbox', d: 'Follows your Voice computer. Kept 24 h · up to 20 files · 100 MB.', c: h.sw(false) })
    + h.row({ cls: 'vs-dis', t: 'What to keep', c: h.seg(['What I say', 'What it says', 'Both'], 2) })
    + h.row({ t: 'Recordings on devbox', d: 'None', c: h.btn('Export', 'ghost', '', 'sm') + h.btn('Delete all', 'ghost', '', 'sm') })));
  const links = h.sheet(h.row({ lead: `<span class="xrow-lead" style="color:var(--text2)">${ic('history', '', 'width="18" height="18"')}</span>`, t: 'Voice history', d: '38 conversations · review or delete transcripts', chev: true }) + h.row({ lead: `<span class="xrow-lead" style="color:var(--text2)">${ic('ext', '', 'width="18" height="18"')}</span>`, t: 'Privacy policy', chev: true }));
  return `<div class="page">${head('Privacy & data', 'What your voice service hears and reads, and what Happier keeps.', { crumb: true })}
    ${h.sec('Where your voice goes now', 'For Local voice with a Voice agent. It changes with the service you choose.', flow)}${start}${live}${mem}${diag}${h.sec('More', '', links)}</div>`;
}
function privPhone() {
  return ph('Privacy & data', `${h.sec('When a conversation starts', '', h.sheet(h.row({ t: 'What’s on your screen', d: 'When asked', chev: true }) + h.row({ t: 'Session summaries', c: h.sw(true) }) + h.row({ t: 'Your recent messages', d: 'Last 3', c: h.sw(true) }) + h.row({ t: 'Tool names', d: 'Never arguments or paths', c: h.sw(true) })))}
    ${h.sec('While you talk', '', h.sheet(h.row({ t: 'From the session you’re in', d: 'Messages · 3 per update', chev: true }) + h.row({ t: 'From other sessions', d: 'Activity', chev: true }) + h.row({ t: 'Include what you wrote', c: h.sw(false) })))}
    ${h.sec('Voice agent memory', '', h.sheet(h.row({ t: 'Remember past conversations', c: h.sw(false) })))}`, { back: 'Voice', lede: 'What your voice service hears and reads, and what Happier keeps.' });
}

/* ═══ A · Advanced ═══ */
function advPage() {
  const screen = h.sec(`On screen ${NEW('lane A')}`, 'How a live conversation shows up. Choices follow the voice-presence lab.', h.sheet(
    h.row({ t: 'Start conversations with', d: 'All my sessions: one assistant for everything. The open session: it starts inside that session.', c: h.seg(['All my sessions', 'The open session'], 0) })
    + h.row({ t: 'Show the live conversation', c: h.seg(['Automatic', 'Top bar', 'In the session'], 0) })
    + h.row({ t: 'Show the transcript while talking', c: h.sw(true) })
    + h.row({ t: 'Open it when a conversation starts', c: h.sw(false) })
    + h.row({ t: 'Floating voice orb', d: 'This device only. Voice stays in the composer and top bar.', c: h.sw(false) })));
  const comp = h.sec('Voice computer', 'The computer that runs speech models and signs in to connected accounts for voice. Shared across your devices.', h.sheet(
    h.row({ lead: `<span class="xrow-lead" style="color:var(--text2)">${ic('desktop', '', 'width="18" height="18"')}</span>`, t: 'Automatic · devbox', d: 'Keeps devbox until you choose again. If it goes offline, you pick another.', c: h.sel('Automatic') })));
  const models = h.sec('Speech models on devbox', 'Installed once per computer. Remove one to free space; settings keep your choice.', h.sheet(
    h.row({ lead: `<span class="xrow-lead" style="color:var(--text2)">${MK.neural(18)}</span>`, t: 'Kokoro voice · 82 MB', d: why('Speak · chosen for voice conversations, not installed'), c: h.btn('Install', 'secondary', 'vsDl', 'sm') })
    + h.row({ lead: `<span class="xrow-lead" style="color:var(--text2)">${MK.neural(18)}</span>`, t: 'Zipformer English · 44 MB', d: 'Hear · installed · update available', c: h.btn('Update', 'secondary', '', 'sm') + h.btn('Remove', 'ghost', '', 'sm') })), `<button class="btn ghost sm">${ic('refresh')}Check for updates</button>`);
  const net = h.sec('Connection', '', h.sheet(h.row({ t: 'Give up on a speech request after', d: 'For endpoints and speech models. 1 to 60 seconds.', c: stepper('15 s', 'Speech request timeout') })
    + h.disc('For developers', 'Model source: built-in list', h.row({ t: 'Speech model source', d: 'Built-in list. Set HAPPIER_… on the computer to use your own (shown only here).', c: h.btn('Copy diagnostics', 'ghost', 'copy', 'sm') }), false)));
  return `<div class="page">${head('Advanced', 'Where voice runs, how it shows on screen, and the speech models it uses.', { crumb: true })}${screen}${comp}${models}${net}</div>`;
}
function advPhone() {
  return ph('Advanced', `${h.sec('On screen', '', h.sheet(h.row({ t: 'Start with', d: 'All my sessions', chev: true }) + h.row({ t: 'Show the transcript', c: h.sw(true) }) + h.row({ t: 'Floating voice orb', d: 'This phone only', c: h.sw(false) })))}
    ${h.sec('Voice computer', 'Shared across your devices.', h.sheet(h.row({ t: 'Automatic · devbox', d: 'Until you choose again', chev: true })))}
    ${h.sec('Speech models on devbox', '', h.sheet(h.row({ t: 'Kokoro voice', d: 'Not installed · 82 MB', chev: true }) + h.row({ t: 'Zipformer English', d: 'Update available', chev: true })))}`, { back: 'Voice' });
}

/* ═══ SR · search finds every control, even conditional ones ═══ */
const RES = [
  ['Wait after I stop speaking', 'Voice › Conversations › Hear', 'Hands-free only · now Hold to talk', true],
  ['Ignore speech shorter than', 'Voice › Conversations › Hear', 'Hands-free only'],
  ['Silence before a reply', 'Voice › Conversations › xAI Grok Voice', 'When xAI Grok Voice is the service'],
  ['Padding before speech', 'Voice › Conversations › xAI Grok Voice', 'Turn taking · when xAI is the service'],
];
const resList = (sel = 0) => `<div class="vs-sres"><div class="h">Settings · 4 · also matches by meaning</div>${RES.map(([t, p, c], i) => `<div class="it ${i === sel ? 'on' : ''}">${ic('mic')}<div style="min-width:0"><div class="t">${t.replace(/(silence)/i, '<mark>$1</mark>')}</div><div class="p">${p}</div>${c ? `<div class="p ${i === 0 ? 'warn' : ''}">${c}</div>` : ''}</div></div>`).join('')}</div>`;
function searchPage() {
  const hear = h.sec('Hear', 'How your speech becomes text before the agent reads it.', h.sheet(
    h.row({ t: 'Speech recognition', d: 'This Mac’s speech', c: h.sel('This device', ic('laptop', '', 'width="15" height="15"')) })
    + h.row({ t: 'How you talk', d: 'Hands-free starts and stops on its own.', c: h.seg(['Hold to talk', 'Hands-free'], 0) })
    + `<div class="disc open"><div class="dhead" data-disc>${ic('chevR', 'car')}<div><div class="ttl">Hands-free timing</div></div><span class="sum"></span></div><div class="dbody"><div><div class="inner">${h.row({ cls: 'vs-hl vs-dis', t: 'Wait after I stop speaking', d: why('Choose Hands-free to change this.', 'Switch to Hands-free'), c: stepper('5 s', 'Wait after speaking') })}${h.row({ cls: 'vs-dis', t: 'Ignore speech shorter than', c: stepper('1 s', 'Minimum speech') })}</div></div></div></div>`
    + h.row({ t: 'Interrupt by speaking', c: h.sw(true) })));
  return `<div class="page">${head('Voice conversations', 'Talk to your agents out loud, hands on the keyboard or not.', { crumb: true, actions: chip() })}${hear}</div>`;
}
function searchPhone() {
  return HI.phone({ nav: HI.pnav('Settings', '<a style="font-size:16px;color:var(--blue);font-weight:560">Cancel</a>'), body: `<div class="vs-psrch">${ic('search')}silence<span class="caret"></span></div><div class="vs-pb" style="padding-top:0">${resList(-1)}</div>`, tab: false });
}

/* M (one page) and R (list + detail) alternatives were deleted 2026-11-07 (VOICE-LAB-CLEANUP-1107): unselected, not in
   the plan (VOICE-GAP-1107 NIP). The chosen hub H and its pages stay. */

/* ═══ notes ═══ */
const N = {
  H: `<h3>H · Voice (lead)</h3><p>Identity first: the Daybreak dot planet as one static frame (no rings, no tile, no motion) and one sentence. The hero is <b>the thing itself</b>: each mode's live pipeline, so you see what runs, where, and whether it works before opening anything. Healthy steps are quiet; the one problem (Kokoro missing) carries its fix.</p><p>Privacy, Advanced and History stay one tap away with a value summary. "Try voice" opens lane C's first-run moment.</p><p>Keeps the 4 intents: Dictation and Conversations are the two cards; Privacy &amp; data and Advanced are rows.</p>`,
  C1: `<h3>C1 · Conversations · Local voice (lead)</h3><p><b>Signature:</b> the pipeline card. Hear → Think → Speak, each step with its engine, where it runs and its readiness. A step that needs you shows the exact reason and one action (role readiness from <code>readiness.ts</code>: <i>install_model</i> → Install). Clicking a step scrolls to and opens its section; Install turns into progress in place (see ST).</p><p><b>Service gallery</b>: provider ≠ billing (ElevenLabs once), readiness in each tile footer, Off says Dictation stays.</p><p>Sections follow the card: Hear, Think, Speak, Language. "How you talk" is disabled with its exact prerequisite (audit C-04 fixed: visible for every endpoint-driven engine). Advanced agent behaviour stays closed (C3).</p><p>Runs on chip = the shared execution-machine owner, shown only for routes that need a computer.</p>`,
  C2: `<h3>C2 · Conversations · ElevenLabs</h3><p>One provider, two ways to pay: "Pay with: Happier | My ElevenLabs account". BYO swaps in key + agent id + "Create an agent for me".</p><p>Language honesty: ElevenLabs uses one language, so "Reply in" is a read-only line, not a second control. Greeting and language are tagged <code>fix</code>: the leaf ignores them today (C-02); ship the controls with the fix, never before.</p><p>The pipeline collapses to one step: a realtime service hears, thinks and speaks.</p>`,
  C3: `<h3>C3 · Advanced agent behaviour, in place</h3><p>Every Voice agent knob in words: warm roots, idle TTL (with the real 1 min–6 h bounds), prewarm, teleport, stay-home, commit model, commit isolation, streaming, chunk size. Memory lives in Privacy &amp; data with a link here. The selected Think step shows which part of the pipeline this edits.</p>`,
  ST: `<h3>ST · Every readiness state</h3><p><b>Daybreak grammar, used sparingly</b> (one glyph in each card's status line): Light = ready (lit dot planet), Shadow = waiting on something outside (eclipse: computer offline, server feature off), the 2×4 dot cell = working (installing, checking). Needs-you stays the settings amber dot. All static frames; the dot cell animates only while an install or check is really running, and not under reduced motion.</p><p>The card's states map 1:1 to <code>VoiceRoleReadiness.status/recoveryAction</code>. Fresh Local (C-06) offers the quickest ready alternative only when capability proves it. Checking shows last-known data with its time. Q3's vertical form is the phone's.</p>`,
  D: `<h3>D · Dictation</h3><p>Two-step pipeline (Hear → into your message). Engines are a radio list because each needs its own prerequisite and privacy line. "I dictate in" says plainly that it doesn't follow the conversation language. Today's "Check setup" button becomes the always-on card readiness (same passive facts, no mic, no audio).</p>`,
  P: `<h3>P · Privacy &amp; data</h3><p>Starts with where your voice goes <i>now</i> (from the processing-disclosure owner). Then the three payloads, each with its own limit and name: when a conversation starts (recent messages 3), while you talk (messages per update 3; ongoing snippets moved here from Advanced, C-08), Voice agent memory (restore 16). Diagnostic recordings and history close the page.</p>`,
  A: `<h3>A · Advanced</h3><p>Screen placement (values follow lane A's voice-presence decision), the shared Voice computer with the real sticky-Automatic policy, the speech-model catalog on that computer, and the request timeout. Hidden tunings (poll interval, batch size, stream/bootstrap timeouts, home folder) stay out of the UI.</p>`,
  SR: `<h3>SR · Search reaches everything</h3><p>Every rendered control is declared, including conditional ones (C-05). A hit on a control that isn't usable now lands on it with the exact prerequisite and the switch to make it usable. Results say which service a provider-specific control belongs to.</p>`,
};

const pair = (id, label, d) => ({ [id]: { label, h: d.h, html: d.desk, notes: N[id] }, [id + 'p']: { label: `${label.split(' · ')[0]} · 390`, phone: true, html: d.phone, notes: N[id] } });
S['voice-settings'] = {
  title: 'Voice settings',
  subtitle: 'Settings → Voice: per-mode pipeline cards, service gallery, honest language, every control placed',
  def: 'H',
  variants: {
    ...pair('H', 'H · Hub (lead)', { h: 1060, desk: (s) => desk(s, 'vsHub', hubPage()), phone: hubPhone }),
    ...pair('C1', 'C1 · Conversations · Local', { h: 2220, desk: (s) => desk(s, 'vsConv', convLocal()), phone: convLocalPhone }),
    ...pair('C2', 'C2 · ElevenLabs', { h: 1900, desk: (s) => desk(s, 'vsConv', convEleven()), phone: convElevenPhone }),
    ...pair('C3', 'C3 · Think', { h: 2200, desk: (s) => desk(s, 'vsConv', convAgent()), phone: convAgentPhone }),
    ST: { label: 'ST · States', board: true, html: statesBoard, notes: N.ST },
    ...pair('D', 'D · Dictation', { h: 1180, desk: (s) => desk(s, 'vsDict', dictPage()), phone: dictPhone }),
    ...pair('P', 'P · Privacy & data', { h: 2180, desk: (s) => desk(s, 'vsPriv', privPage()), phone: privPhone }),
    ...pair('A', 'A · Advanced', { h: 1240, desk: (s) => desk(s, 'vsAdv', advPage()), phone: advPhone }),
    ...pair('SR', 'SR · Search', { h: 900, desk: (s) => desk(s, 'vsConv', searchPage(), { q: 'silence', results: resList(0) }), phone: searchPhone }),
  },
};
})();
