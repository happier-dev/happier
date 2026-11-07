/* ───────────── PROVIDERS · GATEWAYS · ROUTING (2026-10-09, lane `lab`) ─────────────
 * Reference frames for plan .project/plans/2026-10-09-providers-gateway-routing (units R1, G2, M1) and the
 * owner decisions D3–D11 in .project/reviews/2026-10-09-providers-audit/DECISIONS.md.
 * Reuses the settings lab kit: xRail / cdWide / xHeader / emptyState / xChip (craft pass), h.sec / h.sheet /
 * h.row / h.sw / h.seg / h.disc / h.btn / h.pill (kit), .xpop, .xban, .xst, .xinl, .xadd, phone .pnav.
 * New here (routing.css): the composer with its chips and the Agent + model picker popover — both exist in the
 * app (AgentInput, SessionModelPicker in OptionPickerOverlay) but had no drawing in this lab.
 */
(() => {
Object.assign(P, {
  rGate: '<path d="M3.5 7H7c3.200 0 3.800 5 7 5h6.500M3.500 17H7c3.200 0 3.800-5 7-5"/><path d="m17.500 9 3 3-3 3"/>',
  rStar: '<path d="m12 3.8 2.5 5.2 5.7.8-4.1 4 1 5.700-5.100-2.700-5.100 2.700 1-5.700-4.100-4 5.700-.800L12 3.800Z"/>',
  rEyeOff: '<path d="M4 4l16 16"/><path d="M10 5.700a9.400 9.400 0 0 1 2-.200c6 0 9.500 6.500 9.500 6.500a17 17 0 0 1-2.900 3.600M6.400 7.500C3.900 9.300 2.500 12 2.500 12S6 18.500 12 18.500c1.300 0 2.500-.300 3.500-.800"/><path d="M9.900 9.900a3 3 0 0 0 4.200 4.200"/>',
  rUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  rSub: '<path d="M6 4v8a4 4 0 0 0 4 4h9M16 13l3 3-3 3"/>',
  rPlayC: '<circle cx="12" cy="12" r="9"/><path d="m10.200 8.600 5 3.400-5 3.400Z"/>',
});

/* ── copy deck: every user-facing string that is new or changed lives here (mirrored in lanes/lab.md) ── */
const C = {
  viaNote: 'Hidden here: Main gateway, OpenRouter — Work',
  browse: 'Browse sources',
  consequence: 'Native subagent models follow Agent definitions.',
  hiddenScope: 'Hidden from the main picker',
  allShown: 'All shown sources',
  browsing: (s) => `Browsing <b>${s}</b>`,
  runsSub: (a) => `Where ${a} gets its models for this session.`,
  showPicker: 'Show in model picker',
  showOnDirect: (n) => `On by default for direct providers. ${n}’s models appear in every agent that can run them.`,
  showOffAgg: 'Off by default for providers that list many models. They stay available from Runs through.',
  showOffGw: 'Off by default for gateways, so the same models don’t appear twice. They stay available from Runs through.',
  showOnLocal: 'On by default for models that run on your computers.',
  noComputerProv: 'No computer selected. Choose one to test this connection or change how it’s reached.',
  noComputerAgent: 'No computer selected. Choose one to check the CLI or sign in.',
  noComputerRail: 'Choose a computer to see Ollama and LM Studio.',
};

/* ── small helpers ── */
const mk = (k, s = 18, cls = '') => `<span class="rt-mk ${cls}" style="width:${s}px;height:${s}px">${BRAND[k] ? BRAND[k](s) : ic(k, '', `width="${s}" height="${s}"`)}</span>`;
const lead = (k, s = 18) => `<span style="width:28px;display:grid;place-items:center;flex:none;color:var(--text2)">${BRAND[k] ? BRAND[k](s) : ic(k, '', `width="${s}" height="${s}"`)}</span>`;
const star = (on) => `<span class="rt-star ${on ? 'on' : ''}" aria-label="Favorite">${ic('rStar', '', 'width="15" height="15"')}</span>`;
const sel = (v, leadHtml = '', o = {}) => `<button class="sel w ${o.full ? 'full' : ''}">${leadHtml}<span style="flex:1;text-align:left;${o.muted ? 'color:var(--text2)' : ''}">${v}</span>${ic('chevUD')}</button>`;
const val = (t, icon = '') => `<span class="rt-val">${icon ? ic(icon) : ''}${t}</span>`;
const pane = (inner) => `<div class="xpage xpane" style="max-width:720px;padding-left:56px;padding-right:64px;margin:0">${inner}</div>`;
const pnav = (back, act = '') => `<div class="pnav"><div class="row1"><span class="back">${ic('back', '', 'width="20" height="20"')}${back}</span>${act}</div></div>`;
const pmore = () => ic('more', '', 'width="22" height="22" style="color:var(--blue)"');
const pbody = (inner) => `<div class="x-pbody rt-pbody">${inner}</div>`;
/* a row whose control is wider than a switch/short value: beside the label on desktop, beneath it on phones */
const R = (ph, o) => (ph && o.wide)
  ? `<div class="row stack ${o.cls || ''}"><div class="lbl"><div class="ttl">${o.lead ? o.lead.replace('width:28px', 'width:20px') : ''}${o.t}</div>${o.d ? `<div class="dsc">${o.d}</div>` : ''}</div>${o.c}</div>`
  : h.row({ ...o, t: `${o.mark || ''}${o.t}` });
const sec = (title, desc, body, action = '') => h.sec(title, desc, body, action);

/* ═════════════ composer, chips, picker, sources popover ═════════════ */
const AGN = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini' };
function chip(icon, label, o = {}) { return `<span class="rt-chip ${o.open ? 'open' : ''}">${icon}${label}</span>`; }
function routeChip(o) {
  const label = o.armed
    ? `<span><span class="q">Next via</span> ${o.armed}</span>`
    : o.inherit ? `<span><span class="q">Inherit session ·</span> ${o.runs}</span>`
    : `<span><span class="q">Runs through</span> ${o.runs}</span>`;
  return `<span style="position:relative;display:inline-flex">${chip(ic(o.inherit ? 'rSub' : 'rGate'), label, { open: o.runsOpen })}${o.runsOpen ? o.pop || '' : ''}</span>`;
}
function comp(o = {}) {
  const a = o.agent || 'claude';
  const txt = o.text ? `<div class="ph has">${o.text}</div>` : `<div class="ph">${o.ph || 'What should we work on?'}</div>`;
  const chips = [
    chip(`<span class="mk">${BRAND[a](17)}</span>`, o.noModel ? AGN[a] : `${AGN[a]} · ${o.model || 'Fable 5.1'}`, { open: o.agentOpen }),
    routeChip(o),
    o.lean ? '' : chip(ic('shield'), 'Default permissions'),
    o.lean ? '' : chip(ic('laptop'), 'MacBook Pro'),
    o.lean || o.session ? '' : chip(ic('folder'), 'happier'),
  ].join('');
  const send = o.sendLabel ? `<span class="rt-send wide">${o.sendLabel}</span>` : `<span class="rt-send">${ic('rUp')}</span>`;
  return `<div class="rt-comp">${txt}<div class="rt-chips">${chips}<span class="grow"></span>${send}</div>${o.agentOpen ? o.pop || '' : ''}</div>`;
}
function appFrame(inner, { session = false } = {}) {
  return `<div class="rt-app">${appSidebar('')}<main class="rt-main"><div class="rt-col ${session ? 'session' : ''}">${session ? '' : '<h1 class="rt-hello">Good afternoon, Leeroy</h1>'}${inner}</div></main></div>`;
}

/* Engine popover (D13): today's anatomy — SessionModelPicker in OptionPickerOverlay with `multiColumn`.
 * Agent rail on the left; on the right the "Model" title with the running / applies-next status line and the
 * refresh control, the search field, then a two-column grid of model cards. The selected card is filled and
 * expands in place with its own options (Thinking effort, Ultracode). Notes sit in the reserved footer under the
 * grid. Design A adds only: source section headings, "· via <source>" on cards whose name exists under more
 * than one source, the hidden-sources footer line, and the scope bar when browsing one source from Runs through. */
const EP_AGENTS = [['claude', 'Claude'], ['codex', 'Codex'], ['opencode', 'OpenCode'], ['gemini', 'Gemini'], ['copilot', 'Copilot'], ['cursor', 'Cursor']];
const epRail = (sel) => `<div class="ar ep-rail">${EP_AGENTS.map(([id, nm]) => `<div class="ep-ag ${id === sel ? 'on' : ''}"><span class="mk">${BRAND[id](id === 'opencode' ? 16 : 19)}</span><span class="nm">${nm}</span>${id === sel ? ic('check', 'ck') : ''}</div>`).join('')}</div>`;
const epOpts = (o = {}) => `<div class="ep-opt"><div class="ep-ol">Thinking</div>${h.seg(['Low', 'Medium', 'High', 'XHigh', 'Max'], o.effort ?? 2, 'sm')}</div>` +
  (o.ultra === false ? '' : `<div class="ep-opt ep-ultra"><div class="b"><div class="ep-ol">Ultracode</div><div class="ep-od">Maximum reasoning with dynamic workflows (forces XHigh effort). Applies to the current session only.</div></div>${h.sw(false)}</div>`);
/* card: n name, d description, via source (ambiguous names only), on selected (+ opts), run = reported running */
const card = (n, o = {}) => `<div class="ep-card ${o.on ? 'on' : ''} ${o.kb ? 'kb' : ''}"><div class="ep-ct"><div class="ep-cn"><span class="nm">${n}</span>${o.via ? ` <span class="via">· via ${o.via}</span>` : ''}</div>${o.on ? `<span class="ep-ci">${ic('check')}${o.run ? ic('rPlayC') : ''}</span>` : ''}</div>${o.d ? `<div class="ep-cd">${o.d}</div>` : ''}${o.on && o.opts !== false ? epOpts(o) : ''}</div>`;
/* the grid fills two independent columns in reading order, like the app's column variant; phones get one */
const cols = (cards, n = 2) => `<div class="ep-cols" style="grid-template-columns:repeat(${n},minmax(0,1fr))">${Array.from({ length: n }, (_, c) => `<div>${cards.filter((_, i) => i % n === c).join('')}</div>`).join('')}</div>`;
const epSec = (title, markKey, cards, n = 2) => `${title ? `<div class="ep-sh">${markKey ? `<span class="mk">${BRAND[markKey] ? BRAND[markKey](13) : ic(markKey, '', 'width="13" height="13"')}</span>` : ''}${title}</div>` : ''}${cols(cards, n)}`;
const epFoot = (icon, text, link = '') => `<div class="ep-foot">${ic(icon)}<span>${text}</span>${link ? `<a>${link}</a>` : ''}</div>`;
const epFind = (ph, q = '') => `<div class="ep-find ${q ? 'has' : ''}">${q ? `<span>${q}</span><span class="caret"></span>` : `<span>${ph}</span>`}</div>`;
const epHead = (status) => `<div class="ep-hd"><div class="t"><div class="ep-ttl">Model</div><div class="ep-st">${status}</div></div><span class="ep-rf" aria-label="Refresh models">${ic('refresh')}</span></div>`;
const epScope = (src) => `<div class="ep-scope"><span class="bk" aria-label="${C.allShown}">${ic('back')}</span><span class="tx">${C.browsing(src)}<span class="dot">·</span><span class="q">${ic('rEyeOff')}${C.hiddenScope}</span></span>${h.pill('Experimental', 'line')}</div>`;
function engine(o) {
  return `<div class="rt-pick ep" style="${o.style || 'bottom:calc(100% + 8px);left:0'};height:${o.h || 600}px">${epRail(o.agent)}<div class="ep-pane">${epHead(o.status)}${o.scope ? epScope(o.scope) : ''}${epFind(o.ph || 'Search models…', o.q)}<div class="ep-body">${o.body}</div>${o.foot || ''}</div></div>`;
}
const RUN = (model) => `Running: ${model} · Applies from your next message`;

/* model data, copied from today's Claude Code catalog descriptions */
const CL = {
  cli: (o) => card('Use CLI settings', { d: 'Configure models in CLI settings', ...o }),
  haiku: (o) => card('Haiku 5.5', o),
  sonnet: (o) => card('Sonnet 5.5', o),
  opus: (o) => card('Opus 5.5', { d: 'Latest Opus model for long-running agentic coding and knowledge work.', ...o }),
  fable: (o) => card('Fable 5.1', { d: 'Latest Claude model for demanding reasoning and long-running agentic work.', ...o }),
  opus5: (o) => card('Opus 5', { d: 'Prior Opus model for complex coding and reasoning tasks.', ...o }),
  sonnet5: (o) => card('Sonnet 5', { d: 'Latest balanced Claude model with the best combination of speed and intelligence.', ...o }),
  fable5: (o) => card('Fable 5', { d: 'Prior Fable model for demanding coding and reasoning tasks.', ...o }),
  opus48: (o) => card('Opus 4.8', { d: 'Prior highest-capability Claude model for the hardest coding and reasoning tasks.', ...o }),
  sonnet46: (o) => card('Sonnet 4.6', { d: 'Prior balanced Claude model for everyday coding.', ...o }),
};
const SEL = { on: true, run: true };
const EP = {
  /* MP3 parity: one native group, no heading (as today), no footer */
  claudeToday: (n = 2) => epSec('', '', [CL.cli(), CL.haiku(), CL.sonnet(), CL.opus(SEL), CL.fable(), CL.opus5(), CL.sonnet5(), CL.fable5(), CL.opus48(), CL.sonnet46()], n),
  /* MP1: Favorites, the Agent's own subscription, a shown direct source. Sonnet 5.5 exists in two sources → both say where. */
  claudeAll: (n = 2) =>
    epSec('Favorites', '', [CL.opus(SEL), card('Sonnet 5.5', { via: 'OpenRouter — Work' }), card('DeepSeek V4 Pro', { d: 'DeepSeek’s strongest model for coding and reasoning.' })], n) +
    epSec('Claude subscription · Work pool', 'claude', [CL.cli(), CL.haiku(), CL.sonnet({ via: 'Claude subscription' }), CL.fable(), CL.opus5(), CL.sonnet5(), CL.fable5(), CL.opus48()], n) +
    epSec('DeepSeek', 'deepseek', [card('DeepSeek V4 Flash', { d: 'Fast, low-cost model for everyday tasks.' })], n),
  claudeSearch: () =>
    epSec('Favorites', '', [card('Sonnet 5.5', { via: 'OpenRouter — Work', kb: true })]) +
    epSec('Claude subscription · Work pool', 'claude', [CL.sonnet({ via: 'Claude subscription' }), CL.sonnet5(), CL.sonnet46()]),
  /* RT2: one source, grouped by the subscription serving each model; nothing selected here yet */
  gateway: (n = 2) =>
    epSec('ChatGPT · Codex pool', 'codex', [card('GPT-6.1 Sol', { d: 'Frontier model for complex, long-running coding work.' }), card('GPT-6.1 Luna', { d: 'Fast, efficient model for everyday coding tasks.' }), card('GPT-6 Codex', { d: 'Prior coding-tuned model.' })], n) +
    epSec('Claude · Work pool', 'claude', [CL.fable(), CL.opus(), CL.sonnet(), CL.haiku()], n),
};
function TXC() { return `<div class="rt-tx"><div class="me">Tighten the pairing retry loop and add a test for the timeout path.</div><div class="ag"><div class="who">${BRAND.claude(14)}<span>Claude Code</span></div>The retry loop now backs off from the server’s hint instead of a fixed delay, and a new test covers the timeout path. The pairing suite passes.</div></div>`; }
const it = (o) => `<div class="it ${o.on ? 'on' : ''} ${o.dis ? 'dis' : ''}"><span class="mk">${o.mk}</span><span class="grow"><b>${o.t}</b>${o.d ? `<span class="sub">${o.d}</span>` : ''}</span>${o.end === 'check' ? `<span class="end ck">${ic('check')}</span>` : o.end === 'chev' ? `<span class="end">${ic('chevR')}</span>` : o.end ? `<span class="sub">${o.end}</span>` : ''}</div>`;
function srcPop(o = {}) {
  const armed = o.armed ? `<div class="rt-armed">Switches to ${o.armed} with your next message. Nothing is sent until then.</div>` : '';
  const nat = it({ mk: ic('key'), t: 'Account default', d: 'Codex pool · set in Connected services', end: 'check', on: true }) +
      it({ mk: ic('stack'), t: 'Codex pool', d: 'Personal, then Bot · 71% left' }) +
      it({ mk: ic('user'), t: 'Personal', d: 'Pro · 71% left' }) +
      it({ mk: ic('user'), t: 'Bot', d: 'Plus · 100% left' });
  return `<div class="xpop rt-src" style="${o.style || 'top:36px;left:0'}">${o.bare ? '' : `<div class="pph"><b>Runs through</b><span>${C.runsSub('Codex')}</span></div>`}${armed}
    <div class="lbl2"><span>ChatGPT subscription</span></div>${nat}
    <div class="lbl2"><span>Gateways</span></div>
    ${it({ mk: ic('rGate'), t: 'Main gateway', d: 'ChatGPT and Claude · on MacBook Pro', end: 'chev' })}
    <div class="lbl2"><span>Providers</span></div>
    ${it({ mk: BRAND.openrouter(17), t: 'OpenRouter — Work', d: '312 models · hidden from the main picker', end: 'chev' })}
    ${it({ mk: BRAND.ollama(18), t: 'Ollama', d: '4 models · on MacBook Pro', end: 'chev' })}
    ${it({ mk: BRAND.deepseek(18), t: 'DeepSeek', d: 'Works with Claude Code and OpenCode', dis: true })}
  </div>`;
}
const TX = () => `<div class="rt-tx"><div class="me">Move the pairing tests to the new harness and keep the old fixtures green.</div><div class="ag"><div class="who">${BRAND.codex(14)}<span>Codex</span></div>I moved 14 pairing tests onto the shared harness and kept the two legacy fixtures behind their existing loader. The full pairing suite passes; one unrelated flaky test is quarantined with a note.</div></div>`;

S.rpicker = {
  craft: true, def: 'MP1',
  title: 'Model picker', subtitle: 'Routing · today’s engine popover + Design A additions (D7, D8, D13) · plan unit R1',
  variants: {
    MP1: {
      label: 'MP1 · Today’s popover + source headings', app: true,
      html: () => appFrame(TXC() + comp({ agent: 'claude', model: 'Opus 5.5', runs: 'Claude · Work pool', agentOpen: true, session: true, ph: 'Message this session…', pop: engine({ agent: 'claude', status: RUN('Opus 5.5'), body: EP.claudeAll(), foot: epFoot('rEyeOff', C.viaNote, C.browse), h: 640 }) }), { session: true }),
      notes: `<h3>MP1 · Today’s engine popover, with sources named</h3>
<p>D13: the popover keeps its anatomy exactly — Agent rail, “Model” with the running / applies-next line and refresh, search, a two-column grid of model cards, and the selected card filled and expanded in place with its own Thinking effort and Ultracode. Design A (D7, D8) only <b>adds</b> to it.</p>
<h4>What is added</h4><ul>
<li><b>Source headings</b> above each group of cards, in the list’s existing sentence-case section header: <b>Favorites</b>, the Agent’s own subscription (<b>Claude subscription · Work pool</b>, the same words the Runs through chip uses), and each shown direct source (<b>DeepSeek</b>). They appear only when there is more than one group; with one, the grid stays headless as today (MP3).</li>
<li><b>“· via &lt;source&gt;”</b> only on cards whose model name exists under more than one source — here both “Sonnet 5.5” cards. DeepSeek V4 Pro is unambiguous and carries nothing.</li>
<li>The reserved footer under the grid carries one line: <b>Hidden here: Main gateway, OpenRouter — Work</b> + <b>Browse sources</b> (opens Runs through, RT1). OpenRouter’s favorite stays visible although its source is off (D8 exception).</li></ul>
<h4>Unchanged</h4><ul><li>Rail, header and status line, refresh, search, card styling and spacing, the selected card’s ✓ and running mark, Thinking segments and the Ultracode switch inside the card. Provider-model cards have no in-card options, as today.</li>
<li>Picking a card commits model and source in one tap; the Runs through chip’s label cross-fades (opacity only). The popover keeps its height; one scroller.</li></ul>
<p><b>Owner:</b> <code>SessionModelPicker</code> → <code>OptionPickerOverlay multiColumn</code>; section titles from <code>buildSessionModelPickerSections</code>; the footer is the overlay’s existing grid notes slot.</p>`,
    },
    MP2: {
      label: 'MP2 · Search', app: true,
      html: () => appFrame(TXC() + comp({ agent: 'claude', model: 'Opus 5.5', runs: 'Claude · Work pool', agentOpen: true, session: true, ph: 'Message this session…', pop: engine({ agent: 'claude', status: RUN('Opus 5.5'), q: 'sonnet', body: EP.claudeSearch(), foot: epFoot('rEyeOff', C.viaNote, C.browse), h: 640 }) }), { session: true }),
      notes: `<h3>MP2 · Search filters the same grid</h3><ul>
<li>Search filters cards in place, as today; the source headings that still have matches stay, so results keep saying where they come from. “· via” follows the same rule as MP1 (both Sonnet 5.5 cards).</li>
<li>Hidden sources stay out of results, except favorites and the current model (D8). The footer names hidden sources and keeps Browse sources available; it does not count per-query matches inside them.</li>
<li>The popover keeps its height while results narrow; the first card is keyboard-highlighted; Esc clears the query first, then closes.</li></ul>`,
    },
    MP3: {
      label: 'MP3 · Nothing extra connected', app: true,
      html: () => appFrame(TXC() + comp({ agent: 'claude', model: 'Opus 5.5', runs: 'Claude · Work pool', agentOpen: true, session: true, ph: 'Message this session…', pop: engine({ agent: 'claude', status: RUN('Opus 5.5'), body: EP.claudeToday(), h: 640 }) }), { session: true }),
      notes: `<h3>MP3 · Parity: today’s popover, unchanged</h3><p>With no providers or gateways connected, nothing is added: one headless group of cards, no “via”, no footer line. This frame must match today’s popover (owner screenshot <code>scratch/engine-popover-current.png</code>) and is the implementation’s parity check.</p>`,
    },
    MP1p: {
      label: 'MP1 · 390', phone: true,
      html: () => `<div class="rt-pstage"><div class="dim"></div><div class="rt-psheet ep-psheet" style="top:56px"><div class="hd"><span class="bk">${ic('back')}Agents</span><h3 style="text-align:center">Claude</h3><span class="x">${ic('x')}</span></div>${epHead(RUN('Opus 5.5'))}${epFind('Search models…')}<div class="ep-body">${EP.claudeAll(1)}</div>${epFoot('rEyeOff', C.viaNote, C.browse)}</div></div>`,
      notes: `<h3>Phone · the same cards, one column</h3><ul><li>The grid resolves to one column at phone width; cards, the selected card’s in-card options, headings, “via” and the footer line are the same as on desktop.</li><li>The Agent rail is the sheet’s first page (Agents); choosing one pushes its models. Back returns to Agents.</li><li>One scroller; the footer line stays pinned at the bottom of the sheet.</li></ul>`,
    },
  },
};

S.rruns = {
  craft: true, def: 'RT1',
  title: 'Runs through', subtitle: 'Routing · the chip, its sources and honest states (D6, D9) · plan units R1, R2',
  variants: {
    RT1: {
      label: 'RT1 · Chip + sources', app: true,
      html: () => appFrame(comp({ agent: 'codex', model: 'GPT-6.1 Sol', runs: 'ChatGPT · Codex pool', runsOpen: true, pop: srcPop() })),
      notes: `<h3>RT1 · “Runs through” says where the model really comes from</h3>
<p>The existing sign-in chip (<code>createConnectedServicesAuthActionChip</code>) stops describing only the native account. It now reads the selected model’s real source (D6).</p>
<h4>Chip labels</h4><ul>
<li>Native: <code>Runs through ChatGPT · Codex pool</code>, <code>… ChatGPT · Personal</code>, <code>… ChatGPT · Account default</code>.</li>
<li>Gateway: <code>Runs through Main gateway</code>. Provider: <code>Runs through DeepSeek</code>, <code>Runs through OpenRouter — Work</code>.</li>
<li>“Runs through” is medium weight, the source is semibold: the eye lands on the fact.</li></ul>
<h4>Popover</h4><ul>
<li>Three groups in the order people think: the agent’s <b>own subscription</b> (account default, accounts, pools — the existing credential choice, applied on tap), <b>Gateways</b>, <b>Providers</b>.</li>
<li>Gateways and providers carry a chevron: tapping one <i>browses its models</i> (RT2). It changes nothing by itself; only a model pick does.</li>
<li>A source that this agent can’t use stays listed, dimmed, and says which agents it works with. Nothing is hidden to look tidy, and nothing pretends to work.</li>
<li>Hidden sources are reachable here and say so in their subtitle.</li></ul>
<h4>Motion</h4><p>Popover grows from the chip (existing popover transition). Pushing into a source slides the content left 12px with a cross-fade inside the same surface; the surface resizes once to the picker’s size, never per row.</p>`,
    },
    RT2: {
      label: 'RT2 · Browsing one source', app: true,
      html: () => appFrame(TX() + comp({ agent: 'codex', model: 'GPT-6.1 Sol', runs: 'ChatGPT · Codex pool', agentOpen: true, session: true, ph: 'Message this session…', pop: engine({ agent: 'codex', status: RUN('GPT-6.1 Sol'), scope: 'Main gateway', ph: 'Search Main gateway…', body: EP.gateway(), foot: epFoot('info', C.consequence), h: 640 }) }), { session: true }),
      notes: `<h3>RT2 · The same popover, scoped to one source</h3><ul>
<li>Choosing a gateway or provider in Runs through opens <b>the same engine popover</b> — rail, header, status line, search, card grid — with one scope bar under the header: back (to all shown sources), <b>Browsing Main gateway · Hidden from the main picker</b>, and the Experimental tag. No second picker component.</li>
<li>Cards are grouped by the subscription that serves them (“ChatGPT · Codex pool”, “Claude · Work pool”), so a Claude model in Codex is visibly a Claude-subscription request. Inside one source no card needs “· via”.</li>
<li><b>Nothing has changed yet.</b> No card is selected here; the status line still reads Running: GPT-6.1 Sol and the composer chips are unchanged. Picking a card commits model and source; Esc, click-away or back leaves the session as it was. Scope is local to the popover and forgotten on close.</li>
<li>The reserved footer carries the gateway’s one consequence line: <b>Native subagent models follow Agent definitions.</b> Experimental sources keep their confirmation step on pick (existing controller).</li></ul>`,
    },
    RT3: {
      label: 'RT3 · Running session, change armed (D15)', app: true,
      html: () => appFrame(TX() + comp({ agent: 'codex', model: 'Fable 5.1', runs: 'ChatGPT · Codex pool', armed: 'Main gateway', sendLabel: 'Continue via Main gateway', runsOpen: true, session: true, text: 'Now add the migration tests.', pop: srcPop({ armed: 'Main gateway', style: 'bottom:38px;left:0' }) }), { session: true }),
      notes: `<h3>RT3 · A change waits for the next message (D15)</h3><ul>
<li>Picking another route or model in a running session <b>arms</b> it, exactly like switching Agent: nothing restarts and nothing is sent yet. The chip says <code>Next via Main gateway</code>; the row that is serving now keeps its check.</li>
<li>The send control becomes <b>Continue via Main gateway</b>. Sending restarts the Agent on the new route, then delivers the message through the ordinary path. A turn still running refuses, as it does for an Agent switch.</li>
<li>The popover opens with one quiet line: <b>Switches to Main gateway with your next message. Nothing is sent until then.</b> Picking the current route again un-arms it. No Now/Next block, no Restart/Keep buttons, no amber state.</li>
<li>Motion: the chip label cross-fades between Runs through and Next via; the send control widens to its words once, from the same box.</li></ul>
<p><b>Owner:</b> the armed-switch presentation (<code>agentContinuationSubmitPresentation</code>) and <code>resolveSessionRoutePresentation</code> (chip); the restart is the existing provider-binding restart. Supersedes the Now/Next design (lab outdated after D15).</p>`,
    },
    RT4: {
      label: 'RT4 · Child runs', app: true,
      html: () => appFrame(`<div class="rt-tx" style="gap:10px"><div class="rt-cap">Runs in this session</div><div class="rt-runs">
        <div class="rt-run"><span class="mk">${BRAND.codex(17)}</span><div class="b"><div class="t">Review the pairing diff</div><div class="r"><b>Inherit session</b> · Main gateway · Fable 5.1</div></div><span class="xst ok"><i></i>Working</span></div>
        <div class="rt-run"><span class="mk">${BRAND.codex(17)}</span><div class="b"><div class="t">Write migration tests</div><div class="r"><b>Chosen for this run</b> · ChatGPT · Codex pool · GPT-6.1 Luna</div></div><span class="xst off"><i></i>Done</span></div>
        <div class="rt-run"><span class="mk">${BRAND.codex(17)}</span><div class="b"><div class="t">Explore the harness <span style="color:var(--text3);font-weight:400">· native subagent</span></div><div class="r">Main gateway · model from its Agent definition</div></div><span class="xst off"><i></i>Done</span></div>
        <div class="rt-run ask"><span class="mk">${BRAND.gemini(17)}</span><div class="b"><div class="t">Summarize the changes</div><div class="r">Gemini can’t run through Main gateway. Choose a model for this run.</div></div>${h.btn('Choose', 'secondary', '', 'sm')}</div>
      </div></div><div class="rt-cap">New run</div>` +
        comp({ agent: 'codex', noModel: true, runs: 'Main gateway · Fable 5.1', inherit: true, runsOpen: true, session: true, lean: true, ph: 'What should this run do?', pop: `<div class="xpop rt-src" style="bottom:38px;left:0;width:324px">${it({ mk: ic('rSub'), t: 'Inherit session', d: 'Main gateway · Fable 5.1', end: 'check', on: true })}${it({ mk: ic('rGate'), t: 'Choose for this run', d: 'Pick a model and where it runs through', end: 'chev' })}</div>` }), { session: true }),
      notes: `<h3>RT4 · Children say what they inherited</h3><ul>
<li>A child launched from a session with no explicit choice shows <b>Inherit session · &lt;route&gt; · &lt;model&gt;</b> — the parent’s <i>applied</i> route and model, spelled out (D9). It is the default row of the launcher’s route chip; “Choose for this run” opens the normal picker.</li>
<li>Run summaries carry the resolved values: inherited, <b>Chosen for this run</b> (explicit override), a native subagent (route inherited, model from its Agent definition), and the honest refusal when another Agent can’t use the parent’s route — with the one action that resolves it. No silent fallback to another model or to native billing.</li>
<li>Route line is secondary ink on one line; it truncates from the right, keeping the “Inherit session” prefix.</li></ul>
<p><b>Owner:</b> existing execution-run summary presenters and the delegate / plan / review launchers; the values come from host admission (plan R2), never copied by the UI.</p>`,
    },
    RT1p: {
      label: 'RT1 · 390', phone: true,
      html: () => `<div class="rt-pstage"><div class="dim"></div><div class="rt-psheet" style="top:130px"><div class="hd"><h3>Runs through</h3><span class="x">${ic('x')}</span></div><div class="sub">${C.runsSub('Codex')}</div>${srcPop({ bare: true })}</div></div>`,
      notes: `<h3>Phone · sources as a sheet</h3><p>Same three groups in a bottom sheet; rows are 52px with the subtitle on its own line. On the composer the chip shortens to its source (“Codex pool”, “Main gateway”) because the route glyph already says “runs through”; the full sentence is the chip’s accessibility label.</p>`,
    },
    RT2p: {
      label: 'RT2 · 390', phone: true,
      html: () => `<div class="rt-pstage"><div class="dim"></div><div class="rt-psheet ep-psheet" style="top:56px"><div class="hd"><span class="bk">${ic('back')}Sources</span><h3 style="text-align:center">Main gateway</h3><span class="x">${ic('x')}</span></div>${epHead(RUN('GPT-6.1 Sol'))}<div class="ep-pscope">${ic('rEyeOff')}<span>${C.hiddenScope}</span></div>${epFind('Search Main gateway…')}<div class="ep-body">${EP.gateway(1)}</div>${epFoot('info', C.consequence)}</div></div>`,
      notes: `<h3>Phone · pushed source, same cards</h3><p>Choosing a source pushes its cards inside the same sheet, one column. The sheet header’s back returns to Sources with nothing changed; the sheet title already names the source being browsed, so the scope line only adds <b>Hidden from the main picker</b> (no repeated name).</p>`,
    },
  },
};

/* ═════════════ settings: rails ═════════════ */
const ritem = (markHtml, name, sub, o = {}) => `<div class="ritem ${o.on ? 'on' : ''}"><span style="width:28px;height:28px;display:grid;place-items:center;flex:none;color:var(--text2)">${markHtml}</span><div style="min-width:0;flex:1"><div class="nm">${name}</div><div class="sub">${o.warn ? '<span class="dot warn" style="width:6px;height:6px;margin-right:5px;vertical-align:1px"></span>' : ''}${sub}</div></div></div>`;
const gl = (t, n = '') => `<div class="glabel"><span>${t}</span><span class="tnum">${n}</span></div>`;
const gI = (n, s = 18) => ic(n, '', `width="${s}" height="${s}"`);
function csRail(selId, o = {}) {
  const gwSub = o.gw === 'off' ? 'Unavailable · Studio offline' : o.gw === 'idle' ? 'Idle' : 'Running · MacBook Pro';
  return xRail({ title: 'Connected services', search: true, body:
    gl('Services', 3) +
    ritem(BRAND.claude(20), 'Claude', '3 accounts', { on: selId === 'claude' }) +
    ritem(BRAND.codex(20), 'ChatGPT', '3 accounts · 1 needs sign-in', { warn: true }) +
    ritem(BRAND.anthropic(18), 'Anthropic API key', '1 key') +
    gl('Pools', 2) +
    ritem(gI('stack'), 'Work pool', 'Claude · 3 accounts', { on: selId === 'work' }) +
    ritem(gI('stack'), 'Codex pool', 'ChatGPT · 2 accounts') +
    gl('Gateways', 1) +
    ritem(gI('rGate'), 'Main gateway', gwSub, { on: selId === 'gw', warn: o.gw === 'off' }) });
}
function pvRail(selId, o = {}) {
  const mach = o.machine || 'ok';
  const local = mach === 'ok'
    ? gl('On MacBook Pro', 2) + ritem(BRAND.ollama(20), 'Ollama', 'Running · 4 models', { on: selId === 'ollama' }) + ritem(BRAND.lmstudio(18), 'LM Studio', 'Not running', { warn: true })
    : mach === 'none'
      ? gl('On a computer') + `<div class="xinl"><span class="grow">${C.noComputerRail}</span></div><div style="padding:0 6px">${h.btn('Choose computer', 'secondary', '', 'sm')}</div>`
      : gl('On devbox') + `<div class="xinl"><span class="grow">devbox is offline. Ollama and LM Studio can’t be checked.</span></div>`;
  return xRail({ title: 'Providers', count: o.draft ? 3 : mach === 'ok' ? 5 : 3, body:
    (o.draft ? ritem(BRAND[o.draft](20), o.draft === 'deepseek' ? 'DeepSeek' : 'OpenRouter', 'Draft', { on: true }) : '') +
    (o.draft === 'deepseek' ? '' : ritem(BRAND.deepseek(20), 'DeepSeek', 'API key · 2 models', { on: selId === 'deepseek' })) +
    ritem(BRAND.openrouter(18), 'OpenRouter — Work', o.fresh ? 'API key · 312 models · just added' : 'API key · 312 models', { on: selId === 'openrouter' }) +
    local +
    gl('Gateways', 1) + ritem(gI('rGate'), 'Main gateway', 'Managed from Connected services', { on: selId === 'gw' }) });
}
function agRail(selId, o = {}) {
  const row = (a) => ritem(a.logo(), a.id === 'claude' ? 'Claude Code' : a.n, o.machine === 'none' ? (a.grp === 'ready' ? 'Enabled' : 'Not enabled') : a.st, { on: a.id === selId, warn: o.machine !== 'none' && a.s === 'warn' });
  return xRail({ title: 'Agents', count: 19, search: true, body: (o.machine === 'none' ? gl('Enabled', 4) : gl('On MacBook Pro', 4)) + AGENTS.filter(a => a.grp === 'ready').map(row).join('') + gl(o.machine === 'none' ? 'More agents' : 'Available to install', 15) + AGENTS.filter(a => a.grp === 'avail').slice(0, 3).map(row).join('') });
}

/* ═════════════ gateway detail ═════════════ */
function gatewayDetail(o = {}) {
  const ph = !!o.ph, st = o.state || 'running';
  const status = st === 'running' ? `<span class="xst ok"><i></i>Running on MacBook Pro</span><span class="sep">·</span><span>2 sessions</span>`
    : st === 'idle' ? `<span class="xst off"><i></i>Idle</span><span class="sep">·</span><span>starts when a session needs it</span>`
    : `<span class="xst warn"><i></i>Unavailable</span><span class="sep">·</span><span>Studio is offline</span>`;
  const head = xHeader({ title: `Main gateway ${h.pill('Experimental', 'line')}`, mark: mk('rGate', 28, 'g'), meta: status, desc: 'Lets any agent use your ChatGPT and Claude subscriptions.', actions: ph ? '' : h.btn('', 'ghost', 'more', 'icon'), gut: 'pane' });
  const ban = st === 'offline' ? `<div class="xban warn" style="margin:-6px 0 26px"><span class="ic">${ic('warn')}</span><div class="b"><b>Studio is offline</b><span>Sessions can’t use Main gateway until Studio is back, or you choose another computer below. Nothing else is tried in its place.</span></div></div>` : '';
  const chat = o.chat === 'empty'
    ? R(ph, { mark: '', lead: ph ? '' : lead('codex'), t: 'ChatGPT', d: 'Connect a ChatGPT account to use it here.', c: h.btn('Connect', 'secondary', '', 'sm') })
    : R(ph, { wide: true, lead: lead('codex'), t: 'ChatGPT', d: 'Personal, then Bot · 71% left', c: sel('Codex pool', ic('stack', 'lg'), { full: ph }) });
  const claude = o.claude === 'unused'
    ? R(ph, { wide: true, lead: lead('claude'), t: 'Claude', d: 'Claude models aren’t offered through this gateway.', c: sel('Not used', '', { full: ph, muted: true }) })
    : R(ph, { wide: true, lead: lead('claude'), t: 'Claude', d: '3 accounts · 42% left on Work', c: sel('Work pool', ic('stack', 'lg'), { full: ph }) });
  const from = sec('Models from', 'The subscriptions this gateway draws on. Choose an account or a pool for each; they are never mixed.', h.sheet(chat + claude));
  const chosen = o.runs === 'chosen';
  const runs = sec('Runs on', 'Where the gateway starts when a session needs it. Requests still go to ChatGPT and Claude.', h.sheet(
    `<div class="row stack">${h.seg(['Each session’s computer', 'A chosen computer'], chosen ? 1 : 0, 'full')}<div class="dsc" style="margin-top:-2px;max-width:none">${chosen ? 'One gateway on the computer you choose. Sessions on your other computers reach it through Happier.' : 'One gateway per computer, shared by every session there.'}</div></div>` +
    (chosen ? R(ph, { wide: true, t: 'Computer', d: st === 'offline' ? `<span class="xst warn"><i></i>Offline · last seen 09:12</span>` : `<span class="xst ok"><i></i>Online · your other computers can reach it</span>`, c: sel('Studio', ic('desktop', 'lg'), { full: ph }) }) : '')));
  const pick = sec('Model picker', '', h.sheet(
    h.row({ t: C.showPicker, d: C.showOffGw, c: h.sw(false) }) +
    h.row({ t: 'Models', c: val('6 available'), chev: true })));
  const helperSel = (v, muted) => sel(v, '', { full: ph, muted });
  const helpers = sec('Claude Code helper models', 'Claude Code hands side tasks to a fast, a default and a strongest model. Choose what each one is on this gateway. Agent definitions that name a model keep it.', h.sheet(
    R(ph, { wide: true, t: 'Fast', c: o.pins ? helperSel('GPT-6.1 Luna') : helperSel('Same as session', true) }) +
    R(ph, { wide: true, t: 'Default', c: helperSel('Same as session', true) }) +
    R(ph, { wide: true, t: 'Strongest', c: o.pins ? helperSel('Fable 5.1') : helperSel('Same as session', true) })));
  const details = sec('Details', '', h.sheet(
    R(ph, { wide: true, t: 'Name', c: `<div class="input" style="min-width:${ph ? 0 : 260}px">Main gateway</div>` }) +
    h.disc('Experimental', 'What to know', h.row({ t: 'Your subscriptions, outside their own apps', d: 'ChatGPT and Claude don’t support this use. Requests can be refused and their terms can change. Happier only ever sends a request to the account or pool chosen above.' }), !!o.open)));
  return `${head}${ban}${from}${runs}${pick}${helpers}${details}`;
}

/* ═════════════ pool detail ═════════════ */
function poolDetail(o = {}) {
  const ph = !!o.ph;
  const head = xHeader({ title: 'Work pool', mark: mk('stack', 26, 'g'), meta: `<span>Claude</span><span class="sep">·</span><span>3 accounts</span><span class="sep">·</span><span>using Work since 09:12</span>`, desc: 'Claude Code moves to the next account when one runs out.', actions: ph ? '' : h.btn('', 'ghost', 'more', 'icon'), gut: 'pane' });
  const acct = (n, s, p, warn) => h.row({ cls: 'compact', t: n, d: s, c: `<span class="tnum" style="font-size:13px;color:${warn ? 'var(--danger)' : 'var(--text2)'}">${p}% left</span>`, chev: true });
  const accounts = sec('Accounts', '', h.sheet(acct('Work', 'leeroy@company.com · Max', 42) + acct('Personal', 'leeroy.b@gmail.com · Pro', 6, true) + acct('Lab', 'lab@happier.dev · Max', 96) + `<div class="xadd">${ic('plus')}Add account</div>`));
  const cmpRows = [
    ['Runs through', 'Claude’s own sign-in', 'Main gateway'],
    ['Works in', 'Claude Code', 'Codex, OpenCode'],
    ['Supported by Claude', 'Yes', 'No. Experimental; requests can be refused'],
    ['Limits', 'This pool’s limits', 'The same limits, shared'],
  ];
  const cmp = `<div class="rt-cmp"><div class="h"></div><div class="h">${BRAND.claude(14)}In Claude Code</div><div class="h">${ic('rGate', '', 'width="14" height="14"')}In other agents</div>${cmpRows.map(([k, a, b], i) => `<div class="k">${k}</div><div class="v">${a}</div><div class="v ${i === 2 ? 'q' : ''}">${b}</div>`).join('')}</div>`;
  const title = `Use in other agents <span class="opt">via Main gateway</span>`;
  let body;
  if (o.replace) {
    body = h.sheet(h.row({ t: title, d: 'Main gateway uses Lab pool for Claude models today.', c: h.sw(false) }) +
      `<div style="padding:0 12px 12px"><div class="xban" style="margin:0"><span class="ic">${ic('arrows')}</span><div class="b"><b>Switch Main gateway to Work pool?</b><span>New sessions in other agents will use Work pool for Claude models. Lab pool keeps its accounts, and running sessions keep what they started with.</span></div><div class="a">${h.btn('Cancel', 'ghost', '', 'sm')}${h.btn('Switch', 'primary', '', 'sm')}</div></div></div>`);
  } else {
    body = h.sheet(h.row({ t: title, d: 'Codex and OpenCode can run Claude models from this pool.', c: h.sw(true) }) + cmp +
      h.row({ lead: lead('rGate'), t: 'Main gateway', d: 'Running on MacBook Pro', chev: true }));
  }
  const other = sec('Use in other agents', 'Claude Code signs in to this pool directly. Other agents reach the same accounts through a gateway.', body);
  const behavior = sec('Behavior', '', h.sheet(R(ph, { wide: true, t: 'When an account runs out', c: h.seg(['Next account', 'Ask me'], 0, ph ? 'full' : '') })));
  return `${head}${accounts}${other}${behavior}`;
}

S.rgateway = {
  craft: true, def: 'GW1',
  title: 'Gateway & pool', subtitle: 'Routing · one gateway surface, vendor slots, helper models (D3, D4, D5, D10) · plan unit G2',
  variants: {
    GW1: {
      label: 'GW1 · Gateway detail', shell: 'inv', nav: 'services', wide: true,
      html: () => cdWide(csRail('gw'), pane(gatewayDetail())),
      notes: `<h3>GW1 · One gateway, one screen, two ways in</h3>
<p>A Gateway is the managed connection people already have, under a name they can understand (D3). It appears in <b>Connected services → Gateways</b> (this frame) and in <b>Providers</b> (PD frames); both open this same detail.</p>
<h4>Order: what it uses, where it runs, then the rare things</h4><ul>
<li><b>Header</b>: mark, name, an outlined Experimental tag, and one live status line — <i>Running on MacBook Pro · 2 sessions</i>, <i>Idle · starts when a session needs it</i>, or <i>Unavailable</i> (GW2). Healthy is quiet text with a green dot; no badge row.</li>
<li><b>Models from</b>: one row per service, each a single select holding <i>Not used</i>, that service’s accounts, and its pools. The description under the label is the live state of the choice (members, what’s left). Rotation never crosses services, and the copy says so once in the section description.</li>
<li><b>Runs on</b>: a two-option segment — <i>Each session’s computer</i> (default) or <i>A chosen computer</i>. Choosing the second reveals the Computer row in place (GW2). “Requests still go to ChatGPT and Claude” prevents the “it’s local, so it’s private” misreading.</li>
<li><b>Model picker</b>: the same <i>Show in model picker</i> switch every connection has (off by default for gateways, with the reason), and Models for per-model hiding.</li>
<li><b>Claude Code helper models</b>: Fast, Default, Strongest; each defaults to <i>Same as session</i> in secondary ink so untouched rows read as “nothing to do”.</li>
<li><b>Details</b>: Name, and an Experimental disclosure that states the risk in plain words.</li></ul>
<h4>Behaviour and motion</h4><ul>
<li>Every control saves on change (no Save button on this screen); a failed save restores the previous value and says why on the row.</li>
<li>Changes apply to sessions that start afterwards; running sessions keep their route (stated on the pool switch and in the replace confirmation).</li>
<li>Revealing the Computer row: the sheet grows by one row (grid-rows 0fr → 1fr, 220ms), content fades in 40ms later. Segment thumb slides.</li></ul>
<p><b>Owner:</b> <code>ProviderConnectionDetailScreen</code> rendered from both collections; slots through <code>ConnectedAccountPurposeTargetChooser</code>; the rail section through <code>ConnectedServicesRail</code>.</p>`,
    },
    GW2: {
      label: 'GW2 · States: no account, chosen computer offline, pins', shell: 'inv', nav: 'services', wide: true,
      html: () => cdWide(csRail('gw', { gw: 'off' }), pane(gatewayDetail({ state: 'offline', chat: 'empty', runs: 'chosen', pins: true }))),
      notes: `<h3>GW2 · The states that need words</h3><ul>
<li><b>Unavailable</b>: amber status in the header and one banner that names the computer, the consequence and the fix. It also says what does <i>not</i> happen: nothing else is tried in its place (no silent fallback). The rail row gets the amber dot.</li>
<li><b>No ChatGPT account yet</b>: the row says <i>Connect a ChatGPT account to use it here.</i> with a Connect button, instead of a disabled select. It is not “Unavailable”.</li>
<li><b>A chosen computer</b>: the Computer row shows reachability next to the choice (online / offline with last seen). Saving a computer never claims it is reachable.</li>
<li><b>Helper models pinned</b>: explicit choices render in primary ink; untouched ones stay “Same as session”.</li>
<li>Also designed, not drawn: <i>Loading</i> keeps the section titles and reserves the rows (skeleton lines, no layout shift); <i>Claude · Not used</i> is the select’s first option (GW1p shows it).</li></ul>`,
    },
    GW1p: {
      label: 'GW1 · 390', phone: true,
      html: () => pnav('Connected services', pmore()) + pbody(gatewayDetail({ ph: true, state: 'idle', claude: 'unused' })),
      notes: `<h3>Phone</h3><ul><li>Selects and the segment move beneath their labels at full width; only switches and chevrons stay on the right.</li><li>The ⋯ menu moves to the native header. Status shows the Idle state; the Claude slot shows “Not used”.</li></ul>`,
    },
    PL1: {
      label: 'PL1 · Pool: use in other agents', shell: 'inv', nav: 'services', wide: true,
      html: () => cdWide(csRail('work'), pane(poolDetail())),
      notes: `<h3>PL1 · A pool stays one thing; a switch lends it to other agents</h3><ul>
<li>Pools are not duplicated into “native” and “gateway” versions (D5). The pool page gains one section: <b>Use in other agents <span style="font-weight:400">via Main gateway</span></b>, a switch.</li>
<li>Under the switch, a four-line comparison answers the only questions people have: what it runs through, where it works, whether Claude supports it, and whose limits it uses. The unsupported cell is the only one in secondary ink — honest, not alarming.</li>
<li>The last row is the gateway itself (mark, live status, chevron) for anything beyond on/off. The switch and the gateway’s Claude select are the <i>same</i> setting; flipping one moves the other.</li>
<li>Turning it off clears the gateway’s Claude source only if this pool still holds it.</li>
<li>With more than one gateway the “via …” suffix becomes a select on the same row; nothing is chosen implicitly.</li>
<li>Motion: switching on reveals the comparison and gateway row in place (rows fade in, 40ms stagger); switching off collapses them faster than they opened.</li></ul>
<p><b>Owner:</b> existing pool detail; the switch submits the gateway’s slot mutation (one writer).</p>`,
    },
    PL2: {
      label: 'PL2 · Pool: replacing another pool', shell: 'inv', nav: 'services', wide: true,
      html: () => cdWide(csRail('work'), pane(poolDetail({ replace: true }))),
      notes: `<h3>PL2 · The consequence, before it happens</h3><p>If the gateway already uses another Claude pool, flipping the switch does not apply immediately: the row opens into a confirmation, in place, that names both pools and says what stays untouched. <b>Switch</b> is the single primary; Cancel returns the switch to off. This is the surface’s signature moment — the control you touched becomes the question, no dialog.</p>`,
    },
    PL1p: {
      label: 'PL1 · 390', phone: true,
      html: () => pnav('Connected services', pmore()) + pbody(poolDetail({ ph: true })),
      notes: `<h3>Phone</h3><p>The comparison keeps three columns (label, here, other agents) at 12.5px; cells wrap rather than truncate.</p>`,
    },
  },
};

/* ═════════════ provider detail, add flow, index ═════════════ */
const PV = {
  deepseek: { n: 'DeepSeek', meta: '2 models', models: '2 shown', host: 'api.deepseek.com', show: true, why: C.showOnDirect('DeepSeek') },
  openrouter: { n: 'OpenRouter — Work', meta: '312 models', models: '312 available · 1 favorite', host: 'openrouter.ai', show: false, why: C.showOffAgg },
  ollama: { n: 'Ollama', meta: '4 models', models: '4 shown', host: 'localhost:11434', show: true, why: C.showOnLocal },
};
function machineSection(title, o, rows, invite) {
  const m = o.machine || 'ok';
  if (m === 'none') return sec(title, '', h.sheet(`<div class="xinl"><span class="grow">${invite}</span>${h.btn('Choose computer', 'secondary', '', 'sm')}</div>`));
  if (m === 'off') return sec(title, '', h.sheet(`<div class="xinl"><span class="grow">devbox is offline. ${o.offLine}</span>${h.btn('Choose another', 'secondary', '', 'sm')}</div>`), xChip('devbox', 'off'));
  return sec(title, '', h.sheet(rows), xChip());
}
function providerDetail2(o = {}) {
  const ph = !!o.ph, k = o.kind || 'deepseek', p = PV[k];
  const head = xHeader({ title: p.n, mark: mk(k, 28), meta: `<span>Model provider</span><span class="sep">·</span><span>${p.meta}</span>`, actions: ph ? '' : h.btn('', 'ghost', 'more', 'icon'), gut: 'pane' });
  const ban = o.done ? `<div class="xban" style="margin:-6px 0 26px"><span class="ic">${ic('check')}</span><div class="b"><b>OpenRouter is connected</b><span>312 models are ready. They’re hidden from the picker by default, because OpenRouter lists many models you may already have. Pick one any time from Runs through, or show them all.</span></div>${ph ? '' : `<div class="a">${h.btn('Show in picker', 'secondary', '', 'sm')}${h.btn('', 'ghost', 'x', 'icon sm')}</div>`}</div>` : '';
  const conn = sec('Connection', 'Saved to your account. Works on every computer.', h.sheet(
    R(ph, { wide: true, t: 'Name', c: `<div class="input" style="min-width:${ph ? 0 : 260}px">${k === 'openrouter' ? 'Work' : p.n}</div>` }) +
    (k === 'ollama' ? '' : h.row({ t: 'API key', d: 'Kept as a saved secret. Never shown again.', c: `${val('Saved')}${h.btn('Replace', 'secondary', '', 'sm')}` })) +
    h.row({ t: 'Models', c: val(p.models), chev: true }) +
    h.row({ t: C.showPicker, d: p.why, c: h.sw(o.show !== undefined ? o.show : p.show) })));
  const rows =
    h.row({ t: 'Endpoint access', d: `MacBook Pro reaches ${p.host} directly.`, c: val('Direct'), chev: true }) +
    h.row({ t: 'Test connection', d: `<span class="xst ok"><i></i>Working · checked 10:42</span>`, c: h.btn('Test', 'secondary', '', 'sm') }) +
    (k === 'ollama' ? h.row({ t: 'Local runtime', d: `<span class="xst ok"><i></i>Running · 4 models loaded</span>`, c: h.btn('Stop', 'secondary', '', 'sm') }) : '');
  const mach = machineSection('On this computer', { machine: o.machine, offLine: 'Last test: working, yesterday 18:20.' }, rows, C.noComputerProv);
  return `${head}${ban}${conn}${mach}`;
}
function addDeepseek(o = {}) {
  const ph = !!o.ph;
  const head = xHeader({ title: 'Add DeepSeek', mark: mk('deepseek', 28), desc: 'Paste a key and DeepSeek’s models appear in Claude Code and OpenCode.', actions: ph ? '' : `${h.btn('Cancel', 'ghost')}${h.btn('Connect', 'primary')}`, gut: 'pane' });
  const form = h.sheet(
    `<div class="row stack"><div class="lbl"><div class="ttl">API key</div></div><div class="input focus mono" style="min-width:0;font-size:13px">sk-4f1c••••••••••••••••••••••••a92e</div><div class="dsc" style="margin-top:-4px">Kept as a saved secret in your account. Create one at platform.deepseek.com.</div></div>` +
    R(ph, { wide: true, t: 'Name <span class="opt">Optional</span>', c: `<div class="input" style="min-width:${ph ? 0 : 260}px"><span style="color:var(--text3)">DeepSeek</span></div>` }));
  return `${head}${form}<p class="rt-hint">Saved to your account straight away; <b>no computer needed</b>. You can test it from any of your computers afterwards.</p>`;
}
function providersEmpty(o = {}) {
  const marks = ['deepseek', 'anthropic', 'openrouter', 'ollama', 'lmstudio'].map(k => mk(k, 24)).join('');
  return emptyState({ marks, title: 'Bring your own models', body: 'Connect a provider once and its models appear in every agent that can run them. No computer needed to start.', primary: h.btn('Add provider', 'primary', 'plus'), secondary: h.btn('Custom endpoint', 'secondary'), alt: 'Subscriptions like Claude and ChatGPT live in <a>Connected services</a>.', variant: o.ph ? 'page' : 'pane' });
}
function providersPhoneIndex(o = {}) {
  const prow = (markHtml, t, d, warn) => `<div class="row link"><span style="width:28px;display:grid;place-items:center;color:var(--text2)">${markHtml}</span><div class="lbl"><div class="ttl">${t}</div><div class="dsc">${warn ? '<span class="dot warn" style="width:6px;height:6px;margin-right:5px"></span>' : ''}${d}</div></div>${ic('chevR', 'chev')}</div>`;
  const local = o.machine === 'none'
    ? sec('On a computer', '', h.sheet(`<div class="xinl"><span class="grow">${C.noComputerRail}</span>${h.btn('Choose', 'secondary', '', 'sm')}</div>`))
    : sec('On MacBook Pro', '', h.sheet(prow(BRAND.ollama(20), 'Ollama', 'Running · 4 models') + prow(BRAND.lmstudio(18), 'LM Studio', 'Not running', true)), '');
  return `<div class="pnav"><div class="row1"><span class="back">${ic('back', '', 'width="20" height="20"')}Settings</span><span class="pact">${ic('plus', '', 'width="22" height="22"')}</span></div><h1>Providers</h1><p>Model sources for your agents.</p></div>` + pbody(
    `<div class="sheet">${prow(BRAND.deepseek(20), 'DeepSeek', 'API key · 2 models')}${prow(BRAND.openrouter(18), 'OpenRouter — Work', 'API key · 312 models')}</div>` + local +
    sec('Gateways', '', h.sheet(prow(gI('rGate'), 'Main gateway', 'Managed from Connected services<br>ChatGPT, Claude'))));
}

S.rprovider = {
  craft: true, def: 'PD1',
  title: 'Providers', subtitle: 'Routing · account-first detail, add flow, index (D8, D11) · plan unit M1',
  variants: {
    PD1: {
      label: 'PD1 · Provider detail', shell: 'inv', nav: 'providers', wide: true,
      html: () => cdWide(pvRail('deepseek'), pane(providerDetail2()), 296),
      notes: `<h3>PD1 · What belongs to your account, and what needs a computer</h3>
<p>Today a page-wide computer bar sits above everything, so a key or a name looks like it belongs to one machine, and with no machine the whole page disappears. The recomposition (M1, D11):</p><ul>
<li><b>Connection</b> — Name, API key, Models and <b>Show in model picker</b> — is account-level and is always available. The section description says it in eight words: <i>Saved to your account. Works on every computer.</i></li>
<li><b>On this computer</b> carries its own computer chip in the section header, and holds only what really runs somewhere: Endpoint access, Test connection, and for local providers the runtime (Start / Stop). The chip is the existing machine selector in its chip presentation, scoped to this section.</li>
<li><b>Show in model picker</b> explains its default by kind: on for direct providers and local models, off for providers that list many models and for gateways. One sentence, the consequence first.</li>
<li>Test is no longer a header action: it is a row next to its last result, in the section whose computer runs it.</li>
<li>The rail groups follow the same truth: account connections first, <b>On MacBook Pro</b> for detected local runtimes, <b>Gateways</b> last with <i>Managed from Connected services</i> — tapping it opens the same gateway detail (GW1).</li></ul>
<h4>Motion</h4><p>Test: the button shows the working spinner in place of its label (width reserved), then the status line cross-fades to the new result with its time. No toast for success.</p>`,
    },
    PD2: {
      label: 'PD2 · No computer selected', shell: 'inv', nav: 'providers', wide: true,
      html: () => cdWide(pvRail('deepseek', { machine: 'none' }), pane(providerDetail2({ machine: 'none' })), 296),
      notes: `<h3>PD2 · No computer: only the computer part changes</h3><ul>
<li>Connection stays fully editable. The <b>On this computer</b> section collapses to one line that says what a computer is needed for and offers <b>Choose computer</b>. No disabled form, no page-level wall.</li>
<li>The rail keeps the saved connections and the gateway. Only the detected-runtimes group turns into the same invitation.</li></ul>`,
    },
    PD3: {
      label: 'PD3 · Selected computer offline', shell: 'inv', nav: 'providers', wide: true,
      html: () => cdWide(pvRail('deepseek', { machine: 'off' }), pane(providerDetail2({ machine: 'off' })), 296),
      notes: `<h3>PD3 · Offline keeps what is known</h3><p>The chip shows devbox with a grey dot. The section says it is offline and keeps the last known result with its time (“Last test: working, yesterday 18:20”), then offers another computer. The account sections are untouched.</p>`,
    },
    PA1: {
      label: 'PA1 · Add DeepSeek', shell: 'inv', nav: 'providers', wide: true,
      html: () => cdWide(pvRail('', { draft: 'deepseek', machine: 'none' }), pane(addDeepseek()), 296),
      notes: `<h3>PA1 · Add DeepSeek in one step</h3><ul>
<li>+ → DeepSeek opens a draft row in the collection (“DeepSeek · Draft”) with one field that matters: the key. Name is optional and pre-filled as a placeholder. <b>Connect</b> is the single primary, enabled once a key is pasted.</li>
<li>The frame is drawn with <b>no computer selected</b> on purpose: the form works, and says so. Nothing here asks for a machine.</li>
<li>The description promises the outcome in the user’s terms and names the agents that can actually run DeepSeek (Claude Code, OpenCode — not Codex).</li>
<li>Paste trims whitespace; the field masks after blur; Enter submits. On success the draft row becomes the saved row in place and the detail turns into PD1 (no navigation).</li></ul>`,
    },
    PA2: {
      label: 'PA2 · OpenRouter connected', shell: 'inv', nav: 'providers', wide: true,
      html: () => cdWide(pvRail('openrouter', { fresh: true }), pane(providerDetail2({ kind: 'openrouter', done: true })), 296),
      notes: `<h3>PA2 · Setup ends by explaining the one surprise</h3><ul>
<li>OpenRouter’s models are hidden from the picker by default (D8). A person who just connected it would look in the picker and think it failed, so completion says it up front: connected, how many models, why they’re hidden, and the two ways to use them.</li>
<li><b>Show in picker</b> in the banner flips the same switch that sits in Connection below (it animates on as the banner dismisses). The banner appears once, right after connecting.</li></ul>`,
    },
    PI1: {
      label: 'PI1 · Index, nothing connected', shell: 'inv', nav: 'providers', wide: true,
      html: () => `<div class="rt-emptywrap">${providersEmpty()}</div>`,
      notes: `<h3>PI1 · The empty collection owns the page</h3><ul>
<li>With no providers there is no rail to show, so there is no blank column and nothing to clip: the invitation is centred in the whole content area (the existing empty-collection composition).</li>
<li>Marks stand on their own (no tiles), one promise, one primary, one quiet alternative, and a pointer for the most common confusion (subscriptions live in Connected services).</li>
<li>It no longer asks for a computer first: adding a provider is an account action.</li></ul>`,
    },
    PD1p: {
      label: 'PD1 · 390', phone: true,
      html: () => pnav('Providers', pmore()) + pbody(providerDetail2({ ph: true, kind: 'ollama' })),
      notes: `<h3>Phone</h3><p>Shown with Ollama so the local runtime row is visible. The computer chip stays in the section header (it is short); Name moves beneath its label.</p>`,
    },
    PA1p: {
      label: 'PA1 · 390', phone: true,
      html: () => pnav('Providers', `<span class="pact" style="font-weight:600">Connect</span>`) + pbody(addDeepseek({ ph: true })),
      notes: `<h3>Phone</h3><p>Connect sits in the native header, always visible above the keyboard. No full-width footer button.</p>`,
    },
    PI1p: {
      label: 'PI1 · 390', phone: true,
      html: () => `<div class="pnav"><div class="row1"><span class="back">${ic('back', '', 'width="20" height="20"')}Settings</span></div><h1>Providers</h1></div><div class="x-pbody rt-pbody" style="padding-top:96px">${providersEmpty({ ph: true }).replace('class="xes "', 'class="xes " style="border:0;padding:0"')}</div>`,
      notes: `<h3>Phone · empty</h3><p>Same invitation; both actions stay visible without scrolling.</p>`,
    },
    PI2p: {
      label: 'PI2 · 390, no computer', phone: true,
      html: () => providersPhoneIndex({ machine: 'none' }),
      notes: `<h3>Phone · index with no computer</h3><p>Saved providers and the gateway are listed and open normally. Only the detected-runtimes section asks for a computer, with its action on the same line (the missing recovery action from live QA).</p>`,
    },
  },
};

/* ═════════════ agent detail + agent models ═════════════ */
function agentDetail2(o = {}) {
  const ph = !!o.ph;
  const head = xHeader({ title: 'Claude Code', mark: mk('claude', 28), meta: `<span>Coding agent</span><span class="sep">·</span><span>used by new sessions</span>`, actions: ph ? '' : `<span style="font-size:13px;color:var(--text2)">Enabled</span>${h.sw(true)}${h.btn('', 'ghost', 'more', 'icon')}`, gut: 'pane' });
  const enabled = ph ? `<div class="sheet" style="margin-bottom:26px">${h.row({ t: 'Enabled', c: h.sw(true) })}</div>` : '';
  const defaults = sec('Session defaults', 'Used when a new session starts with Claude Code. Saved to your account.', h.sheet(
    R(ph, { wide: true, t: 'Model', c: h.sel('Fable 5.1', BRAND.claude(14)) }) +
    R(ph, { wide: true, t: 'Permission mode', c: h.seg(['Default', 'Accept edits', 'Plan', 'Yolo'], 1, ph ? 'full' : '') }) +
    R(ph, { wide: true, t: 'Account', d: 'Same default as in Connected services.', c: sel('Work pool', ic('stack', 'lg'), { full: ph }) }) +
    h.row({ t: 'Models', c: val('7 shown · 1 hidden'), chev: true })));
  const rows =
    h.row({ t: 'Sign-in', d: `<span class="xst ok"><i></i>Signed in as leeroy@company.com · checked 2m ago</span>`, c: h.btn('Reauthenticate', 'secondary', '', 'sm') }) +
    h.row({ t: 'CLI', d: 'claude 2.1.278 · system install', c: h.btn('Reinstall', 'secondary', '', 'sm') }) +
    h.row({ t: 'External sessions', d: 'Follow Claude Code sessions started in a terminal.', c: val('Installed'), chev: true });
  const mach = machineSection('Setup and status', { machine: o.machine, offLine: 'Last check: signed in, yesterday 18:20.' }, rows, C.noComputerAgent);
  return `${head}${enabled}${defaults}${mach}`;
}
function agentModels(o = {}) {
  const ph = !!o.ph;
  const head = xHeader({ title: 'Models', back: !ph, meta: `<span style="display:inline-flex;gap:6px;align-items:center">${BRAND.claude(13)}Claude Code</span>`, desc: 'What Claude Code’s model picker shows.', gut: 'pane' });
  const legend = `<div class="rt-legend"><span>${star(true)}Pinned to the top</span><span>${h.sw(true)}Shown in the picker</span><span>${h.pill('Default', 'info')}New sessions start here</span></div>`;
  const mrow = (n, o2 = {}) => `<div class="rt-mrow ${o2.hid ? 'hid' : ''}"><div class="nm">${n}${o2.def ? h.pill('Default', 'info') : ''}</div>${o2.text ? val(o2.text) : ''}${ph || !o2.cx ? '' : `<span class="cx">${o2.cx}</span>`}${star(!!o2.fav)}${o2.text ? '<span style="width:40px;flex:none"></span>' : h.sw(!o2.hid)}</div>`;
  const grp = (markHtml, t, d, ctl = '') => `<div class="rt-grp"><span style="width:22px;display:grid;place-items:center;color:var(--text2)">${markHtml}</span><div class="b"><div class="t">${t}</div><div class="d">${d}</div></div>${ctl}</div>`;
  const srcSw = (on) => ph ? h.sw(on) : `${val(C.showPicker)}${h.sw(on)}`;
  const native = h.sheet(grp(BRAND.claude(18), 'Claude subscription', 'Claude Code’s own models. Always in the picker.') +
    mrow('Fable 5.1', { def: true, fav: true, cx: '1M' }) + mrow('Opus 5.5', { cx: '1M' }) + mrow('Sonnet 5.5', { cx: '1M' }) + mrow('Haiku 5.5', { cx: '200K' }) + mrow('Sonnet 4.6', { hid: true, cx: '200K' }));
  const ds = h.sheet(grp(BRAND.deepseek(18), 'DeepSeek', 'Shown in every agent that can run it.', srcSw(true)) + mrow('DeepSeek V4 Pro', { fav: true, cx: '128K' }) + mrow('DeepSeek V4 Flash', { cx: '128K' }));
  const or = h.sheet(grp(BRAND.openrouter(17), 'OpenRouter — Work', 'Hidden from the picker · 312 models', srcSw(false)) + mrow('Sonnet 5.5', { fav: true, text: ph ? 'Stays visible' : 'Stays visible as a favorite' }) + `<div class="row link compact" style="border-top:1px solid var(--p-divider)"><div class="lbl"><div class="ttl" style="font-weight:450;color:var(--text2)">Browse 312 models</div></div>${ic('chevR', 'chev')}</div>`);
  const gw = h.sheet(grp(gI('rGate'), 'Main gateway', 'Hidden from the picker · 6 models', srcSw(false)));
  const fresh = `<p class="rt-hint" style="display:flex;align-items:center;gap:10px"><span style="flex:1">Lists last checked on MacBook Pro at 10:42.</span>${h.btn('Refresh', 'ghost', 'refresh', 'sm')}</p>`;
  return `${head}${legend}<div style="display:grid;gap:12px">${native}${ds}${or}${gw}</div>${fresh}`;
}

S.ragent = {
  craft: true, def: 'AG1',
  title: 'Agent', subtitle: 'Routing · account defaults vs setup on a computer, and Agent → Models (D8, D11) · plan unit M1',
  variants: {
    AG1: {
      label: 'AG1 · Agent detail', shell: 'inv', nav: 'agents', wide: true,
      html: () => cdWide(agRail('claude'), pane(agentDetail2())),
      notes: `<h3>AG1 · Session defaults are yours; setup belongs to a computer</h3><ul>
<li>The page-wide “Managing · MacBook Pro” bar is gone. The header is the Agent’s identity and its account-level Enabled switch.</li>
<li><b>Session defaults</b> (model, permission mode, account, Models) says where it lives: <i>Saved to your account.</i> D22 keeps the model via <code>providers.defaults.set</code>; no Account effort-default owner exists, so no effort control is drawn. Permission mode stays a four-option segment.</li>
<li><b>Setup and status</b> carries the computer chip in its header — read together: “Setup and status · MacBook Pro”. It holds Sign-in, CLI and External sessions: the things that are facts about one machine. Integrations and Advanced from C1 keep their content; they are simply filed under the section whose scope they have.</li>
<li>Models moved out of an Advanced disclosure into Session defaults with a live summary (“7 shown · 1 hidden”).</li></ul>
<p><b>Owner:</b> <code>AgentSettingsScreen</code> with existing <code>PageHeader</code> / <code>ItemGroup</code>; the chip is <code>MachineAdministrationTargetSelector</code> (chip presentation) placed in the section header instead of the page.</p>`,
    },
    AG2: {
      label: 'AG2 · No computer selected', shell: 'inv', nav: 'agents', wide: true,
      html: () => cdWide(agRail('claude', { machine: 'none' }), pane(agentDetail2({ machine: 'none' }))),
      notes: `<h3>AG2 · Defaults stay; setup invites</h3><p>The D22 model-only default remains editable, along with permission mode and account. Setup and status becomes one line — what a computer is needed for — with <b>Choose computer</b>. The rail groups by Enabled / More agents instead of by what is installed on a machine, because there isn’t one.</p>`,
    },
    AM1: {
      label: 'AM1 · Agent → Models', shell: 'inv', nav: 'agents', wide: true,
      html: () => cdWide(agRail('claude'), pane(agentModels())),
      notes: `<h3>AM1 · Three different intentions, three different controls</h3><ul>
<li>The legend under the title names them once: <b>★ Favorite</b> pins a model to the top of the picker; the <b>switch</b> shows or hides it; the <b>Default</b> tag marks where new sessions start. They never share a control.</li>
<li>One sheet per source, in picker order. The agent’s own models have no source switch (always in the picker). Each provider or gateway sheet has <b>Show in model picker</b> in its header — the same account-wide switch as on the provider’s page, so the description says “every agent”.</li>
<li>A hidden source collapses to its header. Its favorites stay listed with <i>Stays visible as a favorite</i> in place of the switch, so the exception is explained where it shows. “Browse 312 models” opens the provider’s Models page.</li>
<li>Per-model switches are the existing per-model hiding and remain underneath the source switch: turning a source on does not un-hide models hidden one by one.</li>
<li>Works with no computer (saved lists). Only <b>Refresh</b> needs one; it sits with the freshness line at the bottom and names the computer that checked.</li>
<li>Motion: turning a source switch on expands its rows (stagger 30ms, max 8 rows animated, the rest appear); off collapses in one move.</li></ul>`,
    },
    AG1p: {
      label: 'AG1 · 390', phone: true,
      html: () => pnav('Agents', pmore()) + pbody(agentDetail2({ ph: true, machine: 'none' })),
      notes: `<h3>Phone · no computer</h3><p>Enabled becomes the first row. D22 keeps Model alone, with no Account effort default. Model, permission mode and account stack their controls beneath the label. The setup invitation keeps its action on the same line.</p>`,
    },
    AM1p: {
      label: 'AM1 · 390', phone: true,
      html: () => pnav('Claude Code') + pbody(agentModels({ ph: true })),
      notes: `<h3>Phone</h3><p>Context sizes drop out; star and switch keep 44px targets. The source switch sits alone at the right of the group header; its label is the header’s description.</p>`,
    },
  },
};
})();
