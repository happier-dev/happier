# Session collaboration: access, key delivery, personal state

One Session can be readable by its owner, by Accounts it was shared with directly, and by the
members of Teams and flat Groups it was granted to. This page is the contributor's map of who
decides what across that surface, because the decisions look adjacent but are deliberately
separate: **who may do something** is Session access, **whether they can decrypt it** is key
delivery, **whether it is personally relevant** is the personal-state owner, and **what the
Session is doing right now** is the awareness projector.

See also [Team lifecycle, policy, and branding](teams.md),
[Team membership, flat Groups, and Session-history horizons](teams-membership-and-groups.md),
[Encryption and data encoding](encryption.md) for the recipient-envelope tuple,
[Protocol](protocol.md) for the awareness projection and its wire selectors, and
[Compatibility](compatibility.md) for the released owner/direct seam.

> **Status (0.3 development source).** Team and Group grants, responsibility,
> Follow and the shared read-state owner are implemented behind the `sharing.session`,
> `sessions.conversations` and `sessions.following` feature ids, which are per-Home capability
> boundaries enabled by default (see [feature-gating.md](feature-gating.md)). Direct shares
> created by 0.2 stay effective regardless of them. The first-class Discussion migration is
> incomplete; see its dedicated section below. Source presence is not release availability.

## Canonical owners

| Decision or fact | Owner |
|---|---|
| Effective access for one `(Account, Session)` | `apps/server/sources/app/session/access/sessionAccess.ts` |
| Capability rules, level order, delegation-gain rule | `packages/protocol/src/sessions/access/sessionEffectiveAccessV1.ts` |
| Access role classification for a projection | `readSessionAccessProjectionRoleV1` in the same Protocol module |
| Grant mutation, subject resolution, transition effects | `apps/server/sources/app/session/access/sessionAccessGrantService.ts` |
| Complete current structural recipients of a Session | `apps/server/sources/app/session/access/sessionRecipients.ts` |
| Team authentication qualification for a Session operation | `apps/server/sources/app/session/access/sessionAccessAuthentication.ts` |
| Recipient data-key envelope tuple and its pages | `apps/server/sources/app/session/encryption/sessionDataKeyEnvelopeService.ts`, `.../sessionDataKeyEnvelopePersistence.ts` |
| Recipient content-key readiness projection | `apps/server/sources/app/session/encryption/sessionDataKeyRecipientProjection.ts` |
| Envelope wire shapes and summary-bucket precedence | `packages/protocol/src/sessions/encryption/sessionDataKeyEnvelopes.ts` |
| Durable viewer read state and its cursor operations | `apps/server/sources/app/session/personal/readState.ts` |
| Explicit Follow relations, default-rule preferences, Follow entry | `apps/server/sources/app/session/follow/accountFollowService.ts` |
| Receiver delivery-mute state and decision | `apps/server/sources/app/session/follow/sessionDeliveryMuteService.ts`, using `packages/protocol/src/sessions/follow/sessionDeliveryMuteV1.ts` |
| Operational awareness projection | `packages/protocol/src/sessions/awareness/projectV1.ts` |
| Client runtime observations, exact Home and Session scoped | `apps/ui/sources/sync/domains/session/sessionRuntimeObservation.ts`, populated by the existing activity accumulator |
| Client Session/list publication classification after admission | `apps/ui/sources/sync/store/domains/sessionRuntimePublication.ts`, consumed by the Session store's full-row and scoped-list writers |
| Discussion mutations, including Agent provenance | `apps/server/sources/app/discussions/mutations.ts` |
| Discussion grants and recipient keys | `apps/server/sources/app/discussions/accessService.ts`, consuming `app/teams/resourceGrantAccess.ts` |

## List omission and concurrent exact reads (0.3 development)

Selected secondary Homes refresh through push, reconnect and gap recovery without
a periodic refresh. Web lifecycle recovery uses visibility, pageshow and resume
events. Each loaded browser tab owns an in-memory cursor identity; it does not
renew a cross-tab presence lease. Reloading starts a fresh tab scope using the
existing snapshot and catch-up path. Blocked-cursor events evaluate cursor-lag
diagnostics without a sleep-detection timer.

The ordinary list and exact Session response carry an optional `observationCursor` from the
viewing Account's existing change sequence. The server reads it in the same content snapshot
as the rows and returns that admitted capture without a second policy evaluation. Only the present-user
Sync consumer receives this Account-wide observation; automation and restricted Session
credentials do not. It is a read-order witness, not an
access grant or permission to advance the client's applied change cursor.

Transcript pages, exact-message and action-reference lookups, and reply projections
likewise admit the finite read once in their content snapshot. They finish from
that captured access, publication and content state without a post-snapshot policy
replay or a second reply snapshot. The next request admits again and observes
revocation. Live socket delivery remains a separate recipient content-read boundary;
its current disclosure authorization is not retained from the originating write.

The client membership owner is `sync/engine/sessions/snapshotMembership.ts`. Ordinary-list
omission never proves access withdrawal, even for an exhausted page with a newer observation
cursor. Reconciliation adds listed Sessions while retaining previously readable Sessions and
pending exact reads. This keeps off-page and pinned Sessions available for their existing
exact-read hydration and repair. Explicit access pushes and authoritative exact-read refusals
use the existing teardown owner and fence outstanding reads.

Direct share revocation and deletion retain their explicit teardown. Pure Team/Group changes
instead publish AccountChange and refresh the demanded list. A secondary Home reads the
Session ids named by that wake through the existing exact list-projection reader when
it retains those rows; authoritative absence retires only that Home's row. Duplicate
ids share one read and unrelated retained rows are not fetched. Retained off-head rows are not
re-read one by one on refresh: access is enforced at the next natural request or reconnect,
and an exact read's authoritative absence retires that Session. Account suspension also
withdraws credentials and sockets. Machine
control withdrawal retains readable Session history; terminal custody and Archive have their
own lifecycle. Ordinary handoff changes execution placement without transferring Session
ownership. Older producers may omit the optional observation cursor; ordinary-list omission
does not establish withdrawal with either producer shape. The server continues to authorize
each exact read and controls live delivery and stream retirement.

## One access decision, two presentations

`projectEffectiveSessionAccess` in `sessionAccess.ts` is the only place that turns a loaded
Session row into an access answer. It collects the applicable grants — the caller's direct
`SessionShare` rows, then the Team and Group grants whose membership is currently active and
whose `effectiveAt` is after that member's history horizon — and projects them through the
Protocol's `projectSessionAccessCapabilitiesV1`. Capabilities are resolved per grant, never by
combining grants: an Admin grant and a delegated Edit grant do not add up to delegated Admin,
because each capability must be supported by one qualifying grant on its own.

The wire shape is `SessionEffectiveAccessV1`, marked `v: 1`, carrying the resolved `level`
(`view` → `edit` → `admin` → `owner`), the decisive `sources`, the full `capabilities` record,
an optional `audienceContext`, and an optional `primaryTeamId`. Three of those are frequently
misread:

- `sources` is the *decisive* set, not the complete audience. The projector records the highest
  grant, plus the grant that supplied permission delegation, plus a Team grant that is required
  by Team policy — enough to explain the answer, not to enumerate the sharing topology.
- `audienceContext` is one safe display identity. It is never an authorization input.
- `primaryTeamId` is authored organizational context. It may name a Team that has nothing to do
  with the decisive grant, and it never establishes a grant or an audience match.

`resolveSessionAccessForOperation` is the single composition point for a protected operation. It
keeps structural entitlement and Team authentication separate until that point, so an
owner-or-direct path can never be suppressed by a failing Team-derived path, and it carries the
`accessMode` selector: `legacy_owner_or_direct` leaves Team and Group grants out of the answer
for a released reader while every other rule — runtime-principal currentness, Account status,
transcript shareability, capability — stays in the same owner. The two seam projections are two
presentations of one decision, never two admissions.

A verified Session-scoped Runner principal is admitted here too, as a capped `edit` recipient
with empty `sources` and no owner metadata: its authority is credential-derived, not a persisted
sharing relationship, and `verifyCurrentMaterializedRunnerPrincipalInTx` revalidates the
persisted activation, Machine and AccessKey binding on every sensitive operation rather than
trusting the socket admission that proved the signed bearer once. The Machine-RPC half of that
principal is in [peer-mediation.md](peer-mediation.md).

For clients, `readSessionAccessProjectionRoleV1` is the one normalizer that turns a Session
record into `owner` / `recipient` / `unavailable`. A present-but-malformed `effectiveAccess`
resolves `unavailable` and must not fall back to released owner/direct inference; only true
absence permits the released `share` translation.

## Grants: direct-only `SessionShare`, plus Team and Group grants

`SessionShare` is the **direct** grant table and nothing else. One row is one
`(Session, recipient Account)` pair carrying `accessLevel` and `canApprovePermissions`. The
canonical grant service (`/v2/sessions/access-grants/*`) is its only writer; the released
`/v1/sessions/:id/shares` routes were removed under the one-way 0.3 upgrade because no 0.3
client calls them. Rows a 0.2 Home created stay effective and readable through the same
access evaluator.

Team and Group grants are separate tables — `SessionTeamGrant` and `SessionGroupGrant` — and they
deliberately do not copy membership. The grant row is durable and membership is evaluated live,
so removing a member revokes their access without touching the grant. Each row mints
`effectiveAt` once, from the same transaction-scoped database clock that mints membership
horizons, and preserves it across later desired-state replacements, because it is the only fact
that can decide a `from_membership` member's access to Session history. `requiredByTeamPolicy` is
set only by the Team session-policy composition and is never accepted from a client.
`SessionGroupGrant` stores no redundant `teamId`: the Group reaches its Team through its own
relation.

In 0.3 development, the live access editor previews context-policy refusals through the
manager-only `/v2/sessions/access-candidates/inspect` read. It batches the directory subjects
and delegates externality and the context Team's verdict to the same server policy owner
as the grant writer. The reply also names the current context and reports its archive state;
absence from an active-Team directory alone does not prove archiving. A Home without this
read leaves context-scoped additions unavailable with a retry explanation. The grant writer
still rechecks current policy when a change is submitted.

## Key delivery is a separate fact

The envelope collection preserves restricted Team authentication recovery for the
management operation. A readable Session with an independent direct View grant does
not satisfy `manageAccess`; the server returns a typed authentication-required or
authentication-unavailable result when the Team policy needs qualification. The UI
surfaces that recovery state, then refreshes and explicitly retries after qualification.
A Session with no current read access remains concealed.

Access says a recipient may read the Session. It does not say they can open it. For an encrypted
Session, each recipient needs a data-key envelope, and the canonical record is the
`(Session, recipient Account)` tuple behind
`GET`/`PATCH /v2/sessions/:sessionId/data-key/envelopes`.

The tuple carries three facts that are reported separately on the wire: `recipientAccountId`,
`envelopeState` (`prepared` / `missing` / `invalid`, describing stored bytes alone), and
`contentKey` (the recipient's readiness, `available` with the binding or `unavailable` with a
reason). The readiness projection has one owner,
`sessionDataKeyRecipientProjection.ts`, shared by the per-Session collection and the
membership-history page so the reason vocabulary and encodings are not answered twice.

