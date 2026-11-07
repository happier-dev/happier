// Credentials lab · cr-guide: the Connect sheet for API-key services (lane CREDS-TEMPLATES-DESIGN, 2026-11-03).
// Owner (11-03, screenshots CREDS-TEMPLATES-evidence/owner-connect-{modal,hetzner}-empty.png): "Connect Hetzner cloud account"
// opens a sheet with a key glyph, "The account works on every machine." and Continue — no field, no guidance. Asks: the
// provider's logo; short specific steps to create the credential; a link to that provider's console; the same for Voice
// (ElevenLabs, Grok/xAI); "Secret" near the top of Credentials "+".
// Product truth read this round (apps/ui/sources unless noted):
//   - The sheet body is ConnectedServiceSetupPanel chrome="sheet" → renderFlow(entry): ConnectedAccountSetupController,
//     then the lock line (connectedServicesSettings.setupTrust). Manual (paste) modes render ConnectedAccountManualForm.
//   - Guidance exists ONCE today, hard-coded for Anthropic only: connectedServiceRegistry BUILT_IN_SETUP_PRESENTATION
//     .manual { consoleUrl, createKeyTitleKey, billingNoteKey, shapeHintKey } → ManualForm `guided` (per-field subtitle +
//     "Open console" link). Plugins (Hetzner, Modal, Vercel, ElevenLabs…) have no way to say it → split-brain, moves to the
//     declaration (CREDS-TEMPLATES-LOGIC owns the data).
//   - Marks: ConnectedServiceMark resolves legacyServiceId only, so every plugin service draws the key glyph. Hetzner already
//     ships its brand for Machines (manifest brand.iconResourceId 'brand-icon'); the sheet reuses that, no second registry.
//   - Saved keys: ConnectKeySheetBody / ConnectSheetContent already offer New | Saved inside the same sheet.
// Lab-only: every value is a proposal for a named owner.
(() => {
const { I, M, prow, card, sec, btn, cx, shell, rail, phWrap, phNav, seg, accountPage } = Object.assign({}, window.SF, window.CR);

Object.assign(P, {
  cgExt: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13M17 13.5v5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 4 18.5v-10A1.5 1.5 0 0 1 5.5 7H10"/>',
  cgLock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/>',
  cgCheck: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  cgChevD: '<path d="m6 9 6 6 6-6"/>',
  cgChevR: '<path d="m9 6 6 6-6 6"/>',
  cgKey: '<circle cx="8" cy="15" r="3.6"/><path d="m10.6 12.4 7.4-7.4M15.5 7.5l2.2 2.2M13.3 9.7l1.6 1.6"/>',
  cgEye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
});

/* ── brand stand-ins (the live marks come from each plugin's declared brand asset) ── */
const BR = {
  hetzner: (s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="3" fill="#D50C2D"/><path d="M7.5 6.5v11M16.5 6.5v11M7.5 12h9" stroke="#fff" stroke-width="2.6"/></svg>`,
  modal: (s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none"><path d="M2.5 16.5 7 7.5l4.5 9M12.5 16.5 17 7.5l4.5 9" stroke="#62DE61" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/></svg>`,
  elevenlabs: (s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><rect x="7" y="3.5" width="3.2" height="17" rx=".6" fill="currentColor"/><rect x="13.8" y="3.5" width="3.2" height="17" rx=".6" fill="currentColor"/></svg>`,
  xai: (s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor"><path d="M3.5 4h3.6l13.4 16h-3.6L3.5 4Zm12.6 0h3.6l-5.3 6.3-1.8-2.1L16.1 4ZM9.7 15.7l1.8 2.1L9.1 20.6H5.5l4.2-4.9Z"/></svg>`,
  vercel: (s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M12 4.2 20.8 19.4H3.2Z" fill="currentColor"/></svg>`,
  e2b: (s = 20) => BRAND.mono('e2b', '#FF8800', '#fff', s).replace(/font-size:[^;]+;/, `font-size:${Math.round(s * .36)}px;`),
};
const mark = (k, s = 20) => (BR[k] ? BR[k](s) : M(k, s));

/* ── the declaration each service carries (CREDS-TEMPLATES-LOGIC owns the real shape; data only) ── */
const SVC = {
  hetzner: { name: 'Hetzner', title: 'Connect Hetzner', purpose: 'Create cloud servers for your agents, billed to your Hetzner project.',
    console: 'Hetzner Console', steps: ['Open your project in the Hetzner Console', 'Go to <b>Security → API tokens</b> and choose <b>Generate API token</b>.', 'Pick <b>Read & Write</b>, then copy the token. Hetzner shows it once.'],
    fields: [{ lb: 'API token', ph: 'Paste the token', val: 'hk7Q••••••••••••••••••••••••••••Zt2', hint: '64 characters' }], saved: 'Hetzner token' },
  modal: { name: 'Modal', title: 'Connect Modal', purpose: 'Run sandboxes in your Modal workspace. Modal bills your workspace directly.',
    console: 'Modal settings', steps: ['Open Settings → API tokens in Modal', 'Choose <b>New token</b>. Modal shows a token ID and a secret.', 'Copy both into the fields below.'],
    fields: [{ lb: 'Token ID', ph: 'ak-…', val: 'ak-4fQm2Rr8tWbN1sXe' , mono: true}, { lb: 'Token secret', ph: 'as-…', val: 'as-••••••••••••••••••••Lp0d', secret: true }], saved: 'Modal token' },
  elevenlabs: { name: 'ElevenLabs', title: 'Connect ElevenLabs', purpose: 'Voices for talking to your agents. ElevenLabs bills your account per character.',
    console: 'ElevenLabs', steps: ['Open Developers → API keys in ElevenLabs', 'Choose <b>Create API key</b> and allow <b>Text to Speech</b> and <b>Speech to Text</b>.', 'Copy the key.'],
    fields: [{ lb: 'API key', ph: 'sk_…', val: 'sk_••••••••••••••••••••••••••••••••c41a' }], saved: 'ElevenLabs key' },
  xai: { name: 'xAI', title: 'Connect xAI', purpose: 'Grok voice for talking to your agents. xAI bills your team per minute.',
    console: 'xAI Console', steps: ['Open API keys in the xAI Console', 'Choose <b>Create API key</b> and allow the <b>Voice</b> endpoints.', 'Copy the key.'],
    fields: [{ lb: 'API key', ph: 'xai-…', val: 'xai-••••••••••••••••••••••••R7mE' }], saved: 'xAI key' },
};

/* ── parts (one sheet; the declaration decides the words, never a per-service component) ── */
const head = (k, s, o = {}) => o.bigMark
  ? `<div class="hd cg-hd-a"><span class="mk">${mark(k, 44)}</span><div class="tt"><b>${s.title}</b><span>${s.purpose}</span></div><span class="sf-ib">${I('x')}</span></div>`
  : `<div class="hd cg-hd-b"><div class="ln"><span class="mk">${mark(k, 20)}</span><b>${s.title}</b><span class="sf-ib">${I('x')}</span></div><p>${s.purpose}</p></div>`;
const consoleLink = (s, o = {}) => `<a class="cg-link ${o.cls || ''}">Open ${s.console}${I('cgExt')}</a>`;
// A: the steps are a quiet numbered list; the console link closes it; the field follows. Step 1 is the link's own sentence.
const steps = (s) => `<div class="cg-steps"><ol>${s.steps.map((x, i) => `<li><span>${i === 0 ? `<a class="cg-inl">${x}${I('cgExt')}</a>` : x}</span></li>`).join('')}</ol></div>`;
function fields(s, o = {}) {
  return s.fields.map((f, i) => {
    const filled = o.filled || o.bad || o.checking;
    const v = filled ? `<span class="mono">${f.val}</span><span class="grow"></span>${f.secret !== false && !f.mono ? I('cgEye') : ''}` : `<span>${f.ph}</span>`;
    const cls = o.bad && i === s.fields.length - 1 ? 'bad' : filled ? (i === s.fields.length - 1 && !o.checking ? 'focus' : '') : (i === 0 ? 'focus ph' : 'ph');
    const hp = o.bad && i === s.fields.length - 1 ? `<div class="hp bad">${s.name} didn’t accept this token: it needs Read & Write. Generate a new one with that permission.</div>` : '';
    return `<div class="cc-f"><div class="lb">${f.lb}</div><div class="in ${cls}">${v}</div>${hp}</div>`;
  }).join('');
}
const store = () => `<div class="cc-store">${I('cgLock')}<span>Saved to your Account, end-to-end encrypted. Your machines use it; your Home can’t read it.</span></div>`;
const foot = (pri, on, o = {}) => `<div class="ft"><span class="grow">${o.note || ''}</span><span class="sf-btn txt">Cancel</span><span class="sf-btn pri ${on ? '' : 'dis'}">${pri}</span></div>`;
const savedList = (s) => `<div class="cc-keys">
  <div class="cc-key on"><span class="rd"></span><span class="g">${I('cgKey')}</span><div class="tx"><div class="t">${s.saved}</div><div class="d">Token · only you · added 28 Oct</div></div><span class="r">Not used yet</span></div>
  <div class="cc-key"><span class="rd"></span><span class="g">${I('cgKey')}</span><div class="tx"><div class="t">Studio ${s.name}</div><div class="d">Token · from Ari Rahman</div></div><span class="r">Ari approves first</span></div></div>`;

/* the body: A (recommended) — guide, then fields; Saved key hides the guide (nothing to create) */
function bodyA(s, o = {}) {
  const tabs = o.hasSaved ? seg(['New key', 'Saved key'], o.saved ? 1 : 0) : '';
  if (o.saved) return `${tabs}${savedList(s)}`;
  return `${tabs}${steps(s)}${fields(s, o)}${store()}`;
}
const ANCHOR = 'left:745px;top:96px';
const page = (over) => shell('Credentials', rail({ sel: 'home' }), accountPage(), { over });
const sheet = (k, body, pri, on, o = {}) => `<div class="cc-scrim"></div><div class="cr-dlg cc cg" role="dialog" aria-label="${SVC[k].title}" style="${o.anchor || ANCHOR}">${head(k, SVC[k], o)}<div class="bd">${body}</div>${foot(pri, on, o)}</div>`;
const sc = (k, body, pri, on, o) => page(sheet(k, body, pri, on, o));

const A = (k, o = {}) => sc(k, bodyA(SVC[k], o), o.saved ? `Use ${SVC[k].saved}` : o.checking ? `Checking with ${SVC[k].name}…` : 'Connect', o.saved || o.filled, o);

/* ═══ the "+" menu: Secret near the top, every service with its mark ═══ */
const mi = (lead, t, d, r = '', o = {}) => `<div class="it ${o.on ? 'on' : ''}"><span class="c">${lead}</span><div class="tx"><b>${t}</b>${d ? `<span>${d}</span>` : ''}</div>${r ? `<span class="r">${r}</span>` : ''}</div>`;
function addMenu() {
  const g = (t) => `<div class="gh">${t}</div>`;
  return `<div class="cr-menu cg-menu" style="left:404px;top:58px" role="menu">
    <div class="find"><span class="sf-field">${I('sfSearch')}<span>Search services</span></span></div>
    ${mi(I('cgKey'), 'Secret', 'A key, token or password for anything else', '', { on: true })}
    <div class="sp"></div>
    ${g('Agent sign-in')}${mi(M('claude', 16), 'Claude subscription', 'Claude Code, OpenCode and Pi', '2 added')}${mi(M('chatgpt', 16), 'ChatGPT', 'Codex, OpenCode and Pi', '3 added')}${mi(M('anthropic', 16), 'Anthropic API key', 'Claude Code, OpenCode', '1 added')}
    ${g('Cloud machines')}${mi(mark('hetzner', 16), 'Hetzner', 'Cloud servers')}${mi(mark('modal', 16), 'Modal', 'Sandboxes')}${mi(mark('vercel', 16), 'Vercel', 'Sandboxes', '1 added')}${mi(mark('e2b', 16), 'E2B', 'Sandboxes')}
    ${g('Voice')}${mi(mark('elevenlabs', 16), 'ElevenLabs', 'Voices and transcription')}${mi(mark('xai', 16), 'xAI', 'Grok voice')}
    ${g('Code and tools')}${mi(M('github', 16), 'GitHub', 'Pull requests, issues and checks', '2 added')}${mi(M('linear', 16), 'Linear', 'Issues')}
  </div>`;
}
const menuScene = () => page(addMenu());

/* ═══ phone: the same body in the bottom sheet ═══ */
const psheet = (k, body, pri, on) => `<div class="cr-scrim"></div><div class="cr-psheet cc cg"><div class="grab"></div>${head(k, SVC[k])}<div class="bd">${body}</div><div class="ft"><span class="sf-btn pri ${on ? '' : 'dis'}">${pri}</span></div></div>`;
const phPage = () => `${phNav('Credentials')}<div class="pg">${accountPage()}</div>`;
const ph = (k, o = {}) => phWrap(`${phPage()}${psheet(k, bodyA(SVC[k], o), 'Connect', !!o.filled)}`);

/* ═══ register ═══ */
const NOTE = `<h3>A ★ · Guide, then the key</h3>
<p>Owner (11-03): each service shows its logo, short specific steps to create the credential, and a link to its console. One generic sheet; the declaration supplies the words.</p>
<ul><li><b>Band</b>: the provider’s mark (its declared brand asset, bare) · “Connect Hetzner” · one line of what it’s for and who bills it. The band replaces “The account works on every machine.”, which said nothing about Hetzner.</li>
<li><b>Steps</b>: 2–3 numbered lines in meta size, the provider’s own menu names in medium weight. The console link closes the list, so the person reads where to go, then goes. No per-field “Create one” link: one place for it (the Anthropic-only <code>guided</code> subtitle + link move here).</li>
<li><b>Fields</b>: the declared manual fields, labels from the declaration, focus on the first. Connect stays disabled until every field matches its schema (the existing validators), then checks with the provider; its refusal reason lands under the field.</li>
<li><b>Saved key</b>: New key | Saved key appears only when a matching saved key exists; Saved hides the steps (nothing to create).</li>
<li><b>Storage line</b>: unchanged owner (Account mode decides the words).</li></ul>
<h4>Why A</h4><p>B hides the guidance the owner asked to see; C binds the form inside a step list, so Modal’s two fields and the Saved tab fight the numbering, and the ManualForm would have to render inside guidance it doesn’t own. A keeps the guide a block above the one form: one renderer in <code>renderFlow</code>, every service, no per-service component.</p>`;
S.crGuide = { title: 'Connect an API-key service', subtitle: 'logo, steps, console link · Hetzner, Modal, ElevenLabs · “+” with Secret', def: 'hetzner', variants: {
  hetzner: { label: 'A · Hetzner ★', h: 940, html: () => A('hetzner'), notes: NOTE },
  hetznerFilled: { label: 'A · filled', h: 940, html: () => A('hetzner', { filled: true }), notes: '<h3>Filled</h3><p>The token matches the declared shape, so Connect enables. Nothing else moves.</p>' },
  hetznerChecking: { label: 'A · checking', h: 940, html: () => A('hetzner', { checking: true }), notes: '<h3>Checking</h3><p>The primary becomes its own progress (“Checking with Hetzner…”); fields lock; the sheet keeps its height.</p>' },
  hetznerBad: { label: 'A · refused', h: 940, html: () => A('hetzner', { bad: true, filled: true }), notes: '<h3>Refused</h3><p>The provider’s typed reason under the field (the plugin’s diagnostic, said in words), the draft kept, Connect again.</p>' },
  hetznerSaved: { label: 'A · saved key', h: 940, html: () => A('hetzner', { hasSaved: true, saved: true }), notes: '<h3>Saved key</h3><p>The same New | Saved switch as every key sheet; Saved lists the Account’s matching keys and hides the steps.</p>' },
  modal: { label: 'A · Modal (2 fields)', h: 940, html: () => A('modal'), notes: '<h3>Modal</h3><p>Two declared fields (token ID, secret). The steps say both appear at once; the second field is secret, the first is not.</p>' },
  elevenlabs: { label: 'A · ElevenLabs', h: 940, html: () => A('elevenlabs'), notes: '<h3>Voice providers</h3><p>ElevenLabs and xAI use the same sheet and the same Saved Secret owner as every key; Voice settings’ key field opens it too (LOGIC routes the binding).</p>' },
  xai: { label: 'A · xAI', h: 940, html: () => A('xai', { hasSaved: true }), notes: '<h3>xAI · Grok voice</h3><p>With a saved key present the switch appears, New stays selected because nothing matches yet.</p>' },
  menu: { label: '“+” menu ★', h: 940, html: menuScene, notes: '<h3>Credentials “+”</h3><ul><li><b>Secret</b> first, above the groups: the one entry that isn’t a service (opens the existing Saved Secret create flow in the same sheet).</li><li>Every service row carries its mark: plugin services through their declared brand asset; key glyph only when a service declares none.</li><li>Voice is its own group (ElevenLabs, xAI), from the declaration’s category.</li></ul>' },
  phHetzner: { label: 'Phone · Hetzner', phone: true, html: () => ph('hetzner'), notes: '<h3>Phone</h3><p>The same body in the bottom sheet; primary full width; the keyboard pushes the sheet.</p>' },
  phModal: { label: 'Phone · Modal filled', phone: true, html: () => ph('modal', { filled: true }), notes: '<h3>Phone · two fields filled</h3>' },
} };
/* ═══ round 2 (owner 11-03 14:35, owner-cloudflare-methods.png): two methods read as one choice ═══ */
// Picker: 2 methods = equal segmented, no "Recommended" (first and selected already says it); 1 = no picker; 3+ = today's bar.
// Own-client fields fold under Advanced; permissions are a per-feature list, not more numbered steps.
BR.cloudflare = (s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M16.6 15.8c.2-.6.1-1.1-.2-1.5-.3-.4-.7-.6-1.3-.6l-8.6-.1c-.1 0-.1 0-.2-.1v-.1c0-.1.1-.2.2-.2l8.7-.1c1-.1 2.1-.9 2.5-1.9l.5-1.3v-.2C17.6 7 15.4 5.2 12.800 5.200c-2.400 0-4.400 1.500-5.100 3.700-.5-.3-1-.5-1.700-.4-1.100.1-2 1-2.100 2.100v.8C2.100 11.500.8 12.900.8 14.600c0 .2 0 .3 0 .5 0 .1.1.1.2.1h15.400c.1 0 .2-.1.200-.2Z" fill="#F38020"/><path d="M19.300 10.500h-.3c-.1 0-.1 0-.2.1l-.3 1.100c-.2.600-.1 1.100.2 1.500.3.400.7.600 1.300.6l1.800.1c.1 0 .1 0 .2.1v.1c0 .1-.1.2-.2.2l-1.900.1c-1 .1-2.100.9-2.500 1.900l-.1.400c0 .1 0 .1.100.1h6.600c.1 0 .1 0 .1-.1.1-.4.200-.9.200-1.300 0-2.500-2-4.500-4.500-4.500Z" fill="#FAAD3F"/></svg>`;
SVC.cloudflare = { name: 'Cloudflare', title: 'Connect Cloudflare', purpose: 'Deploy Workers and Pages and route tunnels from your Cloudflare account.', console: 'Cloudflare', saved: 'Cloudflare token',
  steps: ['Open API tokens in Cloudflare', 'Choose <b>Create token</b> and allow the permissions below for what you’ll use.', 'Copy the token. Cloudflare shows it once.'],
  perms: [['Workers', 'Workers Scripts: Edit · Workers CI: Edit'], ['Pages', 'Pages: Edit'], ['Tunnel and DNS', 'Cloudflare Tunnel: Edit · DNS: Edit'], ['Every token', 'Account Settings: Read · API Tokens: Read']],
  fields: [{ lb: 'API token', ph: 'Paste the token', val: 'cfut_••••••••••••••••••••••••••••a3Xk' }] };
const perms = (s) => `<div class="cg-perms"><div class="h">Permissions it needs</div>${s.perms.map(([f, i]) => `<div class="p"><b>${f}</b><span>${i}</span></div>`).join('')}</div>`;
const methodSeg = (on) => `<div class="cg-seg">${seg(['Sign in with Cloudflare', 'API token'], on)}</div>`;
const cfAdvanced = (open) => `<div class="cg-adv ${open ? 'open' : ''}"><div class="t"><span>Advanced</span><span class="grow"></span><span class="n">${open ? '' : 'Your own OAuth client'}</span>${I(open ? 'cgChevD' : 'cgChevR')}</div>${open ? `<div class="b"><div class="cc-f"><div class="lb">OAuth client ID</div><div class="in ph"><span>Leave empty to use this Home’s client</span></div></div><div class="cc-f"><div class="lb">Registered API scope IDs</div><div class="in ph"><span>Space-separated</span></div><div class="hp">Must include the scopes for Workers or Pages.</div></div></div>` : ''}</div>`;
const cfBody = (o = {}) => o.token ? `${methodSeg(1)}${steps(SVC.cloudflare)}${perms(SVC.cloudflare)}${fields(SVC.cloudflare, o)}${store()}` : `${methodSeg(0)}${cfAdvanced(o.open)}${store()}`;
const CF_NOTE = `<h3>Two methods read as one choice</h3><p>Owner (14:35): the picker listed “With a browser” twice and three per-feature tokens, under a technical paragraph. LOGIC consolidates the declaration to at most “Sign in with Cloudflare” + one “API token”.</p>
<ul><li><b>Picker</b>: two methods are an equal segmented control, the same one as New | Saved; one method has no picker; three or more keep today’s bar. No “Recommended” badge at two: first and selected already says it.</li>
<li><b>Names</b>: a declared mode title wins over “With a browser”. That override is what printed the duplicate.</li>
<li><b>Description</b>: one sentence from the declaration; instructions move to <code>setup</code>.</li>
<li><b>Account choice</b>: sign in first, then choose from the returned account names after consent. One account is used directly; several use the existing account-choice scene.</li>
<li><b>Advanced</b>: declared per field (<code>presentation.advanced</code>), closed by default, open when it holds a value or an error. The row names what’s inside.</li>
<li><b>Permissions</b>: <code>setup.permissions</code>, per feature, under the steps. They aren’t a sequence, so they aren’t numbered; pick what you’ll use.</li>
<li><b>Fields stack</b> inside the sheet; the side-by-side row left long descriptions in a narrow column.</li></ul>`;
Object.assign(S.crGuide.variants, {
  cfSignIn: { label: 'Cloudflare · sign in ★', h: 940, html: () => sc('cloudflare', cfBody(), 'Continue with Cloudflare', true, { anchor: 'left:745px;top:140px' }), notes: CF_NOTE },
  cfAdvanced: { label: 'Cloudflare · Advanced', h: 940, html: () => sc('cloudflare', cfBody({ open: true }), 'Continue', false, { anchor: 'left:745px;top:140px' }), notes: '<h3>Advanced open</h3><p>Own-client fields only. The Cloudflare account is chosen after consent, never by entering an Account ID before sign-in. Everything else on the sheet stays put; the sheet grows downward.</p>' },
  cfToken: { label: 'Cloudflare · API token ★', h: 940, html: () => sc('cloudflare', cfBody({ token: true }), 'Connect', false, { anchor: 'left:745px;top:96px' }), notes: '<h3>API token</h3><p>Steps, per-feature permissions, console link position unchanged, one field.</p>' },
  phCfToken: { label: 'Phone · API token', phone: true, html: () => phWrap(`${phPage()}${psheet('cloudflare', cfBody({ token: true }), 'Connect', false)}`), notes: '<h3>Phone</h3><p>“Sign in with Cloudflare” must fit half the sheet at 390; permissions stack feature over items.</p>' },
});
/* ═══ round 3 (owner taste 11-03): one left edge, one rhythm; Account ID after sign-in ═══ */
const cfAccounts = () => `<div class="cc-keys"><div class="cc-key on"><span class="rd"></span><div class="tx"><div class="t">Happier Labs</div><div class="d">Owner</div></div></div><div class="cc-key"><span class="rd"></span><div class="tx"><div class="t">Studio</div><div class="d">Administrator</div></div></div></div>`;
const cfNoId = (o = {}) => `${methodSeg(0)}${o.choose ? `<div class="cc-f"><div class="lb">Which Cloudflare account?</div></div>${cfAccounts()}` : `${cfAdvanced(false)}`}${store()}`;
Object.assign(S.crGuide.variants, {
  cfNoId: { label: 'Cloudflare · no Account ID ★', h: 940, html: () => sc('cloudflare', cfNoId(), 'Continue with Cloudflare', true, { anchor: 'left:745px;top:160px' }), notes: '<h3>Account ID: after sign-in</h3><p>Sign in first; the account is chosen after consent (LOGIC 14:25, post-consent continuation): one account is used directly, several show the next scene. The API token method keeps Account ID in its one form: Cloudflare’s account-token verification requires it, and user-token verification returns no account (LOGIC, official docs).</p>' },
  cfChoose: { label: 'Cloudflare · choose account', h: 940, html: () => sc('cloudflare', cfNoId({ choose: true }), 'Use Happier Labs', true, { anchor: 'left:745px;top:160px' }), notes: '<h3>Several accounts</h3><p>Only when the sign-in can see more than one. Names, never a 32-character ID.</p>' },
  phHetznerB: { label: 'Phone · Hetzner (b)', phone: true, html: () => ph('hetzner'), notes: '<h3>Phone</h3><p>Same edge, same rhythm.</p>' },
});
/* ═══ round 4 (owner 11-04 taste follow-ups): Cloudflare mark, own-client steps, one field order, one verb, permission rows ═══ */
// Every guide uses one anatomy: numbered steps (step 1 links the console), an optional copyable value row on the same
// edge, then "Permissions it needs" as checklist rows (glyph column = number column; feature, then its items beneath).
const ck = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
const permRows = (rows) => `<div class="cg-prow-h">Permissions it needs</div><div class="cg-prows">${rows.map(([f, i]) => `<div class="r"><span class="g">${ck}</span><div><b>${f}</b><span>${i}</span></div></div>`).join('')}</div>`;
const guideR4 = (stepsHtml, extra = '') => `<div class="cg-steps"><ol>${stepsHtml.map((x, i) => `<li><span>${i === 0 ? `<a class="cg-inl">${x}${I('cgExt')}</a>` : x}</span></li>`).join('')}</ol>${extra}</div>`;
const copyRow = (label, value) => `<div class="cg-copy"><span class="l">${label}</span><div class="v"><span class="mono">${value}</span><span class="cp">${I('crCopy')}</span></div></div>`;
const fieldR4 = (lb, ph, o = {}) => `<div class="cc-f"><div class="lb">${lb}${o.opt ? '<span class="o">Optional</span>' : ''}</div><div class="in ${o.focus ? 'focus ph' : 'ph'}"><span>${ph}</span>${o.secret ? '<span class="grow"></span>' + I('cgEye') : ''}</div>${o.hp ? `<div class="hp">${o.hp}</div>` : ''}</div>`;
const segR4 = (lb, opts, on, hp) => `<div class="cc-f"><div class="lb">${lb}</div><div style="margin-top:6px">${seg(opts, on)}</div>${hp ? `<div class="hp">${hp}</div>` : ''}</div>`;
const CF_PERMS = [['Workers', 'Workers Scripts: Edit · Workers CI: Edit'], ['Pages', 'Pages: Edit'], ['Tunnel', 'Cloudflare Tunnel: Edit'], ['DNS', 'DNS: Edit, for the zone you route'], ['Every token', 'Account Settings: Read · API Tokens: Read']];
const cfOwnClient = () => `${methodSeg(0)}${guideR4(['Register an OAuth client in Cloudflare', 'Choose <b>Authorization Code</b> with PKCE and no client secret.', 'Add the redirect URL below, grant the scopes below, then paste the client ID and scope IDs.'], copyRow('Redirect URL', 'https://app.happier.dev/oauth/connected-account/callback'))}
  ${fieldR4('OAuth client ID', 'Paste the client ID', { focus: true })}${fieldR4('Registered API scope IDs', 'Space-separated', { hp: 'The scopes you registered for the permissions below.' })}${permRows(CF_PERMS)}`;
const cfTokenR4 = () => `${methodSeg(1)}${guideR4(['Open API tokens in Cloudflare', 'Choose <b>Create token</b> and allow the permissions below for what you’ll use.', 'Copy the token. Cloudflare shows it once.'])}${permRows(CF_PERMS)}
  ${fieldR4('API token', 'Paste the token', { focus: true, secret: true })}${fieldR4('Account ID', '32 characters', { hp: 'Shown on your Cloudflare dashboard’s overview.' })}${fieldR4('Name', 'Cloudflare', { opt: true })}`;
// One order for every key sheet: the secret, then the optional name, then where it is kept.
const keyR4 = (k, o = {}) => `${guideR4(SVC[k].steps.slice(0, 2))}${fieldR4(o.valueLabel || 'API key', 'Paste the key', { focus: true, secret: true })}${fieldR4('Name', SVC[k].saved, { opt: true })}${o.storage ? `${segR4('Stored in', ['Happier', '1Password'], 0)}${segR4('Keep it', ['Personal', 'Shared'], 0, 'Only you can use it.')}` : ''}`;
const R4_NOTE = `<h3>Round 4 · one anatomy for every key sheet</h3><ul>
<li><b>Mark</b>: Cloudflare ships its brand like Hetzner and ElevenLabs (plugin <code>brand</code> asset); no per-service icon in the app.</li>
<li><b>Own-client help</b> is a guide, not a paragraph: step 1 links the registration page, settings are short steps, the redirect URL is a copyable value on the sheet’s one left edge (it comes from the mode’s declared callback, not a second copy of the URL). Field help is one short line, no URLs.</li>
<li><b>Field order</b> on every key sheet: the secret, then the optional Name, then where it’s kept (Stored in, Keep it). “Stored in: 1Password” swaps the secret slot in place.</li>
<li><b>One verb</b>: <i>Connect</i> when the sheet creates a connected account (Hetzner, Cloudflare); <i>Save key</i> when it only saves a key (ElevenLabs, xAI); <i>Save secret</i> stays for the bare Secret entry.</li>
<li><b>Permissions</b> are checklist rows on the guide’s columns: glyph where the numbers sit, feature then its items beneath, the steps’ spacing.</li></ul>`;
Object.assign(S.crGuide.variants, {
  r4CfClient: { label: 'R4 · Cloudflare own client ★', h: 1000, html: () => sc('cloudflare', cfOwnClient(), 'Continue', false, { anchor: 'left:745px;top:56px' }), notes: R4_NOTE },
  r4CfToken: { label: 'R4 · Cloudflare token', h: 1100, html: () => sc('cloudflare', cfTokenR4(), 'Connect', false, { anchor: 'left:745px;top:40px' }), notes: R4_NOTE },
  r4Hetzner: { label: 'R4 · Hetzner', h: 940, html: () => sc('hetzner', keyR4('hetzner', { valueLabel: 'API token' }), 'Connect', false), notes: R4_NOTE },
  r4Eleven: { label: 'R4 · ElevenLabs', h: 940, html: () => sc('elevenlabs', keyR4('elevenlabs', { storage: true }), 'Save key', false), notes: R4_NOTE },
  r4PhCfClient: { label: 'R4 · phone own client', phone: true, html: () => phWrap(`${phPage()}${psheet('cloudflare', cfOwnClient(), 'Continue', false)}`), notes: R4_NOTE },
  r4PhEleven: { label: 'R4 · phone ElevenLabs', phone: true, html: () => phWrap(`${phPage()}${psheet('elevenlabs', keyR4('elevenlabs', { storage: true }), 'Save key', false)}`), notes: R4_NOTE },
});
})();
