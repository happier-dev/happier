// Credentials lab · the share sheet (lane UIR-CREDS, 2026-10-30).
// Truth: components/sharing/ShareSheet.tsx is the one share sheet (owner row, grants each with a level control, a directory
// search over people/Groups/Teams with blocked candidates carrying a reason, removal with consequences, presentation
// compact | full | inline). Credentials consume it through an adapter: the two levels are the owner's two choices.
//   "Let them use it"  → brokered use (teams.credentials.* with person or Team audience, RULING 21:12; broker placement = the
//                         machine that makes the calls). Recipients never get Reveal/Copy.
//   "Give them the value" → value grants on the one record (secrets.shared.grants.set); their devices hold a copy.
// Eligibility (who can be added) is decided once by the server's shareEligibility (Q10: a friend, a teammate, or a Team you
// belong to); the sheet renders blocked candidates with that reason and never re-decides.
(() => {
const { I, NEW, M, prow, card, btn, field, shell, rail, accountPage, secretPage, pav, PPL, phWrap, phNav } = window.CR;

const scrim = (dlg) => `<div class="cr-scrim"></div>${dlg}`;
const who = (k, d, right, o = {}) => `<div class="cr-who ${o.hl ? 'hl' : ''} ${o.off ? 'off' : ''}">${pavBig(k)}<div class="tx"><div class="t">${PPL[k][2]}${o.you ? ' <span class="cr-dim">(you)</span>' : ''}</div>${d ? `<div class="d">${d}</div>` : ''}</div>${right || ''}</div>`;
const pavBig = (k) => { const [l, c, , team] = PPL[k]; return `<span class="av ${team ? 'team' : ''}" style="background:${c}">${l}</span>`; };
const youRow = () => `<div class="cr-who"><span class="av" style="background:#D2463A">L</span><div class="tx"><div class="t">Leeroy Brun <span class="cr-dim">(you)</span></div><div class="d">Owner · signed in on nl2-devbox</div></div><span class="cr-level locked">Owner</span></div>`;
const level = (t, open) => `<span class="cr-level" ${open ? 'style="box-shadow:inset 0 0 0 1.5px var(--sf-text)"' : ''}>${t}${I('chevD')}</span>`;
const head = (mark, t, sub) => `<div class="hd"><span class="mk">${mark}</span><div class="tt"><b>${t}</b><span>${sub}</span></div><span class="sf-ib">${I('x')}</span></div>`;
const ACC_HEAD = () => head(M('chatgpt', 24), 'Share Happier', 'ChatGPT Pro · codex4@happier.dev');
const via = () => `<span class="cr-chip">${I('sfMachine')}Through nl2-devbox${I('chevD')}</span>`;

/* ═══ Y · one sheet, a level per person (recommended) ═══ */
function sheetY(o = {}) {
  const grants = o.grants || [];
  const findOn = o.picker;
  const picker = findOn ? `<div class="lbl">People</div>
      ${who('maya', 'Friend', `<span class="addb">Add</span>`, { hl: true })}
      ${who('ari', 'Teammate in Studio', `<span class="addb">Add</span>`)}
      ${who('jonas', 'Teammate in Happier Core', `<span class="addb">Add</span>`)}
      ${who('sam', 'Not a friend or teammate yet', `<span class="why">Can’t add</span>`, { off: true })}
      <div class="lbl">Your Teams</div>
      ${who('studio', '6 people · you’re a member', `<span class="addb">Add</span>`)}
      ${who('core', '12 people · you’re a member', `<span class="addb">Add</span>`)}` : '';
  const list = findOn ? '' : `<div class="lbl">Who has it</div>${youRow()}${grants.map(([k, d, lv, open]) => who(k, d, level(lv, open))).join('')}
      ${grants.length ? '' : `<div class="note">${I('info')}<span>Only you. Add a friend, a teammate or one of your Teams. They can use it right away; you choose whether they also get the value.</span></div>`}`;
  const done = o.done ? `<div class="cr-done">${I('crCheck')}Maya Kim can use it now. Studio can use it now.</div>` : '';
  const foot = findOn ? `<div class="ft"><span class="grow">People you add can use it through nl2-devbox. Change it per person.</span>${btn('Done')}</div>`
    : `<div class="ft"><span class="grow">Use runs ${via()}</span>${btn('Done', true)}</div>`;
  return `<div class="cr-dlg" role="dialog" aria-label="Share Happier">${ACC_HEAD()}<div class="bd"><div class="find ${findOn ? 'on' : ''}">${field(o.query ? `<span style="color:var(--sf-text)">${o.query}</span>` : 'Add people or Teams')}</div>${done}${picker}${list}</div>${foot}</div>${o.menu ? levelMenu(o.menu) : ''}`;
}
function levelMenu(kind) {
  const secret = kind === 'secret';
  return `<div class="cr-menu" style="left:${secret ? 676 : 676}px;top:${secret ? 372 : 372}px" role="menu">
    <div class="it ${secret ? 'dis' : 'on'}" ${secret ? 'style="opacity:.5"' : ''}><span class="c">${secret ? '' : I('crCheck')}</span><div><b>Let them use it</b><span>${secret ? 'Only accounts and service keys can run through your machine. Share the value instead.' : 'Their agents run through your machine. They never see it, and you can stop it any time.'}</span></div></div>
    <div class="it ${secret ? 'on' : ''}"><span class="c">${secret ? I('crCheck') : ''}</span><div><b>Give them the value</b><span>Their devices get their own copy. You can stop sharing, but can’t take back a copy.</span></div></div>
    <div class="sp"></div><div class="it del"><span class="c"></span><div><b>Stop sharing</b></div></div></div>`;
}
function confirmValue() {
  return `<div class="cr-dlg" role="alertdialog" aria-label="Give Maya Kim the value?" style="top:140px;width:440px">${head(M('chatgpt', 24), 'Give Maya Kim the value?', 'Happier · ChatGPT Pro')}
    <div class="bd"><ul class="cr-conseq">
      <li>${I('sfMachine')}<span>Maya’s devices get their own copy of this sign-in, and her agents use it without your machine.</span></li>
      <li>${I('eye')}<span>Happier won’t show it to her, but anything her agents run can read it.</span></li>
      <li>${I('crHistory')}<span>You can stop sharing later. A copy she already has can’t be taken back; sign in again to end it.</span></li>
    </ul></div><div class="ft"><span class="grow"></span><span class="sf-btn txt">Cancel</span>${btn('Give the value', true)}</div></div>`;
}

/* ═══ a free-standing Secret: only the value can be shared ═══ */
function sheetSecret() {
  return `<div class="cr-dlg">${head(I('crTok'), 'Share Registry token', 'Token · End-to-end encrypted')}<div class="bd"><div class="find">${field('Add people or Teams')}</div><div class="lbl">Who has it</div>${youRow()}
    ${who('studio', '6 people · since 21 Oct', level('Has the value', true))}${who('ari', 'Teammate in Studio', level('Has the value'))}</div>
    <div class="ft"><span class="grow">Their devices hold their own copy.</span>${btn('Done', true)}</div></div>${levelMenu('secret')}`;
}

/* ═══ phone bottom sheet ═══ */
function phSheet() {
  const page = accountPage();
  return phWrap(`${phNav('Credentials')}<div class="pg" style="filter:none">${page}</div><div class="cr-scrim"></div><div class="cr-psheet"><div class="grab"></div><div class="hd"><b>Share Happier</b><span>ChatGPT Pro · codex4@happier.dev</span></div>
    <div class="bd"><div class="find">${field('Add people or Teams')}</div><div class="lbl">Who has it</div>${youRow()}${who('maya', 'Friend · since 24 Oct', level('Can use it'))}${who('studio', '6 people', level('Can use it'))}</div>
    <div class="ft"><span class="cr-dim" style="font-size:var(--product-type-meta-size);text-align:center">Use runs through nl2-devbox</span>${btn('Done', true)}</div></div>`);
}

const over = (dlg) => ({ over: scrim(dlg) });
const NOTE_Y = `<h3>Y · One sheet, a level per person (recommended)</h3>
<p>Owner ruling: “one simple share sheet from the credential: people/team picker under the Q10 rule, then ‘Let them use it’ / ‘Give them the value’.” Replaces today’s Share flow (Teams list left, empty detail right).</p>
<ul><li><b>It is the one ShareSheet</b> every other share in Happier uses (sessions, documents, projects, today’s Secrets), mounted with a credential adapter. The owner’s two choices are its two levels: <i>Let them use it</i> → shows as “Can use it”; <i>Give them the value</i> → “Has the value”.</li>
<li><b>Add</b> from one search over friends, teammates and your Teams. A person who isn’t eligible stays visible with the reason (“Not a friend or teammate yet”), from the server’s eligibility owner.</li>
<li><b>Safe default</b>: adding someone gives “Let them use it” at once — nothing leaves your machine. Choosing “Give them the value” from the level menu asks first (consequences, then <i>Give the value</i>), because it can’t be undone.</li>
<li><b>Where use runs</b> is one chip in the footer (“Through nl2-devbox”): the broker placement the brokered grant needs, defaulting to the machine the account is signed in on.</li>
<li>Changing a level or stopping applies at once with the row’s own saving/error state (ShareSheet operation model); stopping takes effect at the next request (revocation at the next boundary).</li></ul>
<p>Data: person audiences for brokered use land in Providers cred-merge-1030 with a security review (RULING 21:12); the sheet offers “Let them use it” to people only once that lands. ${NEW}</p>`;
S.crShare = { title: 'Share sheet', subtitle: 'one sheet; Let them use it / Give them the value', def: 'y', variants: {
  y: { label: 'Y · shared with 2 (rec.)', h: 940, html: () => shell('Credentials', rail({ sel: 'happier' }), accountPage(), over(sheetY({ grants: [['maya', 'Friend · since 24 Oct', 'Can use it'], ['studio', '6 people · since 21 Oct', 'Can use it']] }))), notes: NOTE_Y },
  yEmpty: { label: 'Y · first share', h: 940, html: () => shell('Credentials', rail({ sel: 'happier' }), accountPage(), over(sheetY({}))), notes: NOTE_Y },
  yPick: { label: 'Y · adding', h: 940, html: () => shell('Credentials', rail({ sel: 'happier' }), accountPage(), over(sheetY({ picker: true }))), notes: '<h3>Adding</h3><p>The directory search: People (friends and teammates) and Your Teams. Each eligible row adds with one press; the ineligible one explains itself. The sheet keeps its height while results narrow.</p>' },
  yMenu: { label: 'Y · level menu', h: 940, html: () => shell('Credentials', rail({ sel: 'happier' }), accountPage(), over(sheetY({ grants: [['maya', 'Friend · added just now', 'Can use it', true], ['studio', '6 people · since 21 Oct', 'Can use it']], menu: 'acct', done: true }))), notes: '<h3>Level menu</h3><p>Popover from the level control (Popover + FloatingOverlay, anchored to the trigger): the two ways, each with its consequence; Stop sharing last. The one-line confirmation above the list acknowledges the add without moving it.</p>' },
  yConfirm: { label: 'Y · give the value?', h: 940, html: () => shell('Credentials', rail({ sel: 'happier' }), accountPage(), over(confirmValue())), notes: '<h3>Confirm the value</h3><p>Only the irreversible choice asks. Three consequences in plain words, then Cancel / Give the value. Primary, not destructive red: it is a deliberate grant, not a deletion.</p>' },
  ySecret: { label: 'Y · a Secret', h: 940, html: () => shell('Credentials', rail({ sel: 'registry' }), secretPage(), over(sheetSecret())), notes: '<h3>A free-standing Secret</h3><p>Broker sources are accounts, pools and provider keys only (sourceBindingV1), so a Secret can only be shared as a value: “Let them use it” stays visible but unavailable, with the reason in place.</p>' },
} };
S.crPhone.variants.share = { label: 'Share sheet', phone: true, html: () => phSheet(), notes: '<h3>Phone · share sheet</h3><p>The same ShareSheet as a bottom sheet that tracks the finger; Done full width; the level menu opens as a menu above its trigger.</p>' };
})();