`classifySessionDataKeyEnvelopeItemV1` is the one owner of summary-bucket precedence, and it
makes unavailable readiness exclusive: an inert tuple left behind by an earlier preparation must
not report a Plain or inconsistent Account as `prepared`. Structural validity of stored bytes is
never a claim that the recipient can open them, and a retained tuple after revocation is inert —
it is simply never projected again. The full preparation, repair and page-boundary contract is in
[encryption.md](encryption.md#recipient-key-delivery-development).

## Context documents and private Session preferences (0.3 development)

Session access and Artifact access are separate grants. Sharing a Session or
belonging to its Source does not grant its owner's Prompt Library documents.
Context, instruction and memory reads use the qualified Artifact access and
encryption owners for the addressed Home and current Account. A recipient with an
actual document grant can read its permitted content; a recipient without that
grant remains owner-private. A reference selects content; it cannot mint a grant
or borrow the Session owner's credentials.

The Session's prompt-stack selection and Voice preference remain owner work facts.
`SessionOwnerWorkV1Schema` retains them under `work`, while
`projectSessionSharedMetadataV1` excludes that private work from recipient metadata.
A grant to a document does not expose or transfer the owner's Session preferences.
Conversely, unavailable owner preferences do not invalidate a separate document
grant. The qualified UI Prompt Library reader delegates to the captured Account's
`workflowArtifacts` transport rather than using a cached owner's display copy.

Editing a readable document still requires its current write access and normal
Actions admission; required approval uses authenticated human authority. Neither
Session membership nor an Instructions attachment creates a Bot-specific waiver.
The Session Work display and editing controls are still being integrated; these
source contracts do not establish released UI availability.

The development Ask Happier entry uses `happierGuideDraft.openAskHappierDraft`
to create an editable `built_in` PromptDoc through the captured Account's
existing Prompt Library writer. The Protocol Instructions-intent owner selects
that qualified reference in the ordinary durable Bot draft before navigation;
only the composer can Send. A failed navigation retains the canonical draft
and acknowledged document, without speculative deletion or automatic replay.
Pre-auth Start stores only authoring context in the existing Home-scoped pending
setup-intent owner, using its unchanged keys, TTL and Account adoption. The
authenticated index consumes that branch through the same opener rather than
machine setup. Release context is a captured four-field entry; current-screen
context must come from the canonical safe CurrentUiContext snapshot. These
private documents do not create any additional Artifact grant.

## Personal Session pins (0.3 development)

Pinning is the viewing Account's organization choice, not a Session identity or
access mutation. A readable shared Session can have that reader's own list pin;
changing it neither promotes the Session to a Bot nor changes the owner's work.
The existing `SessionPin` row carries independent list and rail memberships with
one personal order. Adding rail membership requires the exact Home's readable
Bot identity; demotion hides the rail item but retains the personal choice, which
can still be cleared. The Bot marker remains a recipient-safe identity fact,
not an authorization grant or an inference from pin presence.

The current pin Action uses Account HTTP transport without waking the execution
host. Retained predecessor pins become list-only at the stored reader; current
HTTP requests and responses stay strict. See [Actions](actions.md) for the
canonical mutation and answering-client reorder owners. These are development
contracts; source presence does not establish released rail or roster UI.

The ordinary list refresh treats pins and the organization snapshot as additive.
An unavailable pin read keeps the personal pin and uses the existing
metadata-unavailable presentation when a cold row exists. An organization failure
keeps its own error and retained arrangement. Neither failure rejects an otherwise materialized list
page or prevents its next-page cursor from advancing. A later refresh or explicit
Session open can recover the pin. Explicit required hydration used by change-feed
recovery still must succeed before that recovery checkpoints its changes.

## Read state, Follow, and awareness

These three answer different questions and must not be collapsed:

- **Read state** (`AccountSessionReadState`) is the sole durable per-viewer unread owner. Absence
  means quiet; a frontier is clamped to the viewer-visible publication ceiling; a mutation touches
  exactly one Account.
- **Follow** is the durable per-Account choice to track a Session, with its notification and Voice
  preferences and four relationship default rules (`assigned`, `direct`, `team`, `group`).
- **Awareness** is the pure operational projection of what the Session is doing. It is not
  persisted and owns no unread, Follow, attention or notification decision. See
  [protocol.md](protocol.md#session-awareness-development).

In 0.3 development, `follow.preferences.set` writes the four relationship choices as
`defaultRules: { assigned, direct, team, group }`, alongside any supplied
`managerPolicy`, `runReportPolicy` and `discussionReceivePolicy`. The shared reader
also accepts the legacy four top-level booleans and normalizes both forms to the
existing Account columns. This names the existing operational defaults; arbitrary
private rules still use the ordinary Follow rule owner. Omitted creation policies
keep their saved values, and existing relationships are unchanged.

In 0.3 development source, the UI retains admitted runtime observations separately from
Session content rows, at the exact Home and Session address. After existing admission and
normalization, the Session publication owner classifies an already-active row's coupled
`activeAt` / `updatedAt` renewal while every other semantic fact stays equal as a legacy
liveness carrier. It retains the incoming clock pair before freshness normalization, so a
debounced older renewal cannot masquerade as a content change after a newer presence
transition has correctly fenced its activity clock. Socket projections and hydrated/list
snapshots share this owner: timely carriers refresh the observation without advancing
content time or replacing the row. An `updatedAt`-only commit receipt likewise retains the
incumbent content row; actual semantic and authority changes retain normal publication.
Socket and HTTP projections preserve absent optional facts rather than synthesizing new
own `undefined` fields. Committed owner-tuple writes publish their complete admitted owner
projection, including envelope provenance, through the same reader/projector as hydration;
an HTTP echo does not create a second projection for that commit. Patch coalescers batch ordered
projectors, not pre-normalized rows: the store admits each operation against the preceding
row and derives publication, membership, index and persistence impact from the final state.
Net-zero batches retain their original row and root identities. Awareness
and its existing freshness clock read the observation; actual stop, offline and stale-to-live
transitions still notify consumers. Equal-time observations are stop-wins. The same compact
record retains the suppressed full-publication clock. The scoped ordering reader uses that
witness for inventory/hydration currentness, lifecycle replay, thinking resurrection and
fallback pending/transcript ordering, without changing content sorting or display clocks.
Session-list grouping and Activity recency use meaningful activity (or creation), not the raw
receipt clock. The opened "Put under…" chooser deliberately snapshots last-receipt recency:
its ranking and relative-time label read that exact-Home witness directly, without replacing
the retained row. A receipt alone seeds only compact runtime facts and cannot invent presence.
Activity and Work inventory presentation consume the admitted compact row with exact-Home,
tuple-current held facets; they do not reconstruct a full Session on every projection pass.
The same lifecycle, metadata and pending owners serve those facets and an explicitly presented
full request control. A newer summary cannot invent a request body from an older Agent tuple.
Pure ephemerals never advance the witness, and raw observation admission rejects thinking
resurrection at or before it; a genuinely later observation remains fresh.
Account resets and Session removal clear the same owner. This is a client projection
correction, not a new wire format. The server delivers an active heartbeat to the whole
publication audience as the `activity` ephemeral (see Follow availability below). The socket parser accepts absent or matching
legacy `sid` aliases and rejects contradictory Session routing identities before projection.

In 0.3 development source, reverse `follow.list` inspection delegates to the Session Follow
edge owner through the shared Action transport. A caller must currently read the source;
each returned Session receiver also requires current read access. The complete source-owned
projection distinguishes manager and ordinary relations, includes the caller's own personal row
only when it contributes to the anonymous people count, and reports active stored personal intents
in that count. This counts persistent follows and armed one-shot intents with current source access;
private Unfollow preferences and fulfilled-only witnesses remain at `follow.get`. Implicit owner tracking and event-time
rule matches do not create enrollment rows. Other Accounts' identities, rules, preferences and
delivery receipts are never part of that census.
Revoking source access refuses the read; revoking receiver access withdraws that receiver.

Generic Follow source references in 0.3 development use the strict `sourceRef` JSON query
on the shared Account/Session get, set and remove transports and reverse follower read.
The Action transport owns encoding and exact signed-purpose matching; source identity
is parsed once after query decoding. A full Execution Run id therefore reaches the same
source admission as a short id, without expanding the HTTP router's parameter limit.
These undeployed source URLs replace the earlier JSON-in-path projection in place;
Session-source routes and receiver mute bodies keep their existing contracts.

Follow list inspection in 0.3 development accepts an optional `limit` and a source-owned
`cursor`. With no limit, the owner returns the complete admitted list. A limited read
returns `continuation` while more source relations remain, and the Action reports partial
coverage until the last page. Cursors bind the exact Account and inspection direction;
each page applies current access again and does not freeze membership. The optional
`sourceKinds` set selects relation kinds before pagination and binds the continuation
to that selection. Private rules are returned with the first Following page when
no kind selector is present, rather than repeated on every source page;
kind-selected reads omit that census.

In development source, Session and Account Voice Follow observations and
acknowledgements use the authenticated socket's lifetime and cancellation, without
a shorter handler-local deadline. The existing publisher authority checks and
Serializable transaction retries remain; the storage owner retains its acquisition
and execution budgets. A failed observation returns a typed failure without
advancing Follow progress, so a later invalidation or reconnect can observe the
same retained original again.

The development daemon's `/session-activity-changed` notification likewise
waits for its source reconciliation without a shorter generic control deadline;
explicit caller cancellation and deadlines still apply. It reports a committed
personal Session occurrence, not a Discussion receiver binding. Removing a
Discussion participant detaches that Discussion's Follow edge but does not
disable unrelated personal Session follows or their original notifications.

Session-original route reads in 0.3 development validate the source's current
publisher generation and Machine custody. A heartbeat from that same publisher
does not retire a committed occurrence notification while the daemon traverses
its source range. Publisher replacement, source access, the exact original,
receiver audience and mute remain current checks. An idle manager therefore
uses the ordinary policy and Pending wake path without first taking a foreground
turn to recover the source through receiver-owned authority.

An exact question-handler offer also asks that route owner whether the same
handler-bound original already has admitted Pending or Message custody. The
dispatcher excludes that represented handler before another Pending POST,
including during late receiver catch-up. Unrelated Agent-state bookkeeping does
not change the original key; passing the question to a different handler does.
This read reuses the existing input custody and access checks. Fresh source
versions and final native request/handler admission remain fenced as before;
an observation is neither a new receipt nor permission to answer.

Passing up changes the assigned handler, not the asking Session that owns the
request. The form identifies `questionOwnerSessionId` and supplies the exact
`session.user_action.answer` routing arguments. A manager or grandmanager must
target that original owner, not its own handler Session. Answer lookup and
completion stay at the original request store.

The daemon's connected-service projection consumer respects the Account change's
qualified service scope. It reconciles only runtime targets configured for, or
still holding an active binding to, an affected service; an unscoped snapshot
continues to reconcile all targets. An email-only change must not rematerialize
coding-agent credentials and hold the Account feed ahead of a question wake.

Receiver reconciliation uses an exact, cursor-relative
`session-follow-receiver:<sessionId>` entry on the existing Account change feed.
The relation invalidation owner publishes it transactionally to the receiver's
current audience alongside the ordinary Session projection. A later Pending or
metadata write cannot overwrite that separate wake. Installed and requester
Account daemons consume it through the same receiver admission; a generic change
to the receiver's Session row does not itself demand another Follow observation.
The UI retains the ordinary Session projection and treats the receiver-demand key
as neither an Account Settings/Profile change nor a Usage change.
Reconnect and gap recovery still inspect retained originals. The wake contains
no content or authority: Home, Account, Machine, installation, access, policy and
currentness are rechecked before delivery. Source-range traversal shares its
already-admitted Session transport with rule-facts preparation within that pass;
it retains no Session snapshot across operations.
The same pass prepares supplemental Project and organization filter facts once
for its source and admitted rule snapshot, then shares them across its original
messages, questions and terminal occurrence. A new pass reads fresh facts; a
changed rule snapshot prepares the facts required by that new configuration.
Original-route verification and final Pending admission still run per original.
The server observes a source's current destinations through the existing
set-oriented context-admission owner, retaining each destination's audience and
custody checks without repeating source reads for every Follow relation.

Private-rule discovery already names a changed source and candidate receiver.
It dispatches that source through the same ordered range owner, without first
reading receiver-wide inactive observations. That owner refreshes rule progress
and verifies original, route and delivery authority. Concurrent requester source
hints retain their exact source identities; only an actual receiver invalidation
or lost feed continuity requests broad recovery. The request-count contract is
zero receiver-wide reads for source-only discovery or settled idle, and one per
exact receiver invalidation, not one per native Turn: a Turn can commit several
distinct source facts, and each admitted range still has one source-detail loader.

Source publication hands Session-original ranges to the daemon's destination
Session context. The receiver's retained requester owns original scheduling for
both source offers and receiver catch-up; the source requester's separate rule
cache does not admit that receiver's originals. Overlapping offers and unchanged
redelivery therefore share one Pending admission, while a distinct source Turn
still creates its own input. Pending retains its existing local-id idempotency.

In 0.3 development, the Account daemon also retains rule definitions, defaults
and scoped receiver-progress discovery across ordinary source arrivals. Rule
changes refresh configuration once. The admitted observation retains scoped
progress for Session receivers whose membership, inception and source frontiers
are unchanged; an Account-only rule edit does not make each source re-read the
rule endpoint. New Session membership or changed inception/progress still needs
its server-owned first-range discovery. Reconnect or an exact accepted-progress
receiver push withdraws the affected projection. Concurrent demand shares its
next read. Neither a generic Session arrival nor an unrelated receiver push
reloads that projection. Traversal still reads the current source tail and final
delivery still proves original, progress, access, mute and currentness authority;
the retained projection is discovery, not an admission grant.

The existing content-free request-completion log distinguishes inactive receiver
recovery (`session-follow:receiver-recovery`) from the final fresh check for a
manager waiting Turn or a selected ordinary/manager/rule stalled Turn
(`session-follow:manager-turn-admission`). These
labels are diagnostic only and do not supply admission authority.

Ordinary followers, managers and rule-only receivers can consume a selected
stalled Turn through the existing no-original V1 observation and provider-accepted
frontier ACK. A selected wake can resume an eligible inactive receiver; next-turn
delivery waits for ordinary input. Selection alone neither writes a Pending input
nor advances delivered progress, and an explicit Stop still holds automatic wake.

For rule-only delivery, the admitting Account daemon evaluates its
private rules; the existing private rule `sources[]` progress entry retains the
selected presence fence and delivery decision without advancing `delivered`.
Home projects only `relation: 'rule'`, aggregate `effectiveDelivery`, the exact
presence/Turn witness and public frontier facts. Rule ids, versions, filters and
private progress do not enter the no-original observation, source-key control,
wake event or ACK. Rule edits/removal, delivery mute and recovered presence
withdraw pending selection. Overlapping physical and rule routes share one
worker card while acceptance settles every represented route.

This is an unreleased 0.3 extension of the closed Follow V1 wire objects, not a
new npm-version or wire epoch. Current readers still accept physical V1
observations; the new authority-bearing rule arm requires matching current
producer and consumers. The inspected 0.2 predecessor has no such no-original
Follow seam, so no reverse-development adapter or additional persisted store
is introduced. The private progress endpoint's `accepted` result admits pending
selection only; delivered progress still requires the provider-accepted ACK.

The projection writer distinguishes Pending bookkeeping, metadata-only and
runtime-activity projection writes from source changes. Those writes still
refresh ordinary Session readers without invalidating outgoing Follow receivers;
Agent-state, transcript, Turn and lifecycle changes retain source invalidation.

The same distinction reaches the installed and requester daemons on the existing
Account change feed. A projection-only hint carries `followSourceChanged: false`
and `followSourceUnchangedSinceCursor`, the existing Account cursor before that
run of projection writes. The AccountChange publication owner preserves that
cursor when later title/read projections coalesce. A daemon skips source-rule
discovery and range traversal only after its feed has consumed that preceding
cursor; an unseen original coalesced under a later title still demands traversal.
Unknown or older hints retain ordinary source recovery. A metadata-only
notification therefore performs no Follow GETs, while a committed source message
still traverses its range. This adds no retained daemon snapshot or signal, and
does not change Pending custody, original admission or delivered frontiers.

The Account-lifetime original scheduling owner retains unfinished admission and
selection decisions, indexed by source and receiver. Accepted Pending/Message
custody and applied Follow frontiers remain authoritative: the dispatcher retires
scheduling entries only from the common applied frontier of the contributing
routes, including its actual terminal Turn witness. That witness also excludes
the consumed Turn from reselection. An unrelated source push therefore visits no
other source's scheduling entries, while admitted work without its applied
witness remains retained. Scheduling settlement never creates a delivery ACK.

The same Session push carries the content-free advisory
`followReceiverAvailabilityChanged` decision. Publisher registration, retirement,
access-loss retirement and active/inactive transitions set it. An active publisher
touch (the released 60-second heartbeat of an already-active Session) changes no
durable row fact: it persists only the liveness fence (`lastActiveAt`) and writes
no AccountChange or Account cursor. Its current publication audience, including
shared viewers under the realtime publication policy, receives the new `activeAt`
as the `activity` ephemeral without `thinking`, which keeps their 120-second runtime
freshness without a catch-up read. Inactive → active recovery still publishes. 0.3
does not keep the earlier durable heartbeat for released 0.2 viewers (0.2 and 0.3
components are not mixed).

The AccountChange owner OR-coalesces availability and retains its original
Account cursor in `followReceiverAvailabilityChangedAtCursor`. Readers release a
receiver-held original only for that receiver's unconsumed availability event,
an exact Run push, or Account reconnect/full recovery. A consumed event retained
under a later title is false for that reader. Follow receiver-progress hints
cannot release receiver-held admissions. Older servers omit the field; only an
own-receiver change with held work permits `legacy_unqualified` recovery.
Neither hint grants input authority or advances accepted progress. Stop publishes
availability when the runtime becomes inactive; Resume publishes it when the
runtime registers its publisher again. Clearing explicit-stop metadata requires
no separate Follow cue. Final admission still rechecks the receiver's stop and
publisher state.

Terminal Session Follow in 0.3 development selects the host's persisted Turn
before merging ordinary, manager and matching-rule routes. The exact
`sourceTurn: { id, status }` determines `finished` for a completed Turn and
`failed_or_stopped` for a failed or cancelled Turn. Native ready timing does not
create another original; silent host-loss failures use the same Turn path.
Waiting requests and observed stalls remain separate source facts. Hydration
opens only the selected Turn's anchored final message and cannot reclassify its
outcome from a later Session or review-Run state.

Current policy is rechecked at the effect boundary. A private rule's exact
selected delivery vote stays with its pinned-version admission witness; the
server combines surviving votes with current ordinary/manager policies without
opening private rules. Its effective mode controls wake versus natural-turn
intake separately from the immutable original receipt. Native ordinary personal
failure fallback uses the same verified Turn and real publisher proof, retaining
the incumbent Activity eligibility owner without granting unavailable private
rules or creating Session delivery effects.
Failed/cancelled native markers retain their existing committed receipt in the
host's per-Turn transcript state. Only after the host terminal mutation persists
does that owner notify the incumbent daemon/Activity path; append callbacks no
longer announce those terminal facts early. A deferred append reuses its existing
commit observation and Session lifetime, without delaying Turn retirement or
adding notification durability.

Source-owned Account private terminal effects additionally retain the native
terminal receipt as `terminalSourceMessage: { localId, seq }` in personal progress.
The exact committed record and verified Turn/status are checked together. The
existing Account rule `delivered.readyEventSeq` orders these current-state cues:
an older or equal terminal sequence has no effect and cannot replace a newer
cue. This does not advance transcript-prefix progress or promise delivery of
every historical Turn. Without that receipt, source-owned Account private effects
fail closed; off-source host-loss recovery remains receiver-owned under C1 §4.5,
and existing server explicit alerts and UI Inbox projection are unchanged.

In 0.3 development, Follow Inbox rows remain derived: the Activity dispatcher
does not write a private notice Artifact for a Follow occurrence. Follow progress
records source acceptance, not an outward channel receipt. The existing
`dispatchActivityNotificationAsync` owner writes one INFO-level file record,
`[activityNotifications] Dispatch outcome`, for each dispatch, including a quiet
zero-attempt result or a preparation failure. Read the JSON after that marker in
the serving daemon's log, or the owned runner's log when its rich notification
owner sends. Correlate `sourceSessionId` with `sourceTurnId`, or
`sourceMessageSeq` for a committed ready original; `occurrenceId` reuses the
canonical opaque Follow occurrence key when one exists. Channel counts and
per-channel ids/status/cause codes contain no notification content or endpoints.
`deliveredChannels` means adapter/provider acceptance, not device display;
`failedChannels` means no acceptance was confirmed for that attempt, not proof
that a remote effect could not have occurred. A missing record remains unknown,
including while dispatch is pending or INFO logging is disabled. An Important
completed Turn is quiet and can correctly report zero outward attempts; that
record does not independently prove the derived Inbox row was displayed.

The channel catalog is the Account's independent `notification-channels` entity
row, not the plugin contribution registry. Daemon warm-up is process-local;
runner preference bootstrap alone does not load this row. Activity dispatch
demands a missing/loading catalog through the existing Account catalog loader
only for its captured, still-current Account lifetime and matching credentials.
Explicit supplied catalogs and unavailable/partial results remain fail-closed;
dispatch never substitutes legacy preferences or an empty channel list. Catalog
preparation failure occurs before selecting push, webhook or plugin channels,
so zero attempted channels with a cause is not a successful quiet result.

Personal receiver evaluation in 0.3 development uses the captured app Account
lifetime and the same pure Protocol rule evaluator as the source daemon. Private
definitions retain the census reader's Home, Account, credential and mode checks;
originals use current Session read access and that Session's actual content keys.
Same-Account source-produced originals remain source-daemon work. The
receiver-person observation and personal-progress arms carry exact original and
rule-version identities without claiming Machine or publisher authority. The
server verifies foreign Session ownership, read access, the caller's private
rule, mute, inception and existing progress before accepting an effect. Replay
and a second device share that per-rule progress; no enrollment or delivery log
is added. A recovery claim without a server-known recovery fact remains pending
as `recovery_unverified`; terminal status or an absent publisher alone is not
such a fact. Known receiver-evaluated pending work uses “Waiting for an authorized
device” while its authorized app lifetime is unavailable. For never-read sources,
the personal read-state owner projects a boundary for each exact rule version
from its existing inception. Originals before that boundary stay excluded; later
originals count as unread until the viewer's normal read or mark-read advances the
existing private cursor. The app selects only its currently matching rule's
projected boundary and policy. No initial cursor, Follow enrollment or receipt
store is written, and disabling, deleting or changing the rule removes its future
match contribution. The app withholds personal progress until the incumbent
Activity-to-Inbox classifier represents the original. Loaded-runtime replay and
the presentation look-check remain integration work, not release claims.

In development source, configured Execution Run and Workflow Run follows read
the Run's own original through the Follow occurrence-route owner.
The Account daemon retains only active Run/Discussion Follow interests in its
existing Account list projection. Reconnect and Follow configuration changes
refresh that projection; a recreated Account lifetime loads it on first demand.
Session arrivals select only that Session's Run interests from the projection,
without another Follow-list request or an inventory scan. Exact Run/output,
Workflow and Discussion changes retain their source-scoped reads. These interests
select discovery work only: current source, policy, access and accepted progress
remain decisions of the occurrence-route and personal-delivery owners.
Execution Runs retain their terminal occurrence id, including recovered host
loss; Workflow Runs retain their revision and typed state. An Execution Run source
has exactly one anchor: its Session, or its Machine for a detached Run with no
Session. Both use the existing Machine frontier RPC and current source admission;
a Machine anchor never fabricates a Session or borrows another Run's identity.
For a Session-backed Run on a shared Machine, the Session owner remains the
placement/read principal, while transport targets the Machine's actual custodian
Account. The frontier witness rechecks custody, installation, committed placement
and publisher before mutation or acknowledgement; the request stays Session-bound.
An unavailable Run frontier is held by the existing Account-lifetime route reader,
not re-probed by unrelated arrivals or rule changes. On the existing Run occurrence
route, `includeTargetMachineId=true` opts into an optional `targetMachineId` on an
authorized Session-backed `409/source_unavailable` refusal. It comes only from the
same canonical committed placement decision used by that read, never Session metadata
or a caller-supplied target. A held Run with this hint resumes on its own Machine's
reconnect, its exact `execution-run-updated`, or actual Account reconnect/full recovery.
A fieldless refusal retains broad Machine recovery, including with an older server.
Old daemons omit the opt-in and receive the unchanged response their strict parser accepts.
The optional closed `releaseReason` query records `exact_run`, `target_machine`,
`account_reconnect`, `full_recovery` or `legacy_broad` in the existing
`followSourceRoute` completion record; it is a caller diagnostic, not an authorization
or availability fact. Neither query changes the strict request body or adds a poll.
Detached Run admission follows the existing custodian-only Run get/list policy;
general shared-Machine access does not grant private Run inventory or permit
its disclosure into a Session with a broader audience.
A Session's `execution-run-updated` carries Run state and content-free turn
witnesses (ids and state). The server reads this frame in clear in every Account
mode, so a turn's result stays on Run reads and the transcript, and the server
refuses a frame that carries one.
Detached semantic Run changes reuse `execution-run-updated` with only Machine
and Run identity for the custodian Account. The server admits the current
Machine installation and credential; it neither publishes a detached Session
roster entry nor fans private source identities out to shared-Machine accounts.
A live Execution Run
permission request uses its sorted exact request-id/creation-time pairs as a `needs_you` approval
original for Session and personal Account receivers. Clearing or replacing that request withdraws
unstarted delivery through the same source reader and Pending owner; it never
advances or fabricates a terminal cursor. Source notifications
and receiver reconnect both use that read. Session receivers then use the shared
policy and Pending admission. They do not substitute a parent Session's transcript frontier for a
Run result. Repeated observations reuse the original's destination-scoped input
identity; accepted input and source-owned progress determine replay. In 0.3
development, mute, source access and destination policy are decided at new
original admission. Retained bounded delivery uses the original's admitted
custody and exact publisher identity; policy withdrawal applies to the next
admission, while explicit Stop still holds execution.
In 0.3 development, a Session-backed Run's admitted terminal observation also
carries a WorkerUpdate made from that exact retained status, source pointer and
existing sanitized runtime-issue recovery facts when reported. The Follow source owner rechecks the terminal occurrence through
the same Machine frontier read; failure, cancellation and timeout remain distinct.
The receiver renders the outcome through the existing WorkerUpdate prompt/card
path, within its existing Follow context allowance, and acknowledges only after
that exact input is accepted. Missing source evidence or insufficient context
keeps the original pending. This projection carries no result body, deliverables,
keys or native Run-read authority; source inspection still requires an
independently authorized read. Sender notices and final provider input share that
informational instruction. This is development source, with loaded-runtime replay
still required.
The public Follow set/get/list and reverse inspection use that same retained Run
frontier for availability, never relation membership alone. A known running Run
without attention has no pending original; an undelivered terminal or permission
original is pending until its existing acceptance/progress owner settles it.
Missing current source evidence leaves availability unavailable and pending
unknown. Reads probe only authorized selected Run sources outside database
snapshots, then readmit the source and viewer before returning. This projection
adds no source-content access or background polling.
Run wake admission uses the receiving Session's most recent protected,
person-written input as its existing check-in root, not a later agent input's
inherited source root. Without a person input, the exact Run occurrence's
deterministic destination input is the root. Actual native starts count through
the existing Pending/check-in owner; quiet delivery and personal Inbox
acceptance are not starts.
Account Execution Run receivers retain the canonical permission-occurrence key
on their existing private Follow row, independently of the terminal cursor.
The key includes each request's id and creation time, so an id reused for a new
request is distinct. Acceptance revalidates the exact current source; a cleared
or replaced permission cannot consume progress or admit an outward effect.
For supported Account occurrences, the captured authorized Account daemon uses the same
dispatcher and source-owned personal Follow progress. That acceptance advances
the Run cursor and admits one outward channel attempt; channel success is not
the acceptance fact. Inbox Run rows stay derived from the Run owner's attention
projection and recede when the owner settles them. A demanded Run roster retains
last-known rows across refresh failures and publishes loading and failure alongside
them; an unavailable baseline or refresh cannot make Inbox report caught up.
Run Follow does not write a
private Account notice with an independent lifetime, and retired development
Run notice copies are no longer admitted as Inbox notices. A crash after source
acceptance can leave the source-backed Inbox state without a channel alert.
Run **Notify me** controls use the same private Follow row, independently of its
persistent policy: `run_settled`, `first_needs_you`, or `output_ready` for an exact
selected output. Several distinct output intents may remain armed together.
Output readiness is bound to the selected result, comparison, output kind and
revision; a sibling output or the enclosing Run settling is not that occurrence.
The source reader captures pending revision baselines and catches up an already
settled selection when no later-revision boundary was requested. Accepted
one-shot identities remain in that Follow row as source-backed Inbox receipts
until opened or cleared; they are no longer active routing interest. A failed
source read is not a receipt deletion. In 0.3 development, a
typed Execution Run source-unavailable or read-transport outage retains an already-admitted terminal header and
its fulfilled notice within the same Account lifetime, while reporting partial
source coverage. This receipt-header retention does not add stale running
activity or permission rows. An access refusal, malformed response or unknown
failure withdraws the header; it cannot preserve content across an access change.
A cold Inbox still needs the Run owner's readable header: the private receipt
contains an occurrence identity/outcome, not a copied title, content or time.
Run activity and Home reconnect re-read that source; successful recovery projects
the same receipt once without a new Follow acceptance or Artifact write.
Clearing receipts with `clearOnceDeliveries: true` does not remove armed intents or change
the persistent policy. Replacing the armed-intent array preserves unrelated
fulfilled receipts; explicitly rearming the same intent replaces its receipt.
`once: null` explicitly clears all Run convenience custody.
These convenience controls do not author Workflow triggers. Authored Habits
retain their existing trigger and delivery lifecycle.
Explicit Run Follow choices suppress the incumbent
implicit Workflow report, so the two adapters do not send the same original.
Discussion personal follows retain the exact Discussion message reference and
original committed producer classification, but reuse the source-backed
Discussion Inbox item rather than creating a second private notice with a
separate read lifecycle. The existing personal Follow progress admits the
outward channel attempt.

Private, encrypted person Follow settings are not evaluated by Home. Evaluation
belongs to the Account's own online app/daemon context; the captured authorized
daemon performs the private outward-channel dispatch. With no evaluator online,
the app's next-open Account invalidation and badge refresh recover Discussion
attention through the existing source-backed Inbox reader, not a new server
notifier or an app-side outward Follow publisher. Existing Discussion grant
owners establish that reader's cursor; Follow does not create another read
cursor. Discussion participant, mention and request alerts remain on C3's
existing server path. `submitSessionActivityRemoteAlerts` remains Session-only.

**The direct-share rule.** An explicit `mark-read` / `mark-unread` is admitted for *any* active
Account holding `readTranscript` — a direct-share recipient with `view` access included — and
seeds that Account's own read-state row through the single tracking-entry seam
(`beginViewerReadTrackingOnFollowEntryInTx`). It writes no Follow relation: choosing to mark a
Session unread is not choosing to follow it. Automatic tracking keeps the older rule: an
`advance` or a composed acknowledgement without an existing frontier is refused with
`session-not-tracked`, because a composed request must never fabricate a baseline. The tracked
predicate itself is owner-or-active-Follow, resolved through a narrow Follow-fact port, and
cursor presence is deliberately kept out of it.

Relationship attention defaults are normalized into the Account's default Follow rules; assignment and
access transactions do not enroll per-Session follows. Current rule matching uses the canonical
filter and delivery policy, without creating an explicit relation or a read-state baseline.
Explicit Follow remains a separate choice, and an existing opt-out or retained read frontier
is not replaced when defaults change. Owner tracking remains implicit.

In current development source, a newly committed direct grant and an assignment by another
Account publish a content-free `session-personal-event` to the named recipient. The shared
post-commit publisher uses the existing socket router's current credential-qualified Session
access check. The UI presents share/assignment facts through its existing transient notice host;
they do not create a notification history or replay on reconnect. Repeated unchanged mutations
and self-assignment stay quiet. Assignment does not enroll a Follow; the recipient's
default rules select later matching occurrences. Direct sharing never produces an
OS alert, and receiving either in-app fact does not create Follow or read-state rows.

The same development-only, content-free committed-event envelope carries transcript and
Discussion activity, failed/cancelled turns, and unavailable Follow sources into the existing
local Activity notification runtime. Mutation owners classify the committed event; clients do
not infer a new event from ciphertext, a historical list refresh or an `active: false` transition.
Publication occurs after commit, and socket delivery rechecks the recipient's current authority.
In development source, API publishers and headless workers use the same protected
Session delivery envelope. Each receiving API node qualifies its own local sockets,
including the publishing node, without awaiting a cluster-wide socket census.
An unrelated late peer therefore cannot suppress delivery on responsive nodes.
The envelope carries routing intent; each receiver rechecks current per-credential
access, applies client projection and excludes the sender before delivery.
The local notification owner then applies the recipient's Follow level and shared delivery,
privacy and quiet-hours policy. A committed event is candidacy, not permission to display an
alert. This adds no durable notification feed or reconnect replay, and does not turn a
share/assignment notice into an OS alert.

In the 0.3 development source, receiver Mute is a private routing preference,
not Unfollow or an access change. The Follow service stores exact scopes on the
receiving Account or Session and exposes `session.delivery.mute.set/remove/list`
through the existing Action catalog. A person may read or change only their own
Account preference; Session routes admit the exact receiver. Set/remove are
idempotent, and removing a scope affects only future delivery. The shared policy
read suppresses ordinary and manager Session Follow, protected Pending input
before provider effect, and Account personal remote-alert recipients. In that
last path the Follow row and the source's Work/Inbox/read-state projections stay
unchanged: an alert is delivery, not the underlying relevance fact. A missing
or malformed policy read is unavailable, never an empty mute list. Rule Follow
and Discussion participant delivery must consume this same read at their own
integration boundaries; their source files are not evidence of those consumers
being live yet. There is no released 0.3 Mute UI claim here.

Session- and Run-source Follow observations remain settlement demand while muted; they
do not authorize hydration or a model turn. The final Pending owner validates the
original's current source, receiver and route authority, retains suppression in
the existing discarded input under `session_input_muted`, and settles its existing
relation/rule or Run terminal/revision progress. Permission originals retain their
exact discarded input identity without advancing the Run's terminal cursor.
Removing the mute cannot requeue that original, including
an open question whose Agent-state carrier later changes. Suppressed custody has
no effective delivery and no native acceptance; it cannot prepare a source key
or hydrate source context. It is hidden from the receiver's discarded-input
history, while the sender keeps the muted outcome. A fresh eligible original
after removal uses the ordinary admission path. This is development source
behavior; the composed loaded-runtime and Discussion-participant closure remain
separate validation obligations.

## First-class Home Discussions (development)

The 0.3 development refactor makes a Discussion an independent Home resource, with its
own owner, grants, encryption mode and data key. An optional Session, identity-only Doc
or Task anchor is a source link: it neither grants access nor owns the Discussion's lifecycle.
A Doc anchor reuses the existing `{ ref, revision }` reference with its exact Home; it
carries no passage or grants. The Session People pane is an anchored-list consumer of the
same Discussion owner. Archiving or deleting a source does not archive or delete the
Discussion. The Doc owner still admits quoted-source reads independently.

In development source, deleting a Session anchor or its exact original message does
not prevent inviting a person or existing Session into the surviving Discussion.
The invitation owner checks physical source identity separately from access/key
readiness: a missing original needs no source disclosure or automatic source grant.
A live original still requires the existing source-access, key and complete-audience
checks, including when the inviter can manage the Discussion but cannot read that
source. Discussion grants, target Session control and Discussion-to-Session disclosure
remain required. This invitation exception does not loosen fresh quoted-source
creation or the separate source-active post/read checks.

Protocol owns the contract under `packages/protocol/src/discussions/**`; the server owns
transactions under `apps/server/sources/app/discussions/**`. Human invitations are direct
resource grants, with explicit Team/Group grants evaluated through the same shared grant
policy used by Artifacts. View reads, edit posts, and owner/admin manages the resource.
Self-leave removes only the caller's direct grant; inherited Team/Group access can remain.
The owner must transfer ownership or archive instead of leaving an ownerless resource.

In development source, Account automation may publish with Account authorship into
a Discussion that Account owns. The native Action approval policy still applies;
approval preserves `account_automation` rather than elevating the requester.
This requires the owner's own unscoped credentials; a credential carrying
Session content-disclosure scope cannot use the Account-publisher alternative.
Non-owner automation gains no publishing permission from this path. Session
publishers still require their own participant admission and answer policy; an
Account-owned Discussion does not authorize an uninvited Session to speak.

Selected committed messages use exact selection on the existing `discussion.read`
owner rather than scanning conversation history. Reply ancestors and approved-publication
recovery retain fresh Discussion access and key acquisition; a protected question's
`throughSeq` ceiling is applied before disclosure. Local retry IDs are readable only
for the authenticated author's messages. This is the current undeployed 0.3 contract,
not a compatibility adapter or a second message cache.

In unreleased 0.3 source, signed native `discussion.read` and
`discussion.attachment.read` requests carry the selected Discussion through
the existing Action root. The HTTP preparation owner admits its summary/key read;
attachment decoding also reads the exact committed message and blob reference
before downloading and verifying bytes. That attachment proof does not authorize
a history scan, another Discussion, a roster read or a write. Missing
scope, access or keys stays a typed refusal, never a plaintext fallback.

Clients capture the Home/Account scope with `{serverId, discussionId}`. Create and first
post have separate retry identities, retained across an uncertain response. A raw Discussion
id or a newly selected Home cannot retarget an existing operation or draft.
The shared draft owner uses `discussion/<encoded-id>` and `new-discussion` beneath that
captured Account scope. A Session anchor does not enter either draft address.
An uncertain encrypted create first recovers the original caller's recipient envelope through
the creator-qualified `creationLocalId` lookup, including archived results, before resealing
the original retry. It must not generate another data key. Initial invitations commit with
the resource and first message; recipient key preparation then uses the existing census and
fenced envelope commit owner. A pending key-delivery result is not a second creation.

New Discussion's existing create input carries the selected initial people and concrete
Session/Bot participants. After their ordinary invitation admission, the atomic first
message uses the same addressing classifier as later posts. A typed Session mention must
name an invited participant; it never enrolls one implicitly. That first question is the
original message at sequence/cutoff1, available through the existing participant Follow
relation. An unaddressed invitation creates no default agent request. Retrying create
retains the same first occurrence and does not reset an acknowledged Follow frontier.
This describes the development server seam; selection controls and the composed live
New Discussion journey are not certified by the server tests.

In unreleased 0.3 source, the shared composer reads `discussion.candidates.list`
when a person opens mention selection, including before a passage thread exists.
Selecting an own Session for the first comment carries it through the existing
initial-participant admission; selecting one for a reply uses `discussion.invite`
before posting. Raw server mentions still require membership. `doc.comment.reply`
retains its own Action policy and accepts initial participants only for a new thread;
that sharing operand requires present-user authority.

This remains work in progress, not shipped availability or completed package/live validation.
The current resource contract includes same-Discussion message replies and distinct Account
and Session participant references. Mentions carry that typed identity; labels and ordinary
`@name` text never select an executable Session. The content owner projects Account attention
separately from Session addressing, and encrypted writes bind both routing sets into semantic
retry equality. Automatic delivery, final-answer return and enforcement of an addressed
question's context cutoff still require the composed Follow/Pending/native runtime path;
the typed fields alone do not establish those guarantees. Model participants, second-opinion
entry and public Discussion composer integration remain in progress. Earlier
Session-owned rows and drafts are undeployed 0.3 intermediates: preserve their bytes without
a rekey or draft migration. Plain rows convert; encrypted legacy rows without recipient
envelopes remain unavailable through the existing `keyReadiness: false` state. Old
Session-addressed drafts remain stored and are not read at the new Discussion address.

### Discussion client data and controls

In unreleased 0.3 source, Get a second opinion and Discuss open the shared
[Start pane or sheet](app-shell-panes.md), including in transcript hosts without
pane columns. The inline participant, recipe and Where controls prepare the
existing opinion request. Ask retains the source-disclosure preview and pending
approval; only an accepted result replaces Start with the Discussion. The source
marker reopens that result. Quoted source and the request controller remain
memory-only while their pane lives: after a reload, reopen from the source
answer if the retained request is unavailable.

Starting a Workflow from a Discussion likewise keeps its configuration and
accepted Run in that Details destination. The existing Workflow controller owns
reviewed inputs and pending submission across dismissal; the Discussion adapter
keeps report-back and draft currentness. Ordinary Discussion creation, replies
and prepared text sent to a Session continue through their existing owners.

In unreleased 0.3 source, `DiscussionWaitingApprovalCard` uses the shared
approval prompt and inline decision footer also used in the transcript. A
private Discussion draft offers **Post** and **Decline**; **Review** opens the
full request. The card consumes the same decision owner and does not create a
second publication path.

Development file attachments consume the Session intake, file/folder source model,
draft manager and inline-token owners. A folder retains relative leaf paths and empty
directories; Home stores its private physical leaves under the committed message's
Discussion grants and DEK. Readers do not depend on the sender's Machine. The data
binding supplies immutable payloads plus process-local sources to the existing
create/post/reply client, exact verified reads, and a resource-backed adapter for the
shared file-preview/media owner. Retained bytes and preview lifetimes remain bound
to the captured Home, Account, Discussion, message, key and current access. Composer,
thread-row and open/download composition remains with the Discussion UI integration;
these hooks are not certification of that loaded journey.

The development `discussion.create`, `discussion.post` and `discussion.reply`
Actions also accept `attachmentSources: [{blobId, path}]`. Each source pairs one
leaf of the shared file/folder content payload with an absolute path on the
invoking Machine (`~/` expansion uses the CLI path owner). The authored content
still supplies the immutable size and SHA-256; changed bytes refuse the upload.
Folder paths and empty directories use the existing shared payload, with one
source per file leaf. Source paths remain host operands and never become Home
storage locators or appear in the committed message.

An Agent's actual host validates its active turn witness or original approved
replay before opening these files. It signs the exact Home/Account upload
metadata with its existing installation identity. The upload route checks the
current Machine/Session binding before byte intake and again in the prepared
message transaction, then derives the same Agent producer and applies the same
Discussion access, draft-review and reply-return rules as ordinary publication.
Signed uploads accept Account and paired-daemon terminal bearers through the
same installed-publisher admission as Machine socket publication: current
Machine custody, installation and original Session authority remain required.
Signed Action roots do not substitute for that carrier. For reviewed posts,
the mutation owner also requires a non-deleted built-in approval Artifact in
the publishing Account and producer Session; the daemon validates its private
decision and exact approved Discussion input before signing the upload.
An external credential alone supplies neither this host attestation nor upload
authority. No separate attachment writer, credential or staging store is added.

Reviewed post/reply preparation uses the deciding person's Account for current
resource and key reads, including when the decision arrives through the signed
daemon ingress. That ingress must carry the matching Artifact's signed `approve`
admission and the original Home, Account and Machine. The original Session's HTTP
carrier remains immutable approval provenance; it is withdrawn from these replay
reads so a retired turn cannot block the reviewed upload. The host still reopens
the executing approval and compares the exact content, blob identities and file
sources before reading bytes. This does not admit an unapproved or unrelated
external credential.

An attachment is not addressing. For an admitted Follow original, final normal/steer
preparation rereads only the exact question and its admitted reply ancestors through
the protected cutoff. It materializes files and folder trees on the receiving Machine
through the target Session's existing encrypted upload, directory finalization and
issued-handle owner. Empty directories survive without invented file bytes. Existing
Session native-image verification and file projection then feed the Agent. Pending
source/disclosure admission is rechecked before and after preparation; unavailable
bytes, keys or target issuance hold the input rather than dispatching text alone.
Definition capture that cannot retain an attached input uses its existing
`unsupported_content` refusal instead of silently capturing an executable text-only
Workflow.

#### Per-Discussion check-in and composer recipients (r0.3f development)

The existing Discussion resource now carries optional operational `settingsV1`.
Its closed shape is `coordination.autonomousCheckIn.afterTurns`, using the shared
autonomous-exchange setting: a positive integer overrides the Account interval,
`null` never pauses, and an absent override inherits the Account choice. These
settings contain no message content or key material. An additive nullable JSON
column leaves existing Discussions inheriting; no applied migration is rewritten.
`discussion.settings.get` reads with current Discussion access, while
`discussion.settings.set` requires its owner/admin authority and the ordinary
Action HTTP admission. Empty settings restore inheritance. CLI commands are
`discussions settings get <discussionId>` and `discussions settings set
<discussionId> --settings <json>`; MCP/Voice use the catalog's
`discussion_settings_get` / `discussion_settings_set` bindings. The canonical
approval policy keeps in-app reversible changes direct and agent approval intact.

The production Session client binds N1's
`readDiscussionAutonomousCheckIn({serverId,discussionId})` to that captured-Account
authorized read. `undefined` means inheritance, `{afterTurns:null}` means Never,
and `null` means unavailable: the existing check-in owner holds rather than
silently inheriting. A different Home, refused read or malformed known value is
unavailable, not inheritance. No counter, mode or reducer lives in Discussion
settings. UI data comes from `useDiscussionSettings`; `dontPause()`,
`setOverride(value)` and `inherit()` feed the Discussion menu composition.

The private Discussion draft's `recipients` field stores typed admitted Account
or concrete Session references, not labels or a second roster. The shared
`RecipientMultiSelectModel` and `useDiscussionRecipientSelection` supply controlled
choices to the existing Send to chip. Bound model participants use their backing
Session; unbound model slots cannot become routing targets. The selection survives
draft reload and accepted-send clearing until explicitly changed. At send time,
`useDiscussionRecipientSelection.prepareContent` intersects those defaults with the
admitted roster before delegating to `useDiscussionDraft.prepareContent`. The model's
`removedRecipients` identifies dropped selections for visible composition. A missing
roster is not a removal: preparation returns `null` when Send-to defaults need that
roster, retaining the draft until it is available. Explicit mentions and Reply still
override the defaults through the existing content owner. Default typed mentions
are supplied only when the existing content has no explicit participant mention
and there is no Reply target.
Any Reply (including a Doc or Task target) wins. The existing content/addressing
owner remains the only parser, and admission still checks live membership.
This is data-layer behavior; the visible menu/chip and live journey belong to the
Discussion composition lane and are not certified by these owner tests.

Route `messageId` only acquires, scrolls to and highlights a message. Deliberate
Reply intent belongs to the same private V2 draft as its text: `replyTarget` and
`setReplyTarget(target | null)` are exposed by `useDiscussionDraft`. The composition
lane binds a message's Reply action and its clearable replying-to control to that
setter. A post captures this target in the existing retry intent; observed success
clears only the captured reply field, preserving a newer choice made while sending.
Failed or uncertain sends retain their original target. Draft reload retains the
explicit choice independently of route focus. The server still resolves and admits
the parent inside the addressed Discussion, including a parent outside the loaded
client page.

After observing a committed create, `NewDiscussion.finish` clears only the still-current
submitted fields, retires the attempt and persists local draft custody before `onCreated`
replaces the New route with the captured-Home Discussion route. Remote draft synchronization
continues through the existing synchronizer in the background; its acknowledgement does not
hold navigation. This describes current source, not completed live navigation validation.

The canonical `discussion.create`, `discussion.invite`, `discussion.access.grants.set`,
`discussion.participant.policy.set` and `discussion.participant.remove` specs use direct-user
UI confirmation policy. These reversible in-app operations avoid a redundant confirmation
unless the person's explicit Action setting requires one. Ownership transfer retains
confirmation and explains that the new owner's help is needed to transfer ownership back.
Present-user authority, the Agent approval request path and danger classifications remain
enforced by the same Action owner.

`createDiscussionClient(...).setParticipantPolicy` and the shared
`DiscussionRepository.setParticipantPolicy` consume the canonical
`discussion.participant.policy.set` Action for an exact Session or model slot.
They retain the captured Home/Account executor's authority and approval outcomes;
an approval request is not a completed policy change. After success, callers refresh
`repository.participants(discussionId)` for the current roster. Delivery, watch and
private draft-review enforcement remain with their existing runtime owners.

The development Discussion page consumes `useDiscussionParticipantManagement` for
its captured-Account roster and participant operations. It retains the selected
model slot and exact operation on explicit retry; approval-pending and unknown
outcomes never acknowledge a successful invitation or policy change. Owner Leave
offers transfer to an existing invitee, revalidated by the transfer Action, or
archive. Leave follows only an acknowledged transfer to the selected new owner;
if its response is then lost, retry repeats Leave alone. Archive remains an
archive outcome, and a successful Leave reports any inherited access that remains.
Cancel closes an unsubmitted resolution; it cannot cancel an unresolved effect or
durable approval request through local state.
Opening an agent uses its captured Home/Session address. Model birth, stop and
archive continue through the ordinary Session lifecycle in the Action executor.
This data binding does not establish completion of the rendered management controls.

The management view-model derives `modelParticipants` from that roster and its
single current invite result, without a separate birth-status store. A bound
Session is `started`; only a matching active attempt is `starting`. A witnessed
failure retains its typed start reason. An unobserved, pending or uncertain
binding is `unknown`, never indefinitely starting just because its Session id is
null. Account, Discussion and demand retirement discard local attempt facts.
Rows expose the selected model and Machine label through the existing catalog
and inventory naming owners. Explicit row retry keeps its saved launch and slot;
working, approval-pending and typed nonretryable outcomes do not offer retry.

The Invite data binding, `useDiscussionInviteCandidates`, reads people from the existing
Home/Team collaboration directory and existing Sessions/Bots from the exact-Home Session
list. Model choices come from the ordinary executable-participant picker. The projection
excludes already admitted people and backing Sessions; candidate labels and readiness are
display facts, not permission to invite, start work or disclose content. The hook runs only
when selection is demanded and retires with its captured Account lifetime.

In 0.3 development source, that same inventory carries the admitted Session Bot marker
into the shared Invite/Ask presenter. Bots follow ordinary Sessions and use the Bot chip;
Ask retains its model-first ordering. Promotion and demotion update the candidate's display
identity without a second inventory or per-row read. A Bot still selects the same concrete
Session through `discussion.invite`; its marker changes neither access nor source-disclosure
admission. The existing second-opinion preview defaults foreign runtime Accounts to quote-only
and own Sessions/model choices to source read, with disclosure still confirmed on Ask.

Session invite/reviewer candidates retain the ordinary Session display `label` and
expose `titleReadable`, derived by the existing Home-qualified
`readableSessionDisplayTitle` owner. A locked placeholder is not a readable title;
the flag lets the presenting surface group or hide unreadable choices without
comparing translated strings or retaining a second title store. It is display
availability, never permission to invite or disclose content.

Discussion speakers, committed Session mentions, roster rows and invite candidates
reuse that Home-qualified Session title owner. In current development source,
an admitted Account-owner name remains available while shared Session-key
hydration is deferred; an opened but unnamed owner view uses the canonical
untitled fallback. A different Home, recipient-only projection or unopenable
owner envelope cannot supply the private name. This does not open shared Session
content, fetch a second title inventory or grant Discussion viewers Session access.

Operational `discussion.invite` accepts a SessionTarget in `participant.sessionId`;
`discussion.create` accepts independently-one SessionTarget operands in Session entries
of `participants`. The shared Action SessionTarget front door resolves these before
approval and storage. A `discussion:` selector reads that Home's authorized current
executable roster, including bound model Sessions, without requiring a fabricated source
Session. Unbound model selections are not executable participants. A model launch's saved
client Home label is not membership authority; the admitted roster and concrete Session
admission remain authoritative.

An initial invitation array creates one Discussion and first message, not one resource
per target. Approval custody retains the concrete targets and their participant slots;
replay does not enumerate the selector again. The UI repository retains those same concrete
participants in its existing create intent for uncertain-response retries. Removal and
answer-policy operands remain exact participant identities. Selection neither supplies a
grant nor makes a runtime's Discussion key ready: initial Session admission reuses the
existing invitation owner inside the create transaction, and a refusal rolls back the
resource, initial grants, bindings and first post. Account recipient-envelope preparation
remains separate from executable Session admission.

A refused initial audience fails only that proposed creation, retaining its mutation
and draft recovery plus unrelated loaded Discussions. A refused creation-local-id
reconciliation read remains uncertain; it cannot prove that the whole Home was revoked.
Known-resource refusal remains resource-scoped, and actual Account retirement uses the
existing Account lifetime owner. The separate Doc-comment delegation has no configurable
initial-audience operand and rejects nonempty participants before writing, rather than
silently discarding them.

The ordinary Discussion `@` picker uses its current admitted roster: existing
Sessions/Bots, bound model backing Sessions, and invited model slots whose Session
has not started yet. Cached titles supply display only and cannot admit an outsider.
An unstarted model is named by the existing Agent/model/Machine display owner;
selecting it retains its real slot reference in the existing Discussion draft and
does not launch anything. On explicit Send, the Discussion owner rereads current
membership and resolves that exact slot through the existing invitation/rejoin
and ordinary Session-birth path, preserving the saved launch and answer policy.
An already-bound slot uses its real Session without another start. Only confirmed
backing identities become the existing typed Session mentions in posted content;
pending, approval or failed birth leaves the question drafted rather than posting
a fabricated Session reference. The server still rechecks membership at commit,
and invited idle/offline Sessions remain addressable.

Summary `latestMessage.content` carries the original stored envelope, not a server-readable
preview copy. `createDiscussionActionAdapter` opens it through the same resource key and
stored-content reader as the title and message history. Locked or mode-mismatched envelope
content becomes `null` with an incomplete list result; older summaries that omitted the
envelope retain that absence. Neither case becomes guessed plaintext. The server's
`projectDiscussionsForViewerInTx` resolves and admits any independent Doc source before
including the envelope. Revoked or deleted Doc sources leave authorized Discussion metadata
readable while omitting that message body; a Discussion grant alone cannot disclose it.

Development summaries also carry write-time, server-visible non-content facts:
`roundOutcomeV1` identifies the latest admitted Fresh opinions or Answer + review Run,
with its answer count, synthesis presence and settled state. Workflow admission and
accepted progress writes maintain it; a superseded Run cannot overwrite a newer round.
Fresh-opinion counts become known at the existing outcomes projection, not on each
individual answer arrival. `openCommentCount` counts passage roots matching a Doc anchor;
ordinary replies and same-identity retries do not increment it. Archive projects zero,
and restore exposes the retained count. `doc.read` consumes the same count through its
existing admitted summary pages. Unknown or missing count facts remain unavailable.
These fields contain no title, question, answer or other user text, and list reads
select them with the existing Discussion page without per-row reads.

In development source, executable reads also retain the destination Session from the
verified signed Session Action original or restricted runtime principal. Before returning
a Doc root or inherited reply, the reader applies the existing source→destination policy
to that Session's current full audience, not just the tool-calling Account. The same
read-time admission applies to quoted Session-message anchors. A safe invitation is not
lasting disclosure permission if the receiver later gains another reader. A refused
executable source read returns the existing access error before opened content reaches
the Session; authorized Discussion metadata remains available without source-bearing
latest content. Ordinary human history paging retains its independent row-withholding behavior.

CLI and UI adapters share Protocol's `hasProtectedDiscussionActionContextV1` and withhold
this preview as `null` in an actual protected addressed-Agent context, including summary
results from mutations, and mark list results incomplete.
Current summaries are not cutoff snapshots; U2's admitted `discussion.read` remains the bounded
content port for that turn.

`useDiscussionListSearch` searches the captured Account's already-opened Discussion
titles, participant display names and available source labels. A nonempty query demands
`DiscussionRepository.loadCompleteList` for the selected active or archived corpus,
continuing the ordinary list's retained cursor rather than creating a second list or a
server content query. The Home column omits `anchorSessionId`; an anchored pane may
explicitly supply it. Existing presentation filters apply to the resulting items.
Message bodies, opaque ids and ciphertext are not search inputs. Partial page/read failures
retain received matches and expose the repository's error and completeness state.

The returned `DiscussionListSearchSnapshot.sourceLabelsUnavailable` is an active-query
availability fact: a referenced Session/qualified Doc has no usable opened label, or a
Task label producer is absent. It triggers neither fetching nor loading and does not make
the corpus incomplete. When the query is empty, the flag is false because source-label
availability is not demanded. Source labels reuse scoped Session naming and decrypted
Account Artifact headers; a foreign Home or Account's same raw id cannot supply a label.

The data binding `useDiscussionListRows` exposes transient attention facts through
`buildDiscussionListAttention`, consuming the Inbox owner's strict approval-Artifact reader
and the existing private mention cursor. `attentionReason` is `draft_waiting`, then
`approval_pending`, then `mentioned`, or `null`; `approvalArtifactIds` link the existing requests. An unloaded or
different Home/Account Artifact inventory sets `approvalAttentionAvailable: false`, rather
than proving no approval exists. This creates no second Inbox store or private draft-body
copy. An open request carrying the private draft-review owner's immutable
`discussionDraftReview: true` marker projects `draft_waiting`, ahead of ordinary approval
and mention attention. Settled, unhydrated, invalid or foreign-Account/Home requests do not
contribute that reason. This does not infer review purpose from the current roster policy.
This projection is ready for page composition; its presence does not
establish that every rendered list already consumes it.

Native Session permissions are separate from those approval Artifacts. The shared
Session pending-request owner reconciles opened `agentState.requests` with exact
completions and stamped summary observations: an unstamped zero counter cannot
erase a live native permission; a newer stamped zero or matching terminal request
can retire it. In current 0.3 development, `useSessionAwareness(sessionId, serverId,
undefined, {accountLifetime, enabled})` exposes `pendingRequests`,
`oldestPendingRequest` and `requestHref` alongside `awareness`. The captured
Home/Account must match the current Session read scope; retirement, disabled
observation and unreadable content withdraw request details. A Discussion may
mount that existing hook for its admitted participant Session, not derive another
permission counter or acquire approval authority from membership. Its Open request
control can open `requestHref` and pass the exact request id/source to the existing
`setPendingNavigationLanding` owner for Session hydration and reveal. This data
contract does not establish that Discussion composition already renders the control.

The explicit scoped awareness binding also acquires a never-opened Session through
`useSessionContentDemand` in viewport mode. That existing demand owner retains the
qualified Session as a visible metadata consumer and shares Sync's exact snapshot
hydration with `hydrateMessages: false`; it neither opens a transcript nor marks
the Session as viewed. Requests and settlements continue through the ordinary
Session store/socket projection. Disabling the leaf or retiring its Account
withdraws that demand, and the existing surface-reset version reacquires it after
a Home reset. Unscoped Summary/transcript callers keep their host-owned acquisition.

Discussion transcript remount continuity uses the shared `TranscriptListShell`
renderer through `viewportRetention={repository}`. The scoped repository lifetime
and qualified Discussion data key retain only a keyed row's viewport offset or
tail-follow intent; the renderer's existing entry-placement/held-anchor owner
restores it across Back/Forward, message arrival and viewport changes. This is
ephemeral navigation placement, not a second message store or synced read cursor.
Native physical placement is captured at the existing drag/momentum terminal
callbacks and exit, not by measuring the buffered window on every scroll frame.
Main Session transcripts retain their existing durable entry lifecycle.

In current 0.3 development, UI and CLI `approval.request.list` use the same strict
Account Artifact header/body scan on the captured Home. The requested matching-count
limit is not an exhaustive approval census. A private Discussion draft is an existing
V2 approval Artifact, not a public Discussion message or a separate draft store;
Inbox opens that Artifact at `/inbox/approvals/<artifactId>?serverId=<Home identity>`.

Cold Inbox content instead demands the canonical Discussion repository's batched attention
read. In current 0.3 development, it opens original envelopes with the Discussion's own
codec and consumes the server's current classification, without loading each thread or
copying live messages into notice Artifacts. Open Doc proposals that this person may decide
remain in Needs you after mark-read and leave that view when their C5 disposition settles.
Mentions and informational comments retain the private read cursor. Discussion changes and,
while attention is demanded, Doc Artifact changes refresh that same projection; an older
in-flight page cannot restore a proposal after a newer owner refresh. Cached, unmounted
threads are not hydrated merely because the Inbox is open. Account retirement and explicit
read refusal withdraw the corresponding projection.

Summary `lastReadSeq` is the viewing Account's private, nullable cursor, not a participant
read receipt. Grant entry can initialize that cursor at the current message sequence;
this baseline does not establish that the person read those messages. The admitted
participant roster and human presence projection expose no peer read frontier. Presence
can describe viewers and typing, but cannot supply a “read up to” marker for another person.

Participant profile display uses `useDiscussionParticipantProfiles` over the admitted roster,
batching the existing people API under the captured Home/Account. Its required `accountLifetime`
argument fences reads, late responses and display: absent, retired or scope-mismatched
lifetimes return no actors. Its `owner` and `accounts`
are display actors, not additional grants. The shared `resolveAccountActorPresentation`
qualifies “You” and avatar identity by Home and Account; a matching raw Account id in another
Home is not the viewer.

Development summaries also carry optional `participantAccounts` and
`participantSessionIds` display facts, batched with the existing list projection.
The people are the owner, explicit Account invitees, and Accounts already disclosed
by this Discussion's messages as authors or qualified requesters. Team and Group
grants do not expand into private member identities, so a member who has never
participated remains absent.
Agent references name active bound Sessions and use the existing admitted Session
presentation. Sanitized Account profiles come from the shared Account actor
projector. Omission means the producer has not supplied roster display facts;
recent-author metadata is not a second participant inventory. These facts grant
no additional access. An explicit invitee who never participated disappears after
removal; a disclosed author or requester remains available as a historical actor.

Historical Discussion message and requester actors use that same projector with
the Discussion access owner's current audience. The optional `accessibility`
fact is `former` when the historical Account is no longer in that audience even
if its neutral profile remains readable; the shared Account presenter then uses
the existing Former member label. It is display-only and cannot admit a read or
mutation. Rejoining through a Team or Group grant changes that disclosed actor back
to `current`; it does not reveal other members of the collective grant.

### Public Actions and composer integration

`packages/protocol/src/discussions/actionIds.ts` and the canonical Action specs own the
operation inventory. The Plugin SDK derives its Discussion input/result maps through the
existing generator; `ActionsService.execute` returns either the domain result or the ordinary
approval-request result. A plugin must distinguish those before treating an operation as
complete. Human-owned operations retain present-user authority even when a plugin or Agent
can request their review.

The development `discussion.candidates.list` Action composes the existing collaboration
people search and accessible Session pager. Each source retains its native cursor; Session
choices require the current access projection's `submitAgentInput` capability. Supplying an
existing Discussion also excludes its admitted roster. The model source projects supplied
ordinary authoring selections/readiness only, not a model inventory or setup probe. Missing
readiness stays unknown, and listing never invites, launches or grants access. The mounted
Invite hook and public Action share the same eligibility/exclusion projection; writes still
revalidate at their canonical owners.

The shared executable picker uses the ordinary launch-visibility and Machine-action
ordering owners for model setup targets: removed/replaced targets are omitted, available
Machines lead, and offline/unknown targets remain selectable afterward with their readiness
cause. This does not reorder existing Session reviewers or probe every Session on opening.

The standalone API-token SDK derives `actions.discussion.*` from `PUBLIC_ACTION_IDS`, a
narrower credential-admitted projection. It does not expose present-user create, rename,
archive, restore, read-state, Leave or ownership-transfer operations. An API token's approval
scope does not make it a present person or grant the Plugin SDK's request path. Neither SDK
registration nor generated declarations prove the composed runtime journey.

The public Discussion composer extends the existing Composer reference, host bridge and
mounted lifecycle owners; it must not alias the optional Session anchor or introduce another
draft store. This integration and its external-plugin fixture remain in progress. The
canonical author guide is [Composer](../apps/docs/content/docs/plugins/guides/composer.mdx).

Current source shares `HappierThreadMessage` and `HappierReplyQuote` from
`packages/plugin-ui/src/presentation/content/**` between core and external
plugin adapters. The Doc passage adapter consumes already-opened C5 content;
an unavailable source carries no cached quote text or navigation callback.
The passage form's filled box belongs to `HappierReplyQuote` itself, so core's
second-opinion and annotation passages and plugin passages share one anatomy.
`HappierAccountByline` (`packages/plugin-ui/src/presentation/account/**`) is the
one transcript byline presenter: core's `SessionMessageAccountByline` binds its
visibility rule, localized name and avatar to it, and the public `AccountByline`
localizes a classified label (Protocol `classifyAccountActorLabelV1` kinds) through
the host-reserved `happier.plugin-ui.accountActor.*` strings. Classification stays
in Protocol; visibility, approval and currentness stay with the app.
Discussion controls, regions and reference declarations consume the Account app-shell declaration union,
Administration's selected per-plugin execution origin and the daemon's existing
Composer renderer catalog. They do not infer an execution Machine from the
Discussion's optional Session anchor. Package and loaded-runtime acceptance
remain separate from the source contract.
In development source, a declared plugin reference is searched on that selected
origin when the picker queries it. The shared Composer document keeps its typed
identity through public apply, Send and reads as an inert `reference` content
part. Only closed Account/Session `mention` parts enter participant addressing;
a reference's label or plugin identity cannot select an executable receiver.
Addressed input carries those references through the existing Pending structured
input metadata so the ordinary dispatch owner can resolve current plugin context.
Development Task anchors and reply targets carry `{ kind: 'task', entry }`, using
the canonical `TriageEntryRefV1Schema` from Protocol's `tasks/entryRefV1` leaf.
The reference grants no Task access and selects no configured source connection.
Task reads and navigation remain with the Tasks source owner; an unavailable source
does not remove the private Discussion or its authored replies. `discussion.reply`
publishes only into the Discussion, never into a tracker's provider comments.
The retained entry identity alone is not a configured-source read target. Triage's
current get operation requires an explicit configured instance; core must not
guess one from the entry id or choose the first matching connection. Until the
source owner supplies that qualified read/open handoff, Task headers and replies
keep a shared unavailable source/quote state without a fabricated title or link.

A retained Session anchor acquires its authorized metadata on the Discussion's
captured Home even when that Session has never been opened. A pending read shows
loading; a deleted or archived Session, or a denied or unreadable source title,
remains unavailable without a navigation callback. An available anchor
returns to its exact committed message, when present, through the shared
Home-qualified Session route. Activation rechecks the captured Account lifetime
and current source readability/archive eligibility rather than spending a stale rendered link.

### Second-opinion composition (development integration)

`discussion.second_opinion.start` composes the existing source readers, grants,
Discussion creation and addressed-post Actions. A content-free server preview
uses the shared pairwise disclosure owner and current source/key/audience facts;
the key-holding client opens the exact committed assistant answer or Doc passage
through its ordinary reader. Missing or mode-mismatched E2EE material is an
error, never a plaintext or quote-only fallback. Non-Voice source reads do not
inherit Voice's transcript-sharing preference.

For a historical owner-readable E2EE Session with no recipient-envelope tuple,
preview permits the same Account-key read attempt as ordinary Session hydration.
It still requires current Account key readiness and a successful exact transcript
opening; a present invalid envelope, non-owner access or mode mismatch cannot use
that compatibility path. Notification previews retain their stricter key rule.

Session sources select their known committed `messageId` through the existing semantic
`session.transcript.get` owner, rather than paging transcript bodies. Preview and Ask each
perform their own admitted read; Ask never reuses the preview's quote. The selected result
must be a complete assistant text message on the captured Home. Missing, filtered,
truncated or unavailable content still refuses composition without a fallback scan.

Voice proposes the ordinary human approval rather than acquiring human
authority from a confirmation waiver. Approved preview reads retain the
verified proposal's Voice disclosure policy even when the person approves in
the app. Redacted Voice text is marked incomplete and cannot become an exact
source quote. An Agent-originated composed root retains the original Session's
exact-daemon publication custody, rather than becoming a human-authored post.
For a selected model on another Machine, the original reviewed root and exact
public spawn child remain bound together. The selected receiver countersigns
the actual Session-create body with its existing installation key; the ordinary
create transaction rechecks the current machines and reserved participant slot.
The root token alone never authorizes model birth.

Preview writes no grants or messages. Explicit Ask confirms the current human
Discussion audience, publishing Agent Session when present, reviewer runtime and
source access before any mutation. Own Sessions and models default to source
read; another Account's Session defaults to quote-only, which still requires
disclosure admission. Confirmed read grants use the ordinary whole-Session or
Artifact view grant and remain until revoked through that resource's owner;
they are not temporary Discussion-scoped grants.

The shared Action policy classifies a valid `intent: preview` as read-only for
default danger confirmation; `intent: ask` remains dangerous. Preview still
returns source text to its caller, so it retains present-user authority, source
admission and Voice privacy checks. Explicit Require settings still apply, and
an automated CLI call cannot claim present-user authority. The sheet passes
refusal or deferred-approval codes to the shared diagnostic state rather than
turning an approval request into a successful preview.

Reviewer selection consumes the shared executable-participant picker and its
readiness/setup owners. A model choice retains its reviewed launch and participant
slot through preview, Ask and retry; selecting or previewing it does not create a
Session. Late setup from a retired Home/Account must not become a reviewer choice.

One reviewer receives the ordinary U2 addressed question after an unaddressed
anchored quote. Create, quote and question keep distinct retained retry ids;
uncertain responses retry those identities and current admission, not a new
Discussion or model slot. In current development source, multiple reviewers use
`builtin:fresh-opinions` through ordinary `workflow.run.start`, with the committed
Discussion question as the origin. Ask carries the selected Machine/folder in the
`project` operand; missing placement is refused before any grant or creation.
Retry retains that placement and the existing question identities. The controller
and optional committed-answer opener are data bindings; rendered L7 composition
and loaded desktop/phone validation are
still integration work, not released availability. The separate background
Agent Second opinion role is unchanged.

### Discussion Pattern bindings (development integration)

Discussion Run uses the existing Pattern picker, composer and `workflow.run.start`
owner. Its Discussion origin names a committed addressing message; admission
resolves and freezes that message's actual sequence, not a caller-authored
cutoff. A draft is posted through the ordinary Discussion submit/rejoin owner
only on explicit Run. Opening the picker or reviewing inputs posts nothing.
Uncertain post and Run-start responses retain their respective original ids.
The submitted question is the reviewed main text input, committed as ordinary
unaddressed Discussion content; it must not also start the separate Ask fanout.

The Workflow input owner reads Discussion context through the authorized C3
paging and encryption owners. Addressing context stays at the frozen question;
`discussion_context` with scope `so_far` captures the current readable frontier
once in the invocation's existing materialized input. Recovery reuses that input
rather than widening it with later replies. Missing keys or revoked access do
not become plaintext or an empty-history fallback.

Accepted Session-executed leaf output publishes through the existing trusted Discussion publisher
after the exact invocation result is durable. The original input, accepted turn,
Run, invocation, attempt and executing Session must agree. The sole append
transaction records the canonical C2 `publicationRef` for a published answer and settles
the original; recovery rejoins that identity rather than executing the Agent or
posting a generic final answer again. Structural Workflow containers do not
publish duplicate answer bodies. Private-draft review remains with its existing
Discussion approval owner; accepting a Workflow result does not release a held draft.
Selected model participant slots use C3's
ordinary reservation and Session birth; implicit Workflow execution leaves keep
their existing Run-step ownership.
Ordinary admitted replies use the existing default approval policy; explicit
Require settings still apply. A known publication refusal becomes actionable
Run attention. Retrying its structural root reuses the completed leaf and input
instead of executing the Agent again; an unknown transport result stays uncertain.
Current Discussion reply delivery requires Session-executed steps. A
`detached_run` leaf has no consumed C2 Discussion-result producer and is refused
before start effects; ordinary non-Discussion detached runs are unchanged.
Existing participant Sessions must also be supported by the Run Account's
current execution authority; a shared Home is not cross-Account delegation.

Discussion timeline bindings query the existing managed Run list/store by
Discussion origin, with the captured Home and Account lifetime. Header and
controls use managed lifecycle/progress and the existing Run detail actions,
not native Session Workflow activity. Another round uses the same accepted-start
preparation and `workflow.run.start` replay intent, whose owner supplies prior
results. Discussion access does not grant access to private Run content.

These are data/hooks for the Discussion composition owner, not a claim that the
visible Run header or controls have been mounted or validated in a loaded app.
Fresh opinions uses the same ordinary Workflow admission and source-disclosure checks.
`workflow.definition.capture` is not registered, so Save as pattern reports
`workflow_definition_capture_unavailable`; it does not create a local graph,
save through a different Action or run automatically.

### Model participant birth (development integration)

A model choice uses the ordinary Session launch-selection schema, not a
Discussion-local model runner. The executable picker distinguishes that launch
from a Home-qualified existing Session; a Bot remains its actual Session
identity. Human invitations remain grants, outside this executable selection.

The existing participant owner reserves a stable `participantSlotId` and launch
selection. An unresolved start retries that slot rather than selecting another
creation identity. An unstarted slot selected in the Discussion composer is also
resolved through that same owner on explicit Ask/Send, never through a composer-local
launcher; editing or opening/selecting a mention alone does not start it. Ordinary Session birth carries the strict `discussion`
origin and exact Discussion/slot correspondence; the server validates the
current reservation, creator and launch before committing its backing Session.
An authenticated creation-tag retry also revalidates current participation
before acknowledging or restoring the same Session; immutable identity alone
does not prove that a removed participant is still admitted.
This provenance is retained independently of a Discussion foreign-key cascade.
The reference alone is not authority to create, disclose context or control a
Session. Ordinary Agent-start, Machine, permission and resource-disclosure
admission remain authoritative, and invitation supplies no initial prompt or
triggers. Fresh native ingress requires the explicit birth facts to match any
retained Discussion creation recipe; it never invents omitted authority.
Client transport sends the admitted public Session input and resolved creation
key, not expanded host launch arguments. Derived `originKind` and the private
original-launch sidecar stay out of that public request; the receiving ordinary
Session owner re-admits the public selection and establishes the birth facts.

Removal distinguishes a Discussion-owned backing Session from an existing
Session that was merely invited. The former uses ordinary Session lifecycle
Actions; the latter detaches without archiving. Owned provenance and historical
messages remain available to reconcile a lost removal response. Discussion
administration does not grant control of another Account's Session. Readiness
and start uncertainty are separate from authorization and must remain visible.
After ordinary Unarchive, an explicit existing-Session invitation can readmit a
removed child under the current input, disclosure and key-readiness checks.
Unarchive alone restores neither membership nor delivery. Readmission preserves
the original model slot, launch, creator and Session ownership; it does not turn
later owned removal into detach-only or allocate another Session. The new
invitation uses its requested answer policy, or the ordinary when-addressed
default, and the existing Follow owner starts at the current message sequence.
Withdrawn older asks stay withdrawn. A blind replay of a removed model-selection
request is still refused while that slot remains removed.
The existing stop owner also confirms an already-stopped Session when the exact
daemon finds no runtime and a fresh authorized Home read reports it inactive.
The UI producer preserves that canonical `already_stopped` result alongside its
legacy presentation fields, so owned removal can continue to ordinary archive.
Offline appearance alone, a cached inactive row or an uncertain acknowledgement
does not supply that proof; the Discussion composition adds no liveness reader.
An archive endpoint refusal remains a failed ordinary Action, not a completed
owned removal merely because its participant binding was already detached.
Retry keeps the same owned Session descriptor and re-enters that lifecycle.
The composed answer, removal, package and loaded-runtime journeys are still
being integrated; schema presence does not establish completion or release
availability.

### Discussion provenance

Agent provenance on a discussion message is decided once, at the mutation writer
(`admitProducerInTx` in `apps/server/sources/app/discussions/mutations.ts`). A present-user
post has no producer. Runtime-produced posts require a current participant binding whose Session
belongs to the authenticated execution Account, or the existing protected Workflow-original
return admission; trusted provenance must agree with that retained execution origin.
`DiscussionProducerV1` is display metadata, never caller-selected authority. Human invitations
remain grants; executable participation binds an existing Session separately and requires
runtime-control and pairwise disclosure admission. Neither invitation starts a turn.

For a protected reply return, the append writer reopens the exact original reply progress
and stamps its content-free `actionRequestAttributionV1` beside `producerV1.replyReturn`.
Neither authored input nor the reply target supplies this cause. Retained producers use
the tolerant stored reader; current writes and known fields remain strict. Message,
latest-row and mutation responses project `requesterAccountActor` through the same sanitized
Account display projector used by transcript authors and Team rosters, only for a requester
on this Home. This needs no friendship, profile store or expanded Team roster disclosure.
An autonomous/unknown or other-Home requester has no local Account-name projection. These
facts describe who asked and who posted; they do not prove the Account or credential used
by a separate outward operation. Reply custody without that exact operation actor leaves
the result's “using” identity unknown.

In development source, a committed explicit reply is an `answer`, including when
the person approves its private draft after the native turn finishes with an empty
or failed final. The append transaction records that same answer/publication on
the original input; later turn projection cannot downgrade it or create another
return. The trusted publisher preserves its verified `terminalReturn` distinction
only for a host final/result fallback, whose genuine pass, failure, cancellation
or no-result outcome remains typed. Authored Action/RPC inputs cannot select that
host classification. This corrects new publications, not retained historical rows.

In development source, CLI input attribution and Discussion reply-return markers
use the canonical Home identity from the existing feature observation of their
bound server origin. A local CLI routing profile is not a portable Home identity.
Unavailable observations retain retryable input custody; a ready legacy Home
without the capability can still deliver ordinary input without fabricating
attribution. Previously settled protected attribution is preserved, not relabelled;
this correction does not rewrite historical messages or signed approvals.

Account-placed agent Actions use the existing authenticated Discussion publisher. Active
Agent publication retains the current Session publisher and its admission witness. In
development source, a person's approved post/reply instead reopens the actual executing
approval Artifact and immutable Session origin through that same host verifier, then sends
the reviewed body on the owning installed Machine's socket. The server rechecks retained
Session/Machine custody, original input and current participant/reviewer access before the
same append writer runs. This does not start or resume the receiver: an approved private
draft can be posted after its native process exits. Atomic creation retains the current
Session publisher. A bare approval reference is not an approval claim. Terminal fallback
instead reopens the protected original, resolves its exact
result or typed outcome, and checks the resource-decoded payload against that projection;
an original-return tuple alone cannot authorize caller-authored text. None of these paths
introduces another credential or uses human HTTP posting to invent Agent provenance. The
Discussion's own key remains the content key, independent of an optional source Session.

In current development source, the canonical `discussion.reply` Action declares direct
Agent tool exposure as `discussion_reply`, through the same shared Action/MCP projection.
It is not injected separately for addressed turns or particular Agents. Explicit Action
exposure/disable settings and the Home conversations feature still govern availability;
direct visibility does not waive dangerous-post approval, private draft review, original
custody, cutoff or publisher admission. Generic Action discovery/execution remains available
when the caller deliberately selects discoverable-only exposure.

Development-source publisher diagnostics retain typed refusal codes and identify the
content-free approval, original-custody, exact-result or publication stage in the existing
correlated RPC completion record. A thrown transient prerequisite read is unavailable,
not proof that posting was denied; it does not authorize publication. Definitive refusals
remain closed, and neither diagnostic records private text or changes approval authority.

Human-required approved creation retains the canonical present-user ingress check at the
publisher: an Account-writable approval Artifact cannot establish that authority by itself.
Omitted mutation retry IDs derive from that Artifact's existing identity, with distinct
creation, first-message and post keys. Once publication starts, an unusable acknowledgement
remains an unknown outcome rather than a definitive denial; reconciliation uses the same key.

In current development source, atomic Agent creation uses that same trusted publisher
for creation and the first post in one transaction. It retains ordinary create approval
and does not implicitly enroll its producer as a participant. C2's original input custody
now carries a Discussion return destination; the append writer validates its protected
original-input/accepted-turn correlation before treating a reply as an informational
return rather than a new ask. Explicit typed Session mentions still create new asks.
The composed Follow/Pending/cutoff and automatic return path is still being integrated;
these owner-level changes are not a claim of native continuation independence or a
completed live Discussion-answer journey.

### Addressed participant input and return (development integration)

The participant's C1 Follow edge retains the receiver Account's Discussion
receive policy at invitation time; later creation-default edits do not rewrite
that edge. Observation carries this persisted policy and the committed original
event into the shared C1 resolver. An addressed question is needs-you/decision
(wait); an ambient watch original is person-wrote for a human publication or
message for ordinary Agent chat. Unaddressed non-watch chat creates no input.
An explicitly addressed original carrying a C2 answer obligation is a direct
ask regardless of that Follow level: wake an idle receiver, use the next boundary
when busy, and retain the existing hold when person-stopped. Quiet queues only
selected unaddressed/informational events without waking; Custom/off suppresses
those events. The existing receiver admission, Pending custody and source mute
still apply; changing the Follow level does not opt out of a direct ask.

In development source, the Session recovery control offers the existing person
Resume action for an inactive, natively resumable Session when its Machine is
reachable and the viewer retains write access, even with no Pending rows. It
does not substitute Ask Happier merely because the queue is empty. Rendering
that action does not clear a person Stop or start work; the explicit click uses
the ordinary present-user Session resume owner. Higher-priority queue, guard,
Provider-binding and restart recovery retain their existing precedence.
Empty and non-empty queues use that same Resume Action. In development source,
its failure presentation retains the returned Action code behind the existing
Technical details disclosure, with the attempted operation and captured immutable
Home identity (or an explicit unknown identity). It does not disclose private
transport material, substitute a local profile id for a Home, waive carrier
verification or clear a held Session after a failed attempt.

Answer policy belongs to the existing executable participant row. The
`discussion.participant.policy.set` Action changes that row; invitation defaults
to `when_addressed`. `reads_only` permits authorized reading but cannot start a
speaking turn or publish as that participant. `drafts_for_approval` receives
addressed questions and prepares a private `ApprovalRequestV2` reply. Ordinary
Action-confirmation waivers do not disable this selected review policy. Its
entitled reviewer uses the existing approval decision/replay path; publication
retains the original Agent identity and rechecks current participant, reviewer,
Discussion grant and key readiness. The draft body stays in the approval
Artifact, outside the public Discussion message history.
For a Discussion Post, the reviewing client hands the decision to the exact
daemon before recording consent. That daemon owns the approval transition and
publication together; leaving the review page cannot interrupt a separate
browser-owned consent-to-replay step.
After Home authenticates and accepts the decision's strict HTTP envelope,
disconnecting that reviewing client ends observation, not the daemon's decision
or publication. The daemon still validates the exact approval, current authority
and original custody; this does not guarantee delivery of a request the client
never sent or survive daemon termination.
Its immutable `discussionDraftReview: true` presentation fact distinguishes an
open deliberate draft from ordinary Action confirmation in the private Inbox;
it grants no decision or publication authority.

The native explicit post/reply policy check reads participants as a companion of
the original signed Account Action, not a newly signed `discussion.participants.list`
effect. Home accepts only its canonical GET roster route with absent body/query and
matching route operands; original root, current installation, signature and resource
access remain independently required. The daemon normalizes the exact addressed
C2 return identity before signing, including deliberate drafts. A downstream
signed recheck cannot rewrite that identity:
if policy has changed to draft review, it refuses and requires preparation there.
Already-bound return context skips rebinding through its existing return marker;
signed informational input remains informational after a level/policy change.

Explicit addressed replies, deliberate drafts and final-result fallback retain
the original question/participant/turn identity. The fallback reconciles the
original C2 obligation before preparing an Action: a committed explicit reply
needs neither another publication nor another approval. If the explicit reply
is still awaiting approval, both paths rejoin that existing approval, preserving
its first captured body and terminal decision rather than opening another review.
The final-return producer captures the fresh canonical Home identity through the
existing Machine execution-origin resolver, retaining the CLI profile identifier
separately. Approval currentness compares that Home identity, not a browser's or
daemon's local profile alias; unavailable Home identity holds preparation closed.
The private publisher verifies the executing approval before stamping a draft
review assertion on its trusted socket publication. Neither a public post nor
an authored private publisher request accepts that assertion. Reviewed publication does
not require a live Agent caller, but retains Home, Account, Machine, permission, source and
participant currentness; ordinary Agent effects still require their live caller. Definite
pre-publication refusals remain typed. A failed read-only preparation request returns
`discussions_unavailable` (or `cancelled` when that read is aborted), not publication
uncertainty: no append has been attempted. An uncertain append acknowledgement remains an
unknown outcome under the same original retry identity, not another approval or a wake.

The development original-input progress keeps return publication separate from the native
answer in `returnPublication`. A closed failure records its code, phase and retryability;
a definite refusal releases only publication custody, preserving the completed native
result. The original question projects that participant's failed return through its
existing delivery-status row. Transient failures retain pending custody without another
publication attempt from duplicate hints; the existing transport reconnect or an advancing
native result can make recovery eligible again. No reply-specific timer is added.
An unknown feature probe remains unavailable and retryable; a proved disabled feature
or absent endpoint remains unsupported. Admission still fails closed in either case.
An `approval_pending` result retains the exact approval Artifact instead of repeatedly
executing the same Action. Its approved replay owns publication. Reject or Cancel of
ordinary Action confirmation records an exact-Artifact publication refusal and preserves
the native answer. Deliberate draft review retains its distinct typed decline outcome.
If approved publication fails, replay records the typed failure on that same original
through `discussion_publication`, bound to the exact approval Artifact. Withdrawing
speaking policy before Post therefore exposes `discussion_answer_policy_denied` on the
original question without posting the draft. Retryable failures release the approval
hold into ordinary pending return recovery; repeating the decision can finish a lost
settlement acknowledgement without repeating publication or the resource change.
Workflow publication-state changes use the existing original-reply hint with its captured
`workflowRunId`, addressed to the original Machine. Equal writes emit no new hint. The
existing Workflow recovery callback carries that exact Run through the recovery reader
and storage query, preserving Account, assigned Machine and pending-custody admission.
Concurrent hints retain every distinct Run; an unrelated hint never retries a held
non-Session result. Startup, reconnect and explicit resume retain broad recovery.
Missing-receipt diagnostics identify the original input, question and admitted turn using
content-free fields, so a refusal can be correlated without logging the answer body.

Reviewed post/reply replay uses that same `discussion-agent-post-v1` event's closed
`approved_replay` Machine carrier. The installed owning daemon validates the executing
private approval and its exact body, retains present-user replay authority, then supplies
the required review assertion. Home rechecks the authenticated current Machine installation,
the exact retained Machine–Session custody, the durable Session source or protected original
return, and current participant/reviewer access before invoking the same append transaction.
This does not require the receiver's Session process or current-publisher registration; it
does not start one. Both deliberate drafts and ordinary human-approved replies use it.
In development source, the signed currentness check accepts the retained addressed
source only for this reviewed publication purpose: it verifies the signed root's
Session, input and turn against the current original/return and participant access.
It does not waive Account, Session access-key, Machine installation or permission
revocation. The replay host supplies its credential-bound Account and canonical Home
facts; after trusted person approval, preparation reads use that current reviewer's
Account rather than the retired Agent's signed HTTP carrier. The captured Agent
origin remains immutable and publication still reopens the exact executing private
approval and body through the same Machine publisher. Ordinary signed HTTP reads,
effects and authorization issuance do not acquire a retained-source exemption.
Ordinary Agent publication and atomic create retain their current-Session publisher fence.
An indeterminate Machine append returns explicit `outcome_unknown` to the existing Action
owner rather than silently withholding an acknowledgement or claiming no effect.

Decline or cancel uses that same private approval transition, then settles the
exact Discussion original through C2's existing reply mutation. The original
becomes `released` with typed outcome `declined`; neither decision posts a reply.
The Artifact retains the specific decision. Repeating a terminal decision can
retry the idempotent original settlement after a lost response, but cannot replay
the declined publication. That settlement routes by the origin's canonical Home identity
when present, retaining the creator's local profile id as descriptive origin data. No
separate disposition store, profile alias or decision hook exists.

`watches_and_speaks_up` deliberately admits ambient turns through the same Follow,
Pending and autonomous check-in owners. The committed addressing snapshot
distinguishes watchers from explicitly addressed participants so ambient turns
count without charging person-authored asks. A watch turn publishes only through
an explicit post; its final text or typed pass does not become an automatic
Discussion message. These development paths still need the composed policy,
private review and Inbox journey on the loaded stack; they are not a released
availability claim.

A committed typed Session mention or reply to an Agent-produced message selects
current eligible participants at the Discussion append owner. Each selected
participant receives the committed question's `throughSeq`, not a later feed
snapshot. The existing C1 Follow edge stores the Discussion source identity and
delivered frontier; its shared receiver, delivery mute and check-in decisions
remain authoritative. New Discussion participation defaults to Quiet through the
canonical Follow creation preferences. Explicitly addressed messages still wake
through C3 addressing; there is no separate configurable delivery engine.

In 0.3 development, Discussion Follow intake renders the addressed question
through `sessionInputPromptContextV1.ts`. Its input-context block identifies the
sender kind and available Account, Team, Session and display-name facts. These
labels describe the request; they grant no authority. A person uses the admitted
Account profile's name; an Agent Session, Bot or model uses its authorized Session
presentation, not its human Account owner's name. An unavailable name remains
unavailable rather than borrowing a different actor's identity. A retained wait/return
obligation advertises `session.message.reply` with the receiving Session and exact
`requestLocalId`; the exact turn's final-result return remains the fallback. A returned
informational answer does not advertise another reply obligation. The renderer preserves
the complete escaped input-context block rather than silently dropping its trailing fields.
Provenance alone advertises no reply Action. Discussion intake uses C1's exact-original
classifier to distinguish an addressed ask from ambient watch custody; the latter does
not advertise an automatic final-answer return.
Background items use that same owner's `<happier_discussion_context>` block: participant
content carries its author, while compact Doc cards are labelled `host_reference_metadata`.
Follow intake includes the already-admitted reply ancestors, oldest first, including the
quoted source answer for a second-opinion question. It retains their admitted Account or
Agent Session author facts without opening another Session's private transcript or
borrowing that Session's human owner's name. Published Workflow ancestors retain their
actual producer facts as host-reference metadata, not a fabricated person or Session.
Only the referenced chain at or before the question's cutoff enters this background;
unrelated history and later peer answers do not. These entries reuse the existing exact
reads and provider input budget; intake adds no history/depth cap or separate hydrator.
Doc ancestors keep the compact authored comment/proposal-reason projection, not the
private Doc body, passage quote or proposal replacement.
Both carry escaped content marked as data, not instructions.
Quoted mentions or commands in those items do not become addressed requests.
Workflow inputs and digests must consume this shared renderer when their
Discussion context is wired; this intake change does not certify those consumers.

A human Discussion writer does not need control of an already-invited participant's Session
to address it. Invitation control and receiver disclosure remain separately enforced. Intake
retains the committed human cause or the Agent original's protected permission facts; a
Discussion grant does not supply access to a private source Session or delegate its causal
authority. Foreign-Account Agent roots therefore retain the existing Pending-owner
`session_input_target_unavailable` hold. Follow delivers originals in order and
advances its frontier only after Pending accepts their custody; it does not
recompute that hold or maintain a second held frontier.
Until requester/entitled-approver replay is available, the approved integration
requires authorized Discussion reads to project the hold as `participantDeliveryV1` with
`disposition: 'held'` and `code: 'session_input_target_unavailable'`. This is a
read-only admission fact, not an approval, delegated authority or a new obligation.
The message renderer can explain the hold without exposing the private source Session.
Later same-Account questions enter the existing Pending owner once each while
the earlier foreign original remains held. The read projection derives from
actual blocked Pending custody and its protected receipt/reply binding, not a
second Account-policy decision at Discussion reads.

A private foreign original can enter custody through the existing authenticated
Machine enqueue without opening its source transcript or inventing a permission
ceiling. Pending validates its source tuple against the committed Discussion
producer, persists the hold immediately and does not arm activation. Follow can
then acknowledge custody and deliver the next original. The Pending provider
selector skips these blocked Discussion originals rather than allowing one to
hold the entire provider frontier. An ordinary restore cannot turn authority-free
custody into legacy native input: host reconciliation returns it to Pending
settlement before provider delivery. This development-source path has owner and
composed SQLite coverage; package and loaded native integration remain unverified.

The protected Pending request, receipt and native admission witness retain the
question/participant/cutoff tuple. Happier-supplied context and `discussion.read`
cannot exceed that cutoff, and provider dispatch rechecks the original custody.
That recheck reads the original's settled authority and exact admission receipt:
initial settlement deliberately removes the untrusted request metadata. It
retains the original authority and encrypted content without re-evaluating
permissions, mute or participation for that admitted original. Pending still
checks its exact destination, publisher identity and active custody; an exact
settled original uses its retained exchange state rather than a fresh check-in
preference. New originals retain current admission checks. It does not restore a
request into the transcript or treat authority-free held custody as admitted.
Two queued questions retain separate contexts rather than merging their
cutoffs. These checks cannot erase content already ingested by a retained native
continuation; the composed native-independence live proof remains open.

C2 retains the Discussion destination on the original input, separately from its
causal Session or Run. Explicit publication and exact final-result fallback
share the original's return identity. The sole Discussion append transaction
settles the original obligation with its publication, so an uncertain explicit
response must not create another final answer. A validated informational return
does not ask the original producer again; explicit typed Session mentions still
create new asks. Pass, failure and cancellation remain typed outcomes, not
fabricated assistant answers. The r0.3f development contract for a stopped answer
uses C2's `cancelled.result` reference to its exact committed partial assistant
row. The existing result reader opens that text and the same return publisher,
subject to its existing answer-policy approval, posts it once, attributed to the answering Session and marked cancelled/stopped;
a committed explicit reply still wins and suppresses fallback. No partial text
means a bare cancellation, not an invented answer. The foreground Stop projector
now returns the acknowledged drained assistant sequence, and the host retains it
on that exact cancelled turn. Source-composed host-abort coverage proves the
partial anchor and the empty-cancellation neighbor; the reply owner resolves that
anchor to `cancelled.result`, including after late anchor projection. This source
proof does not certify a loaded native Stop-to-Discussion journey. Native-result
fulfillment remains a distinct producer.
`discussion.pass` acts on the current protected
original through the existing Session reply owner. Automatic publication,
approved replay and absent-host intake are still being validated; these
development contracts do not establish a completed user-visible journey.

Machine recovery uses its installed Account or an already-retained, exact requester Session
context on a shared Machine. That context supplies its own credentials, policy and lifetime;
it never falls back to the Machine custodian's Account. The existing requester visitor and
content-free hint drive the same recovery scheduler. Automatic return truthfully records a
host executor and original Session/Machine custody for Ask-first approval, without inventing
an active Agent turn or work depths. Approved completion reuses the exact-original terminal
publisher, not a general host permission to author Agent posts. An unavailable or retired
requester context leaves the original pending; no cross-Account restart bootstrap is added.

## Not decided here

Team identity, role and policy ([teams.md](teams.md)); membership lifetime and history horizons
([teams-membership-and-groups.md](teams-membership-and-groups.md)); Account encryption mode and
content-key ownership ([encryption.md](encryption.md)); route and transport selection for Machine
RPC ([peer-mediation.md](peer-mediation.md)); and the Action-surface admission floor that decides
which of these operations an Agent or the public API may invoke at all
([actions.md](actions.md)).
