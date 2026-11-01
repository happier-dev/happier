# The Actions platform

An **Action** is one named, schema-typed user intent — `session.list`, `teams.policy.set`,
`session.board.get` — declared once and projected to every surface it opts into: UI, Voice, Agent
tools, MCP, CLI, Machine RPC, the public HTTP API, and plugins. The point of the platform is that
a new capability is added by declaring a row, not by writing a command, a tool, a route, a
permission check and a confirmation dialog five times.

This page describes the platform's owners and its admission vocabulary. The public HTTP wire
contract lives in [api.md](api.md#external-action-api-developer-preview-source-contract); the CLI
host is in [cli-architecture.md](cli-architecture.md#action-derived-command-arguments).

In unreleased 0.3 source, Agent and external MCP Action tools default to
`discoverable_only`, with the shared direct allow-list and each Action's explicit
`toolExposure` metadata resolved by `getDefaultActionToolExposureMode` in
`packages/protocol/src/actions/actionSurfaceAvailability.ts`. CLI defaults stay
direct. Account `actionsSettingsV1.actions[id].toolExposureModes` overrides the
default independently for `agent`, `mcp`, and `cli`. A `direct` override adds the
enabled Action's named tool; `discoverable_only` removes that named tool even
for an allow-listed Action. Discovery and `action_execute` retain the same
availability, authority, and approval checks. Settings uses this resolver for
its default label. `happier mcp serve` captures Account Action settings at
startup; restart that MCP process after changing its exposure preferences.

In unreleased 0.3 source, an automatic managed-Machine retention wait superseded
before policy admission or native execution settles as `cancelled`. A successful
manual Stop or Delete therefore does not turn that obsolete wait into a failed
Action. The controller retains the `intent_changed` supersession diagnostic;
explicit Action conflicts, admission failures and issued native effects keep
their existing settlement semantics. Pending Stop/Suspend recovery uses the
Home's policy-admission provenance projected in the controller census, rather
than treating matching desired and submitted intents as policy ownership.

In unreleased 0.3 source, `localServices.inventory.list` accepts
`projection: 'count'` with its existing target and returns the strict
`{summary: LocalServiceMachineSummaryV1}` result. The existing inventory snapshot
Machine RPC accepts the same projection. Both read the daemon inventory owner's
current summary through `getSummary()` without scanning, refreshing or watching.
Omitting the projection preserves the existing full snapshot result. A ready
summary reports its running-service count, including zero; unknown, error,
disabled and unsupported count reads supply no count. Session rail readers reuse
received Machine or inventory summaries first, then make at most one scalar read
per mounted Session address and target Machine, without retry or a full-inventory
fallback. Project rails use held summaries only.

In unreleased 0.3 UI source, `captureLazyActionAccountContext` binds an Action to
its explicit Home and Account rather than the focused Sync transport lifetime.
Refreshing that Account's bearer preserves the captured authority when its
credential kind and encryption material stay the same; requests still use the
original admitted credential. Sign-out, replacement Account or key material, and
replacement restricted credentials retire it. Invocation cancellation remains
separate from Account-only cleanup. A manual Session launch refused before
dispatch ends its local attempt and returns the mounted composer to its existing
failure surface, preserving the draft for another Send.

A signed external Action spends one Home verification per target at ingress, the
same decision whether it arrived over RPC or the local HTTP route. Effect sites
then consume local cancellation and the installation pin, so admitted work
finishes and withdrawal applies at the next signed request. Approval replay is a
new admission: its requester preparation and signed effect each verify once, then
replay work stays local. For an Account request, Home verifies the retained root
Action while the installation signature binds the approved effect, input and
target. PAT replay also checks the resolved effect against the captured grant.
A forwarded child keeps its receiving Machine's proof, and
open-ended terminal access keeps `verifyMachineAuthorityCurrent`.

The unreleased Files & Editor work adds workspace replace preview/apply and SCM
blame intents through this same catalog. Preview and blame are safe reads;
replace is a danger Action with the normal agent approval default. A present
user applying the reviewed replacement uses `uiConfirmation: 'direct'` with
present-user confirmation. Result custody remains distinct from prompting.
The replace Action accepts `operation.kind: 'replace'` with a matcher and reviewed file hashes, or
`operation.kind: 'restore'` with post-replacement hashes and inverse edits. Undo
uses this same danger Action with exact inverse-text validation; present-user
calls use direct confirmation and automated callers retain normal approval.
The same host Action operation owns acceptance, cooperative cancellation and
the terminal per-file result. Its in-memory result retains inverse edits for
Undo; accepting an operation does not mean that its files have been written.
The generated Action reference owns the exact schemas
and surface inventory; this development contract does not imply release or
completed surface validation.

Unreleased 0.3 language intelligence also exposes symbol rename, file rename
with importer edits, and code fixes through `code.rename.preview/apply`,
`code.file.rename.preview/apply`, and `code.codeActions.list` /
`code.codeAction.apply`. Preview/list are safe reads. Apply keeps danger's normal
automated approval default and uses direct confirmation for a present user.
All edits, including server-requested command edits, use the same guarded
multi-file writer and inverse-restore owner as workspace replacement; no native
language-server command payload is an agent-facing execution authority.

The same unreleased review work extends `scm.diffSummary.reviewed.mark` and
`scm.diffSummary.reviewed.unmark` with live source/content-key selectors; Keep
only changes the Account's reviewed marks, never the index. Captured occurrence
selectors remain accepted and resolve through the same content identity owner.
`scm.change.discard` is the existing danger Action, not a separate hunk Action;
its comparison arm supplies guarded per-change or whole-file restoration and
Undo data. A present person's reversible Discard uses direct confirmation while
automated callers retain normal approval. Selection Ask reuses the existing
composer transaction and Run draft owners; it seeds a draft, never sends a
question automatically. See [SCM comparison ownership](scm-diff-summary.md) for
scope, result deletion and mark persistence. Rendered integration and generated
surface projections are separate from these development-source contracts.

In the same development source, `composer.transaction.apply` accepts
`reviewComment.add` with the canonical review-comment draft (anchor, selected-text
snapshot, body and inclusion choice). On a mounted editable Session composer,
the host resolves that Session's workspace and upserts through the workspace
review-draft owner used by editor, diff and Problems Ask. The operation keeps
unsent text and plugin attachments intact and never sends a message. The safe
composer Action's existing approval settings apply. The UI's direct use of that
same draft owner also retains selection context before the composer mounts.

The unreleased 0.3 editor work adds `file.editor.save` and
`file.editor.resolve` through the existing scope Action family. They address the
answering client's mounted editor, optionally by `tabId`; an absent owner is
`unavailable`, not a request to open or load a file. Save reports `saved`,
`clean`, `conflict` or `unavailable`. Resolve accepts `useMine`, `useTheirs` or
`discardDraft` and reports `resolved` or `unavailable`. Automated callers keep
the normal approval default. The filesystem write Action remains a danger
Action, with `uiConfirmation: 'direct'` for a present user's Save; explicit
per-Action approval settings still apply. Inline and upload saves carry the same
raw-byte `expectedHash` to the shared guarded replacement owner. Use mine writes
against the shown disk hash and Undo is guarded too. These are development
integration contracts, not a release or live-validation claim; [file editor
ownership](file-editor.md) describes the state, draft and write boundaries.

The unreleased File-page copy flow uses the same `artifact.publish_from_file`
Action. Its optional `workspace: {machineId, rootPath}` explicitly selects the
source instead of an ambient Session; omitting it retains the admitted Session
source. The UI reads through the existing confined workspace transfer under
the captured Home/Account. Source paths, Machine and workspace identity stay
in private revision provenance, not the public header or shared content.
CLI hosts route an explicit workspace to that exact Machine through the same
publication Action. The receiving host proves its local Machine identity and
uses the existing confined workspace transfer and Artifact publication owners;
it never publishes the invoking host's ambient Session file instead.
Required approval replays on that captured Machine; the mounted dialog consumes
the same publication receipt rather than reserving client-only execution.
Generated Action references own the exact input; File-page rendering and live
validation remain program integration work.

In 0.3 development source, Session-targeted Actions declare their operational
operand and one/many cardinality through `sessionTarget`. The shared
`sessionTargetV1` schema normalizes shorthand and object intent; the executor's
`sessionTargets` owner resolves authorized qualified addresses before approval.
`session.message.send` and `session.status.get` consume self, manager, workers
(direct or recursive), siblings, Followers, Following, Discussion participants,
and matching filters; `session.open` requires exactly one result.
Plain Session IDs retain their existing result shape. Group sends/status reads
return each target's outcome. Native participant recipients remain separate
inside-Session routing identities.

For plugin `session.message.send` in unreleased 0.3 source, attachment local ids
resolve to the sender's declaration first, then to the immediate host-stamped
initiating plugin's declaration. A delegated Triage → Channels send can retain
`happier.triage/entry` while Channels owns the send. Callers cannot author that
identity or borrow a grandparent caller; an undeclared selection returns
`session_input_invalid` before persistence. Session creation projects that
initial-input refusal as `invalid_input`. Fresh sends, retry correspondence
and pending-first-input handoff share the same
[attachment identity owner](plugin-platform.md#session-send-attachment-identity-03-development).

`session.targets.resolve { target, actionId }` is the safe read-only inspection
Action for that same resolver. It exposes authorized addresses and complete or
unavailable coverage through the catalog's UI, Voice, Agent, MCP, CLI and SDK
projections. The picker delegates to this Action; it owns no separate traversal.
Inspection creates no effect or approval. The eventual operation prepares its
own current selection once, then retains that concrete list for approval/replay.

In unreleased 0.3 source, the SDK host-Action `execute` overload and UI Action
execution options accept `sessionAddress: ActionSessionAddressV1` when a caller
already holds an exact Home/Session result. This is a routing constraint, not a
selector or grant: the Action's declared operand must contain exactly one plain
Session-id string matching the address, and canonical resolution must yield
that same single qualified target before policy or effects. Selector objects,
reserved selector shorthand and contributed-Action references do not accept
this option. The host retains its original authorization anchor, captured
Account, explicit credential fences and retirement cancellation. CLI execution
cannot use the option to leave its admitted Home. Omitting it preserves existing
selection and fanout behavior; no qualified-string grammar is introduced.

External installed plugins in 0.3 development source declare the same
`sessionTarget: { field, cardinality }` on their public Action declaration.
Discovery retains that metadata. Inspection accepts the canonical qualified
Action id (`<pluginId>/actions/<localId>`); invocation uses `action.invoke` with
the ordinary contribution reference and input. The executor projects the
declared field beneath `input` and resolves it before the plugin's exact-input
parser, approval or handler. The same resolver enforces cardinality and the
caller's available subtree. Each concrete invocation retains its reviewed
target in approval custody; changed membership never expands it during replay.
Preparation reads remain signed under the admitted `action.invoke` or
`session.targets.resolve` root. Selection grants no additional handler or
Session mutation authority.

For Session-placed Actions with exact targets in 0.3 development, original CLI
invocation reuses the ingress selector owner and the protected-message Session transport lookup
to derive the owning Machine before delivery. Session Actions enter that
Machine's daemon; protected message input retains its existing live-publisher
or inactive-Session resume route. The receiving daemon still proves locality
and admission. An unavailable owner returns the existing admission failure;
the caller's local daemon does not become a replacement execution target.

Session-backed SCM backend operations in 0.3 development use the same exact
target-Machine route as explicit Machine Actions. The shared CLI adapter resolves
the Session's Machine and workspace; a bound Run keeps its own host-provided
working directory. The receiving daemon executes against its admitted SCM
backends, including external plugins. Session runners do not create an SCM
registry. Restricted runners reach the credentialed adapter through the existing
Session capability channel, retaining their turn and Run witness.
The host-selected workspace travels outside authored SCM input and becomes the
existing Machine target's directory. SCM ingress intersects that directory with
Machine filesystem policy on the receiving filesystem, including symlinks.

Saved review-result reads, revision edits, refinement/discussion and reviewed
marks over retained evidence keep their existing local Home, Session-access and
saved-scope checks. Live capture, generation, commit-plan application and live
content-key marks need the daemon's installed backend owner. Machine-wide saved
inventory still requires an explicit Machine target.
Prepared review-workspace materialization remains at the host-stamped source
plugin owner; it has no public CLI, Agent, MCP or Machine RPC entry point.

In 0.3 development source, Claude's contributed Create agent team and Launch
teammate Actions are discoverable and callable from CLI and MCP with a current
Session, as well as UI and Agent tools. They use the existing Session input
admission and native launch policy; surface availability grants no additional
invocation authority. Real Claude team execution still requires vendor sign-in
and the release-owned live check.

Preparation and the existing approval Artifact retain the concrete address
list. Replay rechecks each target's current access and input admission without
expanding changed relations. Missing or incomplete selector backing returns
`session_target_unavailable` before fanout; an empty group and a one-target
cardinality mismatch have distinct results. Matching consumes the complete,
authorized Follow preview/filter owner and refuses unavailable candidates or
continuation. The host readers exhaust ordinary and attention pages. Follow selectors
combine authorized stored relations with current rule matches through that same
filter owner; private person follows and non-Session sources never become Session
targets. Rule-backed Following and Followers exclude self-follow, as the Follow
delivery owner does. Discussion selection reads the admitted participant roster, including model
slots only after they have an ordinary Session; selection creates no Session or grant.
Incomplete reads refuse the whole selection before effects. The remaining declaration
sweep and the coordination program's loaded-runtime validation are separate gates.

The human Discussion composer additionally retains invited, unstarted model-slot
mentions in its existing draft. Explicit Send resolves those slots through the
existing invitation/rejoin and ordinary Session-start Actions before posting the
canonical Session mentions; selecting a suggestion alone has no start effect.
This does not turn the read-only Discussion Session selector into a launcher.
See [model participant birth](session-collaboration.md#model-participant-birth-development-integration).

External selector preparation signs these reads under the original Action root.
The catalog declares `follow.list` as a read so the existing route-purpose check
admits it; the verifier still binds each preparation phase to its exact signed
request. Private Follow-rule census retains full Account credential admission,
and resource access is checked by each reader. Preparation grants no Follow write.
Specialized native operations retain their narrower preparation contracts before
this general selector admission applies.

Session messaging in 0.3 development uses that same front door. Send writes
`session.message.send` with `reply: 'none'`; an ask uses `wait` for inline
observation or `return` for an answer that can come back after observation ends.
The predecessor boolean `wait` is accepted at ingress, but cannot be combined
with `reply`. A caller timeout ends observation without cancelling admitted work.
Pass, failure, cancellation and a terminal turn without a result are distinct
outcomes, not inferred from silence. `session.message.reply` fulfills the exact
named input rather than choosing a new destination; `session.update.post`
publishes progress through Follow policy and is not an ask or a reply.

The [original input's reply custody](pending-delivery.md#correlated-session-answers-03-development)
owns fulfillment and inline-versus-later disposition. Returned answers are
information, never another acknowledgment request or a transcript-access grant.
Receiver mute and autonomous check-in are enforced at their shared admission
owners; a selector, UI control or Voice tool supplies no alternative policy.
These development contracts do not establish completed composer, Voice or
loaded-runtime validation.

The 0.3 composer retains each cross-Session Ask/Send as one informational source
transcript event. Its encrypted/plain content contains the person's text, reply
mode, frozen concrete targets and immediate admission receipts. A deterministic
key derived from the submission localId keeps retries on that row without
colliding with a self-targeted input. It does not submit input or start a turn in
the asker. Agent-tool invocations reuse their existing tool-call row.
Receipt updates retain the entry's original target membership and successful
admissions. The transcript entry is presentation, not trusted replay custody:
it never supplies executable target operands or synthesizes Action acceptance.
The composer's device-local draft supplement retains execution retry custody:
the Action-resolved target snapshot and each real admission receipt belong to
the exact draft attempt. Retrying an unchanged draft passes only refused or
uncertain leaves, with their original operation identity, through the existing
Action executor. It does not re-enumerate a changed selector. Previously admitted
leaves remain visible in the source entry; editing the draft starts a new attempt.

The transcript result reader joins these identities to the original receivers'
reply custody and admitted returned-answer facts. Concurrent displayed demand
shares an exact-key HTTP batch; settled rows do not poll or read on unrelated
arrivals. The source entry owns presentation history, not reply fulfillment or
execution authority. These data hooks do not establish completion of the result
row's visual composition or loaded-runtime acceptance.
A refused or uncertain operation key is not proof of an admitted question:
those rows do not attach an original or returned answer by localId alone. A
confirmed retry can establish that binding through the existing Action owner.

In 0.3 development source, `session.status.get {sessionId, readiness: true}`
adds an operation-scoped diagnostic to the ordinary readable status. It composes
the existing qualified Machine reachability, Agent inventory/sign-in and invocation
grant facts. Omitted, stale or unread prerequisites remain unknown; a configured
Session is not proof that it can execute. The default operation is conversation.
For a credential operation, callers additionally supply `operation: 'credential'`
and its qualified `credentialPurpose`. Personal operations read their selected
purpose binding. A Team operation also carries the setup owner's exact
`credentialTeamSelection`; the status owner checks its purpose, service and
resource binding against the current declaration and entitled catalog. Unavailable
resources retain their owner's failure and recovery facts. It never substitutes the
viewer's setup for another Account's binding;
inaccessible or incomplete evidence stays unknown. An optional integration does
not veto ordinary conversation, and a diagnostic never grants write authority.

Detail reads are explicit, using the existing inventory owner, without a new
poller or readiness cache. Entitled repair opens the existing exact Agent sign-in
or connected-account reconnect Action; reading readiness never starts either.
Actual send/start/write admission still rechecks current authority and setup.
An unavailable executor does not remove access to previously authorized results.
Handoff availability remains the handoff owner's source-and-target decision, not
an inference from a ready destination. These source contracts still need the
coordination program's integrated live repair and handoff validation.

In 0.3 development source, `actions.policy.get` and `actions.policy.reset` read or
reset one exact `{ actionId, audience }` preference. `actions.policy.set` accepts
that target with `mode: 'allowed' | 'ask_first' | 'off' | 'default'`, or a typed
`change` for global enablement, audience enablement, placement visibility or slash
policy, tool exposure, or a plugin's host-capture approval preference. The UI uses
these same intents and Account persistence. Default removes
that audience's explicit disable/approval preference and inherits canonical policy.
Audience-only edits leave global Off, neighbouring audiences, placements and tool
exposure intact. Audience results distinguish stored mode from global `actionEnabled` and
`enabled` after these settings apply; catalog and runtime availability still govern execution.
Changes require human authority: Agent/MCP requests use the ordinary approval flow,
and a saved waiver cannot let an agent approve its own policy relaxation. These
operations accept no raw settings patch.

In 0.3 development, choosing Ask first or Allowed in Settings → Actions restores
inheritance when that answer matches the Action's default for that surface.
The settings writer reads the shared approval policy, including contributed
Action declarations and the Source Control confirmation preference; it clears
only that surface's approval override or waiver and preserves neighbouring settings.

The development Account reader normalizes predecessor `session_agent` policy to
`agent` at the shared Action-settings owner, including explicit Require, disable
and tool-exposure preferences. Existing UI/voice aliases use that same reader;
valid current tool-exposure keys take precedence over aliases. Writers retain
only current surface names. This forward reader remains while 0.2-created
Account settings are supported; it does not change dangerous defaults or add a
0.3-to-0.2 rollback writer.

UI writes, effects and reads with an equivalent typed read Action must enter
the Action executor so the same intent has one enabled, surface, authority and
approval policy. Settings → Actions per-Action Ask-first and disabled settings
apply to UI reads, including refresh, retry and paging. A retained subscription
may own demand, paging and publication, but acquires its data through that same
Action front door; the shared domain transport stays below Action admission.
Public pre-auth reads and signed-out draft bootstrap retain their existing
authority boundaries.

In 0.3 development, client-routed UI Actions accept optional `clientId`, an exact
answering socket id. The server selects only an eligible handler with that id;
a disconnected or ineligible selection returns `client_not_available` without
substituting another client. Socket ids expire on reconnect.
Once an exact client answers, its result is terminal; a receiver refusal does
not switch to an incumbent headless fallback owner.

Without `clientId`, the server uses the sole eligible App or the App with the
unique most recent focus transition observed through the existing `ui-focus`
push. Focus history belongs to the live socket and is lost on disconnect;
missing or tied history returns `client_ambiguous` before execution. That
refusal includes `details.clients` (id, nullable device label and available
focus state) and `details.recovery.inputField: "clientId"`, so the caller can
retry with an exact candidate. No client-discovery Action is required for that
recovery. Unadvertised device labels remain null. No focus timer or polling is
introduced.

Contributed plugin client Actions use the same receiver selection. Invoke the
host `action.invoke` envelope with optional `clientId` alongside `action` and
`input`; the selector is not a field in the plugin's business input. The shared
host transport keeps the plugin request schema and occurrence checks unchanged.
Supplying `clientId` for a non-client contributed Action returns
`client_routing_not_applicable` before its handler runs.

Generic client-placed Actions from a bound Session reach an eligible App viewing
that Session through the existing Session reverse-RPC method. An absent viewer
returns typed unavailability. Explicit mounted Work, current-context command, Workflow draft,
Library view and plugin execution-origin addresses keep their routing contracts;
Library view and execution-origin discovery enumerate the connected clients.
Standalone CLI destination selectors are not caller Sessions: opening a Session
uses the answering App even when that destination is not already viewed. Agent
bridges and explicit Session caller provenance retain their bound routing.

Voice conversation (including History) and client-placed Settings operations use the generic answering-client
room even for a Session caller, so visiting Home or Settings does not withdraw
them. They use the same exact-client, sole-client and focus selection rule among
signed-in clients connected to the target Machine; absence returns `noClient` with
a `connect_client` recovery instruction. Composer and other view-specific
operations retain their exact Session routing.

In 0.3 development, `ui.pet.choose` is the shared UI, Agent and MCP pet-selection
Action, executed by the answering client through the existing reverse dispatcher.
Empty input opens pet settings. `petRef` selects a built-in or Account-library
reference and clears this device's override only after the Account write succeeds;
`deviceOverride` selects a known local source or returns to inheritance. The
effect owner validates the current pet catalog and feature availability. Off,
Ask first and Allowed use ordinary per-Action policy; rejected or failed choices
leave selection unchanged. Account settings and device settings retain their
existing storage shapes.

In 0.3 development, Machine-placed `browser.view.openExternal` keeps its strict
`{ browserSessionId, viewId, commandId }` input. The daemon forwards it through
the existing exact-view client channel. The mounted answering client selects
the page address and opens its system browser; no mounted owner means a typed
unavailable result. External opening does not require page-automation support.

In 0.3 development, Session sharing discovery follows that rule through
`session.access.candidates.inspect`, `session.access.principals.resolve` and
`session.access.accounts.search`. These safe reads reuse the server's candidate
policy, principal-label/creation-decision and collaboration-search owners. An
inspection is advisory: the grant writer still checks current authority and
policy when access changes.

The same development family exposes `session.access.encryption.prepare`,
`session.access.encryption.reprepare` and `session.access.layout.update`.
These client-placed Actions reach the answering app's existing envelope
preparation and metadata tuple owners. Inputs identify the Session and, for
Re-prepare, the recipient Account; callers never supply keys or metadata.
Agent and MCP calls use Ask-first approval. A present user's manual preparation
uses direct UI admission; historical layout Update keeps its approval policy.
The dedicated CLI commands accept `--server-id` for the exact Home. Automatic
post-grant preparation stays a continuation of the admitted grant, and the
grant's historical-layout preparation runs only after grant admission.

In 0.3 development, `approval.request.list` exposes the Inbox queue's metadata
read to UI, Agent, MCP and CLI callers. Use `happier actions invoke
approval.request.list --input-json '{"status":"open"}' --json`, or MCP's
`action_execute` with that Action id and input. The read validates each approval's
Artifact header and body before returning metadata for built-in and plugin
approvals; it does not hydrate transcripts or return approval bodies.
The existing page bound is 1–100 matching entries (default 32). Optional
`actionId` filters built-in approvals by Action id; plugin Action approvals use
`action.invoke`. `workflowRunId` selects open requests whose admitted execution
origin caller is that Run, including participant invitations and external plugin
Actions, alongside Discussion-result publications correlated by their admitted
return binding. It defaults the status to `open`. The Run page uses that same
approval correlation over the open-request projection;
unrelated document arrivals do not rescan the Artifact inventory. Discovery
uses the existing kind/state query and exact body hydration, and ends once
the viewed Run is terminal with settled custody.
Pass a non-null `nextCursor` back as `cursor`, retaining the
same status, Action and Run filters, to continue. A null `nextCursor` marks source exhaustion;
a full final page may require one empty continuation read. The cursor is the
ArtifactStore's opaque continuation, including the position after skipped
nonmatching Artifacts. It grants no access or decision authority.
`approval.request.get {artifactId}` is available wherever `approval.request.decide`
is available and returns the request with declared confidential plugin inputs
redacted. Older plugin requests without disclosure metadata withhold their input.
Both reads are discoverable through Action search. Their
approval-control admission remains separate from deciding or executing an
approval; listing pending work grants no decision authority.

Daemon plugin approvals retain the host-stamped caller materialization's Machine
in the existing execution origin and Artifact header when no explicit Machine
custody is present. The shared approval-origin builder supplies this default for
all Actions, rather than only automation status reports. Explicit target and
signed custody retain precedence; this projection grants no authority and does
not add an execution target or change Action input.
Sessionless approvals use that Machine for the existing requester presentation
in the Inbox and approval details, resolved only on the approval's Home. Session
requesters retain their existing Session context.

In 0.3 development source, `automation.event.source.status.report` is safe
runtime telemetry by default, while retaining write-effect metadata and exact
host-stamped plugin provenance. It does not inherit the dangerous default of
`automation.event.admit`. An explicit Settings → Actions approval requirement
still applies through the shared per-Action policy.
An explicitly required status report keeps its live invocation in the existing
blocking approval flow until the write executes or approval is refused. The
shared SDK Actions adapter joins identical in-flight reports from the same
source service and cancellation lifetime, so repeated wakes observe the same
pending approval. A returned report acknowledges an accepted status, not merely
an approval request. After currentness admission, equal source or catalog facts
do not advance their status revision or publish an Account-change wake. New
occurrence timestamps, counter deltas and changed reporter or status facts still
publish. Refusals return to the source's existing recovery cadence.

In 0.3 development source, an `approval_stale` failure retains the failed
authority or custody fact as `execution.details.reason` on its approval Artifact.
The [closed reason schema](../packages/protocol/src/approvals/approvalStaleReason.ts)
admits diagnostic codes only, without Account, Home, Machine or credential values.
Decision observations and Action Operation errors preserve that same typed fact;
the existing new-session error code includes it. These diagnostics do not change
approval policy, origin verification or execution authority.

Mounted UI Actions use live-only approval custody when they explicitly retain
private operands or local delivery ports. A serializable write does not acquire
that view lifetime merely because it has an effect: its durable approval remains
reviewable after the initiating view unmounts. Credential and Account retirement
still revoke authority through the existing scope owner.

In 0.3 development, an authenticated, strict-envelope `approval.request.decide`
HTTP invocation retains its daemon-owned decision after the reviewing client
disconnects. HTTP observation lifetime does not withdraw that explicit decision;
the existing `reject` and `cancel` decisions retain their own domain meaning.
Other HTTP Actions keep cooperative request-disconnect cancellation. This adds
no retry queue or process-restart guarantee and does not waive current daemon,
credential, approval-origin or publication admission.

In 0.3 development, open Action approval cards remain available in an inactive,
resumable Session. The Artifact owns the decision; the approving app replays it
or the daemon retains custody. `deriveTranscriptInteraction` preserves the access
grant for these decisions independently of process activity. Tool permission
prompts still require a live process. Public and read-only transcript surfaces
continue to withhold decisions.

In 0.3 development, a standalone CLI approving a client-placed Action forwards
the recorded decision to its original daemon, which reaches the connected app
through the existing reverse Action dispatcher. It does not replay the client
effect in the standalone process. New Session draft deletion reads the exact
Account draft before deciding it is missing, then uses the draft repository's
tombstone and attachment-cleanup path. A missing connected app fails the approval
with `unavailable` / `noClient`; a rejected draft revision reports
`session_draft_conflict`. A lost deletion response or failed cleanup reports
`outcome_uncertain`: inspect the exact draft before requesting another deletion.
Homes without draft synchronization retain local-only deletion.

Ordinary public sign-in link Copy, Share, QR and Open, route-only navigation,
and local draft/result disclosure are client presentation. The public member
sign-in URL is already readable through `teams.identity.connections.list`;
these controls need no additional Team business Actions. Invitation bearers
retain the separate human-only live-result custody described below.

## Canonical owners

In 0.3 development, shared Action input validation returns `invalid_parameters`
with `details.issues`: each issue identifies its input `path` and validation
`code`, plus `expected` for type failures or `acceptedValues` for literal,
enum and discriminator failures. Agent spawn authoring and intercepted inputs
use the same projection as ordinary Action admission. Diagnostics omit rejected
values, unknown-key lists and custom validation prose; the existing Action
failure envelope carries these details through Agent and MCP tools.

Discovery uses the same content-free issue envelope for an unknown Action id
(`unknown_action` at `id` or `actionId`) and an unknown input hint
(`unknown_field` at `fieldPath`). An invalid schema-section pointer identifies
`schemaPath` with `invalid_schema_path`, independently of Action lookup.
Identifiers are located by path rather than echoed. Native callers can repair
the named operand without receiving rejected
values or private input content. Missing or contradictory inventory selections
use `invalid_selection` at the relevant `draftInput` field. The shared selection
owner preserves that refusal through both option resolution and direct reads.

In 0.3 development, `mcp.servers.duplicate` accepts only `{ serverId }` and returns
`{ serverId: <new id> }`. The Protocol MCP Action owner reads the current Account
catalog, allocates the copy's identity and unique name, and commits its configuration
with default reach from `resolveCreateReachV1` through the existing catalog CAS.
Connected Account grants and attempts remain scoped to the source id; the copy
needs its own OAuth sign-in. UI navigation uses the returned id, and the compiled
`mcp servers duplicate <name>` leaf shares the existing CLI name-to-id adapter.

In 0.3 development, every authored Action spec requires typed `approval`
metadata. Family constructors declare result custody and flow beside their
schemas; `actionApprovalClassification.ts` reads that declaration. Adding an
Action no longer requires a separate approval-ID census. The closed `ACTION_IDS`
list and its literal union derive from `ACTION_ID_FAMILIES_V1`.

API admission remains derived by the canonical normalizer. An authored
`surfaces.api: false` can retain an exclusion; it cannot grant API authority.
In development source, plugin Settings administration is available through UI,
Agent and MCP Actions. List, non-secret reads and secret status are safe;
set, reset and secret binding/removal ask first by default through Actions
Settings, where users can waive that default. Secret mutations still exclude
the ordinary API surface and accept SavedSecret identities rather than raw
secret material. Placement and approval custody share the schema-admitted
Account or exact daemon target; declaration admission, revision checks and
currentness still govern the effect.

`plugins.account.release.select`, `plugins.account.hosting.set`,
`plugins.account.hosting.remove` and `plugins.account.cache.clear` use the existing Availability selection, intent CAS,
hosted artifact/asset removal and device cache owners. Registry-profile Actions
use the existing revisioned Machine profile writer; native credentials are
acquired privately after admission and never become Action input.

Specs also own host-only `approvalPolicy` and `originalExecution` metadata.
Approval settings consume the declared confirmation defaults, while server
original-root ingress accepts catalog Account, Machine and client placements by
default, while an explicit `accountRoot: 'separate'` declaration keeps a separate
entry point. Signed-root validity, credential policy, surface and target admission
remain at their existing owners. Session roots retain their declared surface and
authority requirements. Home cannot open
encrypted operands: the receiving daemon still resolves the exact placement
from schema-admitted input. Native-purpose metadata selects the existing strict
transport checks; it does not grant authority or relax their target binding.

In 0.3 development, `approvalPolicy.uiConfirmation: 'direct'` declares direct
default admission for a present user on the UI surface. Reversible capability
settings use this declaration; Agent, CLI and MCP callers retain the dangerous
default, and unknown surfaces fail closed. Explicit Ask settings still win.
Present-user UI authority comes from a host-mediated control. A raw plugin
`hostApi.executeAction` call retains plugin/automation authority, including when
a plugin click handler starts it; declaring a direct UI policy does not upgrade
that caller or its nested Actions.
`uiConfirmation: 'policy'` retains the shared confirmation policy. Plugin install
uses that policy for the first Install & Trust trusted-code disclosure. A host
confirmation for that exact Action satisfies the default once; explicit Ask
still applies.

`uiConfirmationForInput` is evaluated only for a present person's UI request.
In unreleased 0.3 source, Session visuals use the same Agent approval floor as
other danger Actions, including a visual authored by its own Session Agent
with no network or host Actions. Visual preparation retains capability and
revision checks but cannot waive Agent approval. Ask first creates one request
before any write; Allowed and Blocked retain their shared policy meanings.
The same no-network visual remains direct for a present person in the app.

Present-user Session responsibility and lead assignment, Home restart, local
runtime restart and remote-host relay restart use the direct UI default because
they are reversible. Public-link creation also uses that default. Document
deletion forwards exact `presentUserConfirmation` after the artifact surface's
designed consequence review; its generic default still applies without that
review. Prompt-library deletion and document-link revocation use the executor's
single canonical confirmation. Settings → Actions can require approval on each
Action and surface in either case; Agent and automation defaults are unchanged.

The host-only `approvalPolicy.nonWaivable` declaration is resolved by
`actionApprovalPolicy.ts#isActionApprovalWaivable` for both executor admission
and Settings → Actions. A declared non-waivable confirmation stays Ask first
despite a saved waiver; Settings offers Off and Ask first for that Action.
Approved replay retains its existing host-proved bypass. Workflow trigger writes
and plugin installation remain configurable; they do not declare this restriction.
Default in-place UI confirmation and app-owned approval replay share the same
present-user host predicate, excluding external credentials, external execution
authorization and Session RPC authority.

Connected-account authentication declares the same direct present-user UI
default for starting, continuing, submitting and cancelling an attempt. The
service's OAuth, device or credential step owns the connection flow. Explicit
per-Action Ask settings still apply, and Agent, MCP and CLI authentication
calls retain the danger default.

Connected-account defaults and names, Resource-purpose defaults, pool creation
and edits, member add/edit/removal, switching and ordering, pool defaults, and
the user's entered subscription price also declare direct present-user UI
defaults. These declarations use the same shared approval policy: explicit Ask
still asks, and Agent, MCP and CLI requests retain their approval defaults.
Credential replacement, account revocation, pool deletion and quota reset
retain their confirmation defaults.

In 0.3 development, a New Session seed that names a Machine without a folder
keeps that folder unresolved through draft hydration. The existing placement
owner selects that Machine's recent folder or home; hydration never invents `/`.
Explicit folder choices, including `/`, stay authored choices. This does not
change the separate no-folder intent, whose private directory belongs to the target daemon.

Missing-folder preparation for `session.spawn_new` uses the same approval
resolver. The target daemon still supplies the exact directory proof; creating
that folder is direct by default for the present user's UI invocation and its
authenticated RPC hop. Agent callers retain the directory-creation approval
default, and per-Action Ask settings and waivers still apply. A waiver carries
the directory proof without changing the caller's execution authority.
In 0.3 development, UI and CLI approval producers both read target preparation
before creating the Artifact and retain that proof with the request. Replay
rechecks it at the target daemon; missing or changed proof fails with the typed
stale reason before spawning.
The read-only transport is `daemon.sessionCreation.directoryPreflight.v1`,
admitted through current Machine Use and restricted to an explicit path without
checkout creation. The same target preparation owner handles it; the existing
`daemon.sessionCreation.prepare.v1` retains custodian-only materialization.
Keeping distinct method identities makes an older guest fail unavailable rather
than receive new shared authority on its older materializing handler. Home, the
requesting client and the target daemon must load the new method for shared
directory preflight to succeed. Admission refusal and caller timeout do not
establish that the daemon is offline.
An unconfirmed UI directory-preflight reply is a pre-effect `spawn_failed`
with launch code `RPC_TRANSPORT_UNAVAILABLE`; an original `RPC_OUTCOME_UNKNOWN`
remains diagnostic evidence about that read, not about Session creation. The
preflight issues no create and has no spawn operation to observe. A lost reply
after the actual create was issued still retains the existing pending/unknown
settlement and creation key; this classification adds no retry or effect replay.

Creating a checkpoint or a private prompt document, editing an Account role,
creating a workspace directory, and changing future worker or service placement
preferences also declare direct UI defaults. Destructive role resets/removals
and worker-copy retirement retain their confirmation defaults.

In 0.3 development, `session.checkpoint` is also exposed to Agent, MCP and CLI
callers through the same source-qualified checkpoint owner. Those callers retain
the danger approval default; creating a checkpoint from the user's own UI is
direct. This does not change the separate checkpoint restore or code rollback
confirmation policy.

Plugin reload and opening a Browser workspace/view declare direct present-user
UI defaults: opening a view or loading the current plugin again is reversible.
Their Agent danger defaults remain, and explicit Ask settings still take
precedence. Inspector's side-effect-free `happier.inspector/actions/self-check`
declares UI, Agent and MCP surfaces through its ordinary plugin manifest.

The administration Machine picker is device-local presentation context. Changing
it selects the inventory shown and the target of a later operation; it does not
itself perform a plugin lifecycle effect. Agents pass that exact target to the
corresponding Action. The separate `plugins.execution_origin` Actions expose
where a plugin runs, including mounted contextual choices; they do not manipulate
the administration picker's display state.

In 0.3 development, `plugins.execution_origin.list/set/clear` operate on the
answering device's preference for its current Account and Home, for UI, Agent,
MCP and CLI alike. CLI/MCP inputs accept an optional `clientId` identifying
the exact answering app socket. List returns `answeringClientId` and eligible
`answeringClientIds` for follow-up
calls; socket ids expire on reconnect. All three operations follow the shared
client-choice rule: exact selector, sole eligible client, or unique latest
pushed focus transition. Otherwise `client_ambiguous` lists candidates in
`details.clients` for an exact retry. A missing selected client is unavailable;
the transport never substitutes another device. Set admits an exact current origin but stores only its
Home-qualified Machine; each operation resolves fresh source custody. An
unavailable explicit Machine stays selected and blocks its operations. With no
pin, a sole admitted candidate in the local Home may run. Clear removes the local
choice. These Actions do not use an Account settings version or synchronize a
choice to another device. Retired Account origin keys remain readable as inert
stored data and are never migrated, pruned or written by the selector.

Installed-plugin lifecycle controls use semantic Actions in the existing plugin
change family: enable, disable, rollback, uninstall, forget trust and update policy. UI,
CLI, Agent and MCP callers reach the same daemon change admission with an exact
Machine target. Enable, disable, rollback to a retained trusted version and
update-policy edits are reversible own-UI defaults; uninstall and forgetting trust
retain confirmation, with the latter also discarding rollback retention. Agent/MCP lifecycle writes
ask by default, and user waivers do not bypass trust admission or grant human
authority. Updating an installed plugin uses `plugins.install` with
`source: { kind: 'installed', pluginId }`, retaining the daemon's update selection
and the same Install & Trust disclosure/replay owner.

The daemon's executor owns lifecycle approval; the mounted UI presents its
original review Artifact rather than adding a caller-owned confirmation. Exact
targets, trust review and managed-resource dispositions remain domain
preconditions. A resource-responsibility review is a distinct choice and supplies
new operands to the next admitted invocation.

A UI caller that runs an Action now for a present person enters through the executor's
`execute`: only `execute` offers the host's in-place default confirmation
(`presentUserActionConfirmation`), because that confirmation dispatches the Action
immediately. `prepare` never dispatches, so it stays for admission without effect (for
example a borrowed plugin Resource read) and for callers that hold the invocation to run
later; a run-now caller that uses it creates an approval Artifact instead of the confirmation.
Withdrawal before dispatch is the context `signal`. Agent, MCP, CLI and plugin callers never
receive this confirmation, and an explicit Ask-first setting still forces approval.

Source-control writes follow the same rule, and the Action policy is the one confirmation owner
(Settings → Actions can require any Action per person, so a caller-owned dialog would double up).
Reversible or recoverable writes (stage, unstage, commit, commit revert, undoing the last commit,
branch create and checkout, remotes add, edit and remove, publishing a branch, worktree create,
opening a pull request, publishing or initializing a repository, continuing a merge or rebase, stash
create, apply and pop, fetch, pull, push) declare `approvalPolicy.uiConfirmation: 'direct'` in
`scmGitActionSpecs.ts` and have no dialog of their own. Irreversible writes (discard, merge, rebase, skipping a
rebase step, aborting a merge or rebase, stash drop, worktree removal and pruning) keep the single
in-place confirmation, each with a plain title and an `approvalPresentation` summary so the dialog
says what will happen instead of repeating the title. UI callers must not add a second dialog in
front of either kind.

Remote pull and push are `direct` by default, and two inputs make the executor's one in-place
confirmation apply. The person's 0.2 `scmRemoteConfirmPolicy` preference (Source Control settings;
`always`, `pull_only`, `push_only`, `never`) is the UI default confirmation of those two Actions:
the UI host's approval hook (`isActionApprovalRequiredByAccountSettings` in
`sync/domains/settings/actionsSettings.ts`, the one resolver for the executor and for UI predictions)
asks for a present person's UI press unless the Action is set to Allowed or the caller already
recorded the person's answer to this exact press (`confirmedByPerson` on the SCM facades becomes
`presentUserConfirmation`; used when a pull choice dialog or a pull-then-push already asked). A force
push with lease is input-confirmed by the spec (`uiConfirmationForInput`), whatever the preference.
`executeScmRemoteOperation` and its callers hold no confirmation; a declined press returns
`declined` and stays silent, and the pane's busy label ("Pushing to origin/main…") starts only when the
admitted Action reaches the Machine (`onDispatched`, a surface-local notification of the UI SCM terminal),
so it never shows behind the dialog and never for a decline or a waiting approval. The shared
mutation runner (`runSessionScmMutation`: merge, rebase, abort, remote edits, commit undo) uses the
same notification: its operation lock waits `queued` (`deferRunning`) until `onDispatched`, and every
other direct SCM caller (commit, stage, revert, stash, pull-request compose) treats a declined or
waiting result with `isScmActionNotRun` instead of an alert. Settings → Actions
reads the same resolver, so a `Default` pull or push row says it asks because of the Source Control
preference. An explicit Ask first in Settings → Actions is the Action's own approval
request and replaces, never adds to, the in-place dialog. Not confirmations of the write itself, and so
not covered: index-lock recovery, the stash-overwrite choice, the push-rejected fetch offer and the
default-branch remediation are offers or choices the app makes after a failure or before a distinct
decision.

A declined confirmation is the person's answer, not a failure. `isActionApprovalDeclinedErrorCode`
(`actionExecutionResult.ts`) is the one predicate over `approval_rejected` and `approval_canceled`;
UI callers that treat the two alike use it rather than comparing codes. The SCM facades return it as
`{ success: false, declined: true }` (`normalizeUiScmFacadeResult`; `COMMAND_CANCELLED` is only the
closed-vocabulary placeholder, because nothing ran), and `isScmActionNotRun` is how SCM callers
stay quiet. A created approval request (Ask first) is the same kind of quiet result:
`{ success: false, awaitingApproval: true, approvalArtifactId }`, announced once by `invokeUiScmAction`
as the neutral "Waiting for your approval" presentation notice with a Review action, never as a failure
alert, for every SCM write. The shared mutation runner (`runSessionScmMutation`) returns it without a log entry,
refresh or retry, so no outcome line, banner or alert follows; callers that present their own
failures check the same predicate before they alert. Callers that deliberately word rejected and
canceled differently (Team sign-in, API tokens, Session board, Team settings) read the code itself.

In 0.3 development, aborting an ordinary blocking approval wait returns `cancelled`
to its original caller and retires that waiter without executing the Action or
withdrawing the durable approval. Explicit human Reject and Cancel decisions
retain `approval_rejected` and `approval_canceled`. A host-retained intent that
owns withdrawal keeps its existing approval-cancellation transition.

In 0.3 development, declared Settings feedback follows the same quiet-decline contract. The scoped
plugin Settings adapter preserves it as `status: 'declined'` for Account and daemon writes, including
secrets. The record and field owners release their pending state and retain the draft and last saved
value; they do not turn a refusal into transport failure or trigger recovery reads. A failed write,
disabled Action, unavailable target or unknown outcome still uses its normal failure presentation.
Mounted value-parsing clients use `useMountedActionExecution.executeValue`: the existing continuation
waits for the original approval's terminal receipt before exposing domain data. The unmounted value
adapter throws a typed `HappyError` for pending custody or a failed Action, preserving its code and
details rather than passing an approval request to a domain-result parser. Neither adapter replays
an effect; the approval execution owner retains that authority.

In 0.3 development, a lost terminal approval-write acknowledgement triggers one
read of the original approval receipt. Only an exact persisted terminal request
settles the live result. An absent, unreadable or different receipt remains
`approval_execution_outcome_unknown`; it never authorizes replay of the effect.
An initial approval-write failure likewise reads the receipt once: only the exact
persisted approved request continues through the existing execution claim and
live custody; an absent, unreadable or different receipt preserves the original
typed failure without performing the effect. A generic `action_failed` storage
failure becomes recoverable `approval_context_unavailable` because this invocation
has not attempted an execution claim; deciding the same approval again uses the
existing claim owner.

In 0.3 development, approval detail and transcript cards read nested domain failures through
`readApprovalExecutionFailure`. An executed receipt can record successful Action dispatch while
its catalog-validated output reports a failed effect. The reader projects the typed code and
message for the existing failure formatter without rewriting history or exposing opaque result
details. Machine conflict and plugin review outcomes retain their family-specific interpretation.

For original Account and terminal Session Actions, an outer Machine target selects the daemon
that opens the encrypted input. The existing input reconciliation then resolves the Session target,
and the daemon signs that resolved target for Home verification. Issuance, principal currentness and
resolved-effect verification share the Session-target admission owner: explicit or resolved Sessions
still require the current Account/Session/Machine access relationship. A Machine placement alone
does not grant access to a Session. Offline Machines and mismatched daemon installations remain
unavailable at the dispatcher.

In 0.3 development source, an accepted Session Action retries temporarily unavailable
requester Home reads while acquiring its requester context, checking Session ownership,
and preparing Home authorization. These reads use the shared Home-offline delay policy,
and cancellation interrupts the pending delay. The admitted request's cancellation and lifetime own
that recovery; preparation does not add a separate deadline or attempt limit. Each retry
reads current authority again. The Action executor runs once after preparation succeeds;
an effect failure is not replayed by this recovery path. Callers without an admitted
request lifetime retain their existing failure and recovery policy.

The final requester currentness check before runner launch retains a classified temporary
Home outage as the bounded `requester_home_unavailable` spawn detail. The Session-spawn
Action projects that cause as `target_unavailable` with `retryable: true`; it does not
replay the launch. A revoked admission, unavailable handoff custody, or genuinely missing
daemon capability keeps its existing refusal or incompatible-target result. Cancellation
keeps the existing spawn disposition: a submitted request whose outcome is unknown remains
pending with the same creation key; cancellation is reported when no such custody remains.

The resolved Session transport reads the requester's persisted Account encryption currentness
under that same signed invocation, without borrowing the daemon's bearer.

In 0.3 development, the shared CLI Session transport adapter uses the canonical endpoint-error
classifier to expose currentness transport/service failures as `server_unreachable` and
authentication refusals as `not_authenticated`, before generic Action failure normalization.
Invalid successful responses and Account encryption domain refusals retain their original
failure evidence, separately from unavailable Session encryption material. A failed preflight
does not enqueue input or resume the Session. The caller may retry explicitly with the same
input localId after recovery; this adapter adds no retry policy or effect replay.

Session HTTP purposes reuse each route's existing Action and Session selector. Every declared Session operand retains
the captured PAT resource ceiling and current Machine access relationship, even after the PAT's
current grant expands. Operand projection applies to native mutations too; it does not itself admit
an operation. Session access retains the captured PAT grant unless the signed owner has proved all
declared Session operands. Declaring an operand for a previously closed route preserves its Runner
exclusion with `allowSessionRuntime: false`. Read roots may compose bodyless GETs on declared Session readers under
ordinary Session access; mutations require the actual declared effect or an explicit native
purpose on its admitted target. Unmatched signed purposes fail closed for every credential kind.
Ordinary PAT roots cannot substitute unrelated effect ids. Existing composite PAT roots
(`approval.request.create`, `action.invoke`, or a qualified plugin Action) may resolve a native effect,
which must still match its canonical transport and authority. Explicit native phases retain their
named child read effects.
In 0.3 development, public-profile preparation retains its signed root while
reading the captured Account's owner record. Snapshot preparation reads only the
typed `public_eligible_personal` Usage population, including its preceding-period
comparison; it receives no quota grant or all-personal-history fallback. Prepared
publication writes use their existing closed transport schemas and exact paths,
not the caller-facing intent grammar. Current Account/source admission and the
ordinary Action approval policy still apply to every operation.

Profile editing reuses those existing Actions: preview accepts explicit draft
field, metadata, period and presentation inputs; update applies reviewed changes;
publish makes the selected edition public. `settings.get`/`settings.set` with
`target.kind: 'public_profile_draft'` address the answering client's mounted Look
draft, not the published record or ordinary Account preferences. Named layouts
and presets use `widgets.area.layout.*`; selecting or editing a draft is not
publication. Plain-language Action discovery searches these declared operations
without adding authority or new profile-editing Actions.
Routes that act on several Sessions declare every operand through the same binding owner; a Follow
source write proves both source and destination. Manager assignment declares the child, new manager and expected
manager; only an explicitly nullable operand may omit a Session with `null`, so detachment remains valid
while missing or malformed operands fail closed. Signed requests, direct PATs and Runner binding use
the same operand projection. Native Account transports (including deletion, organization assignments,
access grants, responsibility, read state and public links) declare their actual Action and Session
selector at the route, before handlers run. Session-list collection phases without a named Session require
captured Account-wide resource access. Specialized native-purpose restrictions still apply before
shared feature discovery. Signed Pending admission uses its exact socket event (including the existing Execution Run epoch), while ordinary RPC effects
retain the Machine RPC catalog. This is development-source behavior; loaded-runtime validation is separate.

In 0.3 development, Protocol owns the exact empty `502` acknowledgement-loss
response classification for original-Account HTTP dispatch. The UI reader retains
its existing `outcome_uncertain` result and the CLI reader its `outcome_unknown`;
malformed responses and typed pre-dispatch refusals retain their separate results.
Uncertainty does not authorize another invocation. Installed-plugin controls
retain the exact target for their existing read-back recovery rather than
reporting an unknown mutation as Done or replaying it.

In 0.3 development, the global HTTP error owner also classifies database
rollback exhaustion and connection unavailability for the external Action route.
That route returns HTTP 503 through its strict outer error envelope with
`database_transaction_conflict_exhausted` or `database_connection_unavailable`;
it does not turn these known failures into `internal_error`. Account-placed
managed Actions retain the confirmed rollback code from their native Home HTTP
response. This classification adds no retry or replay permission.
The failure vocabulary is an unreleased 0.3 source-contract correction; load the
server and consuming Protocol closure together rather than treating the added
codes as compatible with an older closed reader.

Unexpected Action exceptions in 0.3 development return the original request ID.
A managed admission failure returns `action_not_admitted` only when it occurred
before write submission and the admission lookup confirms no retained allocation. A retained allocation,
an unavailable admission check, an uncertain transaction completion, or a daemon
execution exception returns `action_outcome_unknown` instead;
callers must inspect current state before trying again. The existing server and
daemon log owners record Action/request correlation, phase, allowlisted error
class/code, and source callsites without exception messages or Action input.
Source frames are selected only after the complete rendered exception message;
unrecognized stack headers contribute no frames. The UI and CLI HTTP adapters
preserve the schema-validated, request-bound ID in Action failure details.
These codes extend the same unreleased closed HTTP vocabulary and require the
server and consuming Protocol closure to load together. Log retention is owned
by the existing destinations; a correlated response does not guarantee that a
rotated server log remains available.

In 0.3 development, skill writes declare an explicit approval input projection
separate from their identity-only observation projection. The deciding user can
review the name, reach rules and file changes: text files show their decoded
contents, while binary files show their path, kind, size and mode. Replay keeps
the original schema-admitted operands. Agent, CLI and MCP creates and installs
still ask by default through the existing Action approval policy.

In 0.3 development, Project setup effect review uses the `projects.prepare`
approval default and its original surface's waiver. Waiving review permits only
that invocation; it writes no remembered Project trust and grants no agent
authority to approve setup. Explicit human trust decisions still bind the
current Project and effect. Service Move and public-link controls consume the
same Action policy and read the targeted Home's settings. Service Start/Restart
effect review also follows the invoking Action's policy; waived review still
captures and revalidates the current effect before launch. An explicitly supplied
stale effect digest remains a refusal, not an approval that policy can waive.
Declared Service Start approvals in development source retain a native-produced
`preview.serviceStartReview` before publishing the ordinary approval Artifact.
It binds the unchanged signed request to the exact Machine and checkout, copy
effect, Start effect and any required setup review. Approved replay remeasures
that effect at the same native owner and supplies reviewed setup through the
existing one-time setup decision port; it writes no remembered trust. Missing
native review, unavailable target bytes or changed placement/effect refuses
without publishing an input-only approval or copying files during review.
Worker/Auto requests retain their addressed Machine through approval and replay;
pool membership is rechecked without reranking the approved destination.
Issuers outside the daemon obtain this read-only native review through the
existing launcher snapshot transport. A missing review response fails closed;
the transport does not execute the copy, setup or Start.
Admitted Local Services Actions supply the raw transport's
acknowledgement or confirmation nonce after approval routing, including when
the user waived approval; those fields are not another approval policy.

The setup control opens the captured Home's approval when Ask first applies.
Passive `projects.inspect` carries requester admission on the user's own Machine
as well as shared targets, so setup readiness reads the same target-local success
as execution. Its optional `setupReview` comes from that same passive review;
the approval producer consumes it into `preview.setupReview` without serializing
the executable plan or secret material. Commands, native tools, declared non-secret
config values and binding labels remain target-produced facts. An explicitly
stale effect basis returns `project_setup_effect_changed` before creating an
approval Artifact. This contract is development-only.
Approving “This time” runs the reviewed setup without writing Project trust.
For a held operation, Scripts, Services setup and Session reviews address
`projects.prepare` with `heldOperationId`, the actual target checkout and
`expectedEffectDigest`. Its retained review producer remeasures current SOURCE
and copied target inputs, then consumes This time or Skip inside the original
reservation. It admits no second preparation and writes no Trust row. Skip
records no target setup completion; a skipped Service setup declines its waiting
Start. Changed inputs remain held and cancellation cannot be reversed by a late
decision. Agents may request Until it changes through `projects.prepare` with
`consentScope: 'untilChanged'`, the exact `heldOperationId` and reviewed
`expectedEffectDigest`. `workspace` names that retained operation's actual target
checkout, including a worker target, rather than reconstructing it from SOURCE.
This is a request for a present person's decision in the
ordinary approval card/Inbox flow, even when invocation approval is waived.
Approval runs in the approving app and delegates to the same
`decideProjectSetupConsent` → `rememberReviewedProjectEffect` → approving-Account
Trust CAS writer as the UI button. It remeasures the retained target review
before writing; a changed digest is not covered. Agents cannot approve their own
request, and rejection, cancellation or an expired/stale request remembers
nothing. Ordinary preparation, This time and Skip retain their Machine owner;
the native preparation RPC cannot write remembered consent. This is undeployed
0.3 behavior, refactored in place without a compatibility alias or second writer.
Exact current target completion can still satisfy another same-digest hold
without repeating setup effects.
Ordinary `actionOperation.get.v2` reconciliation returns its retained snapshot
while a setup review refresh runs. Human review readers explicitly request
`refreshSetupReview: true` and await the current producer before deciding.
Stop approval opens through the same captured Home; awaiting that decision is
distinct from a dispatched Stop, and terminal snapshots clear the stopping state.

In 0.3 development, a spec may declare `safetyForInput` for a validated,
field-sensitive approval default. The approval-policy owner consumes it after
explicit settings; discovery retains the conservative declared safety. Provider
connection updates use this for display-name edits. Malformed input and updates
to routing, credentials, slots, placement or helper models retain danger by default.

The same owner resolves `settings.set` and `settings.reset` from the selected
built-in declaration. A reversible personal preference explicitly declares
`agentSafety: 'safe'`; an omitted declaration policy, unknown anchor, sensitive
setting or present-person-only setting retains danger. List density and
navigation placements use this declaration-owned default. Inputs cannot supply
their own safety, and explicit Settings → Actions approval choices still win.
`settings.invoke` retains its declaration's operation approval policy. These
defaults do not change setting value validation, surface restrictions or
execution authority.

The development-only `session.list.statusWords` declaration is a safe personal
Account preference, defaulting to `false`. Sessions/Runs, Workflow and Discussion
work columns share its `sessionListStatusWords` value; UI readers use the existing
`useSetting` hook and controls use the canonical `settings.set` writer with that
anchor. `settings.reset` restores icon-only status. There is no per-column store.

Model favorites use the safe Account Action `models.favorite.set`, with an exact
favorite selection and a membership boolean. UI stars and daemon/Agent callers
share the Protocol favorite carrier/merge owner and Account settings CAS. Native
and Provider selections stay distinct; unreadable retained entries survive.
`session.model.unarm` is safe and asks the running Session's model-transition
owner to restore its applied selection. It writes through the same intent queue
as model selection and does not send a message or restart the Agent.

In 0.3 development source, `sessions.spawn.capabilities.preview` reads both
skills and MCP servers through the selected Machine's existing preview producer.
Temporary-computer drafts use the same Action with the captured Account catalogs;
their Machine platform and native skill delivery remain unknown until materialization.
Preview admits Profile skill seeds through the same Profile reader as fresh
Session creation; explicit Session exclusions still win.
When Agent `session.spawn_new` names an explicit launch Profile without a Role
override, that Profile is checked before Agent-start hydration. A missing Profile
returns `target_unavailable` with
`details: { code: 'target_unavailable', reason: 'profile_unavailable' }`, including
through MCP. Authored Profile lookup uses the current catalog and granted
Artifacts without reading remembered built-in visibility; built-in lookup retains
that evidence requirement. Home authorization, currentness and authoritative
catalog reads still precede this decision, so it is not a local no-read refusal.
`session.capabilities.get` reaches that same Machine producer after resolving
the owned Session, so an online Machine can answer for a stopped Session.
Preview preparation uses the containing Action's cancellation lifetime in both
the app and CLI. A real preview deadline returns `preview_timeout`; it does not
establish that the Session is unavailable. The app retains its existing check
failure and Retry presentation.
`session.capabilities.set` writes the Session's desired item override and applied
baseline through the metadata codec inside the current tuple's CAS mutation.
The Action captures the prior desired selection for Undo; an intervening desired
selection edit refuses with `conflict`. Runtime acknowledgments and unrelated
metadata updates are preserved by applying the edit to the writer's fresh snapshot.
The write can
land while its Machine is offline. Its spec declares a reversible direct
present-user UI effect; Agent, CLI and MCP callers ask by default through the
existing deferred approval owner. Optional `reason` is a review operand and
does not change the effect. Undo sends the returned previous override through
the same Action. Agent-created skills use that same Session include writer.

<a id="session-origin-defaults-on-approval-replay"></a>

In 0.3 development source, approval replay keeps the original caller projection
on its host-only replay reference: an omitted skill reach defaults to the creating
Session even when another device approves. Execution authority stays with the
approving person, and an explicit approved `where` wins. A person's focused
Session alone does not change the Everywhere default. Direct Agent widening
still uses a separate rules Action. The former MCP-only Session
write Action and UI metadata publisher are retired in place.

For attached Runs, `execution_run_child_choice_required` carries a strict
`details.childChoice` projection and `noRunCreated` evidence. Callers may start
a new `execution.run.start` attempt with `childSelection: 'agentDefault'`, or an
explicit exact model selection. The host resolves Account defaults for the child
Agent; an unavailable default snapshot refuses. Omission still inherits applied
parent state. Choice projections do not authorize credentials or model execution.

In 0.3 development source, discover `execution.run.start`'s `intent` options
before choosing its retention, Run class and I/O mode. Each option describes
its purpose and the accepted values for all three fields, projected from the
shared [intent policy matrix](../packages/protocol/src/execution/runs/intentPolicyMatrix.ts).
Use `delegate` for ordinary bounded child work; `voice_agent` serves an ongoing
Voice conversation and requires its retained streaming combination. MCP,
Agent, UI and friendly CLI discovery consume that same projection. A policy
refusal before Run creation retains `execution_run_not_allowed` and reports
`details.executionRunStart.runCreation: "noRunCreated"`, with content-free
`details.issues` naming every incompatible field and its intent-specific
accepted values. Missing or malformed creation evidence remains
`outcomeUnknown`; callers must reconcile that outcome before considering a
fresh start.

| Decision or fact | Owner |
|---|---|
| The Action registry: every row, its schemas, surfaces, safety and approval | `packages/protocol/src/actions/actionSpecs.ts` |
| Canonical Action input/result contracts | Runtime schemas reached by `packages/protocol/src/actions/actionSpecs.ts` |
| Generated validator-neutral SDK Action DTOs | `packages/plugin-sdk/scripts/generateActionTypeMap.mjs`; SDK family modules and the aggregate are outputs |
| Explicit schema/DTO type and catalog correspondence gate | `packages/protocol/src/actions/pluginActionDtoCorrespondence.ts` |
| Portable SDK Action declarations and publication currentness | `packages/plugin-sdk/scripts/generateActionTypeMap.mjs` |
| Surface-independent metadata vocabulary (surfaces, authority, placement, tool exposure) | `packages/protocol/src/actions/metadata.ts` |
| Discovery projection and serialization for external consumers | `packages/protocol/src/actions/actionCatalog.ts`, `.../actionDefinitionV1.ts` |
| Execution: input parse, authority admission, approval routing, output settlement | `packages/protocol/src/actions/actionExecutor.ts` |
| Admitted client-Action delivery | `apps/cli/src/session/actions/clientActionReverseDispatch.ts` through the existing connected-client reverse RPC |
| Waiting-host completion after launched runs (development) | `packages/protocol/src/actions/actionCompletion.ts` |
| Approval result classification and ActionId completeness (development) | `packages/protocol/src/actions/actionApprovalClassification.ts`; independent census in `actionApprovalClassification.test.ts` |
| Whether an invocation needs approval, and which approval flow | `packages/protocol/src/actions/actionApprovalPolicy.ts` |
| Approval operand review and typed execution-failure presentation | `packages/protocol/src/actions/actionApprovalPresentation.ts`, `packages/protocol/src/approvals/approvalExecutionFailure.ts` |
| Effective invocation authority and terminal policy composition | `packages/protocol/src/actions/invocationAuthority.ts` |
| Credential decision admission | `packages/protocol/src/actions/decisionAuthority.ts` |
| API-token action, target, model, mode and origin grant | `packages/protocol/src/auth/apiTokenGrant.ts` |
| Friendly CLI command projection | `packages/protocol/src/actions/actionCliProjection.ts` |
| CLI presentation, including demoting an ineffective success | `apps/cli/src/cli/actions/commandPresentation.ts`, `.../executeCommand.ts` |
| Machine-RPC route class for an Action-bearing method | `packages/protocol/src/machines/peer/mediation/rpc/routePolicyV1.ts` |

In 0.3 development, `action.spec.get` returns input schemas, hints and examples.
Agent, MCP and CLI discovery expose shared definitions as named `schemaSections`;
read a definition with the same Action `id` and its `schemaPath`. The response's
`schemaSection.schema` contains that definition's root; nested definitions have
their own advertised sections. Its local references
still resolve against the original `inputSchema` or `outputSchema` root, rather
than the section itself. Reattach the listed definitions before compiling the
schema with a JSON Schema validator. No fields or allowed values are truncated.
Tools omit outputs by default; `includeOutputSchema: true` includes their section
index, and a `/outputSchema/...` section read includes outputs automatically.
UI/API retain full, self-contained schemas and outputs by default.

Native Agent descriptors and Session MCP discovery also reuse document-local
references within each complete input schema in 0.3 development. The shared
Zod projector owns that reuse; the native adapters preserve their existing
JSON Schema dialect and object-root presentation. Repeated schema nodes are
advertised once rather than copied into every occurrence. Tool availability,
accepted operands and authoritative Action/plugin validation are unchanged;
authored plugin JSON Schema references remain attached to their definitions.

Session-bound discovery also returns `invocationContext.sessionId` and, when the
Account scope is available, `invocationContext.widgetSurface`. Session Board
Actions fill an omitted `sessionId` from that invoking Session. Widget Actions
require an explicit qualified surface: use the returned surface for that Session
Board, or retain its Home/Account ids and choose `owner: {kind: 'home'}` for Home.
These references grant no access; the existing scope and target checks still run.
Do not guess a Home id from a hostname or a local server-profile id.

There is no server-side Action executor. Three hosts execute: the UI executor
(`apps/ui/sources/sync/ops/actions/defaultActionExecutor.ts`), the daemon executor
(`apps/cli/src/session/actions/createCliActionDeps.ts`, which also serves the CLI, Agents and
MCP), and the public API's relay to a daemon. A server-owned Action declares its Home path on
its spec row and the family clients build their requests from that declaration — see
`serverTransport` below.

In 0.3 development source, the UI host binds authenticated invocations to the explicitly
selected Home, or captures the active Home when the caller supplies none. It derives
authority from that Home's credential provenance and supplies an attempt request ID
for Account- and terminal-credential UI and Voice calls, preserving an existing request ID or creation key. Both
execution and preparation use this owner. UI domain clients do not generate approval
origins; the Protocol executor still validates strict provenance and enforces approval
policy before any effect. Voice model calls, like Agent and plugin calls, retain
automation authority even when carried by an Account credential. Dangerous Voice
effects require the canonical Ask-first approval by default; only a human control
can decide the request. Managed native Actions relay through the existing Account
transport with its automation authority ceiling, so their installed native Action
owner creates the shared approval request and executes its human-approved replay.
That signed Account approval origin retains `account_automation`; neither the
carrier's UI ingress nor its Home signature turns the Voice model into a human.
The server preserves the authenticated lowering ceiling on both direct Account
origination and re-entry through an already-signed root.
An attempt ID does not upgrade authority: terminal credentials retain automation
authority on UI, can request policy-required approval, and cannot decide it. The
approval UI preserves `present_user_required` and directs the person to an Account
sign-in on this Home or another device with that sign-in. Content-key custody and
Home ownership do not supply present-user authority.

Before Account sign-in, the app host can bind a present-user interaction to an
exact writable built-in device-local Settings declaration. This requires the
canonical Auth owner to report no installed credential, no active Account,
and a current local mutation owner. The host supplies that bounded fact to the
same invocation-authority resolver; caller context cannot supply it. It does
not promote terminal, API, plugin or Agent credentials, authorize Account
settings, or override an explicitly narrowed caller or the Action's Off/Ask
policy.

Original remote paired-terminal approval decisions retain the automation ceiling.
When that ceiling refuses a decision, Home reports `credential_scope_denied`
rather than declaring the authenticated credential invalid. Local terminal policy
and an authenticated Account's approval flow retain their existing authority.

The development CLI executor retains its captured Home endpoint throughout
preparation, execution and approval continuation or replay. Session lookup,
Account encryption currentness and subsequent control RPCs share the same
invocation-local Home scope; this does not change process configuration.

In 0.3 development source, an admitted operation-bearing Action enters the
installed host's `runActionOperation` port after approval, immediately before
its native effect. Direct execution and approved replay use the same terminal
boundary and the incumbent Machine operation runner/store. An already observed
same-Action invocation retains its acceptance; the approval decision itself
does not supply operation custody. The plugin after-hook `observeActionExecution`
remains diagnostic and cannot create that custody.
Machine RPC carries the same private runner port into admission instead of
starting an operation around an approval request. Native Session lifecycle
adapters consume that port at their effect boundary as well.

Prepared filesystem upload, download and copy therefore retain the requester's
operation through acceptance and actual transfer settlement. The host keeps the
requester's private ports alive until the effect finishes. Download result
custody still requires the original live caller; the exact-daemon decision wakes
that blocking continuation. Replaying an Artifact cannot recreate a lost byte
destination. A prepared transfer reached without an actual operation owner still
refuses with `FILESYSTEM_OPERATION_OWNER_REQUIRED`.

In 0.3 development source, an approval whose custody requires its exact daemon
cannot replay without a Machine in its captured execution origin. The Protocol
approval executor settles that request as `failed` with
`approval_origin_unavailable` before any effect or replay dispatch, including a
request previously left `approved`. The message explains that the origin is
unavailable and the request must be submitted again from the originating daemon
or Agent Session. A standalone CLI's Session-placed pending output states this
prerequisite before the user approves; JSON retains its pending envelope and
prints the prerequisite on stderr. Account-owned approvals that the existing
custody policy permits the approving app to execute retain that path.

Blocking live-only results follow the admitted approval request's flow, including
the required-result default when the authored spec omits `flow`. They resume the
original daemon invocation so its caller receives the full typed result; approval
history and the deciding app retain only the Action's observation projection.
Deliberately deferred proposals keep their existing deciding-user result path.

In 0.3 development source, ordinary results retain their complete typed receipt
in the existing private approval Artifact so an original caller waiting on another
host can receive it. Blocking flow alone does not imply live-only custody.
Public approval reads, decisions and execution observations still apply the
Action's observation projection; explicitly declared live-only results remain
excluded from durable custody.

In 0.3 development source, Machine preset, pool, managed-machine, worker-setting,
service-placement and operation Actions
declare review operands on their spec producers, including exact targets,
revisions and structured configuration. The Protocol approval presenter derives
operands without editor hints from the Action's canonical observation projection
when one is declared, otherwise from its input schema, and preserves hinted labels
and typed references. Durable requests still validate the full captured invocation;
an intentionally omitted observation operand does not waive its replay requirement.
Declared review hints retain their intentional omissions, including private retry keys.
In 0.3 development, declared select and multiselect options can carry a `labelKey`
alongside their portable `label`. The shared approval presenter carries the selected
labels and keys to every approval surface; the UI resolves known string keys through
its translation owner and otherwise keeps the authored label. Enum values remain
the executable operands. Managed-machine references prefer the enrolled Machine's
canonical display name in the approval's Home, falling back to the authorized launch
name before enrollment or when that Machine is unavailable.
A domain can declare `approvalPresentation.projectInput`
for private review operands (such as a saved Profile definition) that its shared
`projectObservationInput` must omit. In development, `approvalPresentation.inputSchema`
validates a safe review shape when it differs from executable input, and optional
private `inputHints` describe that shape without changing Action authoring or CLI
fields. Approval preparation writes only this validated private projection to its
preview. Missing review context produces a typed
refusal consumed by both the Approve control and the executor. Settled private history retains the declared
`approvalPresentation.projectInput` when the spec declares `retainInputOnSettlement`,
falling back to the observation projection otherwise. Rules and registry source
specs retain their review, as do capability mutations that narrow shared observations.
MCP review names its server, configuration, tool-policy changes and Where; literal
environment/header values and import text are omitted. Live-only import, adoption
and credential input custody remains redacted in `actionArgs`; only their safe
review preview persists, and execution still needs the originating continuation.
Settled Details reads the validated review schema without re-running Approve admission
or offering another decision; operands already removed from historical records
remain unavailable. Capability rule fields name the skill or MCP server, place,
and change through the existing spec hints and typed reference reader; exact
identities remain in Technical details. An executed invocation is not proof that
its domain effect succeeded: the shared failure reader validates Machine-family
results against their canonical output schemas and presents typed refusals,
conflicts and unavailable selections as failures. The durable execution receipt
and domain result remain unchanged; a refusal cannot trigger a success continuation
or hide the failure through completion navigation.

Native Agent tool approvals preserve the actual tool name and operands through
the existing host interaction and permission-policy owner. Safe Happier discovery
uses that policy; mutating Actions retain their permission-mode restrictions and
Ask-first effect approval. A native approval admitted without session persistence
uses the existing request-source carrier to enforce that ceiling before reusable
grant writes, including mediated responses. The permission footer offers only
valid decisions; an already-authorized session grant may satisfy the current
once-only request without creating or widening a grant.

In 0.3 development source, `session.status.get` also returns `pendingRequests`
from the shared Session pending-request projector. Each entry exposes `requestId`,
its optional `turnId`, `kind` and `tool`, without tool arguments. A null list means
the request content could not be opened; older status producers may omit it.
Answer a `permission` entry with `session.permission.respond`, preserving both
the exact request id and any published turn id. A current turn-scoped request
rejects an omitted or stale turn id. Answer a `user_action` entry with
`session.user_action.answer`; this Action does not approve native tools. Native
tool-call correlation and transient interaction custody retain their existing
host owners. These reads do not grant decision authority.

The development UI Account-machine transport preserves those host-stamped facts
inside the existing installation-key encrypted requester Account context. Its
closed private invocation carries caller provenance, input constraints and the
permission ceiling; none are public Action inputs. The receiving executor
combines that ceiling with authenticated credential authority after checking
the original root, installation and current requester custody. Missing required
provenance refuses execution, and a Plugin or API-token caller is never promoted
to a present user. Session-placement reversal retains the resolved Session target
without discarding the original admitted Machine root.

Same-Session Agent changes use this one Action owner, not a parallel raw mutation
RPC. Their installed-source signed lifecycle, cutover and input effects retain
the original authorization. The server verifies the root, grant and signed
effect; opaque E2EE request semantics remain the decrypted coordinator's
responsibility. Context reads retain ordinary Account access, while API-token
grants are evaluated against the actual requested Session, including fork
ancestors; unavailable required lineage is refused before stopping the source.
The installed RPC signature binds the exact private requester box, so replacing
its encrypted invocation invalidates the signature. Daemon and Session runners
reuse the same installed requester-preparation lifecycle. A verified API-token
root already supplies its own provenance: finite Session effects retain that
captured grant and automation authority without fabricating requester Account
custody. Account-root UI/Plugin effects still require private caller provenance.
This describes development integration, not released availability.

In 0.3 development source, Actions Settings retains each contributed Action's
danger and confirmation facts from the selected daemon's typed projection. Its
surface default uses Protocol's `pluginActionRequiresPresentUserIntent`, the same
owner as the daemon gate; shared Actions policy then applies explicit requirements
and waivers. **Default** clears the surface override, **Allowed** waives it, and
reset restores the manifest default. Non-safe Actions require confirmation on
UI, Agent, MCP, CLI and API by default. `confirmationWhen` is the sole portable
declaration of conditional confirmation; its canonical owner is shared by
discovery, Settings and invocation. A flat input predicate applies on every
surface; `{ presentUserUi: false }` skips the default only for the host-proved
present user's UI operation, retaining automation defaults. The scoped value
also accepts an input predicate. `writesLocal` alone does not assert that an
operation is reversible. Explicit Ask and surface waivers remain user policy;
conditional defaults do not grant human authority. Plugin/background defaults
remain unchanged.
The scoped form also accepts `default: <input predicate>` for the other
requesters. This lets a mixed read/write Action retain safe read operands and
automated write confirmation while `{ presentUserUi: false }` makes its
reversible person-operated writes direct. Both predicates use the same parsed
input and canonical confirmation owner. Older strict manifest readers reject
this undeployed extension through existing compatibility admission.
These display facts do not grant execution authority. Qualified Action ids retain
their encoded dynamic route segment through workspace navigation so their Settings
controls remain reachable.

The development daemon projection ingress routes CLI, Agent and MCP callers
that need current intent through the existing target-Action approval Artifact
and decision observer. UI and Voice continue to carry the confirmation already
settled in their host. The connected machine binds the requester to its existing
installed Account runtime and Home; missing or changed custody fails closed.
Approval still rechecks the current Action policy,
input and source custody before the plugin handler can run; explicit Action
policy waivers retain their existing effect.

In current 0.3 development, the canonical plugin invocation owner normalizes
Action input before it is disclosed or fingerprinted. Dispatch uses that same
admitted value; deferred replay validates the saved normalized value without
running its transforming parser again. Currentness and policy are still checked
after the decision. The approval subject carries the manifest's declared secret
input paths and their declared labels. Declared-secret values and SecretString
carriers use the same `approvalInputCustody: 'live_only'` rule as built-in
Actions: the admitted invocation remains the sole blocking waiter and retains
the raw input; the Artifact holds only its redacted projection. The shared
presenter identifies confidential values with their declared labels and keeps
every public operand as an exact JSON literal, including quoted strings.
The existing exact-daemon decision path wakes that invocation; replay without
it returns `approval_stale` and never dispatches redacted input. Non-secret
plugin inputs return `approval_request_created` with their Artifact id immediately
on CLI, Agent, MCP and API. The existing exact-daemon replay retains the original
invocation surface and authority. A caller waiting with live-only input can find
its open approval through `approval.request.list` and inspect it through
`approval.request.get` from another invocation. Confidentiality comes from input
declarations or SecretString carriers, never diagnostic key spelling.
Host-retained UI/CLI operations can also block on approval while keeping
non-secret invocation state, such as a captured Composer submission. Only that
same live invocation, retained field or operation may resume a blocking request;
its retirement makes detached replay `approval_stale`. Ordinary deferred
proposals remain durably replayable after their usual currentness checks.
The presenter still withholds older
development requests without secret-path disclosure metadata; those requests
remain readable and rejectable and must be requested again to proceed.
The existing policy fingerprint binds the executable plugin version and input
declaration as well as policy. A saved approval cannot authorize a different
version or declaration at the same development root after a daemon restart;
replay returns `plugin_action_current_intent_mismatch`. Older development approval
fingerprints likewise require a new request. Managed and bundled source custody
and live occurrence checks remain part of admission.

In development source, built-in Settings approvals read the setting's human
title and description from the same declaration used by discovery and its page.
The exact anchor remains in Technical details; sensitive values are not added
to the summary. This presentation does not change approval or replay authority.

The development Settings summary groups the effective policy by app controls,
Agent tools and integrations, so “ask first” names who is asking. Mixed policy
within an audience is qualified rather than presented as universal. It derives
confirmation from the same policy owner (including visible UI placements) and
shows the contributed danger separately: destructive Actions cannot be undone;
remote writes and external side effects change things outside Happier. Disabled
Actions remain off regardless of their saved approval overrides.

In 0.3 development, contributed Action discovery, Settings keys and public Tool
`actionId` metadata share `pluginId/actions/localId`, formatted from the typed
contribution identity. Internal registry keys remain `pluginId/localId`; only
the existing daemon execution adapter translates at that boundary. Generic
`action_execute` admits a qualified Action through current `action.spec.get`,
without requiring a separate Tool declaration. Named Tools still use their
admitted catalog snapshot and contributor-occurrence fence. Both paths retain
the shared enabled/surface/approval owners; the external API `action.invoke`
admission and fixed API approval replay contract are unchanged.

## SDK Action declarations (0.3 development source)

### Report submission (development)

`bugreport.submit` reaches the answering client's existing report submission and
fallback owners. It retains Account-automation authority and the configurable
dangerous external-effect approval policy, including Ask first by default on UI.
Pending approval is not a submitted report; a refusal does not open a fallback
that could bypass the decision. A headless caller cannot manufacture the client
host or diagnostic collection for another Home.

The existing draft validator still requires `acceptedPrivacyNotice: true` when
diagnostics are included, even if approval is explicitly waived. That operand
records an acknowledgement, not proof of who supplied it. Review shows the
diagnostic selection and acknowledgement; raw submission operands and pasted
diagnostics use the existing live-only approval custody. Crash reporting and
replay retain their separate preference. These are unreleased development-source
contracts; registration does not establish loaded-client or released availability.

### Home and Team administration workflows (development)

These workflows describe unreleased 0.3 source. The generated
[host Action reference](../apps/docs/content/docs/plugins/api/host-actions.mdx)
owns the complete operation inventory, schemas, surfaces and placement; source
registration does not establish released or loaded-client availability.

Home administration reads governance and Team-creation eligibility, then uses
the existing People, policy, settings and audit owners. Policy edits carry the
reviewed revision and explicit widening confirmation where required. People
controls change roles or Account status, sign a person out, or request erasure;
an incomplete erasure remains distinct from success and is retried by the
authorized Home administrator. Home governance is independent of whether Teams
is enabled. An owner's claim and a person's own profile use their separate
authority boundaries.

Email configuration uses the registry-backed Home settings writer, including
explicit write-only secret replacement or clearing. Mail readiness reports
transport and link readiness; Send test email is a separate outward effect
whose typed result reports delivery or its failure class. Data retention uses
that same settings writer, while the dry-run Action observes what the current
retention rules would delete without deleting it. Effective settings preserve
deployment precedence and distinguish pending restart values from applied ones.

Managed OIDC setup creates a disabled provider, saves revision-checked
configuration and a write-only client secret, validates discovery, and then
uses the existing test, enable/disable and removal-preview/removal operations.
Team setup binds that provider through the Team connection owner; Home setup
uses the Home scope. Home WorkOS adapts the same connection, Admin Portal,
reconcile and verified-selection workflow to Home-qualified Actions. Directory
sync remains a Team workflow. An Admin Portal link is sensitive live delivery,
not an ordinary public member sign-in URL.

Directory-source removal has an exact API/SDK automation exception. Its separate
preview is a read; execution remains dangerous and follows deferred approval,
original-principal replay and current Team/source authorization. The generated
SDK exposes `actions.teams.directory.sources.remove.preview(...)` and
`actions.teams.directory.sources.remove.execute(...)`. Sibling directory
mutations retain their declared present-user authority.

Managed GitHub App setup shares one Home/Team-owned registration path: manual
configuration or manifest-assisted setup, revision-checked updates and key
rotation, installation verification and removal. Keys remain write-only.
Connection/provider administration retains each Action's declared human floor
and ordinary approval custody; requestability never grants an Agent human
effect authority. External Group mapping mutations retain Account-automation
authority and the canonical consequential-Action approval policy.

Team credential administration shares the canonical resource, audience, policy,
limits, test and usage owners. `teams.credentials.preparation.get` observes only
aggregate direct-access readiness and pending counts; internal credential census,
recipient bindings and envelopes remain with their encryption/delivery hosts.
It is separate from encrypted membership-history preparation. External-key
creation and invitation creation/reissue retain one-time human live delivery.
Credential metadata, broker policy and audience saves use the direct
present-user UI default. The credential editor's draft owner still reviews
actual direct material disclosure and disclosure-ceiling widening before
accepting that draft. The Action does not infer disclosure from a nonempty
audience or reconstruct its previous audience.

`teams.members.history.preparation.get` observes recipient readiness and
actionable work through the existing encryption host. Its aggregate exception
counts reveal neither Session identities nor envelopes. The client-placed
`teams.members.history.preparation.prepare` requests that same host's existing
prepare/retry operation, with mandatory present-user approval. The answering app
must hold the current recipient binding and encryption material; approval never
supplies keys or bypasses membership/access checks. Typed partial outcomes retain
the existing repair and retry workflow rather than reporting incomplete work as
success. Agent and MCP use connected-client dispatch; a headless caller without
the required encryption host cannot fabricate preparation.

The Account-placed `teams.credentials.usage.export` produces a CSV file result
from the existing authorized Team usage query and shared CSV/file-result owners. Its reviewed
query preserves the selected filters and cost provenance. An explicit
`breakdownRowCount` selects ranked rows corresponding to the UI's loaded pages;
an incomplete breakdown is marked `loaded_pages`, not silently expanded into
a complete export. The display-only resource name grants no access. Producing
the file result does not save or share it; those are the existing client delivery
effects. Access and captured Account currentness are rechecked before disclosure.
An installed signed executor may consume only the corresponding native usage
read under the export root's grant; the Home still authorizes the actor, Team and
resource. The signature binds the read bytes. The Home retains the parent input
digest, not its opened query, so deriving that read from the admitted export input
remains the trusted executor's responsibility rather than an independently
reconstructed Home comparison.

Leave Team uses `teams.members.leave` for the authenticated person's own
membership, including its last-owner and current-access checks. An accepted
leave refreshes the same directory and withdraws the former Team detail;
pending approval is not a completed leave. Native Group contribution removal,
directory reconciliation and Team removal keep their distinct domain owners.

### Your Account name and username

`account.profile.get {}` reads the authenticated caller's name, username,
avatar and profile observation timestamp through the existing self-profile
owner. It drops unrelated provider and credential projections, normalizes the
retained first/last-name representation through the existing name reader, and
accepts no other Account's id. It requires no Home-administration authority.

`account.name.set { name }` updates only the authenticated caller through the
existing Account profile route. Name is one optional free-text value: trim it;
an empty string or null clears it. This write is available on every Home and
does not depend on Friends. `account.username.set { username }` reaches the
existing username route and retains that Home's Friends and username policy.
Neither input accepts another Account's id. Both are write Actions with required
result-bearing, deferred approval metadata; the shared approval owner decides admission.
When approval is required, an Agent call returns the durable approval reference
immediately. Human approval replays the reviewed Account effect once in the approving app.
For a public `approval.request.create` proposal, the signed carrier retains that
authoring Action id. Currentness verifies the installed producer's signature over
the reviewed target Action and input; the approving app uses its own present-user
Home adapter for the effect.
The mounted UI follows pending approval through the existing approval notice and
applies a save acknowledgement only after the admitted write actually completes.
Account/Home retirement prevents that acknowledgement from updating another
Account's local profile.

`Account.name` is the canonical display value. Protocol's
`resolveAccountDisplayLabelV1` chooses name, then username, then null, never an
Account id. Identity linking fills only an empty name. Released profile, social
and direct-share clients still receive `firstName` containing the complete name
and null `lastName`; this compatibility projection does not split a chosen name.
The old storage columns remain read-compatibility data, not competing writers.
This is an undeployed 0.3 development-source contract.

`home.public_profiles.handle_reclaim` is a separate Home-administration identity
Action. It names the captured Account and exact current username, an audited
reason and the notice disclosed to that Account. The canonical username owner
withdraws the publication while retaining any operator restriction, clears the
name and disables provider auto-fill. It creates no voluntary-release hold.
The same transaction writes the Home audit and existing Account text-feed
notice (`public_profile_handle_reclaim` repeat key). A stale reviewed name
returns a conflict; replay after successful clear is a no-op with no second
notice. Default approval is waivable through ordinary Action settings but never
grants Home privilege. The rendered operator/owner flow remains integration work.

### Work authoring surface parity (development)

Role reads and mutations, including Account role creation, overrides and applying
roles to reporting Sessions, are projected to MCP through their existing Action
rows. Launch-profile publication likewise has an MCP binding. These projections
retain the existing authority and confirmation policy; they do not make a Home
family's withheld operations available by default.

Review verdict Actions declare the CLI paths `reviews comments list`,
`reviews comments transition`, and `reviews comments set-disposition`.
In development source, `review.apply` (`actions invoke review.apply` in the CLI,
`review_apply` on MCP) accepts a one-Session target and reviewed `{runId, findings}` sets. The
review card and external plugins invoke that same Action. It reloads the scoped
ReviewComments, including references reused from earlier rounds, selects current
accepted groups, and sends the canonical verify-first instructions through
`session.message.send`. Each reviewer retains its own evidence, thread references
and current comment CAS. Empty acceptance sends nothing; review and delivery
refusals remain typed. Applying does not itself write dispositions: the verifier
uses the existing ReviewComment Actions. The public SDK reviews entrypoint exports
the input schema and canonical verification renderer/instruction texts.
`session run ensure` projects `execution.run.ensure`, which is also exposed to
UI and MCP. Surface exposure alone does not prove that a UI control uses the
Action front door or that its host has the required dependency: those callers
must still migrate through the admitted execution path, not invoke its RPC
transport directly.

The free-form Run composer submits through `execution.run.start` after its
existing composer promotion and exact-target readiness checks. Its mounted
Account, protected launch selection, launch origin and correlation remain part
of that admission; an uncertain transport result still uses the existing Run
reconciliation owner rather than issuing a second start.

The Session Run detail controls and review follow-up use mounted Action admission
on the captured Home and Account. Resume supplies `resume: true` to
`execution.run.ensure`; cancel-turn retains the exact occurrence and turn ids,
and review follow-up retains its finding, thread and reply ids. Pending approval
is not a completed control operation. Account quiet-hours and device overrides
use their existing `settings.set` declaration anchors and setting owners.

In 0.3 development, bound Account-key and Account-owner settings can capture their
exact sparse mutation with `settings.set` and `reversal: { kind: 'capture' }`. The returned
receipt records raw presence and values, including objects and compound
mutations. Restore passes that receipt back with `kind: 'restore'` at the same
declaration. Both App and CLI use the shared
[`settingMutationReversal.ts`](../packages/protocol/src/actions/settings/settingMutationReversal.ts)
owner to check the affected current keys before writing; unrelated Account
changes do not invalidate the receipt. A changed affected key or different
Home/Account refuses the restore. Originally absent keys are removed, rather
than replaced with their effective defaults. Receipt versions describe the
captured transition; callers need not supply a global Settings version for Undo.
The App captures the writer's acknowledged raw transition after persistence
normalization, including Voice normalization. Declaration bindings still limit
the affected keys, and secret-bearing raw values cannot enter a receipt.

An Account setting can also return to raw absence without a prior receipt:
`settings.reset({ anchor: 'sourceControl.explainChanges', expected: { value: true } })`.
The expected value is the raw stored value, not its projected default. Compound
bindings accept `expected: { changes: [{ key, applied: { value } }, ...] }`, with
`{ unset: true }` for an absent raw key. The same reversal owner validates the
complete declaration-owned key set and compares current values on every Account
CAS attempt. Whole-key declarations return to raw absence; nested and compound
owners retain their sparse default mutation so sibling preferences survive.
The reset applies only while the affected raw values still match; unrelated
Settings writes can advance the Account version without blocking it.
Omitting `expected` retains the ordinary default-value reset.

In 0.3 development, Agent permission defaults, enabled state and executable-source
preferences use the declared `settings.set` anchors `agents.defaultPermission`,
`agents.enabled` and `agents.executableSource`. Their value is
`{ agentTargetKey, value }`; the existing Account Settings CAS owner rebases that
single-target intent while preserving other Agents. Per-Agent configuration/state
sharing uses `connectedServicesAgentSignIn.sharingPerAgent` with
`{ agentId, configMode?, stateMode? }` and the same catalog-backed privacy-intent
owner as default sharing. Caller-authored risk acknowledgements are rejected;
the admitted Settings Action supplies them after approval routing, including a
waiver. There is no second sharing-consent dialog or unwaivable approval floor.
Action approval defaults remain configurable and waivable. Experimental-model
confirmation uses its Provider Action's approval policy, with no second UI modal.

In 0.3 development source, goal controls use the Session runtime while it is
active and its recorded Machine's daemon while inactive. Setting an objective
wakes an inactive Session through the existing resume owner with `initialGoal`;
`resumeInactiveWithInitialGoal: false` saves it without waking. Status and budget
edits alone do not wake the Session. The legacy `daemon.sessionGoal.set` RPC
retains no-wake semantics; explicit wake uses the closed
`daemon.sessionGoal.set.v2` request. An older daemon's refusal is returned rather
than retried as a legacy write that would misleadingly report wake success.
Agent and automation calls retain their private execution authority through
resume; they cannot acquire present-user provenance by setting a goal.

`homes.reconnect` projects the focused Home's existing single-shot connection
recovery. It requires that Home to match the Action scope, does not change
device focus, and refuses a canceled request or a focus change during recovery.
The result acknowledges the retry; it does not claim a connected socket.

`connectedServices.pools.selection.get` distinguishes the persisted active
account from the candidate chosen by selection policy, including manual pools
with no candidate. `activeSince` is the persisted clock only when its account
identity matches that active account; missing or mismatched clocks are `null`.
Observation time and legacy switch timestamps do not stand in for this fact.
These are 0.3 development-source read projections, not a new selection writer.

`session.draft.append { sessionId, text, sourceSessionId? }` is a client-placed
intent on the Session's existing initial-prompt handoff owner. It returns
`{ status: 'appended', sessionId, createdAtMs }` only after the captured Account's
metadata write, or `{ status: 'unavailable' }` when that owner cannot accept it.
It appends to the destination composer and never sends a message. The Run-result
caller applies the existing template first and reveals/focuses the composer only
after append succeeds. This is a 0.3 development-source contract, not a released
availability claim.

`session.message.send` also accepts the development structured intent
`{ sessionId, kind: 'sessionSubagentCommand', command }`, where `command` is
the existing team-delete or teammate-shutdown payload. Protocol owns its text
and `subagent_command.v1` metadata projection; callers do not author the
private transport envelope. It uses the existing Session input admission,
immediate-delivery intent and receipt, not a separate Claude-specific Action
or native command transport. SDK Session handles expose the same semantic
arm with their existing required idempotency key and host-stamped caller.

In 0.3 development source, `machines.add.ssh.start` and the Add Machine UI
share SSH task admission and completion persistence. Start accepts either a new
target or `savedHost: { hostId, expectedRevision }`; saved references are bound
to that catalog revision and resolved by the existing credential owner, without
returning secret bytes. Supported authentication modes follow the selected task
runner. Successful completion attempts to save the host through the existing
catalog owner, without overwriting a later revision; persistence is best effort
and does not redefine task success. Live password and private-key entry remains
present-user UI, and existing explicit trust and provisioning prompt policies
are unchanged. This is not a released availability claim.

In 0.3 development source, `machines.local.service.status/start/stop/restart`,
`machines.local.service.autostart.set`, `machines.local.service.update` and
`machines.local.service.disconnect` project the desktop's existing native
SystemTask service owner. Requests name a saved Home; its captured URL and
identity target the local user service, while autostart changes every
desktop-managed service's common login mode. Phones and clients without the
desktop service bridge return `local_service_unavailable`. Native failure
codes remain failures, and invocation cancellation cancels the admitted task.
Status readback updates the existing shared projection only in its initiating
Home/Account scope. Update retains the single managed-CLI update admission and
completion owner, using the existing `this-computer` item identity rather than
attributing a cached machine ID from another Home. Disconnect preserves user-owned services and never forgets
the saved Home. Existing Action approval and native consent policies remain
in force; these controls do not create another service registry or preference.

In 0.3 development source, coordinator setup prepares Important project-first and Home
rule suggestions through the shared Session list filter: Sessions started by
you, in the selected Home, across all accessible work. Creation defaults select
the suggestions, role and worker-question preference; placement resolves the
stored `suggest` value from the person's actual selected project/Home scope.
The caller supplies new rule identities. Manager preselection requires a
complete, admitted private census for that Home and exactly one other Session
receiver of an enabled Home-wide rule; multiple rules for one receiver count
once. Unknown, partial or cross-Home reads do not imply a selection. Setup
does not write rules, invent manager CAS values or create a coordinator record.

In 0.3 development source, `session.context.update` accepts
`intent: { kind: 'set_plan', entryId }` to select an existing Doc Context entry
as the Session's Plan; `entryId: null` clears the choice. Selection uses the
same field-scoped retrying Context writer as other entry edits. The
selected entry carries `plan: true`; choosing another clears the old flag
atomically. Missing entries and non-Doc references are refused without clearing
the current Plan. Reorder, budget and enabled edits retain the choice, while
detaching or replacing the selected entry removes it. Account and Project
Context do not own a Plan selection, and no separate document pointer is stored.

#### Roles, reporting and input observation

The development role owner is Protocol's
[`resolveRoleSelectionV1`](../packages/protocol/src/prompts/roles/resolveRoleSelectionV1.ts).
Built-in, Artifact and plugin sources resolve through the existing Account role
reader. Personal overrides use mode-aware Account role-override records; the
retained `rolesV1` settings shape is migration input, not a second live library.
Plugin sources are read-only declarations projected by the contribution catalog.
`roles.override.*` changes the reader's override, not the plugin declaration.
Run override, workflow pin, Session snapshot/override and Account source resolve
per field through this owner. Engine target/model/effort form one field, so a
target change cannot borrow another Agent's model or effort.

Session role mutation is field-scoped under `work.sessionRolesV1`;
`session.role.set` does not replace notes or the full inherited role snapshot.
In 0.3 development, it accepts `roleId`, `answersWorkerQuestions`, or both;
an empty intent is refused. A toggle-only request preserves the selected role,
inherited roles, overrides and notes. Toggle and combined edits reuse the
existing durable `SessionRoleEdit` intent on `intent.sessionRoles`, applying
only the requested fields against current metadata when replayed. A role-only
request retains its existing `intent.role` path and workspace-write admission.
Both use the same Action approval, target authority and receiving role owner;
the configuration-copy RPC remains the owner of explicit report copies.
In 0.3 development, Workflow Action leaves forward Session role and notes edits
through the installed executor's signed Workflow origin. Home binds the assigned
Run executor and exact target Session. The assigned executor evaluates accepted
authorization, including source-plugin and mediation currentness, before signing
the existing `sessionAuthority` witness and again after Home issuance. Receivers
consume that signed evidence bound to the exact Account, Run, request and target;
their process-local plugin registry supplies no authority for the source.
Home rechecks the installed signature, current Run assignment and target custody
immediately before forwarding. Source revocation before the executor's final
currentness check refuses delivery; a source change after that observation may
race the already authorized delivery. This window ends at that delivery, has no
new timer or lease, and subsequent calls re-enter the source check.
The receiver retains the Run caller, checks current origin/subtree authority
through `admitAgentStartV1`, then uses the existing durable Session mutation owner.
The receiving Session's Account reader observes current relations; it does not
borrow the Run executor's private signing key for those policy reads.
Report configuration copies use the same carrier for each exact child Session.
The Run's write ceiling and the target's existing hands-off policy remain
monotone for automated callers.
Before queuing a Role mutation or report copy, the receiver recomputes against
current target metadata after its final awaited authority/relation check, so a
user's concurrently accepted deny override is not erased by a stale candidate.
Workers copy the effective role set and notes at birth. Explicit
`session.roles.apply_to_reports` updates same-Account reporting Sessions; a
reporting relation itself grants no access or authority. The
public Role/notes edit owner likewise reads only current/requested/edited external
bodies not already complete in the Session snapshot, retaining its post-await
authority and monotone workspace-policy checks. List, Apply and full-spawn reads
still acquire their complete inventory. The
[`manager relation schema`](../packages/protocol/src/sessions/follow/sessionManagerV1.ts)
requires the expected current manager, and the relation owner checks input, audience
and cycles. Reparenting is not a new creation origin or a lower causal work depth.
In development source, `session.manager.set` succeeds once that edge commits,
including approval replay. Pending source-key preparation is reported separately
as `sourceKeyPreparation: { kind: 'waiting', reason }`; it never makes the
committed relation a failed approval. A preparation retry uses the current manager
as `expectedManagerSessionId`, preserving the attachment and delivery frontier.

The 0.3 manager graph is `SessionFollowEdge` with `relation: 'manager'`, from
worker source to manager destination. Ordinary `follower` rows remain independent
for the same pair. `session/follow/sessionManagerService.ts` owns the Home-fenced
single-parent, cycle and expected-manager checks; the shared frontier adapter
owns storage translation. Consumers read the admitted Session's `manager`
projection through `readSessionManagerSessionIdV1`; neither membership nor that
identity accessor grants access or approval authority.

Session Follow authoring in 0.3 development requires the shared event policy:
the source PUT body is `{policy: FollowPolicyV1}`, and source reads and pending
Session observations return that same policy. New manager attachments use
Important. The in-place data migration preserves old ordinary delivery choices
as Custom policies and removes the old mode column; there is no runtime mode
adapter. Wake preparation uses the hydrated source event and shared policy
resolver, and policy edits withdraw prepared context before dispatch. Accepted
progress also checks the exact observed policy alongside publisher, attachment
and represented-frontier currentness.

In development source, a committed `session.spawn_new` returns its successful
creation result even when reporting-edge key preparation is waiting.
The optional `sourceKeyPreparation` result records that separate outcome beside
`initialInput`; neither is a failed Session creation. Persistent destination
daemons require no standalone source-key transfer. Ephemeral destinations retain
their existing key requirement and report missing source material as waiting.

While native startup is still pending, the receiving host's existing tracked
operation is returned as optional `operation: {serverId, machineId, operationId}`.
Use that address with `action.operations.get` or an `action_operation` wait target
to observe startup without submitting another create. `session create --json`
retains it beside `session_create_pending` and the existing spawn-attempt id.
An unknown outcome without an observed operation does not invent an address.

The shared UI Session-creation client joins a returned operation through
`action.operations.get` with `waitForTerminal: true` and the original invocation's
signal and Action transport. New Session, Voice carriers and embedded creation
therefore consume the same terminal result without another create. The UI routes
the read and keys the store with the requester's Home scope; a daemon's stack-local
server identifier is not a client profile identity. Direct and settled successful
results carry the requester's Home identifier, including manual recovery and
committed results awaiting key preparation. Operation, Action, Machine and
captured Account identity still qualify the returned result. The terminal
snapshot advances the shared operation store even if its socket notification
was missed. An embed credential still needs its existing operation-read grant;
creation does not widen that credential's authority. Pending receipts without an
operation retain the same-creation-key reconciliation contract above.

In 0.3 development, a signed-out Agent keeps the non-retryable
`agent_signed_out` creation result and its Agent identity. Its existing
`launchError` detail carries safe recovery guidance: sign in on the target
Machine, select a Connected Account profile for the Session or recipe, or
configure an Account default profile. This guidance does not select a profile
or change the native-auth refusal. An available account is not an implicit
default; unread or invalid default catalogs retain their separate typed refusal.

In 0.3 development, a requester Home outage during Connected Account status
preflight remains retryable. The existing `launchError` detail carries
`project_requester_home_unavailable` and guidance to retry when Home is available;
it does not report a provider credential failure or request profile reconnection.

Hands-off (`workspaceWrites: deny`) is a role ceiling at both native-tool and
workspace-writing Action admission. Agent invocations can tighten it; relaxation
requires present-user authority. It is not a permission-mode override. Reviewer's
automatic allow-once answers also remain within that ceiling. Direct
`session.approval_reviewer.set` requires a present user for direct configuration.
Its required `enabled` input accepts `true`, `false`, or `null`. A boolean sets
the Session override; `null` removes it so the permission owner follows the
Account default again. Clearing an absent override does not publish metadata.
The stored field remains an optional boolean; `null` is an Action input only.
An agent may request the session choice or the Account default
(`settings.set`, anchor `delegation.approvalReviewerEnabled`), but the change
applies only after present-user approval (approved ORC r0.5-W option b).
An agent request alone never enables the reviewer.

`execution.run.send` addresses detached scope (`sessionId: null`); Session-owned
Run input uses `session.message.send` with a recipient. Successful send settlement
acknowledges input admission, **not completion of the submitted turn**. This also
holds for bounded resume: the bridge awaits admission while the resumed Run owns
later outcome settlement. An input-aware caller can use `execution.run.get` with
`waitForInputId` to await its exact current/last input turn; the send result itself
does not return that id. `execution.run.wait` observes Run terminal/attention
conditions instead. Stopping or timing out an observation neither stops the Run
nor supplies a successful result. See [runtime ownership](runtime-core.md) for
retained input and completion-barrier semantics.

The published [Roles](../apps/docs/content/docs/agents/roles.mdx),
[Work](../apps/docs/content/docs/sessions/work.mdx) and
[approval reviewer](../apps/docs/content/docs/sessions/approval-reviewer.mdx)
guides describe the UI/Action task parity. These are unreleased 0.3 source
contracts, not proof of a loaded UI, daemon or published SDK package.

### Personal library folders (development)

`artifact.folders.list` reads the complete personal folder tree, including empty
folders. `artifact.folders.read` addresses one folder by `folderId`. Both use the
invocation's captured Home/Account catalog and return strict folder rows with
names, parent ids and the catalog revision. A complete list has
`coverage: 'complete'` and `nextCursor: null`; an addressed missing folder returns
`not_found` with that same revision. Unavailable or incomplete folder data returns
an unavailable result rather than an empty tree.

These safe read Actions declare `approval: { result: 'none' }` and share the
existing `artifact.folders.*` mutation owner. Ordinary Action settings and caller
admission still apply.
They expose personal organization without loading Artifact bodies or changing
document content, grants or another person's placement. UI subscriptions may read
the same catalog directly; Agent, MCP, CLI and RPC reads use the declared Actions.
The generated [host Action reference](../apps/docs/content/docs/plugins/api/host-actions.mdx)
lists the canonical Actions, admission and surface declarations; the generated
[SDK Action type map](../packages/plugin-sdk/src/actions/actionTypeMap.generated.ts)
projects their exact input and result contracts. This is development source
behavior; loaded-runtime validation remains an integration obligation.

### Session Bot marker (development)

`session.bot.set` promotes a regular Session to a Bot with `bot: { kind: 'bot' }`
and demotes it with `bot: null`. The reversible marker writes through the
Account metadata owner without waking the execution host. Its declaration uses
`approval: { result: 'none' }`; ordinary Action settings and caller admission
still apply. The same Action is exposed on UI, CLI, Agent, MCP and voice surfaces.
This describes 0.3 development source, not a released feature or a separate
permission for Bot actions.

### Prompt and skill saves (development)

Prompt document and skill editors submit through their captured Home/Account's
mounted Action executor. The `skills` family owns library creation, reads,
editing, duplication, deletion, ZIP export, Found adoption and updates through
the existing Artifact and prompt-library row owners. `skills.create` replaces
the unreleased `prompt_bundle.create` id. Current bundle authoring admits
`skills.skill_md_v1`; stored `bundle.generic_v1` remains readable.
`prompt_bundle.update` remains a hidden 0.2 reference adapter at the same
operation owner while those stored references are supported. In 0.3 development,
`prompt_registry.install` also exposes its existing library installer to Agent
and MCP callers. Like `skills.install`, a present-user UI import applies directly
unless the user's Action settings require confirmation. Agent and MCP imports ask
for approval by default; the user can waive approval per surface. Legacy registry
install targets are parsed but do not export.

Plugin permission administration exposes grant listing and revocation to Agent
and MCP callers in 0.3 development. Listing and session-hook status inventory
are reads without default approval. Revocation asks by default and honours the
user's per-surface waiver. Grant and dismiss operations still require
`present_user` authority: automation can propose them for human approval, but a
waiver cannot execute them as a human. Permission requests remain plugin-originated
operations using host-stamped plugin provenance; they are not user UI capabilities.

`prompt_asset.export` retires without an alias: its prompt-document-to-Claude
command operation has no equivalent replacement. Unknown Action overrides,
including a retained Export row, round-trip without resolving to an executable
Action. The old Export screen redirects to the item detail; existing native
files and outside-install receipts are not removed by this code retirement.
`skills.export` still produces an Agent Skills ZIP and `skills.machine.install`
is the explicit native-folder opt-in; neither restores the old asset-type UI.

Each spec declares its approval policy. Present-user reversible skill writes
act directly; deletion and outside-install removal confirm. Agent, CLI and MCP
dangerous writes ask by default and can be configured under Settings → Actions.
Reach edits use `skills.rules.set`; Session overrides use
`session.capabilities.set`. Agent create/install/duplicate/adopt uses Session-only
reach, with a separate rules Action required to widen it. CLI command declarations
and exact inputs remain owned by the generated host Action reference.

An editor Save can include an exact `createFolder` operand and the reviewed
folder catalog revision. The canonical executor admits that child intent and
combines its approval requirement with the parent Save before either writes.
Denial or disablement writes neither content nor a folder; stale folder CAS
stops content publication. This is combined admission, not a transaction across
the separate folder catalog and Artifact owners: a committed folder can remain
if the subsequent content write fails. Approval settlement adopts the original
receipt without replacing a newer local update draft. Existing host import
operations retain their independently derived provenance.

Found skill reads and adoption use the `skills` Action family on both UI and CLI
hosts. `skills.found.list` returns the selected machine's scanner projection;
`skills.found.read` reads a reported directory over the existing download
transfer without creating library content. `skills.found.adopt` copies those
bytes into the captured library Account through the canonical skill-create and
reach owners, deriving machine provenance from the scanner rather than caller
input. A selected Machine Home may differ from the library Home; each retains
its own authority. Plugin-owned skills become ordinary library copies.

The friendly CLI commands are `skills found list --machine <id>`,
`skills found show <name-or-path> --machine <id>` and
`skills adopt <names...> --machine <id> [--off]`. Ambiguous names require an exact
scanner path. Reads are safe Actions; adoption follows required approval for
external callers, while a present user's reversible UI tap acts directly.
Content, reach and Session inclusion acknowledgements remain ordered, not
transactional: partial outcomes retain acknowledged skill ids and identify
unfinished steps. `skills.machine.install` and `skills.machine.uninstall` remain
separate machine Actions; adopting a skill does not install it into native
Agent folders. The generated host Action reference owns the exact schemas and
surface declarations. Loaded-runtime and new Found-screen validation remain
integration obligations, not evidence supplied by these docs.

### Headless Services (development)

The existing `localServices.*` domain Actions are reachable from the credentialed
CLI, Agent and MCP hosts without an answering UI: inventory list/refresh,
launcher snapshots and scoped history clearing, private-preview metadata
registration/status/revocation, and public-preview create/status/revoke. Start,
Stop, Restart, Forget and detected-process Terminate retain their existing
Action policy and daemon control owners. Public exposure creation still requires
the canonical confirmation acknowledgement in addition to configurable approval.
Ask-first returns approval custody, not a completed effect.

Friendly `services` commands are declarations on that same Action catalog,
compiled by the shared CLI argument owner. They include `services inventory
list|refresh`, `services launcher snapshot|register-preview`, `services launcher
history clear`, `services start|stop|restart|forget|terminate`, and `services
preview|public-preview create|status|revoke`. Structured declarations, current
service bindings and reviewed control requests use the compiler's JSON fields;
`--server-id` selects the existing exact Home credential owner. These commands
do not introduce a separate Services parser or runtime.

The headless adapter reaches the exact authenticated Machine through the
existing Machine transport. Snapshot envelopes become the existing typed Action
snapshot; mutations preserve refusal, review-required and unknown-outcome
receipts without replay or manufactured completion. Launcher scope/root and
private-preview selectors/initial paths survive the shared schema-owned request
lowering. Current-service preview requests remain bound to the exact occurrence,
Machine, cwd and declaration rather than the invoking Session. Public preview
Agent/MCP egress uses the canonical URL redaction policy.

Human output reports observed lifecycle/readiness and actual admitted endpoints:
an available Start suggestion is not a running service, a URL-less running
service is not waiting for HTTP, and preview metadata is not navigation or
browser admission. Browser Open and clipboard Copy remain client effects;
headless hosts do not report those effects as completed. Move is outside this
parity slice. These are unreleased source contracts, not package or loaded-runtime
certification.

### Remote hosts (development)

`remote_hosts.*` is declared by the Protocol Remote host family and executes
through the existing Account Action owner. Catalog reads and mutations address
the invocation's captured Account; client SSH tasks resolve SavedSecret
references only inside that captured task admission. Add/edit presentation
requires the addressed Account to remain applied and cannot silently open an
editor for another Home.

Save, delete, credential changes and destructive SSH operations retain the
canonical configurable dangerous-Action approval policy (Ask first by default).
Save uses live-only approval input custody: a prepared Plain SavedSecret packet
may contain credential material, while persisted observations contain only
host/task identity, revision and status. Sealed Resource creation and the host
reference mutation belong to the existing SavedSecret transaction owner, not
independent Resource writes. Metadata-only writes retain Account-automation
admission; a packet that creates Resources also requires the incumbent
SavedSecret present-user admission before any resource or catalog effect. See
[the catalog encryption owner](encryption.md#private-remote-host-catalog-03-development).

Development client-local `remote_hosts.trusted_keys.*` uses this device’s existing
trust store. Remove checks the reviewed fingerprint; Clear checks the reviewed
key set. `remote_hosts.tunnel.stop` releases an exact native lease or starts the
existing desktop stop task for an exact tunnel key. Native results report
`released`; desktop UI results report `task_started` and retain the runner's
observation. Non-UI desktop callers observe the canonical terminal Task result
within the same client dispatch, or an explicit unknown outcome.
`remote_hosts.tunnel.list` reads desktop tunnels through that same client's
existing list task and settlement owner, and native leases from the existing
native supervisor snapshot. Native results report `listed`; both use the
catalog's read Action approval policy and the page's Remote host management
decision. The tunnel UI's refresh read shares the desktop task; saved host
definitions remain the separate `remote_hosts.list` collection. The existing
trust and stop Actions do not require the Home’s remote host management
service. Key destruction and tunnel stop use canonical dangerous
Action admission, with private addresses and tunnel identities redacted from
observations and exact operands kept in live-only custody.

These are development-source contracts. Collection/editor entry-point cutover,
retained-source cleanup and composed loaded-runtime validation remain in
progress; registration does not establish published availability or completed
UI parity.

### Ordinary Machine administration (0.3 development)

The Machine page submits metadata changes, daemon Stop, revocation and explicit
replacement or undo through its declared Actions. Metadata retains the existing
versioned client writer, including Windows launch preferences; callers without
an answering client receive typed `unavailable` / `noClient`, rather than using
the daemon's metadata lifecycle as a second writer. Revocation uses the shared
revoke-and-Provider-cleanup owner and reports pending cleanup without disguising
it as successful completion. Replacement and undo retain the existing Home
enrollment endpoints and their HTTP refusal results.

The development “This computer” Add flow uses `machines.add.local.start` on the
answering desktop App. Its only public input is the focused `serverId`; the
existing local setup owner captures the Home, signed-in Account and native
setup prompts privately and retains its task in the ordinary Add draft. It
uses dangerous-Action approval (Ask first by default), preserving the separate
exact Account-move confirmation and native setup consent. UI and Agent/MCP
consume that same client-placed Action; an absent answering App is unavailable,
and standalone CLI, RPC and Voice execution are not advertised.

The development SSH add flow uses `machines.add.ssh.start/status/respond/cancel`
at its existing client task owner. Start accepts a direct target or a saved-host
id and expected catalog revision. Password/private-key material is not Action
input: it stays in the present user's private submitted draft or is read through
the captured saved-host/Saved Secret owner. Password response carries only its
prompt kind; the reader rechecks the captured host and material before delivery.
Status projects approved prompt/progress fields, not task parameters, raw events
or exception prose. Completion uses the existing remote-host CAS writer while
the captured Account remains current.

Cancel with a task id retains its existing receipt. Omit the id only to cancel
the captured pending native start, receiving `{ pendingCanceled: true }`; the
existing retained start-promise owner cancels a native id that arrives later.
These client-placed Actions are available on UI and through an answering App for
Agent/MCP; they do not promise headless CLI, RPC or Voice execution.

Managed installation questions use the development client-placed
`machines.managed.bootstrap.respond` Action through that same answering-App
placement. Its strict input identifies the Home profile and identity, managed
resource, creation operation, installer task, exact projected question and explicit approval or refusal.
The client reads that exact resource and operation, checks the retained native
resource/controller and current unanswered question, and answers the existing
`tool.systemTasks` task. The managed prompt union covers SSH host trust, host-key
replacement, Account sign-in and remote background-service replacement. Trust
questions retain the host and current/new fingerprints for review. The response
must match the current question, so a stale trust decision cannot approve a later
sign-in question on the same task. Managed SSH uses its generated unencrypted
keyfile; password entry remains with the ordinary SSH setup owner.
The existing task response also carries the expected question kind, which the
task owner checks synchronously when accepting the answer.
The Action never accepts a caller-selected controller
or arbitrary task answer. UI and Agent/MCP use the same executor and configurable
dangerous-Action approval policy; automation defaults to Ask. Action approval
does not replace the installer's sign-in consent, and an answered task receipt
does not claim enrollment has completed. Headless CLI, RPC and Voice are not
exposed for this client placement.

Stop, revoke, replacement and undo use the canonical dangerous-Action policy
(Ask first by default). The mounted page's existing explicit confirmations are
carried into Action admission; disabled Actions remain disabled. Per-Machine
terminal host and tmux preferences use the declared
`settings.set` binding `machines.terminal.host`, not a parallel settings writer.
The keyed `machines.connection.direct` binding takes a Machine id and
`default`, `direct` or `relay`. The Machine Connection row and agents use this
same Account-scoped setting. `default` removes only that Machine's override;
the Account default and other Machines' preferences stay intact.
The Machine Tools install button uses `machines.capabilities.install` for
install, upgrade and reinstall, delegating to the daemon's existing
`capabilities.invoke` installer. It is a dangerous Action with the ordinary
user-changeable Ask default. Per-installable auto-install and auto-update
preferences use the keyed `settings.set` binding
`machines.installables.policy`; each write applies one sparse override against
the current Account settings snapshot rather than replacing other tools' or
machines' policies.
These are unreleased source contracts; composed loaded-runtime validation and
catalog generation belong to the integration boundary.

### Machine-resource guidance and review (0.3 development)

Resource Actions declare `prompting.agentGuidance` and `toolExposure` at the
existing spec owner. Action discovery projects that guidance to clients; it is
instructional metadata, not another approval policy. The primary Vitals,
Processes, Storage summary, Suggestions and Guard reads are directly exposed;
the remaining operations are discoverable. Every mutation still enters the
ordinary Action executor and uses the person's existing per-Action approval
setting. Neither a storage verdict nor an Automation origin adds an approval
floor. The daemon's filesystem refusal facts remain separate from approval.

The UI's Vitals current/history and Processes inventory reads enter those same
Actions. Their shared stores retain the parked watches as transport demand;
watch renewal does not create another Action invocation or sampler.
The Guard-get operation lifetime is declared once in the Protocol's
[`Guard operation contract`](../packages/protocol/src/machines/guard/actionIdsV1.ts)
and consumed by both CLI and UI adapters. After bounded transport setup,
`machines.guard.get` waits for the caller's completion or cancellation; reads
still check the captured Account before disclosing the answer.

Desktop Guard stop warnings use the existing notification channel's native
interaction boundary (`sendTauriLocalNotification` → `tauriNotificationPlugin`
→ `src-tauri/src/desktop_notifications`). The OS carries the original occurrence
and canonical action identifiers back through `useNotificationResponseRouting`.
`guardStopWarningLifecycle` rechecks the saved Home, current Account and current
warning before invoking the normal Action executor, and owns withdrawal through
the same transport interface used by Expo. Rust owns OS handles only; it does
not decide Guard eligibility or Action approval. Ordinary text notifications
retain their existing plugin delivery within that same channel.

This is unreleased development implementation, pending loaded desktop validation.
The native notification retains the original Home, Account and warning occurrence:
macOS uses `userInfo`, and Windows uses protocol activation arguments with the
installed channel's URL scheme. A process-local response queue bridges native
launch to renderer readiness; there is no notification disk store. Recovered
responses enter the same parser and Guard currentness checks, refuse an Account
rebind, and cannot execute permission answers or plugin Actions through this
Guard-only native route. Delivered macOS/Windows warnings are read from OS history
so the existing withdrawal owner can reconcile them after restart.

Linux requires an action-capable notification daemon and the original sending
connection: full process exit ends XDG action delivery. Reopen the app to use
the current in-app warning in that state. macOS requires a real application
bundle and notification permission. Windows protocol activation requires the
installed application's AppUserModelID and registered URL scheme; Action Center
persistence additionally needs the shortcut's `ToastActivatorCLSID`, which the
current stock installer does not set. Retained Windows cold-start activation
therefore remains incomplete. Signed/installed native notification journeys are
release checks; host tests do not establish visible delivery or OS activation.

`machines.list { refresh: true }` runs the existing Home machine inventory
fetch-and-apply owner before listing, including Overview Retry and page refresh.
Omitting `refresh` retains the cached UI list; the CLI inventory already fetches
through its authenticated inventory owner. Voice disclosure preferences still
apply to Voice listing.

Device-local resource preferences use `settings.get` / `settings.set` through
the existing declarations: `appearance.machineSummaryStyle`,
`appearance.machineSummaryMetrics` (including an empty metric list),
`machines.indexView`, and keyed `machines.storage.view`. The Storage key is the
existing Home id, U+0000 separator and Machine id. A sparse value changes
`shape` (`list`, `map`, `rings`) or `sort` (`by` and `direction`) without replacing
another Machine's preference. Phones display List while preserving the remembered
desktop shape. Process stop, kill and left-behind cleanup all use the shared
resource proposal check, subset and per-item receipt body; cleanup keeps its
identity-pinned primitive refs rather than inventing target expectations.

Process proposals check the current identity and the canonical Guard planner's
kept-session facts before approval. Proposed working or waiting sessions show
Keep and start unticked; including one requires an inline confirmation naming
the work and the loss from stopping or killing it. A changed expectation or
loss requires fresh confirmation. An unavailable check withholds approval and
offers Check again. These are review and selection rules; the Action's own
approval policy still governs execution. Full Suggestion widgets offer inline
Approve only when the entire proposal fits their visible rows; Review opens the
complete proposal for larger sets.

Permanent `machines.storage.deleteNow` requests use this same item-review body,
fresh check and signed subset-narrowing decision. Their inputs contain no claimed
verdicts, so only the check establishes Safe default selections. Approval names
permanent deletion and its lack of Undo. Receipts use the execution's measured
freed bytes and per-item outcomes, including skipped items; they do not read
Trash or offer Restore/Empty operations.

Storage proposal receipts retain the exact Trash entry ids still present when
the original execution settles. On reopening, the shared proposal controller
reads the complete Trash category and the existing 30-day Activity range.
Entry-scoped Empty receipts prove bytes freed; the original move receipt's
`undoneAt` proves restoration. Missing records, expired Activity and older
receipts without entry ids leave the final outcome unavailable rather than
turning disappearance into a deletion claim. A partial immediate empty's
settled freed total is added to later correlated Empty receipts, without
counting its original effects twice. Undo and Empty now address only the
remaining correlated entry ids, and partial failures retain those entries.
When a remaining subset cannot prove its physical allocation union, the card
shows its count with an unknown size instead of summing overlapping allocations.
This uses the existing Trash and Activity owners; the proposal has no ledger.

In 0.3 development, Try again invokes the same Action as a new UI request. Its
strict settled result is appended to `storageRetryResults` on the existing V2
approval Artifact through the approval writer's Account-scoped compare-and-set.
Only originally unsuccessful items may receive retry results; batches and entry
ids stay distinct. The original subject, decision and execution remain unchanged.
Reopening uses each retry's own batch and entry ids to derive its Trash, Emptied
or Restored receipt. A failed history write is reported while the settled local
receipt and its Undo remain available; it is not proof that the effect failed.

The Resources settings family supplies separate Reading and Changing sections.
Read-only Automation and filesystem facts are declarations, not configurable
callers. Machine suggestions derive from supplied resource facts and fill the
ordinary composer without sending a prompt. The weekly storage-review entry
seeds the existing Workflow editor and scheduled Automation creation path;
saving there remains the write. Its local-time weekly trigger uses the existing
trigger owner; the ordinary editor owns the user's Agent and model selection,
without a template role overriding that choice.
The review prompt proposes Trash cleanups and excludes permanent deletion or
emptying Trash. Automation-origin approvals join their Automation's Inbox work
group through the existing run identity, without acquiring new decision logic.

These are development-source logic contracts. Resources layouts, resource
widget bodies and composed loaded-runtime validation are separate integration
work; the existing Machines widget remains until its replacements land.

### Home runtime and hosting desktop (development)

The Home runtime family is declared in
[`home/runtime/actionsV1.ts`](../packages/protocol/src/home/runtime/actionsV1.ts)
and projected through the ordinary Action catalog. Local runtime, relay access,
Personal Home operations and native file choices execute on the answering client
through its existing desktop and SystemTask transports. Agent and MCP
invocations use the existing connected-client reverse dispatch; an available
client with the required native transport is necessary. Standalone CLI exposure
is disabled for client placement by the canonical surface policy. File choices
still open the native picker and require a person to select or cancel. Signed-out
desktop bootstrap and presentation retain their existing native UI transport.
Signed-in hosting, Reach and device runtime controls, including a device without
a Personal Home receipt, use the captured Account's Action executor. Native file
choices, file effects and uninstall use that same policy path. Absence of a
Personal Home receipt does not make a signed-in invocation a draft bootstrap.

UI task invocations return admission and retain the existing task observation
flow. Other callers observe the terminal task result within the same client
dispatch, so a desktop-local task id is never treated as a portable task handle.
Losing that observation returns an explicit unknown outcome; cancelling the
observer does not cancel the admitted task. Connected-Machine Home restart uses
the Machine's existing SystemTask start/wait capability instead. Home, local
runtime and remote-host relay restarts are direct for a present user's UI press;
explicit Ask-first and automation retain the canonical approval policy. Other
runtime writes retain their declared confirmation; OS file opening uses that same policy
because the native port can launch files, while picker and reveal remain safe
presentation operations. Relay configuration keeps credential input in live-only
approval custody. Its mounted author publishes the existing pending notice when
the blocking UI waiter joins; opening Inbox retains that author and its original
invocation. This is observation of the same Artifact, not deferred replay or
durable custody of the credential input. Native logs fallback re-enters Action
policy only after a known native path-opening failure, never after refusal or
an unknown effect outcome.

`relay.runtime.task.cancel { taskId }` requests cancellation through the answering
client's existing native SystemTask owner, bound to the Home and Account captured
when the task started. It neither creates a portable task registry nor authorizes
another Account's task. A cancellation request is distinct from confirmed native
termination; already-settled and uncertain outcomes remain explicit.

`home.runtime.get` reads the canonical Home release projection and optional
`searchReadiness` (`ready`, `indexing`, `unavailable` or `unknown`) from the same
feature capability/readiness owner used by Runtime. Missing or malformed search
capability is unknown, and this observation grants no search authority. Mounted release
subscriptions continue to consume that same feature owner. `home.search.rebuild`
uses the existing Home search transport and its present-user authority floor.
These are development-source contracts; loaded desktop, Machine and Home journeys
remain separate validation evidence.

### Usage snapshots and explicit exports (development)

`usage.query` reads a batch of independently resolved personal `UsageQuery`
values. The shared input adapts the canonical accounting clauses rather than
declaring another filter grammar. Home, Account credentials and access belong
to the captured invocation, not the query. Scope and cost-basis fields may
follow context independently through the general input-field contract; metric
and breakdown remain own values.

In development source, an installed Session's `usage.query` and `usage.export`
spend their existing Home-issued Action authorization for the accounting query,
captured Account mode/settings/profile reads and retained quota reads.
Coach dismiss/snooze/apply/undo roots consume the same evidence reads without
gaining mutation authority; their existing approval and mutation-owner policies
remain in force. `usage.calendar.export` admits only its retained quota read.
The `usage.recap.private.*` roots consume the same query and quota reads for
private composition. The Home purpose owner admits those exact routes and
schemas under the original Action root; it
does not grant Account mutations, broaden public-source recap access or substitute
the daemon's bearer. Session-source currentness and ordinary route-level Account
access still apply.

Session filters admit the captured caller's current transcript-read access,
including a Can-view grant. Accounting totals and message counts remain scoped
to that caller's Account: sharing a Session does not share its owner's Usage.
An unrelated or revoked reader is refused by the canonical Session access owner.

Relative periods retain their relative request identity. The shared accounting
read planner resolves them at one captured read clock; accounting, the preceding
comparison, allowance history and private interval/Coach projections use that
same witnessed range, including when accounting is pending or unavailable.
Development v2 accounting and published-message counts use half-open ranges:
start is included and end is excluded, so adjacent comparisons do not count a
boundary twice. The retained v1 adapter preserves its inclusive end instant.

Development accounting reconciles reported counter totals before filtering.
A reported amount that covers earlier estimated or API-priced contributions
is a separate money-only fact, with query-only references to the contributions
it covers. The cost owner selects it once when that complete population is
present. A day, model, source or Work subset that cannot apportion the charge
keeps selected money unavailable; it does not attach the whole charge to residual
tokens. Raw reported, estimated and API-equivalent facts stay separate. A
zero-token money observation adds no tariff population and cannot make otherwise
fully priced tokens incomplete. These overlap references are derived query
evidence, not persisted accounting or producer-supplied admission authority.

Timeline buckets partition the selected query population after resolving these
overlaps once. A whole reported charge appears at its observation time; covered
earlier estimates remain raw facts and are not counted again. This differs from
running a new query for one day, whose narrower population may not admit that
report. Daily, Flow and the single-series projection share this temporal owner.

Active days and current/best streaks use the shared calendar-day summary at the
query's offset and range, not a count of hourly or monthly series buckets. The
current streak ends today or yesterday; the best streak is period-local. Missing
calendar evidence remains unavailable rather than zero. Execution-source shares
use reconciled token contributions and witnessed `happier`, `outside` or unknown
execution attribution. Native capture alone does not establish outside execution;
unknown contributions stay in the denominator and a missing denominator has no
measured share.

In 0.3 development source, `includeAccounting` defaults to true. Capacity sets
it to false through the shared widget demand owner: the same query identity and
Account Resource then read allowance and selector facts without accounting,
comparison or private Session evidence. This host-demand clause never crosses
the accounting HTTP boundary. Quota-only and accounting-backed slices share B's
admission and source-state projection. Ordinary accounting snapshots retain
their price projection during the read; a changed response, catalog, override or
cost basis recomputes it, while independent source progress reuses it.

`includeSessionEvidence` controls opened Session metadata, turn intervals and
retained permission facts. `includeTranscriptEvidence` separately requests
transcript-derived detail for those admitted Sessions; disabling it keeps the
interval facts and explicit partial detail without reading message pages.
`includeWorkEvidence` controls native SCM outcomes. All three default to true
for direct Usage Actions, and the accounting HTTP adapter removes all three.
Builtin accounting widgets and filter inventory request none; outcome and
Project-ledger widgets request SCM evidence only. Period summary, Parallel work
and Night shift request Session summaries without transcript detail. General
Session value reads SCM evidence; its explicitly single-Session autopsy also
requests Session and transcript detail. Coach, Human loop and recap retain
transcript detail demand. The captured Home/Account Resource owner shares one
Session/turn admission across summary and transcript demands. It retains projected
input, phase and Coach facts and releases opened message bodies. Unchanged refreshes
reuse that admission; the detailed Session and compact list-row sequence,
metadata/agent-state versions, turn marker, access and content mode invalidate
only that Session. An exact Session wake
also requires fresh admission. A broad Account wake uses the loaded Session markers;
reconnects and Sessions without a loaded marker require fresh admission. Complete
message facts and successfully opened partial pages can be reused after admission
proves the same sequence, readable transcript access and content mode. Partial
pages retain partial coverage; repeating the same page is not historical catch-up.
Failed or wholly unopened reads remain retryable, and Account or credential
retirement clears the private evidence.

The Session-evidence read publishes admitted interval facts before requested
transcript detail finishes. Its existing source states distinguish
`how_you_work:sessions` from `how_you_work:transcripts`; summary-only demand
settles after Session admission without a pending transcript source. When detail
is requested, the base source stays pending until that read settles. A refused
Session withdraws the interval aggregate rather than presenting the surviving
Sessions as the full total. Progress publishes those source-phase transitions,
including immediate refusal, rather than projecting and serializing the full
Account after each unfinished Session completion. The scoped Session reader
shares one finite Account-currentness observation across the batch while keeping
its mode/material admission and canonical encryption-invalidation fences.

The mounted Usage toolbar and current-context commands share the same supported
Sources, Agents, Machines and Projects filter inventory. Each choice toggles
that field's selection; its All choice resets that field to unrestricted.
The inventory comes from admitted displayed facts and current selections, not
guessed ids, and Session-scoped pages do not publish these scope toggles.
Mounted commands refuse after unmount, cancellation, stale surface or
Home/Account retirement. Scope changes do not change the period or a widget's
metric/breakdown; period selection and layout presentation retain their own owners.

The deterministic page aggregation keys the complete normalized query and
names requested and shown meaning separately. Accounting, allowance and local
detail retain their source authorities and status; unavailable facts are not
zero. A bounded comparison names the exact preceding range with the same
filters, basis and timezone. The Resource lifecycle, rather than an Action
stream or a widget-local cache, owns invalidation and progressive rereads.
The UI's one-shot Action acquires that same exact-query Resource and returns
its fresh snapshot once the requested accounting sources settle. Comparison,
private detail and allowance sources can still be pending; their status is part
of the result. Already-admitted private facts remain available for that exact
query. Releasing the Action's read does not end a mounted page's subscription.
Resource freshness does not promote retained source evidence to current;
Coach mutations still require current evidence after a source or settings change.
Their nested query waits for its requested private evidence and binding-catalog
admission in this same Resource; it does not wait for independent allowance history.
Ordinary one-shot queries keep returning progressive snapshots. Undo needs the
authorized query and the owner's conditional receipt, rather than renewed advice.

The existing accounting engine/model timeline can also retain source parts per
bucket. Capture path and execution placement are separate: a native record
with an admitted linked Session witness is Happier work, while an admitted
sessionless native record is outside Happier. Missing or older evidence stays
unknown. Daily and Flow consume those parts from the same query, retaining
Agent color and hatching outside-Happier portions; they do not query or count
native records a second time.

`connectedServices.pools.selection.get` also admits an optional `hypothetical`
strategy and `atMs` through the same read-only selector. It evaluates retained
facts at that moment using the live comparator; it never switches an account,
changes the pool policy, refreshes a provider or predicts quota replenishment.
Future quota evidence can become stale or unavailable. A successful hypothetical
read echoes its effective strategy and time, and the Action rejects missing or
mismatched acknowledgement instead of showing a live read as a comparison.
The mounted pool's Why detail consumes this admitted read through the shared
Account Resource, using the machine that supplied the pool's selection.

The development reset planner reads content-free identities of Account-owned
unbound Session Pending input through the existing Pending owner. Bind and cancel
use `session.pending.resetStart.*`, as does the composer's Send at reset entry.
The set Action's optional initial input creates already-held custody only after
approval and fresh exact B-witness admission; it does not enqueue ordinary input
and bind it later. A missing write acknowledgement retains the draft. The existing
signed CLI root binds the exact Session, local input, qualified source, B record,
meter and accepted witness. Preparation admits only Account-mode currentness,
that source's resolution, that record and that exact witness; it grants no general
Account reads, history range, refresh or Pending listing. The same signed facts
must match the initial-held write or existing-input binding effect.
The signed representation uses fixed-size canonical domain-separated digests for
Session/source/record/witness and the complete mutation purpose; both raw read
selectors and mutation facts are independently re-derived. It does not copy
unbounded meter identities into JWT headers or increase the global header limit.
Explicit Home issuance and ordinary public Action dispatch consume the same
envelope-to-purpose projection. Both reject missing purpose or an Account-mode
mismatch before relay; dispatch retains its Machine carrier and signs the exact
Session identity inside that projection.

The development Plan Fit body derives capacity weather from witnessed B pace,
model headroom from a fresh model-specific meter, and period price per recorded
reset from comparable adjacent witnessed B window rollovers. These are qualified
projections, not promises of future capacity or actual billed consumption.
Its ended-calendar-week recap separates A accounting coverage from H interval
coverage; absent intervals are unknown, not a complete quiet week. Subscription
price alone cannot support per-account value: without response-bound connected
account attribution the value projection stays insufficient.

In development source, `usage.prices.get` reads the public model catalog and
`usage.prices.refresh` explicitly fetches the fixed LiteLLM price file through
the server's outward-network owner. No Account or Session data is sent to that
source. Disabled fetching and failed refreshes retain cached or bundled prices
with visible provenance; a usage query does not trigger an outward refresh.
The bundled offline snapshot carries its upstream revision, timestamp and MIT
licence. Only standard text-token tariffs are projected; unsupported models or
missing tariffs remain unpriced.

`settings.get/set` at `usage.modelPrices` reads/writes per-model rates or an
explicit mapping to another model in the existing private Account settings.
The shared query projection applies those overrides to retained contribution
tokens, so edits reprice history without rewriting reported money or the
historical `estimatedUsd` observation. API-equivalent is its own selectable
basis, never payment or invoice spend. The logic exposes typed editor data;
the price editor's presentation is a separate development lane.

The development Work Session drill opens the existing Session Usage route,
carrying the shown page scope, canonical query clauses, money basis and Work layout. Work and private
recap share one detail body over that `usage.query` slice: contribution/turn
amounts, exact checkpoint/commit/outcome witnesses and the admitted witnessed
busy/wait phases. Missing prices remain unpriced, and missing interval ends
remain partial; no autopsy Action, query cache or attribution inference exists.
SCM evidence can retain actual checkpoint/commit object timestamps and all
local branch aliases whose immutable head matches the witnessed PR head.
Kept-change counts are a textual lower bound from original changed files whose
blobs and modes are unchanged at the compared target. Later-modified and binary
files remain partial rather than being credited as kept lines; this is not
AI authorship or a claim that the Session caused the final work. Native tool and
compaction evidence contributes content-free classes or point markers, not
inferred tool durations or human presence.
The autopsy cost curve cumulatively projects the selected monetary basis at
accounting observation times and names its kind and currency. Incompatible kinds,
currencies or missing selected money keep the cumulative amount unknown; tokens
and witnessed SCM timestamps are independent of that monetary availability.

Personal calendar buckets use the query's fixed offset in minutes east of UTC;
weeks start Monday. The shared Protocol bucket owner supplies accounting,
activity and interval boundaries. This is not historical IANA/DST reconstruction.
How-you-work consumes only admitted opened Session detail: absent permission,
accepted-input or lifecycle evidence remains unknown, rather than zero. Known
busy intervals exclude witnessed permission, user and child waits; missing ends
are partial and never filled to now. Sum of agent time, elapsed busy union and
concurrent elapsed time are separate values. Exact work identity, not a parent
label alone, controls duplicate representations. An explicit night-hour window
uses recorded activity and witnessed busy duration, never inferred human presence.
The optional Account night-hours choice defaults to unset. Changing it invalidates
the existing Usage Resource and reprojects available recorded activity even
while private Session detail is pending; each query keeps its own fixed-offset
calendar. Changing or clearing the hours also reprojects retained witnessed
intervals, without inferring missing busy duration.

In 0.3 development source, the same `usage.query` slice additionally exposes
shared chart facts, not another analytics reader. `howYouWork.runLengths`
contains deduplicated closed-turn wall durations (including waits), per-Agent
median/p90 and separate open, cropped and invalid counts. Missing terminal
observations are not completed samples. Anonymous Agent/duration observations
reuse `summarizeUsageRunLengthObservations`, the same quantile owner, without
inventing lifecycle identities or timestamps. `howYouWork.steering` joins accepted
inputs and permission answers to historical turn Agents and answer hours;
follow-ups remain distinct from steers, unpaired answers have no wait latency,
and rates use only witnessed same-Agent busy time. `collaboration` preserves
typed directed spawn/run/native/review/plan/report/replay/handoff evidence;
missing launcher identity or time stays Unknown, and current manager membership
does not establish historical launch provenance.

`howYouWork.agentCalendar` folds full reconciled contributions into Agent
day/week/hour metrics before selecting joint leaders. Its full-period summary,
weekday/hour and hour-of-day reductions deduplicate Sessions and sweep actual
dated busy spans; callers must not sum bucket Session counts or peaks. Period
Agent membership and nullable token/cost shares use that same full population,
including Unknown attribution. Absent measurement-presence evidence cannot
turn a zero-valued context observation into a measured share. It also derives observed
Agent active days, normalized weekly token shares and clipped witnessed weekly
peaks. Costs retain the selected canonical money basis. Configured day/night
shares use recorded hourly activity, not busy time or human presence; no window
means unavailable. Coarse machine kinds remain unavailable without evidence.
Calendar shaping follows existing Activity/model-timeline demand and steering
follows transcript demand. `mergedOutcomes` delegates to the canonical Work
allocation: merged PRs linked to period work, merges actually dated in the
period and undated merged PRs are separate facts. Optional or null projections
mean unavailable, not zero. These private result fields do not authorize public
disclosure; public population admission and field policy remain separate.

`usage.recap.private.compose` returns a strict private selected-field preview from that
same authorized query slice. In current 0.3 development, private compose, export
and delivery accept `sourceSelection`: `whole_usage` (default) or `happier_only`.
This choice is independent of the parent page's capture-source filter. It
projects one canonical query, clearing that inherited filter and selecting
witnessed `execution: 'happier'` only for Happier-only output. The accounting
owner filters execution after reconciliation; a capture-source id cannot prove
execution. Whole usage includes unknown execution with explicit coverage, while
Happier-only never promotes unknown turns into witnessed Happier work. Private
detail follows the same admitted turn membership. A server that cannot admit
the execution filter refuses it instead of returning broader facts.
One result supports Daybreak (default), Sigil,
Editorial, Glass, Holo, Skyline and Terminal, with square, story and
link-preview formats. These choices do not change the admitted facts. Private names
and dollars are excluded by default; unselected private identities, paths and money
do not enter the preview. Exact period, timezone, as-of and coverage remain
explicit, and missing Work, parallel, night or Coach evidence stays unavailable.
Supplied closed intervals do not imply complete private history.
An explicitly supplied night window can retain recorded native activity even
when private lifecycle facts are unavailable; its busy duration remains null.
No default night window or zero busy time is inferred.
Explicitly selected dollars preserve the canonical reported, estimated,
API-equivalent, invoice and unpriced facts separately, including currency,
null unpriced amounts, as-of and completeness. Recap strips private source
identities and never blends those kinds, reprices tokens or interprets absent
canonical money facts as a paid zero. In the current development result,
`dollars.selected` is the nullable kind/currency/amount projection from the same
scoped cost owner used by the query; `dollars.facts` merges comparison facts by
kind and currency through the existing cost-fact totals owner. The card shows
selected spend once, keeps estimates and API-price comparisons separate, and
does not promote raw whole-report amounts into unavailable scoped spend.
Selected Coach facts expose only witnessed
detector ids and evidence counts, with currentness and coverage kept explicit.
Cache selection retains its read and write token counts even without selecting
total tokens. Agent mix rows retain their public catalog `agentId` independently
of the private Names selection, so every card can show its Agent names and marks.
Older composed rows without that optional identity remain readable. Agent and model mixes remain separate populations, and selected
highlights retain their witnessed peak or linked-outcome facts in the card model.

Coach is a development-only projection of this same query, not another query,
registry or rules engine. Its finite built-in vocabulary each returns `finding`,
`insufficient_evidence`, `no_finding` or `disabled`, with the required evidence named.
Missing native cache, tokenizer, comparable model-request or complete tool-use evidence
does not become a heuristic diagnosis or an observed zero. The public typed
finding retains the exact query, period, evidence identity, source coverage and
currentness; content and private source paths are not composition evidence.

Every finding also carries its evidence method, dated source citations,
limitations and remediation. Informational observations do not become waste or
savings. The [cited vendor-facts owner](../packages/protocol/src/usage/coach/coachVendorFacts.ts)
holds verified numerical policy facts; the existing Usage model-price catalog
and user overrides still own tariffs. Cache economics and its retained idle/prefix
cause views use one analysis, the request's actual TTL, and exclude expected
rebuilds. Missing causes or prices do not establish an avoidable cost. MCP advice
flags witnessed upfront definitions or measured context share, not an assumed
per-tool size. Ordinary repeated compaction is not thrash: the latter requires
three witnessed immediate refills to the limit. Identical operation/error runs
require three consecutive failures with no progress; that rule is labelled
guidance-derived, not an empirical optimum.

The retained `context_bloat` preference key now selects observed per-request
context growth and cached-history cost, not a full-window warning. Recorded-effort
and exact subagent accounting audits are informational and require their actual
facts. Current accounting does not expose request speed or scheduled-turn interval
facts, so those conditional candidates are explicitly `not_available`. Native
refill, effort and tree-accounting facts are not inferred from transcript counts
or current Session defaults.

Host prompt preparation retains content-free composition in the existing
Session-protected transcript event path. UI and CLI/daemon Usage queries feed
their existing protected Session readers into one neutral Protocol projection.
The selected Session read opens user, agent and event rows through its captured
Home/Account authority. Mixed Claude assistant prose/tool blocks contribute only
typed tool identities and phases; prose and tool input paths are not query facts.
Historical model selectors use the same alias normalization as accounting.
Host-only records
describe actual injected components and the final dispatch payload using scoped
opaque identities and UTF-8 bytes. They do not claim a native cache prefix,
tokenizer, TTL, MCP schema or context-window capacity. These events do not create
unread messages or meaningful Session activity.
That quietness is established by the 0.3 attention owner, not by older Home
versions. New evidence arms are development-source contracts; do not infer
mixed-version quietness or released availability from current source tests.

`usage.coach.apply`, `usage.coach.undo`, `usage.coach.dismiss` and
`usage.coach.snooze` delegate to the existing settings, Session-model, MCP,
recovery and prepared-Session Action owners. The current development query also
admits reversible proposals from real retained evidence. MCP advice witnesses
zero per-binding calls in fully observed successful foreground windows; it does
not measure hidden native schemas or claim causal savings. The observed server
and binding revisions must still match their canonical Account entries before a
disable proposal is admitted. The catalog/rules owners advance those edit stamps
for each change, including tool policies and edits within one clock tick.
Current binding windows use V2 to witness that stamp contract. Retained V1 windows
stay readable as observations but cannot authorize a disable: their historical
stamps could have been reused by earlier catalog writers. A fresh native window
is required; history is never rewritten or promoted.
Unrelated catalog edits do not retire that evidence;
Apply uses the catalog's current revision for its existing atomic mutation, and
Undo uses the committed receipt's revision to refuse intervening edits. Windows
are grouped by the binding's witnessed configuration, so an unrelated catalog
revision cannot erase an earlier tool call. Claude's retained window also carries
the final native result's queue count when observed; null or an absent historical
field means unobserved, never a host Pending count. Model comparison infrastructure matches content-free
identities of the same host request completed on two models in one Session,
with observed lower cost on the other completed request. This is the sole model
suggestion trigger; no broader suitability heuristic is inferred from totals,
model names or task labels. The default “Suggest with estimates” mode labels
observed costs as partial and identifies absent response-bound Provider evidence
as “provider unknown”. Current Session metadata is not proof of an earlier
response's Provider. Completion does not establish equal quality, and partial
cost samples never establish that a heavier model was unnecessary. The pair is
an n=1 observation, not a trend; cache-rebuild adjustment is unavailable unless
explicitly witnessed. A mid-session switch must account for its cache rebuild
before comparing potential future savings. Native
accounting does not certify complete host-request costs, so “Only with complete
evidence” remains insufficient with those facts. The conditional proposal path requires an exact
inactive Session model-owner condition; missing active-runtime revision facts are
not invented. Missing matched completed requests stay insufficient.
The existing Account `usageCoachPreferencesV1` declaration (`usage.coachPreferences`)
owns all built-in check choices, the model mode and evidence-scoped dismiss/snooze
state. Coach dismissal/snooze writes remove expired snoozes and replace that exact
evidence key's previous state; another finding from the same check remains
independent. `settings.get`/`settings.set` provide the same read/write owner for agents
and clients. Disabled checks are skipped by the single evaluator before their
evidence is inspected, including while older detail is retained during refresh.
An unavailable Account preference read does not silently enable checks; the
query withholds Coach findings until its configuration can be read.
These are current development-source contracts, not claims of released availability.
Apply revalidates the current
evidence-bound proposal; each child keeps its normal admission and approval.
Reversible effects use the owner's captured before/applied state and conditional
write. Undo must refuse an intervening owner edit or a different Home/Account;
it does not need an obsolete finding to survive a successful remedy. Settings
Undo captures raw field presence/value at the owning mutation and does not
depend on optional, prunable Account history. Repository advice prepares a review-prompt Session,
not Git rollback. Its finding carries the canonical execution target, directory,
Agent target and explicit nonempty text prompt, not an arbitrary Session birth
envelope, browser content or trigger configuration. Apply delegates that recipe
to the unchanged full `session.spawn_new` owner. Dismissal and snooze are scoped
Account preferences keyed to the exact evidence.
Mounted findings use the refreshed canonical dismissal/snooze state, including
expiry and external restoration; an acknowledged Action does not keep a second
local suppression mask. Coach's digest is an opt-in
suggestion in the same query, not a cadence preference or another scheduler.
The user supplies a destination and schedule before the existing
`workflow.trigger.add` Action creates a recurring Automation under its normal
approval rules; existing Automation Actions own edits, execution and removal.
Its recipe re-queries recent usage and reports unavailable evidence honestly,
without applying remedies. Source implementation and loaded UI/Automation
validation are separate evidence; registration alone is not availability.

Compose produces data without publishing, rendering an image or opening a
share sheet. `usage.recap.private.export` is client-placed: it composes the same selected
facts, then returns strict PNG file bytes with their field manifest and as-of.
A headless caller receives compose data and explicit image unavailability, not
a fabricated image. The client renderer uses the same recap card as the preview.
`usage.recap.private.deliver` accepts the same closed source intent plus `copy`, `save`
or `share`, never caller-supplied image bytes or paths, and owns explicit client
delivery through compose, rendering and the existing image-delivery adapter.
Its result distinguishes delivered, cancelled, unavailable and failed outcomes.
Android chooser presentation returns `failed` with `outcome_unobservable` and
`handoff: 'presented'`: completion is unknown, not a proven delivery failure,
and callers must not automatically retry. Browser download acknowledgement is
only a handoff, not proof that a file was persisted; native Save retains the
system sheet's semantics, not a promised photo-library write. Cancellation or
Account retirement prevents a late render from disclosing bytes. These are
development-source contracts; source checks do not establish loaded UI or release
availability.

The separate `usage.recap.compose`, `.export` and `.deliver` roots require
`{source:{kind:'public_profile'}}`. Private source privilege is visible in the
signed root, not inferred from an input digest or a caller claim. UI and agents
use the same source-specific roots and the same canonical recap composition,
rendering and delivery owners. Public roots reject private query inputs and
receive no private accounting or quota privilege; private roots reject public
source inputs. This is an in-place 0.3 development contract, not a released
compatibility alias.

A public-source recap reads the captured Account's
currently admitted public view through `/v1/account/public-profile/view` rather
than re-querying private Usage or accepting a supplied snapshot or username.
Only admitted public fields reach the existing style model; unavailable public
source never falls back to private data. Public source transport and host UI
integration remain development work, not an available publication workflow.

The optional How-you-work footprint is also a deliberate data result. No
applicable licensed, versioned method has been admitted for the available
model/input/output/date/serving facts. Its projection returns
`insufficient_basis`, with null Wh and CO₂e estimates, not measured zero.
Accounting tokens remain explicit proxy coverage; no universal per-token
energy or carbon coefficient is inferred.

`usage.export` serializes explicitly selected accounting sections into JSON,
CSV or text file bytes. Save, Copy and Share remain explicit client operations;
the Action does not write a local file or send data. Plugin host-read admission
does not expose this export Action. These are development-source contracts,
not evidence of published SDK availability or completed live QA.

`usage.calendar.export` similarly returns `.ics` bytes for explicitly selected,
admitted reset and renewal facts. Unknown renewal dates are not inferred, and
creating this safe-read file does not create calendar entries. UI and headless calendar
Actions open only the explicitly selected connected accounts through the existing
authorized retained-quota read; this does not refresh a provider or enumerate an
Account catalog, or depend on an accounting-ready query snapshot whose quota is still
pending. Clients already holding admitted quota facts may compose from
those same facts. Billing navigation
uses `connectedServices.billing.open` on the client and only the destination
admitted by the connected-account descriptor; no guessed provider URL is used.

`connectedServices.subscription.price.set` sets or clears the user's monthly
amount and currency for an exact qualified connected account through ordinary
write approval. Its captured UI/CLI adapter encodes the amount in the Account's
persisted encryption mode; the Connected personal metadata owner writes only
the exact-account price facet in its existing Account-row catalog, even before
any quota observation exists. The quota reader retains it even when the provider
reports no subscription facet, using the existing unavailable subscription state.
Plans displays that monthly amount as “you entered”, separately from provider-paid
and published list-price facts. Period-qualified value and fit still require their
witnessed billing period; entry does not establish one. This is development-source behavior; the price-entry UI and
loaded-runtime verification are owned by the Usage integration boundary.

Plans consume quota history through the existing B history/pace owner. Unused
capacity retains the witnessed denominator and entitlement. An ending projection
is labelled as an estimate; absent or incompatible history/denominators produce
explicit insufficient basis, never an invented currency loss. The mounted UI
reader traverses the existing quota-history cursor for its selected range;
transport batch size is not a history cutoff. For a requested bounded history
range, a finite CLI or MCP Usage snapshot retains the first canonical page for
each eligible account. It preserves any non-null `nextCursor`, marking both
the account and aggregate quota source partial while continuation remains.
Consumers that need further recorded history use `connectedServices.quota.get`
with the same source, requested range and page size plus that cursor. This does
not add a history limit or a second cache. A later ordinary UI read failure
keeps an explicitly partial accepted prefix, while denied or retired authority
withdraws the facts.

### Native usage sources (development)

The `usage.sources.*` family addresses one Home and Machine. Discovery reads
declared source metadata, not transcripts or accounting. The Sources widget's
resolved inventory scope selects Agents, Machines and exact accounting source ids;
period and metric do not filter inventory. Metadata discovery on selected Machines
establishes source membership before Sources and Work show matching rows, and
matches Agent contribution identities without guessing from local ids.
Its descriptor and Sources-only preset require only that inventory projection,
not a complete accounting query. Consent, Stop, root
changes and native-history deletion execute at the Machine's captured Account
custodian through the canonical Action approval owner. Consent, root changes
and deletion retain dangerous-Action approval (Ask first by default); a caller's
`confirmed` flag cannot grant it. Dismissal is client-local presentation state
and is unavailable to a headless caller, not a consent mutation.

In development source, each plugin's metadata-only `accountingSource` declares
the ids emitted by its real codecs: `codex-native-accounting`,
`pi-native-accounting`, `opencode-native-accounting`, and Claude's shared
`claude-assistant-usage` / `claude-sdk-result` ids. The existing collector projects
these as `accountingSources` together with the witnessed Machine and
`captureKind: 'from_logs'`. Accounting coverage retains the same Machine/capture
provenance; filesystem paths are only authorized display metadata, and the opaque
capture-root id continues to address consent and deletion. Exact filters match
the accounting ids, never a guessed `native` path or Agent alias. Older retained
capture state remains readable through the tolerant stored reader. Missing
accounting metadata permits unfiltered inventory but cannot establish an exact
source match; fresh metadata discovery can supply it without reading records.

Sources and Work reuse the External Sessions candidate and link owners for
eligible outside sessions, through `sessions.external.link.ensure`. Linking is
separate from accounting capture consent. Opening Sources or Work does not grant
vendor-history access: Usage's shared candidate composition lists history-backed
candidates only after capture consent or an explicit browse interaction. Explicit
browsing/linking never enables capture; root, consent and Account changes retire
the applicable browse intent and late candidate/link results. Stop and history deletion follow their
consent/history authority even when the source's reader or ingest is unsupported.
Discovered and stopped rows can change their root through the existing root Action;
the resulting root still requires fresh capture consent.

Background capture settlement emits a strict, content-free ephemeral
`usage-sources-invalidated` wake through the existing admitted Machine socket.
It carries only Machine and installation identity, after the collector releases
its task. The existing Home invalidation subscriber rereads `usage.sources.get`;
the event is not source-status authority or durable delivery. Empty captures also
wake readers, and reconnect uses the existing Home refresh path. No polling or
second status store is introduced.

The daemon owns per-root consent and sealed pending accounting. Stop retires
capture demand but retains pending rows and captured history. A root change
retires the old capture and requires consent for the new root. Delete history
removes that source's native captures in the selected range; it does not delete
vendor files or runtime witnesses from Happier Sessions. Deletion retires
collection until explicit consent is granted again, so source replacement cannot
silently repopulate deleted history. An invalid root leaves the old scope intact.
Paths may be shown through the admitted Machine transport but never enter usage
ingest. All root-bearing Source results use live-only Approval custody, including
discover/get when a policy forces approval of those safe reads. See
[encryption.md](encryption.md#usage-accounting-03-development) for the consent
disclosure and server-readable accounting fields.

### Filesystem mutations and finite transfers (development)

The filesystem Action family addresses an exact Machine and reviewed workspace
root. Bounded read-file, write-file, list-directory and directory-tree requests
now enter through the same strict Action family as create-directory, rename,
delete and copy. The existing daemon filesystem handlers remain the canonical
path/security and size-limit owners; retained released RPC method names are
carrier aliases, not a second policy path. Inline writes retain dangerous-Action
approval and expected-hash enforcement. Bounded reads return their existing
base64 or metadata-shaped result and do not move transfer bytes into an Action
receipt.

Create-directory, rename, delete and copy reuse the filesystem-policy and
mutation owners; destructive effects retain configurable dangerous-Action
approval. Rename admits the present user's UI request directly, while Agent,
MCP and CLI requests retain Ask first by default; an explicit Settings → Actions
requirement still applies to the UI. Delete retains its confirmation.
Newer semantic RPC carriers refuse unsupported
older daemons instead of delivering rooted instructions to an older handler
that ignores the root. Retained incumbent RPC names translate their released input
at that same owner and still enforce its filesystem authority.

Upload and download use the incumbent prepared Machine transfer carrier. An
accepted result contains the prepared transfer and an operation receipt; it is
not proof that bytes arrived. The existing operation stays active until import
finalization or successful destination completion, cancellation, failure or an
unknown outcome. Export resource release alone is not destination success.
Cancellation addresses the prepared record and its exact root/requester scope;
it does not add a second transfer protocol or erase an unrelated transfer.
Automatic byte-driver cleanup instead uses the original opaque HTTP transfer
capability, as chunk delivery and finalization do; that capability is not an
Account/root grant. User cancellation can release those original resources
through the same captured Account, but Account retirement cannot borrow a
replacement sign-in. Explicit semantic cancellation retains Action approval.

Concrete UI/CLI drivers bind the source or destination identity to their actual
local byte adapter. Generic Action clients without that adapter return a typed
unavailable result before preparing a transfer; an arbitrary identity is never
interpreted as permission to read or write a local filesystem path.

In development, a plugin Action that acquires provider bytes can use
`context.services.fs.prepareDownload({ name, bytes, destination }, { signal })`.
The Action declares file-writing danger and an Activity operation, and its strict
input admits the receiver's opaque top-level destination. This capability grants
no workspace root or arbitrary output path. The provider Action itself is the
effect authority: it does not invoke a second filesystem Action. Present-person
and automated approval follow that same Action's declaration and Settings.
The existing operation returns the canonical accepted receipt to the caller
before delivery; `prepareDownload` remains pending inside the handler until the
existing receiver completes or fails. Its receipt names the actual operation,
and the incumbent transfer lifecycle retains the binary source through ACK,
cancellation, authority retirement or expiry. Provider bytes and signed provider
URLs never become Action JSON. The caller-held receiving device still owns Save
As, overwrite choice, integrity verification, destination completion and ACK.
Only the physically owned transfer advertises Stop support; an arbitrary plugin
AbortSignal is not a cancellation guarantee. Native failure or an unconfirmed
transfer cannot become a successful operation merely because the handler returns
valid result JSON. The operation also waits for later handler work, preserving
its failures, and a late Stop cannot undo already confirmed delivery.

Save As and clipboard placement remain client-local effects. The Action layer
admits and references the existing transfer lifecycle, while the requester-owned
driver keeps byte custody, destination finalization and cleanup.

The File page's **Open in default app** is also a present-user, client-local
effect and is deliberately excluded from Actions. It hands a downloaded file to
the person's operating-system handler, which can execute that file; an agent
has no default application on that device. This exclusion does not change
`daemon.filesystem.download` admission or expose an Action for launching the
operating-system handler.

Target copy addresses both exact Homes, Machines and roots. The original
Account-client driver admits source and destination independently with their
own credential bindings; a destination daemon does not impersonate the source
requester with its owning token. File copies retain actual size/hash custody.
Directory and symlink copies reuse the existing entry-manifest/blob codec,
prepared imports, private staging and native confined materializer, without a
saved Sync relationship or a second copy protocol. The copy operation completes
only after the actual destination apply settles, not when a blob upload ends.
Prospective symlink targets must remain admitted after relocation; native
recovery-needed outcomes remain unknown rather than claimed success.
Local copy uses that same complete-entry materializer: overwrite replaces the
selected destination entry, rather than merging directory contents. Selected
workspace entry names, including a literal `~`, are not home shorthand.

The credentialed Account-JWT copy driver is mounted beneath public Action
admission. A prepared-file API-token copy fills its original admitted import
receipt, never a second destination copy. Address-only API-token copy and public
prepared entry-tree input lack the live preparation/source custody port and
currently return a typed refusal before source preparation.

Upload, download and prepared copy consume the existing result-required approval
flow so their mounted byte driver remains present through admission. Semantic
rooted mutation RPCs likewise use the live canonical Action owner with the
verified requester; only released unrooted aliases retain their narrow
compatibility adapter. Their dangerous defaults also apply at the new semantic
RPC entry points; this does not change ordinary incumbent internal RPC policy.
The mounted transfer result uses the existing live-only approval custody mode.
An actor stamp alone cannot supply another Account's settings or approval
Artifact authority: until that requester producer is available, the daemon
refuses foreign-Account filesystem Actions before admission/effects rather than
borrowing its owner's authority. Explicit UI-required copy approval currently
lacks forwarded confirmation correlation and can also prompt at the destination
RPC; it never supplies a client-written waiver. These are development-source
contracts, not a completed cross-platform or loaded-runtime certification.

### Project worker preferences and Machine policy (development)

Worker preference Actions address one Home-qualified checkout, not the whole Account
settings document. Their finite preference is one semantic entry in the reserved
workspace execution-config row; set/reset preserves the separate service intents.
Defaults apply only to a successful absent read or valid opened default finite
values. A service writer can materialize those defaults without conflicting with
the first finite preference write; another finite edit still conflicts. Locked,
invalid or unavailable content remains a typed refusal. A lost write acknowledgement
is observed at that exact row, not blindly replayed. This row is not a global
Account Settings binding or a client-owned settings cache.

Machine work admission uses `finitePolicyV1` inside the existing Machine content
and metadata CAS. Its semantic writer preserves unrelated metadata and consumes
the current mode/key and Manage admission owners. `runAtMost: null` means No limit
only after valid content has been opened; unavailable content does not imply
unlimited admission. Preference and policy mutations do not start, cancel or
retarget accepted work. Their dangerous-Action approval is owned by the same
configurable policy as other Actions.

Protocol owns placement precedence and the purpose-qualified advisory pool selector.
Detected native targets and declarations without portable execution permission
are primary-only. Selecting workers does not grant portability: an explicit worker
choice or an implicit accepted worker baseline is refused with `primary_only`.
A named declaration's `execution: 'portable'` permits worker placement; an accepted
Workflow Machine remains the baseline until explicit reviewed admission permits
an override. Session pool
selection retains tier/hash affinity. Finite/service selection uses the smallest
eligible tier, then the smallest known running count and the same affinity;
unknown load is not zero, and full workers can still queue at the target.
The Account-side pool Action reads each exact candidate through the worker status
Action and uses this same selector. The raw server resolver handles Session
selection only; it does not infer finite eligibility from Session presence.
Status carries the qualified source workspace, exact candidate Machine, purpose
and optional reviewed memory demand. Its eligibility and load are separate facts;
eligible unknown load remains unknown. Reading status never starts work or pumps
the accepted queue, and target acceptance rechecks current authority and policy.

A too-small refusal can carry `observedMemory` with the total and available bytes
from the same validated admission sample. The explanation compares the reviewed
demand with total memory, not temporary free memory; unavailable telemetry supplies
no invented quantity. The default observation uses the operating system's total
and free memory and does not claim container-limit qualification.

Definitive pre-acceptance worker refusal retains the configured `ask`, `primary`
or `fail` choice in the finite Action failure's typed `no_worker_can_accept`
details. The Scripts controller exposes those facts as `failure.workerRefusal`.
Current V2 approval history retains the same closed facts only for a valid Script
or compute request whose SOURCE Home matches its execution origin. Stored reads
project known fields; writes reject extra details, mismatched codes and unknown
eligibility. Released V1 history remains detail-free and grants no replay authority.
Recovering on primary or another worker requires a new explicit Run choice and
ordinary admission; the failure neither authorizes nor automatically runs it.
Unavailable eligibility remains `worker_status_unavailable` at pool aggregation.
A full queue, unknown policy or memory, possible acceptance, and a failed command
cannot establish this fallback condition. These new development contracts are
still under package and loaded-runtime validation.

Service-start status uses the mounted declaration starter and current host execution
ports, the canonical feature decisions, exact linked target/root and daemon drain.
Finite accepting and count capacity describe finite load; they cannot reject a
long-lived service or reserve its lifetime. Unavailable finite-policy telemetry
keeps load unknown without inventing a service policy. A genuinely finite setup
still uses finite admission and releases its reservation before service lifetime.

Service placement saves a separate next-start intent in that same workspace row;
it never moves a running service. The placement read returns desired/default
provenance separately from native custody on the source and its current linked
copies. Managed-only snapshots ignore launcher Hide, and incomplete or unavailable
custody cannot establish absence. Native declaration identity uses the same
qualified discovery owner across copies. Shared requester visibility and external
general linked-Machine read delegation remain unproven; generic Machine access is not a
replacement. Source-to-worker Start and confirmed Move are still being integrated,
not a completed or released capability.

The development Move coordinator retains its reviewed SOURCE root and original
envelope for the exact incumbent snapshot/Stop and selected destination
service-start status/Start. These children use the existing signed Machine RPC
transport; the SOURCE signature never becomes a destination grant. Home checks
the original principal, current root and destination Machine access, and the
receiving executor opens the original input with the admitted requester's
material before comparing the service binding, selected Machine and current
linked refs. Another Machine, effect or service cannot spend that Move. Loss of
access refuses a replay before effects. A retained paired-terminal credential
keeps its original automation authority; it does not become an Account sign-in.
Codec and native-preparation reads use
that original requester's existing private Account ports, never the custodian's
credential. Controller-routed clean preparation uses the same signed SOURCE
mechanism as finite work and checks the source ref and reviewed destination.
The native starter consumes retained admission through the shared approval-policy
owner while preserving fresh effect-digest checks. The SOURCE rechecks its
original requester on the post-placement observation before native Stop.
Approval replay retains the exact original envelope only while needed; terminal
settlement removes it through the existing approval owner. Package and loaded
Move validation remain integration obligations, not a release claim.

Development UI launcher snapshot Actions carry the requested Workspace scope and
root through the existing client and scoped subscription store. A qualified Start
receipt updates that request's Workspace feed, not another Workspace on the same
Machine. Neither publication changes native custody or the saved placement.

The receiving literal-host slice keeps the accepted SOURCE declaration immutable,
reviews the addressed worker's effect, and uses the existing routed clean Sync
preparation only during Start. Copied declaration, placement, receiving platform
and configuration changes require fresh review rather than stale-byte launch.
Actual finite setup consent resumes in the same operation and reservation.
Finite and service receiving admission use one classifier for primary, exact
Machine and current enabled/connected pool membership. It validates the already
addressed receiver through the canonical pool read; it never selects or reranks.
Native review, copy and final launch recheck the same passive service eligibility,
so entering daemon drain prevents a new service without pumping finite work.
Source-side exact/Auto dispatch still needs the canonical pre-approval target and
native-effect carrier; a generic SOURCE approval is not consent for an unselected
worker, and selecting a different native target after approval cannot supply it.

Relocation's existing operation observation retains the observed old native target
when Stop is unconfirmed. Before a new Start dispatch, that attachment becomes the
once-selected new destination, without claiming a new native lifetime. Unknown
Stop never authorizes replacement; unknown Start never authorizes reranking,
fallback or replay. The real compound Action integration remains pending.

The target's process-local finite admission owner keeps accepted work in one FIFO.
Copy, reviewed setup and the process share one reservation; cancellation requests
or an unknown process outcome do not release it. Optional reviewed memory bytes
use the same reservation. Current memory pressure queues capable work, while a
demand larger than the observed effective total is refused before acceptance.
Measured evidence is an optional observation link, not another authorization gate.
Status reads this owner rather than a separate load cache. Capability publication
uses the Machine's existing complete publication and acknowledgement owner, and
must follow the installed finite handler's lifetime.

Admission captures the selected Script execution basis from its SOURCE: command,
environment/config declarations and passive hashes of selected execution inputs.
Dequeue rechecks that basis before copying, then checks those same inputs in the
copied target before effects. Changed execution inputs fail with
`project_script_effect_changed` and typed `pendingApproval` review facts; they do
not resume through setup consent or launch a substituted command. Ordinary project
data is not frozen and still reaches the worker through fresh Sync.

The installed finite runtime keeps local custody checks separate from fresh
Home effect admission. Local row/manifest/tool preparation uses the admitted
requester context and its pushed encryption invalidation. Each signed HTTP
request is still verified by Home at its destination. Worker-copy admission,
native setup and the final Script/Exec spawn explicitly revalidate the current
Machine and original root/grant/epoch after preparation. Passive readiness
retains its current Machine checks before returning private results. These are
0.3 development contracts; loaded-runtime latency validation remains separate.

Current queue progress is a phase observation with a nonnegative numeric
`queueAhead`, not percentage progress or another operation state. The same
operation's V1 outward projection omits that additive field for strict predecessor
readers; current V2 readers retain it.

The same accepted operation changes from `queued` (with `queueAhead`) to
`preparing` after reservation; this is not a second operation or a claimed
process launch. Machine-wide `machines.work.summary.get` may include
`finiteLoad` from that same admission owner, independently of a Workspace.
Requester task counts include other work and must not be substituted for
finite reservations. Unknown requester inventory can still carry known finite
load, without inventing an empty requester list. Missing policy, producer or current lifetime yields
unknown load rather than zero, under the existing summary access checks.

Sync status's optional `lastCleanSyncAtMs` records only an actually completed
clean flush in the current relationship lifetime. Passive checks and recovered
cycle counters do not advance it; an absent or null value is unknown. It is an
observation, not permission to skip a worker's next dequeue Sync barrier.

In 0.3 development, a signed `projects.script.run` or `projects.compute.exec`
prepares its linked worker copy through the existing Sync `prepareBetween`
controller route. The original Action remains addressed to the worker. Its
installed sender attests the original envelope and exact preparation request;
Home rechecks that requester and the selected controller before forwarding it.
The controller opens purpose-bound requester custody, reads that Account's
current refs privately, and uses the incumbent relationship and root owners for
the clean barrier. Preparation does not borrow the custodian's Account sign-in,
publish the requester's graph as the daemon's graph, or authorize another Run.
Exact-daemon finite approval replay retains the signed original envelope in
the existing approval origin and restores it with the original requester root;
it does not reconstruct protected ciphertext from the reviewed input. That
replay-only envelope is removed when the approval settles, together with the
existing input-settlement projection.
Package and loaded two-Machine validation remain integration obligations.
Readonly committed-copy preview may include `sizeBytes`: observed logical
regular-file bytes including retained caches, excluding symlink targets. This
optional metric is neither transferred bytes nor a persisted custody fact;
missing measurement never implies an empty or current copy.

Personal copy retirement uses the same Sync relationship termination owner as
ordinary termination, but only a relationship with canonical `worker_clean_copy`
provenance and its bound target direction is a worker copy. Missing or unknown
stored provenance is not inferred from a cross-machine link. The Machine's
current Account/Home row reader uses that same fact; unavailable or incomplete
rows remain unknown rather than an empty Fresh copies list.
The controller's current dependent work and the reviewed definition are
checked before mutation. Definition-only retirement is a controller-owned
settings change and preserves target bytes. Retiring a disabled definition does
not require a reachable target.
Queued remote work revalidates its Sync route before preparation; retirement
does not stop an already running remote process.
Optional reviewed removal additionally requires the Sync component's dependency
observations and original committed-copy materialization evidence,
including the original worker creation binding written
by the target from its persisted Home definition, and exact physical-root custody.
A later review, transient marker or recovery cannot enrich an ordinary receipt
into a removable worker copy. Replaced, symlinked or
user-created roots are refused. Unknown removal remains inspectable and does not
authorize a second deletion attempt at another path. Releasing root ownership or
aborting an uncommitted materialization is not committed-copy deletion authority.

In development source, readonly personal copy review uses the strict safe/read
`projects.worker.copy.inspect` Action, including the Fresh copies UI helper.
Its binding reaches the incumbent Sync committed-copy inspection owner, which
refreshes current Home rows around target inspection, checks current Manage
ingress and installation lifetime, and derives the review fingerprint from the
genuine committed receipt and physical root. The exact Home, relationship and
target produce the existing preview/removal identity, including `rootFingerprint`;
consumers do not calculate it. Not-owned and unavailable remain distinct from an
empty copy. No caller path, row presence or
preview result grants deletion authority; removal remains the separately approved
`projects.worker.copy.retire` Action. Loaded app/headless validation remains an
integration prerequisite for this development contract.

These are unreleased source contracts. Installed target status/admission, service
execution and the composed app/headless journey must be validated together
before claiming the worker flow is available. The generated host Action reference
owns the Action inventory and DTOs; this page does not maintain a second list.

### Standalone MCP delivery (development)

Standalone MCP admits External Session Actions through the shared CLI executor before
calling the addressed Machine's existing ActionSpec RPC method. Discovery, deletion and
linking use the parsed Machine selector; operation controls and materialization resolve
the linked Session's authenticated owner. Explicit target conflicts are refused, and
delivery never remaps an exact target to a replacement Machine. Operation results use the
existing semantic projection rather than exposing private daemon progress.

Client-placed Actions retain the exact Home's signed-root admission and connected-client
reverse dispatcher. Session-only commands outside the signed-root vocabulary require a
bound Session host: standalone MCP excludes them from tools and resources, while the
Session-host MCP retains its current-viewer presentation command. MCP remains Account
automation; reaching a daemon does not confer present-user authority or waive approval.

### Widget instance placement (development)

Widget Action specs own input-dependent execution placement. Account-owned placements use
the Account executor; Companion instances, transfers with a Companion endpoint, and refresh
use the answering client's existing reverse dispatcher. A headless host without that client
returns typed unavailable rather than trying to materialize Companion state. Both
`widgets.item.*` and widget mutations in `boards.apply` share configured-instance
admission before their existing surface writers.

Standalone CLI reads of a specific installed widget or plugin input type use the
existing Account Machine selector and plugin availability census to choose a
reachable Machine carrying that plugin. An explicit Machine selector or selected
Session keeps its exact target. If no eligible Machine carries the plugin, the
Action returns `widget_type_unavailable` naming the missing plugin; an incomplete
or failed census remains unavailable and cannot establish absence.

### Entity drop effects (development)

Entity dragging selects a semantic destination and calls its domain Action. There is no generic storage-mutating drag Action. Pointer release, staged keyboard, menus and agent requests consume the same current domain resolvers and writers: relation changes retain `session.manager.set`, organization uses `session.organization.move`, and navigation uses the workspace tab and split owners (`workspace.tabs.*`, `workspace.split` and `workspace.groups.*`), including Session destinations. Workflow binding edits only the mounted draft's conversation; composer transactions insert typed context without sending it. Pending and todo reorder retain exact recipient/current membership semantics. Widget movement delegates to the configured placement owners rather than a drag-owned store.

The mounted [entity runtime](../apps/ui/sources/components/ui/treeDragDrop/entityDragDropRuntime.ts) revalidates the source, target and admission on completed release. Hover and cancellation do not write. A refused target returns its typed reason; dangerous effects use the existing configurable approval policy. UI input does not confer present-user authority on a plugin or agent. Once dispatch starts, an acknowledged refusal and an unknown outcome remain distinct; drag cancellation cannot rewrite an issued effect or replay it.

Client draft, canvas and picker Actions require their exact answering mounted owner and return typed unavailable when it is absent. Repository upload picking requests acquisition through the existing transfer owner; it does not fabricate OS file handles in JSON or promise upload completion. The generated [host Action reference](../apps/docs/content/docs/plugins/api/host-actions.mdx) owns the complete ids, inputs, outputs and execution placements. [Plugin source/target authoring](plugin-platform.md#entity-drag-sources-and-drop-targets-03-development) describes the declaration and Action allowlist seam. This is 0.3 development behavior, pending the composed loaded-platform journey.

In 0.3 development, `workflow.authoring.draft.get` reads the answering client's mounted Workflow editor (omit `draftId` to list drafts in the exact Home/Account scope). It returns the authored definition, block labels, settings, validation issues, dirty state and `draftRevision`. `.edit` accepts the same Protocol edit operations as `workflow.definition.edit` and an optional `settings` patch for description, project target, execution target and trigger drafts, guarded by `expectedDraftRevision`. Supply operations, settings or both; a combined edit is one undoable change and highlights changed blocks. Trigger settings use the desired rows and context returned by `.get`, not a durable trigger write. Native settings controls share this snapshot mutation owner, including on a new unsaved Workflow. Stale revisions, invalid edit operations and unavailable trigger restoration are refused without partial edits. Definition operations and description require document-edit access; a view recipient retains the native editor's personal target and trigger permissions, but not Undo, Redo or Discard authority. `.undo` and `.redo` use the existing editor history. These operations neither save nor run. `.save` is an explicit write through the host's existing validation, saved-revision CAS and trigger Save, and waits for its outcome. Its definition and trigger child Actions retain the admitted caller's surface, authority, identity, provenance and restrictions; parent confirmation or approval bypass is not consent for a child Action. Agent trigger approval can keep Save pending without a trigger effect; native Save retains UI admission. Save preserves its existing sequence rather than becoming transactional: a definition or personal target already saved can remain committed if a later trigger write is refused, with pending trigger edits retained for retry. `.discard` is danger/present-user-authority, requires human approval for automated callers and follows the existing confirmation. Cancel retains the draft; saved-document Discard changes stays undoable. If a route change or import replaces the draft while confirmation is open, the confirmation is refused and the replacement's content and history stay intact. Conversation binding shares this mounted registration. No/ambiguous matching owner is `unavailable`, and a Home/Account mismatch is refused; no Action opens, loads or creates an editor. These client-placed Actions are exposed through Agent/MCP, conventional Voice and the existing answering-client CLI transport; raw RPC exposure remains disabled.

The shared edit operations include `upsert_role { role }` and `remove_role { roleId }` for definition-local roles. Upsert adds or replaces the canonical `WorkflowRoleV1` entry by its unchanged id, including inline name/instructions, engine and runs-as or a catalog-role pin. Remove deletes that local entry, restoring catalog inheritance for a referenced role. The native Roles editor dispatches these same operations as one history batch per edit; saved-definition validation and frozen Run role admission keep their existing owners. CLI commands follow the Action ids (`workflow authoring draft get|edit|undo|redo|save|discard`, `workflow run review draft set` and `workflow library view get|set|reset`). Review preparation and Library-view commands still operate only on the answering client's mounted owners, with their existing authority and confirmation rules.

The shared saved-definition owner applies `admitAgentStartV1` to agent create, update and edit, including child Actions from mounted draft Save and Save as copy. It checks the materialized permission ceiling even when an Action-only or Wait-only workflow starts no Agents, and resolves nested plugin workflows through the same materializer. The same ceiling governs Run admission: non-Agent leaves contribute declared permissions, including inherited defaults; omission grants no additional authority. Agent steps retain their canonical `default` permission when omitted, and resolved child starts contribute their effective permissions. An excessive ceiling returns `definition_exceeds_authority` with the policy cause before the Artifact write; the stored content and revision stay unchanged. Mounted draft Save retains the canonical failure code in its refusal's `reason` and keeps the local edits. Missing caller context is refused rather than treated as a human edit. Human definition edits remain unrestricted by Agent-start policy. Trigger writes consume that same ceiling and policy; import and capture only prepare unsaved content.

`workflow.run.review.draft.set` sets only the displayed human value buffer for an exact mounted hold (`draftId` is the invocation id, plus `runId` and `expectedContentRevision`). It preserves Keep my edits / Use newer when another result arrives and never publishes or accepts a result. Acceptance remains `workflow.run.invocations.complete_review`. Saved-definition edits and agent result publication keep their separate persisted contracts; mounted-draft Actions do not add another store or channel.

Mounted Workflow Actions use the existing Machine reverse-RPC room with the Home/Account scope and draft id in its address. Only the client that currently mounts that address registers it; another signed-in tab cannot answer through its generic client Action handler. Replacing or closing the draft retires its address. A scope-only Get uses the same room family for the mounted scope, and multiple answering clients are unavailable rather than selected by socket order. The exact installed Machine still authenticates the continuation: installation custody is checked on the sending daemon, not on the receiving App client. The answering client rechecks Account scope and normal Action approvals.

### Personal Session pins (development)

`session.organization.pin.set` writes the caller's personal pin on the exact Home through the Account HTTP owner, including from a headless CLI or MCP host. It does not wake the Session's execution host. The optional `surface` selects `list` or `rail`; omission retains the Session-list meaning. Rail additions read current authorized Session metadata and require the canonical Bot marker, without promoting the Session. Clearing a saved rail choice remains possible after demotion.

One Account/Session pin row holds both memberships and one shared order. Changing membership preserves its existing order and timestamp; clearing one surface preserves the other, and the row is removed only when both are clear. Both surfaces share the existing pin budget and a Session counts once. Retained three-field rows normalize to list-only. Stored readers tolerate unknown fields; current requests and acknowledgments remain strict. A missing effect producer returns typed `unsupported_action`, with no fallback that creates a list pin.

Pinned reordering remains `session.organization.move` through the answering client's existing anchored organization adapter. Its rail projection uses the same order writer, never creates rail membership, and is unavailable without that mounted owner; there is no standalone headless reorder substitute.

### Accepted Session association (development)

`todos.session.link` associates an already accepted, Home/Account-qualified Session with an exact Zen task. UI accepted creation and the Account Action executor use the same `todo.<id>` semantic KV/CAS owner; CLI (`todos session link`) and MCP (`todos_session_link`) project the catalog operation. It never creates another Session or changes human-owned Done. A missing task or mismatched task Account is refused. An ambiguous write reports `unknown`; retrying the same qualified association is idempotent. Released bare Session-key links remain readable and are recognized on same-Account retry.

### In-surface Find (development)

`ui.find` uses the mounted app's focused Find surface, shared with its keyboard
commands and Find bar. It reads status or sets a query/options (optionally naming
a mounted surface), steps, stops searching, or closes Find. Results contain
status, counts and coverage, never transcript or file text. `noMountedSurface`
is distinct from a mounted surface with zero matches. This client-placed Action
does not create a headless search engine in the CLI, daemon or Home.

Accepted Session/Project file Find navigation uses `workspace.tabs.open` with a private,
strictly qualified launch seed. The mounted Workspace Action validates the
Session or Project destination, addressed file and current Home/Account authority, stages the seed in the
existing one-shot file Find handoff, and only then opens the file. Query text is
never serialized into the URL or tab state. Session chat Find keeps the same
private handoff and lifecycle under the same Workspace Action owner.

The canonical file opener also accepts `present: false` for preview positioning
in the foreground, exact Session and retained tab instance. It uses that
Session's registered pane driver without presenting the pane, changing the
foreground main tab, or pushing a native route. Existing Session pane URL
mirroring still projects retained state. Normal Action policy and dirty
guards still apply. A missing driver, different foreground Session/instance or
Project target is refused; this option does not open a hidden destination.

Monaco remains focus-addressable while its native widget owns physical Find
shortcuts. Set, step and close use public editor actions. Its read projection
returns the last host-known query/options with `status: 'unavailable'` and
`unavailable: 'engineOwned'` for counts; native widget edits and counters are not
available through Monaco's public API.

### Code navigation (0.3 development source)

Unreleased 0.3 source declares `code.hover.get`, `code.definition.get`,
`code.references.list`, `code.symbols.list`, `code.diagnostics.list` and
`code.restart` through the canonical Action catalog and Machine transport.
All six are safe and available to plugin callers by default. The five queries
are reads; Restart is a reversible write that changes no workspace files.
Their required result custody does not request a prompt: no surface, including
Agent, MCP, CLI or plugins, asks by default. Explicit Action approval settings
still apply.

Session-bound Agent tools default `machineId` and `rootPath` to the calling
Session's Machine and workspace through the shared Action tool-context owner.
Discovery makes those fields optional only when the host supplies them. The
same defaults cover semantic rename/code-action previews and applies, workspace
file search/replace, and the Machine field of Processes. Explicit targets win;
another Machine requires an explicit root. File paths and reviewed edit operands
remain explicit, and sessionless calls retain their required scope fields.
This changes no approval policy: normalized scope is captured before approval.

Queries use disk text, not an editor buffer, and successful semantic results
include `fileHash`. Unsaved editor changes are refused with
`unsaved_editor_changes` and the current `diskHash`. Position-bearing Actions
accept a one-based `line` with either an explicit `symbol` (and optional
one-based `occurrence`) or a zero-based UTF-16 `character`. Invalid positions
and unresolved symbols remain typed errors; symbol lookup reports candidates
instead of guessing a column. A cold project returns `loading`, never an
authoritative empty result. Diagnostics explicitly request a fresh check.
Queries and Restart retain caller cancellation without a separate operation
deadline; transport connection and setup keep their canonical finite budgets.

The editing-intelligence extension uses the same session scope and disk-text
rules for `code.completion.list`, `code.signature.get`,
`code.typeDefinition.get`, `code.implementation.get`,
`code.symbols.workspace` and `code.callHierarchy.get`. Workspace symbols accept
a query string; call hierarchy accepts a position for every direction and
prepares incoming/outgoing targets in the same request. Returned server/item
ids are also usable while their document stays open; they are not durable
references across a server close. `code.diagnostics.list`
accepts `scope: 'project'` for an explicit whole-project check. These are safe
reads; unsupported server capabilities remain unavailable.

`code.format.apply` and `code.imports.organize` accept
`operation: {kind: 'preview'}` to return normalized, hash-guarded edits and
`operation: {kind: 'apply', files}` to apply the reviewed result. Format preview
also accepts a zero-based UTF-16 `range` for a selection and `formattingOptions`.
Apply has the normal danger approval default for automated callers and direct
confirmation for a present user. Its separate Machine routes preserve Action
admission and use the existing guarded multi-file writer, per-file outcomes
and inverse edits for Undo. These additions are unreleased development source.

When no server is capable of definition or reference lookup, an explicit symbol
uses the existing workspace content-search owner. Definitions are approximate
declaration candidates and references are identifier text matches, labeled
`text_matches`; search authorization, exclusions, partial coverage and
unavailable outcomes remain intact. A character-only query without a capable
server returns `unavailable/no_capable_server`, not `invalid_position`.
Server crashes, missing methods and transport failures do not become text
search. Older Machines without the new operation return an operation-scoped
`update_required` result.

The app's Restart helper re-enters `code.restart`, preserving Action admission
and the distinction between the routing Home and the optional language-server
definition id. File opening and passive `@` outline requests do not activate a
server; explicit semantic queries do. The syntax outline remains available
without semantic symbol identity. See
[Search](search.md#code-navigation-and-document-symbols-03-development-source)
for its shared search path and limits. These source contracts do not claim
released availability or completed UI/live validation.

### Next pending request (development)

`session.pending.next` takes an empty input and navigates through the mounted
client's existing pending-request selection and exact-Home detail readers. UI,
Agent and MCP invocations share that client placement; this is navigation, not
Session resume or an unattended daemon read. Its closed result is
`{ status: 'opened' | 'none' | 'unavailable' }`: `none` means the checked candidate
Sessions have no answerable request, while missing client custody or unavailable
details remain `unavailable`. The app-shell host derives Account bindings from
the existing credential owner and cancels uncommitted navigation on retirement.
The keyboard reference is generated from the same command registry.

### Detached Run responses (development)

`execution.run.permission.respond` answers an exact detached Run request with
either a permission decision or structured question answers. The Run screen and
Action share the existing daemon request writer; the Action does not replace its
request-identity validation or result observation. It requires present-user
authority. Agents and MCP can discover it, but automation-authority invocations
receive `present_user_required` without dispatching a response.

### Notification webhooks and this app’s updates (development)

`notifications.webhooks.*` discovers configured channels without returning signing secrets and
adds, edits, removes or changes their signing secret through the captured Account settings writer.
The UI and Actions share the channel reducers and attention-policy mirror. Signing-secret input
uses the Action secret field, is removed from observations, and has live-only approval custody.
Webhook mutations retain ordinary dangerous-Action confirmation and do not send a notification.

The Account endpoint-catalog cutover is in progress in 0.3 development. The catalog
dispatcher requires the captured Account's ready catalog and reports missing or partial
catalog authority as a typed failure, without substituting registered push tokens.
Retained Workflow channel ids remain destination ids. The existing
Settings-based editor described above has not yet completed its catalog-consumer validation;
row readiness alone does not certify editor migration or signing-source cleanup.

`notifications.desktop.permission.read/request` uses the answering desktop’s existing
notification plugin. In 0.3 development, automation requests Ask first by default;
the user can waive confirmation for that Action surface. The OS still decides whether
permission is granted. The result reports
the permission observed after the request, not a notification-delivery guarantee.
These client-local declarations do not add a CLI, daemon or server permission path.

`notifications.push.tokens.list/remove` addresses the captured Home’s existing push
registration API. List returns registration ids, masked display fingerprints, timestamps,
client-server hints and a private exact-token comparison’s current-device flag, not native
push tokens. Short tokens are masked completely; fingerprints are not identity operands.
Client-server hints are redacted from observations. The mounted reader retires
results from a Home that is no longer displayed.
Remove carries only the opaque registration id, resolves its token privately on that
same Account, and retains canonical dangerous-Action admission. It does not withdraw
registrations on other Homes or silently reinterpret a missing id as this device’s token.

`notifications.push.permission.read/request` delegates to the incumbent bounded native
access and permission-priming owners. In 0.3 development, automation requests use the
same configurable Ask-first policy as desktop permission requests and keep
the in-app framing and system-settings recovery flow. `notifications.push.register`
runs the existing device-wide reconciler across all locally credentialed Homes;
`reconciled` reports that its recovery attempt settled, not that every Home registered
successfully. Unsupported runtimes, denied permission and per-Home failures retain that
owner’s existing skip behavior. Native token values stay private to those owners.

`app.updates.*` observes and invokes the answering app’s existing platform update owner through
`useAppUpdateStatus`. The mounted shell summary keeps these operations available when the Updates
page closes; retiring the last consumer makes them unavailable. Update, Retry and Restart require
the operation currently offered by that owner, and Skip targets the exact offered desktop version.
Operation results report `requested`; progress and failure remain observable through Get rather
than being represented as an installation-success acknowledgement. These are client operations,
not daemon or server update engines.

### Connected Account configuration (development)

`connectedServices.accounts.list` reads the captured Account's existing profile
inventory, optionally restricted to one qualified service. It returns accounts
and pools with credential-only health (`healthBasis: credentials`), not fresh
provider usage. Missing member facts leave pool health unknown. The source
observation is reported separately; an older profile without the V4 inventories
returns the existing typed unsupported result instead of an empty collection.

`connectedServices.catalog.list` reads held, admitted setup descriptors. Its
ready/partial/unavailable result keeps known unavailable services and their
reasons, without starting sign-in or probing a Machine. UI Account browsing uses
its applied descriptor registry; CLI uses its admitted contribution registry.
Gateway candidates come from the corresponding provider declaration owner.

`providers.gateways.choose` is a non-mutating declaration choice. An exact
qualified contribution key selects only a matching candidate; a service/purpose
can narrow the candidates. Omission selects a sole candidate, while multiple
candidates return `choice_required` with every choice. It neither reads saved
connections nor creates or starts a gateway. An optional Machine uses the
existing exact-Machine declaration path, including installed plugins. These
three read Actions default to no approval; creating or editing a gateway still
uses the existing mutation Actions and approval policy.

`connectedServices.configuration.get/replace` reads or replaces one qualified
service and authentication mode's service-scoped Account configuration through
the existing Connected configuration catalog. No selected or online machine is
required. Protocol owns descriptor validation, secret-field normalization and
the semantic revision check; UI and CLI supply the captured Account's existing
mode-aware catalog CAS transport. Replacement keeps dangerous-Action approval,
and new SavedSecret resources plus their references commit in the existing atomic
promotion transaction. Reads return values, readiness and configured secret field
ids, never secret material. A conflict leaves the caller's draft intact; an
uncertain mutation must be observed with Get rather than automatically replayed.

The acknowledgement means Account configuration was saved. It does not report a
native refresh or reconnect as applied: those consequences remain with the
machine runtime consuming that revision. Account/attempt-scoped configuration
still belongs to the credential/sign-in envelope and its native control owner.
The same development Actions also accept an exact machine and qualified account
or attempt target for that native configuration. Those variants use the existing
daemon control owner, retain revision checking and dangerous-Action approval,
and acknowledge only the committed configuration revision. The service/mode
Account form remains machine-independent; the target forms do not introduce a
second configuration writer.

The development `connectedServices.authentication.*` Actions route the mounted
connection flow and Agent/CLI invocations to the same daemon authentication
owner. Begin, reconnect, manual submission, OAuth completion, device polling and
resume, reconciliation, cancellation and read preserve the incumbent strict
`ConnectedAccountDaemonCommandSchema` operands, including the exact machine and
attempt or qualified service/account. Pending-attempt discovery is a separate
read Action; it never starts or resumes an attempt. UI and CLI adapters retain
the captured Home and Account and check currentness before private RPC issuance
and readback. Effectful steps default to Ask first; the person's UI gesture and
the ordinary Action approval policy remain the consent owners.
The mounted connection view uses the existing Action approval continuation and
pending notice for configured read and metadata confirmations; it retains the
original target and waits for the typed result rather than treating an approval
Artifact as a daemon reply. Private authentication steps keep their existing
blocking, live-only continuation.
The friendly `happier connect` workflow routes authentication, revocation and
configuration replacement through that same executor before issuing an effect;
its existing prompts and diagnostic reads remain on their incumbent paths.

Manual fields and OAuth completion have live-only input custody. Authentication
results also have live-only custody: authorization URLs, OAuth state and device
codes reach only the live continuation, while durable approvals and observations
retain the Action-owned safe target/status projection. Transcript correlation
ids remain available, but a transcript origin's copy of live-only `toolInput`
does not cross that durable/observer boundary. These are development-source
contracts, not certification of a loaded bundle or released mixed components.

The `connectedServices` configuration family lets Agents perform the same account-default,
pool creation/removal, name, policy and member changes as the UI. Its executor uses the
existing purpose-default writer and qualified V4 pool schemas. App HTTP adapters and Actions
share `buildQualifiedConnectedAccountGroupMutationRequestV4`, including the revision-bound
DELETE query contract; no separate pool writer or persistence format is introduced. Creation,
patch and member edits return the acknowledged qualified group for subsequent revision-fenced edits.
Removal clears defaults through `removeAgentConnectedAccountDefaultsForDeletedTarget` after
the server acknowledges the exact incarnation and an authoritative reread confirms absence;
a recreated same-ref pool retains its default. Action discovery, surfaces and approval
remain owned by the ordinary registry.

Mounted pool creation, edits, member changes and immediate switching use those
same Actions; revisioned edits carry the captured qualified ref and V4 revisions. `switchNow` returns
an effect acknowledgement; the UI reads the group again within the captured Home
before presenting its current state. List-only clients have no raw mutation
fallback. `identityPrivacy.set` admits the UI toggle before changing the existing
device-local identity masking setting; it does not write Account settings.
Mounted pool, purpose, privacy and acknowledgement controls use the shared
mounted Action continuation and pending-approval notice. A deferred approval is
not an applied change: the original operation retains its captured operands and
Account custody until the typed receipt, refusal or retirement settles it.

Mounted Agent default selectors submit closed intents through
`connectedServices.accounts.purposeDefault.set`: the choice is a personal account,
pool, shared Team resource or the Agent's own login. An optional declared `purpose`
changes only that purpose; omitting it changes the service's declared purposes.
New-account suggestions use `onlyIfUnset`, checked inside the existing catalog
mutation so acceptance leaves an intervening personal-account, pool or Team
selection untouched. The original
account/pool star Actions retain their exact target semantics. Resource setup uses
`connectedServices.purposes.default.set` with its captured Home, Machine, qualified
purpose and personal target. UI and CLI admission read the selected Machine's
installed Resource declaration and the existing target resolver; the persisted
choice remains a preference, not a permission grant. All writes retain the
ordinary purpose catalog revision check and predecessor-carrier retirement.
In development source, edits to an active purpose or configuration catalog read
its admitted row without waiting for retained Settings-history maintenance.
An absent row still enters the existing catalog initialization path; ordinary
catalog observation continues to own source and history cleanup.

The development Protocol contract separates personal Account/group labels from a pool's
definition name: `accounts.rename` and `labels.set/reset` share the presentation-row writer,
while `pools.patch.displayName` still changes the definition. Acknowledgement Actions address
an exact adoption subject or Account/machine warning; explicit `false`, empty warning ids and
literal machine ids keep their meaning. Disclosure Actions are client-placed and address the
current device's existing local disclosure owner, not an Account row.
The mounted Agent pool-adoption dismissal enters `acknowledgements.set` with
its captured Home and Account before the metadata owner writes its row.

Definite revoke and pool-delete results may carry the existing typed `metadataCleanup` outcome.
`cleanup-pending` preserves the acknowledged primary effect when related purpose/default or
personal-metadata cleanup cannot finish, including after the initiating Account retires.
Qualification is captured before deletion; unavailable preparation never blocks the primary
operation, and missing cleanup support is not evidence of completion. Unknown primary outcomes
remain unknown. These contracts are still being integrated into the captured UI/CLI producers;
their package and composed-runtime checks are pending.

### Ordinary Account Artifacts (development)

The `artifact.*` family reads and publishes ordinary Account documents through
the existing mode-aware Artifact store. Create, update, delete, publish from file,
binary export and restore carry danger safety and require approval by default. Get, list,
revision list and storage usage are reads. CLI commands and MCP tools project
from these same catalog rows; the canonical schemas and generated SDK types
come from [`artifactActionsV1.ts`](../packages/protocol/src/artifacts/artifactActionsV1.ts).

Host UI/Voice and the Account's own CLI, Agent and MCP callers share notice
admission for `artifact.get` and `artifact.update`. Their captured Account may
read its own private notice and dismiss it through the same revision-checked
update, or mark an informational update/mention read. A verified own-Account
signed CLI request retains this access; foreign Accounts, API credentials,
plugin callers and restricted Session RPCs do not. Generic Artifact listing
still excludes internal notice kinds.
Notice admission retains the exact stored body and permits only those header
changes; update still requires ordinary approval by default. Dismissal does not
resolve a source request. A plugin updates or resolves its own stable notice item
through its existing `notifications.send` SDK service; consumers do not
gain producer identity or permission to resolve another plugin's item.

List search, kind filtering and sorting operate on decrypted headers at the
key-holding host, using the existing paginated server list. The server never
indexes plaintext titles or provenance for E2EE Accounts. Explicit `kind` or
`kinds` approval selection also exposes admitted approval headers through
`artifact.list` for the captured Account's own native Inbox caller;
`approvalStates` narrows that same server query before paging. API credentials,
plugin callers and restricted Session RPCs retain specialized approval reads.
This header-only development read carries Action, Session, Machine and Run ids,
state and timestamps without opening receipt bodies. Broad document listing
still hides approvals, and approval body reads and mutations retain their
specialized owner. Publication copies
only from the authenticated caller's own validated workspace through the file
transfer owner, completes that transfer before creating content, and records
host-derived Session, Run, machine, path and digest provenance in private revision metadata.
Create/update can acquire binary bytes from that same proved workspace. The machine-placed
`artifact.export` Action retrieves an ordinary binary document through the authenticated,
mode- and integrity-checked `readBinary` owner and writes its exact bytes into the invoking
Session's workspace through the existing confined upload target and transfer finalizer.
It preserves existing files unless `overwrite` is explicitly approved, refuses escaping
destinations and internal document kinds, and returns only an Artifact id, workspace-relative
path and byte count. It does not expose raw bytes in the transcript or replace Account blob
access with workspace-path-only filesystem download. These are development-source contracts; Plain/E2EE
composed live export remains part of the next owner-authorized QA pass.

In the same development source, `artifact.export` also accepts
`{ portable: { kind: 'role' | 'launch-profile', document } }`. The document must
pass its canonical Role or value-free Launch Profile schema. This arm runs on
the answering client and uses the existing browser download/native share owner
used by “Send a copy”; it neither grants access nor writes an Artifact. Its
receipt contains `exported: true` and the file name. UI controls enter the same
Action as Agent callers, retaining per-Action enablement and the automated
Ask-first default. The original `{ artifactId, path, overwrite? }` input and
workspace receipt remain Machine-owned and unchanged.

Body updates retain prior bodies transactionally. Restore compares the read
header and body versions and advances both atomically. The key-holding host
prepares the header through the document-kind owner, keeping embedded Workflow
revisions and body-derived profile, role and Board projections coherent with
the restored body. Historical rows are never rewritten. Revision reads use
the same current grants, Account mode and recipient key as the document.
`artifact.storage.usage` reports persisted ordinary header, body and revision
bytes; wrapped keys and row metadata are excluded. Optional document and Account
budgets default to unlimited. A rejected write returns `quota_exceeded` with
`{budget,limitBytes,usedBytes}` in the canonical Action failure's `details`.
`usedBytes` is the projected storage after the attempted write. Delete or export
provides recovery; a rejected write changes neither content nor history.

Operators configure retention with `HAPPIER_ARTIFACT_REVISION_RETENTION_COUNT`
(default 10, zero disables retention), and optional byte limits with
`HAPPIER_ARTIFACT_DOCUMENT_LIMIT_BYTES` and
`HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES`. These are live policy entries in the
existing server configuration owner. The document limit covers its current
stored header, body and retained revisions; the Account limit counts these
bytes across ordinary documents. Plain
server-sealing overhead counts toward these storage limits.

Sharing remains with `artifact.access.grants.*` and the server grant owner.
In 0.3 development, an acknowledged grant set/remove keeps its committed receipt
if the key-holding host's follow-up preparation fails, including cancellation
after acknowledgement. The canonical mutation result then includes
`preparation: { status: 'pending' }`. This does not certify current content or
recipient key readiness. An ordinary fresh Artifact read retries preparation
under the existing access, Account-mode and envelope checks; failed reads remain
unavailable. Grant list remains a read and does not turn failure into a receipt.
`getArtifactUseTargetV1` selects both recipient intent and the existing kind
owner's sharing validation in one Protocol policy: prompt document, prompt
bundle, workflow, role, launch profile, Board or generic Artifact opening.
UI and CLI grant executors consume this policy without their own adapter lists.
That intent confers no access. Plugin-hosted artifacts retain their separate
availability and budget owners.

The UI's captured Account/Home Action store handles revision list/restore and
usage alongside ordinary Artifact reads and writes. Create, update and restore
derive an optional `header.excerpt` through the shared Protocol projection:
at most 600 UTF-16 code units (the browser card's preview bound), never half a
surrogate pair. Empty bodies remove stale excerpts. This content stays inside
the existing header envelope, allowing header-only list cards to preview
without another read or a server plaintext index. Stored raw metadata is kept
separate from the UI's normalized display projection; display defaults are
never repersisted into strict kind headers.

### Session terminals (development)

The session terminal Action family delegates membership and docking to the mounted
AppPane workspace, and process work to its existing terminal controller and daemon
PTY owner. UI tab menus and terminal toolbars use the same Action front door for
Restart; a borrowed terminal is read-only, and an unmounted terminal cannot accept
that request. Success admits the restart request, not completion of the new process.
Open in Details pins the existing member's view without creating another terminal.
Removing membership also removes its retained Details views, including hidden groups.
The generated [host Action reference](../apps/docs/content/docs/plugins/api/host-actions.mdx)
owns the family IDs and schemas.

### Work observation (development)

The `wait` Action observes an existing Home-qualified target; it never stops or
restarts the work. Its strict request is `{ target, condition, timeout? }`, with
an optional `timeout.durationMs` observation deadline. The host's captured Home
must agree with `target.serverId` before a read. Terminal means any proved
terminal outcome, including failure or cancellation, not success.

CLI `wait` and `watch` and MCP tools `wait` and `watch` derive from that same row. CLI commands
require `--server-id` and accept canonical `--input-json`. `watch` emits the
initial snapshot and changed snapshots from the target's existing change source;
Ctrl+C releases only the observer. A quiet healthy observer stays pending:
reuse its handle instead of polling. Prefer `notifyParentOnCompletion` or Follow
when the intended result is parent delivery.

Execution terminal observation delegates to `execution.run.wait`. Workflow
`terminal_or_needs_attention` delegates to FIN's `workflow.run.wait`. Session
archive/attention/exact-turn observation uses canonical awareness and turn facts,
with check–arm–recheck on the Session event transport. Session `terminal` means
archived; `turn_terminal` requires the exact `turnId`. Neither offline nor unknown
runtime evidence proves idle or ready.

In 0.3 development, a Session-bound native `workflow.run.wait` can omit
`timeoutSeconds` for an immediate terminal observation after Run custody has
settled. Active or unsettled Runs, and passive snapshot streams, still require
the native caller's authored deadline; omission returns `invalid_input` rather
than occupying a Session that a future Workflow branch may need. Authored native
deadlines retain the existing self-dependency checks.

Session idle/ready observation reads persisted publisher presence (`active` and
`activeAt`) through the existing authorized V2 Session read and awareness
normalizer. Activity, Session changes and reconnect wake that read; the shared
awareness predicate requires live, complete evidence. The Session event source
re-arms long observation deadlines at Node's timer boundary without capping the
accepted duration.

Session reads, including the activity read inside `wait`, use the Action executor's
shared Session-scope admission. An Agent may read its own Session or a Session in
its server-proved led subtree, using the same host-resolved Session caller facts
as Agent-start admission. Missing caller facts or unproved membership refuse the
foreign read. In 0.3 development, a restricted `current_session` host can also
read its own managed subtree when the Home proves current runtime authority and
filters membership through ordinary access. SessionTarget previews and read
admission consume that same paged Under-self proof; an unavailable proof never
becomes Account-wide access or widens current-Session-only START authority.
Private Follow-rule facts remain unavailable, so
their absence cannot produce a complete Followers selection. An `unavailable`
corpus cannot authorize a subtree read. In 0.3 development,
`session.stop`, `session.archive` and `session.unarchive` use this same fresh
led-subtree admission. Their Settings → Actions Agent-disabled defaults and
approval requirements still apply. Fork and open retain their existing scope.
Lifecycle scope observation that cannot reach a complete Home result returns
`target_unavailable` with `details.cause: 'subtree_observation_unavailable'` and
`details.retryable: true`, without executing the effect. A completed observation
excluding the target retains `unsupported_action` / `target_outside_led_subtree`.
An admitted Agent stopping its own Session retains `unsupported_action` with
`error: 'self_stop_forbidden'`. Archiving an active own Session reaches this
same Stop refusal; it does not imply that the Session is outside its subtree.
Relation membership does not replace ordinary Home access or grant other
mutation rights. Caller identity, turn depth and subtree membership cannot be
supplied in Action input.

In 0.3 development, an Agent answering a host-addressed Discussion question can
also use `session.transcript.get` for that Discussion's quoted source Session,
including transcript pages beyond the selected message. The scope owner reads
the current Discussion and its exact question under the protected original
cutoff; a navigation anchor alone grants nothing. The two preparation reads
retain the signed transcript Action root. Ordinary source Session read access
still applies, and the final transcript read rechecks that the full current
runtime audience may receive the source. Revoked access, a mismatched source or
an unreadable question cannot authorize a foreign Session read. This does not
widen an external plugin caller's Session scope.

The development `session.archive` Action accepts optional `alsoArchiveReports`.
Omission or `false` archives only the selected Session. With `true`, the archive
owner reads the current Home's active Session list and archives only unarchived
direct reports, not grandchildren. Each report re-enters ordinary Action rights,
scope and approval admission; approval for the lead does not approve its reports.
An active report uses the existing Stop Action before retrying Archive. The
strict result confirms the lead with `success` and `sessionId`, and returns each
report as `archived`, `failed` or `approval_pending`. A failure does not prevent
the remaining reports from being attempted. `reportsError` records incomplete
discovery after the lead was archived. The existing UI scope dialog supplies
this operand and presents these outcomes; its cached count is display-only.

The development UI Stop producer retains the canonical `sessionId`, `stopped`
and optional `stopOutcome` alongside its incumbent presentation fields. Exact
daemon absence plus a fresh authorized inactive row retains `already_stopped`;
an acknowledgement or cached/offline appearance alone does not confirm Stop.
UI archive/unarchive refusals use the ordinary Action failure envelope, so a
composed lifecycle does not acknowledge an archive the Home rejected.

In 0.3 development, Session Action authorization preparation preserves transient
Home mint failures as `project_requester_home_unavailable`. No effect executes;
the caller can retry after Home recovers. HTTP 401/403 authorization denials retain
their closed refusal, and cancellation remains `cancelled`. This distinction
does not retry an Action automatically or change its authority checks.

In 0.3 development, `session.history.get` is the compact/raw convenience Action
over the daemon's diagnostic Session event reader. The UI delegates the original
history Action through the captured Account relay, retaining its input, caller,
surface and cancellation context. It does not invoke the deprecated
`session.events.get` Action on a surface that disallows it or substitute the
Voice transcript projection. Both Action names share the daemon reader; their
catalogued surfaces and admission remain distinct.

In 0.3 development, an authenticated Session Action caller carries the same
strict Session id, starter depth and turn depth through approval capture and
replay; replay retains the original invocation facts while rechecking current
policy and access. Id-only Session references are not execution authority.
Autonomous Session role edits and Apply-to-reports use the existing native
Session capability channel and the caller daemon's authenticated Machine RPC
socket. Home verifies that Machine currently hosts the caller before stamping
the original Action request, turn and permission facts for the target. The
target rechecks the caller's current led subtree and write ceiling; report
copies also check the current report relation. Agents are never relabeled as
present users. Missing or malformed transported provenance refuses the edit,
including when an older Home drops the new origin header. Role mutations still
enter the target's registered metadata outbox; this adds no role store.

In 0.3 development, `workflow.run.read_state.set` acknowledges an owner Account's
actually opened failed Run with `{runId, revision, failedAt}`. The Home verifies
the observed failure timestamp and current revision; a repeat acknowledgement of
that same failure is idempotent even after custody bookkeeping advances revision.
It records `attentionSeenFailureAt` without changing operational revision or
terminal history. Non-owner Team/Artifact viewers retain Failed status but neither
receive the failure notice nor write its marker. Full summaries, source strips and
latest-Automation summaries expose canonical `failureUnseen` and
`invocationAttentionRequired` constituents of `attentionRequired`; a genuine hold
can remain after the failure is seen. Opening an authorized active detail writes
the acknowledgement; collection loading, passive observation and Work peeks do not.

The execution owner now exposes permission-attention selectors and passive
snapshots through the same `execution.run.wait` observation. The workflow owner
also accepts an optional nonempty, unique `conditions` set from `terminal`,
`attention` and `paused`; omission preserves first-of-any observation. Matched
results carry `matchedCondition`. A terminal run with no selected match returns
`not_matched_terminal`, with terminal evidence rather than a false attention match.
Its host-only `onWaitSnapshot` sink emits `{run}` summaries, including canonical
`attentionRequired`, from the same Account change/reconnect feed. Delivery is
ordered and awaited for backpressure; unchanged summaries are suppressed, and
passive observation stays open through terminal until cancellation or deadline.
Invalidations catch up current facts, not an event journal. No polling or new
transport is introduced. In development, generic execution and workflow waits
delegate terminal, attention and combined selectors, and passive snapshot sinks,
to these native owners. Unsupported conditions return an explicit non-match
disposition, not a terminal substitute. Plugin conditions carry `{kind:'plugin', actionLocalId,
condition}`: choose the exact admitted Action from discovery, rather than
deriving an id from the plugin name. The existing contributed-Action dispatcher
admits `{sourceId, condition, timeoutMs?}` against that declaration. GitHub's
`wait/pull-request-checks-v1` accepts `checks_complete` and `checks_passed` for
an admitted checks checkpoint source; failed checks do not satisfy passed.
Plugin passive watching is not exposed by this one-result contract.
Both the Session and external MCP servers advertise `resources.subscribe`.
For targets with an owner-backed passive feed, `watch` returns the exact target,
condition, initial snapshot and `resourceUri`. Reading that URI builds the current
snapshot through the same passive Action sink as CLI watch. MCP hosts can send
`resources/subscribe`, re-read after `notifications/resources/updated`, and send
`resources/unsubscribe` to release observation. Disconnect also releases the
owner subscription. Unsupported passive targets return `unsupported_condition`;
resource subscription/read refusals carry that typed result in the MCP error data.
External MCP consumes the current Session, execution and workflow passive feeds. The Session-host MCP
Account Action channel currently carries one result rather than a passive feed,
so its passive requests return `unsupported_condition` until that channel exposes
snapshot delivery; Account authority remains with the daemon.
A resource-updated notification is a change hint, not a promise of an agent-turn
wakeup: the MCP host decides how to present it. No complete event replay is promised.
Raw CLI/MCP observers have no process-restart durability guarantee.

SDK authors retain exact literal Action ids and input/result types without importing
Protocol's validators. The canonical schemas are the single source of truth.
Named DTO maps generated in the SDK are outputs, never
hand-edited contracts. The explicit source compiler witness checks each family against the canonical schemas
and complete catalog coverage, including the named declarative-node grammar, Action
support declarations and icon vocabulary. This witness is excluded from Protocol's
normal dependency build: DTO staleness fails the correspondence gate, never the SDK's
prerequisite compilation. After changing a schema, regenerate its declaration
projection through the same producer, under its existing publication lease.
The lane changing that input runs the writer; a consumer-only edit reuses the
prepared projection. Integration retains the full correspondence and public
surface checks. Existing public projections keep
validator slots opaque, erase validator-only string brands, and admit readonly JSON
inputs without changing normalized result types.

The retained Action-map producer prepares the canonical schema expressions in one
compiler program and shares its checker across families and public support types.
Full and scoped derivations use the same catalog inference order; scope selects
the outputs to publish. Each family is rendered separately, then the generated
neutral declaration closure projects into SDK family modules and a small
`actionTypeMap.generated.ts` index. The printer sorts union members by rendered
text while preserving property and intersection order. Virtual declaration
placement follows the module defining each canonical family
export, with no separate placement list or persisted Protocol DTO copies.
The producer never renders one whole-catalog structural map. Public support and the
declarative UI grammar are derived from their canonical owners by the same producer.
Stable public support exports remain derivation roots even when an Action schema
inlines their uses; recursive interfaces retain their canonical readonly heritage.
The same producer loads the normalized runtime catalog once in memory and emits
`clientRoutedActionIds.generated.ts` as the type-only effective client-capable set.
Protocol's `WithClientRoutingInput` consumes it for both public input maps and
schema carriers; widened schema metadata never reclassifies placement. The
generator's cheap exhaustive parity test checks every plugin-visible client-capable
Action and the outer `action.invoke` selector against runtime schemas and SDK types.
Runtime input normalization and routing remain catalog-owned.
Schema-only projections without that client-input helper do not evaluate registry
metadata; they retain the schema expression/type projection boundary.
The SDK's declarative UI aliases consume that generated neutral grammar;
Protocol remains the runtime parser and policy owner. SDK runtime delegates and
validated values cross one private declaration-projection seam, retaining canonical
identity and validation without making SDK compilation depend on DTO freshness.

Use the SDK's `generate:action-type-map` command after editing canonical schemas.
`check:action-type-map` compares the SDK outputs and generated placement type without
writing source; the compiler correspondence suite independently verifies their types.
The authoritative local checkout owns all generated source writes. Its existing
`.project/tmp/plugin-sdk-action-type-map.lock` covers derivation, every generated
family module, the index and the input cache through publication. Checks use that
same lease and retain source fencing. Neither mode acquires the CLI dist publication
lease: the DTO producer writes SDK source, while CLI builds and declaration emitters
publish their respective dist outputs under their existing output leases.
One independently filtered CI drift job checks
current output; ordinary root typechecking does not run schema derivation.
Declaration/publication checks enforce current output;
ordinary internal `build:prepared` dependency compilation does not regenerate or
reject a stale Action map. This is an internal development representation change,
not a new SDK API or a released availability claim.

## Shared typed inputs (0.3 development source)

[`inputs/**`](../packages/protocol/src/inputs/index.ts) owns the neutral field
vocabulary, predicates, structured option identity and normalization used by
Action hints, Workflow input adapters and widget descriptors. Value/schema
admission remains distinct from form presentation. Workflow defaults,
required-without-default rules and accepted-run input freezing stay with the
Workflow owner.

`action.options.resolve` delegates source reads to the single
[`inputOptions`](../packages/protocol/src/inputs/inputOptions.ts) resolver.
Action, Workflow and widget forms use that front door with their admitted
consuming field; source-id possession alone does not grant discovery. Dynamic
source refusal remains a typed error rather than a successful empty list or a
fallback to static choices. UI options reads are demanded by an open form and
retire with the last consumer.

Widget `connectedAccountOptions: true` fields use that same
`action.options.resolve` front door with the admitted widget consumer. Choices
are the current viewer's active qualified accounts for the declared Resource
purpose's permitted services, not another caller's inventory. The marker is
valid only on a `select` field and cannot be combined with static options,
`optionsSourceId` or `inputType`.

Plugin `inputTypes` declare a qualified semantic identity and self-contained
value schema, with optional options Resource and picker renderer references.
The existing Resource/renderer registration and grant owners admit those
leaves; a picker result passes the same schema/options admission, while cancel
causes no mutation. See [plugin input types](plugin-platform.md#typed-input-extensions-03-development)
and the generated [host Action reference](../apps/docs/content/docs/plugins/api/host-actions.mdx)
for current operation schemas.

## Widget operations (0.3 development source)

Widget catalog, definition, layout-item, input, area-layout, Refresh and snapshot
Actions delegate to the owners described in
[configured widgets](plugin-platform.md#configured-widgets-03-development).
Instances select bindings; host layouts retain order, width and frame. Account
Artifacts, shared Session Board records and device-local Companion preferences
retain their separate lifetimes and authority. A headless caller cannot mutate
an absent mounted client owner by pretending a durable Account write answered it.

The unreleased 0.3 placement family is `widgets.item.*`, replacing
`widgets.instance.*` in place. Home and area layouts contain widgets or groups;
their qualified reference retains the `instanceId` field for either item id.
Group operations delegate to the same placement reducer, and `widgets.item.move`
can address a group destination. Groups are admitted on Home, Project main/aside,
plugin areas and host-owned core-page areas; WorkBoards, Session Board and direct
Companion retain individual widgets. Group inputs compose with surface context
through the existing follow/pin resolver; every child retains its own admission.

A configured instance's `value` bindings are admitted against the widget's
`inputSchema`, which `widgets.catalog.list` returns per entry: it is the same
object the admission owner compiles, so the advertised shape and the accepted
shape cannot diverge. A picked Session, Machine or checkout is the value
`action.options.resolve` returned for that widget input, unchanged. When
`widgets.item.add` needs approval, that same owner preflights the add's inputs
first and refuses decisive invalid or denied inputs. If preflight cannot decide
because every unavailable field reports `not_authenticated`, validation is
deferred to approved execution with the person's Account reads. Approval does
not bypass input admission, and a deferred add can still be refused then.

Saved groups use the `widgets.fragment.*` lifecycle and `widgets.group.add` to
insert independent copies through one atomic layout intent. They preserve group
options and child definitions, bindings and sizes, while allocating fresh group
and child ids. Editing a saved fragment does not update previously added groups.
Gallery's Your widgets saved-group rows offer Rename, Duplicate and Delete
through those same fragment Actions; edits read the current fragment revision
before writing. Deleting a saved group removes its library entry, not groups
already added to a layout.
Named areas use one `layoutId` and `widgets.area.layout.*` family for host presets
and user views on Project, plugin and core pages. Create with `fromSurface` copies
the current layout. The stock Project `overview` selection normalizes to the
omitted-default owner reference, so both spellings address one Artifact.
Reading missing defaults does not write, the first edit
persists the defaults with that edit without changing the selected tab's order;
only explicit reorder changes it. An explicit empty layout remains empty.
Reset requires `expectedRevision` and returns an Undo capture; Reset and Undo
refuse intervening edits. Select changes the exact answering mounted area's
displayed layout through its route or local selection owner; it returns typed
unavailable when that owner is absent. `widgets.item.list` remains the document
read. Native and declarative plugin areas use the same named-layout tab bar and
page-local carrier, without another renderer or selection store. The generated
[host Action reference](../apps/docs/content/docs/plugins/api/host-actions.mdx)
owns the exact operation schemas.

Personal presentation edits on admitted private Project, plugin-area and
core-page owners use the existing contextual safe classification. Shared and
destructive writes keep their dangerous default, and explicit Ask first
preferences remain effective. The CLI declarations cover mounted Canvas,
organization/reorder, Workflow binding and composer/picker Actions through the
answering client, without a headless substitute writer. Session presentation
retains its host-stamped Session/UI binding: these declarations do not grant a
standalone CLI process ordinary credential-based presentation authority.

The public author surface is qualified `widgets.*` Actions for widget
operations and plugin-ui `WidgetSurface` for a declared native page area;
declarative pages use `widgetArea` nodes. Hosted HTML pages do not embed host
widget areas and use ordinary `widgets.*` Actions only. Public
`session.presentation.apply` and SDK `context.ui.present` accept the Protocol's
author presentation subset: reversible current-Session navigation and
arrangement of readable built-in, Board-item or pane references. Raw direct
Companion instance payloads, instance input/rename intents and conditional
instance-removal captures remain host-internal. The author subset reuses the
host's canonical validators; it is not a second presentation owner or a way
around widget admission.
`chat.item.show` is the "Show here" of a transcript reply: it asks that a
readable Board item run its one live body in its Chat reply, so every Board host
previews it. The mounted Board controller keeps that request while a reply that
draws the item is on screen; opening the item on a Board host takes it back, and
`unavailable` is the typed result when no such reply is visible. It changes only
this viewer's single-runner election, never the item or its Board placement.
The optional `occurrenceId` selects an existing mounted reply occurrence. An
unknown or retired occurrence returns `unavailable`; omitting it selects the
reply that has been visible longest. The reply's UI uses this same Action
through the Session shell's current-client presentation port.

The same development presentation subset admits `viewer.open` and
`viewer.source.select` with source `computer` or `browser`, plus `viewer.close`,
`viewer.expand` and `viewer.restore`. These affect only the answering client's
current Session presentation, never target selection, input control or Session
execution. Docking, corner and size remain host-local, not author operands.
The Session viewer's semantic UI callbacks enter the literal
`session.presentation.apply` Action. An exact mounted UI invocation applies the
admitted command through its current-client presentation port, bound to the
Session, Account and mount lifetime. Other client calls use the existing
Session-scoped RPC, authenticated focused binding and command/ACK owner. The
mounted port applies the accepted command rather than dispatching another
Action. Account approval policy still applies. Geometry callbacks stay
local to the controlled frame.
When that UI invocation is configured Ask-first, its trusted host UI can settle
the existing V2 approval using the sealed original Session input. This narrow
replay does not expose the internal Action to API/plugin callers or permit
external-principal or Agent-origin internal replay.
The mounted source/frame port supplies availability; without it the current
presentation owner returns `unavailable`. Schema acceptance alone does not mean
the shared viewer shell is integrated or available in a loaded client.

The development author subset also admits `work.view.select` (`view: list | map`),
`work.recent.show_more` and `work.map.expand`. The existing mounted Work pane owns
these controls and its local view/disclosure state; hiding or unmounting that
pane makes them unavailable. Map expansion uses the existing details pane and
is unavailable on a phone. Neither an intent nor a plugin invocation persists
this ephemeral state or creates a second presentation target.

Viewer bindings resolve the viewing Account's qualified, existing Connected
Account purpose selection. There is no per-instance viewer override or widget
selection setting: a missing selection asks that viewer to Connect. Pinned
Connected Account references are allowed only on personal surfaces. Changing
the existing purpose selection retains its normal lifetime and can affect other
viewer bindings using that same purpose; it is not an edit of one copy. Snapshot
posting publishes the exact inert preview supplied to approval through the
existing shared Board writer, without another read after approval. Definition
update/delete and shared publication use the existing consequential approval
defaults and configurable waivers. These are development contracts; public
projection, package and loaded-platform validation remain separate evidence.

Project dashboards consume the same named-layout Actions and Artifact
owner. Named documents contain main and aside in one revision; host presets are
undeletable. Generic Artifact Actions consume the existing internal-kind policy
and cannot read, manufacture, retag, update, delete or restore dashboard documents;
their dedicated widget and sharing Actions remain the admitted paths. Shared
Project and WorkBoard widget writes use actual admitted
Artifact sharing facts for the same configurable confirmation policy as shared
Session content, not the surface kind as a personal-write exemption. Optional
input `paths` select exactly which saved choices to set or reset against the
owner's current bindings; omitting them retains whole-binding replacement/reset.

## Workflow inputs and complete review reads (0.3 development source)

For a Session-agent `workflow.run.start`, the authenticated caller supplies the
origin Session and its Machine/workspace context. `inputs` contains only the
workflow's declared input values; putting `machineId` or `directory` there does
not select where the workflow runs, and undeclared inputs are refused during
start preparation. `executionTarget.kind` selects the leaf
execution kind (`session` or `detached_run`), not a Machine or workspace.

Resolve options for a declared workflow input through `action.options.resolve`
with its workflow `consumer` and that input's name as `fieldPath`. The `inputs`
container is not an input name. A known workflow with an unknown input name
returns `input_type_consumer_unavailable` with the declared `availableFields`,
so the caller can choose a real input before resolving its options.

The Workflow Action census also includes `workflow.definition.import`,
`workflow.definition.export`, and `workflow.trigger.run_now`. Document import takes
`{ json }` and delegates the sole `workflowDocumentV1` codec, returning an
`unsaved_definition` carrier or its typed document failure. It never saves, starts,
or schedules anything. Export takes `{ definitionId }`, opens the authorized saved
Artifact at its current revision, and returns canonical `happier.workflow` JSON;
credentials, staged media, and runtime state are not document fields. File picking
and delivery stay platform-local. Unsaved mounted draft editing/export remains local.

Workflow Action failures preserve `cancelled` for native cancellation during
family preparation or a catalog-declared read. An aborted signal alone does not
prove that an issued write was cancelled: an unavailable write receipt retains
its failure or unresolved outcome. Typed `currentness_conflict` keeps its revision;
uncoded or unknown storage failures remain `storage_unavailable`. This is a 0.3
development contract at the shared Workflow-family and strict Action boundary.

`workflow.trigger.remove` takes `{ automationId, triggerId? }` in 0.3 development.
With `triggerId`, it removes only that trigger; removing the last one keeps the set
as Manual. Omitting `triggerId` deletes the whole Account trigger set, including a
disabled Manual set with no triggers, and returns `{ automationId, deleted: true }`.
The existing Automation deletion owner retires scheduling and assignments while
retaining past Runs. The Account lookup refuses foreign and Session-scoped sets,
and whole-set removal retains the shared, user-waivable Agent approval default.

Manual Run now takes `{ automationId, idempotencyKey? }` through the existing Protocol trigger owner
and delegates the current Automation occurrence admission transport. It returns the
exact V3 receipt, including explicit Workflow Run correspondence when supplied,
without converting or rewriting a retained definition. The optional key uses the
incumbent manual-occurrence idempotency contract. This danger-classed Action uses the
canonical configurable Ask-first policy, as do Account trigger writes.
Ordinary Account/UI calls use their captured Home without a reachable Machine; Agent-origin
callers retain canonical Session/placement and agent-start admission before the effect.
The UI keeps its existing Account-scoped transient acknowledgement. Its captured Action
host publishes the Run observation only while that Account remains current and active.

`workflow.trigger.test` is a read-only diagnostic over the supplied trigger and
observation facts. The Protocol orchestration owner compares event/source identity
and contract version, then reuses the admission age and filter evaluators. Results
are `matched`, `noMatch`, `sourceMismatch`, `tooOld`, or `invalid`; a match is not an
attestation that an occurrence was admitted. Strict inputs exclude occurrence ids,
private source selectors, watcher configuration and execution custody. The UI's
retained-event Test uses the same Protocol diagnostic owner synchronously; this
local preview does not read Account state or admit an occurrence.

`workflow.starters.list` returns the built-in example catalog, and
`workflow.starters.resolve` materializes one key with optional explicit Session
target and timezone. The same Protocol materializer serves the UI. Session-bound
examples return `requires_session` without a target; ready results are unsaved
definition/trigger carriers, never a save, attach, schedule or execution effect.

`workflow.events.list { machineId, serverId? }` reads the selected Machine's current
`automationEligibleEvents` contribution projection: event declarations, observation
transports and setup facts. It returns `{ machineId, events }`, not the private
configured-sources list. Missing eligibility support is unavailable; an explicitly
supported empty catalog is valid. This development read neither configures a
source nor admits an event occurrence.

Saved Secret MCP sharing is selectively projected for `secrets.shared.promote`
and `secrets.shared.grants.set`; this is not a Home-family-wide exposure. The
existing human approval default retains the exact envelope and audience input
for replay through the credential-bound Home transport. Previews, observations,
settled approval records and strict receipts expose metadata only, never secret
payloads. A malformed successful mutation response remains `outcome_unknown`,
not an invitation to repeat the write.

Workflow review completion continues to require a present-user decision through
the existing approval path with the exact Run/revision custody.

In 0.3 development, the person's own Workflow UI edits and Run now are direct by
default. Run now starts a cancellable Run; its steps retain their own approval
rules. Removing one trigger leaves the Habit available for another trigger.
Deleting a whole Habit, saved Workflow definition, document, or Run history has
no product restore path and retains confirmation with the localized Delete verb.
Mounted draft Discard uses the editor's existing confirmation. Explicit per-Action,
per-surface Ask first settings still win; Agent, CLI, MCP and automation defaults
and scoped Session-trigger admission remain unchanged.

In 0.3 development
source, an Agent, MCP or CLI caller may request retained legacy trigger conversion
through `workflow.trigger.update` with `confirmLegacyConversion: true` and the
reviewed inline target, project and `expectedRevision`. This input requires
present-user execution authority and asks for approval by default. A policy waiver
suppresses the request without granting that authority; an automated invocation
then returns `present_user_required`. The existing approval presentation shows the reviewed conversion fields.
Opening retained private content still requires the existing present-user review.

After an authenticated user approves and the approval owner claims execution,
replay carries a host-only `presentUserApproval` fact bound to the Action id,
original request id and canonical input digest (including `expectedRevision`).
The original requesting caller and surface remain intact. Conversion consumes
that exact fact or the existing direct present-user host authority, and retains
the template ciphertext, review eligibility, inline target, project and retained
Session source checks. Unapproved or denied requests do not convert; a stale
revision returns `currentness_conflict`. The app's direct review-and-Save path
continues through the same conversion owner.

In 0.3 development, `workflow.trigger.list` also accepts the exact structural
`{ managedTarget: { homeId, managedId } }` selector. Machine rule reads and
controller Moves share this selection at the Automation owner. Only matching
definitions and temporarily unindexed rows are opened; the private inline
Action still determines the rule. The selector is carried through the
[Automation definition query](api.md#automation-definitions-03-development),
not an Account-wide trigger census.

`workflow.definition.list` opens saved definitions through the existing batched
Artifact read. In 0.3 development, saved-definition pages request trigger summary
facts only for that page's definition IDs. The CLI/UI Automation adapters carry
this set through `POST /v3/automations/query` to the existing Account list query
and projection; singleton trigger reads retain their GET selectors. The set
inherits the structural Artifact page maximum. An unsupported or failed query
marks returned definitions with a typed `triggerSummaryErrorCode`; authorized
definition content remains listed. While that field is present, `triggers: []`
and `nextRunAt: null` are unavailable enrichment, not evidence of no triggers.
The library shows the existing localized unavailable label and trigger filters
retain unknown coverage. No Account-wide fallback or retry census is performed.
Account pages return before unrelated plugin discovery; the existing
`nextCursor` carries the plugin continuation after the Account pages. The shared
library displays saved rows while that continuation is pending and retains them
if plugin discovery fails. In 0.3 development, an exact plugin open supplies
`workflow: 'plugin:<pluginId>/<localId>'` to the same list Action, without a cursor
or limit. The shared source resolver returns only that admitted plugin descriptor,
or an empty plugin list when unavailable, without reading saved Artifact pages.
Mounted reference and catalog readers reuse an already-admitted library hit.
A recognized Workflow header with missing or invalid required fields,
or a readable header with a missing, malformed or
unreadable body, remains a typed `contentStatus: 'unavailable'` row with
`stepCount: null` and `contentUnavailableReason`; valid neighbors still load.
Rejected-header rows use the authorized Artifact identity and physical revision,
with null revision/metadata when those facts are unavailable. That display
projection never repairs the header or authorizes opening its body.
Exact definition opens return `content_unavailable` with the same typed reason.
The library and editor show localized unavailable copy rather than discarding it.
Stored Workflow readers drop unknown fields recursively, including a stray header
`savedBy`, while retaining required-field, mode and revision checks. Writers emit
only the canonical shape. Attribution belongs only to owner-private revision
provenance, never to a shared header. Restoration projects the same known fields;
request and Action inputs remain strict. Raw Account encryption conversion preserves rejected bytes without
making them readable. Artifact transport, authentication and Account-mode failures
remain request-wide, and an unopened header is never inferred to be a Workflow.
The lean row's `nextRunAt` is the earliest persisted occurrence among enabled
scheduled triggers in enabled Account-level sets, or null when none is scheduled.
The shared trigger summary owner reads this scheduler fact without opening private
trigger context or calculating schedules in clients or Boards.

Mounted Run controls consume the shared Run row's current caller access, including
same-revision lean refreshes. The existing Account change feed revalidates access
on Run changes, grants on the Run's source Artifact, and Team membership changes;
revoked Runs leave the shared row owner. Frozen accepted detail is not an access
snapshot for later controls, and no polling timer is involved.

Frozen Action input and output schemas use the same Protocol-owned draft-07
JSON Schema dialect and Ajv compiler. Self-contained `definitions` and `$defs`
may be referenced by document-local JSON Pointers (`#` or `#/…`), including
recursive references. The compiler retains these references rather than
expanding them into cyclic JSON. External references and undeclared schema
keywords are refused; no schema is fetched from a URL or file. This lets a
Workflow Action validate the native `session.trigger.remove` output without
weakening its recursive Workflow definition contract.

Native Action acquisition requests outputs explicitly and uses the Protocol
`readCompleteActionSpecV1` reader to reattach every advertised definition before
freezing the contract. Section replies must retain the requested Action and path;
failed reads refuse that contract, and caller cancellation remains cancellation.

In 0.3 development, full Action discovery also carries the serializable
`completion` declaration from the Action spec. `freezeWorkflowActionContractV1`
is the single Workflow contract projection for direct CLI/UI admission, daemon
trigger claims and contributed Actions. It preserves that declaration and uses
its terminal schema as the Workflow output schema; undeclared Actions retain
their immediate output. Executable completion functions stay at the Action
owner. The existing execution-run observer waits for terminal evidence, so
downstream steps receive plans and explicit per-engine failures rather than
successful Start references. Stored readers remain tolerant; existing accepted
snapshots are immutable and are not reinterpreted or backfilled. A fresh start
freezes the current contract, including when starting from a saved definition.

Workflow string inputs can declare `enum` choices in the canonical
[`WorkflowInputDefinitionSchema`](../packages/protocol/src/workflows/workflowV1.ts).
The daemon's input binder checks occurrence evidence, constants and defaults
against those choices before launching leaves. Review & converge accepts only
`fix` or `report` for its `apply` input.

`reviews.comments.list` retains its paged default. Callers needing the complete
read can request `allPages: true`: the shared Action executor drains the existing
ReviewComment transport with the same scope, principal and cancellation signal.
The flag is Action-only, never sent to the server. A failed later page fails the
Action rather than returning partial findings. Review & converge uses this read
for both Judge evidence and its persisted convergence check.

Final-panel fingerprint certification requires every reviewer to complete and
report complete finding materialization. Missing, partial or failed materialization
cannot authorize an identical-tree skip; the factual reviewed fingerprint remains
available in the reviewer result.

## Client configuration controls (0.3 development source)

`shell.column.get/set` operate on the answering client's mounted column owners. The optional
`column` selects `navigation` (the existing default), `main` or `side`. Main visibility is the
inverse of the scope's persisted `mainHidden`; a host must supply its main-column descriptor to
offer this control. A side-panel set can also supply a registered `tab` id, including plugin tabs,
which selects and opens that panel. Missing mounted owners and unavailable controls retain their
typed unavailable results. The family remains a reversible view operation with its existing
default approval policy; user Action settings can still require approval. Arrangement is the
declared `appearance.paneArrangement` setting through `settings.get/set`, not another Action family.
See [App shell panes](app-shell-panes.md) for visibility and layout ownership.

Client-placed Actions operate on the answering client's current owners, not an
arbitrary remote window. In 0.3 development, an admitted Agent, MCP or other
daemon-hosted invocation reaches a connected app through the existing
machine-scoped reverse-RPC channel, using `ui.actions.execute.v1`. The Protocol
executor validates input, caller authority, surface policy and required approval
before delivery. The answering app uses its canonical UI Action executor with
the admitted surface and authority; the trusted continuation skips only the
already-satisfied approval step for that exact parent Action, and cannot grant
additional authority. A client plugin Action's nested host Actions do not inherit
that bypass: they enter ordinary plugin-surface policy with their own caller
provenance, so defaults, explicit Ask-first settings and waivers apply separately.

The server selects eligible handlers in that Account's machine/method room,
excluding the calling socket. Every client-routed UI Action uses the shared
exact-client, sole-client and pushed-focus rule described above; ambiguity
returns candidates before any receiver executes.
Session-bound Next and conversation search select the app viewing the invoking
Session through its Session-qualified method, while retaining their Account-wide
operation scope. No matching view is `noClient`; multiple matching views are
`client_ambiguous` unless the shared focus rule selects a unique receiver.
Unbound calls use the generic client room with the same selection rule.
Daemon availability advertisements are hints, and the server's current
registration selection decides absence rather than a daemon-local negative.
Action inputs still address their exact Session, composer or
mounted surface where supported; client choice does not retarget an absent view.
Browser automation retains its separate exact-view controller
custody and interrupted-completion contract. Contributed plugin client Actions
retain their own artifact/schema and plugin-occurrence lifecycle dispatch.

Ordinary host Agent, MCP and CLI calls to a contributed client Action use
`ui.actions.contributed.execute` through that same connected-client transport.
The Account's Machine reverse runtime owns both client method families. It
advertises contributed delivery only for a Machine supplying a current client
Action; an app without such a declaration is not an answering receiver. Equivalent
projection updates do not replace that Machine binding; the contributed receiver
reads the current committed projection at invocation.
The root invocation's approval-origin record does not make it a daemon replay:
the answering app rechecks the declared caller surface, current plugin occurrence,
Action settings and required approval before running the client handler. Plugin
caller provenance, external execution authorization and exact daemon replay or
execution-origin bindings cannot be forwarded as ordinary client authority.
An absent contributed receiver returns `plugin_action_client_target_unavailable`;
an issued call with no valid settlement returns `plugin_action_outcome_unknown`
and is not retried.

When no handler is advertised, including by an older app without this method,
delivery preserves the Action's absence contract. Workspace tabs/groups/split/resize,
Updates, app updates, Account lifecycle, prompt-template authoring and bug-report
submission return `unsupported_action`. Find and the prompt picker return
`reason: 'noClient'`, Next returns `status: 'unavailable'`, and other Actions retain
their declared unavailable results. Missing required mounted owners remain distinct domain results. A lost
or invalid response after issuance reports `outcome_uncertain`; delivery never
retries an issued invocation. These are current development contracts, not
released availability or a completed loaded-runtime validation claim.

The registry normally excludes client-placed Actions from CLI availability and
friendly command generation unless the spec declares a CLI entry point. In
current 0.3 development, `session.open` navigation uses the existing paired
daemon's answering-client dispatcher: ordinary navigation, including an explicit
comparison destination or workspace tab, opens through the mounted Workspace owner, not a second terminal
navigation implementation. A disconnected app returns `unavailable` / `noClient`;
the CLI does not claim that the view opened. The catalog's `placements` field lists UI
locations such as command palettes and menus; it does not report connected
clients. Tool exposure remains a separate policy: removing a transport-gap
override does not change the default Agent discovery budget.

In 0.3 development source, `projects.pages.list {workspaceRefId,serverId}` is
the safe client read for an accepted Project's built-in and applicable plugin
pages. Its closed `{pages}` result carries host-generated `href`, title, icon,
kind and disabled reason, plus exact plugin/local destination identity for
plugin entries. It uses the same Project context, policy and page catalog as
the rendered shell, with no navigation, SCM discovery or Run-on selection.
Open the returned href with `workspace.tabs.open`; no second page-open Action
or Machine-targeted `projects.open` step is involved.

Project tab customization uses `settings.get` / `settings.set` at
`appearance.navigationPlacements`, with a single-surface patch
`{projectTabBar:{orderedIds,placements}}`. The existing placement writer merges
it into current device-local preferences, preserving other surfaces and inert
removed ids. Desktop and phone share that Project surface. The declaration's
safe personal-preference policy supplies the normal no-default-approval behavior;
explicit user Action settings still apply. Hiding changes navigation placement,
not policy admission or direct-route authority.

Workspace tabs/groups/split/resize, `updates.*`, `machines.cli.update`,
`app.updates.*`, Account sign-out/forget-all/delete, prompt-template authoring and
`bugreport.submit` also admit CLI invocation through this existing dispatcher.
Use `happier actions invoke <action-id>` with the declared input and an exact
Home/Machine target when needed. The original surface stays `cli` through the
answering app, so Off and Ask-first settings continue to govern it. These
declarations enable the generic invocation path; they do not add friendly command
aliases or a headless replacement for a mounted owner.

`ui.command_palette.list` and `ui.command_palette.invoke` use the mounted
`CommandPaletteProvider`'s current command builder. Removed commands and retired
mounts cannot retain an executable callback. Entries already governed by an
Action are excluded from this generic host-command path; use their original
Action so its caller policy remains intact.

`workspace.tabs.*`, `workspace.groups.*`, `workspace.split` and
`workspace.resize` consume the mounted Workspace provider's navigation, reducer
and measured split controls. `session.open` can name a destination `tabId`;
the client must have that tab in its current workspace. No-tab opening retains
its existing Session navigation behavior. These controls do not create another
workspace store or infer layout measurements on headless hosts.

In 0.3 development, the workspace tab context and overflow menus also expose
Close others, Close to the left, Close to the right and Close all through the
same client Action family. Bulk closes apply to the selected tab's pane, or the
explicit/focused pane for Close all, and preserve pinned tabs. Single-tab Close
can close a pinned tab. The mounted client's existing unsaved-draft guard owns
the decision before any selected tab is retired; Action approval settings remain
user-configurable, with no mandatory approval floor added by these commands.

Retained screens supply their identity through their existing `PageHeader` or
plain screen-title option. Native header chrome is separate from that identity.
`DestinationInstanceHost` publishes the identity into
the current workspace's transient projection, bound to the exact destination
and Account. Native scenes bind the same collector using Expo's local module
and parameters, so an inactive retained scene cannot borrow the foreground URL.
The destination catalog's reader and live hook combine it with the existing live
Session, Project and Discussion title owners for tab strips, overflow/switcher,
closed-tab Action labels and window/document title consumers. Nested screens wait quietly for
their own title rather than borrowing an area label. Publication writes no
layout or Account settings; changing the destination retires its former title.
`WorkspaceWindowTitle` projects the focused title to the browser document and
desktop window adapter; the Expo route mirror preserves navigation metadata,
but is not a document-title writer.

For `workspace.split`, an explicit `groupId` selects the pane to split; a named
`tabId` may move there from another pane. Without `groupId`, a named tab splits
its own pane, otherwise the focused pane is used. Admission and execution both
use the canonical measured workspace split owner.

In the current development UI, the mounted phone workspace also registers tab
Actions, including while All tabs is open. Open, activate, close and reopen use
the same guarded navigation owner before changing membership, focus or the
phone stack. The phone transport pushes from a main screen and replaces an
existing tab screen; closing the final tab returns to the list. Canvas, group
and cross-group move operations remain unavailable on phones.

Mobile-web Settings and Personalize are the presentation exceptions: their focused destination stays
mounted in the workspace and uses browser navigation at both phone and desktop
widths, retaining the route's layouts, parameters and unsaved editor state during
resize. Admission requires a registered body; the workspace route registry derives its
Settings inventory from `listSettingsRouteNames` and declares Personalize's module,
catalog admission and responsive retention together. The hidden Expo URL mirror
mounts only navigator registrations, while the hosted layout owns the collection
controllers. Locations with repeated query values remain Expo-owned so their
domain readers receive the original multiplicity. Native phones and other phone
screens keep the stack transport above.

`session.list.view.get/set/reset` use the rendered Session-list filter controller;
My work is a scope in that controller. `shell.column.get/set` use the existing
shell visibility control. Neither family creates a second filter store or
changes Session access.

In 0.3 development, a current mounted plugin UI may read its Account's Session
list through `session.list`. The mounted host stamps the list-only
`sessionListAccess: 'mounted_ui'` context; it retains plugin automation authority
and does not accept this scope from Action input. Autonomous plugin Actions do
not inherit it. Signed Agent callers retain their own Session or server-proved
led subtree, as admitted by the Session host. Durable list approvals preserve
the scoped plugin contribution and source custody for currentness checks.
Home-scoped UI reads retain the server's page cursor and ingest rows without
replacing the mounted Session list or its filter membership. Unqualified Voice
reference reads retain their existing cross-Home corpus.

In 0.3 development, `session.list` accepts `project: { serverId, projectKey }`
to narrow the admitted Session corpus to a qualified private Project. It reads
the viewer's owner metadata: an explicit Project id wins; otherwise a uniquely
accepted checkout associates the Session. Directory grouping, repository labels,
Team Source access and a shared dashboard do not grant access to private Sessions.
Both UI and CLI hosts use the same membership predicate, retain list cursors and
report unreadable candidates with `projectFilterUnavailableCount`. The response
echoes the applied `project`; a host that ignores the filter returns
`session_list_project_filter_unsupported` through the Action executor.

In 0.3 development, `workflow.library.view.get/set/reset` use this same admitted
client-control family to read and change the focused Library's All, Triggered,
Running and text-search choices. The rendered Library and Actions share its
membership and offered-view owner. An absent, unfocused or retired Home/Account
owner is unavailable; a view that the Library does not offer is refused. These
choices stay in the mounted client's presentation state, without server
persistence or cross-window coordination.

Library view inputs accept optional `clientId` (CLI `--client-id`). Run
`happier workflow library view get --json` to read the selected answering
client and discover `answeringClientId` plus eligible `answeringClientIds`.
When no unique focus fact can choose among several clients, this read returns
`client_ambiguous` with `details.clients` instead.
If that client has no focused Library, the unavailable result retains these
addresses in its error details.
Read each candidate with `--client-id <id>` to identify its mounted Library,
then use the same selector for set/reset. All three operations use the shared
client-choice rule and refuse unresolved ambiguity before execution.
An absent selected client is unavailable; no other app is substituted.
Socket ids expire on reconnect. The existing `answering-client.v1/` operation
protects selection on the relay; an unsupported relay returns
`client_routing_update_required` without unselected delivery.

`settings.list/get/set/invoke` discover U4 setting declarations by anchor. Explicit
declaration bindings name the canonical Account or device preference key or an
owner-backed nested field and its exact mutation schema;
Account writes use the captured Account-settings writer and device writes use
the local-settings owner. The closed Action envelope carries strict JSON values;
each declaration's canonical owner validates its scalar or compound mutation
shape. Declared device-local UI writes, including text size, density and Reset,
enter this admission before raw persistence. They remain usable before sign-in;
signed-in local approvals retain the originating client invocation. Theme mode
also accepts the complete strict mode/profile selection through its existing
owner, preserving scalar mode inputs and profile Reset behavior without a new
persisted format. Choice descriptors remain scalar. The Workflows capacity and Run-history
retention anchors bind to the server-owned Automation settings record, not Account
preferences. The Workflows
Run settings controls use this same Action writer; field updates read the current
record and preserve its other fields. Derived values, sensitive preferences and
editors without an explicit value binding remain unavailable for writes: discovery
reports their access status and unsupported writes return a typed refusal.

The captured Account writer validates every one-shot prepared result, including
CAS rebase candidates. A missing, inherited or non-record `settings` baseline
returns `{ status: 'invalid', reason: 'invalidPreparedMutation' }` before a Settings
write, paired transaction or legacy organization import. Callers that require application receive
`account_settings_mutation_invalid`; an explicitly prepared empty `{}` remains
valid. Missing preparation is never interpreted as an empty Account document.

In 0.3 development, the Appearance glass section declares `appearance.homeAtmosphere` and
its source, planet placement/style/digits, picture reference/layout, remembered
looks, behind-sessions and moments controls (`appearance.atmosphere*`). They use
`settings.get/set/reset`; the Account CAS owner reapplies nested intents to the
latest document and preserves sibling preferences. Full atmosphere and look-map
writes use the answering client's picture catalog to retain only differences
from each known picture's release look; an absent catalog entry retains its
authored overrides. Look entries contain `look`, `strength` (0–1) and `dissolve`.
The UI's Fade control is that dissolve style, not a separate numeric override.
The saved picture reference remains the person's choice. Home's hourly idle
resettle derives the shown built-in picture from that choice and its optional
`picture.selectedAtMs`; it never writes Account settings. Picking, Shuffle and
the picture-reference Action record a deliberate selection time, so the chosen
picture appears first. Full-object Home and Project mutations also anchor a changed
picture source/reference at the mutation owner; presentation-only edits retain
the selection time. Home and inheriting readers share one admitted display sample,
including a Look editor opened later while writing withholds a resettle. The sample
advances on a deliberate selection, an admitted resettle or a fresh arrival, with
no polling or automatic Settings writes. Older stored choices without a time use the Unix epoch
for the same deterministic sequence. Own pictures, contributed pictures and
explicit Project overrides keep their selected picture. Look's picker shows
the saved choice; its per-picture controls and credit describe the shown picture.
Glass preset and intensity retain their
existing `appearance.glassPreset` and `appearance.glassIntensity` bindings.

`appearance.projectAtmosphere` requires
`target:{kind:'project',serverId,projectKey}`. Its complete override, or `'home'`,
is stored through the current Account's existing Project organization row CAS,
preserving the row's label, pin and other fields. Reset writes `'home'`; a stale
row returns `project_account_mutation_conflict`.

`settings.invoke` at `appearance.atmospherePictureAdd` accepts
`input:{kind:'atmosphere_picture_add',source:{kind:'url',url}}` (HTTP or HTTPS),
or `source:{kind:'machine_file',machineId,path}`. Machine files use the existing
authorized `readFile` binary contract and its file-size policy. The answering
client prepares acquired images once as WebP (2560px maximum long side, quality
0.86) through its platform image owner, stores them in its device-local
`pictureStore` and selects the
returned `localId`; another device without those bytes uses the default fallback.
`appearance.atmospherePictureRemove` accepts
`input:{kind:'atmosphere_picture_remove',localId}` and requires approval by
default. It removes only user-picture bytes on that device and retains authored
synced references. The add anchor cannot execute removal. These operations and
catalog-dependent/project settings require an answering client; headless
fallbacks return the existing connect-client recovery.

In 0.3 development source, notification Account and device preference controls
and the MCP startup policy submit their declared anchor/value through
the scoped `settings.set` UI front door. Disabled UI policy refuses the change;
configured approval remains pending in the mounted approval continuation without
applying the setting. Nested notification mutations still read current state at
their existing owner and preserve sibling fields. The
`session.mcpServersStrictMode` declaration belongs to Sessions and binds the existing
Account key `mcpServersStrictMode`; the Settings MCP preview route is retired.
Push-channel changes retain
`notifications.expoPush.update`; native permission and token repair are separate
operations, not Account preference writes.
Enable requests permission separately through `notifications.push.permission.request`,
so refusing that Action still permits the channel preference but prevents its prompt.
Onboarding's local-notification consent uses the same permission Action with
`purpose: 'local_notifications'`; it does not enable remote push. Automatic
startup priming waits for a known Account settings version and consumes its one
startup observation even when push is off, leaving later Enable consent to its
admitted operation. Native sound Preview uses `notifications.sounds.preview`
and the current Account sound and device override, not a second sender.

In 0.3 development source, `desktop.startOnLogin` binds to the common native
autostart mode of this computer's desktop-managed background services. The
desktop row and Settings Action use the same `daemon.service.autostart.set.v1`
task and shared status readback; no Account or device preference shadows the
service fact. Unknown or mixed service modes return `setting_value_unavailable`
for reads and writes. A write retains its invocation lifetime and reports the
service fact after the native task settles.

In 0.3 development source, discovery derives `targetKinds` and `targetRequired`
from each declaration binding. `settings.get/set` accept an optional exact
`target`: `{kind: 'home', serverId}`, `{kind: 'team', serverId, teamId}` or
`{kind: 'team_identity_connection', serverId, teamId, connectionId}`. Home
targets must match the invocation's captured Home; Team and identity-connection
declarations require their resource target. Account and device preferences accept
no resource target. Unsupported kinds or a different Home return
`setting_target_mismatch` before a read or write. Team policy and identity
connection edits use their existing domain Actions and revision owners.

In 0.3 development source, direct Account-key declarations accept
`settings.get {anchor, includeVersion: true}` to return `settingsVersion`, and
`settings.set {anchor, value, expectedSettingsVersion}` performs one conditional
CAS without rebasing on a conflict. The revision covers the whole Account
settings document, so an unrelated intervening preference edit also conflicts.
Account-key and Account-owner writes can request `reversal: {kind: 'capture'}`; the writer
returns the captured Home/Account scope, exact raw unset/value states, and the
committed before/applied versions. Undo submits the complete captured receipt
as `reversal: {kind: 'restore', ...receipt}` through the same Action. The owner
checks its actual scope, declaration and the affected keys' raw applied state,
then restores only those keys under the same CAS, ignoring the caller's `value`.
Raw absence is restored as absence, including inverted-boolean declarations;
when the declaration has no default, reads and restores return `unset: true`
instead of a JSON value. History retention or pruning does not control Undo. Capture reports
`reversalUnavailableReason: 'no_change'` only for the real owner's unchanged
version and exact raw-state equality; it creates neither an Undo receipt nor a
forced write. Ordinary writes without capture keep their existing result.
Device/Home/Team bindings do not support this reversal contract.
Headless hosts that cannot enforce these conditional requests
use the existing answering-client placement, including otherwise headless
Account anchors; a disconnected client returns connect-client recovery. They
never downgrade conditions to ordinary writes. No-flag Account requests retain
their existing headless owner. All requests retain normal Action admission and approval.

The same development-only conditional corridor extends the incumbent Session
model and Account MCP rules Actions. `session.model.set {captureBefore: true}`
captures the exact provider-bound selection, ordering stamp and Home/Account/
Session scope; an active owner also captures its current `runId`. Restore submits
that applied tuple and `updatedAt` through `expected`, so an intervening edit or
owner/run change refuses. Inactive capture supports only an existing canonical
V1 non-null intent for the same Agent target: null, absent, legacy and V2/Team selections are
unsupported rather than converted into an inexact inverse. Restricted Session
principals do not acquire this Account-owner capture capability.
`mcp.rules.set` changes one or more servers' reach rules through the Account
catalog CAS. Its receipt includes the committed rules and each server's previous
rules. Undo submits the previous rules as a replacement through the same Action;
the executor reads the current catalog revision and reports a lost CAS as
`conflict`. Configuration edits use `mcp.servers.update { configOverrides }` and
preserve reach rules. Present-user UI rule edits act directly; Agent, CLI and MCP
callers ask by default, with surface waivers owned by Settings → Actions.
Compiled `mcp on|off|inherit` commands and the retained `mcp servers bind|unbind`
paths use this Action. Unbind takes an item and place and removes that rule;
the former `--binding-id` input is retired in 0.3 development. These are source
contracts, not loaded-runtime or release certification claims.

In 0.3 development source, `appearance.navigationPlacements` reads and sets the
device-local `navigationSurfacePlacementsV1` map through that same declaration
owner. Its `appRail`, `sessionRail`, `workspaceRail` and `sessionTabBar` entries
contain ordered contribution ids and `pinned`, `overflow` or `hidden` placements.
These preferences change only the named navigation surface; hiding an App-rail
icon does not hide its destination from the launcher, columns or command palette.
Unknown or temporarily removed item ids remain saved; current catalogs decide
which items can render. Stored reads drop unknown object fields, while Action
inputs reject them. The older `sessionCockpitBarSurfaceIds` and
`compactAppDestinationPreferencesV1` preferences seed only absent surface entries;
an explicit empty phone pin list stays empty. Mounting a navigation surface does
not migrate or write either historical preference. Device-local Action placement
requires the answering client and does not synchronize these preferences to the
Account or other devices.

In 0.3 development, `settings.list` reaches the answering client's complete
declaration registry, including contributed settings. It does not substitute a
partial headless catalog. The Delegation anchors and Create-session Action policy
fields share their Account bindings in
`packages/protocol/src/actions/accountSettingDeclarations.ts`; shared Account
bindings can be read and written without an answering app. CLI writes use the
existing Account settings CAS owner and preserve concurrent unrelated settings,
including sibling policy fields. Approval-reviewer configuration remains
present-user-only. Input-dependent placement keeps device-local anchors
client-owned. Discovery and device-local requests without an answering client
return `unavailable`/`noClient` with a typed `connect_client` recovery hint to open
a signed-in client connected to the target Machine. Other declaration families
retain their existing owners; this is not headless coverage of the whole catalog.

The authenticated Account ingress admits the four Settings roots through its
existing exact-Account Machine carrier. Reverse client delivery retains the
requester, request ID and credential grant. Home registry and Follow aliases
invoke their canonical domain Actions, which recheck the grant and their own
approval policy; the outer Settings approval bypass does not authorize a nested
write. A deferred nested approval remains an `approval_request_created` outcome,
not a completed preference update. Consent-required settings still require a
present user and cannot be enabled by an Agent for itself.

An original CLI request can reach a retained same-Account remote Machine through
the existing Home Action carrier without starting a local daemon. The canonical
fixed-Home daemon publication keeps positively matching local targets on their
existing signed-root path, even when Home and control ports differ. Identity-less
legacy publications retain that own-target bridge while foreign targets still
use Home admission. Remote origination preserves the invocation's automation
authority ceiling and Account encryption mode. Ordinary own-Account delivery
reuses installed custody. Finite Project CLI Prepare, Script Run and Exec also
seal the original CLI invocation to the admitted installation through the
existing private requester context, including on an owned Machine. The receiving
requester-policy owner applies CLI approval settings and binds Ask to the exact
Home-issued Machine root; a UI waiver cannot replace CLI Ask. Missing installation
sealing material refuses admission. A supplied host-only Ask that Account policy
cannot preserve returns `approval_context_unavailable` before dispatch rather
than creating an unsigned approval.

Managed controller Actions in 0.3 development use Home-issued Machine admission
even for the Account's own local controller. Creation, inspection, installation
retry and managed control all call protected Home endpoints; the private local
daemon control credential cannot supply that admission. The CLI's existing
`requiresOriginalAccountMachineActionProof` decision selects the same carrier
for local and remote controllers, without disclosing foreign Account custody
for an owned Machine.

After a managed power intent is acknowledged by Home, a later controller HTTP
failure does not roll it back. In 0.3 development the controller returns
`action_outcome_unknown` and retains the same operation with an
`outcome_uncertain` observation. An unreadable admission acknowledgement also
retains an unconfirmed outcome, including an admit-control 503 with
`database_connection_unavailable`: that code alone does not prove the intent
failed to commit. Home's `database_transaction_conflict_exhausted` refusal
retains its confirmed-rollback meaning. Explicit unknown native power, delete and rebuild results use
the same unconfirmed result while retaining the exact native submission;
observation and identical request replay do not replay that native effect.
Host preparation refusals and the private dispatcher's proven `notStarted`
refusals settle the unused submission as definite failures, preserving their
typed codes; they do not become native uncertainty. The existing Check now
inspection and reconciliation of a newly admitted intent report fresh native
truth to Home. A newer definite power observation settles retained power
custody even when it shows that the older desired power did not happen; unknown,
unavailable or stale observations keep it unresolved. Home then allows the
still-current newer intent to submit through normal admission. Delete still
requires observed absence, and Rebuild requires its bound replacement.
Reconnect refreshes policy census; it is not a universal native inspection timer.
Read the managed row before retrying; Stop
remains available to retract desired Start even while the last observation
says stopped. Definite native refusals retain their existing failure result.
The shared `project_requester_home_unavailable` code also applies to Machine
root-authority reads: its historical name does not imply a Project dependency.

Settings discovery, mutation and operations also respect the declaration's page feature
gate and host availability. Optional unset values are explicit, rather than
invented defaults. Compound choices keep their domain owner and update atomically.

The Conversations language anchor projects its title and write admission from the selected
consumer's declared language behavior. It is Reply in for independent reply preferences and
I speak for a service with one supported language for listening and replies. Unsupported or
unreadable consumers have no scalar writer; a retained unsupported language is unavailable,
not the service default. UI edits and Actions use the same preference owner and reject a
prepared language change after the selected consumer or its activation retires.

Mounted Voice panels submit their compound edit through `settings.set` at the
host-only `voiceConversations.edit` anchor. The public operand is null; the
captured edit and language-owner lifetime remain private to that live invocation,
including while approval is pending. The existing Account CAS writer rebases the
whole edit on its current settings. Agents retain the exact declared field
operations and their consent rules. This compound host binding is omitted from
settings search and public discovery; without its mounted intent it has no writer.

`settings.invoke` accepts a declared anchor and a closed operation input. Voice
operations identify a model-pack or voice id, diagnostic artifact/session,
revocation obligation, diagnostic enable choice, or credential-source selection. Discovery advertises the
operation, its default approval requirement and whether it needs human interaction; callers cannot submit a
provider id, JSON path, gesture claim or confirmation token. Contributed Voice
settings operations share the UI's occurrence/currentness, real confirmation,
snapshot and Account-settings CAS owner. Provider-side success alone does not
mean its patch was saved: the result reports completion only after that owner
acknowledges the patch. Decline, unavailable prerequisites and uncertain write
outcomes remain explicit.

The contributed `credentialSource` operation accepts `voice_credential_source`
with its declared slot, None/SavedSecret/Connected selection and expected Account
settings version. A displayed choice may also carry the value-free declaration
contract digest; automated callers can obtain the settings version through an
existing versioned `settings.get`. The operation delegates source and qualified
Connected-purpose changes to the same atomic owner as the UI. Its receipt reports
applied, conflict or unknown outcome without returning secret material. Choosing
the source type does not authorize creating or replacing a credential.

In 0.3 development, `account.settingsHistory` also accepts
`{ kind: 'account_settings_history_restore', historyVersion, expectedSettingsVersion }`.
It restores through the existing classification-aware, one-shot Settings CAS;
conflicts and uncertain outcomes remain explicit and are not silently replayed.
`account.encryptionMode` accepts
`{ kind: 'account_encryption_mode_convert', toMode: 'plain' | 'e2ee' }`.
That operation shares Settings' complete conversion owner, including inventory,
proofs, upload custody and activation. Both declarations require Ask-first
approval before preparation. Inputs carry no credentials, keys, prepared
migration payloads or caller-authored confirmation claims.

In 0.3 development, cancellation or a changed Account/provider selection after a
declared vendor mutation has been dispatched reports an unknown outcome unless
the provider returned a classified HTTP failure. The stale response cannot update
Account settings, but cancellation does not prove that the external effect was
undone. Cancellation before dispatch and cancelled read operations retain their
ordinary cancellation result.

Credential selection and recipient review open the incumbent anchored control and report
`interaction_opened`, rather than completion. Credential values stay undisclosed
and scalar Get/Set remains refused. Curated moving-model aliases and privacy
opt-ins use the same real human confirmation for UI and exact settings mutations;
the mutation rechecks its admitted owner and Account scope before each CAS apply.
Declared speech endpoints share the rendered endpoint normalization and consent owner:
HTTPS clears insecure-origin consent, while HTTP consent is bound to the exact origin
and reachable execution computer and rechecked before each prepared mutation applies.

### Native Realtime Session authority (development)

Native Realtime Start is **Session-owner-only** in 0.3 development: it uses the
owner's Agent account. The server verifies ownership at the canonical Session RPC
policy, and the host requires trusted owner-classified Start context before
creating its live-attempt input admission. Missing owner proof refuses native
Start, not unrelated Session operations. Shared editors retain ordinary input and
question-answer access. Native turns use the existing Action discovery/execution
and approval policy, but cannot decide approval requests; End, disconnect or
retirement withdraws their input admission.

### Client-local Voice controls (development)

Standalone realtime Voice advertises hot-path Actions directly. Discover other
built-in Actions with `searchActionSpecs` and `getActionSpec`, then call the
transport tool `action_execute` with `{actionId, input}`. It uses the same Voice
Action executor, surface availability and approval policy as direct tools;
pending approval is not an executed effect. Results use the MCP-compatible
`{ok:true,result}` / `{ok:false,errorCode,error}` envelope and the target Action's
Voice privacy policy. This gateway cannot execute effects through identity-less
SDK callbacks or providers without stable effect custody, and is absent from
attached Agents' current-UI-only surface. Contributed plugin Actions still use
`action.invoke` through `invokeAction`.

The `ui.voice_global.*` conversation and Brief Actions execute on the answering
client through its incumbent lifecycle, held-input, recovery and Inbox delivery
owners. Read the current attempt with `ui.voice_global.get`; mutations carry the
returned attempt identity, so later navigation cannot redirect a stop, mute or
hold operation. Starting a microphone, unmuting it, recovery that may reopen it,
and Brief request/retry use the existing configurable approval defaults through
the ordinary Action policy. The person's drawn and keyboard controls carry
present-user UI context through `useMountedActionExecution` and are direct by
default; Agent, MCP and plugin callers retain their approval defaults. Explicit
UI Ask-first preferences still require confirmation. A validated
`set_muted` request with `muted: true` stays safe. UI transport, dismissal,
turn controls and held-input gestures enter the same client-local executor;
Action admission adds no remote Action dispatch.
Explicit Action approval requirements and waivers still apply. End, mute,
dismissal and reads are direct by default. The current attempt read
reports captured destinations and actual availability, rather than promising
that an unsupported host can start Voice. Brief delivery remains demand-mounted
on the ready Home/Inbox surface; missing owners return typed unavailability.
In 0.3 development, **Voice agent can approve requests** (`voice.canApproveRequests`)
defaults on for Local Voice and realtime modes exposing host decision tools. The
Voice agent may approve or deny any pending request on the person's behalf through
the existing decision owners, including requests surfaced in a brief.
Prompt guidance tells it to read the request, ask, and follow the person's answer.
Decisions are attributed to the Voice agent acting for the person. Turning the
setting off requires a tap in the request UI. The captured Account's current
preference is checked again when a prepared decision resumes and immediately
before its decision write or Session response is issued. Revocation returns
`present_user_required`; it does not undo an already-issued effect or receipt.
Explicit cancellation of an approved but unclaimed request is still a new
decision write and revalidates delegation; passive execution claims/results do
not acquire that check.
Current V2 approval decisions record the host-derived optional
`decidedVia: 'voice'` for both approval and rejection, alongside the unchanged
deciding Account and requester provenance. Absence in history is unknown, not
evidence of a person's tap. Requester/Bot Session confirmation carries the
guarded host's private `decisionSource: 'voice'` through the existing authenticated
RPC packet. Ingress validates the exact literal only after requester/Session
admission, removes it before strict Action parsing and carries it on verified
requester context to the remote canonical decision writer. Its surface stays
`rpc`; no new authority is granted, and neither modality field is public Action
input. On this requester path the modality is reported by the deciding person's own
authenticated client and is not independently host-verified, so `decidedVia` there is
an attribution label, never an authority input; a modified client of that same person
could mislabel its own decision, and nothing else trusts the field. The received viewer Artifact is not rewritten. Native Session response
history retains its existing
format. Other automated callers retain their
existing authority floors. Ending Voice leaves pending requests reachable.
Native Codex Realtime is excluded: its agent reads the request within the sharing
policy, says that it cannot decide there, and directs the person to tap the request
or switch to Local Voice. This does not widen its current-UI-only host surface or
the attached Agent's authority. See [plugin platform](plugin-platform.md).

Presentation Actions borrow the answering window's mounted owners: Glance
open/close, transcript visibility, Companion reveal, normalized Island/Orb
position and setup expansion. An absent owner returns typed unavailability;
these controls neither start audio nor change saved preferences. Brief Close
retires pending delivery and closes the mounted list without ending Voice.
Open conversation uses the captured attempt's exact destination: saved
conversation, coding target, or Voice History for a targetless runtime attempt.
An ended attempt from another Account is unavailable, never redirected to focus.
Conversation and recovery navigation use the mounted workspace's existing tab
owner, falling back to Expo navigation only when no workspace is mounted.
Teleport exposes the existing daemon-backed operation to Agents and MCP under
the ordinary Account automation policy; it grants no approval authority.

Field Dictation has separate `ui.voice_global.dictation.start`, `.finish`,
`.cancel` and `.dismiss` operations. Focus the actual editable field or its
Dictation control, then read its opaque commands with `ui.current_context.read`.
`ui.current_context.command.invoke` delegates each command to the same typed
Dictation Action; direct calls use that command's `commandId`. Start requires
approval by default for automated callers and existing device microphone consent.
The person's own UI Start is direct unless Settings → Actions requires Ask first. Finish inserts
editable words through the mounted field's insertion owner without Send;
cancel inserts nothing. Retired, hidden, disabled or other-Account fields return
typed unavailability rather than targeting another input. The one current-UI
mount and existing Dictation controller own this capability; no draft or recorder
is created by the Action adapter.

In 0.3 development source, `ui.voice_global.history.search`, `.load_older`,
`.export` and `.clear` use the answering client's existing History consumer.
Search filters loaded text and provider names; explicit refresh rediscovers the
owned Voice conversations through the ordinary active and archived Session-list
owner. Ordinary user and Agent text belongs to that conversation's history;
direct-media provenance is not a second membership rule. Export streams the loaded or complete history,
optionally filtered, to the client's download/share target and returns file
metadata. Clear retains destructive approval and deletes the discovered owned
Voice conversations through ordinary Session deletion. The legacy direct-media
carrier is no longer a History search/export source. The History page uses the same Actions and
consumer, including Account currentness, pagination and delete-wins retirement.

The 0.3 development `settings.invoke` operations `voiceConversations.readiness`
and `voiceDictation.readiness` return the page/setup's semantic readiness and
recovery, alongside their inspection facts. Conversations include Hear, Think
and Speak; Dictation includes its recognition readiness. Device speech and
machine-free contributed services do not acquire an execution-Machine
requirement. Only selected machine-backed contributions are probed; inspection
never opens a microphone or grants credential access. Account retirement or a
changed selection cancels the result.

The declared diagnostics inspection returns daemon status (null without an
execution Machine), current client runtime/revocation facts, and the canonical
processing disclosures. Account retirement refuses disclosure. Local neural
preview Stop is a declared Settings operation; the picker, Test/Preview
Actions and Stop share playback custody, including a pending sample whose
stopper arrives after cancellation. Web playback still requires a user gesture.
Picker close/unmount retires only its own sample; explicit Stop remains shared.

The development Voice catalog declarations expose `listCatalog` and
`retryCatalog` operations through `settings.invoke` for contributed conversation
services and selected speech engines. Local neural voices use
`voiceConversations.ttsCatalog` and `voiceConversations.ttsCatalogRetry`.
These reads reuse the current catalog owners without starting playback, changing
settings, or acquiring microphone consent. Preview and Stop presses enter the
same local Settings Action executor; picker retirement releases its own sample.

In 0.3 development, `settings.invoke` on `voicePrivacy.privacyPolicy` opens the
public privacy policy through the answering client's ordinary external-link
owner. It needs no execution Machine or microphone and returns typed
unavailability when that client cannot open the link. The same declaration names
the searchable Privacy & data row; standard Action policy still applies.

The development status result includes nullable `inUseVoice`: the qualified
contribution, declared voice field/value and display name accepted for the
current attempt. Unknown application remains null. A saved next-attempt Session
preference cannot relabel running audio; ending or replacing the attempt retires
that fact. Start distinguishes an exact Home-qualified Session target from
global mode, and both retain the ordinary configurable human approval policy.

In 0.3 development, the top-bar caption, glance overlay dismissal, setup tile,
panel Close and Escape enter the existing Voice presentation Actions. Setup Done
waits for the admitted close result before using the existing Home dismissal
owner; a refused close cannot hide the setup through dismissal.
`ui.voice_global.setup.microphone.permission.request` shares the device permission
owner without starting Voice. It retains the automation approval floor and
reports observed granted, denied, unavailable or unknown permission explicitly.
`ui.voice_global.setup.system_settings.open` uses the same native application
settings owner as setup; web or failed opening returns typed unavailability.
Neither operation grants remote capture consent or starts an audio conversation.

`session.voice.preference.set` uses the registered `intent.voicePreference`
owner field. Null restores Account inheritance; a selection changes only a
provider-declared voice field, never the provider, credentials, model or speed.
The private owner work projection retains the choice without exposing it in
shared Session identity. Exact-target instruction preparation and all-carrier
application are separate integration obligations, not implied by accepting a
preference or returning an attempt status.

Contributed provider action buttons, local TTS samples and Forget conversations
enter their declared `settings.invoke` operation before provider calls, audio or
transcript invalidation. Forget retains its existing confirmation after admission.
Audited Voice operation declarations keep direct present-user UI gestures or their
owner's existing consent dialog through `uiConfirmation: 'direct'`; explicit
Action Ask preferences still win, and Agent/MCP danger defaults are unchanged.
Unknown or unaudited required operations retain policy confirmation.
Provider failures expose only the same allowlisted structural code, stage and HTTP
status facts used by the UI; provider-authored error prose stays private.

Manual daemon install/remove/default selection and native prepare/update/remove
also enter their existing `settings.invoke` declarations before model effects,
informational preflight or consent. The incumbent operation owners retain their
scope, selection and consent checks. Native progress and recovery callbacks stay
private to the mounted invocation. Observing an already admitted native download
and cancelling the same invocation do not create new admission requests.

Executable Voice settings operations use `settings.invoke` and return typed
completion, cancellation or unavailability from the same operation owners used
by their controls. Destructive and secret-bearing operations default to approval;
platform audio gestures, consent and save prompts still apply. These are
development-source contracts, not a claim of availability in a released client.

Model Cancel uses `voiceAdvanced.cancelSpeechModel`,
`voiceConversations.sttCancelPrepare` / `ttsCancelPrepare`, or
`voiceDictation.sttCancelPrepare`, with the existing `model_pack` input. It borrows
the current Settings surface's active cancellation command and AbortController,
captured before asynchronous Settings reads. A different pack, execution machine,
Account, completed operation, replaced command or ambiguous active target is unavailable; cancelling does
not invoke model removal. This safe cancellation has no default approval prompt;
install, removal and credential consent keep their existing policies. Device Test
speech also retains its invocation signal and playback stopper, so cancellation
stops speech and releases its audio-session lease.

These V1 Action input/result and nested operation envelopes are closed: unknown
fields are rejected and receive no routing, credential or mutation meaning.
The optional discovery projection preserves older descriptors without an
operation. The new operation is explicitly advertised through the Action catalog
and each applicable setting; its absence supplies no invocation authority.
This extends the 0.3 development contract without a persisted format change or
an older-host obligation to execute the new Action.

`inbox.mark_all_read` and `session.read_state.set` allow Agent and MCP callers to
mark an exact Inbox snapshot or individual Session read without default confirmation.
They delegate to the existing bulk/manual-read-state owners and do not settle
approvals, mentions or human attention. `session.draft.delete` uses the Account's
draft repository and launch-custody guard. `session.draft.directory.set` changes only
one exact mounted, presented, editable New Session composer through its existing directory
intent setter; fixed profiles, submitting or retired composers refuse it. It neither
launches a Session nor creates a directory, and it preserves the prompt. Browse/import reuse
`sessions.external.*` and the exact Session's Home and Machine operation owners;
they are not alternate import or takeover implementations.

The development Channels plugin declares Agent and MCP access for all management
Actions: connection setup, transfer, policy, deletion, pairing and recovery, plus
binding read, resolution, creation, update, enable/disable and deletion.
Observational prepare, retest, resolver and exact-read Actions keep their safe
classification. Writes retain their existing confirmation and the canonical
present-user approval flow before handler execution, along with revision,
target and lifecycle checks.
Pairing finalization still requires the proposal authenticated by the external
human; requesting an Action does not supply that proof. Accepted-loss and
ambiguous-delivery decisions retain their existing disclosures and never resend
an uncertain effect. Channels has no literal rename field: the displayed
endpoint label is not a newly writable preference.

These are development-source contracts, not a released availability claim.

The development `happier.channels/actions/session-pull-request-watch-v1` Action
owns linked-PR watch reads and configuration in Account placement. Its Account
`list` arm has no Session operand; targeted arms retain canonical one-Session
resolution and binding revision checks. Off, Notify, Analyse, Address and
Auto-fix are declared for every Agent. Address/Auto-fix instructions scope work
to the bound head branch, prohibit force-push/merge/enqueue/auto-merge, and direct
replies through the existing marked publication Actions. These are task
instructions, not a native-shell interceptor or an enforcement capability.
Ordinary Action and Session approval policy remains authoritative.

For Auto-fix preparation, existing `scm.status.snapshot` and `scm.remote.pull`
Actions accept optional `sessionId: SessionTargetV1`. A supplied operand selects
the admitted Session's checkout rather than an unrelated inherited Machine or
execution-run target; an omitted operand preserves existing SCM placement.
The existing pull owner still decides fast-forward and dirty-work behavior.
The counted fixing sequence, C1 continuation/attention and composed watch journey
remain integration work; these declarations alone do not prove a completed loop.

The safe Channels management reads share the UI's Account projection owners:
`connection/list-v1`, `binding/list-v1`, `ingress/attention-v1`,
`delivery/attention-v1` and `delivery/read-v1` (qualified under
`happier.channels/actions/`). They are available through CLI, UI, Agent and MCP.
Lists accept the existing Collection `limit` and opaque `cursor`, and return
`nextCursor` when more rows remain, including after a filtered empty page.
Binding lists may filter by exact `connectionId`, `parentBindingId`, `sessionId`
or `automationId`; router children remain ordinary bindings. Recovery rows carry
their exact custody/obligation id and current revision. Terminal ingress attention
also carries the retained, closed refusal reason when available, such as an
unverified sender, a sender outside the allowlist or a disabled automated sender.
It carries no sender address or message evidence. The delivery read derives
`lastOutcome` from custody: accepted work can still be pending or unknown; only
confirmed delivery reports `delivered`. A start requiring owner confirmation also
projects `createdThreadEndpointRequired.parentId` for `delivery/resolve-v1`.
These reads disclose no message body, recipient list, credential, raw provider
configuration or native delivery evidence. Provider reconciliation reads retain
their separate host-stamped provider-caller fence.

### Email, router and recipe Actions (0.3 development)

`happier.channels/actions/conversation/start-v1` takes `routerBindingId`,
`audienceGroupId`, `subject`, `content: { text, html? }` and `sessionId`, validated
by `packages/channels-protocol/src/v1/management/conversationStart.ts`. The Channels
manifest exposes UI, CLI, Agent, MCP and plugin invocation; Workflow `action`
leaves use the qualified id through the existing contributed-Action executor.
Its `writesRemote` confirmation remains subject to the shared Action policy.
An owner-authored Workflow is not a separate sender or an implicit grant to the
model. The result `{ kind: 'accepted', custodyId }` means ordinary outward custody
admission; the supervisor owns SMTP outcome and child-binding completion.

Recipients are resolved from the router's principal group, never Action-supplied
addresses. The named Session must be confirmed to have no attested sender
identity before starting a multi-principal thread. Delivery then creates an
ordinary child binding allowing that audience; partial/unknown outcomes use
`delivery/resolve-v1`. Binding create/update Actions consume the same
`threadRouter` target and existing session policy; there is no router-specific
CRUD owner or thread registry. Parent policy governs children. Email transport
operations require the plugin surface and host-stamped Email-core caller;
user effects remain at Channels custody.

`session.spawn_new` and recipe authoring expose `allowedTools` and `unlistedTools`
through the Session owner, seeding the existing permission allowlist and denying
unlisted requests when selected. Current MCP authoring uses
`capabilitySelection.mcp`. The public HTTP projection omits `executionTarget`;
machine placement is supplied by the outer target. Directory input is
`{ kind: 'managed' }` or `{ kind: 'path', path }`.

`attestedContext: { externalPrincipalId, sourceMessageId }` is accepted only from
host-stamped plugin callers. Other callers receive
`session_attested_context_forbidden`; the Session stores these birth facts
immutably. MCP header values use the canonical `ValueRefV1` `sessionAttested`
arm, resolved by the existing materializer, omitting absent facts. Token grants
do not confer plugin identity.

`workflow.trigger.run_now` takes an existing `automationId` and optional
`idempotencyKey`. API grants can restrict this Action and its machine/Session
targets, plus exact saved Automation IDs with optional `automationIds`.
For run-now admission, a non-null selector requires a matching `automationId`;
omission or `null` preserves unrestricted Automation selection. The same grant
owner enforces this selector at signed HTTP admission, current-token revalidation
and Action execution, and prevents a delegated grant from widening it. Opaque
encrypted ingress defers only the unavailable operand check: the daemon checks
the decoded Automation, and the native run-now route checks that exact signed
operand against the current grant again before occurrence admission. Other
workflow Actions retain their ordinary Action grants. Notification alerts use
`workflow_run_update` with `workflowRun.updateKind` and optional reason code;
they do not prove that Channels delivery completed.

For token-originated manual Runs in 0.3 development, the request envelope's public
`idempotencyKey` is covered by the Home-signed requester root and must match the
decoded input. The SDK projects it before sealing; the daemon refuses a mismatch.
The run-now HTTP adapter retains that root and signs the exact Automation path
and `Idempotency-Key` header, without the daemon's ambient bearer. The native route
rechecks current token/grant and installation authority. Keys are not secret:
never put private content or credentials in them. The existing manual-occurrence
owner receives a credential-scoped key, so fresh requests with the same credential
and key rejoin the same occurrence; different credentials do not collide. With no
key, the signed root requestId is that credential's retry identity. Ordinary app
and Agent callers retain their custom-key behavior through the same occurrence
owner. This is an in-place undeployed 0.3 contract change, with no legacy adapter
or additional dedupe store.

Workflow Account HTTP failures in 0.3 development preserve a closed
`workflow_http_error` result with the HTTP status and, when recognized, the
server's typed code in `details`. The Automation transport shares this projection
across definition reads/writes and manual Runs. Its readable error is generated
from those content-free facts; raw response bodies, validation input and server
messages are never forwarded to approval results or requesters. Existing paused,
missing-content and revision-conflict semantics retain their Action codes.

Operator examples live in the canonical published
[email guide](../apps/docs/content/docs/extending/email-channel.mdx) and
[recipe guide](../apps/docs/content/docs/extending/email-agent-recipes.mdx).

## Boards (0.3 development source)

`boards.list` and `boards.apply` manage the current Home Account's Boards. Their schemas
live beside `WorkBoardV1` in `packages/protocol/src/boards/actionsV1.ts`; the
Action catalog projects agent discovery, MCP, CLI, API and trusted-plugin
access. The generated CLI commands start with `happier boards`; use Action
discovery for the exact input and result schemas.

Board Actions and the optimistic Boards UI queue replay the same
`applyWorkBoardIntentV1` intents through
`createWorkBoardArtifactPortV1`. Each Board is one `work-board.v1` Artifact,
using the existing mode-aware Artifact clients, encryption, revisions and push/catch-up.
Header metadata supplies the name, Sessions pin and Needs-you dependency without
opening every Board body. Conflicting edits reapply the same semantic intent on
that Board's winning revision; deletion also compares the observed revision.
Board edits do not upload unrelated settings or other Boards, and do not inherit
the Account settings collection quota. A failed save keeps
the acknowledged Boards visible and offers Retry. Board entries in the Artifact
inventory open Boards; direct generic Artifact detail/edit URLs also route to
that owner instead of exposing the generic note writer for Board JSON.
Missing Boards return `board_not_found`; editing an unreadable Board returns
`invalid_board_record`. JSON syntax, Board-schema failures and row-local
`content_unavailable` errors from exact Artifact reads are isolated to that unreadable
document, so readable neighboring Boards still load. The port retains unreadable
coverage; `boards.list` returns only readable documents. A direct opening with a
retained readable header shows that Board's named error state with Retry, not a
missing-Board message. Transport, authentication, Account mode/material, cancellation
and retired-scope failures still fail the request. The stored document owner preserves unreadable Board bytes,
unknown Artifact kinds and unknown source values
without exposing them as writable Action input.

`boards.list {}` returns Board documents and qualified references, not live card details.
`boards.apply {boardId?, intent}` accepts the existing `WorkBoardIntentV1` vocabulary:
`create`, `delete`, `update`, `add_items`, `remove_item` and `set_positions`.
An optional outer `boardId` must match the intent target. Results include that id and
the acknowledged Board, or `null` after deletion.
Sources contain live sections, an inline Sessions filter and hand-picked refs
with `{kind, qualifiedId: {serverId, id}}`. A `source` update changes only supplied
fields: omitted sections and filter stay unchanged, supplied values replace that
setting, and `null` explicitly clears it. Omitted `picked` preserves hand-picked
items, and unknown source data remains retained. Removing
hand-picked refs delegates to the same Board intent owner as the UI.
Agent `set_positions` moves do not prune: agents have no authoritative live
membership, even when they supply a stale membership projection. UI moves still
use their current membership for pruning. Mode switches retain Canvas positions.

Board edits use Account automation authority. The mutation can delete a Board and uses
the shared Action approval policy; approval results are blocking and required
so callers receive the mutation outcome. The present user's own UI edits (Board settings, items,
positions and every widget intent, as for `widgets.item.*`) are reversible and are admitted
without a confirmation; only `delete` and a widget's network change confirm, and an explicit
Settings → Actions Ask applies to any of them. Agents and automation keep the approval floor. UI create, settings, remove, widget and drag
controls enter `boards.apply` before the optimistic queue; Retry re-enters the same
Action admission under its captured Home and Account. Live UI membership is supplied
only by the Board adapter, never trusted from agent input. A host without the Board Artifact
transport reports `unsupported_action`.

## Session-spawn model choices (0.3 development source)

Host Voice Session creation uses the ordinary `session.spawn_new` executor and
approval policy. Its admitted Home and Account supply the opaque creation
namespace, so a retry with the same creation key rejoins the same logical
creation without colliding with another Home or Account. Missing admitted scope
refuses creation. This namespace grants no permission: the host derives Voice
authority from the captured credential. An Account credential supplies
`present_user`; other credential kinds retain `account_automation`. The ordinary
Action approval policy still applies before creating a hidden conversation.

In current 0.3 development, an explicit same-input retry of `session.spawn_new`
after a typed retryable creation error starts a new operation receipt while
retaining the original terminal receipt. The logical creation key and native
nonce remain unchanged: the ordinary creator still creates or rejoins the same
Session. Pending outcomes remain resume-only; success, nonretryable failure and
other Actions' terminal results continue to replay. This does not automatically
retry a failed start or turn a transport acknowledgement into birth success.

The retained creation operation owns cancellation through native Session open.
In 0.3 development source, daemon commitment and seeded creation forward that
same lifetime to their shared Session-create HTTP transport. A signaled request
has no shorter POST timeout; standalone callers without an operation lifetime
retain the existing transport timeout. Cancellation refuses a successful caller
receipt but cannot undo a server commit. The existing creation key and tag
continue to own create-or-rejoin identity after an uncertain result.
The signed root Action observer also follows that creation lifetime rather
than ending at the generic five-minute HTTP cutoff. An explicit caller deadline
or cancellation still ends that caller's observation.

`action.options.resolve` for `session.spawn_new`'s `modelSelection` field returns
an optional strict `modelCatalog`: native choices from the existing Agent
inventory, plus the exact Machine's existing Provider picker projection. Generic
`options` remain native choices. Other fields and Actions do not receive this
catalog. A missing or failed Provider projection is `null`, not a fabricated
model list; native choices remain available.

In 0.3 development source, launch option rows are choices, not complete start
inputs. A native model row's `value` is a model-id string. Session creation uses
it in `modelSelection.ref.modelId`, with the selected Agent target key,
`providerConnectionId: null`, `v: 1` and `updatedAt` on the selection. Connected
Account profile ids belong in `connectedServices`, not the Provider connection
field. Execution Runs accept that native model string directly as `modelId`.

In 0.3 development source, Session-scoped native hosts keep attached Run starts
and their shared review, planning, delegation and Voice start Actions on the
bound Session Run owner. Admission reads the credentialed Agent inventory and
the requester's narrow Agent-start policy through the existing Session-capability
daemon channel, and consumes the Session's prepared Role context. The policy
contains only the work-depth limit, Agent/Role allow-lists and spawn restrictions;
the restricted runner receives no Account settings document. Missing requester
authority refuses admission instead of substituting Account defaults or the
daemon's Account. Session spawn, Workflow leaves and attached Runs consume the
same requester-owned policy. Literal leaf launch does not hydrate Launch Profiles;
only an explicitly selected launch `profileId` requires that catalog. Connected
Account profile ids do not select a Launch Profile.
Run-scoped MCP views retain that same Role owner. This in-process
adapter reaches the current Run protocol owner
directly; it does not negotiate through a remote Machine catalog. The bound local
RPC carries the admitted depth, workspace-write ceiling, Role context and causal
permission authority; it cannot select a foreign or detached Session. Target
lowering uses the canonical routing spelling for authored Agents without requiring
a runner-local installed catalog; the retained daemon snapshot still admits the
actual executable contribution. Session spawn retains its credentialed daemon dispatch.

The credentialed CLI adapter still refuses attached starts carrying private depth
or workspace-write stamps through public Session RPC, which cannot authenticate
those stamps. It returns `execution_run_target_unavailable` and `noRunCreated`
before resuming or starting the Run. An unavailable host start context returns the
content-free `details.issues` path `host`; Run refusals retain their authoritative
creation certainty through the existing failure projector.

In 0.3 development source, Session-caller starts inherit an omitted Launch Profile
and `connectedServices` from the authenticated baseline when the resolved child
Agent and Machine are the same. This applies to `session.spawn_new`, attached
execution Runs, Review, planning, delegation, Voice, Approval reviewer Roles and
Workflow leaves carrying that baseline. A model reference alone does not clear
Connected authentication. Run `launchProfileId` names the Launch Profile;
Run `profileId` still names a plugin execution Profile. Explicit bindings,
native resets and Account-default choices retain precedence. An explicit binding
object overrides inheritance; `{v:2,bindingsByServiceId:{}}` selects native
authentication. Root and different-Agent Session starts use Account defaults
when omitted; incompatible attached Run inheritance returns the existing typed
child-choice refusal. Inherited choices are re-admitted before materialization.
`session.status.get` on `self` exposes the authorized Session's
content-free `connectedServices` selection for explicit reuse; a missing field
means unavailable selection evidence, not native authentication. Pool reads and
inheritance preserve the pool id without pinning its current member.

A Session `configuration` is an optional full snapshot. Its `mode`, `model` and
`permissionIntent` each carry `{ value, updatedAtMs }`; unset values are `null`.
Its `options` map carries `{ value, updatedAtMs }` for each option id. Model values
are strings, permission intents use the canonical `read-only` spelling, and
option values are scalars. Configuration choices name option ids; the Agent's
`agents.config_options.list` inventory owns their value choices. An empty
inventory does not require an empty snapshot: omit `configuration` when no
override is needed. The configuration schema sections expose this typed shape
after the existing strict JSON normalization.

Supply the selected native `modelId` to `agents.config_options.list` to include
that model's declared `modelOptions` alongside session-wide controls. A model's
declaration takes precedence for the same option id; choices from other models
are not combined. Session lookup reads the model from `modelSelection` or the
stamped configuration, and Run lookup reads `draftInput.modelId`. With no
selected model, only session-wide options are offered; an empty answer can be
valid. Public option definitions contain allowed values, never current selections. These inventory
Actions bind their Home from authenticated host context: omit `serverId` in
`agents.models.list`, `agents.config_options.list`, `agents.session_modes.list`
and `sessions.spawn.connected_services.list`. A supplied `serverId` is refused
at that field; select the Home through the invoking transport instead.

In 0.3 development, a selected `machineId` routes model and configuration
inventories through that Machine's native capability producer, for both direct
lists and dependent options. `probe` supplies optional launch context; it is not
an opt-in to Machine discovery. Credentialless native MCP hosts use their
existing Session-to-daemon Action channel for Agent inventory reads. Session and Run config lookup forward the same
directory, profile, Connected Account and runtime descriptor context as model
lookup. Unscoped local discovery retains its existing local probe and metadata
behavior; it does not replace an unavailable selected-Machine observation.
For `execution.run.start` options, an omitted Machine uses the calling Session's
Machine. An explicit `draftInput.machineId` still takes precedence; Session spawn
continues to use its authored `executionTarget.machineId`.

For execution Run model/config/Connected option lookup, set
`draftInput.backendTargetKey` to the selected backend choice's string `value`;
the start input's `backendTarget` object alone does not select an inventory.
Execution Run `configOptions` maps option ids directly to scalar values.
Inline Workflow definitions put model selection and effort on `defaults.engine`
or a step's `execution.engine`; use `effort`, rather than a
`reasoning_effort` entry in `sessionConfigOptionOverrides`. Run
`workflow.validate` before starting an authored definition. These
contracts share discovery and admission owners with UI, CLI and external plugins.
With an origin Session, Workflow leaves resolving to that same Agent inherit
its Connected selection when omitted, including literal and input-bound engines.
The accepted leaf freezes that selection for both Session and detached Run
execution; explicit bindings or native/reset choices retain precedence.
Workflow definition schema sections expose the canonical authored ingress,
including recursive block shapes and prompt shorthand. The Action transport
remains shallow so the iterative Workflow validator can report deep repair
paths without overflowing a recursive transport parser.

The read uses the daemon's retained Provider services through its existing
Machine transport, after the owning Action's ordinary credential admission.
Provider rows retain structured references, compatibility, visibility and
recovery facts. Any direct-materialization endpoint and credential-transport
descriptors are public, nonsecret binding facts, not credential values. Catalog
metadata grants neither execution permission nor trusted prompt authority;
choice narrowing stays with the existing model hide-key owner, and launch
revalidates the selected binding through ordinary Action and Provider admission.

Host Voice may create its conversation before it has a parent Session. Its
canonical spawn retry identity is scoped to the admitted Home and Account,
using the existing opaque creation namespace and durable Action request id.
Missing scope fails closed. This identity is only deduplication and does not
change the captured credential's authority or the Action's approval requirement.

## Notify me (0.3 development source)

`notifications.notify_me` is an Account-automation Action with `message`, optional
`title`, optional `open` (`session` or `workflow_run`), and optional `channels`.
`notifications.channels.available`, resolved through `action.options.resolve`,
projects the same configured push, webhook and plugin-channel owners used by
Activity delivery. Omitted channels select all available channels; an explicit
list restricts delivery, and removed channels are ignored. Delivery still follows
the Account's attention policy, quiet hours and preview privacy. The result reports
`attemptedChannels` and `deliveredChannels`; it does not create an Inbox item.

Notify me is safe and does not require confirmation by default, including Agent
and MCP callers, because it sends only to the caller's own Account. An explicit
Require setting still requests confirmation before delivery. Its
`approval.result: 'required'` describes result custody when confirmation is
required; it does not itself enable confirmation.

The CLI's generated `happier notify` command uses this Action rather than a direct
push path. UI/Voice relay to the captured Account's daemon. Plugin channels are
reached through the current plugin runtime owner and activate only when selected
for delivery. A Workflow caller without an explicit `open` link defaults to its
own run; explicit links are checked for visibility by the Account host. The Activity
owner's existing request-id replay suppression applies to Notify me delivery.
Webhook payloads add the `notify_me` topic and, when supplied, Session or run
navigation metadata. This describes development source, not a released guarantee.

## Computer target consent (0.3 development source)

Native computer actions are machine-placed, with the Session supplied by the authenticated
host context. The computer owner retains that Session's user-selected target in the existing
screen capture registry. Agent calls to `computer.targets.list`, `computer.target.select`,
`computer.control.interrupt` and `computer.control.handBack` require approval by default,
with per-action waivers through Actions settings and the existing bypass semantics.
Window enumeration can disclose other windows' titles, so it has its own approval default.
Approval preserves the agent's `account_automation` authority; it does not turn the caller
into a present user or grant observation consent merely for selecting or handing back.
User controls relayed through external Actions carry a Session envelope target, which the
existing locality resolver validates against the executing machine.
The person's own controls from Happier (choose, look, stop, hand back, privacy pane) reach the
same computer owner over the owner-scoped machine RPC `daemon.computer.actions.execute`, through
the UI's one Action front door and runtime chain. The route attaches through the daemon's shared
Machine RPC route owner after Machine registration, including transport replacement. Registration
does not depend on desktop or driver availability; an absent Computer owner returns `computer_unavailable`.
The route carries verified RPC caller authority and cancellation to the computer owner, defaulting
omitted authority to automation. It names
the Session from the request and admits only the control Action set, never agent input, whose
person-side equivalent travels as live-stream sideband controls. `computer.targets.list` without a
`displayId` lists the daemon's own X11 desktop (`DISPLAY`) or macOS's logical `primary` desktop; a machine without one returns
`computer_display_unavailable` and an unsupported desktop returns a typed `target_unsupported`
refusal, which the picker explains instead of showing an empty list.
Computer use targets the Session's own machine (orchestrator ruling, 2026-10-01): the named flow is
computer use on the daemon's desktop, including a remote dev box. The UI lists and selects only on
the Session's machine, named by its chip; a request that names another machine opens on a typed
refusal (`computer_machine_mismatch`) and there is no cross-machine path in the UI. The computer
owner refuses a different machine id (`computer_machine_mismatch`). `daemon.computer.actions.execute`
remains person-side only; it has no agent variant.
The registry permits only one Session to own overlapping native input targets at a time:
a display conflicts with windows on that display, while distinct background windows
can remain independently selected.
Another Session's selection returns `computer_target_in_use`, including while the previous
owner drains. Confirmed close releases ownership; an unconfirmed close remains quarantined.
Consent and model media remain Session-scoped rather than shared across those Sessions.

An agent selection request supplies `requestedTarget`, a window-title or app suggestion,
and may supply an exact native `target`. The approval UI reads the suggestion from
`actionArgs.requestedTarget` and authoritative display facts from
`preview.computerApprovalDisplay`; a suggestion is not a host-verified title.
Both policy-routed and explicitly created approvals resolve these display facts from
the computer owner; caller-supplied preview facts cannot replace them.
In development, the human may choose a different native identity and submit the
full selection as `narrowedInput` with the existing
`approval.request.decide` operation. The Action spec's `approvalNarrowing` admits
the choice; a `see` request cannot be widened to `use`. The approval owner stores that
selection separately as `decision.narrowedInput`, preserving the original signed
`actionArgs`, machine, Session and original agent authority. The blocking Session
waiter consumes the decided request. Before storing an edited choice, the decision route
validates its exact identity against the deciding person's fresh native target list.
The current decision records `present_user` authority for that edit; the transition
owner admits only spec-valid choices at `open` → `approved`; the decision then
stays immutable during execution. Replay verifies the existing signature against
the unchanged original arguments, validates `decision.narrowedInput` against
those arguments through the same spec, and executes the admitted choice. No
re-signing or signature bypass is involved. The existing terminal observation
projection applies to both original arguments and the saved choice so settlement
does not retain native target identities or write-only secrets.

The selected capture source owns access for its lifetime. `computer.target.select`
defaults omitted access to `use`; an explicit `see` selection refuses `computer.input`
with `computer_access_read_only`, including approved or bypassed agent Actions. This does
not disable the person's own native stream controls. The selected-target response and
owner-resolved approval display report access and the native app display name when available.
Changing access replaces the selected source and requires fresh observation consent.
Selection admission excludes overlapping desktop/window controllers, including a
Wayland desktop and its inherited XWayland connection. Explicit unrelated X11
desktops remain independent; wire target identities are unchanged.

Window listing reports the pinned driver's app display name. Present-user listing may
also include a Session-free PNG thumbnail; agent listing never captures or returns preview
pixels. The development driver also lists the native logical primary desktop when
`get_screen_size` returns validated dimensions, reporting `displays: { status: 'available' }`.
This is not a physical-monitor catalog: the pinned native driver supplies no additional display
identities or negative-origin display geometry. An unavailable producer retains
`display_enumeration_unsupported`. Enumeration never selects a source. Whole-desktop
selection uses the existing see/use approval policy; its presentation must disclose
that other visible apps and notifications can be seen, without adding a second forced prompt.

Control status reports `activity` while agent capture or input is in flight. Click targets
use capture-bound accessibility names and the browser owner's normalized `activeTarget`
shape and label redaction. Input results carry the same `targetLabel` when known; neither
typed text nor accessibility values supply presentation labels. The pinned Linux driver
does not identify the focused accessibility node, so keyboard activity omits a target
name and cursor rather than guessing from a preceding click.
The status Action also reads current OS grants from the retained native driver;
ordinary control refresh does not request thumbnails. An uncertain, quarantined
source still reports its control status without claiming a fresh grant read.
Capture-permission loss disables viewing and input but preserves the selected
share and Stop sharing until the daemon confirms retirement.

The first consequential action follows the ordinary approval owner's policy, including its
bypass semantics. Selecting a target is independent of approval: bypass without a selection
returns `status: 'target_selection_required'`, with display facts for a picker, and performs no
capture or input. A selected target's admitted consent is reused until the user replaces or
revokes it or its window disappears. Explicit per-action approval preferences still apply.
Approved requests bind the selected source lifetime, so a revoked selection cannot authorize
a later selection of the same window.

Approval previews carry `computerApprovalDisplay`: the owner-resolved machine display name,
target kind and title, and the latest observation's Session-image reference when available.
That display shape contains no native target identifiers. The Session-image verifier checks
Session scope, bucket containment, digest and MIME; daemon artifacts use the daemon storage
root rather than MCP cwd. The current Session dispatcher reaches its local daemon; remote
desktop dispatch and cross-machine image retrieval are not established by this implementation.

Stop not confirmed is `interrupted { completion: 'unknown' }`, with `uncertain: true` in
control status. It is not an acknowledgment of safe human control. The shared input controller
owns settlement and recovery; the computer routes do not maintain a second controller.
Once active input has settled, the person can hand back even while status remains uncertain.
For both browser and native input, hand back requires a fresh agent observation before the
next agent mutation; that observation clears uncertainty. The shared admission code is
`observation_required`; browser Actions retain their existing `stale_navigation` projection.
Hand back alone never claims that the preceding physical effect stopped safely.
`browser.control.takeControl` and `browser.control.handBack` expose the existing strict
`takeControl`/`handBack` command DTOs as machine-placed Actions through the same browser
controller owner. Agent invocations have the same waivable approval default as native
controller transitions. Takeover/interrupt are classified safe: yielding control is not
a dangerous physical mutation. Hand back is safe too, and never relaxes fresh observation.
`computer.permissions.openSettings` is a present-user machine action: on macOS the daemon
launches the relevant Screen Recording or Accessibility Privacy pane, returning `dispatched`
only after the OS launch succeeds. This neither grants permission nor proves the pane is
visible. The development executor uses the same installed pinned native driver for
Linux/X11, native Windows primary/window targets, macOS, and enumerable native
Wayland targets beneath that owner. Windows/macOS default to `primary`; Linux
prefers its inherited Wayland socket to XWayland when present, while explicit
X11 connections remain exact. Wayland desktop selection requires native size
metadata (Hyprland in pinned Cua 0.37.0); other compositor windows remain subject
to the driver's identity/capture/input limitations. An empty unsupported
compositor returns explained `wayland_target_unavailable`.
macOS Screen Recording and Accessibility are checked independently; capture-only window
capture omits the Accessibility tree, does not grant input, and denied/unknown grants
refuse the affected operation. Window input retains native background delivery; desktop
input uses the pinned native foreground delivery rather than its unsupported background mode.
Desktop input consumes one exact capture binding and rechecks current dimensions/backing scale;
viewer frames use the existing separate read-only native process and cannot replace that
model binding. Unknown physical completion remains quarantined, never retried.
An explicit target reselection retires that source only after the old native
process has actually exited, then acquires a new source and requires its fresh
observation; it does not replay the unknown input. Window clicks retain host-side
origin and dimension currentness checks. Viewer keys and text use the same input
controller and exact-target native delivery without a screenshot/accessibility
observation per key; they do not replace the model's capture binding. Hand-back
still requires a fresh agent observation. Pointer checks are not an atomic native
origin guarantee. Proven native capture-admission refusals retain their typed
reason and allow a fresh observation without retiring the source. The pinned
`browser_field_needs_keystrokes` refusal likewise remains known; it does not
authorize foreground escalation. Generic tool failures do not prove nondelivery.
Physical macOS permission/input certification and loaded picker/disclosure UI validation
remain separate evidence. Windows and native compositor capture/input journeys
likewise require native release certification. Windows pixels stay physical at
high DPI. Its ordinary input does not require elevation, and native UIPI or
background-delivery refusals do not authorize foreground escalation. See the
[native computer driver contract](binary-runtime.md#native-computer-driver-03-development-source)
for platform permission semantics and compositor prerequisites.
The native contract does not establish exact confidential focus/field delivery:
`computer.secret.fill` remains refused as `field_verification_unsupported` by its existing
trusted executor; ordinary typing is not confidential-fill support.

### Confidential credential entry (0.3 development)

`browser.automation.secret.fill` requests an exact-target human choice through the
existing approval Artifact; its public input contains no credential. The private
continuation accepts a Saved Secret catalog choice or an ephemeral one-time value.
Always allow cannot supply that choice. The executor rechecks the deciding human's
Machine admission separately from the original requester's current origin.

The managed Browser producer qualifies only its actual live headless view as
unobservable by native capture. Other producers refuse confidential entry. Its
existing input/capture owner retains the confidentiality hold while the document
can reveal the value; handing control back does not release it. Field, focus and
document proof bracket fresh approval/access checks immediately before insertion.
The controller status and controller-change event project the existing hold as
the optional `confidentialityHeld` fact for the viewer. It is advisory, not
permission to capture or deliver input, and does not create a second hold owner.
This does not claim atomic isolation from the browser or another same-user process.

Fill and separately reviewed submit settle independently. A known fill remains
filled when submit is refused or unknown; unknown entry never submits or retries.
The private consumer zeroes its mutable delivery buffer on every settlement, and
approval/Action results remain bounded and value-free. Loaded-runtime transport,
recording and UI validation are separate evidence, not implied by owner tests.

Native viewer capture uses an admitted FPS cap only when one exists. Without a cap, capture
completion waits for the viewer's admitted credit/ack before the next fresh observation;
there is no polling timer or invented FPS ceiling. The transport remains the credit owner,
and relays forward accepted acknowledgements to demand-driven capture sources.

### Authenticated Home continuation (0.3 development)

`account.home_continuation.invoke` requests a currently mounted Account continuation:
choose a Home, retry or refresh, stop waiting, relink, or open the enrolled Home.
The descriptor-only current UI context supplies an opaque `commandId`; its private
mounted record supplies the operation and, for Home choice, the public Home identity.
Generic current-context invocation delegates to this typed Action rather than
authorizing an outward `hostLocal` callback.

The requester and human answerer are the same authenticated Account. Agent/MCP
requests use the existing Action approval policy and require `present_user` authority;
approval replay re-resolves that exact mounted command, Account binding, operation
and Home choice. Unmounting or replacing the Account or continuation makes it
unavailable. The existing Account Directory continuation and enrollment owners still
perform the operation and own cancellation; no second enrollment state machine is added.
When several retained continuation cards share one page, an explicit interaction
activates that eligible card through the existing current-context publication owner.
It retires the previous command before requesting an effect and waits for the new
descriptor's commit. Background publication cannot steal focus; hidden, suppressed,
ineligible or disposed cards cannot activate a command.
Native Agent/MCP requests retain their authenticated Session provenance and the
installed daemon's Machine identity; human replay returns through that exact
daemon and the existing client-placement reverse channel. For a local Home-open
approval, a known focus acknowledgement may finalize only its original claimed
Artifact through the existing exact-Home Account adapter. This checks the original
Account, credential material and cancellation rather than borrowing the newly
focused Account. Unknown or non-open outcomes never use that finalization path.

Bootstrap without an authenticated Home Account remains UI-only. Key, credential
and QR acquisition stay in the human recovery flow and are never Action input or
durable approval material. The public Action input is strict and contains only
`operation`, `commandId`, and the Home identity for `choose`.

### Session cancellation and permission intent (0.3 development)

In 0.3 development source, `session.turn.cancel` requests cancellation of the
current turn through the existing `abort` RPC. It keeps the Session process
available; `session.stop` requests process shutdown. Both the composer Stop
button and Agent/MCP/CLI requests enter the canonical Action executor.
An embed's Send grant includes current-turn cancellation, and an abort-only
grant does not authorize sending messages or stopping the Session process.
Permission decisions continue through `session.permission.respond` and retain
their separate approval authority.

The development `session.control.switch` Action requests `remote` or `local`
control through the existing Session terminal switch owner. The Session's
release-to-remote callback uses this same Action and its configurable Off, Ask
or Allowed policy. Unsupported or retired terminal control returns
`session_control_unavailable`. Submission's existing composed switch and the
predecessor `switch` RPC retain that same effect owner and boolean wire reply.

The development `session.permission_mode.set` Action applies immediately;
`applyTiming`, when supplied, must be `immediate`. A `next_prompt` request returns
`invalid_parameters` with instructions to use `session.message.send` and its
`permissionModeOverride` field. The same schema governs CLI, MCP and API calls.

The composer's “From the next prompt” choice is retained with its draft. Send
enters the Send Action with that permission intent; selection alone does not
change the running turn or publish a Session mode. Embedded and standalone embed
composers use the same owner. A refused or unconfirmed Send retains the draft;
accepted Send clears only its captured intent revision, preserving a newer selection.
Recovered armed Agent-continuation custody performs the same revision-sensitive
clear after a delayed response or composer remount.
Agents get the same effect by calling Send with `permissionModeOverride`.
There is no daemon-retained pending permission mode.

## The three host-stamped facts

Three fields on a spec row are stamped by the host and never accepted from Action input. Together
they decide who may invoke an Action, where it runs, and how it reaches the Home.

**`requiredAuthority`** — `account_automation` or `present_user`. It is deliberately independent
of transport: a Personal Access Token and a trusted plugin both carry automation authority, while
an interactive host path can carry a present user. A row may declare it: Team identity and
directory rows declare their individual human-authority floors, while external Group
mapping reads and mutations retain `account_automation` through the shared Home-domain
row builder. Otherwise `resolveActionRequiredAuthority` resolves it
from one explicit id set (`PRESENT_USER_REQUIRED_ACTION_ID_VALUES`), defaulting to
`account_automation`. Either way the answer is computed once. This is also what
derives the public API surface: `surfaces.api` is computed. Automation rows are
eligible, as are the explicit token decision and conversational-input rows;
editing a surface flag cannot expose an arbitrary present-user Action.

In 0.3 development source, `resolveInvocationAuthority` derives the invocation's
authority from verified credential kind, surface and the effective terminal
policy. An account credential is present-user on UI/RPC; a terminal credential
is present-user on CLI/RPC only when allowed. Voice, plugin, Agent and API-token
callers remain automation. Server verification owns the corresponding verified
credential authority; forwarded RPCs use its stamped `callerAuthority`.

The plain Account security projection owns `terminalPresentUserPolicy`, which
defaults to `allowed`. The CLI/daemon combine it with
`HAPPIER_CLI_PRESENT_USER=allowed|disallowed`, with the most restrictive value
winning. An unset override defers to the Account; an invalid value fails
CLI/daemon startup. `happier auth cli-approvals get` reads the Account policy;
`happier auth cli-approvals set allowed|disallowed` changes it through
`account.security.terminalPresentUser.set`. The mutation remains present-user
and disconnects existing terminal sockets so reconnect applies the new policy.
A disallowed CLI also sends an authority ceiling, which can only lower authority.

**`executionPlacement`** — `account`, `machine`, `session`, or `client`. External ingress resolves
an Action's execution target from this registry fact rather than from the id's prefix, so a new
Action cannot silently inherit a Machine route by being added next to one. In 0.3 development,
`client` executes on the answering app through admitted daemon reverse dispatch where that
host has a machine client; absence is typed unavailable. A client-placed Action with a declared
CLI command is exposed through that ingress; undeclared client Actions remain closed. A
standalone CLI without an answering app receives the typed `noClient`/unavailable result
unless that Action declares a headless source, as `inbox.get` does below.

In unreleased 0.3 source, a daemon plugin's ordinary contributed-Action call
reads the exact placement descriptor with its host-stamped `plugin` surface and
`account_automation` authority. A Machine-placed callee in the bound runtime
executes locally through canonical Action admission and the current runtime
invoker, without repeating Account/Machine selection. Plugin-only descriptors
remain unavailable to CLI callers. A plugin call without a bound execution
owner returns `plugin_action_execution_placement_unavailable`; it cannot borrow
CLI authority. Account placement and explicit target-routing currentness checks
retain their existing owners.

In 0.3 development, placement is resolved independently for each child of a
composite Action. `executeHostChild` sends Machine-placed children through the
credentialed host's existing root placement router, including during an
Account approval replay. The Account parent retains its own placement; the
selected daemon owns the child's Machine effect. The private child entry point
derives a request identity from the parent request and the child's position
among calls to the same Action, using the existing deterministic retry identity
derivation. Local execution and Machine routing receive that same identity;
sibling effects stay distinct and repeating the same child path rejoins it.
Workflow Run-start ingress
refuses a missing daemon-applied runtime before materialization or storage. Its
existing `target_unavailable` result carries reason
`requester_runtime_unavailable` and retains
`PLUGIN_DAEMON_RUNTIME_UNAVAILABLE` in `details.errorCode`.

In 0.3 development, Workflow Run list names are private display projections of
the accepted snapshot. Authored metadata wins; an accepted built-in catalog
reference without metadata uses its portable built-in title. Anonymous inline
Runs remain unnamed, and unreadable private content remains unavailable. This
does not rewrite accepted/replay metadata, query a mutable definition, or add
per-row reads. Opened detail publishes the same display metadata into the
Account Run store.

In 0.3 development, `session.work.get` and `inbox.get` use this same CLI ingress to
prefer the answering app's mounted canonical projection for the exact Home and
Account. The mounted Work Session or Inbox advertises its own address on the
existing reverse-RPC channel, so another connected app without that owner cannot
answer the read. They never mount or load a second app projection. Work returns
`{ status: 'unavailable' }` when its owner is absent. Inbox instead reads the
captured Account's private notice Artifacts through the existing mode-aware
host reader and the same notice-item projection as the app. Its `partial`
result includes `coverage.sources`: notices report content coverage, while
app-only live items and friend requests report `requires_app_projection` and
device-local Action operations report `device_local`. Denied, loading or
uncertain client reads are not replaced with headless results. The app-shell siblings
`inbox.mark_all_read`, `session.draft.append`, `session.draft.delete`, and
`session.draft.directory.set` also expose declared CLI commands through the same
client placement, retaining their existing authority, approval, and domain
contracts. `inbox.mark_all_read` reports client absence as the typed
`unavailable`/`noClient` failure rather than an acknowledgement list.

The development `inbox.get` ready or partial result includes the mounted model's canonical
`items`: type, view, read state, qualified source, exact focus and `pageRoute`.
Discussion rows retain their exact message reference and Doc proposal disposition;
`coverage.discussions` reports complete, partial or unavailable source coverage.
An incomplete private Artifact source preserves other admitted rows in a `partial`
result, with notice coverage in `coverage.sources`. Pending reads retain
`isLoading`; failed or unreadable Artifact coverage sets `refreshFailed`. An empty
incomplete projection still returns `loading` or `unavailable`, never caught up.
Opening a proposal marks it read without deciding it. The existing grouping and
source-id fields remain projections of the same mounted model.

**`serverTransport`** — an optional `{ method, path, preservePathFieldsInBody? }` declaration naming the Home route that carries a
server-owned Action. It is a local declaration only: the domain route still owns wire validation
and authorization, and the field is intentionally excluded from serialization
(`serializeActionSpec` builds its output field by field and never copies it) because it is not a
cross-version wire contract. The family transports read it back from the registry —
`homeDomainActionTransportV1` throws if a registered family row declares none — so the request a
host builds and the schemas it parses come from one row rather than from a hand-kept client map.
In 0.3 development, Session folder/tag deletion declares `preservePathFieldsInBody: true`
because those existing routes validate the identity in both the path and the body. Other
mutations send the remaining fields; GET encodes the remaining fields as query parameters.
`POST /v1/actions/:actionId` stays the single generic
external entry; a per-Action server route is the Home's data operation, never a second way to
invoke the Action.

In 0.3 development, mounted Plugin UI also uses this existing Account root
carrier to reach its exact admitted daemon and then the canonical domain owner.
Provenance-only Action shapes are signed-root eligible only with the narrowing
mounted claim; they remain absent from the API-token catalog. The daemon derives
plugin policy from its own current registry, not a claimed caller or publisher
signature. The [plugin carrier contract](plugin-platform.md#mounted-plugin-account-root-carrier)
owns the binding, refusal and approval-replay details.

## Classes Q, M and H

The Teams-program plans classify every Action row as Q, M or H. The letters are plan shorthand;
in source each class is a combination of existing fields, so there is no `class` column to read:

| Class | Source shape | Meaning |
|---|---|---|
| **Q** (query) | `safety: 'safe'`, `requiredAuthority: 'account_automation'` | A read. Agent-exposed by default. |
| **M** (agent may propose) | `safety: 'danger'`, `requiredAuthority: 'account_automation'` | A consequential mutation an Agent may invoke, reaching human consent through the derived approval floor rather than through a refusal. |
| **H** (human only) | `requiredAuthority: 'present_user'` | Account security, root-token administration, sign-out-everywhere, plugin trust/install/secrets/hooks/grants, Runner activation and declared Team identity/directory administration require present-user authority. Token decisions and conversational input have the explicit admission exceptions below. |

In 0.3 development, the Account preference **Voice agent can approve requests**
(`voice.canApproveRequests`, default on) delegates approval and denial of pending
requests to the host's Voice agent in Local Voice and host-tool realtime modes,
acting for the person. Native Codex Realtime is excluded. This is a narrow decision
capability through the existing approval owners, not direct execution authority for
other effects. The original Account and request entitlements still apply. Turning
the setting off restores the tap requirement; Agent, MCP, API-token and other
non-Voice callers keep the authority rules below.

`resolveCredentialActionAdmissionV1` admits `approval.request.decide` and
`session.permission.respond` for a present user or an API token with opt-in
`grant.approve`. In 0.3 development, host Agent/MCP callers may also invoke
`session.permission.respond`: the shared Action approval policy requires approval
by default on both surfaces, and the user may explicitly waive it per Action
and surface. Host Agent/MCP callers may decide ordinary approval requests only
when the user explicitly waives `approval.request.decide` on that surface.
Without that waiver the decision returns `present_user_required`, without
creating a recursive approval. The waiver never delegates privileged or public-link
authority, and never lets an agent decide its own request: the executor compares
the immutable requesting Session with the deciding Session before forwarding or
settling a decision, refusing unavailable requester identity. These are development
contracts. API-token authority remains unchanged. A token also needs
membership in the decided request's target;
it does not need permission to execute the Action being approved. It may decide
a request it started itself, except that approving a present-user Action always
requires a present user. An Approve-scoped token can still reject that request.
Surface-control approval decisions are a separate human-only contract in 0.3
development: browser Take control/Hand back, computer list/select/interrupt/Hand
back, permission-settings recovery and sandbox installation cannot be approved
or rejected by an automation credential. Their Actions remain Agent-requestable
and use the existing configurable approval defaults; a waiver does not manufacture
a human decision. `decisionAuthority.ts` owns both predicates, keeping execution
admission separate from approval-decision authority.
The UI Browser executor validates non-command Machine Actions against their exact catalog input
schema and forwards them through the captured Account's exact-Machine transport. Sandbox recovery
therefore reaches the daemon's existing authority and Machine checks; an unavailable noninteractive
sudo authorization returns `status: 'failed', code: 'os_authorization_required'`. Workspace opening,
system-browser opening, annotations and recording attachment retain their answering-client owners.

In 0.3 development, `browser.context.attachToComposer` also accepts
`{ source: 'activePage', browserSessionId, viewId, navigationGeneration }` to capture
the exact mounted page reference and attach it to that view's Session composer.
Inputs without `source` retain the Machine-owned captured-context operation.
`browser.context.annotation.attachDraft` takes the same view and navigation
identity and commits its marks through the existing capture, media registration
and grouped composer owners. Both UI controls and Agent calls enter Action
admission with the egress approval default. Missing owners, stale navigation and
cancellation refuse attachment; they do not select another view or composer.

`session.user_action.answer` is conversational
input: tokens need the Action grant, rather than `approve`. Other automation
callers outside those host Agent/MCP decision paths still need present-user
authority for these rows. In 0.3 development, Voice can propose a question answer
or rejection through the existing person approval flow. It remains Account
automation until the person approves; replay reaches the same question answer
owner and is attributed to the authenticated person. Waiving the prompt grants
no execution authority. `disposition: pass_up` remains an authenticated manager
disposition at that owner and does not use this Voice proposal path.
Discussion create, rename, archive, restore and private
read-state writes are Agent/MCP-requestable present-user Actions. They use the
same deferred approval and replay owner as other present-user Session intents;
waiving approval cannot grant automation present-user execution authority.
Read-state advances only the executing Account's private cursor. Discussion
reads remain safe automation Actions, and authored message posting retains its
separate dangerous approval default and visible Agent attribution.

In 0.3 development, Agent, MCP and trusted-plugin calls can request present-user
mutations, including
API-token creation, update (including embed configuration), revocation,
sign-out-everywhere and terminal-present-user policy changes. Requestability derives
from the Action's authority and custody metadata, not a mutation allowlist.
`resolveCredentialActionAdmissionV1` admits these requests into the existing Ask-first
flow; it does not grant execution authority. The single approval policy requests a
deferred approval Artifact by default. A surface waiver or explicit false policy
suppresses the request; the executor then refuses automation with `present_user_required`
before preparation or effects. API-token creation explicitly retains its blocking
invocation so the one-time bearer returns to the requester after human approval.
The signed-root CLI catalog admits token creation, access updates, inventory
and revocation. The API-token catalog still excludes token self-management.
Credential-bearing input is the other custody exception: the admitted
invocation remains the blocking waiter and the Artifact holds only its safe
preview. Authenticated approval or exact-daemon replay delivers human authority
through that existing live continuation, never through an Artifact field. A
detached raw-input invocation cannot be replayed from durable history.
Direct API-token mutations remain refused. `account.apiTokens.list`
and `account.security.get` are ordinary Agent/MCP-exposed reads.
The decision owner requires present-user authority before recording approval of any
present-user Action. For the built-in host Agent/MCP Account requests, the deciding app
reuses its authenticated Home adapter and existing execution claim, stamping the human
authority only on that approved replay. Other daemon-owned provenance stays on its
existing exact-daemon replay path.
The owner ruling of 2026-10-12 permits signed Agent-Session Account/client-only approvals
without a Machine/workspace effect to execute in the approving app after validation
of the original proposal, alongside eligible unsigned host-CLI Account approvals.
Eligibility uses the Action's input-aware placement, workspace
effect and input-custody metadata, not an Action-family allowlist. Signed
Agent-Session ingress remains immutable proposal provenance; its automation
carrier is neither upgraded nor spent on the effect. The app uses its authenticated
present-user Home adapter through the existing replay/CAS owner. Machine effects,
plugin provenance and live-only inputs retain exact-executor/live custody. Invitation
create/reissue links reach only the approving UI's `liveExecution` and existing
`TeamLinkDelivery`; Agent-facing results, observations and history retain only
the material-safe outcome. Repeated decisions read the settled outcome without
re-executing or revealing the link again.
Private replay also requires authenticated present-user RPC authority for every
human-mandated Action. An approved Artifact or its stored authority field is not
proof of a human decision.

Stored approval bodies project known fields recursively before header correspondence
and replay checks; strict Action and write admission are unchanged. Stored Board
failure details use the same request-bound family owner and keep known recovery
facts without preserving unknown detail fields.
In 0.3 development, approved `secrets.shared.delete` and
`home.accounts.delete` failures also retain their strict native managed-resource
review result, bound to the exact Action input and refusal code. Durable writes
reject unknown fields; stored readers discard extras while validating the known
resource identities and revisions. Other opaque failure bags remain excluded
from approval history. Retained review details are a request for fresh manual
responsibility consent, not proof that resources were deleted or authority to
retry without normal Action admission.

Session Actions include `session.delete` (the existing durable Session deletion;
the daemon owns managed-folder cleanup), `session.section.set` and `session.tags.set`
(the existing Session-organization assignment routes).

In 0.3 development, the canonical `session.delete` executor owns the bounded
Stop and Delete operation. It uses the existing Home DELETE first: inactive
Sessions delete without contacting their computer. Only the Home's typed
`session_active` refusal invokes the exact reviewed `session.stop` child; a
confirmed Stop permits one Delete retry. An incomplete Stop, failed Stop hold,
refusal, deferred review or cancellation prevents that retry. Stop Require is
included in the Delete review, and Agent requests retain their ordinary Action
policy. The host-local child declaration supplies the existing reviewed-child
issuer; it adds no caller operand, discovery field or second approval owner.
A person's confirmed Delete also confirms that declared Stop child, so the
operation does not ask again unless an explicit Require policy needs review.
Session Info and list menus use the same Delete operation; their Stop and Delete
wording does not decide whether a Stop runs. Inactive deletion, including an
offline computer, keeps the direct Home path.
Direct Home DELETE retains its inactive guard and typed absent/active/conflict
responses. Delete adds no separate liveness read.


In current 0.3 development,
ordinary `session.open` navigates without starting a process. Explicit `intent: 'resume'`
resumes through the same Action admission and exact-Home Session reader; durable
approval retains that intent rather than settling it as navigation. It also accepts
`approvedNewDirectoryCreation: true` as explicit fresh-folder recovery consent;
that arm requires present-user execution authority and asks for approval by default
on Agent/MCP. A waiver suppresses the request without granting human authority.
Exact-daemon replay accepts human authority only
from authenticated RPC context, never an Artifact body or caller-authored payload.
Ordinary open/resume remains safe, automatic wake/resume never infers consent, and
`SESSION_DIRECTORY_MISSING` stays a typed recovery outcome.

Requester credential disclosure is presentation in Share, approval and waiver
surfaces, not a second consent decision after Action admission. Selected launch
purposes name only the provider/native sign-ins actually materialized on the
target; previews never contain credential values or private credential paths.
Session and native Action delivery retain current Account and Machine custody
checks even when the caller has configured an approval waiver.

In unreleased 0.3 source, `session.sections.list/create/update/reorder/delete/archive`
and `session.section.set` expose Account sections through the existing organization
snapshot and folder mutation owners. A section belongs to one Account on one Home;
it can contain Sessions from different Projects and Machines without changing where
they execute. Public operands use `sectionId`. Persisted folder identities and the
existing folder HTTP DTOs keep `folderId`; the Action seam translates once. The
generated Action reference owns the exact schemas.

Names and icons remain private display content. The host seals `{name,icon}` for
the persisted Account encryption mode and opens it for authorized reads. Retained
0.2 folder displays and assignments remain readable; a locked display retains its
identity and membership. Update preserves omitted fields, and the folder record's
`sortKey` alone orders sections. Tag Actions keep their existing upsert contract.

Explicit reorder may normalize retained null, padded or duplicate order keys.
An opened sibling with no name, including a retained `display:null`, does not
block this order-only write: its original display, identity and parent fields
are preserved. It remains unavailable as a named Section; no title is invented.
Genuinely unreadable or mode-mismatched display evidence still prevents a repair
that would rewrite that definition. Stored readers ignore unknown fields;
fresh Action and mutation inputs remain closed.

Section removal uses the existing folder DELETE nonrecursively: only the named
definition is archived. Its own assignments and direct legacy children move to its
parent; at root, its own assignments clear. Child assignments and Sessions survive.
The historical `moveAssignmentsToParent` input literal is unchanged. A repeated
removal reports no removed definition or affected assignments. An older 0.2 Home
still performs its older recursive removal; a 0.3 client adds no alternate route
or negotiation for that operation.

Section organization and removal are safe Actions under the ordinary configurable
approval policy. Archive reads exact section assignment membership, including
unloaded Sessions, and invokes each member's existing `session.archive` policy.
Its result distinguishes archived, failed and unknown members. An acknowledged
assignment result includes captured previous membership for an inverse move;
unknown outcomes supply no Undo. Undo rechecks membership when activated and
preserves an intervening move. Public spawn placement also uses `sectionId`, mapped
at Action admission into the existing internal `folderId` birth placement before
Session creation; drafts, correspondence and replay retain that internal shape.

Class-H token-management and security rows remain excluded from public API
execution. Agent and MCP exposure is still authored per row; other class-H rows
remain off unless explicitly requestable through mandatory human approval. Ordinary
consequential Team mutations are class M, not class H: an Action does not acquire a present-user
requirement merely because it matters. Adding one is a product decision, not a safety reflex.

### Session permission answers

In 0.3 development, Agent and MCP callers use the existing host Action
`session.permission.respond`. The default requires approval before the answer
is delivered; an explicit waiver in shared Action settings allows direct
delivery. The Session permission RPC owner still checks authenticated access,
the current request and turn, and the answers/grants that request offers.
An unknown or stale request returns `permission_request_not_found`; an
unoffered response returns `permission_response_invalid` without settling the
request. No Agent-owned permission policy or decision store is introduced.

`session.permission.respond` stays excluded from trusted-plugin discovery and invocation
(`PLUGIN_SURFACE_EXCLUSION_REASONS`). A plugin's daemon code carries automation provenance, and that
provenance cannot stand in for the present user. The r0.42 plugin capability is a **mounted plugin
UI host method** instead, `respondToSessionPermission`, and it runs in the client realm while the
person acts in the plugin surface.

The host re-derives what it allows from the canonical owners:

- the request must be pending: `listPendingPermissionRequestsFromSession`;
- the viewer must be allowed to approve: `deriveTranscriptInteractionFromSession(...).canApprovePermissions`;
- the Agent's prompt protocol must offer the answer.

It then applies the answer through `answerSessionPermission`
(`apps/ui/sources/sync/ops/sessionPermissionAnswers.ts`), the same owner the Session's
`PermissionFooter` uses for Allow once, Always for this session and Deny. There is no second
decision path. Richer footer-only grants stay with the footer: all edits, shell sub-command rules,
exec-policy amendments and stop. The companion `readSession` and `watchSession` methods project the
Session awareness and pending-request owners (`components/plugins/surfaces/pluginSurfaceSessionState.ts`),
scoped to the mounted Account's own Session store.

## Approval is decided in one place

In unreleased 0.3 Plugin UI source, `Action.Control` binds a host-rendered control
to an Action reference and controller. Its button is physically owned by the mounted
host on native and hosted-web, including details panes. A press asks that controller
to freshly prepare one invocation; the host then executes it with `surface: 'ui'`,
`authority: 'present_user'` and a host caller. The plugin never receives that authority.
Its ordinary `executeAction` and `Action.Execute` requests remain plugin automation.
The canonical approval policy therefore keeps direct person-UI compute distinct from
Agent, MCP and raw plugin defaults, while explicit Settings Ask and setup consent
continue to apply. Allowing a Project preference does not run its command. Settlement
returns the existing Action envelope to the preparing controller; an uncertain
acceptance is never retried automatically. See [mounted host Action controls](plugin-platform.md#mounted-host-action-controls-03-development).

In 0.3 development, original CLI input requiring Machine admission, including
E2EE input, carries `actionRequestAttributionV1` in its protected request
before content sealing. The message producer uses the sending Account credential,
checked against the Home-admitted Account binding on routed sends. Machine
ownership never supplies the requesting person, including on shared Machines.
Conflicting requester, input or persona claims are refused before admission.
The receiver retains this fact in protected input authority for the Agent's
subsequent Actions; authored message metadata cannot supply it. Ordinary UI and
plaintext CLI sends keep their authenticated Account-receipt path. A routed
plaintext send requiring Machine admission carries the same attribution without
requiring Account encryption keys. Already-persisted input
without attribution remains unknown and fails closed when requester confirmation
is needed; there is no owner fallback or attribution backfill.

In 0.3 development, replay uses the approval's validated origin Session as its
contextual `defaultSessionId` when the proposal omits `sessionId`, including when
another Session is focused or another device approves. An explicit approved
operand wins, and resolved SessionTargets stay fixed to the reviewed selection.
This default grants no authority: replay still checks the approving person's
authority and current target access. The same origin rule supplies the
[Skills reach default](#session-origin-defaults-on-approval-replay).

An MCP Action's transcript origin keeps the native transcript call identity in
`toolCallId` and its connection-local JSON-RPC request identity separately in
`mcpRequestId`. In 0.3 development source, the Agent's existing tools capability
declares the optional `mcpToolCallIdMetaKey`: Codex declares `callId`, and Claude
Code declares `claudecode/toolUseId`. The host resolves only that declared `_meta`
field; the stdio bridge forwards metadata opaquely. Missing declarations or
missing/invalid values omit `toolCallId`, never substituting a JSON-RPC id.
The existing transcript matcher then requires the exact tool name, Action id,
Session scope and reviewed operands. It uses the canonical Action-payload reader
and the same contextual-input binding as execution, so an omitted current Session
is equivalent to its bound value, but an explicit different Session is not.
Only known originating context supplies defaults; an approved effect target is
not evidence of the originating Session's Machine or workspace.
It never matches on a tool name alone or stores another raw input copy. This
fallback cannot distinguish repeated calls with identical operands; native call
identity remains the precise path. Correlation selects presentation only and
does not authorize a decision or an effect.

### Session-local MCP confirmations (0.3 development)

An Agent calling an Action in its own Session can use the existing Session
user-action request when the Action declares a safe confirmation preview.
`session.terminalComposer.clear` declares only the target Session and optional
state timestamp; `session.pendingInput.interruptAndRun` also names the pending
input. Neither preview copies draft or prompt text. The host request store owns
the human decision and resumes the original MCP call. Denial returns
`approval_rejected`; cancellation returns `approval_canceled`, without running
the effect. Approval does not change the caller's authority.

The runner uses its existing bound Session RPC port for these effects. It needs
no Account bearer for its own Session; other targets retain normal credential
and scope admission. Account approval Artifacts remain the separate carrier for
Actions whose approval is not projected through this Session-local path.

### Memory search (0.3 development)

`memory.search` retains one Action spec and the existing daemon dependency. Its
existing MCP binding is `memory_search`; CLI/MCP exposure uses that same spec.
The CLI invocation is
`happier actions invoke memory.search --input-json '<input>'`. Session-bound tools
retain the current Session machine default, and standalone calls use explicit
machine/Home routing through shared Action admission and settings policy.

Project search uses `scope: {type: 'project', projectRef: {serverId, projectKey}}`
on that same Action. The exact daemon must advertise `projectSearchSupported: true`;
older peers return `memory_project_scope_unsupported` before a search is sent.
There is no global or Home-search fallback. Current Project/Source attachments
are searchable without a Session. Omitting `corpora` for this new scope searches
documents and Sessions; omission for global/Session scope remains transcript-only.
Matching Session membership is admitted before
ranking and paging; unrelated Account/Profile attachments are excluded. Optional
`project.state` is `ready`, `partial` or `unavailable`. Unknown Session membership
and requested native transcripts without a canonical Project witness cannot be
presented as complete coverage. Credentialless Session-bound MCP cannot use this scope.

The implemented query schema accepts `corpora: ['sessions', 'documents']`.
Omitting it for global/Session scope preserves transcript-only results. The implemented document-hit schema has `type: 'artifact'`, a
qualified doc reference, observed header/body revision and a facts/archive,
document, or named-topic `{type: 'topic', title}` location; these hits carry no transcript sequence numbers and cannot be
passed to `memory.get_window`. A document result must open through the
current library reader. The coverage schema admits optional `documents.state`
values `ready`, `partial`, `pending` or `unavailable`; an older response without the field
does not prove document coverage. The development deep-search path indexes admitted
memory and instruction documents, including all stored topics and archive facts.
It refreshes current attachment context and qualified document access/revision
before returning snippets. Incomplete admission and light search report document
coverage pending/unavailable without disclosing cached document text. UI and authenticated CLI
adapters negotiate document support with the exact daemon and use the shared
corpus policy to preserve Session matches on older peers without claiming
document coverage.

Credentialless per-Session MCP retains only that Session's transcript hits. It
has no Account document authority and filters document hits. Document coverage
is unavailable at that boundary; document-only requests return no matches without
invoking the daemon. Default deep keyword indexing is model-keyless
and embeddings remain opt-in. The independent `hints.enabled` switch defaults
false and is enforced by the worker; selecting hints enables it while preserving
a deep indexing choice. E2EE still needs real Account
material, while Plain Accounts need none. This is a development contract, not a
released availability claim.

### Prompt context preparation (0.3 development)

`resolvePromptStackSystemAppendBlocksV1` is the Protocol composition and
document-kind owner. It reads four already-admitted layers in order: Account →
the Session's own Profile → Source/Project → Session. Empty earlier layers do not
suppress later ones. The coding `resolveEffectiveCodingPromptPlan` places these
blocks after its base plan and before the existing Role/Notes block. CLI coding
and Voice adapters and the UI stack adapter use this same resolver; hosts supply
qualified Artifact reads rather than another parser or composer. Reference,
Account-mode and read-lifetime rules live in
[private prompt catalogs](encryption.md#private-prompt-catalogs-and-role-overrides-03-development).

Protocol selects enabled, non-suppressed entries before requesting an omitted
scope. An empty effective stack returns no blocks or admission facts without
reading Home credentials or Artifacts. A configured selection still fails closed
when its required scope or content cannot be prepared. The CLI's finite qualified
reader records only the failed operation, an allowlisted error code, HTTP status
when available, and Home/private-requester qualification booleans in file logs;
it never records document content, identifiers, URLs, credentials or raw errors.

The preparation read port returns header, body and header/body revision facts.
The current Protocol result is `{blocks, admittedEntries}`. Each admission fact
identifies `entryId`, `layer`, the admitted target `scope` and admitted `ref`,
with outcome `ready`, `valid-empty` or `unavailable`. Ready/valid-empty facts carry
the observed `{headerVersion, bodyVersion}` revision; unavailable facts carry a
reason and the observed revision when available, otherwise null. A valid-empty
fact records an empty rendered projection, not a missing document. Bound callers
supply their admitted Home/Account and applicable Session/Project/Profile target;
the resolver fills an omitted reference Home from that scope. Null scope is reserved
for the portable unbound read port, not inferred authority.

An optional definitively missing entry remains an unavailable admission fact even
when preparation succeeds without its block. This includes a qualified reference
whose saved Home profile is absent: the CLI reader reports `not_found` with its
typed `profile_missing` cause, and Protocol applies the entry's `required` policy
to both header-only and body reads. Required entries still fail closed; no other
Home's credentials are substituted. Missing preparation scope and transient
transport failures remain unavailable rather than proving absence.
Optional stack entries may be omitted only for `not_found`, with the existing
coding Session capability notice. Transient failures return `preparation_pending`;
locked/mode-mismatched, wrong-kind and malformed content return
`attachment_unavailable`, just as required entries do. Coding and bound Voice
share this decision. Existing accepted-input retention owns retry; preparation
does not turn failed reads into empty text or introduce another queue or timer.
Disabled or inherited-suppressed
entries are not admitted; intentionally memory-off entries are omitted too.
Typed preparation errors carry partial `admittedEntries`, including the failed
entry, but return no prepared blocks. Those facts are not a complete successful
inventory and cannot authorize content discovery. D4 consumers must re-prepare
and re-read qualified content through the same owner rather than treating this
result as a snapshot, cache, store or new access authority. Bound CLI/Home and
fresh-Session adapter integration is under focused validation, separate from
package and loaded-runtime completion.

With `memoryEnabled: false`, it first reads header-only inventory with
`includeBody: false`, skips `memory_doc.v1` before body loading, and continues
ordinary instruction documents and retained generic bundles. A required memory entry intentionally
suppressed by that choice is not a missing-document failure. Session
`disabledInheritedEntryIds` suppress matching Account/Profile/Project entry ids
before reads and never suppress an identically named Session entry. The switch
does not change upstream content or enabled state.

Skill-schema bundle attachments are retained as legacy data but no longer
contribute pasted instructions. The additive, once-only migration projects enabled
Account/Project entries into viewer-owned `skill-rules`, Profile entries into
`skillSeeds`, and Session entries into includes. Consumption is recorded in the
same destination CAS; removing a migrated rule does not recreate it. Retained
disabled inherited references still map to Session excludes. Voice skill entries
contribute nothing, while retained generic bundles keep their existing stack text
behavior. See [skill delivery ownership](runtime-core.md#session-path-and-owners).

In the current D47/D48 development contract, a nonempty memory block begins with
`Memory: ` followed by JSON containing `document` (the admitted header title),
`layer` (`account`, `profile`, `project` or `session`) and the admitted `ref`.
This label identifies the block's source; it grants no access. The resolver uses
D3's canonical `renderMemoryDocV1` adapter unchanged: only active, unexpired index
facts and topic titles/one-line summaries enter the always-loaded text. Fact lines
retain their `id:` key and available provenance. Topic detail and archive fact text
do not enter that block. This is a rendering projection, not a separate Artifact
transport or a promise that the stored body contains only the index.

An entry's optional `maxChars` budgets complete index fact/topic-summary entries,
not the source label, and never truncates a memory fact mid-entry. An unset budget
loads the complete eligible index without an invented default cap. The current
body shape is `{v: 1, index, topics: [{title, summary, facts}]}`. Its stored adapter
preserves already-written `facts`/`archive` documents as index/archive-topic content
and reads index-only documents as having no topics; current writes use index/topics.

Valid empty Markdown succeeds. After current Account admission, optional entries
skip unavailable, missing, wrong-kind, malformed or locked content and coding
Sessions publish the existing typed Prompt library notice. Required missing,
wrong-kind, malformed or locked entries return `attachment_unavailable`;
transient required reads return `preparation_pending`, leaving retention and
retry to the existing accepted-input owner. Account admission and cancellation
still refuse preparation rather than treating unknown selections as optional.
This is the current development-source behavior. New Session attachment intents
admit `system_append`; this operation
restriction does not narrow the stored placement schema or discard retained
skill, composer-insert or provider-asset entries.

`session.instructions.set` maps to the registered `intent.context` writer. It
sets the enabled, required `session.instructions` entry in `work.promptStack`,
or detaches that entry when `ref` is null. The shared writer preserves other
entries, Role/Notes and unrelated metadata; detaching never deletes the Artifact.
Its `expectedMetadataRevision` records the observed Session metadata version,
separate from the document's header/body revision; unrelated runtime changes
are rebased by the field-scoped writer described below.
The reserved entry requires a `prompt_doc.v2` header at shared admission and
preparation. A retained wrong-kind entry returns `attachment_unavailable` for
repair, including when memory is disabled; ordinary memory entries elsewhere
remain eligible under the existing memory setting.

Each supported preparation reads current qualified Artifact content, deduplicating
references only within that preparation. A later preparation rechecks both present
and previously absent documents. A cached display copy is not preparation
authority. An edit applies at the next supported coding preparation or bound Voice
preparation; it does not replace instructions in an already-prepared active turn
or Voice attempt. Carrier delivery remains subject to the modality's existing
startup/resume contract and its integration evidence.

The coding Session producer resolves its current workspace/Project association
through `resolveSessionProjectPromptStack`. For a Source-backed Project, the third
layer contains only shared Source attachments marked `context`; otherwise it
contains the personal Project stack. The private Project row is retained but does
not mirror or append to that Source layer. Dashboard attachments are not prompt
context. An unavailable association or
Source stays pending rather than silently dropping that layer. Spawned workers
prepare their own Account, own Profile and associated Source/Project layers, not
the Lead's Session instructions or inherited-entry suppression. A same-Account
worker inherits the Lead's Session memory attachments and current memory choice
at birth; an explicit worker memory choice takes precedence. Only `memory_doc.v1`
attachments are copied, not document bodies, Bot identity or Role memory pointers.
The copied qualified references read current approved facts at later supported
preparations. Rejoining a created worker does not rewrite its birth Context.
An explicitly selected
worker Profile is forwarded at launch and persisted after replay/source overlays.

Memory defaults apply only at creation: ordinary Sessions default off and Bots
default on, unless creation supplies an explicit choice. Account Settings Actions
address these preferences through `prompts.memoryUseInNewSessions` and
`prompts.memoryUseInNewBots`. Changing them does not rewrite existing Sessions'
choices. Retained Sessions without a stored choice use their Session-kind baseline.

Registered Session Context, Instructions, memory and voice-preference Actions
apply their semantic intent through the existing retrying metadata owner. Their
`expectedMetadataRevision` identifies the caller's observation; it does not pin
the whole tuple against unrelated runtime updates. The shared registered-field
updater captures that field's value on its first owner read, reapplies the intent
to refreshed metadata after a tuple conflict, and returns `conflict` if the same
field changed during the write. It preserves concurrent values in other fields.
Context's basis includes its ordered Session stack and inherited-entry suppression;
memory and voice each compare their own effective choice. Changes preceding the
first owner read are part of the current state to which the intent applies.

Attachment admission still uses the qualified header/document-kind owner from
preparation and preserves typed `attachment_unavailable` failures. A refused
attachment retains a newly created reusable document and the editor's draft.
The lower-level explicitly revision-pinned tuple API and retained CLI durable
mutation custody keep their strict revision contract; the semantic Actions do
not pass that whole-revision precondition. Composed loaded-runtime verification
remains separate from source-level Action tests.

These are landed, unreleased source contracts, not package or loaded-runtime
completion evidence. The visual Project Context and Session Work editors remain
deferred to the UI lane; their absence does not add another composition owner.

### Reviewed prompt-document updates (0.3 development)

Prompt shortcut authoring uses `prompts.invocation.create`,
`prompts.invocation.update` and `prompts.invocation.delete` through
the answering client's existing invocations catalog owner. UI, Agent, MCP and CLI
share these Actions. Read `prompts.invocations.list` for each shortcut's target and
the catalog revision; update/delete require that original `expectedRevision` and
return a conflict without retrying when it changed. The Template editor consumes
the same admitted operations. Deletion removes the shortcut while retaining its
prompt document, and its confirmation belongs to the Action policy.

`prompt_doc.get` returns the actual Artifact revision
`{headerVersion, bodyVersion}` with its current title and Markdown.
Its optional `provenance.savedBy` projects only the opened private revision's
person or Agent/Session identity. Workspace source paths and restore metadata
remain outside this Action's result. Missing revision attribution stays unknown.
`prompt_doc.update` accepts that read's optional `expectedRevision`.
`updatePromptDocInLibrary` compares both versions against its fresh read before
constructing the mutation. A changed review basis returns `version_mismatch`
without rebasing the approved edit. The existing Artifact CAS still checks that
fresh read's revision at write time, catching a competing write during execution.
Callers without a reviewed revision retain that execute-time CAS; they do not gain
a guarantee that a prior preview remains current.

Prompt-document writes use ordinary Action approval: dangerous automation defaults
to Ask first, with explicit settings for that Action and exact invocation surface.
A surface waiver affects every Session using that Action on that surface, not one
Bot or document. Document annotations and Session instructions grant no edit or
approval authority. Agent, MCP, CLI and eligible Voice projections consume the
same specs and policy; authenticated human authority decides required approvals.
An approval decision is not a saved-content receipt: the mutation result determines
whether the write succeeded or conflicted. The Work editor and its retained-draft
review UI remain development integration work.

The Instructions detail read model consumes that same revision attribution and
the Session's existing approval receipts. An authenticated approving Account is
shown only when an executed `prompt_doc.update` receipt names this exact document
and accepted body version. A later body edit cannot inherit that approval, and
a denied edit leaves the previous body and its provenance intact. Pending,
updated, denied, conflicted, canceled and failed results come from the existing
approval lifecycle; the diff read model exposes the same outcome for its result
surface. The detail hydrates only this Action's receipts. A foreign-Home document
keeps its own private revision actor but cannot borrow a same-id receipt from the
Session's Home. Names remain display projections of admitted identities, never
inferred from timestamps, titles or the Account currently viewing the page.

### Memory documents (0.3 development)

Each scope's `memory_doc.v1` is one ordinary Account Artifact, using the existing
encryption, grants, public-link and revision-checked write owners. Its canonical
body is `{v:1,index,topics}`: key facts in the always-loaded index, plus named
topics with a title, one-line summary and on-demand facts. Archive is one topic,
not another Artifact or grant. Stored flat `facts`/`archive` and index-only bodies
normalize at the canonical reader; writers use only the current shape.
`memory.read` returns the active index and topic summaries with its header/body
revision, or only the named section when `topic` is supplied. `memory.list`
pages the existing Artifact inventory and preserves its coverage and continuation.
Document-targeted `memory.remember`, `memory.update` and `memory.forget` require
a reviewed Artifact revision and accept optional `topic`. Remember reviews active facts before insertion; update identifies the fact
by id and names its destination (omission means index); forget selects that
section (omission means index). Topic detail stays in the same Artifact.
Updating archives the prior fact and records a supersedes link; forgetting archives
the fact. Undo uses `memory.update` with `topic: 'archive'`, the original `factId`,
and `restore: true`; optional `restoreTopic` names its destination (omission means
index). Restore moves the archived fact unchanged, preserving its identity, text,
dates and provenance, and refuses a fact still referenced by a replacement.
Neither operation erases searchable history. Fact identities, dates and source
Session references are host-derived, and the existing redaction owner scrubs text
before approval custody and before persistence.
Both a stale reviewed revision and a write-time CAS conflict return the currently
readable canonical version in the failure envelope's `details.current`, without rebasing or retrying.
Revoked access or unavailable encryption material refuses without disclosing it.

The shared approval policy admits private writes by default and asks for writes
exposed to another Account, a Team or a public link. Explicit Require and Waive
settings retain their meaning. Unavailable exposure facts refuse rather than imply
privacy, and a newly shared document invalidates previously admitted private work
before its write.

Semantic insertions, including archive restoration, return
`memory_duplicate_choice_required` when the admitted document contains exact or
lexically related active facts. The candidate owner is
`prompts/library/memoryFactCandidatesV1.ts`: exact comparison normalizes Unicode,
whitespace and case; a related candidate requires at least two distinct shared
meaningful tokens from `memory/memorySearchText.ts`. Single characters and English
function stop-words are ignored for candidate review; CJK bigrams remain eligible.
One shared word alone does not interrupt saving. This filter leaves recall/search
tokenization unchanged. The result names that document, its full revision
and possible candidates. Resubmit `duplicateChoice` with that revision: Update or
Replace a selected `factId`, or explicitly Keep both. Update/Replace archive the
selected fact through the existing history owner. A stale choice refuses; it
never rebases or searches another scope for candidates.

Update corrects the selected fact; Replace makes the incoming fact supersede it;
Keep both leaves the saved fact active and adds the incoming fact. When editing
one fact into another candidate, Update corrects that candidate in its existing
topic and archives both prior versions; Replace uses the incoming edit's destination.
Changed wording never inherits an old person's approval.

`memory.decision.save` uses the same targets, duplicate review, lazy attachment
and approval policy, adding `reason` and an exact `sourceMessageRef` from the
canonical Session/Discussion union. The fact stores `decision` with that reason,
source and host-derived `approvedBy`, or null when no person approval was
witnessed. `approvedBy` is not an input. Direct present-person saves use the
authenticated caller; authenticated approved replay retains the deciding
Account and decision time. A waiver, agent invocation or bare bypass never
creates human approval. Expiry-only renewal preserves approval for unchanged
wording; changed wording clears it or records a newly witnessed save.
The server checks the exact committed source and source-to-Artifact disclosure
at the write boundary. Discussion sources use the same exact, access- and
Doc-source-aware reader as Discussion reads; the destination audience must be
allowed to read the source. Unavailable/revoked sources refuse without writing.
Saved source links grant no transcript access. Prompt preparation still
loads the index only; source, reason and topic details are read on demand.

Expiry is Never (no `expiresAtMs`) or a date (`expiresAtMs` in epoch milliseconds).
`memory.update` accepts `null` to clear a date. Expired facts leave prepared prompt
context but remain stored and searchable; expiry does not delete history.

An agent's memory proposal uses `approval.request.create` with
`actionId: 'memory.remember'` or `'memory.decision.save'`. The existing Inbox approval request retains the
reviewed target and revision; creating the proposal does not write a fact.
Human approval replays the same Context remember owner, which still checks the
reviewed revision and current exposure. This proposal path is distinct from a
private direct remember admitted by the policy above; neither path adds a Role
memory pointer or another memory store.

The first `memory.remember` may instead name a qualified Session and reviewed
metadata revision. This Session-targeted form requires the Session's current memory
choice to be on; an off choice refuses before document reads or creation.
The Session target is an exact owner view in the captured Account/Home, not any
readable recipient metadata view. Clients refuse an unavailable owner proof with
`session_target_unavailable` before reading private Project context; a published
Session Project key does not grant that authority. Released layout-zero owner
projections remain usable through the canonical access normalizer. Direct
document-targeted memory continues to use its separate Artifact access contract.
Unrelated Session metadata revisions do not invalidate admission: the owner
rechecks the memory choice and selected target, while the reviewed document
revision and approval target remain strict. A Bot
uses its own memory, lazily attaching reserved `session.memory` through the
registered Session context writer. An ordinary Session uses existing Project
memory, otherwise Account memory; missing Account memory is lazily attached to
the existing Account coding row. Ordinary Sessions do not create Session-only
memory by default. An explicit document ref selects another admitted target.
Without a Session, `memory.remember` accepts `{ scope: 'account', text, topic? }`
or `{ scope: 'project', projectRef: { serverId, projectKey }, text, topic? }`.
These forms resolve the same scope attachment, lazily create its single memory
Artifact when missing, and retain the existing scope row/Source revision writer.
Private scope writes are silent by default; a shared Project scope asks first,
including before creating and attaching its first document. Attachment does not
grant access; deliberate sharing remains the existing Artifact grant operation.
Approval preparation binds the selected document and Artifact revision in the
Session and explicit-scope forms' `reviewedTarget` (or `null` for a not-yet-created scope document).
Both automatic and explicit approval requests retain that target. Replay rechecks
the current Session choice and selected scope, refuses a changed target, and uses
the original revision rather than silently rebasing; unbound Session or scope approvals
fail stale.
A failed attachment preserves
the fact and returns the created document reference. Its retained
`attachment: 'conflict'` receipt means the document is saved but attachment was
not confirmed; an optional strict `attachmentFailure.errorCode` distinguishes
an unavailable or denied attachment from a revision conflict. For example, an
explicit Home transaction-conflict exhaustion is `source_backend_unavailable`,
not evidence that the memory document changed. UI receipt classification keeps
this `saved_unattached` outcome separate from an unsaved write conflict.
Recovery attaches that
known reference through the existing scope context writer at a fresh reviewed
revision, then resumes remember against the actual attachment; it must not blindly
repeat document creation or replace a competing attachment. Opening,
enabling or preparing context does not create memory. Later remembers reuse the
attached document. `migrateRetainedSessionWorkContextV1` moves a retained
`sessionRolesV1.memoryDocRef` into the Session stack as
`session.legacy-role-memory` and removes the pointer. It preserves the existing
Markdown document reference without converting its content into `memory_doc.v1`.
An existing reserved entry with a different reference returns `entry_conflict`.
Role configuration writes reject new pointers; Role/Notes remain with their
existing owner.

When Session memory is off, its native Agent/MCP tools and discovery omit the three
write Actions, and generic dispatch uses the same live availability predicate.
Standalone Account calls remain governed by Account Action policy. Prompt rendering
budgets complete active index fact lines and topic title/summary lines within the
entry's optional `maxChars`, never topic detail. Each fact line includes `id:` and
host provenance/date metadata. Memory is framed as potentially outdated data,
not instructions; topic detail is read on demand. Archive reads include expired
facts without rewriting storage. Upkeep keeps the index short, moves detail into
topics and merges duplicates through these same reviewed Actions. These contracts are
development source, not a released or loaded-runtime certification claim.

Skill-bundle edits also carry both Artifact versions from the read used to derive
the update. A concurrent edit returns a `version_mismatch` conflict and preserves
the winning content; encryption-key recovery cannot replace the captured revision
with a newer one. Reviewed prompt-document updates are described above.

### Shared approval routing

`resolveActionApprovalRouting` is the single approval decision. It answers three things —
whether approval is `required`, which `flow` carries it, and what `result` custody applies — and
every host consumes that answer rather than re-deriving one.

The required-ness comes from Action Settings when they are present, and otherwise from the
default floor. `safety: 'danger'` rows are picked up automatically from
the safety declaration, and a short explicit list of non-danger *egress-sensitive* leaves
(`EGRESS_SENSITIVE_AGENT_FLOOR` — page/region/element captures, network and console summaries,
composer and agent-turn attachment, public-preview status and URL copy) is floored on the `agent`
surface because those egress page content into a turn even though they mutate nothing. That list
is reserved for non-danger egress leaves; mutating, navigating and dangerous verbs must never be
hand-added to it, because they are already classified `danger` in the specs and derived from
there.

Safe browser/native controller transitions and native target selection use
`SURFACE_AUTHORITY_AGENT_FLOOR` in the same policy owner. This explicit approval default
is separate from danger and egress classification; it is waivable per Action, while
human control routes carry verified RPC authority and request cancellation to the
existing Browser/Computer owner; omitted authority defaults to automation.
Browser focus shares navigation's input controller and confidentiality drain.
Already-cancelled Browser commands, including controller transitions, return a
known no-effect failure before reaching control or CDP effects.

In 0.3 development, a present user's UI invocation consumes the same declaration-owned
approval policy as other callers. Reversible UI intents declare `uiConfirmation: 'direct'`;
irreversible effects retain the policy confirmation. A dangerous Action without a direct
UI declaration also asks by default. The executor owns that decision and its confirmation
host; a caller must not put another yes/no dialog or two-step button before the same Action.
Dialogs that collect a different scope, choose recovery after a refusal, or discard an unsent
local draft remain separate decisions.

In unreleased 0.3 source, Action confirmation presentation has two independent
declaration fields. `confirmVerb` is a short literal phrase or the existing
localized-string shape `{ key, fallback }`; omission uses the host's localized
“Approve”. `irreversible: true` declares that the effect cannot be undone;
omission is not irreversible. The confirmation button and its destructive note
read that fact directly, never infer it from `sideEffectClass` or
`approvalPolicy.uiConfirmation`. Neither field changes who approves, whether
approval is required, or the person's approval settings. Plugin Action
declarations and the strict daemon Action projection carry the same optional
fields, resolving plugin keys through the plugin's admitted translation bundle.

An actual completed host confirmation can supply `presentUserConfirmation` for that exact
Action on UI or CLI; opening a form or pressing its ordinary submit button is not a completed
policy confirmation. Explicit per-surface Ask settings still win, and waivers suppress the
default for waivable Actions. Contextual safety uses that same policy and preserves these
overrides; it does not grant execution authority. The executor supplies contextual safety
after input admission, never from a caller's assertion that a target is private.

In 0.3 development, `workflow.trigger.add`, `workflow.trigger.update` and
`workflow.trigger.remove` use the shared dangerous-Action approval default on
Agent/MCP. Persisted surface waivers suppress approval, explicit Ask-first wins,
and a host's resolved policy is consumed once. Agent add/update also needs the
materialized `trigger_write` policy check; approval never supplies that authority.
The host-stamped approved continuation executes under that original request rather
than creating a second approval.

Development FIN placement: the nine `workflow.trigger.*` and `session.trigger.*`
Actions are Account data on the Automation owner. Every Account host composes the one
Protocol trigger owner through `createAccountWorkflowTriggerActions` (CLI with its
credentials, the UI front door with its captured Account), so Account-owned trigger data
does not require a reachable Machine. Host-dependent facts do reach a Machine:
another caller's write (agent-start policy and materializer) is relayed to the
authorized host, and Keep going on an opened Session reads native-goal ownership over
that Session's `session.goal.get`. An unreachable host yields typed `target_unavailable`.

In unreleased 0.3 source, New's managed Workflow continuation acquires and enrolls
the reviewed Machine through the existing managed-creation owner, then admits the
durable Workflow Run through the existing Run owner. Only an accepted Run can
become the `workflow_run` source of its creation-scoped FIN rule. Keep writes no
rule; Stop/Delete use the existing controller-pinned, after-idle managed Action
binding. An incomplete binding retains that accepted Run for repair within the
current composer instead of admitting another task. Finite Action operation ids
are never task-finish identities. Workflow composer progress-badge pass-through
and task-specific scope-choice labels remain UI integration work; this source
continuation alone does not make that choice reachable in the rendered workflow
composer.

Development Session-trigger admission: the Protocol trigger owner uses
`resolveActionAgentStartContextV1` and `admitAgentStartV1`, not captured subtree
membership. Foreign Session access is re-proved after awaited preparation and
private-trigger encoding, before Automation or PR-binding writes and before
returning scoped results, including
Session-scoped rows in an Account-wide trigger list. Own-Session access remains
valid; an originless firing Run may only remove its exact Session/trigger pair,
whose Run correspondence is rechecked before removal. That capability does not
admit other trigger reads or writes.

Session PR-comment and CI-failed definitions use native `prComment` / `ciFailed`
arms, not generic plugin Events. Their private PR selection uses the existing
revision-bound Automation definition envelope. Channels owns the Session↔PR link
and the trigger-specific binding; list and attachment therefore need the Session's
authorized Machine even when the Session is closed. An unavailable binding reader
must not fabricate an empty link list. Removing a trigger retires its scoped binding
without discarding the Session's PR link.

The GitHub checks source projects one rollup into `checksCompleted`, `checksFailed`
and `checksPassed` events. The scoped `ciFailed` adapter consumes that same
`checksFailed` projection, rather than emitting a separate occurrence for each
failed job. The PR-checks wait reads the source's checkpoint snapshot; it adds no
independent checks reader or polling loop. Transport cursors remain separate from
the shared checks-event identity.

Scoped observations carry explicit binding, Session, trigger and its current revision, PR and authenticated
actor correspondence into Conversation admission. Only measured repository write
access admits a Run; false, unknown and mismatched evidence have typed refusals.
The same public host-evidence carrier accompanies E2EE sealed occurrence content,
so the server never has to interpret encrypted sender data. Scoped conversation
causes retain `triggerId` and reuse the existing trigger lock and pending-occurrence
coalescing owner; they do not create a second watcher, permission reader or link store.
These are 0.3 development contracts, not evidence of released availability.

The flow is `deferred` when the caller cannot hold a blocking waiter: the public Action API, which
reports a created approval artifact to its caller, and the present-user UI, whose mounted
continuation follows the artifact and consumes the replayed typed result. In 0.3 development,
CLI invocations also return `approval_request_created` with the Artifact id before exiting;
they do not silently retain the daemon HTTP request while waiting for a human decision.
Explicit `approval.request.create` uses the same surface and custody policy for its
target Action; an ordinary CLI/UI proposal can therefore execute after the requesting
invocation ends. Live-only input remains ineligible for explicit durable creation,
and live-only result custody retains its existing continuation requirement.
The operation has not executed when that result returns. In development source,
the mounted experimental Provider-model confirmation retains its exact invocation
through the existing blocking approval owner. Changing its Agent target, Home,
Account or Providers feature while approval is pending retires that intent. A later
Inbox approval cannot replay the retired field intent; the canonical executor
returns `approval_stale`. The shared approval policy still owns waivers, and a
successful live approval writes the confirmation once.

Ordinary approved results stay schema-complete in the private approval Artifact,
including blocking Session/MCP calls whose effect runs on the approving app.
The original waiter consumes that private receipt. Public approval reads,
decisions and Action observations independently apply the Action's observation
projection; those redacted views are not caller receipts. This is a 0.3
development contract, not a claim about released availability.

The result-custody exception is
`approvalResultCustody: 'live_only'`, where the exact invocation stays the blocking waiter because
its raw result must never become durable artifact custody; such a row must declare both a required
result and a safe observation projection, which the spec schema enforces. Three rows declare it for
a show-once bearer:

- `teams.credentials.externalKeys.create`. Its result is `{ token, key }`. The bearer token
  reaches only the live caller, and the observation projection keeps just the non-secret `key`
  summary for the artifact.
- `account.apiTokens.create`. The API token is shown once and stored only as a digest, so like
  the external key it stays on the admitted invocation and never enters approval history.
  In current 0.3 development, Agent/MCP creation also retains that blocking
  invocation. The approving app sends its authenticated decision to the existing
  exact-daemon replay owner, which resumes the original waiter; the bearer goes
  only to that requesting caller. Approval history, observers and repeat decisions
  receive only the non-secret summary. For signed Session requests, the exact
  daemon replay owner privately retains the deciding human's admitted Account
  context for the approved token effect, bound to the Artifact, original request,
  reviewed input, Account, Home and Machine. This is a one-shot live continuation,
  not an upgrade of the Session root or use of the daemon's ambient credentials;
  cancellation/currentness checks fail closed and release retained custody.
  Approved execution rechecks current Action availability and policy before
  invoking that retained native port.
  Native Session transcript normalization retains the correlated built-in
  Action's observation projection and applies it before normalization and
  Account-mode sealing. Both displayed output and `_raw` contain that safe
  projection; the live native tool response still belongs to the requester.
  A later read of redacted history cannot recover that one-time receipt.
  Encryption access remains a trusted-device
  UI/interactive-CLI operation: automated creation with `encryption` returns
  `api_token_encryption_not_ready` before an approval or effect. The deciding app
  cannot prepare a compound credential for this requester using the existing
  decision-only continuation, so no wrapping secret or new secret store is added.
- `plugin.webhook.endpoint.ensure`. In 0.3 development, Agent/MCP can request endpoint
  setup, with present-user execution authority and a user-waivable approval default.
  A waived automated request returns `present_user_required` without creating an
  approval Artifact or endpoint. An ordinary requester receives an approval Artifact reference; only
  the deciding human's fresh `liveExecution` can contain `oneTimeGeneratedSecret`.
  Observers, approval history and repeat decisions retain only endpoint id, revision,
  public URL and readiness. `plugin.webhook.endpoint.read` is also discoverable on
  Agent/MCP and keeps present-user authority; it never returns a credential.
  Plugin-provenance-only correspondence and target convergence are not Agent/MCP
  operations. Existing direct setup retains its live result; lost disclosure uses
  the existing Webhooks credential-rotation flow, not another endpoint or secret store.

For a present-user invocation, these rows retain the blocking result rather than
durable raw-result custody. API-token creation explicitly keeps that same custody
for Agent/MCP requests. Other Agent/MCP present-user requests remain deferred and
return their Artifact reference; only the deciding human receives fresh live custody.
If the live invocation is lost, the secret is intentionally unrecoverable: revoke or
rotate it through the existing credential owner.

Public `approval.request.get` output omits signed execution authorizations,
signed-input proofs and original invocation envelopes. CLI, MCP, Agent and UI
Action reads share that projection; generic Artifact Actions reject approval
documents as internal. Authenticated Account/terminal Artifact storage remains
the private replay transport. Direct API-token and restricted Session-runner
credentials cannot use that raw transport. A keyholder who deliberately exports
or grants access to a private Artifact can still disclose its raw contents.

The execution authorization has no fixed expiry. Approval settlement does not
invalidate its signature: spending it also requires the exact Machine signature,
current credentials and current source authority. The approval execution claim
prevents a repeated decision from executing the effect twice. An authorization
copied from a transcript alone cannot supply that Machine proof.

`approvalInputCustody: 'live_only'` is the input-side sibling, used for credential-bearing input
such as passwords. The artifact carries only the declared input projection from creation, and a
replay without the live invocation fails closed. CLI rows with either live-only custody declaration
retain their blocking invocation; Agent and MCP blocking callers are unchanged.
In 0.3 development, deciding a request whose live input invocation has ended settles
the Artifact as `failed`, with `approval_stale`, reason `live_invocation_unavailable`
and `effectAttempted: false`. The Approve Action returns that typed refusal, including
on repeat decisions; the requester and Inbox can read the same terminal receipt.
Re-run the original Action to supply fresh live inputs. An attached caller instead
executes once with its retained input and receives its terminal result. Approval
history never acquires the omitted inputs, and durable-input replay is unchanged.

The development personal Saved Secret `secrets.create` and `secrets.update`
Actions use this live-only input custody when carrying a value. Their observation
projection omits the value. Present-user UI writes act directly, while Agent,
CLI and MCP writes ask through the shared spec-owned policy. `secrets.list`
returns owned resource metadata only; create returns its canonical resource ref.
The `updatedAt`/`expectedUpdatedAt` fields on these Actions are aliases for the
private resource's revision concurrency token, not wall-clock timestamps.
The existing encrypted/plain private-resource mutation owner remains the writer;
these Actions do not recreate the retired Account Settings secret writer.

In 0.3 development, `requiresExactDaemonApprovalReplay` is the shared replay-custody
owner. An unsigned host-CLI request for any Account-placed Action with durable
(`approvalInputCustody !== 'live_only'`) input and no Machine/workspace effect is replayed by the approving app
through its authenticated Home adapter, using the exact reviewed input. Placement
is resolved by the Action spec from that input, not just its default placement. Replay
preserves the original provenance on the Artifact and rechecks current policy,
Home/Account identity and access. The approving app executes the reviewed Account
effect as a fresh present-user invocation. Eligible signed Agent-Session Account
requests use this same app-owned effect after validating their original
installation signature, Action id, input and requester. That signed automation
carrier remains immutable provenance, not effect authority. Profile Actions retain
their declared authority; this custody rule does not make them mandatory present-user
Actions. Schema-admitted client effects requested from UI, Voice, Agent or MCP by
a host or Session also replay in the approving app's mounted owner. This includes
Voice unmute: the requesting Session's Machine does not own the client's microphone.
Signed Account-admitted Session proposals for client effects retain the same
signature verification and human replay authority. Plugin callers,
Machine/client-placed CLI Actions and live-only inputs retain
exact-daemon custody.
The existing host Account-effect eligibility remains with the same owner;
Home continuation uses the shared client-placement rule. The app does not classify
families independently.

In 0.3 development, approval Artifact bodies are private replay custody. A signed
external request retains `executionOriginV1.externalActionExecutionAuthorization`
and its input signature where required; the Home authorization is bound to the
original request and requires the selected Machine's signature and current Home
admission. It is not an Account login bearer. Installation-sealed requester
context, when present, remains private custody on that carrier.

The shared Artifact kind owner directs all three approval families to the existing
Inbox presenter. Direct Artifact and edit links use that same destination, with
the portable Home identity preferred over a device-local profile id. Generic
Document and revision-preview readers refuse approval bodies; body-derived header
excerpts are omitted by the shared writer. Retained excerpts are not used for
approval previews. Dedicated approval readers still open and validate the complete
request for decisions and exact-origin replay. People sharing, public publication,
ordinary Artifact search/list and export remain denied by the existing kind policy.

Approval Actions themselves (`approval.request.*`) are never approval-gated, which is
what prevents the obvious loop.

Plugin-contributed Actions follow the same split between present and non-present requesters, with
one owner per side. For a `ui` or `voice` invocation the UI dispatcher
(`apps/ui/sources/components/plugins/surfaces/pluginSurfaceActionDispatch.ts`) is the only place
that asks: it applies the shared requirement rule (`pluginActionRequiresPresentUserIntent`, which
covers the manifest default and the Account's invoking-surface approval setting), shows
the app-shell confirmation, and only then executes. A client-target Action runs through the shared
present-user gate in the UI. A daemon-target Action is sent with `presentUserIntent: 'confirmed'`
on `daemon.plugins.structuredMessages.actions.execute`. The daemon's gate admits that carried
intent and creates no `plugin_target_action` approval artifact. A UI or Voice request without it fails closed
with `plugin_action_current_intent_unavailable`, so a settings skew between UI and daemon refuses
rather than executes when approval is required. An explicit waiver is carried as `false`, not
absence: it overrides the non-safe/declared-confirmation default without changing the Action's
danger metadata. Explicit Ask-first remains required even for safe Actions; missing settings use
the manifest default and a failed settings read cannot waive approval. Catalog policy delegates
to that same requirement rule, with no trusted invocation surface inferred from a catalog read.
Durable `plugin_target_action` artifacts remain only for requesters that are
not present in the app: agent, MCP, CLI, the public API and automation ingresses.

In current 0.3 development, confirmation metadata is independent of effect
classification. A sensitive read can retain `dangerLevel: 'safe'` and declare
confirmation; canonical manifest admission accepts it, and the same policy uses
that confirmation as a default approval reason. Non-safe Actions still require
confirmation metadata on the applicable surfaces.

For widget moves in 0.3 development, the executor retains the source and destination
`isShared` facts from the Artifact reads that admit edit access; Home is private.
A proven private-to-shared move supplies a contextual confirmation default to the
same Actions policy owner. Persisted waivers and explicit Ask settings still apply.
Reversible moves without that widening retain their declaration's direct default,
including ordinary edits on shared surfaces; different-Session Board moves retain
their spec-declared confirmation. Two shared flags do not establish identical reader sets.

In the unreleased 0.3 Plugin UI contract, `hostApi.confirm(message, { action })` binds a direct
UI mutation to a contributed Action reference and applies this same policy before its existing
domain writer. A waiver returns `true` without opening a dialog; a required decision uses the
existing cancellable app-shell interaction. Missing declaration/policy refuses the operation.
This requires no daemon handler or daemon connectivity. Without `action`, `confirm` remains an
ordinary unconditional plugin-local question. Triage source removal and direct fix-PR link/unlink
use this Action-bound form; their Account writers and encryption/collection ownership do not move.

A settled artifact keeps only the declared input projection. The admitted `actionArgs` stay
immutable while the request is `open`, `approved` and `executing`, because deferred replay reads
them. On the transition into a settled state (`rejected`, `canceled`, `executed` or `failed`, which
includes a failure before execution), they are replaced by the Action's own
`projectObservationInput`, never by caller-authored arguments. One owner decides this:
`packages/protocol/src/approvals/approvalRequestTransition.ts` (`decideApprovalRequestTransition`,
`settleApprovalRequestActionArgs`). Both artifact writers consume it, the CLI/daemon approval store
and the UI approval writer, and each commits with the revision it read. Only the winner of
`approved -> executing` performs the effect.

If the effect runs but its terminal Artifact write throws or is refused, including
a CAS conflict, ordinary replay returns `approval_execution_outcome_unknown` and
leaves the durable claim non-replayable. A separately observed effect, such as a
service process stopping, does not prove that approval history settled and must
not trigger a blind retry of an executing approval.

## Completion after an execution-run launch

Development-only: `ActionSpec.completion` declares whether a waiting host must
observe launched execution runs before treating an invocation as complete.
It leaves the Action's immediate output contract unchanged. The generic owner
in `actions/actionCompletion.ts` prepares the immediate output and exact
`awaitedRuns` for persistence before observation. The host then resumes through
the execution-run observation boundary; it does not poll another Action.

Only the `awaits` marker and terminal JSON schema belong in an accepted contract.
The pure `launched` and `terminal` functions stay host-private. Resume resolves
the current declaration by the retained Action id and checks its launch
correspondence. Missing declarations, unreadable state and changed run identities
return `outcome_uncertain`, never another invocation. Terminal values are checked
against the accepted schema through the shared execution-result validator.

`review.start` and `subagents.plan.start` declare this seam. Failed/cancelled runs
and partial launch failures remain per-engine values; no launches or an Action
error fail the invocation. Review completion reads materialized comment ids and
materialization outcomes from the host bridge's observation, never from raw
findings. Workflow Action-leaf integration is a separate development consumer;
this declaration does not make every CLI/API invocation blocking.

Workflow `collect_outcomes` collects finished typed failures from immediate
Actions and from terminal native observation with no failed launches. A launch
failure alone proves neither that no run was created nor that active work has
stopped. An invocation failure with unproven launch custody stays
`outcome_uncertain`; replay never re-invokes it. Valid terminal values keep their
declared per-engine failure outcomes.

Planning explicitly selects detached execution with `target:{kind:'detached'}`
and no `sessionId`. The executor forwards the host-supplied machine workspace to
the canonical execution-run V2 seam with `sessionId:null`; a contextual default
Session is only provenance, not the execution target. Without this arm, the
existing Session selection rule still applies. Contradictory detached/explicit
Session input is rejected before any launch.

In 0.3 development, `review.engines.list` and the `review.start` engine picker
also accept `sessionId:null` with an exact Machine target. The options Action
carries these selector facts in `draftInput`, not its Session-only outer selector.
Discovery uses the captured Home/Account catalog and that Machine's current
projection; an active
Session or Home cannot supply a detached target. Omitting `sessionId` retains
the existing contextual Session selection. CLI/PAT dispatch honors detached
Machine placement rather than a contextual Session, and the UI checks Account
currentness after the awaited inventory read. Detached discovery does not enable
detached walkthrough or explanation narration: those follow-ups remain
Session-bound until the owning execution-run producer supports them.

Detached `review.start` uses `target:{kind:'detached'}` and omits `sessionId`;
the discovery selector's explicit null is not a valid start input. Its declared
`cwd` uses the existing Execution Run working-directory schema. The captured
Machine context's Project directory takes precedence when present; otherwise
the authored detached `cwd` reaches the Run's top-level working location, not
only its review intent payload. This keeps a checkout review from starting in
the daemon's default directory.

For immediate UI Actions in 0.3 development, caller cancellation does not erase
a returned effect disposition. The captured invoker retains a received effect
receipt after cancellation or Account retirement; stale Account projections
still cannot publish it into a different scope. Reads require current custody
before disclosure, and work not yet dispatched remains cancellable. Voice applies the same result custody instead
of rewriting an acknowledged mutation as a cancellation or retrying it.
One-shot CLI Session and Machine RPC likewise preserve a valid decoded
acknowledgement. Cancellation can stop a pending call, but cannot erase its
received effect receipt or authorize a replay. Passive read observations retain
their caller-lifetime and reconnect withdrawal.

For transported RPCs in 0.3 development, the existing `rpc-cancel` follows the
caller's connection-local correlation through the Home to the exact target.
The target's `RpcHandlerManager` owns the native acknowledgement: once it has
observed cancellation, it skips abandoned response encoding and suppresses the
callback, including cancellation received during asynchronous encoding or
cleanup. Machine, Session and ephemeral receivers share this owner. Calls with
`waitForResultOnCancel: true` keep their cooperative result custody; the Home
forwards that existing policy to the target. Older daemons may still send their
late result, which an already-cancelled caller discards. Cancellation cannot
retract bytes emitted before it reaches the target.

In 0.3 development, an issued call whose original Socket.IO namespace is
lost settles as `RPC_OUTCOME_UNKNOWN`, including reads, without waiting for its
authored deadline. Its issued disposition survives serialization; a namespace
disconnect is distinct from `RPC_TRANSPORT_UNAVAILABLE` during target discovery
or before dispatch. Replies belong to the original namespace acknowledgement;
another connection for the same Account or purpose cannot receive that ACK.
Existing demanded-read owners revalidate on their ordinary reconnect wake;
an authenticated Home reconnect requests a fresh snapshot even while an old
watch is parked or preparing. Ordinary Machine request-success wakes only renew
failed observation, so successful reads do not trigger a refresh loop. The
transport adds no retry, timer or cache. An explicit uncertain relay reply
and a decoding failure after a received ACK are not reclassified as disconnects.
Issued effects, including Stop and spawn, retain unknown/pending custody and
their existing reconciliation. Stop must not report a final failure merely
because its issued observer lost the socket while the authority may still run.

Development-source Home RPC diagnostics retain separate `rpc-target-lookup`,
`rpc-target-issued` and `rpc-target-ack` facts for correlated socket calls.
Every shared-client issuance has an observation id: existing cancellable/signed
calls keep `requestId`, while ordinary calls carry diagnostic-only `traceId`.
The latter must not create cancellation state, authorize execution, or change
result custody. Home validates this transient metadata with the existing RPC id
schema, hashes opaque caller ids in logs, and replaces it with a fresh
target-local trace. Invalid diagnostic metadata is discarded without changing
the operation. `rpc-call-received` precedes asynchronous Home admission;
`rpc-call-admitted` means admission to target lookup, not effect execution.
Non-Machine calls complete with `rpc-call-completed`.
The daemon's existing RPC observer records received, manager-admitted and
completed phases using the target trace. A valid `traceId` takes diagnostic
precedence if Home's existing input-authorization path also supplies `requestId`;
only the latter retains its signed/cancellation meaning. Manager admission is
not a promise that a handler's domain policy will accept the effect. Local
in-process calls retain their completion-only diagnostics.
Their `requestId` is the server-minted target id; the existing
`machine-rpc-relay-completed` record joins it to the caller request id and
original caller namespace, including that namespace's connected state at
completion. Discovery warnings carry the same target correlation. An issued
record means `emitWithAck` returned, not that bytes were written or an effect
ran. A received target ACK proves Home received it, not that the caller did;
the caller's native ACK settlement establishes the latter. Reconnecting to a
new namespace cannot establish the old issuing namespace stayed connected.
These diagnostics retain no request/response content and add no replay,
timeout or reply custody across reconnects.

Captured Machine Actions share this settlement rule for Storage, Processes,
Guard and resources policy effects. Connection setup stays bounded by the
existing transport owner; a dispatched effect's completion is operation-owned,
so the ordinary read deadline cannot discard its later acknowledgement. No
retry, longer deadline or receipt cache is added.

## The CLI demotes a success that did not take effect

An Action may legitimately declare its whole outcome union as *successful output* — typed
consumers read the status field. The CLI must not print success and exit zero for such a payload,
so `ActionCliPresentation.classifyResult` exists: after `executeCommand` unwraps the canonical
success payload and handles a created approval request, it gives the presenter one chance to
demote the payload into a typed `ActionCliFailure`, which then flows through the same
`failureFields` / `describeFailure` / `reportFailure` path as every other CLI failure.

`SESSION_SEND_PRESENTATION` is the worked example. The executor has already validated the payload
against the Action's output schema, so the presenter demotes only the canonical undelivered
statuses (`rejected`, `failed`, `cancelled`, `outcomeUnknown`) and does not become a second output
validator. Each demotion carries the admission `code`; only `outcomeUnknown` — the one genuinely
uncertain case — earns the `--local-id` retry hint, and the released JSON `sent` field is derived
from the status rather than assumed.

## Git mutation outcomes (development)

The Git Actions extension is development-only. The client-local
`scm.writeOperations` preference defaults on without requiring Experiments;
an explicit off choice preserves read-only UI behavior. This preference is not
a daemon or Home authorization boundary. The canonical rows live in
`actions/scmGitActionSpecs.ts`;
Agent, MCP and CLI mutations use the same Action admission and danger-approval
policy, not an independent Git command dispatcher.

`scm/operationOutcome.ts` owns the typed mutation result. Its terminal kinds
are `succeeded`, `needs_input`, `conflicted`, `effect_applied_with_warning`,
`failed`, `cancelled` and `outcome_unknown`. Legacy `success` is retained on
SCM responses, but it is not enough to decide whether an effect occurred:
a commit may exist despite failed index reconciliation, and a lost push or
pull-request response may leave the effect uncertain. Consumers retain the
outcome, use its effect or reconciliation identity, and do not blindly replay
an uncertain mutation. Diagnostic text is not an outcome classifier or an
analytics field. A cancellation result requires a genuine cancellation signal
and refreshed repository state; declaring the schema does not establish that
every process adapter can produce it.

`scm/operationState.ts` owns the repository operation shape. Git's sequencer
and unmerged index determine merge, rebase, revert and cherry-pick state,
unresolved paths and available controls. Stash-apply conflicts do not invent
a sequencer. Recovery stashes are applied by immutable object ID; their display
ref is not execution identity.

New raw SCM callers request `outcomeVersion: 1`, and status callers request
`operationStateVersion: 1`. The raw-RPC compatibility projection preserves
supported predecessor error codes and operation kinds when these fields are
absent. Negotiated status projections must not share a cache entry. Advanced
pull policies and force-with-lease require explicitly advertised backend
capabilities; missing bits do not authorize a new request shape. Pull defaults
to refusal of dirty work and fast-forward-only reconciliation. A force-with-lease
push needs an explicitly named remote branch, its expected object ID and danger
approval; there is no raw or automatic force path.

`scm.commit.undoLast` requires the exact observed `expectedHeadOid` and an
advertised `writeCommitUndoLast` capability. The Git owner moves HEAD to its
single parent without changing the index or working tree, keeping the undone
commit's changes staged. It refuses a changed HEAD, the first commit, a merge
commit, an active repository operation, and a commit reachable from observed
remote-tracking history with typed outcomes. This is an observed-history check,
not a claim about an unfetched remote. The successful outcome identifies the new
HEAD; a subsequent refresh failure remains an applied effect with a warning,
never an instruction to repeat the undo.

The UI offers force-with-lease only for the snapshot's observed upstream ref and
object ID and always asks for confirmation, even when ordinary push confirmation
is disabled. A stale lease returns a typed refusal with refresh recovery; neither
the UI nor the Action executor substitutes an ordinary or plain-force push.

Commit input defaults to ordinary `mode: commit`; `mode: amend` is explicit,
and `signOff` is independent of signing configuration. If Git proves the head
is already reachable from its configured upstream, the owner returns
`COMMIT_AMEND_PUBLISHED` before rewriting it unless `allowPublishedAmend` was
explicitly acknowledged. That acknowledgment still uses the Action's danger
approval and cannot authorize a force push. A successful metadata read showing
no upstream permits a local amend without claiming that no remote has ever seen
the commit. A failed read of a configured upstream is not silently treated as
unpublished. Missing `writeCommitAmend` or `writeCommitSignOff` capability bits
never authorize an older backend to ignore these inputs. There is no `noVerify`
option in this contract.

Git pull-request orchestration keeps repository templates, exact base/head,
create-versus-reuse and recovery outcomes at the Git owner. GitHub and GitLab
plugins own provider-native checks, reviews, reviewer changes and request
management; their declared Agent/MCP/CLI mutations use plugin Action approval.
Connected Account selection remains exact, including the selected deployment
origin. GitLab's provider adapter uses that Account's REST API binding rather
than a separate CLI process grant. Opening a provider compose page is
`needs_input` with `result: opened_compose`, not evidence that a request was
created. An unreadable response after a provider write is uncertain and carries
the head/base query needed to reconcile it.

## Current mounted UI context (0.3 development)

Home Customize, widget-area Organize and Project widget Expand/Collapse also
publish through this command owner. They use the human controls' same callbacks
and remain local to the mounted layout and viewer, without a persistence write.
The AppShell composes these host controls with a plugin page's authored commands
in its existing current record. Unmount, layout or viewer replacement and native
background retirement invalidate the old opaque command ids; no answering
mounted client means typed unavailability.

The client-placed `clipboard.write { text }` is the shared copy effect for UI and
Agent/MCP callers, including Usage widgets' Copy query. Its existing safe default
remains configurable through ordinary Action settings. If the person requires
approval, copied text stays in the live invocation: the approval Artifact and
observation projection contain no text, and durable replay cannot reconstruct it.
The answering client must still be available to deliver the copy; approval does
not supply a clipboard or turn an unavailable delivery into success.

`ui.current_context.read` and `ui.current_context.command.invoke` are client-local host Actions available to UI, Voice, Agent, MCP and CLI callers. In development source, the canonical CLI projections are `happier ui current-context read` and `happier ui current-context command invoke <commandId>`. The read returns the current navigation snapshot and complete opaque command inventory; invocation accepts only a currently published command id. Context data is strict JSON, and executable declarations and descriptors remain closed. The snapshot has no independent command-count or aggregate-byte ceiling: a growing filter or view inventory must not erase its entity or commands. Semantic command launch inputs retain their own operation boundary. The answering AppShell uses the same current-context reader and semantic dispatcher as Voice, retaining mount retirement, current Action availability, declared caller surfaces and approval policy. CLI invocation requires that answering client; headless CLI/RPC hosts have no mounted execution owner and cannot substitute a successful local result.

Plugin pages publish finite `executeAction` or route-owned `openSurface` commands rather than raw UI state. PRs & Issues uses this seam for its [mounted-page operations](triage-sources.md#mounted-page-actions-03-development); the current context carries that page's ephemeral Action address for typed operations requiring entry references or a lens.

The CLI current-context route has no browser-tab or mount selector. Its read and
invoke use the connected-client selection described above. An opaque command id
copied from another browser or mount does not address that publisher; the answering
app refuses an id it does not currently publish. Read the answering app's command
inventory before invoking it. A separately observed mounted Action address is
likewise meaningful only while that exact mount remains available; it does not
change the unaddressed route's receiving client.

## Finite Project command observation and output (0.3 development)

`projects.compute.exec` accepts an optional `execution: 'primary' | 'portable'`
constraint. Omission keeps portable placement. `primary` pins admission and
execution to the accepted source checkout's Machine, even when saved worker
preferences select another Machine. An explicit worker choice or conflicting
accepted Machine is refused before launch. Front-door routing and daemon
admission use the same Project placement resolver; older strict readers refuse
an unsupported explicit constraint rather than silently running it elsewhere.

The public operation Actions adapt the existing Account-scoped Machine operation
authority; they do not add an operation store or execution controller. Get may
wait for the admitted operation's terminal result without replaying its launch.

In current 0.3 development source, request-id deduplication holds only while the
daemon still holds the Account/Machine-scoped Action receipt; changed input is
rejected with `action_request_input_conflict` while that receipt is retained.
Receipts are process-local, with settled history limited to 50 entries / 24 h.
After a daemon restart or receipt eviction, Project commands and prepared
transfers may run again under the same request id. Finite `projects.prepare`,
`projects.script.run`, `projects.compute.exec` and prepared filesystem
copy/upload/download lack a durable request-to-run or request-to-transfer
settlement record. Re-admitting the same request id after receipt loss can start
another effect. Project setup completion records describe current readiness,
and transfer staging files hold bytes; neither recovers the original request's
result. Durable effect-owner replay for these families remains unimplemented.

Qualified operation observation, Stop and output retain their original Machine;
an unavailable original does not redirect them to a replacement Machine. This
also applies to retained Workflow observation and recovery.
Foreign Machine requests use the transport's server-verified admitted actor Account,
not the Machine custodian or an Account supplied in Action input. The operation
authority rechecks that admission after a held Get before returning its result.
Stop enters shared configurable Action approval before requesting cancellation;
the request is not evidence that the process has stopped. Present-user UI and
CLI requests retain the canonical deferred approval Artifact. Mounted operation
controls use the shared approval continuation to consume the replayed cancel
result, keeping approval pending distinct from a requested or confirmed stop.
They retain the observed Home and Account; Account retirement releases mounted
interest rather than retargeting a retained operation to the replacement actor.
An active owner's `stop_unconfirmed` observation permits an explicit Stop retry
against the same qualified operation; no timer retries it or fabricates settlement.

The development completion contract retains the original active operation and
accepted reservation across a post-copy setup review. Its strict `setupReview`
fact presents as Needs you, not failure or
uncertain process outcome. FIN observes that review through the existing consent
hold; fresh authorized consent resumes the original no-effect continuation and
rechecks current policy before effects. It does not admit another command or
replay completed setup. Ordinary terminal Wait remains pending through review.
Stopping the retained operation cancels that same continuation. This is an
unreleased source contract; receiving finite-execution integration is still in
progress, and blocking human-approval continuation additionally depends on the
canonical approval owner's callable continuation.

Project command output is addressed by a Home/Machine-qualified operation, never
a caller-supplied terminal id. Each read resolves the currently authorized
`projectCommand` attachment, then uses its exact execution Home, Machine and
terminal with the existing byte-ring reader. Operation custody and the execution
destination may differ. Cursor, retention gaps, credit and byte boundaries remain
owned by the terminal stream. Failed and cancelled commands retain their witnessed
output attachment; an accepted command without a terminal reports output pending.

Development Project Script attachments also retain the originally admitted,
qualified source checkout and the captured named Script/source reference. This
source identity survives setup-before-script and is distinct from actual execution
placement. Account/Home-scoped Scripts selectors therefore observe runs started by
other clients, not just a local Run receipt. A directly selected native reference
does not invent a manifest Script name. Observed PTY exit codes remain on the
attachment across failure or cancellation; arbitrary native failure details are
not exposed. Run duration uses the first observed process start and terminal
settlement, only when a real terminal attachment proves a launch. Queue acceptance
and a no-launch outcome do not establish process duration.

Live development observations reuse the existing Account operation event. Its
content is explicitly encrypted or plain, admitted against persisted Account
encryption mode on the exact Home; absent keys never establish Plain mode.
The Machine connection cannot publish another requester's snapshot into its
custodian's channel. The authenticated relay checks current socket credentials
and Account mode before user-scoped fanout. Clients read the current qualified
V2 record through the original Machine before merging that observation, retaining
Account retirement throughout the read. Released encrypted notifications use the
canonical V1 projection; an unavailable newer reader cannot erase retained rich
facts. The same ingress is installed on selected secondary Homes. The existing
credential-mutation and Account-replacement owners synchronously withdraw a
replaced Account before delayed reconciliation, while retaining proven same-Account
rows. E2EE publication reuses the older Home's persisted-mode endpoint rather than
requiring a newer currentness route. These paths have source-level owner coverage;
broader cache/package checks and the loaded cross-client journey remain incomplete.

Activity dismissal hides the Activity entry, not the retained qualified operation
or its Script history. Explicit detail/output observation uses that same record;
opening a dismissed result does not restore its Activity entry or replay a run.

Open requires an answering app and reuses operation detail. Copy returns structured
byte-stream output on headless hosts; an app reports copied only after its clipboard
writer succeeds. Copied text uses the terminal's existing visible truncation marker
for retention gaps and its UTF-8 projection decoder; raw frames and cursor/completeness
metadata remain unchanged. Borrowed output viewers are read-only subscriptions: closing one
does not ensure, restart or kill the command. These are unreleased source contracts;
the integrated output view and composed cross-Account app/headless journey remain
required before claiming that complete journey is available.

## External Session activity (0.3 development)

External Session imports and takeovers retain their durable executor and operation-record
store as the lifecycle authority. Start, Resume and Retry acknowledge admission before
long-running capture or import finishes. Shared Action Operations list, get, Activity
progress and Stop delegate to that same owner; the generic execution observer never
turns the initial acknowledgement into completion. The projection reuses the existing
operation id and maps durable revision `r` to shared revision `r + 1`. It does not add
a second execution controller or durable operation store.

The record publisher covers commits from RPC, recovery and background execution.
Queries rebuild from the current Account-scoped durable records and retained compact
terminal receipts, and remove stale projected rows when the owner no longer has them.
Compact receipts retain their terminal observation time, rather than reconstructing
earlier lifecycle timestamps. Detaching the domain owner removes its projections.
Private source paths, staging data and diagnostic error messages do not enter Activity.

Recoverable failure, reconciliation and awaiting-resume states remain active and
need attention; Resume or Retry updates the same operation identity. Stop calls the
existing revision-checked cancellation Action and respects its checkpoint safety
decision. The shared cancellation helper can inspect private bindings in a full record;
public transcript progress cannot prove that a private checkpoint has settled, so it
conservatively withholds Stop in that case. This difference reflects available facts
and gives neither presentation surface cancellation authority. A cancelling operation is observed until the durable owner settles it.
Transcript controls continue to use the existing public external-operation projection,
including for an empty linked Session. Shared snapshot publication withholds data when
the persisted credential Account differs from the pinned machine connection Account.

## Doc collaboration (0.3 development)

`doc.read` opens the current authorized prose Artifact and full revision through
`artifact.get`. A supplied revision must still match; it is not a historical read.
`openCommentCount` counts active Doc-anchored Discussions whose passage root
the viewer can currently read, through the existing scoped Discussion list and
resource codec. Archived threads are closed; proposal decisions do not close a
thread. All pages are traversed without marking a Discussion read or repairing
recipient keys. A real inability to establish the count returns `null`, not zero.
Structured Memory uses its own Actions.

`doc.comment.reply` and `doc.edit.propose` use the existing Discussion writer,
content codec and retry identity. Passage text stays inside the admitted content
envelope; routing carries only the qualified Doc and complete revision. Thread
replies inherit the root's Doc anchor.

Proposals retain the exact source passage (UTF-16 Markdown offsets and quote),
before/after text, reason and full base revision. Posting one changes no Doc text.
List previews show the translated suggested-edit label and reason, not the
reviewed before/after text; full human message reads retain the complete proposal.
Comment/proposal operations need the Conversations feature and current Doc and
Discussion admission; a mention supplies neither access nor a grant.

`doc.edit.accept` takes a proposal reference and complete reviewed revision;
`doc.edit.decline` takes only the proposal reference. Acceptance prepares from the
exact committed proposal and current Doc through the shared passage owner, never
from new public replacement text. The keyholding Artifact host seals that body.
The server requires an authenticated present person, current thread access and
Doc edit access; an Agent, approval waiver or `bypassApprovals` cannot decide.
Full revision conflict leaves both body and disposition unchanged. A decision
retry, including an opposite decision, returns the settled result without a new
revision. Decline never writes the Doc body. Whole-catalog SDK projections and
the loaded cross-client journey remain integration-boundary validation; these
contracts are not a released availability claim.

## Request attribution and readiness (0.3 development)

The host's immutable `actionRequestAttributionV1` records the request, qualified
requester (or null), persona Session and optional exact source message. Read it
as **asked by**; returned answers can separately retain **answered by** provenance.
**Using** is separate from both the execution Account and the cause. Current
operation results and settled approval receipts carry host-stamped `operationCredentialUses` from the
credential materializer that actually admitted the operation. Each content-free
entry contains the authorized credential label (or null), connected-account or
Team-resource kind, actual owning Account/Team when known, and purpose-binding
reason. `current_at_materialization` describes the existing admission-time
currentness check, not continuing readiness; a Team entry can retain its admitted
resource revision. The original outcome remains authoritative, including failed
or uncertain effects. Plugin result JSON and the Bot owner's identity cannot
stamp these facts. Older receipts without admission evidence remain unknown.
An approval without terminal execution history remains pending. Live-only
target Actions retain the original approval Artifact through incumbent
settlement and publish the same safe admitted-credential facts beside the
redacted terminal outcome; confidential operands and handler output remain
with the live invocation. Never infer a settled approval or its credential
actor from a pending status.
Attribution grants no authority. Unknown or
autonomous causes never become the Bot owner, and retained history is not a full
audit log. Byline rendering is still being integrated.

A direct person-started Workflow Run freezes `authenticatedStarterV1` inside its
accepted origin when the receiving host has current, Home-authenticated Account
custody for that direct UI or CLI invocation. Public start inputs cannot supply
this fact. Original CLI input uses REQATTR's authenticated Account or paired
terminal classification, independently of execution authority and terminal
approval policy. CLI Workflow birth uses the existing Home-issued Machine proof
and sealed requester context even on the caller's own Machine; private daemon
root control alone carries no authenticated requester custody.
A CLI running inside an Agent Session retains its Agent cause
and cannot stamp a person starter. The credential reader preserves private Session
custody through an explicit saved-Home selector; that custody never qualifies as
interactive stored credentials in the shared approval/starter classification.
An original CLI start without that person classification returns
`approval_requester_unavailable` before Run admission.
The starter contains the qualified Account and original request id;
it does not invent a Session before a participant exists. A Session participant
then supplies its actual Session persona when producing protected input and
retains the starter as the requester. An existing admitted causal attribution
takes precedence. The fact grants neither permission nor approval, and does not
convert the Run owner's or executing daemon's credentials into a person.
Workflow steps apply the same precedence. Before any participant Session exists,
including its `discussion.invite`, the exact accepted starter is the approval
subject. The host carries `authenticatedStarterV1` on its `workflowRun` caller;
the shared approval owner binds confirmation to that person's Account and Home,
through ordinary Account approval and exact-daemon replay. An origin Session is
not required. The invitation's existing replay-currentness owner compares the
retained starter with the accepted snapshot; a substituted or omitted subject
cannot acquire consent. No Session or Run persona is fabricated.
A person starting another round or replay starts a new Run with that person's
authenticated starter; the prior Run's requester and program remain unchanged.

Scheduled, triggered and Agent-started Runs without an admitted person retain
unknown requester attribution. When their Workflow Action block or Agent Action
requires approval, the shared requester decision returns
`approval_requester_unavailable` before creating an Artifact or performing an
effect. An origin Session or daemon credential does not identify a requester.
A retained, unsettled Workflow approval without either that causal requester or
the accepted starter also refuses before decision or replay; old cards cannot
restore missing person attribution. Settled history remains observable.
A starter never
waives an Action prompt: the entitled person decides through the existing
approval flow, and the original executor performs the effect.
In unreleased 0.3, detached Workflow Agent steps have `sessionId:null` and cannot
bind the Session requester required by this approval flow. A danger Action that
requires approval returns `approval_requester_unavailable`, creates no approval
Artifact and performs no effect. The native Run input and Workflow step settle
visibly as failed with that code, even if the Agent consumes the tool error.
Safe Actions and person-attributed Workflow Action approvals keep their existing behavior.
Detached Agents do not acquire a fabricated Session or a Run-persona approval
route.

A shared request's outward write defaults to confirmation under the existing
Actions policy. A known cross-Account requester gets a signed
`requesterConfirmation` binding the request, exact Action/input digest, admitting
Bot Session and execution Account. The original executor checks a current
authenticated decision from that requester; another person cannot substitute.
When confirmation is required but the requester cannot be bound, admission
returns `approval_requester_unavailable` without creating an owner-decided
approval. This includes failure to bind consent to its signed execution origin;
known attribution cannot substitute for that binding. Requester consent never promotes the
Bot's execution authority to present-person authority; a person-only Action
still requires its own entitled person. Ordinary same-Account approvals retain
their existing authority, and an explicitly waived prompt still requires the
Bot's ordinary execution permission.
The existing Artifact recipient path adds the entitled requester as a preview
recipient. The original admitted executor runs the effect with the credentials
selected and rechecked by the existing credential owner; it does not substitute
the deciding person's or Bot owner's credentials. Settings Require
and Waive remain surface-specific policy choices (currently **Ask first** and
**Allowed** in Settings → Actions); a waiver never grants person authority or
permission to accept a Doc proposal.

`session.status.get` with `{sessionId,readiness:true}` adds an explicit diagnostic
from the current Machine/Agent inventory and invocation access. It defaults to
`operation:'conversation'`; `operation:'credential'` with a qualified
`credentialPurpose` additionally reads the operation's actual selected credential
through its personal purpose owner. A Team operation supplies the existing
qualified `credentialTeamSelection` from its setup selection, checked against the
same purpose, service and entitled resource. Unavailable resources retain their
owner's failure and recovery facts. The result reports
`configured:true` and `status:'ready'|'unavailable'|'unknown'` with a cause.
Saved configuration alone does not prove readiness; inaccessible or incomplete
evidence stays unknown. This read performs no repair. Each effect still rechecks
its own authority and binding. People/Bot readiness rendering remains in progress.

## Related

- [api.md](api.md) — the public Action API envelope, PAT authentication, targets, and limits.
- [cli-architecture.md](cli-architecture.md) — how a spec row becomes a CLI command.
- [peer-mediation.md](peer-mediation.md) — the Machine-RPC route classes and which methods may go direct.
- [session-collaboration.md](session-collaboration.md) — the Session-side owners many of these Actions call.
