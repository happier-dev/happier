// Credentials lab · Providers pages and the "before" board (lane UIR-CREDS, 2026-10-30).
// Truth: components/settings/providers/{ProviderSettingsIndex.tsx, ProviderSettingsLayout.tsx, collection/, gateway/,
// ProviderMachineSelector.tsx}; gateway typed cause managed_purpose_bindings_missing (p-catalog-1029 P28: the cold gateway UI
// shows neither the reason nor a Test action; 390 overflows horizontally). Providers UI notes for this lane
// (providers-ui-del-1030 "For the UI lane"): S3 sleeping Machines keep their rows, names and usage, not executable, no index
// failure; C4 an open Pool detail follows remote updates; CM2 verified model rows stay selectable while Machine declarations
// are unavailable, refused Team models never look like recovery actions.
(() => {
const { I, NEW, M, MK, row, grp, cx, field, column, phead, prow, card, sec, btn, sw, phNav, shell, chev, word, act, line, phWrap, st } = window.CR;
const VIEW = window.SF.VIEW;

const machine = () => `<span class="sf-btn" style="font-weight:400">${I('sfMachine')}MacBook Pro${I('chevD')}</span>`;
function provRail(o = {}) {
  const body = [
    `<div class="sf-grp">${row({ mk: 'sfAll', t: 'Overview', on: o.sel === 'home' })}</div>`,
    grp('Your providers', [
      row({ mk: 'openrouter', t: 'OpenRouter', cx: cx('On', 'API key', '14 models') }),
      row({ mk: 'deepseek', t: 'DeepSeek', cx: cx('Off', 'API key', '2 models'), off: true }),
      row({ mk: 'box', t: 'Acme internal gateway — EU staging', cx: cx('On', 'custom endpoint', '3 models') }),
      row({ mk: 'ollama', t: 'Ollama', cx: o.sleep ? cx('mac-studio is asleep', '6 models') : cx('On', 'mac-studio', '6 models'), st: o.sleep ? 'offline' : '' }),
    ], { n: 4 }),
    grp('Gateways', [row({ mk: 'route', t: 'Main gateway', cx: 'Off · needs an account', st: 'signin', on: o.sel === 'gw' })], { n: 1 }),
    grp('From your Teams', o.teamsFailed ? [`<div class="sf-qline">${st('failed')}<span>Couldn’t load your Teams’ providers. <span class="lnk">Retry</span></span></div>`]
      : [row({ mk: 'openrouter', t: 'Studio OpenRouter', cx: cx('Studio', '8 models') })], { n: o.teamsFailed ? null : 1 }),
  ].join('');
  return column({ title: 'Providers', n: 5, icons: ['sfFilter', 'plus'], top: VIEW(0, 2), body });
}
function provPage(o = {}) {
  const head = phead({ t: 'Providers', d: 'Connect a model source once and use its models with every compatible agent.', acts: `${machine()}${btn('Add provider', true, 'plus')}` });
  const yours = sec('Your providers', card([
    prow({ lead: M('openrouter', 20), t: 'OpenRouter', d: cx('API key', '14 models saved'), c: word('On') + chev() }),
    prow({ lead: M('deepseek', 20), t: 'DeepSeek', d: cx('API key', '2 models saved'), c: word('Off') + chev() }),
    prow({ lead: I('sfBox'), t: 'Acme internal gateway — EU staging', d: cx('Custom endpoint', '3 models saved'), c: word('On') + chev() }),
    o.sleep ? prow({ lead: M('ollama', 20), t: 'Ollama', d: cx('On mac-studio', 'asleep · 6 models from its last check'), c: word('Asleep') + chev() })
      : prow({ lead: M('ollama', 20), t: 'Ollama', d: cx('On mac-studio', '6 models'), c: word('On') + chev() }),
  ]), { d: 'Model sources you connected. Open one to turn it on, pick its models or change its key.' });
  const gws = sec('Gateways', card([
    prow({ lead: I('sfRoute'), t: 'Main gateway', d: 'Serves your ChatGPT accounts to OpenCode and Pi', c: word('Off · needs an account', 'amber') + chev() }),
  ]), { d: 'Serve the accounts and pools in Credentials to other agents. Their accounts are managed in Credentials.', right: act('Credentials', 'chevR').replace('<svg', '<svg style="order:2"') });
  const teams = sec('From your Teams', card(o.teamsFailed ? [
    line('crCloudOff', '<b>Couldn’t load the providers your Teams share.</b> Your own providers still work.', 'Retry'),
  ] : [
    prow({ lead: M('openrouter', 20), t: 'Studio OpenRouter', d: cx('From Studio', '8 models', 'runs through Maya Kim’s machine'), c: chev() }),
  ]), { d: 'Model sources your Teams let you use.' });
  const add = sec('Add a provider', card([
    prow({ lead: M('anthropic', 20), t: 'Anthropic', d: 'API key · Claude models for any agent', c: btn('Add') }),
    prow({ lead: M('gemini', 20), t: 'Google Gemini', d: 'API key', c: btn('Add') }),
    prow({ lead: mono('C', '#F38020'), t: 'Cloudflare AI Gateway', d: 'API key · your own gateway', c: btn('Add') }),
    prow({ lead: M('lmstudio', 20), t: 'LM Studio', d: 'Runs on one of your machines', c: btn('Add') }),
    prow({ lead: I('sfAll'), t: 'All providers', d: '18 more, including OpenAI, Mistral and Groq', c: chev() }),
  ]), { d: 'Bring your own models. Keys you add here are credentials too, and show up in Credentials.' });
  return `<div class="sf-page">${head}${yours}${gws}${teams}${add}</div>`;
}
const mono = (l, bg, s = 20) => BRAND.mono(l, bg, '#fff', s);
MK.lmstudio = (s = 17) => BRAND.lmstudio(s);

function gatewayPage(o = {}) {
  const head = phead({ mark: I('sfRoute').replace('<svg', '<svg style="width:26px;height:26px"'), t: 'Main gateway', meta: `<span>Gateway</span><span class="cr-meta-sep">·</span><span>Off</span>`, acts: `<span class="sf-btn" style="opacity:.45">Test</span>${sw(false)}<span class="sf-ib">${I('sfDots')}</span>` });
  const banner = `<div class="cr-banner">${I('sfAlert')}<div class="tx"><b>Choose an account first</b><span>Pick at least one Claude or ChatGPT account or pool under Models before you turn this gateway on or test it.</span></div>${btn('Choose accounts')}</div>`;
  const models = sec('Models', card([
    prow({ lead: M('claude', 20), t: 'Claude', d: 'Not set · choose an account or pool', c: chev() }),
    prow({ lead: M('chatgpt', 20), t: 'ChatGPT', d: 'Not set · choose an account or pool', c: chev() }),
  ]), { d: 'Which of your accounts answer requests sent to this gateway.' });
  const serves = sec('Serves', card([
    prow({ lead: M('opencode', 20), t: 'OpenCode', d: 'Uses this gateway when you pick it' }),
    prow({ lead: I('terminal'), t: 'Pi', d: 'Uses this gateway when you pick it' }),
  ]));
  const addr = sec('Address', card([prow({ t: '<span class="cr-mono">https://nl2-devbox.tailfce179.ts.net:8317/v1</span>', d: 'Reachable from your machines', c: `<span class="cr-ib">${I('crCopy')}</span>` })]));
  return `<div class="sf-page">${head}${banner}${models}${serves}${addr}</div>`;
}
const PS = (detail, o = {}) => shell('Providers', provRail(o), detail);

const NOTE_P = `<h3>Providers · same system as Credentials</h3>
<p>Owner (21:34): main rows’ icons not left-aligned, unclear what’s actionable, “Managed from Connected services” floating, the Teams error block.</p>
<ul><li><b>Rows</b>: every provider is a navigation row — mark in the fixed leading column (all marks on one edge), name, one fact line (key kind, models), and the trailing state word then the chevron. The chevron is what says “open me”; the On/Off word is the current state, not a control (the switch lives on the provider’s page header).</li>
<li><b>Gateways</b> is a section like the others; the floating “Managed from Connected services” becomes its description with one quiet link to Credentials.</li>
<li><b>From your Teams</b>: honest failure in one line (what failed, what still works, Retry). The section disappears only when Teams is really off on this Home.</li>
<li><b>Add a provider</b>: the same rows with one inline Add (was a card shelf); “All providers” opens the catalog. A key added here is a credential and appears in Credentials (one record).</li>
<li><b>Rail</b>: names never wrap beside a trailing meta (owner 21:34): the name gets the whole first line, the facts go to line two (“Off · API key · 2 models”). Row geometry is UIR-RAIL’s shared primitive; this is the content contract.</li>
<li>Machine chip stays the page’s scope control in the header; account-level rows render without it.</li></ul>`;
S.crProv = { title: 'Providers', subtitle: 'overview, Teams failed, gateway reason, sleeping machine', def: 'home', variants: {
  home: { label: 'Overview', h: 1300, html: () => PS(provPage(), { sel: 'home' }), notes: NOTE_P },
  teams: { label: 'Teams failed', h: 1300, html: () => PS(provPage({ teamsFailed: true }), { sel: 'home', teamsFailed: true }), notes: '<h3>Teams read failed</h3><p>Replaces “Teams are not available on this Home · This information couldn’t be loaded. Try again.” (which says two contradicting things). One cause, one line, one action; rail and page each say it once in their own group.</p>' },
  sleep: { label: 'Machine asleep', h: 1300, html: () => PS(provPage({ sleep: true }), { sel: 'home', sleep: true }), notes: '<h3>S3 · a sleeping machine</h3><p>A machine-hosted provider keeps its row, name and last-known models while its machine sleeps: neutral glyph, “mac-studio is asleep”, not executable, never an index failure (Providers S3, publication fix landed).</p>' },
  gw: { label: 'Gateway: needs accounts', h: 1150, html: () => PS(gatewayPage(), { sel: 'gw' }), notes: `<h3>Gateway detail: the typed reason and Test</h3><p>P28: the backend now returns <code>managed_purpose_bindings_missing</code>, but the gateway page shows nothing and has no Test. Proposal: one amber banner under the header with the cause and the action that fixes it (Choose accounts → scrolls to Models); <b>Test</b> sits in the header beside the switch and stays disabled with that reason until a model source is set. A draft can still be saved off and unbound.</p><p>Data: expose the producer’s typed cause to the page without remapping (Providers) ${NEW}; Test action ${NEW}.</p><p>C4 (an open Pool detail follows remote updates) and CM2 (verified model rows stay selectable while Machine declarations are unavailable; refused Team models never look like recovery actions) change no composition; they are kept as-is in the build.</p>` },
} };

/* phone */
function phProv() {
  const body = provPage().replace('<div class="sf-page">', '<div class="sf-page">');
  return phWrap(`${phNav('Settings')}<div class="pg">${body}</div>`);
}
function phGw() { return phWrap(`${phNav('Providers')}<div class="pg">${gatewayPage()}</div>`); }
S.crPhone.variants.prov = { label: 'Providers', phone: true, html: () => phProv(), notes: '<h3>Phone · Providers</h3><p>The overview as the pushed page. Header actions drop beneath the purpose (machine chip, then Add provider). Row facts wrap, state words stay.</p>' };
S.crPhone.variants.gw = { label: 'Gateway', phone: true, html: () => phGw(), notes: '<h3>Phone · gateway</h3><p>P28 saw this page overflow horizontally at 390 (1104 px wide). Every row here wraps its facts; the address truncates in the middle with Copy; the banner action drops under its text.</p>' };

})();
