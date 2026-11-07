// Credentials lab · cr-signin: how a person picks a way to sign in, and what they see right after (lane CONNECT-UI-1106, 2026-11-06).
// Owner (11-06, connecting a real Claude and a real Codex account on the QA Account):
//   "A segmented bar promises the selected thing is below", but you press "Sign in with code", then "Continue", and sometimes
//   nothing happens. "Should they be steps?" · ChatGPT "With a code" is already selected but its form only shows after pressing it
//   again · Setup token / Import native login fonts broken · error: Retry on its own row, Details under it, nothing aligned ·
//   after success the popover kept "waiting" while the account behind it was already connected.
// Product truth (apps/ui/sources unless noted):
//   - Methods come from the plugin declaration (generatedBundledPluginEntries): Claude = Sign in with Claude (oauth, browser
//     unreachable → paste the code back) · Setup token (manual, 1 secret field + checklist) · Import native login (manual, source
//     select + Machine). ChatGPT = Sign in with ChatGPT (oauth) · device code (no title → "With a code") · Import native login.
//   - rankConnectedAccountSetupModes: device code → browser → pasted; first = recommended.
//   - ConnectedServiceSetupFlowBody draws SegmentedTabBar + a generic Continue when the controller passes no flow;
//     the controller (ConnectedAccountServiceView panel branch) passes no flow for an unchosen non-manual method.
//   - Issuing a code / starting a browser sign-in needs an explicit press (R8-9; zero Machine RPC before it, CONNECT-SHEET gate).
//   - Error: SurfaceStateCard size=line (plugin-ui HappierStateLine) + a separate ConnectedAccountFailureDetails under it.
//   - Success: ConnectedAccountSettled (identity line + pool/default offer + Done) once the controller settles.
// Lab-only: every value below is a proposal for a named owner.
(() => {
const { I, M, btn, cx, shell, rail, accountPage, phWrap, phNav } = Object.assign({}, window.SF, window.CR);
Object.assign(P, {
  csExt: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13M17 13.5v5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 4 18.5v-10A1.5 1.5 0 0 1 5.5 7H10"/>',
  csLock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/>',
  csErr: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.8v5M12 16.2h.01"/>',
  csOk: '<path d="m5.5 12.5 4 4 9-9"/>',
  csCaret: '<path d="m9 6 6 6-6 6"/>',
  csDown: '<path d="m6 9 6 6 6-6"/>',
  csCopy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15"/>',
});
const SVC = {
  claude: { t: 'Claude', for: 'For Claude Code, OpenCode and Pi', methods: ['Sign in with Claude', 'Setup token', 'Import native login'] },
  chatgpt: { t: 'ChatGPT', for: 'For Codex, OpenCode and Pi', methods: ['With a code', 'Sign in with ChatGPT', 'Import native login'] },
};
const head = (k) => `<div class="hd"><span class="mk">${M(k, 24)}</span><div class="tt"><b>Connect ${SVC[k].t}</b><span>${SVC[k].for}</span></div><span class="sf-ib">${I('x')}</span></div>`;
const trust = `<div class="cs-trust">${I('csLock')}<span>Saved to your account and used only by your machines.</span></div>`;
const foot = (pri, o = {}) => `<div class="cs-ft">${o.left || '<span class="grow"></span>'}<span class="sf-btn txt">Cancel</span>${pri ? btn(pri, !o.off) : ''}</div>`;
const fld = (lb, val, o = {}) => `<div class="cc-f"><div class="lb">${lb}<span class="grow"></span>${o.link ? `<a>${o.link}${I('csExt')}</a>` : ''}</div><div class="in ${o.cls || ''}">${val}</div>${o.hp ? `<div class="hp">${o.hp}</div>` : ''}</div>`;
const sel = (lb, val, o = {}) => fld(lb, `${val}<span class="grow"></span>${I('csDown')}`, o);
const steps = (xs) => `<ol class="cs-steps">${xs.map((x) => `<li>${x}</li>`).join('')}</ol>`;
const dlg = (inner, label, top = 132) => `<div class="cc-scrim"></div><div class="cr-dlg cc cs" role="dialog" aria-label="${label}" style="left:auto;right:56px;top:${top}px">${inner}</div>`;

/* ── each method's FIRST REAL STEP (what shows the moment the method is the current one) ── */
const STEP = {
  'Sign in with Claude': (o = {}) => o.code
    ? `<div class="cc-wait cs-wait"><span class="sp"></span><div class="tx">Finish on claude.ai<span>Sign in there, then paste the code it shows you.</span></div><span class="sf-btn sm">Open again</span></div>
       ${fld('Code from Claude', '<span class="mono">a7Kq-••••-••••-3xPd</span>', { cls: 'focus' })}`
    : `<p class="cs-lede">Opens claude.ai in a new tab. Sign in with your Claude subscription, then paste the code it shows you here.</p>`,
  'Setup token': () => `${steps(['In a terminal, run <code>claude setup-token</code> and sign in with your Claude subscription.', 'Paste the token it prints.'])}
       ${fld('Claude setup token', 'Paste the token', { cls: 'ph', link: 'Instructions' })}`,
  'Import native login': (o = {}) => `${steps([o.k === 'chatgpt' ? 'On the computer you import from, run <code>codex login</code>.' : 'On the computer you import from, run <code>claude auth login</code>.', 'Choose that computer below.'])}
       ${sel('Computer', `<span class="cs-dot"></span>nl2-devbox<span class="cs-dim">· online</span>`)}${sel('Native login source', o.k === 'chatgpt' ? 'Codex login' : 'Claude Code login', { hp: 'Importing shares this login with Happier. The native app may ask you to sign in again when Happier renews it.' })}`,
  'With a code': (o = {}) => o.code
    ? `<div class="cs-code"><div class="c">K7QM-R2XD</div><div class="tx">Enter this code at <a>auth.openai.com/codex/device</a><span>Waiting for ChatGPT · expires in 14 min</span></div><span class="sf-ib">${I('csCopy')}</span></div>`
    : `<p class="cs-lede">Get a one-time code, then enter it on any device signed in to ChatGPT. Nothing to paste back.</p>`,
  'Sign in with ChatGPT': () => `<p class="cs-lede">Opens chatgpt.com in a new tab. This finishes by itself when ChatGPT sends you back.</p>`,
};
const PRIMARY = { // the product's labels: resolveConnectedAccountModeTitle for a start, connectedServicesSettings.connect for a form
  'Sign in with Claude': (o) => (o.code ? 'Connect' : 'Sign in with Claude'),
  'Setup token': () => 'Connect', 'Import native login': () => 'Connect',
  'With a code': (o) => (o.code ? '' : 'Sign in with a code'), 'Sign in with ChatGPT': () => 'Sign in with ChatGPT',
};

/* ── the error line: cause on the leading edge; Retry and a quiet Details on the trailing edge (one row) ── */
const errLine = (o = {}) => `<div class="cs-err">${I('csErr')}<div class="m">Claude didn’t accept the code. It may have expired; get a new one.</div><div class="acts"><span class="cs-q ${o.open ? 'on' : ''}">Details${I('csCaret')}</span><span class="cs-a">Retry</span></div></div>
  ${o.open ? `<div class="cs-diag"><span class="mono">connected_account_oauth_code_rejected · req 7f3c9a21</span><span class="cs-q">Copy</span></div>` : ''}`;

/* ── B ★ recommended path + "Other ways" ── */
function bodyB(k, o = {}) {
  const ms = SVC[k].methods; const cur = o.method || ms[0];
  const others = ms.filter((m) => m !== cur);
  const done = o.done;
  if (done) return settled(k);
  const step = STEP[cur]({ ...o, k });
  const name = `<div class="cs-mh"><b>${cur}</b>${cur === ms[0] && !o.code ? '<span class="cs-rec">Recommended</span>' : ''}<span class="grow"></span>${o.menu ? '' : `<span class="cs-q">Other ways${I('csDown')}</span>`}</div>`;
  const menu = o.menu ? `<div class="cs-menu"><div class="cs-mh"><b>${cur}</b><span class="grow"></span><span class="cs-q on">Other ways${I('csDown')}</span></div><div class="pop">${others.map((m) => `<div class="it"><b>${m}</b><span>${HINT[m]}</span></div>`).join('')}</div></div>` : name;
  return `${menu}${step}${o.err ? errLine(o) : ''}${trust}`;
}
const HINT = {
  'Sign in with Claude': 'Sign in on claude.ai and paste the code back', 'Setup token': 'Paste a token from claude setup-token',
  'Import native login': 'Use a computer already signed in', 'With a code': 'Enter a one-time code on any device',
  'Sign in with ChatGPT': 'Sign in on chatgpt.com in a new tab',
};
function settled(k) {
  return `<div class="cs-done"><span class="ok">${I('csOk')}</span><div class="tx"><b>Connected as ai1@happier.dev</b><span>${k === 'claude' ? 'Claude Max · Claude Code can use it now.' : 'ChatGPT Pro · Codex can use it now.'}</span></div></div>
    <div class="cs-offer"><div class="tx"><b>Add to Claude pool?</b><span>Claude Code moves to it when Personal runs out.</span></div></div>`;
}
const sheetB = (k, o = {}) => {
  const cur = o.method || SVC[k].methods[0];
  const pri = o.done ? 'Add to pool' : PRIMARY[cur](o);
  const ft = o.done ? `<div class="cs-ft"><span class="grow"></span><span class="sf-btn txt">Not now</span>${btn('Add to pool', true)}</div>` : foot(pri, { off: o.code && cur === 'With a code' });
  return dlg(head(k) + `<div class="bd">${bodyB(k, o)}</div>` + ft, `Connect ${SVC[k].t}`);
};

/* ── C · keep the segmented bar, but the selected segment IS its step (no Continue) ── */
function bodyC(k, o = {}) {
  const ms = SVC[k].methods; const cur = o.method || ms[0];
  return `<div class="sf-seg cs-seg" role="radiogroup">${ms.map((m) => `<span class="${m === cur ? 'on' : ''}" role="radio">${m}</span>`).join('')}</div>${STEP[cur]({ ...o, k })}${o.err ? errLine(o) : ''}${trust}`;
}
const sheetC = (k, o = {}) => dlg(head(k) + `<div class="bd">${bodyC(k, o)}</div>` + foot(PRIMARY[o.method || SVC[k].methods[0]](o)), `Connect ${SVC[k].t}`);

/* ── the page behind: Credentials, the "+" on the service row opened the sheet ── */
const page = (over) => shell('Credentials', rail({ sel: 'happier', hotPlus: true }), accountPage(), { over });
const psheet = (k, body, pri) => `<div class="cr-scrim"></div><div class="cr-psheet cc cs"><div class="grab"></div><div class="hd"><span class="mk">${M(k, 24)}</span><div class="tt"><b>Connect ${SVC[k].t}</b><span>${SVC[k].for}</span></div><span class="sf-ib">${I('x')}</span></div><div class="bd">${body}</div><div class="ft">${pri ? btn(pri, true) : ''}</div></div>`;
const phone = (k, o = {}) => phWrap(`${phNav('Credentials')}<div class="pg">${accountPage()}</div>${psheet(k, bodyB(k, o), o.done ? 'Add to pool' : PRIMARY[o.method || SVC[k].methods[0]](o))}`);

const NOTE_C = `<h3>C ★ (picked) · Every way stays visible; the selected one IS its step</h3>
<p>Owner: “a segmented bar promises the selected thing is below.” The fault was the broken promise, not the bar: the default tab showed a generic <i>Continue</i> (and on ChatGPT a second press), so the bar lied. Fixed at the owner, the selected tab now shows its own first step at once: a form, or one primary named for what it does (<i>Sign in with Claude</i>, <i>Sign in with a code</i>). “Should they be steps?” No: nothing here is sequential.</p>
<ul><li><b>Why C over B:</b> the control table says 2–4 options are a segmented control, all visible; Claude’s and ChatGPT’s ways are each first-class for someone (setup token for headless boxes, import for an already signed-in Mac). B hides them behind a menu for no saving; reference apps (Claude Desktop, Codex app, Cursor) lead with one button because they have one way. B stays recorded as the alternative if the owner wants the fallbacks quieter.</li>
<li><b>No generic Continue anywhere:</b> pressing the step’s primary is the explicit choice (R8-9, zero Machine RPC before it).</li>
<li><b>Step ledes</b> (“Opens claude.ai in a new tab…”) are a <code>new</code> copy proposal; the build ships the primary alone.</li><li><b>Error:</b> one line (plugin-ui <code>HappierStateLine</code>): cause left, quiet Details + Retry on the trailing edge; Details opens the code and request id under the sentence.</li></ul>`;
const NOTE_B = `<h3>B · The recommended way, with the others one press away (recorded alternative)</h3>
<p>Owner: “Should they be steps?” No: nothing here is sequential. The person wants one way that works; the others are fallbacks. So the sheet opens <b>on the recommended way’s first real step</b> (its own primary: <i>Continue with Claude</i>, <i>Get a code</i>), and the other ways sit behind a quiet <b>Other ways</b> on the method line’s trailing edge.</p>
<ul><li><b>No generic Continue.</b> Each primary says what it does. Pressing it is the explicit choice (R8-9: no code or browser sign-in starts before it, zero Machine RPC before it).</li>
<li><b>Other ways</b> opens a menu (Popover + FloatingOverlay, menu-row metrics): title + one line of what each asks. Choosing one swaps the step in place; the sheet keeps its width, the footer stays put.</li>
<li><b>References:</b> Claude Desktop, the Codex app and Cursor all lead with one sign-in button and put API key / other methods in a quiet secondary link. None uses tabs for methods.</li>
<li><b>Forms</b> use the shared field anatomy (label line in <i>label</i>, input at control height, help in <i>meta</i>) and the checklist in <i>body</i>; no page-row titles inside a popover.</li></ul>
<h4>Spec</h4><p>Popover <code>--product-page-dialog-width-px-default</code>, gutter s20. Method line: label role, Recommended as a quiet meta chip. Step swap: cross-fade 120 ms, no height animation; the popover may grow downward once. Phone: bottom sheet, primary full width, Other ways the same menu.</p>`;
S.crSignin = { title: 'Sign-in method', subtitle: 'how you pick a way to sign in, and what you see right after', def: 'c', variants: {
  bToken: { label: 'B · Setup token', h: 900, html: () => page(sheetB('claude', { method: 'Setup token' })), notes: '<h3>Setup token</h3><p>The declared checklist as two numbered lines in body type, then one shared field. Primary Connect waits for the token.</p>' },
  bImport: { label: 'B · Import native login', h: 900, html: () => page(sheetB('claude', { method: 'Import native login' })), notes: '<h3>Import native login</h3><p>Checklist, then the computer and the source as two field selects with the same label/help anatomy as the token field. The machine is part of the step, not a chip in the header.</p>' },
  bCode: { label: 'B · Paste the code', h: 900, html: () => page(sheetB('claude', { code: true })), notes: '<h3>After Continue with Claude</h3><p>The existing OAuth attempt: one waiting line with Open again, then the code field. Primary becomes Connect.</p>' },
  bErr: { label: 'B · Error line', h: 900, html: () => page(sheetB('claude', { code: true, err: true })), notes: '<h3>One error line</h3><p>The cause on the leading edge (wraps beside its actions), <b>Retry</b> and a quiet <b>Details</b> on the trailing edge of the same row. Details opens the code + request id on the next line, on the sentence’s edge, with Copy. Shared owner: plugin-ui <code>HappierStateLine</code> via <code>SurfaceStateCard size="line"</code>, so plugin line states get the same row.</p>' },
  bErrOpen: { label: 'B · Error · Details open', h: 900, html: () => page(sheetB('claude', { code: true, err: true, open: true })), notes: '<h3>Details open</h3><p>The raw code and request id, mono meta, Copy beside it.</p>' },
  bGpt: { label: 'B · ChatGPT (code)', h: 900, html: () => page(sheetB('chatgpt')), notes: '<h3>ChatGPT</h3><p>“With a code” is ranked first, so its first step is the sheet: one line of what happens and <b>Get a code</b>. No second press on an already-selected tab.</p>' },
  bGptCode: { label: 'B · ChatGPT · waiting', h: 900, html: () => page(sheetB('chatgpt', { code: true })), notes: '<h3>Code issued</h3><p>The code, where to enter it, and the waiting line (existing device attempt). The sheet watches the account itself.</p>' },
  bDone: { label: 'B · Connected', h: 900, html: () => page(sheetB('claude', { done: true })), notes: '<h3>Settled</h3><p>The moment the account appears, the waiting step is replaced by the settled line (identity through the one presenter) and the existing offer (pool / default). Not now closes; nothing waits for a second callback. Producer: CONNECT-LOGIC-1106.</p>' },
  c: { label: 'C · Segmented, real step ★', h: 900, html: () => page(sheetC('claude')), notes: NOTE_C },
  cGpt: { label: 'C · ChatGPT', h: 900, html: () => page(sheetC('chatgpt')), notes: '<h3>C · ChatGPT</h3><p>“With a code” is ranked first, so the sheet opens on its one primary, <b>Sign in with a code</b>. No second press on an already-selected tab, no Continue.</p>' },
  cToken: { label: 'C · Setup token', h: 900, html: () => page(sheetC('claude', { method: 'Setup token' })), notes: '<h3>C · Setup token</h3><p>The selected tab is its form, at once.</p>' },
  cErr: { label: 'C · Error line', h: 900, html: () => page(sheetC('claude', { code: true, err: true })), notes: '<h3>C · Error line</h3><p>Same one-row error as B: cause left, Details and Retry right.</p>' },
  phToken: { label: 'Phone · B token', phone: true, html: () => phone('claude', { method: 'Setup token' }), notes: '<h3>Phone · token</h3><p>Same field anatomy at 44 pt controls.</p>' },
  phErr: { label: 'Phone · B error', phone: true, html: () => phone('claude', { code: true, err: true }), notes: '<h3>Phone · error</h3><p>Retry and Details stay on the line’s trailing edge; the sentence wraps beside them.</p>' },
  phGpt: { label: 'Phone · ChatGPT', phone: true, html: () => phone('chatgpt'), notes: '<h3>Phone · ChatGPT</h3>' },
} };
})();
