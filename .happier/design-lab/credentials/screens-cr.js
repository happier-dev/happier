// Credentials lab (lane UIR-CREDS, 2026-10-30). The Credentials home = today's Connected services page renamed, with Saved
// Secrets folded into its rail and detail; one share sheet; the Providers pages. Owner ruling: .project/OWNER-RULINGS.md
// "Credentials home direction" (2026-10-30 ~21:05Z, amended ~21:15Z); board RULINGs 21:12 (person audiences for "Let them use
// it") and 21:30Z (single record on edit/rotate/share; old clients get a typed "update Happier" for that credential only).
// Product truth read this round (paths under apps/ui/sources unless noted):
//   - Rail: components/settings/connectedServices/collection/ConnectedServicesRail.tsx (Agent sign-in · Pools + · Gateways + ·
//     Code and tools · More; service rows with caret, mark, count and an amber key roll-up; accounts indented; eye = hide
//     identities; foot "How agents sign in"). Overview: index/ConnectedServicesIndexView.tsx (Needs you, one band per service,
//     Connect more cards, Pools, Code and tools, Shared with you, Usage gauges) — the mixed presentations the owner flagged.
//   - Add another account to a service: buildConnectedAccountSettingsRoute(service, null, { add: true }) (conn-svc-data-1030).
//     Connect more keeps connected services with connectedCount (selectConnectMoreOffer, RED→GREEN 20:59).
//   - Saved Secrets: components/settings/secrets/SecretsSettingsPage.tsx (Your secrets · Shared with you; Value masked + eye +
//     Replace; Storage; Who can use it = inline ShareSheet "Can use — select it for runs; its value is never shown"; Reveal
//     history; Rename; Delete). Statuses: ready, preparing_encrypted_access, recipient_mode_unsupported, access_removed,
//     deleted, update_required, corrupt (cred-model-1030 §5).
//   - Model: one credential record; SavedSecretResource holds API-key bytes, a connected API-key account references it
//     (.project/reviews/2026-10-09-providers-audit/lanes/cred-model-1030.md option A).
//   - Share: components/sharing/ShareSheet.tsx is "the one share sheet" (owner row, grants with a level control, directory
//     search over people/Groups/Teams, removal confirm). Brokered use = teams.credentials.* (person audiences per RULING
//     21:12, landing in cred-merge-1030); value = secrets.shared.grants.set. Eligibility (Q10) = server teams/shareEligibility.ts.
// Lab-only: every value below is a proposal for a named owner; no product value is defined here.
(() => {
const { I, NEW, MK, mk, avatar, st, row, grp, cx, field, column, sidebar, phead, prow, card, sec, btn, sw, phNav } = window.SF;

Object.assign(P, {
  crShare: '<path d="M12 15V4M8 7.5 12 3.8l4 3.7"/><path d="M7 10.5H6A1.5 1.5 0 0 0 4.5 12v6.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V12A1.5 1.5 0 0 0 18 10.5h-1"/>',
  crKey: '<circle cx="8" cy="15" r="3.6"/><path d="m10.6 12.4 7.4-7.4M15.5 7.5l2.2 2.2M13.3 9.7l1.6 1.6"/>',
  crPass: '<rect x="3.5" y="8" width="17" height="8" rx="2"/><path d="M8 12h.01M12 12h.01M16 12h.01"/>',
  crTok: '<path d="M7 7.5h10M7 12h10M7 16.5h6"/><rect x="3.5" y="4" width="17" height="16" rx="2"/>',
  crUp: '<circle cx="12" cy="12" r="8.5"/><path d="M12 16V8.5M8.8 11.5 12 8.3l3.2 3.2"/>',
  crCloudOff: '<path d="M7 18a4.5 4.5 0 0 1-1.6-8.7M9.3 6.2A6 6 0 0 1 17.7 10.7 3.7 3.7 0 0 1 19.9 17M3 3l18 18"/>',
  crInbox: '<path d="M4 13.5 6.5 5h11l2.5 8.5V19H4v-5.5Z"/><path d="M4 13.5h4.5l1 2h5l1-2H20"/>',
  crSend: '<path d="m4 12 16-7.5-6 16-2.5-6.5L4 12Z"/>',
  crShield: '<path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-2.5Z"/>',
  crCopy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  crRefresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3L19.5 9"/><path d="M19.5 4.5V9H15"/>',
  crHistory: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5"/><path d="M3.5 4v4.5H8M12 7.5V12l3 2"/>',
  crCheck: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  crArrow: '<path d="m9 5 7 7-7 7"/>',
});
const mono = (l, bg, s = 17) => BRAND.mono(l, bg, '#fff', s);
const XM = { discord: (s = 17) => mono('D', '#5865F2', s), telegram: (s = 17) => mono('T', '#2AABEE', s), mail: () => I('mail'), sentry: (s = 17) => mono('S', '#362D59', s),
  openaikey: (s = 17) => MK.chatgpt(s), slack: (s = 17) => mono('S', '#4A154B', s) };
const M = (k, s = 17) => (MK[k] ? MK[k](s) : XM[k] ? XM[k](s) : I(k));
const kind = (k) => I(k === 'password' ? 'crPass' : k === 'token' ? 'crTok' : 'crKey');
const PPL = { maya: ['M', '#2B66C2', 'Maya Kim'], ari: ['A', '#5B2B91', 'Ari Rahman'], jonas: ['J', '#0F766E', 'Jonas Thiel'], sam: ['S', '#9A6B1F', 'Sam Ortiz'],
  studio: ['S', '#3E9A4A', 'Studio', true], core: ['H', '#D2463A', 'Happier Core', true] };
const pav = (k, s = 28) => { const [l, c, , team] = PPL[k]; return `<span class="mk av" style="background:${c};color:#fff;font-weight:600;font-size:${Math.round(s * .45)}px;width:${s}px;height:${s}px;border-radius:${team ? Math.round(s / 3.6) + 'px' : '50%'}">${l}</span>`; };
const meters = (a, b, o = {}) => `<span class="cr-meters">${[[a, `5 h · ${a}%`, a > 85 ? 'amber' : ''], [b, `Week · ${b}%`, b >= 100 ? 'rose' : b > 85 ? 'amber' : '']].filter((x) => x[0] != null).map(([v, l, c]) => `<span class="sf-meter"><i><b style="width:${Math.min(v, 100)}%" class="${c}"></b></i><span>${l}</span></span>`).join('')}</span>`;
const chev = () => I('chevR', 'chv');
const word = (t, c = '') => `<span class="cr-word ${c}">${t}</span>`;
const act = (t, icon = 'plus') => `<span class="cr-act">${I(icon)}${t}</span>`;
const line = (g, html, a, tone = '') => `<div class="cr-line"><span class="g ${tone}">${I(g)}</span><div class="tx">${html}</div>${a ? btn(a) : ''}</div>`;
const fresh = (html, warn) => `<div class="cr-fresh ${warn ? 'warn' : ''}">${I(warn ? 'sfAlert' : 'sfClock')}${html}</div>`;

/* ═══ Settings sidebar: "Connected services" becomes "Credentials"; the separate Secrets entry leaves Profile & account ═══ */
const NAV = [{ g: 'Profile & account' }, ['user', 'Account', 1], ['sfTeam', 'Teams'], ['house', 'Home administration'], ['chart', 'Usage'], ['desktop', 'Machines'],
  { g: 'Agents' }, ['sfSpark', 'Agents'], ['graph', 'Subagents'], ['sliders', 'Launch profiles'], ['sfFlag', 'Roles'], ['sfUsers2', 'Delegation'], ['mic', 'Voice', 1],
  { g: 'Tools & models' }, ['cube', 'Providers'], ['key', 'Credentials', 1], ['sfBulb', 'Skills'], ['puzzle', 'MCP servers'], ['grid', 'Plugins', 1], ['sfList', 'Prompts', 1], ['sfSearch', 'Search'],
  { g: 'Sessions & behavior' }, ['terminal', 'Sessions'], ['sfUsers2', 'Coordination'], ['link', 'External sessions'], ['bolt', 'Actions']];
const shell = (active, col, detail, o = {}) => `<div class="sf" data-w="a" style="position:absolute;inset:0"><div class="sf-app">${sidebar(active, NAV)}<div class="sf-sheet ${col ? '' : 'solo'}">${col || ''}<main class="sf-detail">${detail}</main></div></div>${o.over || ''}</div>`;

/* ═══ the rail ═══ */
// A service row: caret · mark · name · status · count · "+" (add another account to this service; owner 21:38).
function svc(o) {
  const car = `<svg class="car ${o.open ? 'open' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`;
  return `<div class="sf-r ${o.on ? 'on' : ''}">${car}${mk(o.mk)}<div class="tx"><div class="ti">${o.t}</div></div><div class="rt">${st(o.st)}<span>${o.n}</span><span class="cr-add ${o.hot ? 'hot' : ''}" aria-label="Add another ${o.t} account">${I('plus')}</span></div></div>`;
}
// An account row: always two lines (name · email or plan), so a service's accounts share one height (owner 21:38: ChatGPT shows email like Claude).
const acct = (t, sub, meta, o = {}) => row({ child: true, t, cx: sub, meta, st: o.st, on: o.on });
const secretRow = (t, sub, o = {}) => row({ mk: 'key', t, cx: sub, st: o.st, on: o.on });
function rail(o = {}) {
  const sel = (k) => o.sel === k;
  const loading = o.loading;
  const body = loading ? `${row({ mk: 'sfAll', t: 'Overview', on: true })}<div class="sf-gh" style="margin-top:16px">Agent sign-in</div>${SKR(4)}<div class="sf-gh" style="margin-top:24px">Pools</div>${SKR(1)}<div class="sf-gh" style="margin-top:24px">Code and tools</div>${SKR(3)}<div class="sf-gh" style="margin-top:24px">Secrets</div>${SKR(3)}` : [
    `<div class="sf-grp">${row({ mk: 'sfAll', t: 'Overview', on: sel('home') })}</div>`,
    grp('Agent sign-in', [
      svc({ mk: 'claude', t: 'Claude subscription', n: 2, open: true }),
      acct('ai1@happier.dev', 'Claude Max', '62%'), acct('ai3@happier.dev', 'Claude Pro', '18%'),
      svc({ mk: 'chatgpt', t: 'ChatGPT', n: 3, open: true, hot: o.hotPlus }),
      acct('Happier', 'codex4@happier.dev', '<span class="warn">91%</span>', { st: 'limit', on: sel('happier') }),
      acct('Leeroy', o.update ? 'Update Happier to manage it' : 'leeroy@happier.dev', o.update ? '' : '<span class="bad">0%</span>', { on: sel('leeroy'), st: o.update ? 'update' : '' }),
      acct('Happier Devs', 'devs@happier.dev', '', { st: 'signin' }),
      svc({ mk: 'anthropic', t: 'Anthropic API key', n: 1, open: sel('workkey') }),
      ...(sel('workkey') ? [acct('Work key', 'API key · ends 7Qa2', '', { on: true })] : []),
    ], { n: 3 }),
    grp('Pools', [row({ mk: 'stack', t: 'Codex pool', cx: cx('ChatGPT', 'using Leeroy') })], { add: true }),
    grp('Gateways', [row({ mk: 'route', t: 'Main gateway', cx: 'Off · needs an account' })], { add: true }),
    grp('Code and tools', [svc({ mk: 'github', t: 'GitHub', n: 2, st: 'signin' }), svc({ mk: 'linear', t: 'Linear', n: 1 }), svc({ mk: 'discord', t: 'Discord bot', n: 1 }), svc({ mk: 'telegram', t: 'Telegram bot', n: 1 }), svc({ mk: 'mail', t: 'Email IMAP + SMTP', n: 1 })], { n: 5 }),
    grp('Secrets', [secretRow('Registry token', 'Token · shared with Studio', { on: sel('registry') }), secretRow('Sentry DSN', 'Used by Sentry MCP'), secretRow('DeepSeek key', 'Used by DeepSeek provider'), secretRow('OpenAI API key', 'Used by Voice'), secretRow('Release signing password', 'Password · only you'), secretRow('Notebook publishing key', 'Not used yet')], { add: true }),
    grp('Shared with you', o.teamsFailed ? [`<div class="sf-qline">${st('failed')}<span>Couldn’t load what your Teams share. <span class="lnk">Retry</span></span></div>`, row({ mk: 'chatgpt', t: 'Maya’s Codex', cx: 'From Maya Kim · you can use it' })]
      : [row({ mk: 'chatgpt', t: 'Studio Codex', cx: 'From Studio · you can use it' }), row({ mk: 'key', t: 'Staging database URL', cx: 'From Ari Rahman', on: sel('staging') })], { n: o.teamsFailed ? null : 2 }),
  ].join('');
  return column({ title: 'Credentials', n: loading ? '—' : 18, icons: ['sfEye', 'plus'], top: field('Search credentials', { filter: true }), body, foot: `<div class="sf-r"><span class="mk">${I('sfSpark')}</span><div class="tx"><div class="ti">How agents sign in</div></div><div class="rt">${I('chevR')}</div></div>` });
}
const SKR = (n) => Array.from({ length: n }, (_, i) => `<div class="sf-skr"><i class="m"></i><span class="l"><i style="width:${[62, 48, 70, 55][i % 4]}%"></i><i style="width:${[38, 30, 44, 26][i % 4]}%"></i></span></div>`).join('');
// SF kit marks for these lab services
Object.assign(MK, { discord: XM.discord, telegram: XM.telegram, mail: () => I('mail'), sfAll: () => I('sfAll') });

/* ═══ Overview (direction A: one presentation — every section is a title, a description and one sheet of the same rows) ═══ */
// Live refinements (lab-providers-1104): the state reads as one amber word with its glyph before the fix, the shared
// ConnectedAccountSignInRecovery; only the first fix is filled (one primary per view).
const signedOut = (more = '') => `<span class="cr-word amber" style="display:inline-flex;align-items:center;gap:4px;margin-right:10px">${I('sfAlert').replace('<svg', '<svg width="14" height="14" style="width:14px;height:14px;flex:none"')}Signed out${more}</span>`;
const needsYou = () => sec('Needs you', card([
  prow({ lead: M('chatgpt', 20), t: 'Happier Devs', d: cx('ChatGPT', 'devs@happier.dev', 'Codex pool skips it'), c: signedOut() + btn('Sign in again', true) }),
  prow({ lead: M('github', 20), t: 'happier-bot', d: cx('GitHub', 'pull requests can’t be opened as the bot'), c: signedOut() + btn('Sign in again') }),
]));
const agentAccounts = (o = {}) => sec('Agent accounts', card([
  prow({ lead: M('claude', 20), t: 'ai1@happier.dev', d: 'Claude Max', c: meters(62, 41) + chev() }),
  prow({ lead: M('claude', 20), t: 'ai3@happier.dev', d: 'Claude Pro', c: meters(18, 9) + chev() }),
  prow({ lead: M('chatgpt', 20), t: 'Happier', d: cx('ChatGPT Pro', 'codex4@happier.dev'), c: meters(91, 66) + chev() }),
  o.update ? prow({ lead: M('chatgpt', 20), t: 'Leeroy', d: cx('ChatGPT', 'changed by a newer Happier'), c: word('Update Happier to manage it') + chev() })
    : prow({ lead: M('chatgpt', 20), t: 'Leeroy', d: cx('ChatGPT Pro', 'leeroy@happier.dev'), c: meters(null, 100).replace('Week · 100%', 'Used up · resets Wed') + chev() }),
  prow({ lead: M('anthropic', 20), t: 'Work key', d: cx('Anthropic API key', 'pay per use'), c: word('Claude Code, OpenCode') + chev() }),
]), { d: 'Plans and keys your agents sign in with, and how much each has left.' });
const pools = () => sec('Pools', card([
  prow({ lead: I('sfStack'), t: 'Codex pool', d: cx('ChatGPT', '3 accounts', 'using Leeroy since 09:44'), c: meters(null, 33).replace('Week · 33%', 'Week · 67% left') + chev() }),
]), { d: 'Accounts an agent switches between. A session starts on the first with room and moves on when it runs out.', right: act('New pool') });
const gateways = () => sec('Gateways', card([
  prow({ lead: I('sfRoute'), t: 'Main gateway', d: 'Serves your ChatGPT accounts to OpenCode and Pi', c: word('Off · needs an account', 'amber') + chev() }),
]), { d: 'Let other agents use your accounts through one address.', right: act('Add gateway') });
const tools = () => sec('Code and tools', card([
  prow({ lead: M('github', 20), t: 'leeroy-brun', d: cx('GitHub', 'pull requests, issues and checks'), c: chev() }),
  prow({ lead: M('linear', 20), t: 'Happier', d: cx('Linear', 'workspace'), c: chev() }),
  prow({ lead: M('discord', 20), t: 'Happier QA Bot', d: 'Discord bot', c: chev() }),
  prow({ lead: M('telegram', 20), t: 'Happier QA Bot', d: 'Telegram bot', c: chev() }),
  prow({ lead: I('mail'), t: 'wilson@happier.dev', d: 'Email IMAP + SMTP', c: chev() }),
]), { d: 'Accounts your agents and tools act as: code hosts, trackers, chat bots and mail.' });
const secrets = () => sec('Secrets', card([
  prow({ lead: I('crTok'), t: 'Registry token', d: cx('Token', 'used by harbor-ledger deploys'), c: word('Shared with Studio') + chev() }),
  prow({ lead: I('crKey'), t: 'Sentry DSN', d: cx('API key', 'used by Sentry MCP'), c: word('Only you') + chev() }),
  prow({ lead: I('crKey'), t: 'DeepSeek key', d: cx('API key', 'used by the DeepSeek provider'), c: word('Only you') + chev() }),
  prow({ lead: I('crPass'), t: 'Release signing password', d: cx('Password', 'used by the Release profile'), c: word('Only you') + chev() }),
]), { d: 'Keys, tokens and passwords that aren’t tied to one service. Values stay hidden; pick them wherever Happier asks for one.', right: act('New secret') });
const sharedWithYou = (o = {}) => sec('Shared with you', card(o.teamsFailed ? [
  line('crCloudOff', '<b>Couldn’t load what your Teams share with you.</b> Your own credentials still work, and so does what people share with you directly.', 'Retry'),
  prow({ lead: M('chatgpt', 20), t: 'Maya’s Codex', d: cx('ChatGPT', 'from Maya Kim'), c: word('You can use it') + chev() }),
] : [
  prow({ lead: M('chatgpt', 20), t: 'Studio Codex', d: cx('ChatGPT', 'from Studio · runs on Maya Kim’s machine'), c: word('You can use it') + chev() }),
  prow({ lead: I('crKey'), t: 'Staging database URL', d: cx('Secret', 'from Ari Rahman'), c: word('Your agents can use it') + chev() }),
]), { d: 'Credentials friends, teammates and Teams let you use.' });
const connectMore = () => sec('Connect more', card([
  prow({ lead: M('claude', 20), t: 'Claude subscription', d: cx('Claude Code, OpenCode and Pi', '2 connected'), c: btn('Add account') }),
  prow({ lead: M('chatgpt', 20), t: 'ChatGPT', d: cx('Codex, OpenCode and Pi', '3 connected'), c: btn('Add account') }),
  prow({ lead: M('gemini', 20), t: 'Gemini', d: 'Gemini CLI · a Google account or an API key', c: btn('Connect') }),
  prow({ lead: M('chatgpt', 20), t: 'OpenAI API key', d: 'OpenCode and Pi · pay per use', c: btn('Connect') }),
  prow({ lead: I('sfAll'), t: 'All services', d: '24 more, including Slack, Jira and Hetzner', c: chev() }),
]), { d: 'Add another account to a service you use, or connect a new one.' });
const gaugeRow = () => sec('In the composer', card([prow({ lead: I('chart'), t: 'Usage gauges', d: 'Shown · most constrained window · routing hints on', c: chev() })]), { d: 'How much is left, beside the prompt.' });
function homePage(o = {}) {
  const meta = `<span>11 accounts</span><span class="cr-meta-sep">·</span><span>1 pool</span><span class="cr-meta-sep">·</span><span>6 secrets</span><span class="cr-meta-sep">·</span><span style="color:var(--sf-amber-t)">2 need you</span>`;
  // Live refinement (UIR-CREDS-POLISH): List | Grid is the header's action and Refresh all joins the as-of time.
  const acts = `<div class="seg sm"><button class="on">List</button><button>Grid</button></div>`;
  return `<div class="sf-page">${phead({ t: 'Credentials', d: 'Every account, key and secret your agents and tools sign in with.', meta, acts })}
    ${o.machinesDown ? fresh('Couldn’t reach your machines, so usage is from 09:20. Your accounts still work. <span class="a">Retry</span>', true) : fresh('As of 22:13 · <span class="a">Refresh all</span>')}
    ${needsYou()}${agentAccounts(o)}${pools()}${gateways()}${tools()}${secrets()}${sharedWithYou(o)}${connectMore()}${gaugeRow()}</div>`;
}

/* ═══ account detail (ChatGPT · Happier) ═══ */
const grantRow = (who, d, level, o = {}) => prow({ lead: pav(who, 28), t: PPL[who][2], d, c: `<span class="cr-level ${o.locked ? 'locked' : ''}">${level}${o.locked ? '' : I('chevD')}</span>` });
function accountPage(o = {}) {
  const head = phead({ mark: M('chatgpt', 28), t: 'Happier', d: '', meta: `<span>codex4@happier.dev</span><span class="cr-meta-sep">·</span><span>ChatGPT Pro</span><span class="cr-meta-sep">·</span><span>in Codex pool</span>`, acts: `${btn('Share', false, 'crShare')}<span class="sf-ib">${I('sfDots')}</span>` }).replace('<p></p>', '');
  const usage = sec('Usage', card([
    prow({ t: '5-hour limit', d: 'Codex is on this account now · resets 14:20', c: meters(91, null) }),
    prow({ t: 'Weekly limit', d: 'Resets Monday', c: meters(null, 66) }),
    prow({ t: 'Plan', d: 'ChatGPT Pro · renews 3 Nov' }),
  ]), { right: `<span class="cr-dim" style="font-size:var(--product-type-meta-size)">As of 22:13</span>` });
  const used = sec('Used by', card([
    prow({ lead: M('codex', 20), t: 'Codex', d: 'Default for Codex, through Codex pool', c: chev() }),
    prow({ lead: M('opencode', 20), t: 'OpenCode and Pi', d: 'Can use it when you pick it', c: chev() }),
    prow({ lead: I('sfStack'), t: 'Codex pool', d: 'First of 3 · in use now', c: chev() }),
  ]));
  const sharing = sec('Sharing', card(o.teamsFailed ? [
    grantRow('maya', 'Friend · since 24 Oct', 'Can use it'),
    line('crCloudOff', '<b>Couldn’t load Team sharing.</b> People you shared with directly are shown; their access isn’t affected.', 'Retry'),
  ] : [
    grantRow('maya', 'Friend · since 24 Oct · 12 runs this week', 'Can use it'),
    grantRow('studio', '6 people · runs through nl2-devbox', 'Can use it'),
  ]), { d: 'Their agents sign in through your machine. They never see the sign-in, and you can stop it any time.' });
  const sign = sec('Sign-in', card([
    prow({ t: 'Signed in with a code', d: 'Refreshed 2 h ago · signed in 12 Oct on nl2-devbox', c: btn('Sign in again') }),
    prow({ t: 'Works on', d: 'Every machine: nl2-devbox, MacBook Pro, mac-studio', c: chev() }),
  ]));
  return `<div class="sf-page">${head}${o.update ? updateBanner() : ''}${usage}${used}${sharing}${sign}<div class="cr-exit"><span class="sf-btn del">Remove account</span></div><div class="cr-foot">Removes this account from Happier. With no machine selected, remote sign-out can’t be confirmed. Codex pool keeps working with its other accounts, and Maya and Studio lose access.</div></div>`;
}
const updateBanner = () => `<div class="cr-banner neu">${I('crUp')}<div class="tx"><b>Changed by a newer version of Happier</b><span>Update Happier on this device to see or change it. Your agents keep using it, and other devices are unaffected.</span></div>${btn('Update Happier')}</div>`;
function leeroyUpdatePage() {
  const head = phead({ mark: M('chatgpt', 28), t: 'Leeroy', meta: `<span>ChatGPT</span><span class="cr-meta-sep">·</span><span>in Codex pool</span>`, acts: `<span class="sf-ib">${I('sfDots')}</span>` });
  return `<div class="sf-page">${head}${updateBanner()}${sec('Used by', card([prow({ lead: M('codex', 20), t: 'Codex', d: 'Through Codex pool · in use now', c: chev() }), prow({ lead: I('sfStack'), t: 'Codex pool', d: 'Second of 3', c: chev() })]))}
    ${sec('Sign-in', card([prow({ t: 'Details need the update', d: 'Usage, sharing and sign-in show here once this device runs the new Happier.' })]))}</div>`;
}

/* ═══ one credential record: a service API key ═══ */
function workKeyPage() {
  const head = phead({ mark: M('anthropic', 28), t: 'Work key', meta: `<span>Anthropic API key</span><span class="cr-meta-sep">·</span><span>End-to-end encrypted</span>`, acts: `${btn('Share', false, 'crShare')}<span class="sf-ib">${I('sfDots')}</span>` });
  const val = sec('Key', card([
    prow({ t: 'Value', d: '<span class="cr-val"><span class="dots">sk-ant-••••••••••••</span><span class="cr-mono">7Qa2</span></span>', c: `<span class="cr-ib" aria-label="Show">${I('eye')}</span><span class="cr-ib" aria-label="Copy">${I('crCopy')}</span>${btn('Replace')}` }),
    prow({ t: 'Added 12 Oct', d: 'Replaced 28 Oct on MacBook Pro · every use picks up the new key' }),
  ]));
  const used = sec('Used by', card([
    prow({ lead: M('claude', 20), t: 'Claude Code', d: 'Signs in with this key when you choose Anthropic API key', c: chev() }),
    prow({ lead: M('opencode', 20), t: 'OpenCode', d: 'Can use it when you pick it', c: chev() }),
    prow({ lead: I('cube'), t: 'Anthropic provider', d: 'Model source · 6 models', c: chev() }),
  ]), { d: 'One key, used everywhere it’s picked. Replacing it here updates all of them.' });
  return `<div class="sf-page">${head}${val}${used}<div class="cr-exit"><span class="sf-btn del">Remove key</span></div><div class="cr-foot">Claude Code, OpenCode and the Anthropic provider stop working with it until you add another key.</div></div>`;
}

/* ═══ a Secret (owned, shared as a value) and the recipient's view ═══ */
function secretPage(o = {}) {
  const head = phead({ mark: I('crTok'), t: 'Registry token', meta: `<span>Token</span><span class="cr-meta-sep">·</span><span>End-to-end encrypted</span>`, acts: `${btn('Share', false, 'crShare')}<span class="sf-ib">${I('sfDots')}</span>` });
  const val = sec('Value', card([
    prow({ t: o.revealed ? '<span class="cr-mono">ghr_8f2K…</span>' : '<span class="cr-val"><span class="dots">••••••••••••</span></span>', d: o.revealed ? 'Shown on this device · hides when you leave' : 'Hidden', c: `<span class="cr-ib" aria-label="${o.revealed ? 'Hide' : 'Show'}">${I('eye')}</span><span class="cr-ib" aria-label="Copy">${I('crCopy')}</span>${btn('Replace')}` }),
  ]));
  const used = sec('Used by', card([
    prow({ lead: I('folder'), t: 'harbor-ledger', d: 'Deploys · as REGISTRY_TOKEN', c: chev() }),
    prow({ lead: I('sliders'), t: 'Release', d: 'Launch profile', c: chev() }),
  ]));
  const sharing = sec('Sharing', card([
    grantRow('studio', '6 people · their devices have the value', 'Has the value'),
    grantRow('ari', 'Teammate in Studio · since 21 Oct', 'Has the value'),
  ]), { d: 'Their devices hold their own copy. Stopping blocks new copies, but can’t take back one they already have.' });
  const hist = sec('Reveal history', card([
    prow({ lead: pav('ari', 24), t: 'Ari Rahman showed it', d: '28 Oct, 14:02 · MacBook Air' }),
    prow({ lead: I('crRefresh'), t: 'You replaced it', d: '21 Oct, 09:15 · everyone got the new value' }),
  ]));
  return `<div class="sf-page">${head}${val}${used}${sharing}${hist}<div class="cr-exit"><span class="sf-btn del">Delete secret</span></div><div class="cr-foot">harbor-ledger deploys and the Release profile stop finding it. Anyone who has the value keeps their copy.</div></div>`;
}
/* ═══ states ═══ */
function loadingPage() {
  const sk = (n) => card(Array.from({ length: n }, (_, i) => prow({ sk: [[44, 36, 52][i % 3], [28, 22, 34][i % 3]] })));
  return `<div class="sf-page">${phead({ t: 'Credentials', d: 'Every account, key and secret your agents and tools sign in with.', meta: '<span class="cr-dim">Loading your accounts…</span>' })}${sec('Agent accounts', sk(4), { d: 'Plans and keys your agents sign in with, and how much each has left.' })}${sec('Pools', sk(1), { d: 'Accounts an agent switches between.' })}${sec('Code and tools', sk(3), { d: 'Accounts your agents and tools act as.' })}</div>`;
}
function emptyPage() {
  return `<div class="sf-page" style="padding-top:120px"><div class="sf-empty" style="align-items:center;text-align:center;padding:0"><span class="art">${M('claude', 26)}${M('chatgpt', 26)}${M('github', 26)}${I('crKey')}</span><b>Sign your agents in once</b><p style="max-width:440px">Connect a Claude or ChatGPT plan, an API key or a code host, or save a secret. Every machine you use can then sign in with it.</p><div class="row">${btn('Connect a service', true, 'plus')}${btn('Add a secret')}</div><p style="margin-top:8px;color:var(--sf-text3)">How agents sign in ›</p></div></div>`;
}

/* ═══ phone ═══ */
const phWrap = (inner) => `<div class="sf" data-w="a" style="position:absolute;inset:0"><div class="sf-ph390">${inner}</div></div>`;
function phRail() {
  const body = [
    `<div class="sf-grp">${row({ mk: 'sfAll', t: 'Overview', cx: '2 need you' })}</div>`,
    grp('Agent sign-in', [svc({ mk: 'claude', t: 'Claude subscription', n: 2, open: true }), acct('ai1@happier.dev', 'Claude Max', '62%'), acct('ai3@happier.dev', 'Claude Pro', '18%'),
      svc({ mk: 'chatgpt', t: 'ChatGPT', n: 3, open: true }), acct('Happier', 'codex4@happier.dev', '<span class="warn">91%</span>', { st: 'limit' }), acct('Leeroy', 'leeroy@happier.dev', '<span class="bad">0%</span>'), acct('Happier Devs', 'devs@happier.dev', '', { st: 'signin' })], { n: 3 }),
    grp('Pools', [row({ mk: 'stack', t: 'Codex pool', cx: cx('ChatGPT', 'using Leeroy') })], { add: true }),
    grp('Secrets', [secretRow('Registry token', 'Token · shared with Studio'), secretRow('Sentry DSN', 'Used by Sentry MCP')], { add: true }),
  ].join('');
  return phWrap(`${phNav('Settings', `<span class="ib">${I('sfEye')}</span><span class="ib">${I('plus')}</span>`)}<div class="big">Credentials<span class="n">18</span></div><div class="top">${field('Search credentials', { filter: true })}</div><div class="lst">${body}</div>`);
}
function phAccount() {
  const page = accountPage().replace('class="sf-page"', 'class="sf-page"');
  return phWrap(`${phNav('Credentials', `<span class="ib">${I('sfDots')}</span>`)}<div class="pg">${page.replace(/<div class="cr-meters">/g, '<div class="cr-meters">')}</div>`);
}

/* ═══ register ═══ */
const W = (fn, h) => ({ html: fn, h });
const NOTE_A = `<h3>A · One presentation (recommended)</h3>
<p>The owner (21:38): “a lot of things all over the place … not easy to know what is what … multiple different types of presentation as you scroll”, and in Code and tools “group titles and their accounts look identical”.</p>
<ul><li><b>One system for the whole page.</b> Every section is the same three things: a sentence-case title, a description above, one sheet of rows. A row is always <i>mark · what it is · one fact line · one trailing thing</i> (meters, a word, one button, or a chevron — never two kinds). Today’s page mixes service bands with empty headings, cards, tiles, a banner card, a state card and preference switches.</li>
<li><b>No service headings in the main page.</b> Each row names its service in its fact line (“ChatGPT Pro · codex4@happier.dev”) and carries the service mark, so a row can never be mistaken for a group. The rail is where services group accounts (caret, count, “+”).</li>
<li><b>Order</b>: Needs you (only when something does) → Agent accounts (with what’s left) → Pools → Gateways → Code and tools → Secrets → Shared with you → Connect more → In the composer.</li>
<li><b>Connect more keeps connected services</b> with their count and “Add account” (owner ask; selector landed in conn-svc-data-1030 20:59). Same rows as everything else, not tiles.</li>
<li><b>Alignment</b>: page title, purpose, every section title and every sheet share one left edge (PageFrame + HAPPIER_PAGE_METRICS). The rail title and the page title sit on the same baseline band (UIR-RAIL owns the rail header).</li>
<li><b>Usage gauges</b> (composer preferences, today’s last section) become one destination row; proposal Q1 moves them to Settings → Usage.</li>
<li>Secrets come from the old Secrets page: only keys not tied to a service. A service’s key is one record and lives under its service (“Work key” under Anthropic API key).</li></ul>
<h4>Spec</h4><p>Reading column (<code>--product-page-column-reading</code>), sheet rows at the page-row metrics; at 1920/2560 the column stays centred, the rail keeps its width. Long names truncate in the rail, wrap to two lines in the page. Motion: none on arrival; a refreshed meter eases to its new width (motionTokens short ease-out).</p>`;
S.crHome = { title: 'Credentials home', subtitle: 'the Connected services page renamed, Secrets folded in', def: 'a', variants: {
  a: { label: 'A · one presentation (rec.)', h: 2600, html: () => shell('Credentials', rail({ sel: 'home' }), homePage()), notes: NOTE_A },
  aRail: { label: 'Rail “+” hover', h: 940, html: () => shell('Credentials', rail({ sel: 'happier', hotPlus: true }), accountPage()), notes: `<h3>Rail: “+” beside each service</h3><ul><li>Owner (21:38): a “+” beside each service group to add another account. It sits after the count on every service row (Claude 2 +, ChatGPT 3 +), quiet (tertiary ink) and always visible, not hover-only: the owner looked for it and touch has no hover. Hover fills its own 20 px box, not the row.</li><li>It calls <code>buildConnectedAccountSettingsRoute(service, null, { add: true })</code> — a new account, never a reconnect (conn-svc-data-1030 “For the UI lane”).</li><li>Account rows are always two lines (name · email or plan), so every account in a service has one height; ChatGPT shows its email like Claude (data: Providers, Codex refresh keeps <code>providerIdentity.email</code>).</li><li>Groups: Overview · Agent sign-in · Pools + · Gateways + · Code and tools · Secrets + · Shared with you. Header “+” is the add menu (Connect a service · New secret · New pool · Add gateway).</li></ul>` },
} };

S.crDetail = { title: 'Details', subtitle: 'account, one-record key, Secret, update needed', def: 'acct', variants: {
  acct: { label: 'ChatGPT account', h: 1500, html: () => shell('Credentials', rail({ sel: 'happier' }), accountPage()), notes: `<h3>Account detail</h3><ul><li>Entity header: mark, name, one meta line with the distinguishing facts (email, plan, pool). <b>Share</b> is a header action (secondary) beside ⋯; there is no separate “Share credential” row leading to the Teams page any more.</li><li>Sections: Usage (live meters, “As of”) → Used by → <b>Sharing</b> (who can use it, each with its level; the section exists only once shared) → Sign-in → Remove account, closing the page as a quiet button with its consequence.</li><li>Sharing replaces today’s “Shared with Teams” list and lists people and Teams together, each with the same level control the share sheet uses.</li></ul>` },
  key: { label: 'Service key (one record)', h: 1200, html: () => shell('Credentials', rail({ sel: 'workkey' }), workKeyPage()), notes: `<h3>One record: a service’s API key</h3><p>Ruling: an API key for a service is ONE credential record. The Anthropic API key account and the key a provider or MCP server picks are the same thing. Its page shows the value (masked, eye, Copy, Replace — the existing reveal guard), and Used by lists every consumer: the agents, the Anthropic provider, any MCP server. Replacing it here is the rotation for all of them.</p><p>It appears once in the rail, under its service; the Secrets group holds only keys not tied to a service. Data: Providers (cred-model-1030 option A: connected API-key fields reference the SavedSecretResource; Used by from the reference census in <code>savedSecretMutationOwner</code>). ${NEW} Used by census as a read.</p>` },
  secret: { label: 'Secret (shared value)', h: 1500, html: () => shell('Credentials', rail({ sel: 'registry' }), secretPage()), notes: `<h3>Secret detail</h3><p>Today’s Secrets page expands rows in place inside one long list; folded in, a Secret is a rail item with a detail page like every other credential. Value row (masked, eye, Copy, Replace) → Used by → Sharing (levels) → Reveal history → Delete. Storage (E2EE / plain) and Convert move into ⋯ (rare). Statuses (preparing access, recipient can’t open E2EE, corrupt) render as one line in the Value sheet.</p>` },
  revealed: { label: 'Value shown', h: 940, html: () => shell('Credentials', rail({ sel: 'registry' }), secretPage({ revealed: true })), notes: '<h3>Value shown</h3><p>Reveal goes through the existing guard (local secret, else unlock). The value shows in mono on one line and leaves component state when hidden, on unmount and on Account change.</p>' },
  update: { label: 'Update needed', h: 940, html: () => shell('Credentials', rail({ sel: 'leeroy', update: true }), leeroyUpdatePage()), notes: `<h3>Per-credential “update Happier”</h3><p>Ruling 21:30Z: a credential converts to the single record when it is edited, rotated or shared; an older client gets a typed update requirement for <i>that credential only</i>. Everything else keeps working.</p><ul><li>Rail: the account keeps its place, with the neutral update glyph and “Update Happier to manage it” as its second line.</li><li>Detail: identity and Used by still render (they don’t need the new format); one neutral banner with the cause, the reassurance (“your agents keep using it”) and one action. Not amber: nothing is broken.</li></ul><p>Data: the typed <code>update_required</code> status per credential (resource status already exists for Secrets) ${NEW} for connected accounts.</p>` },
} };

S.crStates = { title: 'States', subtitle: 'loading, empty, failed reads', def: 'loading', variants: {
  loading: { label: 'Loading', h: 940, html: () => shell('Credentials', rail({ loading: true }), loadingPage()), notes: '<h3>Loading</h3><p>Known sections hold their place with skeleton rows; the header and its purpose render at once. The rail shows Overview and the group labels with skeleton rows. Nothing moves when data lands; usage keeps its last value while it refreshes.</p>' },
  empty: { label: 'Empty', h: 940, html: () => shell('Credentials', null, emptyPage()), notes: '<h3>Empty</h3><p>No rail until there is something to list (as today). Identity (the marks of what it connects), one sentence of value, one primary action and the secondary “Add a secret”, then How agents sign in.</p>' },
  failed: { label: 'Failed reads', h: 2650, html: () => shell('Credentials', rail({ sel: 'home', teamsFailed: true }), homePage({ teamsFailed: true, machinesDown: true })), notes: `<h3>Failed reads, honestly</h3><ul><li><b>Teams.</b> Today every Teams read error renders “Teams are not available on this Home” as a page-size card (owner 21:38) though Teams is on. The honest state is one line inside the section that couldn’t load: what failed, what still works, Retry. Only a real feature-off decision hides the section, and then nothing is said. Presenter fix: TEAMS-SHARING; this is the composition.</li><li><b>Machines unreachable.</b> The freshness line under the header turns amber: usage is from 09:20, accounts still work, Retry.</li><li>The rail says it once, in its own group, as one quiet line.</li></ul>` },
} };

S.crPhone = { title: 'Phone', subtitle: '390 forms', def: 'rail', variants: {
  rail: { label: 'Credentials', phone: true, html: () => phRail(), notes: '<h3>Phone · Credentials</h3><p>The rail is the page: large title, search, Overview (with what needs you), groups. Service rows keep their “+” (a 20 px glyph whose hit area extends to 44 pt). Rows push their detail.</p>' },
  acct: { label: 'Account', phone: true, html: () => phAccount(), notes: '<h3>Phone · account</h3><p>Pushed page; header facts wrap; Share stays a header action (full width under the title on phones per PageHeader actions rule); meters stack under the row label.</p>' },
} };

window.CR = { I, NEW, MK, M, mk, avatar, st, row, grp, cx, field, column, phead, prow, card, sec, btn, sw, phNav, shell, rail, accountPage, workKeyPage, secretPage, pav, PPL, meters, chev, word, act, line, fresh, phWrap, svc, kind };
})();
