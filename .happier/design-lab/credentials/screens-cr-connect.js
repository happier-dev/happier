// Credentials lab · cr-connect: ONE in-place Connect sheet for the whole app (lane CRED-UX, 2026-10-31).
// Owner ask (~17:40Z): "you never jump screens just to paste a key" (cloud Machine create → Connect → Credentials page);
// one coherent connect experience; find and fix split-brains.
// Product truth read this round (apps/ui/sources unless noted):
//   - openConnectedServiceSetupModal(target) (settings/connectedServices/setup/ConnectedServiceSetupModal.tsx) already
//     shows the one setup panel as a modal (wide) / sheet (phone) and closes on connect. Its one caller is the sidebar
//     usage popover "Sign in again". It returns nothing. → becomes the presenter (presentConnectSheet), not a new owner.
//   - presentShareSheet (components/sharing/presentShareSheet.ts) decides the anchored-popover / phone-sheet chrome once.
//   - ConnectedServiceSetupPanel: target {catalog | service | reconnect}, onConnected(account, serviceKey), purpose
//     requests via ConnectedServiceSetupPage; OAuth/device/manual forms + draft guard; ConnectedAccountSettled offers.
//   - Cloud create (ManagedMachineConfigurationView:638) swaps the WHOLE configurator for ConnectedServiceSetupPage.
//   - Machine token repair (ManagedMachineSections:701), Channels (renderSurface:1615), PRs & Issues
//     (triage-sources surface:204), GitHub Releases (ReleasesPage:480) and the Session auth switch push the Credentials
//     page. Plugin host API openConnectedAccounts({service, accountId?, purpose?}) navigates and resolves void.
//   - SavedSecretPickerModal (components/ui/forms/valueRefs) is the one Saved Secret picker; Provider add pastes a key
//     that becomes a Saved Secret (ProviderConnectionAuthoringScreen:577).
// Lab-only: every value is a proposal for a named owner.
(() => {
const { I, NEW, M, prow, card, sec, btn, field, phead, cx, shell, rail, phWrap, phNav, seg } = Object.assign({}, window.SF, window.CR);

Object.assign(P, {
  ccExt: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13M17 13.5v5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 4 18.5v-10A1.5 1.5 0 0 1 5.5 7H10"/>',
  ccLock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/>',
  ccHome: '<path d="M4 11 12 4.5l8 6.5"/><path d="M6 9.5V19.5h12V9.5"/>',
  ccAlert: '<path d="M12 4 21 19.5H3L12 4Z"/><path d="M12 10v4.2M12 17h.01"/>',
});
const vercel = (s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M12 4.2 20.8 19.4H3.2Z" fill="currentColor"/></svg>`;
const sentry = (s = 20) => BRAND.mono('S', '#362D59', '#fff', s);
const mark = (k, s = 20) => (k === 'vercel' ? vercel(s) : k === 'sentry' ? sentry(s) : M(k, s));

/* ── the sheet's parts (one component; the request decides which parts show) ── */
const head = (k, t, sub) => `<div class="hd"><span class="mk">${mark(k, 24)}</span><div class="tt"><b>${t}</b><span>${sub}</span></div><span class="sf-ib">${I('x')}</span></div>`;
const fld = (lb, val, o = {}) => `<div class="cc-f"><div class="lb">${lb}${o.opt ? '<span class="o">Optional</span>' : ''}<span class="grow"></span>${o.link ? `<a>${o.link}${I('ccExt')}</a>` : ''}</div><div class="in ${o.cls || ''}">${val}</div>${o.hp ? `<div class="hp ${o.bad ? 'bad' : ''}">${o.hp}</div>` : ''}</div>`;
// Storage line: the Account's encryption mode decides (plan 58 Q1); Plain Accounts get no extra step.
const store = (mode = 'e2ee') => `<div class="cc-store">${I(mode === 'e2ee' ? 'ccLock' : 'ccHome')}<span>${mode === 'e2ee'
  ? 'End-to-end encrypted in your Account. Your devices can use it; your Home can’t read it.'
  : 'Saved in your Account on Personal Home, like your other secrets.'}</span></div>`;
const who = (k, t, d, amber) => `<div class="cc-who"><span class="mk">${mark(k, 22)}</span><div class="tx"><div class="t">${t}</div><div class="d ${amber ? 'amber' : ''}">${d}</div></div></div>`;
const key = (t, d, r, on, g = 'crKey') => `<div class="cc-key ${on ? 'on' : ''}"><span class="rd"></span><span class="g">${I(g)}</span><div class="tx"><div class="t">${t}</div><div class="d">${d}</div></div>${r ? `<span class="r">${r}</span>` : ''}</div>`;
const foot = (pri, o = {}) => `<div class="ft"><span class="grow">${o.note || ''}</span>${o.cancel === false ? '' : '<span class="sf-btn txt">Cancel</span>'}${btn(pri, !o.off)}</div>`;
const dlg = (style, inner, label) => `<div class="cr-dlg cc" role="dialog" aria-label="${label}" style="${style}">${inner}</div>`;

// Vercel (machine-vercel declaration: token + optional team). New key | Saved key only when a saved key exists.
function vercelBody(o = {}) {
  // Owner 10-31 "Opening tab": already connected → Your accounts, the current one preselected; Add account one tap away.
  if (o.connected) return `${seg(['Add account', 'Your accounts'], 1)}<div class="cc-keys">
      ${key('Personal', cx('leeroy-projects', 'Pro plan'), 'In use', true, 'crTok')}
      ${key('Studio', cx('studio-team', 'Hobby'), '', false, 'crTok')}
    </div>`;
  const tabs = o.noSaved ? '' : seg(['New key', 'Saved key'], o.saved ? 1 : 0);
  if (o.saved) return `${tabs}<div class="cc-keys">
      ${key('Vercel token', cx('Token', 'only you', 'added 12 Oct'), 'Not used yet', true, 'crTok')}
      ${key('Studio Vercel', cx('Token', 'from Ari Rahman'), 'Ari approves first', false, 'crTok')}
      ${key('Registry token', cx('Token', 'used by harbor-ledger deploys'), '', false, 'crTok')}
    </div><div class="cc-store">${I('info')}<span>Picking your own key is the approval; nothing else asks. A key someone shared with you waits for their OK once.</span></div>`;
  return `${tabs}${fld('Access token', o.bad ? '<span class="mono">vcp_••••••••••••••Q7rD</span>' : o.empty ? 'Paste a token' : '<span class="mono">vcp_••••••••••••••Q7rD</span><span class="grow"></span>' + I('eye'),
      { link: 'Create one on Vercel', cls: o.bad ? 'bad' : o.empty ? 'ph' : 'focus', hp: o.bad ? 'Vercel didn’t accept this token. Check it hasn’t expired and can reach the team below.' : '', bad: o.bad })}
    ${fld('Team', 'leeroy-projects', { opt: 1, hp: 'Leave empty to use your personal account.' })}${store(o.mode)}`;
}

/* ═══ entry 1 · cloud Machine create: the Account row's Connect opens the sheet in place ═══ */
const radio = (on) => `<span class="cc-radio ${on ? 'on' : ''}"></span>`;
function cloudPage(o = {}) {
  const acct = o.done
    ? prow({ lead: vercel(20), t: 'Personal', d: `<span class="cc-just">${I('crCheck')}Connected just now</span> · leeroy-projects · Pro plan`, c: `<span class="cc-sel"><span class="mk">${vercel(14)}</span>Personal${I('chevD')}</span>`, cls: 'cc-hl' })
    : prow({ lead: vercel(20), t: 'Vercel account', d: 'Sandboxes are created and billed in your Vercel account.', c: btn('Connect', false) });
  const size = sec('Size', card([['1 vCPU', '2 GB', '$0.15'], ['2 vCPU', '4 GB', '$0.30'], ['4 vCPU', '8 GB', '$0.60'], ['8 vCPU', '16 GB', '$1.19']].map(([a, b, c], i) =>
    prow({ lead: radio(i === 1), t: a, d: `${b} memory`, c: `<span class="cr-word">${c} an hour while busy</span>` }))), { d: 'Prices from Vercel, checked 16:40. Nothing is billed while it’s stopped.' });
  const keep = sec('Keep it', card([
    prow({ t: 'When idle', d: 'Stopped after 1 hour unused; the next message starts it again.', c: `<span class="cc-sel">Stop after 1 h${I('chevD')}</span>` }),
    prow({ t: 'Region', d: 'Vercel runs sandboxes in one region today.', c: `<span class="cc-sel">Washington, D.C.${I('chevD')}</span>` }),
  ]));
  return `<div class="sf-page">${phead({ mark: vercel(28), t: 'New Vercel sandbox', d: 'Pick its account and size. You can change how long it stays on later.' })}
    ${sec('Account', card([acct]))}${size}${keep}<div class="cr-exit">${btn('Create sandbox', true)}<span class="cr-dim" style="font-size:var(--product-type-meta-size)">Happier doesn’t charge for machines. Vercel bills your team directly.</span></div></div>`;
}
const machinesCol = () => window.SF.column({ title: 'Machines', n: 4, icons: ['plus'], body: [
  window.SF.grp('This Home', [window.SF.row({ mk: 'machine', t: 'nl2-devbox', cx: 'Online · Linux' }), window.SF.row({ mk: 'machine', t: 'MacBook Pro', cx: 'Online · macOS' }), window.SF.row({ mk: 'machine', t: 'mac-studio', cx: 'Asleep' })]),
  window.SF.grp('In the cloud', [window.SF.row({ mk: 'cloud', t: 'New Vercel sandbox', on: true }), window.SF.row({ mk: 'cloud', t: 'vercel-1', cx: 'Running · 2 vCPU' })]),
].join('') });
const ANCHOR_CLOUD = 'left:845px;top:208px'; // hangs from the Account row's Connect (right edges aligned, 8 px below)
const cloud = (o = {}) => shell('Machines', machinesCol(), cloudPage(o), { over: o.done ? '' : `<div class="cc-scrim"></div>${dlg(ANCHOR_CLOUD, head('vercel', o.saved ? 'Connect Vercel' : 'Connect Vercel', 'For new sandboxes · New Vercel sandbox') + `<div class="bd">${vercelBody(o)}</div>` + foot(o.connected ? 'Use Personal' : o.saved ? 'Use Vercel token' : o.checking ? 'Checking with Vercel…' : 'Connect', { off: o.checking }), 'Connect Vercel')}` });

/* ═══ entry 2 · PRs & Issues: a signed-out source repairs in place ═══ */
function triagePage() {
  return `<div class="sf-page">${phead({ t: 'PRs & Issues', d: 'Where Happier finds pull requests, issues and alerts to watch for you.' })}
    ${sec('Sources', card([
      prow({ lead: M('github', 20), t: 'happier-bot', d: `<span class="cc-amber">GitHub · signed out 21 Oct · nothing new since</span>`, c: btn('Sign in again') }),
      prow({ lead: M('github', 20), t: 'leeroy-brun', d: cx('GitHub', '14 repositories'), c: window.CR.chev() }),
      prow({ lead: M('linear', 20), t: 'Happier', d: cx('Linear', 'workspace · 3 teams'), c: window.CR.chev() }),
      prow({ lead: sentry(20), t: 'Sentry', d: 'Errors from your projects', c: btn('Connect') }),
    ]), { d: 'Each source signs in with an account from Credentials.' })}
    ${sec('Watching', card([prow({ t: 'Review requests', d: 'Pull requests waiting on you', c: window.SF.sw(true) }), prow({ t: 'Failing checks', d: 'On branches you pushed', c: window.SF.sw(true) })]))}</div>`;
}
const triageCol = () => window.SF.column({ title: 'Triage', icons: ['plus'], body: [window.SF.grp('', [window.SF.row({ mk: 'sfList', t: 'Tasks' }), window.SF.row({ mk: 'github', t: 'PRs & Issues', on: true }), window.SF.row({ mk: 'sfSpark', t: 'Agents' })])].join('') });
function triageBody(o = {}) {
  const id = who('github', 'happier-bot', o.wait ? 'GitHub · signed out 21 Oct' : 'GitHub · signed out 21 Oct · GitHub revoked the token', !o.wait);
  if (o.paste) return `${id}${fld('Personal access token', '<span class="mono">ghp_••••••••••••••••••4xQe</span><span class="grow"></span>' + I('eye'), { link: 'Create one on GitHub', cls: 'focus', hp: 'Needs repo and read:org. The account stays happier-bot; your sources keep their settings.' })}${store()}`;
  if (o.wait) return `${id}<div class="cc-wait"><span class="sp"></span><div class="tx">Finish on GitHub<span>A tab opened for you. This closes by itself when GitHub sends you back.</span></div><span class="sf-btn">Open again</span></div><div class="cc-alt"><span>Paste a token instead</span></div>`;
  return `${id}<div class="cc-oauth">${btn('Continue on GitHub', true)}<div class="cc-alt"><span>Use a code</span><span>Paste a token instead</span></div></div>
    <div class="cc-store">${I('info')}<span>Signs in as happier-bot again. Its sources, watches and the agents that use it keep their settings.</span></div>`;
}
const ANCHOR_TRIAGE = 'left:845px;top:228px';
const triage = (o = {}) => shell('Settings', triageCol(), triagePage(), { over: `<div class="cc-scrim"></div>${dlg(ANCHOR_TRIAGE, head('github', 'Sign in to GitHub again', 'For PRs & Issues') + `<div class="bd">${triageBody(o)}</div>` + (o.paste ? foot('Sign in') : ''), 'Sign in to GitHub again')}` });

/* ═══ entry 3 · Providers → Add: the API-key row opens the same sheet; saved keys first when they exist ═══ */
function providerPage(o = {}) {
  const keyRow = o.done ? prow({ t: 'API key', d: `<span class="cc-just">${I('crCheck')}DeepSeek key</span> · from Credentials`, c: `<span class="cc-sel">${I('crKey')}DeepSeek key${I('chevD')}</span>`, cls: 'cc-hl' })
    : prow({ t: 'API key', d: 'DeepSeek needs a key to list and run its models.', c: btn('Add key') });
  return `<div class="sf-page">${phead({ mark: M('deepseek', 28), t: 'DeepSeek', d: 'Models from api.deepseek.com, for Claude Code, OpenCode and Pi.' })}
    ${sec('Connection', card([keyRow, prow({ t: 'Address', d: 'https://api.deepseek.com', c: `<span class="cr-word">Default</span>` })]))}
    ${sec('Models', card(o.done ? [prow({ t: 'deepseek-chat', d: 'V3.2 · 128K context', c: window.SF.sw(true) }), prow({ t: 'deepseek-reasoner', d: 'R2 · 128K context', c: window.SF.sw(true) })]
      : [prow({ t: 'Models appear once a key is set', d: 'Happier asks DeepSeek which models your key can use.' })]))}
    <div class="cr-exit">${btn('Add provider', !!o.done)}</div></div>`;
}
const provCol = () => window.SF.column({ title: 'Providers', n: 5, icons: ['plus'], body: [window.SF.grp('Yours', [window.SF.row({ mk: 'anthropic', t: 'Anthropic', cx: 'Work key' }), window.SF.row({ mk: 'openrouter', t: 'OpenRouter', cx: '312 models' }), window.SF.row({ mk: 'ollama', t: 'Ollama', cx: 'nl2-devbox' })]),
  window.SF.grp('Adding', [window.SF.row({ mk: 'deepseek', t: 'DeepSeek', cx: 'Not saved yet', on: true })])].join('') });
function providerBody(o = {}) {
  if (!o.saved) return `${seg(['New key', 'Saved key'], 0)}${fld('API key', '<span class="mono">sk-••••••••••••••••a91c</span><span class="grow"></span>' + I('eye'), { link: 'Get one from DeepSeek', cls: 'focus' })}${fld('Name', 'DeepSeek key', { hp: 'How it shows in Credentials and pickers.' })}${store()}`;
  return `${seg(['New key', 'Saved key'], 1)}<div class="cc-keys">
      ${key('DeepSeek key', cx('API key', 'only you', 'added 3 Oct'), 'Not used yet', true)}
      ${key('Work key', cx('Anthropic API key', 'Claude Code, OpenCode'), '', false)}
      ${key('OpenAI API key', cx('API key', 'used by Voice'), '', false)}
      ${key('Staging database URL', cx('Secret', 'from Ari Rahman'), 'Ari approves first', false)}
    </div>`;
}
const ANCHOR_PROV = 'left:845px;top:208px';
const provider = (o = {}) => shell('Providers', provCol(), providerPage(o), { over: o.done ? '' : `<div class="cc-scrim"></div>${dlg(ANCHOR_PROV, head('deepseek', 'DeepSeek API key', 'For the DeepSeek provider') + `<div class="bd">${providerBody(o)}</div>` + foot(o.saved ? 'Use DeepSeek key' : 'Save key'), 'DeepSeek API key')}` });

/* ═══ expired: a Machine's token was refused → replace it in place (same sheet, reconnect target) ═══ */
function machinePage() {
  return `<div class="sf-page">${phead({ mark: vercel(28), t: 'vercel-1', meta: `<span>Vercel sandbox</span><span class="cr-meta-sep">·</span><span>2 vCPU · 4 GB</span><span class="cr-meta-sep">·</span><span>Personal</span>` })}
    <div class="cr-banner">${I('ccAlert')}<div class="tx"><b>Vercel refused the token for Personal</b><span>vercel-1 can’t start or stop until it’s replaced. It keeps running meanwhile.</span></div>${btn('Replace token')}</div>
    ${sec('Status', card([prow({ t: 'Running', d: 'Since 09:12 · 3 sessions', c: window.CR.word('$0.30 an hour while busy') }), prow({ t: 'When idle', d: 'Stops after 1 hour unused', c: window.CR.chev() })]))}
    ${sec('Account', card([prow({ lead: vercel(20), t: 'Personal', d: `<span class="cc-amber">Vercel · token refused 10:41</span> · used by vercel-1 and 2 presets`, c: window.CR.chev() })]))}</div>`;
}
const machinesCol2 = () => window.SF.column({ title: 'Machines', n: 4, icons: ['plus'], body: [
  window.SF.grp('This Home', [window.SF.row({ mk: 'machine', t: 'nl2-devbox', cx: 'Online · Linux' }), window.SF.row({ mk: 'machine', t: 'MacBook Pro', cx: 'Online · macOS' })]),
  window.SF.grp('In the cloud', [window.SF.row({ mk: 'cloud', t: 'vercel-1', cx: 'Running · token refused', st: 'signin', on: true })]),
].join('') });
function expiredBody(o = {}) {
  return `${who('vercel', 'Personal', 'Vercel · token refused 10:41', true)}${seg(['New key', 'Saved key'], 0)}
    ${fld('Access token', '<span class="mono">vcp_••••••••••••••8LmT</span><span class="grow"></span>' + I('eye'), { link: 'Create one on Vercel', cls: 'focus', hp: 'Replaces the token for Personal. vercel-1 and both presets pick it up on their next start.' })}
    ${o.keep ? `<div class="cc-lbl">This key is Home-managed today</div><div class="cc-choice">
      <div class="cr-choice on"><span class="rd"></span><div class="tx"><b>Encrypt it</b><span>Only your devices can read it from now on.</span></div></div>
      <div class="cr-choice"><span class="rd"></span><div class="tx"><b>Keep Home-managed</b><span>Your Home can keep reading it, as it does today.</span></div></div></div>` : store()}`;
}
const ANCHOR_EXP = 'left:845px;top:168px';
const expired = (o = {}) => shell('Machines', machinesCol2(), machinePage(), { over: `<div class="cc-scrim"></div>${dlg(ANCHOR_EXP, head('vercel', 'Replace Vercel token', 'Used by vercel-1 and 2 presets') + `<div class="bd">${expiredBody(o)}</div>` + foot('Replace'), 'Replace Vercel token')}` });

/* ═══ phone: the same sheet as a bottom sheet over the page that asked ═══ */
const psheet = (k, t, sub, body, pri) => `<div class="cr-scrim"></div><div class="cr-psheet cc"><div class="grab"></div><div class="hd"><span class="mk">${mark(k, 24)}</span><div class="tt"><b>${t}</b><span>${sub}</span></div><span class="sf-ib">${I('x')}</span></div><div class="bd">${body}</div><div class="ft">${pri ? btn(pri, true) : ''}</div></div>`;
const phCloud = () => phWrap(`${phNav('Add a machine')}<div class="pg">${cloudPage()}</div>${psheet('vercel', 'Connect Vercel', 'For new sandboxes', vercelBody(), 'Connect')}`);
const phTriage = () => phWrap(`${phNav('Settings')}<div class="pg">${triagePage()}</div>${psheet('github', 'Sign in to GitHub again', 'For PRs & Issues', triageBody(), '')}`);
const phProv = () => phWrap(`${phNav('Providers')}<div class="pg">${providerPage()}</div>${psheet('deepseek', 'DeepSeek API key', 'For the DeepSeek provider', providerBody({ saved: true }), 'Use DeepSeek key')}`);

/* ═══ register ═══ */
const NOTE = `<h3>One Connect sheet, opened where you are</h3>
<p>Owner (10-31): “never jump screens just to paste a key … one coherent connect experience.” Today 6 entries push the Credentials page, and cloud create swaps its whole configurator for the setup page (CRED-UX §verdicts).</p>
<ul><li><b>One presenter</b>: <code>presentConnectSheet({ service, purpose?, account?, anchor? }) → Promise&lt;ConnectResult&gt;</code>. It is today’s <code>openConnectedServiceSetupModal</code> grown a typed result and the share sheet’s chrome decision; the body is today’s <code>ConnectedServiceSetupPanel</code> (OAuth / device / paste forms, draft guard, settle). No second form.</li>
<li><b>Desktop/web</b>: a popover hanging from the control that asked (Popover + FloatingOverlay, origin at the trigger, flips and clamps). <b>Phone</b>: a bottom sheet that tracks the finger. Same body.</li>
<li><b>Returns</b> <code>{ kind: 'connected' | 'selected', account }</code> or <code>{ kind: 'dismissed' }</code>; the caller selects it in its own draft. The page behind never re-renders into another page.</li>
<li><b>Saved key</b> sits inside the same sheet (New key | Saved key, only when a saved key exists): picking your own key is the grant (10-31 ruling); someone else’s waits for their OK once.</li>
<li><b>Storage line</b> follows the Account mode (Q1): E2EE says end-to-end encrypted; Plain says saved on your Home. No extra step for Plain.</li></ul>
<h4>Spec</h4><p>Popover width <code>--product-page-dialog-width-px-default</code>; it keeps its height while a method switches (fields reserve their rows). Primary on the right; Cancel quiet. Checking: the primary becomes its own progress, nothing else moves. Refused: the provider’s typed reason under the field, draft kept. Motion: popover grows from the trigger (motionTokens short ease-out), returns along the same path; success closes it and the caller row eases its fill once.</p>`;
S.crConnect = { title: 'Connect in place', subtitle: 'one Connect sheet · cloud create, PRs & Issues repair, Provider add', def: 'cloud', variants: {
  cloud: { label: 'Cloud create ★', h: 940, html: () => cloud(), notes: NOTE },
  cloudBad: { label: 'Refused', h: 940, html: () => cloud({ bad: true }), notes: '<h3>Refused</h3><p>Vercel’s typed reason under the field; the token and team stay; Connect again. Nothing else on the page moves.</p>' },
  cloudSaved: { label: 'Saved key', h: 940, html: () => cloud({ saved: true }), notes: '<h3>Use a saved key</h3><p>The same sheet’s second segment lists the Account’s keys (the one SavedSecretPicker catalog, filtered to keys and tokens, most likely first). Your own: one press, the link is the grant. Shared with you: the row says the owner approves first (consent at the owner, unchanged).</p>' },
  cloudConnected: { label: 'Already connected', h: 940, html: () => cloud({ connected: true }), notes: '<h3>Already connected → Your accounts</h3><p>Owner ruling 10-31 (Opening tab): a matching credential already exists, so the sheet opens on the saved side with the current one preselected; Add account is one tap away. No match → it opens on New. Live: <code>ConnectSheetContent</code> account leaf.</p>' },
  cloudDone: { label: 'Returned ★', h: 940, html: () => cloud({ done: true }), notes: '<h3>Back where you were</h3><p>On success the sheet closes itself and the caller selects the new account in its draft: the Account row shows <i>Personal</i> with “Connected just now” once (a single fill ease), size and Keep it untouched. No “Choose size and place” step: the person never left the configurator. Pool/default offers (ConnectedAccountSettled) appear only when the sheet was opened from Credentials itself.</p>' },
  triage: { label: 'PRs & Issues repair ★', h: 940, html: () => triage(), notes: '<h3>Repair a named account in place</h3><p>Reconnect target: the sheet names the account (happier-bot) and the cause once. Primary leaves for GitHub (OAuth); “Use a code” and “Paste a token instead” are the other declared modes, ranked by the existing rankConnectedAccountSetupModes. The account id, its sources and watches are kept (rotate, not add).</p><p>Plugins get this through the host: <code>api.ui.openConnectedAccounts({ service, accountId })</code> now resolves with the result instead of navigating ' + NEW + '.</p>' },
  triageWait: { label: 'Waiting for GitHub', h: 940, html: () => triage({ wait: true }), notes: '<h3>Waiting</h3><p>The existing attempt state: one line, Open again, paste fallback. Closing the popover keeps the attempt; reopening resumes it (existing addressed attempt).</p>' },
  triagePaste: { label: 'Paste a token', h: 940, html: () => triage({ paste: true }), notes: '<h3>Paste fallback</h3><p>Same sheet, the token method. Same field anatomy as Vercel and DeepSeek: one form for every pasted credential.</p>' },
  provider: { label: 'Provider add ★', h: 940, html: () => provider({ saved: true }), notes: '<h3>Providers → Add</h3><p>The API key row opens the same sheet for kind API key, purpose “provider”. The person already has a DeepSeek key in Credentials, so Saved key opens first. Today Provider add has its own paste field plus the picker; the sheet replaces both.</p>' },
  providerNew: { label: 'Provider · new key', h: 940, html: () => provider(), notes: '<h3>New key</h3><p>Paste + a name (defaults to “DeepSeek key”). Saving creates one Saved Secret and links it (58c U3: one resource + one reference). The name is how it shows in Credentials.</p>' },
  providerDone: { label: 'Provider · returned', h: 940, html: () => provider({ done: true }), notes: '<h3>Returned</h3><p>The row holds the linked key; models load; Add provider becomes primary.</p>' },
  expired: { label: 'Expired repair', h: 940, html: () => expired(), notes: '<h3>Token refused → replace in place</h3><p>Today vercel-1’s Reconnect pushes the whole Credentials page without naming the account (ManagedMachineSections:701). Here the banner’s Replace token opens the sheet on that exact account; the record keeps its id and grants (rotate).</p>' },
  expiredKeep: { label: 'Expired · Keep/Encrypt', h: 940, html: () => expired({ keep: true }), notes: '<h3>Home-managed key on an E2EE Account</h3><p>Ruling (10-31): rotating a still-Plain key asks ONE choice, Encrypt (default) or Keep Home-managed, in place. The consequence is said in each choice. No stored marker, no second dialog. Plain Accounts never see it.</p>' },
} };
Object.assign(S.crConnect.variants, {
  phCloud: { label: 'Phone · cloud', phone: true, html: phCloud, notes: '<h3>Phone · cloud create</h3><p>Bottom sheet over Add a machine; primary full width; the keyboard pushes the sheet, never covers the field.</p>' },
  phTriage: { label: 'Phone · repair', phone: true, html: phTriage, notes: '<h3>Phone · repair</h3><p>Same body; Continue on GitHub opens the system browser and returns by deep link (existing callback).</p>' },
  phProv: { label: 'Phone · saved key', phone: true, html: phProv, notes: '<h3>Phone · saved key</h3><p>Rows at menu metrics, 48 pt targets.</p>' },
});
})();
