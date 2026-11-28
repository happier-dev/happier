# The Actions platform

An **Action** is one named, schema-typed user intent — `session.list`, `teams.policy.set`,
`session.board.get` — declared once and projected to every surface it opts into: UI, Voice, Agent
tools, MCP, CLI, Machine RPC, the public HTTP API, and plugins. The point of the platform is that
a new capability is added by declaring a row, not by writing a command, a tool, a route, a
permission check and a confirmation dialog five times.

In unreleased 0.3 source, bundled UI Actions explicitly declare `agent` and
`plugin` so agents and plugin callers can invoke the same intent. A UI Action
with a person-only requirement declares `personOnly: true` and omits `agent`.
The database row download uses that exception because it needs a person-selected
file destination. Agents can use `rows/export` to obtain the content.
`definePlugin` preserves the authored surfaces. All callers go through the
existing Action availability, settings and approval policy.

In unreleased 0.3 source, `machines.scheduled.list` and
`machines.scheduled.watch` read native cron, systemd timers, launchd schedules or
Windows Task Scheduler through the Machine's existing inventory custody and
protected Action transport. The caller supplies `pageSize` and optional `offset`;
`nextOffset` requests another page. Sources report read failures independently.
Readable sources can also report `observation: {kind: 'unavailable', reason}`,
which retains useful rows while exposing a failed native producer. Reads load on
page presentation and explicit refresh; push uses existing native producers where
available, without polling or adding a systemd subscription source. An explicit
`refresh: true` also reattaches failed observations. Command bodies and executable arguments are never returned or
stored on the server. The daemon shares one native observation across pages;
UI data consumers share the existing demand, cancellation and recovery store.

This page describes the platform's owners and its admission vocabulary. The public HTTP wire
contract lives in [api.md](api.md#external-action-api-developer-preview-source-contract); the CLI
host is in [cli-architecture.md](cli-architecture.md#action-derived-command-arguments).

In unreleased 0.3 source, `machines.reachability.configure` retains the firewall
owner's exact prior owned rules, unit, table and boot state in the existing
encrypted device-local Action receipt. Receipt storage uses the operation owner's
existing admission failure semantics; progress alone does not rewrite it. The
scoped V2 operation read and Action detail expose the saved capture without an
interactive task or an SSH connection. This is recovery material, not evidence
that restoration occurred. A later publication failure retains the capture
alongside the actual failure code and diagnostic cause. The existing
24-hour/50-settled-operation retention applies. There is no Home-side durable
copy: a fresh reader still needs the
daemon's outbound Home route.

A Reachability Join whose credential file removal cannot be confirmed carries
`credentialCleanup: 'recoveryRequired'` in the returned and retained
`outcome_unknown` result. `errorCode` remains the native stage's typed refusal
when that stage failed. Confirmed cleanup leaves the disposition absent.

In unreleased 0.3 source, `machines.vitals.summaries.list` can carry the
per-Machine Action or RPC `errorCode` on an `unavailable` row. It carries only
the code. Offline Machines and rows without a typed refusal omit the field.

In unreleased 0.3 source, plugin-provenance-only Actions are excluded from
standalone CLI invocation by the canonical Action spec exposure normalizer.
`actions get`, generated help and Action context descriptions direct callers to
the host-mounted import, which supplies the mounted plugin caller. An explicit
Machine does not supply that provenance. This includes external-session
materialization and plugin self-revocation; their execution provenance checks
remain enforced.

In unreleased 0.3, a server-to-daemon transport refusal retains its closed RPC
code and validated `failureCause` through the existing Action failure projection.
The request envelope supplies the correlation ID. Plain requests return the
Action failure; protected requests return the non-content HTTP refusal. RPC
prose and encrypted result content never enter that projection. Untyped forwards
retain `target_unavailable`; a lost acknowledgement retains its existing unknown
outcome. The dispatcher does not retry a refusal.

In unreleased 0.3 source, the plugin dispatcher owns finite-operation admission.
Before admission, the requesting view's abort signal cancels the request. After
admission, that signal releases the view's subscriber while the existing finite
runner completes. Deliberate Stop uses `action.operations.cancel` for the exact
operation. Transient reads and input forms retain their ordinary abort behavior.
A prepared New Session handoff stays on the existing device-local operation
result record while its view is detached. Opening that operation consumes the
handoff once through the ordinary plugin New Session producer; it neither
prepares another checkout nor admits another operation. Account retirement still
withdraws the captured Account's presentation authority.

In unreleased 0.3 source, contextual Run, opinion and Workflow forms open in the
shared [Start presentation](app-shell-panes.md). Opening, editing, choosing a
reviewer or recipe, Back and dismissal do not admit work. Explicit Start or Ask
uses the existing Action executor and that Action's approval policy. An empty
review, plan or delegate slash command opens the form; the same command with
instructions executes directly through the existing composer resolution owner.
Accepted results replace Start in place, and an origin marker opens the accepted
result without submitting again. Ordinary New Session and prepared composer
text retain their existing explicit Send flow.

In unreleased 0.3 source, the failed deployment receipt's investigation outcome
consumes typed Action results from its linked Session and that Session's admitted
approval Artifacts. It carries produced PR, approval, operation and new receipt
addresses into the existing outcome rows. An approval request is not approval,
a command's recorded exit code is validation evidence, and a receipt acknowledgement
is not observed recovery. Recovery comes only from matching canonical deployment
health. Agent reports, including skipped checks, remain reported Session output;
their prose grants no authority. Repair remains an explicit choice under the
existing Action approval profile, with no automatic merge or redeploy.

Plugin Action input forms and `selectActionInput` use the shared anchored-sheet
chrome. Session-address, review and Session-recipe selectors return their typed
selection or cancellation without invoking the effect; `executeAction` remains
a separate Action invocation. Review selection reuses the Run form's options,
and recipe selection reuses the Session recipe body. Source disclosure, Account
scope and approval admission stay with the existing domain and Action owners;
presentation adds no Action ids or per-step authorization.

In unreleased 0.3 source, `notifications.test` tests an existing saved health
alert destination. Its input addresses the Home, controller Machine, source,
channel, saved destination index (from zero) and expected saved-source revision;
it accepts no message or destination
override. The shared approval preparation discloses the sending controller,
exact saved destination and off-app encryption boundary for both UI and agents.
Several saved destinations may use the same provider; the index identifies the
exact row within the expected source revision.
Execution admits the current saved source once and uses the existing notification
delivery owner. Results distinguish sent, paused, off and unavailable. Quiet
hours can pause a Test. A paused source or saved Off suppresses off-app delivery
while committed health notices remain in Inbox.

In unreleased 0.3 source, the prompt picker exposes selection and application
through `ui.prompts.picker.select` and `ui.prompts.picker.apply` after
`ui.prompts.picker.open`. Selection addresses a Library document, built-in token,
or exact sent-message identity in the open picker. Application inserts or sends
through that mounted composer's existing controller, preserving argument
selection, submission locks and stale-draft refusal. Explicit composer addresses
cover Session, Home and New Session inputs; an absent or closed target is reported
without applying to another composer.

`ui.prompts.history` reads the same open picker's Account-global, device-decrypted
Sent-before projection. Its `read`, `page`, `stop` and `retry` operations retain
the history owner's coverage and progress. A page returns the accepted projection;
it does not imply complete Account history. Closing the picker releases demand.
Stop releases the invoking consumer's wait without cancelling another consumer's
shared read. Explicit Retry replaces the obsolete page or Session hydration;
late retired replies cannot publish its replacement's result or cursor.
No decrypted history is searched by the server.

`session.messages.pins` reads, pins or unpins through the existing device-local
pin persistence owner, scoped to the exact Home, Account and Session. These
Actions act on the answering client device; pins are not synchronized between
devices. Pin and unpin are idempotent and use the same message/route identity as
the transcript row. All three Action families use canonical client dispatch,
admission and Agent/MCP/CLI exposure. The Action catalog remains the authority
for schemas, approval requirements and surface availability.

In unreleased 0.3 source, `sessions.external.backgroundFollow.set` accepts
`{ sessionId, enabled }` on UI, Agent, MCP and CLI surfaces. Session placement
resolves the linked Session's owning daemon without requiring a running Session
process; the daemon's existing follow-policy owner retains metadata persistence,
lease reconciliation and recovery. Settings and header toggles use this Action.
Their mounted invocation retains its exact link and Account lifetime across Ask,
then rechecks that intent before transport and before local metadata catch-up.
A predecessor daemon cannot enable the retired raw-delta follow data plane;
enabling returns the existing typed unsupported result, while disabling retains
the released provider-named transport adapter.

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

In unreleased 0.3 source, advertisement reads the runtime's Account Action
settings provider, including CLI list/describe, standalone MCP and native Voice
prompts. The native Voice function carries a generic Action envelope; its
prompt inventory is filtered, while the protocol decoder retains the full catalog.
An environment setting is an explicit override for ordinary unscoped CLI use; it does not replace a credential-bound runtime's Account policy.
Settings predicts confirmation through the execution approval router, including
its UI confirmation result. For a declaration whose inherited confirmation
depends on input, both Ask first and Allowed remain explicit saved choices.
Resetting to Default restores the declaration's input-dependent behavior.

In unreleased 0.3 source, configuring unused retention admits its scheduled
Stop or Suspend. The managed policy runtime carries that consent to the selected
effect without a new approval card when the unused window expires. Per-Machine
Keep running remains available. Manual Stop/Suspend, Delete and absolute-deadline
effects keep their normal Action review. This follows the 2026-11-06 owner ruling;
retention still uses the existing live-work and native-effect owners.

In unreleased 0.3 source, an automatic managed-Machine retention wait superseded
before policy admission or native execution settles as `cancelled`. A successful
manual Stop or Delete therefore does not turn that obsolete wait into a failed
Action. The controller retains the `intent_changed` supersession diagnostic;
explicit Action conflicts, admission failures and issued native effects keep
their existing settlement semantics. Pending Stop/Suspend recovery uses the
Home's policy-admission provenance projected in the controller census, rather
than treating matching desired and submitted intents as policy ownership.

In unreleased 0.3 source, `machines.setup.adminAccess.inspect` returns the saved
`adminAccess` policy and `metadataVersion` from one metadata snapshot alongside
the native observation. Supply those values as `expectedAdminAccess` and
`expectedMetadataVersion` to `machines.setup.adminAccess.set`; observed sudo
power does not establish the saved policy. Matching Protocol and daemon readers
reload together for this closed response extension.

In unreleased 0.3 source, `machines.setup.adminAccess.set` writes the reviewed
desired policy through the target daemon's existing Machine metadata field CAS,
including plain and E2EE Accounts with every app client offline. The receiving
daemon rechecks exact Machine admission before each write; field comparison
preserves unrelated metadata changes, while revision comparison returns contention.
An acknowledged desired write remains successful if the caller subsequently
disconnects. A lost acknowledgement is observed without blindly replaying the write.
The result reports desired policy and metadata version, not administrator power.
A normal correlated Action invokes the canonical Machine administrator host
adapter after successful desired settlement; its separate `effect` reports the
host result without rolling back acknowledged desired intent. The host settles
an administrator change from exact native verification and a clean interpreter
exit when the final native result record is lost. Activity displays that settled
result. An unknown host outcome triggers one observation refresh, never effect
replay. If reconciliation was not attempted, the optional effect is absent.
Desired success alone must not be presented as a successful host grant or revocation.

A correlated administrator change uses the existing Action operation and admitted
system-task owners. Ask publishes a nonsecret `sudo.password` descriptor on that
same operation and waits for its transient answer; it does not return a successful
host result while unanswered. The native sudo runner starts first. It asks when
sudo challenges for the selected administrator, or at root readiness when the
incumbent native rule already permits root. A sudo exit before either point or
a first-hop challenge for a different principal reports that the daemon's native
Ask route is unavailable. Saving Ask does not
establish that route after native sudo permission has been removed. Restore the
reviewed Ask sudoers rule through the Machine's console before retrying.
The shared setup/reboot response validator requires
the Home-admitted `present_user` authority, original Actor and Custodian, exact
Machine/installation/encryption mode, and current Manage admission. Ordinary
Account automation cannot answer it, and no password becomes an Action operand,
operation record or saved secret. Uncorrelated desired-only writes remain
metadata-only; tracking must not manufacture physical effect intent.

Composed source tests exercise person answer, cancellation, currentness loss and
automation refusal. The semantic current-version UI response hook is implemented;
its rendered secure-answer consumer is still an integration handoff. Installed
native sudo/PAM and cross-platform interactive validation remain release checks.

Administrator-access approval preferences consume the shared P40 policy owner:
the admitted target Machine's preference overrides the global Action preference;
an ambient selected Machine or an Environment preference cannot select this
Action's policy. The existing settings adapter emits scoped `actions.policy.set`
intent and the shared permission-changing Allowed notice with an exact-key
Ask-first revert. Unsupported scoped placement or enablement requests are
rejected by that semantic schema, never converted into a global write. This is
the shared data contract; rendered Machine controls and warning composition
remain with their UI owners.

In 0.3 development source, the managed-Machine Add draft initializes a missing
enrollment identity from the provisioner's declared `enrollmentRole` and the
selected native facts' `guestPlatform`. A declared server with a Linux guest
drafts the dedicated `happier` user-service, Server role and Preauthorized mode.
The selected options' optional `enrollmentRole` overrides the descriptor role.
Personal or undeclared roles draft the existing personal user; a sandbox role
drafts the guest process. A server without guest-platform facts also keeps the
existing personal user. A declared server with a macOS or Windows guest keeps
the existing personal-user path and explains
that dedicated-user enrollment is unsupported there. The controller's platform,
provisioner id, transport and image name never select this default.
Explicit identities, including Ask, are preserved. This is one UI draft producer,
not a Protocol admission fallback; required identity validation remains in place.
For a dedicated identity, the configurator's "On the machine" section discloses
the `happier` user and edits administrator access (None, Ask each time,
Preauthorized) on that same draft. Ask
stays Ask until its named administrator validates against the identity schema;
Create stays disabled meanwhile and never falls back to the default. The new
administrator's password is not collected here: bootstrap asks for it once through
the managed-bootstrap establish response.

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
target. In unreleased 0.3 source, an original Account proposal whose retained
root is `approval.request.create` spends its reopened requester's ordinary Account
credential for the witnessed approved effect's HTTP calls. The proposal root stays
on the approval; it is not an HTTP credential for a different Action. Missing
requester custody or a mismatched approval refuses without borrowing the daemon's
Account. Home retains normal credential-epoch and resource authorization. Session
and Workflow-origin roots keep their existing signed owners; PAT replay checks
the resolved effect against the captured grant.
An admitted Workflow leaf retains its exact Run-start authorization root in the
approval origin and uses its own invocation request ID for correlation. The
installation signs the leaf input using existing custody; replay resolves the
admitted Run and invocation without admitting the original principal again.
Ordinary origins still require the root request ID, and protected original
envelopes retain exact digest, target and runtime-demand binding.
A forwarded child keeps its receiving Machine's proof.
A standalone CLI rejoining a deferred Agent approval's recorded outcome uses the
original daemon's approved-replay RPC to publish through its authenticated Machine
input, for both present-person and terminal credentials. Both retain the original
delivery ID instead of minting another attributed Session input. Terminal credentials
retain their automation authority and fresh consent restrictions.

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
snapshot, body and inclusion choice). Review-comment-only transactions also
work before the editable Session composer mounts, through its retained document.
The host resolves that Session's workspace and upserts through the workspace
review-draft owner used by editor, diff and Problems Ask. The operation keeps
unsent text and plugin attachments intact and never sends a message. The safe
composer Action's existing approval settings apply. The UI's direct use of that
same draft owner retains the same selection context before the composer mounts.

The unreleased 0.3 editor work adds `file.editor.save` and
`file.editor.resolve` through the existing scope Action family. They address the
answering client's mounted editor, optionally by `tabId`; an absent owner is
`unavailable`, not a request to open or load a file. Save reports `saved`,
`clean`, `conflict` or `unavailable`. Resolve accepts `useMine`, `useTheirs` or
`discardDraft` and reports `resolved` or `unavailable`. Automated callers keep
the normal approval default. The filesystem write Action remains a danger
Action, with `uiConfirmation: 'direct'` for a present user's Save; explicit
per-Action approval settings still apply. The mounted Save result settles at the
write receipt; its display refresh cannot hold the editor's write slot. Inline and upload saves carry the same
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
matching filters, and explicit `{selector:'sessions', addresses:[{serverId, sessionId}, ...]}`
selections. `session.open` requires exactly one result. The `sessions` arm is
appended last to `SessionTargetSelectorV1Schema` for stored Collection schema
widening. Explicit selections must be nonempty. The schema deduplicates by Home
and Session, and the exact-reference admission owner resolves every address
before any effect. The UI Account executor admits addresses from its own Home,
so callers submitting to several Homes must dispatch separately per Home.

Session settings Actions used by bulk Compose declare `sessionId` with
`cardinality: 'many'`. They include `session.permission_mode.set`,
`session.model.set`, `session.mode.set`, `session.config_option.set`,
`session.connected_services_auth.set`, `session.capabilities.set` and
`session.agent.transition`. The declaration lets the same executor resolve and
fan out those operands with the ordinary Action policies. See
[existing-Session field application](agent-transition.md#existing-session-field-application)
for how Compose plans those operations.

To retry from an agent, use the failed addresses from the fan-out result as
the next explicit Session selector, grouped by Home and Action operands. For
an engine switch, read the current Agent first and send a transition only if
the target still needs to switch. If message admission was ambiguous, reuse
the original message identity (`localId`, or the plugin’s `idempotencyKey`).

Fan-out starts all targets on a Home concurrently when each target's Machine
placement is known, including targets on the same Machine. Placement comes
from the authorized Session status projection.
If any target has unknown Machine placement, its whole Home runs sequentially.
The executor preserves positional child request ids and selection-ordered final
results. Hosts can pass `context.onSessionTargetResult` to receive the executor's
per-target progress event `{actionId, position, target, result}` as each target
settles, including typed failures and cancellations. The in-process callback
lets hosts update result rows directly and is separate from the Action input
and plugin Host Event contracts.
Hosts can observe the assigned child request through the in-process
`context.onSessionTargetStart` callback. Bulk Compose uses that request to
display the Home's managed Start operation while it is in flight.
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

In the development composer's To picker, **Matching** edits the shared Session
list filter and previews it through that inspection Action. **Use these** is
enabled only for complete, nonempty coverage. It retains the filter as draft
intent, not the preview's concrete rows. Sending prepares the then-current
selection; approval and its replay retain that prepared list. Choosing a filter
neither sends input nor grants access.

In unreleased 0.3 source, the SDK host-Action `execute` overload and UI Action
execution options accept `sessionAddress: ActionSessionAddressV1` when a caller
already holds an exact Home/Session result. This is a routing constraint, not a
selector or grant: the Action's declared operand must contain exactly one plain
Session-id string matching the address, and canonical resolution must yield
that same single qualified target before policy or effects. Selector objects,
reserved selector shorthand do not accept this option. Contributed-Action
references accept it only for a tuple returned by the host Session picker or
Session-list read to the same plugin in the captured Account lifetime, or
inherited from a containing Action's host-admitted `sessionTargetsV1`. A raw
plugin-authored tuple supplies neither. The canonical resolver binds the Action's
declared exact operand and checks the caller's authorized Session corpus before
producing that snapshot; the plugin never supplies the snapshot. The host retains its original
authorization anchor, captured Account, explicit credential fences and retirement
cancellation. CLI execution
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

An explicitly read-only contributed Action can declare a nonempty exact ID
array with `sessionTarget: { field: 'sessionIds.*', cardinality: 'many' }`.
The Session-target owner deduplicates IDs and admits each one on the request's
Home. It invokes the handler once with the admitted IDs and their host-issued
addresses. A Session-stamped Resource can admit only its stamped address.
The host wraps the authored result as `{ kind: 'sessionReadSet', result, failures }`.
For a targeted contribution, the operation's result schema validates the
authored `result` when the handler runs. The host returns the admission failures
alongside it. Each refused ID has the same `session_target_unavailable` result for missing,
foreign, and inaccessible Sessions. When every ID is refused, `result` is
`null` and the handler does not run. An Action schema can also offer another
selector that omits the array. That call resolves zero Session targets and
returns the handler's ordinary result. An explicit host-bound Session address
still requires a matching operand.

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

In unreleased 0.3 source, `review.start` accepts an ordered `reviewers` roster.
Engine entries carry their own model, Role, Profile, credentials and options;
repeating an engine creates distinct selections. Session and model entries use
the shared executable-participant contracts, and person entries carry the
canonical principal and required/optional request. Authored `steps` keep their own
roster and instructions; `then` selects `report` or one `fix` pass. Native single
reviewers retain execution-run completion. Mixed and staged starts compose
ordinary Workflow blocks and return Workflow completion. Each authored stage
runs once; the optional fix sends one request to the selected Session. The final
`review.get` reads persisted coverage, finding counts and human verdicts. Execution
can finish while a requested person's verdict is still pending. The Review record
owns these facts; callers do not infer them from the number of runs.
Existing saved and accepted Workflow definitions retain their authored loops
and effects, with historical engine-list inputs decoded at the Review owner.

The Workflow Review view requests `includeContentArtifact: true` when it needs
the Review record. Home then includes the exact caller-authorized Artifact in
that snapshot. Earlier Homes return the same aggregate and the UI opens the
record with the existing exact Artifact read.

In unreleased 0.3, `review.apply` also accepts a Review id and a destination
Session. Its existing executor reads the Review's canonical finding pages,
selects accepted findings through the shared acceptance owner, and sends one
verification-and-fix request through `session.message.send`. It does not start
another review. Historical requests carrying raw findings retain their existing
input contract and consume current persisted acceptance at the same owner.
The `{ reviewId, destination: 'prompt' }` arm prepares that same fresh prompt
without a Session or message delivery. Its result is `{ status: 'prepared',
prompt, commentIds }`; no currently accepted findings returns `unchanged`.
Clients copy the returned prompt through their existing clipboard owner or open
an editable draft with `session.authoring.open({ seed: { prompt } })` and the
ordinary authoring placement fields. Neither consumer formats findings again.
Agent and MCP requests ask for approval by default; a person's saved surface
waiver uses the existing Action approval policy.
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
expanding changed relations. Explicit `approval.request.create` uses the same
declared-operand binder as ordinary admission: a one-target scalar selector is
replaced with its reviewed Session id before custody, including a contributed
Action's declared field beneath `action.invoke.input`. Indexed operands retain
their exact reviewed slots. Replay refuses a missing or mismatched binding;
changing the manager cannot redirect an approved Goal or contributed Action.
Missing or incomplete selector backing returns
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

An explicit pass is `reply: { kind: 'pass' }` on `session.message.reply`, with
the receiving Session and original `requestLocalId`; an explicit answer uses
the same Action's answer arm. Neither is a new `session.message.send`. A
question raised to the person instead uses `session.user_action.answer` under
its own authority rules, including the admitted manager exception.

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

In 0.3 development source, agents, Session MCP and CLI callers can read
`session.handoff.status.get` and invoke the existing typed
`session.handoff.prepare_target.resume` on the retained target Machine. Resume
uses the observed `handoffId`, `jobId` and `expectedRevision`, plus an explicit
`attemptId`, through the same persisted recovery owner as Inbox Resume. It does
not start a replacement handoff; preparation, commit and abort remain private
lifecycle steps. The daemon's typed revision, identity and recovery failures
remain visible to callers.

For a sandbox preset, first run `machines.managed.acquire` and wait for its
managed operation to settle. Read the enrolled Machine id with
`machines.managed.get` and use it as the destination for the independently
admitted `session.handoff`. A failed acquisition leaves the source running.
For signed handoff between Machines, the receiving daemon applies the Session
isolation policy during the existing capability preflight. A bare destination
that requires a sandbox returns `handoff_target_requires_sandbox_preset` before
workspace preparation or source cutover.

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

In 0.3 development, `session.board.item.upsert` and
`session.board.layout.update` default to Allow on every exposed surface. The
existing current-Session admission still refuses an Agent's mutation of another
Session before approval. `session.presentation.apply` already targets only the
current Session and defaults to Allow. These are per-Action defaults, not a
declarative-Note classifier; explicit Actions settings still apply. Existing
network creation review, network widening, added host Actions and `copySource`
retain their contextual Ask defaults and ordinary waiver behavior. Hosts pass
those already-admitted consequence facts through the existing approval-policy
hook; changing a declaration does not erase them.

In unreleased 0.3 source, `foreign_session_html` is the policy audience for
authored HTML that someone other than the viewer wrote or can change: HTML in a
Session the viewer does not own; HTML widgets on a surface whose Account is not
the viewer, or on the Board or companion of a Session the viewer does not own,
whatever the widget's target; and, for every viewer including the owner, HTML
widgets on a widget surface (Project dashboard, Work Board, plugin-page or
core-page area) or from a saved widget definition that other people can edit
or have edited. "Other people can edit or have edited" is one server-decided
fact from the existing Artifact sharing reader (`readArtifactAudienceFactsV1`),
from the same grant-list read that says the Artifact is shared: an edit or
admin grant, a recipient's own read, or `writtenByOthers`. The server sets
`Artifact.writtenByOthers` in `updateArtifactTx` whenever an Account besides the
owner writes the header or body, never clears it (grant changes, revokes and the
owner's later writes, including restores, keep it), and returns it with the
owner's grant list. View-only grants and a public link cannot change the HTML,
so on those shares the owner's own HTML keeps the owner's ordinary policy unless
someone else wrote it. A read that cannot say counts as writable by others.
Two residuals are deliberate: copying someone else's HTML into the owner's own
new Artifact is the owner's own act and makes it theirs, and content another
Account wrote before the `writtenByOthers` migration is not marked, because the
server has no earlier record of who wrote it. The surface's own layout read
carries the fact (`othersCanWrite` beside `isShared`); a saved definition reads
it once per revision through the same reader and mounts once it is known.
Static HTML still renders. The id keeps its existing spelling.
It is not a transport surface: the mounting host supplies the class once, from
the Session access projection or the surface it read, never from HTML input.
The shared Actions policy defaults this audience to Off, returning
`action_disabled` without creating an approval. Own-Session HTML and HTML on
the viewer's own surfaces that nobody else can edit keep their ordinary policy. A Session's own
Board items are not reclassified by Session sharing: an edit recipient of a
Session can already prompt its owner's agent, which acts with the owner's
authority. The existing per-target Settings control and
`actions.policy.set` let the person choose Allowed, Ask first or Off for host
and contributed Actions; all normal target and authority admission still applies.
There is no Project override or browser-click requirement.
When this audience requests an Action with Ask first, the existing durable
approval origin retains its host-produced caller class. Replay restores that
fact into the same Actions policy context, so a later Off choice is honored
just as it is for an ordinary UI request; approving a proposal does not erase
its originating audience. This adds no separate replay approval check.

Resources use the same policy owner and Settings intents with the qualified
policy target `<pluginId>/resources/<localId>`. This is a permission target,
not a runnable Action or another Resource reader. Foreign HTML cannot read or
watch it by default. Explicit Allowed reaches the existing Resource transport;
Off or Default refuses it. Resources have no approval continuation, so their
Settings control does not offer Ask first; an API-authored Ask first returns
typed `approval_required` without opening a Resource or inventing a prompt.
The deliberate choices live in the additive
`actionsSettingsV1.callerSurfacePolicies.foreign_session_html` map. Allowing
this audience does not override global Off or normal authority admission.

In 0.3 development, choosing Ask first or Allowed in Settings → Actions restores
inheritance when that answer matches the Action's default for that surface.
The settings writer reads the shared approval policy, including contributed
Action declarations and the Source Control confirmation preference; it clears
only that surface's approval override or waiver and preserves neighbouring settings.
One exception keeps Allowed explicit: an Action may declare
`approvalPolicy.agentDefaultForInput`, an Agent/MCP Ask default for inputs with
one consequence only. `requiresDefaultApprovalFloor` applies it on the surfaces
that share the Agent default, Settings shows that the default still asks
(`approvalAskedForInput`), and choosing Allowed writes the surface waiver
instead of restoring inheritance. `session.spawn_new` declares it for
`managedTargetPlacement` (owner decision 2026-11-12): an Agent or MCP request
that places the new Session inside one of the person's managed targets asks
first, and the person can allow it on the Agent or MCP target of Create
session. The person's own app and CLI requests keep their surface defaults.
The daemon's placement owner (`prepareSessionTargetPlacement`) only consumes
an already-admitted request; it does not decide approval a second time.

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

In unreleased 0.3 source, a present-user App can discover and address other
connected Apps through the same Machine-scoped `answering-client.v1/` carrier
and target selector. The carrier must belong to its Account; it retains the
existing Machine-key encryption and does not require daemon execution. Discovery
includes the calling App and its nullable device label. An explicit `clientId`
may select that App or another eligible App. Theme Actions map a disconnected
selection to the typed `client_not_connected` result without fallback or a queue.
The existing Action executor decides admission and approval once; the receiving
App consumes that admitted continuation. Other reverse RPC methods retain their
authenticated daemon source requirement.

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

In 0.3 development, an Agent, MCP or CLI terminal Action with a Home-qualified
Session resource address uses the answering App’s viewed destination for that
Session. An explicitly addressed pane instance keeps its own workspace. Opening
a retained terminal returns a pane member and preserves its process and output.

Voice conversation (including History) and client-placed Settings operations use the generic answering-client
room even for a Session caller, so visiting Home or Settings does not withdraw
them. They use the same exact-client, sole-client and focus selection rule among
signed-in clients connected to the target Machine; absence returns `noClient` with
a `connect_client` recovery instruction. Composer and other view-specific
operations retain their exact Session routing.

In 0.3 development, workspace controls address the answering client's window,
not the invoking Agent's viewed Session. An explicit `clientId` still selects
only that eligible client; it never falls back to another window.

Notch controls, the display inventory, desktop window opens and
`session.open` with `presentation: 'overlay'` or `'window'` use the desktop
responder for the authenticated Home and Account. The existing answering-client
selector applies within that room. A background Agent Session can reach its
desktop even when a browser has focus. An exact `clientId` must belong to that
room. When the room is empty, the existing Action-specific absence result
applies. The mounted overlay and native window owners still settle their own
availability. Desktop routing requires matching 0.3 development components.

In 0.3 development, client-placed widget Actions route from their qualified
surface owner. Home, Project, plugin-area and core-page surfaces use the Account
answering client even when the invoking Agent's Session is in the background.
Session Board and Companion surfaces use their explicit owner's Session room.
The existing exact-client selection and typed absence rules still apply.

In 0.3 development, `ui.pet.choose` is the shared UI, Agent and MCP pet-selection
Action, executed by the answering client through the existing reverse dispatcher.
Empty input opens pet settings. `petRef` selects a built-in or Account-library
reference and clears this device's override only after the Account write succeeds;
`deviceOverride` selects a known local source or returns to inheritance. The
effect owner validates the current pet catalog and feature availability. Off,
Ask first and Allowed use ordinary per-Action policy; rejected or failed choices
leave selection unchanged. Account settings and device settings retain their
existing storage shapes.

In unreleased 0.3 source, `pet.import` imports a registry identity
(`source: { kind: 'registry', sourceId, itemId }`) or a Machine package locator
(`source: { kind: 'machine', machineId, packagePath }`, or `sourceKey`). Both
return `{ pet }`, the Account-library entry. Registry acquisition uses the
existing registry fetch owner; Machine acquisition uses the existing daemon
importer. The Account endpoint validates the sheet and enforces the library
quota. Registry origins retain only source and item ids. `pet.delete` takes
`accountPetId` and uses the existing delete endpoint for Undo. Agent imports
require ordinary Action approval; Store Add is the person's explicit approval.

The existing approval preview carries `PetImportPreviewV1` (successful daemon
validation and a daemon source-key preview handle). `readPetImportConfirmationV1`
projects that pending request for Add as Keep; `readPetImportOutcomeV1` projects
execution as `added`, `could_not_add`, `library_full` or `pet_sync_off` while
retaining the owner's error code. An added result supplies the Account entry
and a `pet.delete` Undo invocation; Undo leaves the original Machine package.
The existing approval result carrier is `ApprovalRequestV2.execution`; retained
review facts receive that same `execution`, and consumers read
`readPetImportOutcomeV1(approval.execution)` or `confirmation.outcome`. No new
Artifact or outcome store is involved.

The bundled Apache-2.0 `hatch-pet` skill uses `pet.import` for its final import.
`useCreatePetSession` opens the existing Codex session-authoring flow with its
ordinary skill inclusion. The skill checks Python, Pillow and WebP
on the chosen Machine before generating images. No model allowlist or separate
dependency preflight is added.

Hatch progress uses the existing command-result carrier: the command's final
stdout line contains `HatchPetProgressV1`, read by
`readHatchPetProgressFromToolResultV1`. `projectHatchPetProgressPlanV1` derives
the four checklist steps and the drawn pose count, retaining step and pose
failures. The shared Create entry uses the existing New Session seed's optional
`intro: { title, body, scene, suggestions }`. Its `scene` is a built-in
`HappierSceneId`; Create declares `ideas` and opens the full New Session page
through the seed navigation owner, including when Docked Composer is selected,
so its intro and attached hatch skill have their first-screen region. The existing draft presentation
exposes the intro for the shipped EmptyState, while unseeded Sessions retain
their existing first screen. This host-only addition does not change the plugin
New Session seed schema. It adds no Artifact type or Todo schema.

In 0.3 development, `links.openExternal { url, clientId? }` opens an HTTP(S) link
on the answering app through its existing platform opener. Explicit Provider,
connected-account, documentation, terminal and content links, including plugin
`Action.OpenExternal`, share this Action's policy admission. It uses the generic
answering-client route even when the invoking Agent's Session is in the
background. Its safe/write declaration uses an explicit configurable `egress`
agent approval default, shared by MCP, and direct present-user confirmation. MCP and Voice discover
`links_open_external`; the CLI exposes `links open-external`. Voice explicitly
requires approval by default through `requiredSurfaces: ['voice']`, because it
is a non-agent surface and does not inherit `agentDefault: 'egress'`. Explicit
Require/Waive preferences still apply, and the URL stays in live-only custody. An absent client
or refused operation opens nothing; there is no
headless opener or automatic retry. OAuth query and fragment values stay in
live invocation custody and are omitted from approval Artifacts and Action
observations. A platform refusal returns `external_link_unavailable`; cancellation
or denial before opening has no outward effect. A successful open retains its
status acknowledgement if cancellation arrives during the platform call.
Automatic continuations of already-admitted authentication
Actions retain their existing owners. The separate mounted
`browser.view.openExternal` still opens the current URL of its exact Browser view.

In 0.3 development, a visible Session Browser discovers daemon-owned views through
one initial `daemon.browser.view.list` and a parked `daemon.browser.view.watch` on
that Session's native view membership. The broker publishes approval-executed
opens even when this app has no local Action operation snapshot. Watch uses the
same Account-scoped Machine transport and discovery projection as list; hiding,
unmounting or changing scope cancels its wait. Each presented Browser host has one
wait, independent of its number of native views. Older daemons retain one-shot
discovery and the existing visible retry path; no polling fallback is introduced.

In 0.3 development, Browser extension Actions choose a Machine before a saved
profile. `browser.profiles.available` resolves those choices through the existing
`browser.extensions.list` Action, including saved profiles with no extensions.
Install also accepts a new profile name; update, enable, disable and remove use
existing profiles. List can omit the profile to include all saved profiles. A
daemon reply without profile inventory reports unavailable choices rather than
an empty inventory.

In 0.3 development, `browser.profile.logins.import` uses one closed `kind`-based
Action for a selected managed profile. Public operands contain Machine, Session,
view, profile and source selections; public results contain per-record metadata.
Cookie values travel only through private Machine RPC, using the existing
Account-mode transport. E2EE exchanges remain encrypted toward Home; Plain
exchanges are server-readable and the confirmation must disclose that fact.
The Session agent and anyone able to drive that browser can use imported logins.

The managed Browser overflow menu exposes this Action as **Import sign-ins…**.
`BrowserSurfaceHost` supplies the exact destination to `BrowserLoginImportSheet`;
the sheet chooses cookies from a selected Machine/profile/sites or personal
passkey references, then invokes the existing confirmed Action. Source and
destination Machines may differ. Its disclosure states that the Agent and other
drivers can use imported sign-ins, and explains Home-readable Plain transport
and same-OS-user access to active software keys. The sheet reports per-record
outcomes and renders the nonzero-counter refusal as a reason to sign in normally.

Native cookie discovery runs only when the import confirmation opens. Source
discovery, source reads and destination insertion require Machine Manage through
the canonical RPC route policy. The standard Firefox profile locations on
Windows, macOS and Linux are supported for SQLite schemas 10–17. Chrome,
Chromium, Edge and Brave profiles are listed from each vendor's standard root and
`Local State`; the chosen profile's `Cookies` database is read from a private
temporary copy because the running browser locks it. Decryption uses only the
person's own OS authorization, acquired once per read and only when a selected
record needs it: macOS Keychain Safe Storage (v10, the OS shows its own
prompt), Linux `peanuts` (v10) or the secret-service/KWallet key (v11), and the
Windows DPAPI-protected `Local State` key (v10). Windows app-bound v20 records
are skipped with `app_bound_encryption`; the existing optional `reason` carries
the same actionable English copy as the import UI: Chrome locks these cookies
to Chrome; import from Firefox, or sign in once in Happier's browser, which
remembers the sign-in. Edge is not offered as an alternative: Microsoft's
[Windows Edge policy](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/ApplicationBoundEncryptionEnabled)
documents app-bound encryption from Edge 127, enabled when unset. Happier does not elevate, call Chrome's
elevation service or inject into Chrome. A refused or locked key settles as
`source_locked`. `chromiumCookieSource.ts` owns this adapter; OS tools run
through `execFileWithDeadline` with argument arrays. Unknown formats and Safari
source stores return typed unsupported results.
Partition/container cookies are skipped explicitly. Source stores are never
modified and only the chosen profile and sites are queried. The destination is
managed Chromium through CDP; a system WebView is unsupported. Imported data
shares the existing ephemeral profile's Session-close, logout and explicit-purge
lifetime. Source logout does not revoke a copied login. Partial/unknown native
outcomes are visible and never automatically replayed. Real OS/browser and
cross-Machine login validation remains with RU2's composed QA wave.

The same Action's `kind: 'passkeys'` accepts Saved Secret references. A private
client read opens those resources through the existing Account-mode owner, then
sends the actual selected key material only through private Machine RPC. It does
not return an assertion or put private keys in public operands, results or
observations. The standard Action approval decision supplies activation consent;
there is no second import approval owner.

Passkey ingestion currently accepts one Chromium CDP resident `Credential`
export through `secrets create NAME --passkey-format chromium-cdp`, using the
existing hidden stdin adapter and `secrets.create` resource writer. It requires
explicit backup flags and preserves the RP, credential and user identity. Native
activation validates PKCS#8 ECDSA P-256 keys. Extension payloads, nonresident and
nonexportable credentials are unsupported. CXF exports omit the required backup
metadata and are unsupported rather than given invented flags. See the
[CDP credential contract](https://chromedevtools.github.io/devtools-protocol/tot/WebAuthn/#type-Credential).

Only credentials with a zero counter activate currently; native `-1` counter
semantics keep assertions at zero. As an accepted limitation, nonzero source
counters remain in custody and receive `source_format_unsupported` with the
reason `this passkey tracks a usage counter` before native effects. The person
keeps normal sign-in for that site; no counter-writeback path is installed.
Chromium enforces RP/origin binding. Active keys follow the managed profile's
purge lifetime; closing all native targets also removes activation. A failed
clone into a newly opened target can require explicit reimport. J4/J5 loaded
Chromium login, wrong-origin and purge checks remain owed to RU2's shared QA wave.

Scoped exemption: non-HTTP links such as `mailto:`, `tel:`, app deep links and
`file:` links in Markdown or other UI remain client-local person actions. They
do not use `links.openExternal`; their existing platform behavior is unchanged,
without a new scheme policy or another opener.

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
The status filter uses the current approval lifecycle schema, including
`executing` and `outcome_unknown`; these selections do not broaden to all statuses.
The existing page bound is 1–100 matching entries (default 32). Optional
`actionId` filters built-in approvals by Action id; plugin Action approvals use
`action.invoke`. `workflowRunId` selects open requests whose admitted execution
origin caller is that Run, including participant invitations and external plugin
Actions, alongside Discussion-result publications correlated by their admitted
return binding. This selection uses the authenticated portable Home identity,
so a request created under another device's local profile id remains discoverable;
a different Home or Run does not match. It defaults the status to `open`. The Run page uses that same
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
In 0.3 development, an untargeted CLI Get or List uses the signed-in Account's
Artifact store on Home and works without a daemon.
Both reads are discoverable through Action search. Their
approval-control admission remains separate from deciding or executing an
approval; listing pending work grants no decision authority.

Both policy-generated and explicit approval creation resolve the requesting
Session through one owner: the calling context first, then valid transcript
origin metadata, then the target Session. Supplied transcript metadata cannot
replace an already known caller.

Successful plugin-install and Discussion approval creation consumes the Artifact
returned by the create acknowledgement, including an existing same-id winner;
a conflict fetches the incumbent. Live-only target settlement uses its admitted
executing request and the existing transition writer, without an extra pre-settlement
read. Deployment Environment removal selects its open approvals by the existing
private subject index before reading their bodies; body admission and the
open-status compare-and-swap still decide each cancellation.

Restricted API-token reads also enforce the approval subject's granted Session
or Machine, using private headers to narrow body reads and the admitted body to
authorize disclosure. A Machine envelope supplies routing, not authority over
every approval in the Account. Session subjects use the existing authoritative
Session-to-Machine resolver for both pre-hydration list admission and exact get;
the recorded execution Machine neither grants nor excludes a Session after it moves.
Private headers distinguish subject kind from the requesting Session, and strict
body correspondence checks that hint. Older headers without the hint may describe
either subject; listing excludes them only when neither possible subject is granted,
and the admitted body still decides disclosure.
Unknown or ungranted subjects are withheld, while unrestricted backend reads
retain their Account scope.

In 0.3 development source, public approval reads retain automatic-check trigger
and Run references, but omit admitted subjects, including each selected trigger's
retained subject, and private human-decision custody. Private Artifact reads
retain those facts for the existing approval continuation.

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
resumable Session. The authenticated Action owner accepts the decision; the
Artifact retains its history. The approving app delivers the decision to the
execution owner, or the daemon retains custody. `deriveTranscriptInteraction` preserves the access
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
Homes without draft synchronization retain local-only deletion. An in-flight
deletion keeps the Account and draft captured at invocation when the composer
opens another draft, so the acknowledged tombstone also removes the original
local copy.

In unreleased 0.3 source, a standalone CLI's blocking Account Action with
live-only private input retains that input in the original invocation. An
authenticated `approval.request.decide` sends only the exact approval and Home
identities through the existing Account RPC relay to its request-id-bound CLI
endpoint. The endpoint is registered before publication and waits for the
original blocking waiter before delivering live decision authority. Generic
Artifact writes, including a stored `approved` label, cannot authorize execution.
Current credential and immutable-subject checks precede the existing execution
claim and settlement. Distinct duplicate origins are refused, never selected by
focus. No private operand travels in the decision transport or durable approval;
there is no daemon, stored-consent or plaintext-recovery fallback if that CLI
has exited. This development contract does not claim loaded-runtime validation.

The same rule covers live contributed Actions and Execution Run host Actions:
stored approval labels never release their waiting execution. Their original
hosts register the waiter before publishing the Artifact, so an authenticated
decision can arrive before the creation acknowledgement. `approval.request.decide`
delivers the live decision through the existing target owner or Session RPC;
the shared coordinator rejects a substituted subject before releasing custody.
The host approval page routes that RPC through the Home its Artifact reader
actually opened, not the creator's device-local profile id in the stored subject.
The original invocation retains final currentness and requester-confirmation
checks. Rejection, cancellation and completed execution history can settle
observations without starting an effect. These are unreleased 0.3 source contracts.

Ordinary public sign-in link Copy, Share, QR and Open, route-only navigation,
and local draft/result disclosure are client presentation. The public member
sign-in URL is already readable through `teams.identity.connections.list`;
these controls need no additional Team business Actions. Invitation bearers
retain the separate human-only live-result custody described below.

## Settings column filters (0.3 development)

`settings.column.filter.get/set/clear` address the answering client's presented
column by exact `{ column, serverId, accountId }`. Protocol's
`actions/scopeActionFamily.ts` owns the strict input/result schemas;
`apps/ui/sources/sync/ops/actions/scopeActionFamily.ts` selects exactly one
current, presented registration from `useSettingsColumnFilter`. Hidden, retired
or ambiguous owners return `client_surface_unavailable`; invoking a read does
not open a page or load its corpus.

The current development contract admits `column:'store'` and the Plugins column
alongside the existing Settings columns. Store binds its held kind, source,
category and job facts through the same condition registry. Kind/source conditions
narrow catalog demand before acquisition; query text goes to the native list
owners. Unfinished pages or failed sources keep coverage partial even when every
loaded row has known fields. Get returns held conditions, `matchedCount` and
`coverage`, plus `searchQuery` whenever that mounted owner supports text search,
including the empty string. A filter-only owner omits the property. There is no
query opt-in. Set replaces `filters`; omitting `searchQuery` preserves the
current query. Clear removes conditions only. To clear both, use Set with
`{ filters: {}, searchQuery: '' }`. An unsupported query is refused with
`client_control_unavailable` before any conditions change. Inputs and Actions
write the same transient query/condition owners; these are not Account settings.
The existing safe client-view Action policy remains authoritative.

MCP Got it and Skills Not now are device-local presentation dismissals through
`capabilityDismissalState`, not business Actions or synced preferences. Skills
Turn on still commits `skills.rules.set`; only its successful admitted receipt
settles the local first-run decision. Empty, refused or failed commits retain
the offered selection. No `settings.capabilityHome.dismiss` Action is added.

These are unreleased 0.3 client contracts. The inspected immutable UI 0.2.19 and
CLI 0.2.17 stable/preview source and moving 0.2 predecessor do not expose this
filter Action family. Unsupported hosts refuse unsupported fields; there is no
query-less development-reader adapter or fallback writer. See
[compatibility](compatibility.md#sdk-protocol-evolution) for the direct-cut rule.

## Canonical owners

In 0.3 development, shared Action input validation returns `invalid_parameters`
with `details.issues`: each schema issue identifies its input `path`, validation
`code` and a safe `message`, plus `expected` for type failures or `acceptedValues`
for literal, enum and discriminator failures. Bot shape failures additionally expose a closed
`constraint` fact naming the geometry rule and its fixed threshold or mouth mood;
the validator owns this vocabulary and the projector rejects input-bearing extras.
Agent spawn authoring and intercepted inputs
use the same projection as ordinary Action admission. Diagnostics omit rejected
values, unknown-key lists and custom validation prose. Messages use schema-declared
validation facts; custom refinements retain a generic message alongside any typed repair facts.
The existing Action failure envelope carries these details through Agent and MCP tools.

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

In 0.3 development, a trusted person's direct app UI press is their decision:
the shared approval owner does not add a second approval card from the Action's
automation safety default. Designed local reviews and destructive confirmations
remain declaration-owned. Account and profile Ask settings govern automation and
other-person requests; the person's own UI admission answers those settings too.
Agent, CLI and MCP callers retain their declared defaults, and unknown
surfaces fail closed. Present-user UI authority comes from a host-mediated control:
`Action.Control`, or a host-created committing control with a declarative Action
binding in matching 0.3 development SDK and host source. The bound controls are
Menu items, PropertyList editors and name tones, RelationList additions and removals, IconButton,
Form submit and Toggle. They share Action.Control's invocation owner; registering,
changing props or editing a draft never supplies a gesture. External credentials
and Session RPC authority remain excluded. A binding declares one Action reference
or a named map of references, then preparation selects a declared key; the shared
host owner rejects an undeclared selection as `invalid_action` without execution.
RNW author fixtures reuse that binding lifecycle through the public semantic
adapter's explicit `actionBindings` option. Their configured test executor owns
test decisions; a successful fixture press does not establish runtime UI authority.
Home may relay that
exact Account UI press to its Machine with the same present-user default. A raw plugin
`hostApi.executeAction` call retains plugin/automation authority, including when
a plugin click handler starts it; declaring a direct UI policy does not upgrade
that caller or its nested Actions. Action declarations retain their local confirmation
metadata on UI as well as their separate automation defaults. Pressing
**Install & Trust** on a plugin listing confirms the selected source and
Machine for a person's first installation. A completed in-flow confirmation consumes the
default for that exact operation. Saving an ordinary
document through `artifact.update` is a direct UI edit: Save writes the revision
without another approval card, while automation retains its Ask default.
A new consequence discovered at preflight
still asks in place through the existing inline approval decision. Internal
steps of the reviewed operation consume its parent admission, rather than asking
again; predeclared children's explicit Require is included in the parent review.

In unreleased 0.3 source, the executor admits a bound `presentUserConfirmation`
after normalizing the operation input. Its input digest, request, Account, Home
and target must match the admitted invocation; the same in-process confirmation
object cannot approve another execution. A carried confirmation enters the
existing request/operation owner before review admission and consumes its
active-join and retained-receipt semantics, not a new durable replay ledger.
`executor/approvalReview.ts` records the
same `presentUserApproval` used by an authenticated deferred decision. A native
review has no Artifact id and does not manufacture an approval Artifact.
A standalone terminal CLI spends its exact in-flow confirmation through this same
owner while retaining its automation authority floor. Session, Workflow and native
credential children retain their automated origin; this does not grant fresh approval
reviewer eligibility.
For an own-UI press that still needs review, a receiving executor without a native
confirmation presenter returns its prepared review and `reviewDigest` with `action_interactive_review_required`.
The originating UI presents that review and binds a fresh invocation's confirmation
to its digest. An Action whose review binds a proof to the request id
(`keepsReviewedRequestOnConfirmV1`: Session creation's sandbox acquire, a Sync
destination proof's operationId) replays the reviewed request id instead, so the
proof the person saw is the one that runs. The receiving executor recognizes the press from the existing
Home-admitted Account binding and rebuilds the review for a digest-bearing confirmation,
refusing a changed digest with the fresh review before any effect. Existing valid
input-bound in-flow confirmations without a review digest retain their admission.
A request still requiring confirmation receives the review-carrying refusal.
A digest without a readable preview
keeps the refusal in the UI. This is unreleased 0.3 behavior; no self-approval
Artifact or caller-asserted presentation marker is required.
For a compact deployment rollout, the app sends the same intent on confirmation
and carries the reviewed operands in the private requester invocation. Home
binds the new request to the first request's signed candidate and exact Artifact
revisions. The controller opens those revisions and rebuilds the whole review,
including the compact intent. Changed intent or pins require a fresh review.
The approval policy owns this disposition for immediate execution, prepared runs,
native forwarding and contributed Actions. Execution placement does not change a
person's caller or authority, and preparation does not create a second confirmation
requirement. A mounted presenter and a headless receiving Machine consume the same
prepared review; digest-bearing confirmations are checked against that review in
both cases. Actual missing secret values, target choices and binding choices retain
their existing input-acquisition flow: a Boolean confirmation cannot supply them.
The originating UI renders carried reviews through the same family presenters as
retained approvals, whether the review appears in a step or in a dialog. Host-specific
annotations supplement those facts instead of replacing them with Action API hints.
Human consequence copy belongs to the Action's `approvalPresentation.summary`.
Without a domain summary, the review uses the Action title; agent input instructions
are never the person's confirmation text.
In unreleased 0.3 source, approval field presentation consumes declared reference
names and option labels through the shared Protocol projector and UI card. An
unreadable reference shows Unavailable; its exact identity stays in the existing
Technical details disclosure. Home Account references, such as the proposed owner
of a new Team, use the Home directory read with the viewing approver’s credentials.
Domains declare explicit null clears in the private, in-process
`approvalPresentation.clearInputPaths`; an omitted operand has no clear
row, and a nullable schema alone does not declare a clear. The ordinary field row
translates “Clears <field>”. These declarations do not change stored approvals or
the serialized Action catalog. `technicalInputPaths` retains transport and revision
operands under Technical details. The same declarations, field labels and choices
apply inside structured operations; reference declarations receive the immediate
parent alongside the complete input. `homeSettingMapInputPaths` declares maps of
Home registry entries, including supplied null clears; the viewing Account's
existing registry reader supplies each entry's label. A technical path can remain
a string, or carry a variant condition such as
`{ path: 'intent.groupId', when: { path: 'intent.kind', equals: 'group_create' } }`.
The condition addresses one discriminant in the complete review input; other
variants retain their existing reference reading.
In unreleased 0.3 source, a member's Source clone with an unprepared destination
returns `workspace_private_checkout_review_required` and the native owner's
`destinationReview`. Open carries the prepared private path through this same
review and digest. The UI shows that destination and resubmits the reviewed
arguments after confirmation, including when an initial Open confirmation
preceded native preparation. Cancel sends no replacement request; the native
owner still requires the member's exact prepared path on resubmission.
Private prepared admission retains the answered review through operation
dispatch. Internal children consume the existing reviewed-parent issuer without
another per-step policy read; confirmation does not replace their ordinary
credential or target admission. Calling those Actions directly remains a new
operation with its ordinary approval policy.

In unreleased 0.3 source, `actions.policy.get`, `set` and `reset` also accept an
exact Machine or Environment `scope`. Protocol's `actionSettings.ts` retains
these deliberate choices in `actionsSettingsV1.scopedApprovalPreferences`, keyed
by Action id and scope. An exact scoped Ask-first or Allowed choice overrides
the person's own global confirmation preference. If the effective inherited
Team, Group, or shared Project approval profile asks on that surface, it still
asks even when the person has saved Allowed on the Machine or Environment.
The saved Allowed applies again when the inherited Ask no longer applies.
The Team profile is a default that the member's Machine applies, and the member
can choose another approval profile.
Default removes only the selected audience's scoped choice. Scope comes from
host admission at effect dispatch. Enablement, authority, currentness, and
independently required reviews still apply.

The semantic Account Settings merge/CAS owner preserves scoped rows omitted by
an older writer; current writers clear them explicitly with an empty array.
The existing 64 KiB serialized Actions Settings boundary applies to the complete
candidate, including UTF-8 bytes. An oversized choice returns
`settings_too_large` without changing stored rows. CLI snapshot and UI Settings
normalization retain unchanged keyed rows; changing one scope does not wake
exact CLI subscribers for sibling scopes. Explicit orphan-row
removal uses `actions.policy.set` with `change.kind: 'scoped_approval_remove'`.

Declared `uiConfirmationForInput` retains the designed in-place product review.
Otherwise `uiConfirmation: 'policy'` retains local confirmation. Irreversibility
alone does not add an approval card to the person's own UI press. The routing
owner reports local reviews separately as `uiConfirmationRequired`; the existing
UI host presents them without creating an approval Artifact. This retains the
existing irreversible product-confirmation default unless the declaration is
`direct`. Missing UI presentation refuses the review instead of producing an
agent-approval card.
A saved Ask-on-UI preference requests this same local confirmation, including
when the Action's default is direct. A scoped choice takes precedence over the
global preference. Prepared children's required reviews fold into the parent's
confirmation and preview; waiving the parent cannot waive a child's review.
A completed confirmation for that exact Action consumes this default once.
A present-user UI press keeps this same default on the executor that Home
admitted that exact Account press for (the signed binding names the Action and
carries no Session or Workflow origin). Terminal credentials cannot claim UI;
other external origins keep the executor's floor.
A host-discovered consequence uses `defaultUiConfirmation`
through the shared approval owner and still asks unless that exact consequence
was already confirmed or the person waived it.
In 0.3 development (owner ruling 2026-11-15, option A), a bare own-UI press
admits only the pressed Action and that Action's own host effects (for example
Triage Save defaults writing a Profile). When its plugin reaches another
contributed Action, such as the selected Tasks source for Create, Edit or Status,
that Action's own policy decides as the person's UI press in
`executeContributedAction`. A Happier-task write is direct by declaration. A
designed confirmation (Linear, GitHub), an explicit Contextual UI or Trusted
plugins Ask, all ask. Off on either row refuses before any effect. A review
admitted before a later Off still finishes; Off applies from the next press.
A required review never creates a self-approval
Artifact: the child refuses with `action_interactive_review_required`, the plugin
passes it up, and the pressed Action's executor returns its own review and
`reviewDigest`. The digest-bound re-press is a completed review, so the same
child is admitted once without another policy read. A Machine-placed source
receives `presentUserIntent: 'confirmed'` only for such a reviewed child. A bare
press keeps its UI origin there, and the receiving daemon's own policy decides.
In unreleased 0.3 source, reversible own-Session Board upserts and layout writes
default to Allow on Agent, MCP and CLI surfaces. A visual with no network or
host Actions therefore needs no approval by default. Visual preparation retains
capability and revision checks; explicit Ask or Off preferences still apply. Ask first creates one
request before any write. A person's reversible app edit also remains direct.
An own-Session write that widens network reach, adds host Actions, or uses
`copySource` instead defaults to Ask, including a present-user UI write. The
existing visual-admission owner compares capability-bearing updates against
the exact current Item/revision and supplies consequence facts to the shared
Action policy; it does not decide approval itself. Unchanged or narrower
capabilities keep the reversible UI default. An explicit per-Action/surface
waiver remains authoritative. Copying another Session's visual asks because
the independent copy gains its destination Session's host access.
In unreleased 0.3 source, a Session agent with `current_session` or `led_subtree`
access may copy from any Session the Account can read into its own Session.
The Session-scope owner refuses another destination with the existing
`current_session_only` cause. Account-wide agents and present-user UI copies
retain their existing scope; source reads still require ordinary read authority.
Visual preparation captures the effective content and network policy in the
approved input. Replay uses those exact operands and the item's domain revision
check; an unrelated change to the creation setting does not invalidate it.

In 0.3 development source, `widgets.item.network.set` compares the requested
guest network with the instance's saved override or inherited saved definition at the common Action
classifier. Equal or narrower access keeps the direct default; adding sites or
opening access defaults to Ask. With neither saved override, the renderer's
declaration is the ceiling, so adding an explicit restriction narrows it. The renderer continues
to intersect the override with its declaration. Explicit per-Action/surface
Ask or Allow preferences remain authoritative.

For a transcript-origin `session.board.item.upsert` at Ask, that request's
approval card is also the visual's single transcript occurrence. It stays at
the original tool-call position and reads the approval Artifact's live status:
open, approved or executing keeps the request pending; rejected is denied;
canceled is expired; and an `approval_stale` execution keeps the stale outcome.
After approved replay reaches `executed`, the card consumes the persisted
`execution.result` through the same exact Session/id/revision acknowledgement
recognizer as an Allowed call, then presents the same live occurrence and
Show here / Open in panel controls. Replay does not append a second transcript
entry. This in-place transcript presentation supersedes the general deferred
receipt-only presentation only for this Session-visual surface; the approval
Artifact remains the decision and replay owner, and the Session record remains
the visual-content owner.

In 0.3 development source, the successful settlement also enriches the existing
native result's admitted transcript association. It retains the original receipt
Artifact id for correspondence, not as a visual read grant. The native transcript
and Artifact writers retain the binding and settlement independently, covering
settlement before the native result and cold replay without appending a message.
Fork seeding and public discovery consume that same settled association; they do
not add private approval-Artifact readers or make approval decisions themselves.

Present-user Session responsibility and lead assignment, Home restart, local
runtime restart and remote-host relay restart use the direct UI default because
they are reversible. Public-link creation also uses that default. Document
deletion uses the shared confirmed dispatch after the artifact surface's
designed consequence review; its generic default still applies without that
review. An explicit document-delete Ask stays with the existing mounted approval
handle instead of automatically navigating to the Inbox. Prompt-library deletion and document-link revocation use the executor's
single canonical confirmation. Settings → Actions can require approval on each
Action and surface in either case; Agent and automation defaults are unchanged.

There are no non-waivable confirmations (owner ruling 2026-10-29): every
declared default, including Team credential disclosure widening, is an Ask the
user can change per Action and surface in Settings → Actions.
Default in-place UI confirmation and app-owned approval replay share the same
present-user host predicate, excluding external credentials, external execution
authorization and Session RPC authority.

Connected-account authentication uses the shared direct present-user UI
rule for starting, continuing, submitting and cancelling an attempt. The
service's OAuth, device or credential step owns the connection flow. Explicit
per-Action Ask settings still apply, and Agent, MCP and CLI authentication
calls retain the danger default.

Connected-account defaults and names, Resource-purpose defaults, pool creation
and edits, member add/edit/removal, switching and ordering, pool defaults, and
the user's entered subscription price use the same direct present-user UI
rule: explicit Ask
still asks, and Agent, MCP and CLI requests retain their approval defaults.
Credential replacement, account revocation, pool deletion, quota reset and Saved
Secret changes follow that same UI rule; their automation confirmation defaults
remain unchanged. Provider Save and Test likewise execute the person's press
without creating a default approval Artifact.

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
For a separated member, this read runs through the existing native filesystem
operation owner, so home expansion and directory observation use that member's
OS identity. It does not inspect the custodian's home on the member's behalf.
An unconfirmed UI directory-preflight reply is a pre-effect `spawn_failed`
with launch code `RPC_TRANSPORT_UNAVAILABLE`; an original `RPC_OUTCOME_UNKNOWN`
remains diagnostic evidence about that read, not about Session creation. The
preflight issues no create and has no spawn operation to observe. A lost reply
after the actual create was issued still retains the existing pending/unknown
settlement and creation key; this classification adds no retry or effect replay.
In unreleased 0.3, after an uncertain Session creation invocation retires, and
on a later operation get/wait, the admitted creator observes birth once through
its existing tag/correspondence and nonce readers. An authenticated Session,
including an archived or inactive one, settles creation successfully. A missing
row with a pending or unavailable nonce remains uncertain; only the nonce
owner's typed refusal settles failure. Observation does not restore, relaunch or
send input. A later failed turn cannot undo birth. Initial input may remain
unconfirmed: the person can open the created Session and resend it. Explicit
same-key resume retains its launch/input completion behavior.
In 0.3 development, a terminal pre-effect refusal stays in the UI's existing
local spawn custody under its Home, Account, Machine and request identity. The
canonical manual-attempt waiter returns that typed outcome in the same browser
without creating a native operation; the draft keeps its prompt and releases
the refused launch identity so a new Send can create a fresh attempt.

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
the exact answering app socket. An available reverse-dispatched list result
can include `answeringClientId`, eligible `answeringClientIds`, and
`answeringClients` with each candidate's device label when advertised.
Use socket ids for follow-up calls before they expire on reconnect. All three
operations follow the shared
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
receive this confirmation. Account Ask settings govern requests made for the person;
the person's own verified UI interaction does not create a self-approval request.
An explicit Ask-on-UI choice still presents local confirmation before execution.
Home admission owns cross-person authority; “own UI” skips only self-approval in the invoking Account.
Explicit `approval.request.create` records the requested approval's deferred flow
even on own UI; declared live-only result custody retains blocking flow. Its
recorded invocation authority and origin stay unchanged.

Source-control writes follow the same rule, and the Action policy is the one confirmation owner
(a caller-owned dialog would double up with the executor's designed confirmation).
Reversible or recoverable writes (stage, unstage, commit, commit revert, undoing the last commit,
branch create and checkout, remotes add, edit and remove, publishing a branch, worktree create,
opening a pull request, publishing or initializing a repository, continuing a merge or rebase, stash
create, apply and pop, fetch, pull, push) declare `approvalPolicy.uiConfirmation: 'direct'` in
`scmGitActionSpecs.ts` and have no dialog of their own. The shared direct app-press
rule also covers irreversible writes (discard, merge, rebase, skipping a rebase
step, aborting a merge or rebase, stash drop, worktree removal and pruning).
Approval requests from automation use the Action's plain title and `approvalPresentation`
summary. UI callers must not add a second dialog in front of the Action.

Remote pull and push are `direct` by default, and two inputs make the executor's one in-place
confirmation apply. The person's 0.2 `scmRemoteConfirmPolicy` preference (Source Control settings;
`always`, `pull_only`, `push_only`, `never`) is the UI default confirmation of those two Actions:
the UI host projects it into the Actions settings it gives the shared router
(`resolveExecutorActionsSettingsV1` in `sync/domains/settings/actionsSettings.ts`, also the source of every UI
prediction), so the router asks for a present person's UI press unless the Action is set to Allowed or the caller already
recorded the person's answer to this exact press (`confirmedByPerson` on the SCM facades selects
the shared `.confirmed` dispatch; used when a pull choice dialog or a pull-then-push already asked). A force
push with lease retains its declaration for automation; a direct UI press follows
the person's Source Control confirmation preference.
`executeScmRemoteOperation` and its callers hold no confirmation; a declined press returns
`declined` and stays silent, and the pane's busy label ("Pushing to origin/main…") starts only when the
admitted Action reaches the Machine (`onDispatched`, a surface-local notification of the UI SCM terminal),
so it never shows behind the dialog and never for a decline or a waiting approval. The shared
mutation runner (`runSessionScmMutation`: merge, rebase, abort, remote edits, commit undo) uses the
same notification: its operation lock waits `queued` (`deferRunning`) until `onDispatched`, and every
other direct SCM caller (commit, stage, revert, stash, pull-request compose) treats a declined or
waiting result with `isScmActionNotRun` instead of an alert. Settings → Actions
reads the same resolver, so a `Default` pull or push row says it asks because of the Source Control
preference. Account Ask does not turn the person's own press into an approval
request; an explicit Ask-on-UI choice uses local confirmation. Not confirmations of the write itself, and so
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

In 0.3 development, every `approval_execution_outcome_unknown` result is built by
`projectApprovalExecutionOutcomeUnknownV1` (`packages/protocol/src/actions/actionExecutionResult.ts`).
It keeps the producer failure's `failureCause`, `details` and `requestId`, records the
producer's own code as `details.reasonCode`, and never carries a no-effect fact
(`effectAttempted` survives only when it is `true`). The protocol executor, the CLI
target-action receipt settlement and recorded target receipts use it, so the cause a
person sees after an unknown outcome is the one the effect produced.

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

In 0.3 development, an approved agent theme try-on reaches its original
transcript card through the result message delivered to the originating Session.
The collector matches the approval Artifact id from the tool result to the
Session receipt. Grouped proposals share the final tool row, and Keep addresses
the option currently active in the device's preview owner.

In unreleased 0.3 source, failed or cancelled `machines.command.run` approvals retain the
command result's exit code, stdout, stderr and optional truncation flags for authorized
approval reads and resumed callers. The strict command-output schema excludes arbitrary
detail bags. Safe Action Events and before-check refusal summaries carry outcome codes,
not this private output; finite setup diagnostics keep their metadata-only contract.

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

In 0.3 development source, a requester Home read that fails before external
Action input is opened retains `project_requester_home_unavailable` through the
daemon relay, HTTP 503 response, and UI/CLI/MCP Action failure. It is distinct
from `storage_unavailable`: no Session input was enqueued or Action effect
dispatched by this pre-open refusal. A prior successful turn does not establish
current Home availability. Authentication or revoked-custody refusals retain
their existing envelope errors; they are not reclassified as a Home outage.

The final requester currentness check before runner launch retains a classified temporary
Home outage as the bounded `requester_home_unavailable` spawn detail. The Session-spawn
Action projects that cause as `target_unavailable` with `retryable: true`; it does not
replay the launch. A revoked admission, unavailable handoff custody, or genuinely missing
daemon capability keeps its existing refusal or incompatible-target result. Cancellation
keeps the existing spawn disposition: a submitted request whose outcome is unknown remains
pending with the same creation key; cancellation is reported when no such custody remains.

In 0.3 development source, `session.activity.get` accepts `view: 'recap'` to read the
same existing memory-synopsis or latest delivered WorkerUpdate selected for the Work
digest and Summary card. The closed result carries `view: 'recap'`, the exact
`sessionId`, and `status: 'ready' | 'loading' | 'empty' | 'unavailable'`; only
`ready` carries a Recap. Delivered updates retain their optional result body and
source Session id. This content read keeps ordinary Action approval and current
Session access, Home, Account and encryption admission. It creates no summary job
or store and exposes no arbitrary host-record address. An older host that ignores
the selector is refused as `recap_view_unsupported`; summary and awareness reads
retain their existing contracts.

The resolved Session transport reads the requester's persisted Account encryption currentness
under that same signed invocation, without borrowing the daemon's bearer.
In 0.3 development, the Machine-placed `session.transcript.get` declaration explicitly
admits this preflight even without a Session origin. Its signed purpose allows only the
bodyless `GET /v1/account/encryption/currentness` for the admitted requester Account;
unrelated Account reads and mismatched signatures or targets remain denied.

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

In 0.3 development, the shared daemon Action execution owner projects a verified
root's `admittedMachineRole` into the ordinary Machine admission context when the
receiving transport has no separate admission carrier. Identity, installation
and role come from Home's signed binding; resource encryption mode comes from
the installed Machine. This applies equally to PAT and Account roots and does
not re-evaluate Machine access or widen the credential grant. Socket RPC retains
its existing receiving admission, including reviewed children on another Machine.
In 0.3 development, an Action spec's `executionChildEffects` declares installed
child effects that consume its existing admission. Home's signed-child purpose
owner reads that declaration and retains the root credential ceiling; the child
route still decides access to the concrete resource. `review.start` declares
`review.reviewers.set` for its admitted round's requested people. This does not
grant Review Edit access or admit verdict submission.
A plugin-composed Review's in-process Machine transport retains its requester's
private ingress proof through the reviewed-child issuer, including comparison
capture. It does not classify capture as a local repository read to obtain that
identity: the receiving Machine's existing SCM authorization still decides access.
Its selected requester is carried to the native handler for capture as well as
repository reads, so the handler consumes that decision.

Reviewed Setup children retain their requester's signed root and check their own
Setup Action grant. They do not mint a new root using the installed Account.
When Setup materializes its combined Workflow Run, the accepted snapshot carries
the public signed original authority and reviewed-child identity. This includes
the ordinary Account spawn's captured Machine admission; ordinary unrelated Runs
do not retain an Account root. The installed Workflow origin and installation
proof bind the publisher to that captured grant. Home mints the native leaf for
the original requester and consumes its admitted Machine role, without requiring
the shared Machine to be owned by the requester or admitting permission again. Later effects consume the signed leaf
and existing Run liveness. Approval replay checks the original root before Run
admission; an already admitted finite Run retains that principal, grant and
Machine role without reopening credential or Machine permission admission at
each leaf. Installed Machine identity and the assigned Run/invocation remain
required. Missing retained authority fails closed.
Signed Setup storage is limited to the Run derived from that original invocation,
and Ask storage is limited to the Action's deterministic approval Artifact.
Account-only requester encryption material is never borrowed for a PAT requester.
In 0.3 development source, Project execution output read/copy retains its same
signed Project root for operation lookup and the derived terminal-byte read.
The operation adapter checks the requested operation, Machine scope and Project
command attachment before deriving the terminal request; Home verifies each
exact signed body on that same Machine/installation. This composition does not
grant general terminal reads or permit cross-Machine attachment substitution.
In 0.3 development, public-profile preparation retains its signed root while
reading the captured Account's owner record. Snapshot preparation reads only the
typed `public_eligible_personal` Usage population, including its preceding-period
comparison; it receives no quota grant or all-personal-history fallback. Prepared
publication writes use their existing closed transport schemas and exact paths,
not the caller-facing intent grammar. Current Account/source admission and the
ordinary Action approval policy still apply to every operation. Preparation
admits the captured Account once and carries cancellation through subsequent
work; each server request still validates its actual signed purpose and effect.

Preview, publish and update accept a private `WidgetAreaLayoutV1` selection as
their `layout`, alongside the existing inert inline layout used by Undo. Shared
`preparePublicProfileAction` compiles that selection with
`compileWidgetAreaPublicProfileLayoutV1` before review and retains the exact
public copy for dispatch. UI, CLI and agent publication use that same owner.
Selected installed definitions use the host's exact retained descriptor read,
without loading saved placements or the Account's definition inventory. The
descriptor's separate availability fact continues to gate input options;
copying inert public presentation does not grant execution authority. Artifact
definitions use the existing Account-mode-aware, signed `artifact.get` read-only
path; this preparation grant permits no audience or recipient-key writes and
does not apply to facts-only refresh or resume. The raw private layout stays in
live invocation custody and is removed from durable observations. HTTP and
persisted publication layouts remain the same closed inert public shape.

Profile editing reuses those existing Actions: preview accepts explicit draft
field, metadata, period and presentation inputs; update applies explicit changes;
publish makes the selected edition public after the first-Publish disclosure
review. Apply and Undo do not open that profile review again. An Update that
widens fields or changes the query prepares the required snapshot into the same
write; hiding fields and layout-only changes need no follow-on refresh. Publish
covers daily facts-only refresh by the native daemon. Refresh defaults to Allowed;
explicit per-surface Off or Ask still prevents unattended execution. Resume is
direct in the UI and defaults to Ask for agents because it exposes the page again.
`settings.get`/`settings.set` with
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

In 0.3 development, Home returns HTTP `502` with `action_outcome_unknown`, the
request ID, and a closed code-only `diagnostic` when a submitted daemon invocation
has no authenticated Action response. Protocol owns the diagnostic vocabulary:
`daemon_rpc_refused` with an existing RPC error code,
`daemon_acknowledgement_lost`, `daemon_response_invalid`, or the existing finite
wake owner's `managed_wake_unconfirmed`. The RPC refusal is
transport evidence; it does not establish an authenticated no-effect settlement.
UI, CLI and SDK readers retain this cause without forwarding opaque daemon text.
Protocol also recognizes an exact empty `502` from an older Home: the UI reader
retains its existing `outcome_uncertain` result and the CLI reader its
`outcome_unknown`. Malformed responses and typed pre-dispatch refusals retain their separate results.
Uncertainty does not authorize another invocation. Installed-plugin controls
retain the exact target for their existing read-back recovery rather than
reporting an unknown mutation as Done or replaying it.

For `session.spawn_new`, closing the caller’s HTTP connection retires its wait.
Once the request reaches the daemon, the Session creation operation owns startup
and first-input settlement. A caller with the operation address can read the
terminal result through `action.operations.get` on a new connection.

If a managed guest loses the completion acknowledgement for `session.spawn_new`,
Home keeps the original invocation open for the same guest to reconnect. The
guest reads the Session by its original creation identity and verifies the
signed request digest retained in owner metadata. An exact match returns the
committed Session without claiming initial-input delivery. If the lookup finds
no Session, the caller gets a retryable `spawn_failed` with
`daemon_reconnected_before_session_birth_confirmed`. Retry uses the same
creation identity. Home never resends the start automatically.
The diagnostic is an unreleased 0.3 source-contract correction; load Home and its
consuming Protocol/UI/CLI/SDK closure together. An older closed reader may refuse
the richer envelope; this change introduces no compatibility retry or downgrade.

In 0.3 development, the global HTTP error owner also classifies database
rollback exhaustion, transaction timeout and connection unavailability for the external Action route.
That route returns HTTP 503 through its strict outer error envelope with
`database_transaction_conflict_exhausted`, `database_transaction_timeout` or `database_connection_unavailable`;
it does not turn these known failures into `internal_error`. Account-placed
managed Actions retain the confirmed rollback code from their native Home HTTP
response. This classification adds no retry or replay permission.
An explicitly expired Prisma transaction (`P2028`) is a timeout, not serialization
conflict exhaustion. A timeout can retain an earlier uncertain commit and does
not establish confirmed rollback for callers.
The failure vocabulary is an unreleased 0.3 source-contract correction; load the
server and consuming Protocol closure together rather than treating the added
codes as compatible with an older closed reader.

Unexpected Action exceptions in 0.3 development return the original request ID.
A managed admission failure returns `action_not_admitted` only when it occurred
before write submission and the admission lookup confirms no retained allocation.
A retained allocation, an unavailable admission check, an uncertain transaction
completion, or a daemon execution exception with an uncertain effect returns
`action_outcome_unknown`. Inspect current state before trying again. A typed
daemon refusal that establishes the effect never started, such as requester
custody retirement, keeps its refusal code and `effectAttempted: false`.
The existing server and daemon log owners record Action/request correlation, phase, allowlisted error
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
Approval runs in the approving client through the shared
`rememberAdmittedProjectSetupConsentV1` owner and the existing approving-Account
Trust CAS writer. The CLI consumes that same approval locally; it does not
re-author a signed `projects.prepare` with a different execution origin. It remeasures the retained target review
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

Device-local preference edits merge their deliberate delta with current persisted
values in `settingsPersistence.saveLocalSettingsDelta`. A stale app-window
snapshot therefore preserves another window's unrelated theme, composer and
window preferences. The store reconciles unchanged references; external updates
use `applyLocalSettings(delta, { persist: false })` without persistence or
settings-analytics echoes. The settings persistence owner subscribes before the
initial snapshot, accepts storage events for the MMKV local-settings key in
local storage, and normalizes the old and new documents once each before
publishing changed keys. It uses browser storage events across app windows;
there is no competing native broadcast. Startup owners that deliberately
replace a complete snapshot retain `saveLocalSettings`.

### Idle compaction preferences (0.3 development)

The three host-owned anchors are `agents.idleCompaction`,
`agents.idleCompaction.minContextTokens`, and
`agents.idleCompaction.cacheWindowOverrideMs`. Existing `settings.get`,
`settings.set` and `settings.reset` use their portable per-Agent storage
binding; plugins do not declare duplicate settings or Actions. The target key
selects one Agent preference entry. A target-specific reset removes that entry
and restores the descriptor default without resetting another Agent. Automatic
for the cache window removes that target's override, allowing detected retention
to apply. A missing detected lifetime still requires a deliberate window, and a
window cannot supply a missing request clock.

Enabled, minimum context size and cache window are captured once at Session
start. Native-mode controls expose only values the selected runtime declares it
honors; its native scheduler does not consume the host cache window. Host-mode
windows must be positive integer milliseconds no greater than 2,147,483,647,
the platform timer boundary. Invalid values remain a visible validation error;
the person can choose Automatic or a valid duration. These are unreleased 0.3
preferences; cache observations and scheduler progress remain runtime state.

In 0.3 development, saved-space deletion uses this same approval owner with the
exact Collection mutation. It asks by default and honors the selected Action
audience's Off, Ask or Allowed policy; resetting the policy restores its inherited
default. The approval explains that deleting a space removes its saved filter
and keeps the work it lists. The Collection hook adds no second confirmation.
Resetting a built-in default space remains a safe operation.

In 0.3 development, captured UI Account Settings mutations carry their admitted
raw baseline into `syncSettings`, which takes one fresh encryption-identity witness
(mode and key fingerprint) per commit attempt before sealing and retains
server-confirmed CAS publication. A write-owned presentation hold shows the choice
until settlement or approval parking, without changing the acknowledged store.
Local Settings normalization runs
for the consumed projection; raw secret-key admission still precedes a write.
The baseline response's `x-happier-account-settings-protocols:
remote-alert-policy-v1` header positively admits the existing remote-policy write
field without another push-token read. It conveys wire acceptance, not consent,
Account mode or feature enablement. Servers without that witness retain the
push-projection negotiation before policy disclosure. Registration views consume
their policy/enrollment keys and, when supplied, the server's version-bound
policy-status fact. Without that optional fact, the existing version-bound
readiness refresh remains. Neither path writes Settings: an empty-pending sync
never repairs policy through an autonomous Settings CAS.

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
Fresh `session.spawn_new` validates the final launch Profile after Role and
target preparation. A missing Profile is refused before Session birth or an
approval request. Dispatch reads current Profile skill seeds; an early probe
does not retain seeds across preparation or approval. A missing Profile
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

In 0.3 development source, the CLI's Execution Run V2 preflight performs its
passive `capabilities.describe` read under the admitted signed root's Action
purpose, retaining its requester and exact Home/target checks. A transport
refusal preserves its known authentication, Home or RPC code. Content-free
`details.executionRunPreflight` carries `phase: 'capabilities.describe'` and
`cause.code` (null when unclassified); public Start classification preserves
that strict evidence alongside `noRunCreated`. Receiver prose and request
content are excluded. This diagnostic grants no authority and adds no retry.

In unreleased 0.3 source, the Action registry builds its combined lists,
normalization, surface projections and lookup indexes on first access. Per-domain
spec arrays follow the same lifetime, including literal arrays, combined exports
and mapped row collections. Imports can therefore finish before aggregation reads those exports;
consumers keep the existing array, schema-map and accessor contracts. Spec
authors must still avoid reading the catalog while their modules are evaluating,
and ordinary schema initialization must remain safe independently.

In 0.3 development source, automation operands are declared by the existing
`sessionTarget` and `approvalScope` owners. Machine and Environment approval
scopes retain their policy meaning. A domain-owned `approvalScope` projector
can also return exact resource identities, such as a qualified Project, an App's
Source, an Environment's backup stream, or the exact database destination of a
restore. The admission result carries those
identities to automation selection once. Incidental input ids and an ambient
`defaultSessionId` do not establish operands. The bound approval profile is
context. Contextual Project and Machine facts come from the exact admitted
Session through the existing execution-origin port, loaded only when an Action
bucket needs them. The CLI's bound Session metadata supplies a Machine; it
does not infer a Project from a directory or an unrelated id.
Contributed Actions declare a saved health check with
`approvalScope: 'healthCheck'`; the host retains its source-instance and check
identity. A heartbeat endpoint id is not part of that subject. An Action that
names one saved check carries `sourceInstanceId` and `checkId`. Health setup
carries the watched `subject` instead: its operands are the checks it saves,
each under the source instance derived from that subject, and a subject-only
preview has none. Input with neither shape is refused as an invalid subject
identity before dispatch.
Custom plugin subjects use their contribution owner's identity-schema admission.
Native domain projectors declare their potential `subjectKinds` alongside the
`project` function in `approvalScope`. Discovery enumerates these kinds without
running a projector on fabricated input. Admission still supplies the actual
resource identity and decides its authority.

An Action with an existing `completion` declaration has no immediate
after-Action bucket. For example, `projects.prepare` can return
an operation to observe or an immediate no-launch result; neither response
starts an immediate after-Action Run. An after-Action link remains one Action
trigger row with one id and revision; ordinary update and removal apply. Its
matcher consumes the existing terminal Events whose declarations name that
Action in `completesActionIds`. The producer maps each terminal Event to
`completionOutcome`; safe Action evidence exposes that value as `outcome`.
Deployment success, failure, cancellation and unknown outcome keep their
existing Event identities. Project setup completion maps to `succeeded` or
`failed`. An Only-when filter on `/outcome` selects, for example, only failure.
The authored filter stays in the private trigger definition. Deployment
completion continues to come from the deployment receipt observer; the matcher
creates neither a combined Event nor a group of trigger rows.
Accepted operations and deployment receipts retain the admitted Workflow origin
separately from the eventual approving person. Native terminal observations carry
that origin into ordinary Run admission, whose existing ancestor rule suppresses
the firing trigger without disabling later independent Actions. The V1 operation
read projection omits this V2-only provenance field.
Synchronous SCM worktree create/remove responses already report the completed
repository operation and carry no accepted-operation handle. These contracts are
development source; composed automation validation is still required.

In development source, private Only-when matching uses safe Action evidence for
both phases. The Account host opens only the selected trigger definitions once
at admission, including after-only triggers. The same invocation retains that
snapshot through approval and settlement even if the source changes or is
removed. Restoring a cold approval Artifact reopens its exact trigger references
and revisions; unavailable content produces a visible Skip. It does not retain a
private snapshot across restarts. Saved-Workflow Action checks seal their matching
definition with that Workflow Artifact's existing associated-content codec. When
the subject owner admits `reachesOthers`, the authorized Workflow index carries
that envelope to the same readers as the Workflow. The actor opens it through
the Workflow's resource key and evaluates the filter locally before Run admission.
Plain Workflow resources carry plain content; E2EE resources carry ciphertext
readable through the Workflow's existing recipient grants. Account-private
Automation context remains outside the shared index.

The Project Overview links checks to the logical Project key. Those checks
are Account-private. Team ownership and grants belong to the Project Source.
Its App Link uses the Source ID and the existing Source audience to review
Workflow access for shared checks.

Development Action discovery summaries expose `automation.before`,
`automation.after`, `automation.workflowStep`, `automation.subjectKinds`
and an optional `automation.primarySubject` containing its declared `kind` and
operand `field`.
The existing `action.spec.search` and `action.spec.get` Actions return these
fields. The catalog derives these
choices from the existing effect, completion and Workflow-step declarations;
pickers consume the read projection. Completion Actions offer an after choice
whose admission comes from terminal Events; their executor still suppresses
immediate after settlement. Read-only Actions cannot be hooked. Subject kinds
describe potential applicability, including Session-derived Project and Machine
context and the bound approval profile; they do not promise a subject is present
on every invocation or grant permission to manage it.
The trigger block's “This resource / Any kind” selector consumes the declared
primary subject directly. It does not choose from ambient subjects such as the
bound approval profile. Matching retains the full `subjectKinds` list. Actions
without an unconditional existing resource operand, including global and creation
Actions, omit the primary subject.
Contributed Actions expose the same subject metadata from their admitted declaration:
saved Health checks use `checkId`, plugin resource kinds use their declared identity
field, and Session targets use their declared target field. An Environment approval
scope advertises applicability to Environments; without a declared unconditional
input operand it does not invent an `environmentId` primary subject.

In 0.3 development source, the Database Workbench declares a client-placed
Open Action. The Action supplies a selected database descriptor and a place
to the Workbench destination. Subsequent database operations use daemon
Actions under the selected target's admission. Console SQL and SQL-only
history stay under the editor's device scope, and staged edits remain in
the mounted Workbench until the reviewed Apply. The Open Action returns
a location outcome and carries no Console content.

The mounted Connect form submits Saved Secret associations through host
`Action.Control`. To open an existing SQLite file, the form describes the
selected Worktree file target through the existing daemon Action, then opens
the returned descriptor in the shared Workbench.

Navigate and Draft Read address an existing Database Workbench on the selected
answering client with its published `mountId`. Navigate uses the same location
owner as the page controls. Draft Read admits Access Read for the selected
database under the invoking principal before reading either the current SQL
draft or SQL-only History from the answering device.

The Workbench publishes Connect, Forget, Access Set, finding list and detail,
Prepare brief, Open, Navigate and Draft Read in CLI and MCP discovery. The
catalogue carries their declared input and result schemas. Invocation uses the
same target and approval policy as the other Action surfaces. The client
Actions still use the answering device.

History Clear (`happier.database/actions/ui/history/clear`) uses the same
published `mountId` and selected-database read admission. Its Client Action
asks for confirmation by default and clears that database's SQL history on the
answering device while preserving the current draft. A missing or closed mount
returns `unavailable`. To save a row export on the answering App from a
Session, pass the CSV or JSON text returned by `happier.database/actions/rows/export`
to `files.save`. The App asks the person to choose the destination.

When a deployment is missing its writer, the Workbench keeps the staged edits.
The manager configures the writer through `deployments.bindings.set` with the
selected service or managed data target, then applies the same review again.

In 0.3 development source, the Database Workbench's Prepare brief control
invokes `happier.database/actions/insights/brief/build` for the selected
finding. The build reads the selection once and takes its initial baseline
from that observation. Callers that already hold an earlier baseline can
pass it to preserve the before numbers. The brief carries the baseline
and the verification operands into editable Session composition.

In 0.3 development source, `action_interception_rejected` is presented as
a refusal. `readActionFailurePresentationV1` owns that classification and reads
only the producer's safe `details.message`; absent text uses the surface's
ordinary translated fallback. Agent, CLI and MCP projections quote a supplied
reason as untrusted Workflow text and omit opaque diagnostics. UI error and
tool-result adapters consume the same projection. Presentation never exposes
raw command output or executes a reason. The Windows tools-call adapter uses
the same projection; composed refusal/cancellation validation remains in progress.

| Decision or fact | Owner |
|---|---|
| The Action registry: every row, its schemas, surfaces, safety and approval | `packages/protocol/src/actions/actionSpecs.ts` |
| Canonical Action input/result contracts | Runtime schemas reached by `packages/protocol/src/actions/actionSpecs.ts` |
| Declared domain refusal branches (0.3 development) | Action spec `outputFailures`; `settleActionOutput` validates the declared output before `readActionFailureEnvelope` projects a matching branch |
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
| Effective invocation authority | `packages/protocol/src/actions/invocationAuthority.ts` |
| Credential decision admission | `packages/protocol/src/actions/decisionAuthority.ts` |
| API-token action, target, model, mode and origin grant | `packages/protocol/src/auth/apiTokenGrant.ts` |
| Friendly CLI command projection | `packages/protocol/src/actions/actionCliProjection.ts` |
| CLI presentation, including demoting an ineffective success | `apps/cli/src/cli/actions/commandPresentation.ts`, `.../executeCommand.ts` |
| Machine-RPC route class for an Action-bearing method | `packages/protocol/src/machines/peer/mediation/rpc/routePolicyV1.ts` |

In 0.3 development, ordinary Agent, MCP and Voice `action.spec.search` ranks
against complete field hints but returns `inputHints: null`; use `action.spec.get`
for invocation details. Workflow-step and automation searches retain field hints
for their pickers, as do UI, API and CLI searches.
`action.spec.get` returns input and output schemas, hints and examples.
Agent, MCP, CLI and Voice discovery expose shared definitions as named `schemaSections`;
read a definition with the same Action `id` and its `schemaPath`. The response's
`schemaSection.schema` contains that definition's root; nested definitions have
their own advertised sections. Its local references
still resolve against the original `inputSchema` or `outputSchema` root, rather
than the section itself. Reattach the listed definitions before compiling the
schema with a JSON Schema validator. No fields or allowed values are truncated.
Voice preserves these catalog section pointers when file-path sharing is off;
filesystem values and path examples still pass through the privacy projection.
MCP tool advertisements omit output schemas; describe includes their section index
by default. Set `includeOutputSchema: false` for input-only discovery. A
`/outputSchema/...` section read includes outputs automatically.
UI/API retain full, self-contained schemas and outputs by default.

The default Agent and MCP core contains search, describe, execute, change title,
Session list/activity/send, and approval list/decide. Other Actions remain
discoverable and executable through the same approval routing. Explicit Account
exposure choices and required Session memory tools retain their existing policy.

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
policy before any effect. The captured Account's existing `voice.canApproveRequests`
preference controls its Voice host's person-class authority; when off, Voice retains
automation authority. Agent and plugin requests retain their own authority even
when an Account credential carries them. Person-class authority alone is not a
completed confirmation: the shared confirmed front door binds the exact Action,
normalized input, request, Account, Home and target. It answers a default Ask,
not an explicit per-surface Ask or an unresolved domain choice.
Managed native Actions retain their existing Account transport and installed
native admission owner. An `account_automation` lowering ceiling remains intact
on direct origination and re-entry through an already-signed root; the carrier's
UI ingress or Home signature does not itself promote that authority.

The host-local `.prepare(actionId, input, context, {reviewOnly:true})` contract
projects the canonical safe operation summary and digest before creating approval
custody. Its ordinary invocation still requires the existing review; preparation
does not grant confirmation. This is a preview, not an admitted effect: later
profile, configured-widget and other domain checks can still refuse its run.
The core owner projects its contextual safety classification into the preview;
consumers do not classify Actions again. Resolved Session selectors include the target owner's
captured snapshot in that digest, so unchanged selector text cannot confirm a
different resolved operation. Normalized inputs and target snapshots remain
host-local, never raw Voice tool results. A confirmed handoff must pass both the
prepared normalized input and its captured `sessionTargetsV1` through the full
Action context; confirmation alone does not retain a selector's earlier target.
The conventional Voice handler consumes this projection through its live call's
read-back binding and the existing confirmed front door. The binding keeps the
normalized operands and resolved Session targets while the host itself speaks
the canonical operation summary through the existing speech output owner. Only
that host utterance's completed playback arms the binding; model speech cannot
arm it. Local and capable realtime callers supply the same host-playback capability;
the dispatcher resumes the captured Action immediately after that playback completes,
without requiring a second model tool call. Local settings writes and approval decisions
report the owner's saved-value or decision result instead of model-authored completion prose.
End and barge-in cancel playback without completing the binding. A later
change of selected Session cannot retarget that confirmation.
With `voice.canApproveRequests` on, the person's requested Action uses this path
without an approval Artifact, including irreversible Actions after read-back.
Setting-off and agent-initiated requests retain ordinary approval admission.
When a Voice tool retains a live wait for a tap-required approval, the host uses
the call's playback capability to tell the person to use the approval card while
the action is pending. The call still returns its settled result. The utterance
contains only the generic tap instruction.
Contributed Actions and current-UI execute-Action commands prepare at the plugin
dispatcher after the inner input is normalized. Their read-back uses the same
localized confirmation and disclosed fields as the tap dialog. The host-local
binding also retains the exact execution placement and contribution occurrence;
changed operands or a replaced occurrence refuse the old confirmation. The
generic `action.invoke` or current-command wrapper summary cannot confirm the
inner effect. Playback unavailable retains the ordinary tap.
Ordinary preparation without this option keeps its existing approval timing and
result shape. This describes development source, not released availability.
Realtime contributions can supply `playHostText` through the public Voice SDK.
The host passes the prepared operation summary to that capability and consumes
the same binding only after its `completed` result. `cancelled` ends this request;
`unavailable` retains ordinary Ask. PCM drain distinguishes natural completion
from clear, interruption and teardown. Model speech and generation completion
alone supply no confirmation. Providers without this capability retain Ask.
Contributed/current-UI overrides still use their resolved Action's existing tap
confirmation: their generic wrapper preview does not describe or confirm that
inner effect. That resolved owner still needs operation-preview/confirmation
integration. Native provider playback also needs loaded-runtime verification.
An attempt ID does not upgrade authority: terminal credentials retain automation
authority on UI, can request policy-required approval, and cannot approve it. In
0.3 development source, a terminal credential can reject or cancel its own pending
approval through the signed decision Action. This withdrawal retains automation
authority and does not authorize approved-effect replay or another Account’s
approval. The approval UI preserves `present_user_required` and directs the person to an Account
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
In 0.3 development source, when an authenticated terminal or lowered Account
invocation cannot satisfy an Action's authority, both Home Action dispatch and
execution-authorization issuance return HTTP 403 `present_user_required`.
The CLI preserves that typed refusal without retrying authorization. Invalid or
revoked credentials still return HTTP 401 `invalid_token`; grant-scope refusals
remain `credential_scope_denied`. An authenticated Account's approval flow
retains its existing authority.

An authenticated credential that cannot supply an Action's original-root,
installed-source or continuation authority receives HTTP 403
`credential_scope_denied`, including execution-authorization issuance. This is
an Action refusal and preserves the client's stored Account session; HTTP 401
is reserved for credential authentication failures.

When execution-authorization minting finds an unavailable or replaced target
Machine or a non-current Session target or source, it returns `target_unavailable`:
HTTP 409 during issuance and retryable placement failure during daemon dispatch.
These availability failures preserve stored credentials too.

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
requires that source Machine for dangerous Agent/MCP client proposals even when the
reviewed effect belongs to the approving app. An open client proposal missing
that origin refuses with `approval_origin_unavailable` at the Action decision
owner before recording consent; the UI preflight returns false, the request
stays open, and no native effect runs. Present-user client actions and admitted
Machine-bound client replay retain their existing paths. For retained replay, the
approval executor settles that request as `failed` with
`approval_origin_unavailable` before any effect or replay dispatch, including a
request previously left `approved`. The message explains that the origin is
unavailable and the request must be submitted again from the originating daemon
or Agent Session. A standalone CLI's Session-placed pending output states this
prerequisite before the user approves; JSON retains its pending envelope and
prints the prerequisite on stderr. Account-owned approvals that the existing
custody policy permits the approving app to execute retain that path.

For a built-in deferred approval routed through the Account app's
exact-daemon decision transport, the app sends the decision through Home before
recording approval. A failure before delivery leaves the request open for
another review. Once Home accepts dispatch, the daemon can record the
decision and claim execution on the Artifact even if the deciding screen closes.

Blocking live-only results follow the admitted approval request's flow, including
the required-result default when the authored spec omits `flow`. They resume the
original daemon invocation so its caller receives the full typed result; approval
history and the deciding app retain only the Action's observation projection.
This includes CLI requests with live-only results and ordinary durable input:
UI approval resumes the existing requester rather than replacing its result
with a redacted Artifact read. Losing that live invocation makes the private
result unrecoverable. Already-deferred proposals keep their deciding-user result path.

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
Machine Preset create and update save configuration under the Preset owner's
and selected controller or pool's management authority. Current provisioner,
credential and pool-candidate availability is decided when acquiring a Machine;
an unavailable configuration can still be saved and edited.
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
fields. Approval preparation writes this domain-declared private projection from
the normalized, captured Action input to its preview. A review field declared with
`inputType: { hostType: 'savedSecretReference' }` reads by its Saved Secret name,
including references nested in JSON objects and arrays (`set.[].source.ref`).
The containing binding keeps its context; an unreadable reference reads as unavailable.
Provider credential/model
references, default-model selections (including explicit clears), initial manual
models, Saved Secret deletion revisions, and durable Remote Host target
revisions remain review operands even when shared observations omit them.
Approve uses the captured operands; it never refreshes a reviewed resource's
revision. Live-only inputs retain their separate redacted custody contract.
Missing review context produces a typed
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
its optional `turnId`, `kind`, `tool` and available `arguments`. These operands
are opened Session content, redacted by the publishing owner, and remain readable
when a fresh native tool call has no durable transcript message yet. They use the
existing authorized Session read and Account-mode Action result transport; they
are not server-visible status metadata. A null list means the request content
could not be opened; older producers may omit the list or operands. This
unreleased 0.3 closed projection requires matching development readers when
operands are emitted; it adds no mixed-development adapter or new authority.
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
UI, Agent, MCP and API by default. CLI local writes default to Direct unless an
applicable `cli`, `default`, or flat input predicate declares confirmation;
destructive and outward operations retain Ask, as do confidential reads with
confirmation metadata. `confirmationWhen` is the sole portable
declaration of conditional confirmation; its canonical owner is shared by
discovery, Settings and invocation. A flat input predicate applies on every
surface; `{ presentUserUi: false }` skips the default only for the host-proved
present user's UI operation, retaining automation defaults. The scoped value
also accepts an input predicate. Explicit Ask and surface waivers remain user policy;
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
replayable plugin inputs return `approval_request_created` with their Artifact id immediately
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
contribution identity. The daemon execution adapter uses the registry key
`pluginId/localId`. The contributed Action observer records tracked invocations
under that registry key and the invocation's request ID. CLI JSON exposes this
pair as `operationRequestIdentity` for `action.operations.list`. The matching
row supplies the operation ID for `action.operations.get`. Generic
`action_execute` admits a qualified Action through current `action.spec.get`,
without requiring a separate Tool declaration. Named Tools still use their
admitted catalog snapshot and contributor-occurrence fence. Both paths retain
the shared enabled/surface/approval owners; the external API `action.invoke`
admission and fixed API approval replay contract are unchanged.

In 0.3 development, built-in Action specs may declare `outputFailures` to name a
refusal discriminant and its code field. Terminal settlement maps only a matching
declared branch after output-schema validation. Capability preview/get/set declare
`ok: false`; language-intelligence Actions declare `status: 'error'` and rejected
edit results. Other negative answers, including loading/unavailable observations,
remain successful Action data unless their owner declares otherwise. Projection
retains the typed refusal details and only producer-supplied effect/cause evidence.

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
existing username route and the Home's canonical username policy. In current
0.3 source, route eligibility admits username operations when Public profiles
are enabled, independently of Friends; otherwise the Friends eligibility rules
apply. This does not enable Friends discovery or relationships.
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
In development source, `reviews.list` and `review.history.list` use the same
Home-domain transport as other Account Actions. The authenticated Home supplies
the caller Account to the Artifact query owner. Listing returns one demanded
metadata page with root-finding counts and a continuation cursor; it reads no
Review bodies and never follows the cursor automatically. History returns exact
finding identities across authorized earlier Reviews of the selected workflow,
with distinct earlier Review/run counts and separate current/previous appearances.
Without an accessible predecessor, novelty remains unknown. Each Review keeps its
own decisions; a matching identity never transfers acceptance or dismissal. UI, CLI, MCP and Voice consume the
canonical Action schemas and the existing Home/Account scope binding.

Team Shared Reviews keeps the Artifact list's order and sharing labels. It
passes only that page's IDs to the optional `reviewIds` field in `reviews.list`
for Review facts. Omitting the selection preserves the ordinary Review list.
The request stays closed, so this unreleased 0.3 selection uses matching client
and server source.

Public review-comment Actions also project named Voice bindings from their
canonical declarations; generic Voice `action_execute` reaches the same schemas,
revision checks and approval policy. The internal publication-dispatch claim
remains unavailable to Voice.
In development source, `review.apply` (`actions invoke review.apply` in the CLI,
`review_apply` on MCP and Voice) accepts a destination Session with a Review id
or reviewed `{runId, findings}` sets, or `{ reviewId, destination: 'prompt' }`
to prepare the same prompt for copying or an editable New Session draft. The
review card and external plugins invoke that same Action. It reloads the scoped
ReviewComments, including references reused from earlier rounds, selects current
accepted groups, and sends the canonical verify-first instructions through
`session.message.send`. Each reviewer retains its own evidence, thread references
and current comment CAS. Empty acceptance sends nothing; review and delivery
refusals remain typed. Applying does not itself write dispositions: the verifier
uses the existing ReviewComment Actions. The public SDK reviews entrypoint exports
the input schema and canonical verification renderer/instruction texts.
Triage's `sessions/start-entry-v1` contributed Action admits Voice through the
same confirmation gate and registered handler as UI, Agent, MCP and CLI. Its
issue-linked orchestration still creates or rejoins the Session, records the
entry link, delivers the issue attachment and opens it through that owner.
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

In 0.3 development source, `connectedServices.pools.get { group }` reads one
qualified pool through the captured Account's existing group endpoint. Its
`{ group }` result includes the saved policy, ordered membership and active
account. The safe Account read requires no approval or Machine and does not
read credentials, refresh quota or change selection. Missing pools retain the
existing Action refusal; the input accepts only the qualified group reference.

`session.draft.append { sessionId, text, sourceSessionId?, discussionSource? }` is a client-placed
intent on the Session's repository-backed composer draft owner. It returns
`{ status: 'appended', sessionId, createdAtMs }` after appending to the captured
Home and Account's draft, or `{ status: 'unavailable' }` when that owner cannot
accept it. It preserves existing text and never sends a message or writes an
initial-prompt metadata seed. Inactive Homes use the same draft owner without
changing the visible Home. Transcript, Discussion and Run-result callers apply
their existing template first and reveal/focus the composer only after append
succeeds. The predecessor metadata-seed reader remains for retained drafts.
Discussion selection provenance uses its existing repository field and commits
with the selected text, so later handoff retains the source relation.
This is a 0.3 development-source contract, not a released availability claim.

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

The 0.3 Action `machines.local.service.pathExposure.set` uses the same native
SystemTasks as the Add to PATH and Remove from PATH buttons. It selects a
desktop in the named Home and changes the desktop user’s PATH entry. By default
it routes to the Tauri desktop. Pass `clientId` to address a specific desktop
including Electron. Agent invocations retain the usual approval policy.

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

In 0.3 development, a worker that refuses a manager's question answer returns
`present_user_required`. The Session MCP tool result carries the worker's
`failureCause.phase` under `rpc.handler.manager_question`, with a suffix such
as `actor_missing` or `admission_refused`. The receiving worker logs the same
clause at info level with the worker Session ID, question request ID and call
ID when available.

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
reporting relation itself grants no access or authority. In 0.3 development,
this Action is unsupported for Workflow callers: it returns the typed
`unsupported_action` refusal without forwarding or writing any recipient.
Session-caller Role-copy remains supported. Complete birth and Apply snapshots
share the canonical role snapshot resolver,
the lead's admitted effective Agent/model, and its enabled Agent inventory.
Workflow-step birth does not require a live origin baseline: an origin Session
may already be stopped. The Workflow daemon explicitly supplies the
step child's resolved Agent/model as the canonical snapshot resolver's default
engine for unfrozen Roles. Already frozen Roles retain their stored engines,
and an accepted frozen Workflow Role overrides only its matching Role. Origin
model intent never supplies an applied baseline. This Workflow-only input grants
no live launch configuration or effective baseline for Apply; ordinary live
Session birth and Apply still require the lead's admitted applied selection.
A Session runner supplies its existing admitted Agent catalog to the same
inventory builder; its cold global catalog cannot hide an admitted authored Agent.
Pending model intent is not an applied baseline. A global source daemon uses
the exact lead's host-admitted baseline; when that baseline is unavailable it
refuses the copy before any recipient write. In 0.3 development, Session-origin
Account Actions read that applied selection from the native Session through the
owner-only `session.agentStart.selection.read.v1` RPC. The reader binds the exact
Session, current turn and Agent; missing, mismatched, retired or unsupported hosts
remain unavailable rather than falling back to requested metadata.
Identity/subtree-only reads do not
establish execution configuration. Ordinary nondelegating prompt reads continue
to acquire only the selected Role body, not the complete snapshot catalog. The
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

In development source, Voice's `spawnSession` / `session.spawn_new` input may
omit `agentTarget` to use the configured New Session default. The Action's
`prompting.voiceHotPath` metadata publishes creation and its Voice input hints
in the local Voice agent's startup action list, including this default option.
The Voice host reads `agents.backends.list` for the requested Machine and Home and copies the
complete `agentTarget` from its `defaultTargetKey` row before ordinary Action
review and admission. The inventory's existing preference owner selects the
default; the Voice agent does not reconstruct it. Explicit selections remain
strict: a configured Agent carries `definitionId` beside `identity`, never
inside it. Deferred approval retains the fully bound target.
Catalog order does not select a configured Agent: an exact saved target takes
precedence, followed by the remembered Agent and the available built-in default.
A Voice creation failure names the bound Agent and carries the existing typed,
redacted startup cause; it does not copy raw process stderr into the conversation.
If that default fails during startup, Voice can offer a different enabled Agent
that the same Account's Machine inventory already knows is ready. The shared
preference owner selects the offer; it neither changes the saved default nor
launches a replacement without the person's choice. Stale or unknown readiness
does not establish a runnable alternative.
The local Voice spoken Action outcome owner presents creation settlement even
when the model returns an empty follow-up. It speaks a brief created confirmation
or the host's failure reason and available alternative; direct and discovered
Action calls consume the same presentation.
Local Codex Voice uses the native `happier_voice_action` function with `{t,args}`.
Its input schema and examples come from the same published Voice Action schemas.
In 0.3 development source, native calls await the existing client Action binding,
review and admission path and return its settled result, including the created
Session id. An approval-required call stays pending until review settles it.
The native provider's callId is the Action request identity; the canonical Session
creation materializer derives its creation key from that identity. Resending the
same call therefore returns the same child, while distinct calls create distinct
children. The carrier adds no deduplication or retry policy. Assistant text is
not an Action transport.
Codex accepts these function definitions on a new thread, so a cold-resumed
carrier without confirmed function delivery asks for a fresh Voice conversation.

Voice leaves automatic Session naming to the coding Session's `change_title`
owner unless the person supplies a name. Spoken Session labels use the canonical
authored title (`summary.text`, then retained `name`); a transient first-message
list title or folder name is not a spoken title. Creation and send acknowledgments
stay brief and distinguish accepted work from completed work.

In development source, ordinary `session.spawn_new` accepts optional
`machineSetupPlanInput` with Home, Machine, sources and exclusions only; removal,
app execution and software updates retain their separate Actions. The spawn review
includes the resolved effects Plan, including administrator and root-equivalent
disclosures, and admits Plan and Apply as host-reviewed children. The selected Machine runs
setup and joins its native operation before Session birth and Agent startup;
a typed setup failure stops the spawn. Both children consume the original
spawn's reviewed consent and Machine admission, without another approval or a
template credential. Machine admission requires Manage when setup is requested:
Use is refused before effects with a typed Manage-required diagnostic and remedy.
The existing public spawn projection binds only the setup-presence fact for
encrypted requests; the receiving daemon checks it against the decrypted input.
A shared Machine keeps its custodian, and a foreign Account gains no authority.
The existing combined setup Run retains the signed Account parent and exact
reviewed-child identity; unrelated Account Runs keep their previous behavior. Machine admission requires Manage when setup is requested:
Use is refused before effects with a typed Manage-required diagnostic and remedy.
The existing public spawn projection binds only the setup-presence fact for
encrypted requests; the receiving daemon checks it against the decrypted input.
A shared Machine keeps its custodian, and a foreign Account gains no authority. Template Copy uses the same Plan/Apply/terminal-join owner
through its existing creation continuation, after Session birth and before Agent
startup. Template Update joins setup before advancing its accepted version. The
host's private reviewed-child port carries the reviewed consent. The UI binds
the exact child through its ordinary present-user confirmation owner. Generic
reviewed setup children consume Account authentication or the PAT's grant for
that exact effect and retain its credential floor; spawn-only or template-only
grants do not install software. The native Setup leaf reuses the installation's
existing sealed invocation codec with a fresh request/reply key. It carries no
Account bearer or Account encryption key, including on a shared Machine.
On another person's Machine the receiving daemon opens the member's own preset
copies with the dispatching Run's requester custody that this installation
already retains, the same custody that Run's dispatch spent. When the Run is
hosted on a different Machine, the leaf stays codec-only and a member's opaque
preset refuses with `requester_account_context_unavailable`. The custodian's
key never opens another person's copy.
No-software Copy and Update retain their token-only transport.
A daemon that predates the optional
field rejects the strict input instead of silently starting without setup.

In development source, a committed `session.spawn_new` returns its successful
creation result even when reporting-edge key preparation is waiting.
The optional `sourceKeyPreparation` result records that separate outcome beside
`initialInput`; neither is a failed Session creation. Persistent destination
daemons require no standalone source-key transfer. Ephemeral destinations retain
their existing key requirement and report missing source material as waiting.

A typed Session creation refusal instead settles the Action as a failure. Its
Session result remains in `details`, including the launch cause, so approval
execution and clients report the same refusal. Failure phase and attempted-effect
facts are carried only when the receiving owner supplied them.

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

In 0.3 development, a typed provider refusal during Session startup carries the
existing `providerError` result, including its recovery action and any retry
delay. Session creation and Workflow starts receive the same provider cause
from the shared launch projection.

Hands-off (`workspaceWrites: deny`) is a role ceiling at both native-tool and
workspace-writing Action admission. Agent invocations can tighten it; relaxation
requires present-user authority. It is not a permission-mode override. Reviewer's
automatic allow-once answers also remain within that ceiling. Direct
`session.approval_reviewer.set` is a person-class Action: Agent/MCP callers Ask by default.
Its required `enabled` input accepts `true`, `false`, or `null`. A boolean sets
the Session override; `null` removes it so the permission owner follows the
Account default again. Clearing an absent override does not publish metadata.
The stored field remains an optional boolean; `null` is an Action input only.
An agent may request the session choice or the Account default
(`settings.set`, anchor `delegation.approvalReviewerEnabled`); both default to
Ask for agents, and a user waiver on that Action and surface lets the agent apply it.

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

Optional `expectedBot` makes the same Action conditional: `{ kind: 'bot' }`
requires the Bot marker, while explicit `null` requires its absence. Omitting
the field keeps ordinary unconditional promotion or demotion. The common
registered Session field updater checks the condition against every metadata
CAS candidate and returns `conflict` without overwriting a later marker change.
Unrelated metadata changes survive a retry. UI Undo submits its accepted marker
through this input; CLI, Agent, MCP and voice callers can express the same inverse.

In unreleased 0.3 development source, the separate `session.bot.face.set` Action
accepts `{ sessionId, face }`. A face contains optional cosmetic overrides owned by
`SessionBotFaceV1Schema`: style, the full 34-body R6 roster, palette colour,
seed and an optional version-1 shape. Action hints and schema discovery derive
choices from these canonical catalogs. Solid is matte; authoring a finish is rejected, while tolerant stored
reads discard that retired key and retain the other choices. `face: null`
clears those overrides. The existing field
registry maps the Action to `display.botFace`, and the Account metadata tuple
writer saves it without waking an Agent. A supplied seed is the concrete saved
choice. This write preserves the Bot marker, creation facts, memory and other
metadata; demotion also preserves the face. The Action uses the same safe,
no-required-confirmation declaration and UI, CLI, Agent, MCP and voice surfaces
as the marker Action. Ordinary caller admission and user-changeable Action policy
still apply.

For a request such as “make me a cat”, a Bot uses the same
`session_bot_face_set` MCP tool or `session.bot.face.set` Action. CLI callers use
`happier session bot face set <sessionId> --face '<JSON face>'` with the same
face input, or the generic command
`happier actions invoke session.bot.face.set --input-json '<JSON Action input>'`.
`shape` contains `v: 1`, `fill: string[]` of closed paths and
`mouth: [x, y, scale]`, plus optional `stroke: [path, width][]`,
`cut: (path | [path, width])[]` and `origin: 'custom' | 'surprise'`.
Author mouth-only outlines in 0–100 source units using `M L C Q A Z`
(either case) and finite numbers. The Action centres the outline at x=45 without
rescaling, checks the geometry field, body area and mouth placement, and admits
mouth scale 0.5–1.2 and stroke widths greater than zero through 24. The authored
body must occupy at least 8% of the sampled 168.75-by-168.75 geometry field after
cuts. Every sampled point of both the `quiet` and `needsYou` mouths must lie on
the body (signed distance at most zero). Keep the mouth inside the filled body,
away from cuts and handle openings. Refusals retain `invalid_parameters` and
return fixed facts in `details.issues[].constraint`: `body_coverage` includes
`minimumRatio: 0.08`; `mouth_containment` names the mood and
`maximumSignedDistance: 0`. These diagnostics never include submitted geometry
or measured input values, so an agent can correct the named rule and retry in
the same turn. A supplied
shape wins over `body` in Dither, Solid, Pixel and Dots; Planet always draws the
standard planet with the Bot's palette and mouth, ignoring body and shape art.
Keeping a body supplies the fallback for older renderers.
For “Surprise me”, use `face.shape: { generate: 'surprise', seed: 17 }`, choosing
an integer seed for the desired new face. The Action resolves that request through
the same Protocol generator the picker uses and saves the concrete outline;
the seed inside this request is distinct from the face's roster-identity `seed`.
Templates and copies carry the saved outline through the existing face field.
The shared face-authoring admission normalizes geometry at face Action,
template authoring/release and birth boundaries; stored reads retain coordinates.
The complete input uses
`EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES`; there is no separate path-count or
path-length cap. The Session metadata PATCH inherits
`SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1` for its complete encrypted or plain
request body.

The existing `settings.list/get/set/reset` declarations expose the Account's
deliberate defaults at `appearance.botFaceStyle` and `appearance.avatarStyle`.
The unreleased 0.3 `appearance.botMotion` Account preference uses the same safe
settings Actions: `lively` (default), `reactions`, or `still`. It controls the app
rail, Bots roster/summary and Home moons, with system Reduce motion taking
precedence. Playback is local and does not write Session state.
Bot style options come from `BotFaceStyleSchema`, with Dither as the fallback.
`AvatarStyleSchema` adds Planet while preserving the brutalist fallback and
existing saved Session-avatar choices. Both declarations classify the preference
as a safe cosmetic write, so a present person's UI edit is direct under the
existing settings policy. A default edit changes only its Account setting;
per-Session face overrides stay on their Session. See
[the Session metadata contract](protocol.md) for shared cosmetics and private work.

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
user's per-surface waiver. Grant and dismiss operations are person-class:
automation asks by default and runs them once the user waives that Ask. Permission requests remain plugin-originated
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

The `skills.create` observation retains its content-free save acknowledgment,
including summary and Session inclusion outcome; input file bytes remain private
to the approval review. Immediate tool results and deferred approval execution
use one saved-skill acknowledgment parser and card. A deferred result renders
at the approval's originating transcript call through the existing settled
Artifact presentation. Older identity-only acknowledgments remain readable
without claiming inclusion or fetching library content. Saved-card attachment state
passively consumes the Skills pane's Account-qualified effective-inclusion preview
and its shared Session-selection overlay. Clearing an override to inherit follows
that resolved baseline; it does not mean Off. A known current selection supersedes
an older save-time inclusion refusal. An undemanded preview remains unknown rather
than triggering a library or Machine read for every transcript card.
Info counts use that same projection against the pushed Session selection, without
refreshing the retained preview. The preview retains `reachEnabled` from its rule
owner separately from `selected`, so resetting an old override to inherit restores
the rule default even when the Machine is not reread. This applies to skill and
MCP rows alike; no client-side rule evaluator is introduced.

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

In the development UI, inventory diagnostics use the shared surface-reason copy
owner. **Local service scan needs attention** distinguishes missing/unreadable
Project roots, unavailable accepted-workspace information, scan deadline
incompleteness and process enumeration failure. A partial inventory is not a
service Start failure; lifecycle and preview outcomes keep their own reasons.
See the published [local service previews guide](../apps/docs/content/docs/self-hosting/local-service-previews.mdx).

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

Development `remote_hosts.ssh.discover` reads the answering desktop device's
configured SSH hosts through its existing discovery task. Account callers use
the read Action's disabled and approval policy. Device-local discovery and tunnel
inventory do not require the Home's Remote host management service.
UI callers retain the task snapshot; agent and MCP callers
receive a typed `listed` host result after settlement, or the task's failure
reason. It accepts no arbitrary configuration path or SSH credentials.
The Remote host form and pre-sign-in SSH onboarding read the same task directly
for the local person, sharing its task specification and typed result. Pre-sign-in
discovery does not require an Account or consume an Account's Action policy.

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
answering desktop App. Its inputs are the focused `serverId` and optional
`reconsiderCli` boolean, which asks the existing native CLI-management question
again. Settings “Change who manages the command line” uses this same Action.
The closed alternative `{ serverId, purpose: 'relay_repair' }` admits Settings
and the relay banner's existing exact-Home repair task, without CLI
reconsideration or arbitrary native-task inputs.
The existing local setup owner captures the Home, signed-in Account and native
setup prompts privately. Enrollment retains its task in the ordinary Add draft;
repair and CLI reconsideration use the runner-owned setup lifetime and leave
that draft and its machine-arrival watch untouched. An unrelated pending SSH Add
does not block either Settings purpose. It
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
`machines.managed.bootstrap.respond` Action through answering-client
placement. The CLI answers in its own invocation, without an App connection;
UI and CLI share the installation-response decision owner in Protocol. Its strict input identifies the Home profile and identity, managed
resource, creation operation and installer task. The `purpose: 'approve'` arm
contains the exact projected approval question and explicit approval or refusal.
The `purpose: 'establish'` arm carries only the current administrator-establishment
`promptId` and a transient password, not a second creation approval.
The client reads that exact resource and operation, checks the retained native
resource/controller and current unanswered question, and answers the existing
`tool.systemTasks` task. The managed prompt union covers SSH host trust, host-key
replacement, Account sign-in, remote background-service replacement and an
administrator-establishment question with its reviewed username. Trust
questions retain the host and current/new fingerprints for review. The response
must match the current question, so a stale trust decision cannot approve a later
sign-in question on the same task. Managed SSH uses its generated unencrypted
keyfile; SSH credential entry remains with the ordinary SSH setup owner.
The existing task response also carries the expected question kind, which the
task owner checks synchronously when accepting the answer. Establishment also
requires the exact current prompt id at that owner; omitted, stale, answered or
cancelled questions cannot receive the password. Its Action input is live-only:
Happier-owned approval previews, retained approval requests and after-execution
observations receive a redacted projection, while the one pending task receives
the submitted answer directly. No stored approval body can replay the password.
These response contracts do not themselves implement guest account creation.
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

### Watched Compose adoption (0.3 development source)

`machines.services.adopt` reviews a native watched Compose project on its target
Machine, then composes Environment creation and binding writes. Both `review`
and `apply` require an explicit `profiles` array for future use, including `[]`
when deliberately selected. Review reports `originalProfiles: 'unknown'`; it
does not infer the original selection from running services. The target's native
adapter supplies the observed source files and working directory. Callers select
the watched service and its expected generation, rather than authoring a host
path or replacement Compose document.

Capture uses the native Compose owner with
`config --format json --no-interpolate --no-env-resolution`. Review returns a
value-free document with variable placeholders plus required/default facts. Default values,
literal environment values and resolved env-file values stay out of the review
and stored definition. Interpolation variables and environment-backed resources
retain their binding names. When multiple services declare the same environment
key, including through an env file, capture gives each service its own binding
name unless that key already names an interpolation or resource binding. Each
container keeps its original environment key. Apply requires
`bindingsConfirmed: true` and an explicit source for every row through the
existing Environment variable-binding schema. Key names, inherited values and
defaults never select or confirm a secret. `deployments.bindings.set` remains
the sole binding-grant writer.

The Machine Services adoption hook owns review, destination and binding drafts,
then one apply of the reviewed generation and digest. The flow consumes the Store's
shared Project choice and the Environment variable-bindings editor. Refusals
preserve the review and entered choices; an identical retry retains its request
key, while changed choices start a new request. Changing the service generation
or Account retires the old review before another apply. UI dispatch uses the
canonical Action front door; the receiving daemon's reviewed-child preparation
owns adoption rather than the native observation runtime.

Apply uses `deployments.environments.create` to seed stored revision 1 and the
first target link through the existing Environment owner, then applies the
confirmed bindings. A successful `adopted` result identifies the Environment,
current revision and target link. A typed `partial` result retains prepared
creation and any completed record references; resume the same operation with
the same `requestKey` to finish its missing step without creating another
Environment. The reviewed digest must still match the target capture.

Apply is an Environment-creating root. Its signed binding carries Create's
`deploymentPreparationAdmission` (`operation: 'create'`), bound at issuance from
the reviewed `destination` and `requestKey`; Home admits it only when the
requester can manage the destination Project owner. The daemon signs create
preparation (Project defaults, the existing native target-link lookup, content
Artifacts) with the adopt root, and Home spends that admission through the same
create-preparation purpose owner as Create. The native lookup lists only the
destination owner's target links. The Environment row itself is written only by
the reviewed `deployments.environments.create` child. Review issues no create
admission. A Home refusal of the native lookup surfaces as its typed
authorization refusal, not a list-schema failure.

Adoption performs no native start, stop or Compose up. The existing watch stays
available until the first normal deploy transfers the native project's custody
to the Environment. These are unreleased development-source contracts;
first-deploy handoff and composed live validation remain integration work.

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
not decide Guard eligibility or Action approval. Notifications without interaction
metadata retain their existing plugin delivery within that same channel.

This Guard transport is unreleased development implementation, pending Guard
desktop validation. The native notification retains the original Home, Account and warning occurrence:
macOS uses `userInfo`, and Windows uses protocol activation arguments with the
installed channel's URL scheme. A process-local response queue bridges native
launch to renderer readiness; there is no notification disk store. Recovered
responses enter the same parser and Guard currentness checks, refuse an Account
rebind, and cannot execute permission answers or plugin Actions through this
native route. Ordinary Activity clicks are admitted separately as default-only
`openSession` commands with the original saved Account, through the shared
`navigateWithNotificationAccount` owner. They cannot enter permission or plugin
Action execution. Browser Activity clicks use that same Account admission. Delivered macOS/Windows warnings are read from OS history
so the existing withdrawal owner can reconcile them after restart.

Linux requires an action-capable notification daemon and the original sending
connection: full process exit ends XDG action delivery. Reopen the app to use
the current in-app warning in that state. macOS requires a real application
bundle and notification permission. Windows protocol activation requires the
application's configured AppUserModelID, matching Start-menu shortcut and
registered URL scheme. Actual Windows 11 development checks verified ordinary
Activity banner clicks from minimized/hidden states and retained Notification
Center clicks from minimized, hidden and fully exited states, preserving the
original Home, Account and Session. Those checks used a matching shortcut without
`ToastActivatorCLSID`; they do not establish Windows 10 or signed/installed release
behavior. Guard button activation remains unvalidated. Signed/installed native
notification journeys are release checks; host tests alone do not establish
visible delivery or OS activation.

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

For an admitted API-token invocation that names Environment targets,
`apiTokenGrant` intersects an explicit usage source selection with the app sources
in those Environments. An empty selection reads all app sources in the grant.
The grant projection strips demand for quota, connected-account pools, Work,
and Session or Activity evidence before the read. The response contains only
accounting for the admitted app sources.
The reader and delivery both consume the projected queries. Private recap
passes its explicit source selection to the same grant projection before the
read. An Account-wide private recap keeps its existing source selection rules.
Usage query, accounting export and private recap carry the projected
Environment selection into the list request. That request consumes Home's
Environment metadata. Home admits each collector's Environment and Machine
under the signed parent token, then the relay consumes the issued binding.
An Account-wide Usage token can select App accounting for any Environment
its Account can read. An Environment-scoped token also needs the Environment
and collector Machine in its grant. Model pricing uses the
same signed Usage request. A grant miss at Home returns
`credential_scope_denied` with `target_not_granted` or
`environment_not_granted`. A revoked token returns `invalid_token`.
Usage query carries Home's code and details in the accounting source status.
The grant owner refuses Usage Actions that
cannot scope their Account evidence or effects to app sources, including
history reads, quota calendar exports and Coach, before dispatch. Those Actions
and queries that select only sources outside the grant return `credential_scope_denied`
with reason `environment_not_granted`.

A named All period resolves to an end-only accounting request. Its calendar uses
the first observed day of the selected population, while retaining every real
accounting fact. Explicit epoch and custom ranges keep their requested bounds.

The query Action delivers grouped facts rather than its internal accounting
inputs: tariff inventories are read through `usage.prices.get`, and raw
contributions accompany only requested Work allocations, whose conservation
contract consumes them. Comparisons deliver their projected facts without raw
rows. Explicit `usage.export` section selections still read the complete admitted
accounting input. Private repricing consumes grouped tariff operands through the
same exact arithmetic owner as rich pricing, without acquiring event rows.
Coach retains its explicitly demanded evidence inside the existing read owner
before delivery. Public-profile preparation consumes bounded
numeric facts and locally composed private projections. The external Action
response-size limit is unchanged. The CLI and agent Action acquire all primary
and comparison accounting slices in one batch request and one server read
snapshot; a single accounting slice retains the scalar route. There is no scalar
fan-out fallback. `includeComparison: false` omits an unused
previous-period read; explicit queries keep comparison enabled by default.
`workProjection: 'summary'` requests the same
canonically qualified merged-PR count without allocation rows; detailed Work
remains the default for explicit Work readers. Period summary uses this bounded
count, and broad Recap does not prefetch its unmounted Session autopsy. A selected
Session retains the detailed autopsy. Public-profile preparation shares admitted
Session/turn membership and bounded numeric/private projections, not full Usage
event delivery. Rich Work stores full contribution records once in
`accounting.contributions`. Both allocation lists reference those records by
contribution ID. Outcome and branch tables list the contributions linked to
each row. The bounded `workSummary` retains distinct Session, contribution and
allocated-contribution counts.

The Work owner publishes counts of merged PRs linked by the read, and of
Sessions with those links, when each Session in the requested Work population
has PR coverage. That witness covers the checkout's current head. A branch
merged after the checkout moves away can be missed. An incomplete read keeps
witnessed links, including undated and outside-period merges, with the
population counts absent. Public-profile execution lenses use their own
admitted Work population and can answer independently.

Work reads keep any readable Session evidence and report missing coverage as
`sources[].unreadSessions` on the `work` source. The counts distinguish an
unavailable Machine, a refused read, a timeout, and other failures. A mixed read
has `partial` status and keeps the accounting total, with unwitnessed lineage
left unallocated. An entirely failed Work read can report
`work_evidence_failed`. Broad agent delivery keeps the same coverage counts
along with the Work summary.

In-process Usage filter-option readers call the same typed query port with
inventory-only demand. They consume distinct accounting ids and labels without
another result parse or the external Usage response-envelope projection. The
Resource transport remains the result-validation boundary; external `usage.query`
still validates and applies its explicit incomplete-response contract.

Agent and MCP delivery defaults to conserved summary facts: accounting totals,
breakdowns and Work summary counts. The existing delivery owner omits broad
per-source coverage rows in favor of `accounting.coverage.sourceSummary`:
the total source count and groups by status, path and capture kind, with source
and event counts. `coverage.reasons` and the other coverage facts remain intact;
`coverage.sources` is empty when that summary replaces its rows. Comparison
accounting uses the same projection. Select one Session to read per-source rows.
The existing delivery owner also omits broad Work links, branches, allocations
and transcript autopsy bodies for agent tool budgets.
It records each omission in `incomplete.omittedSections` with `narrow_query`
recovery.
Select exactly one Session with `session` to obtain those detail sections.
Narrow the period and filters and use the existing include flags or
`workProjection: 'summary'` to acquire only needed sections. UI Resources and
widgets use the admitted result. Mounted and standalone Actions share the
delivery rules below. This is unreleased 0.3 source behavior under the existing
query path and transport cap.

When requested evidence cannot fit the complete Action envelope, the Usage
delivery projection can remove Work Session detail while keeping the linked rows. It reports
`incomplete: { reason: 'response_size_limit', omittedSections, recovery: 'narrow_query' }`
on each affected slice. `workSessionDetail` leaves PR and branch rows and their
typed unread counts available. Its allocation arrays are empty and the raw
accounting contributions are absent. If even compact Work does not fit, `work`
names the whole omission, including its merged-outcome summary.
`howYouWork` and `coach` name those evidence sections.
When Work Session detail is present, each PR or branch allocation row refers
to exactly one `accounting.contributions` row by `contributionId`. For example,
join `slice.work.allocations[0].contributionId` to the row with the same
`id` in `slice.accounting.contributions`. The same join applies to
`slice.work.branchAllocations`.
The bounded Work summary, including Session and contribution counts when rich
Work was acquired, remains available to agents and the CLI. Accounting totals,
breakdowns, allowance facts, source currentness and exact
query identities remain unchanged. Smaller sibling slices keep their evidence
when it fits. Narrow the period or select a Session/filter to read omitted
evidence; there is no automatic retry, hidden truncation or transport bypass.
The rich in-process Resource and explicit export inputs are unaffected. Summary
facts that themselves exceed the envelope remain subject to its existing refusal.

In development source, an installed Session's `usage.query` and `usage.export`
spend their existing Home-issued Action authorization for the accounting query,
captured Account mode/settings/profile reads and retained quota reads.
Coach Apply consumes the same evidence reads without gaining mutation authority.
Undo, dismiss, snooze and restoration do not acquire analytics; they reach their
existing mutation owners directly. Their approval, target admission and atomic
receipt/settings-version checks remain in force. `usage.calendar.export` admits
only its retained quota read.
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
For a Session shared with you, the Session Usage page caption and the Usage Read
Action description identify the figures as usage from your own account in that
Session.

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
The optional host-only `includeCoach` clause controls Coach evaluation over
those facts: omitted preserves direct Action behavior, while builtin widgets
enable it only for Coach. Accounting and Session-evidence HTTP requests omit
this projection clause, so it does not change private-evidence admission.
Mounted Usage Actions that include Coach wait for the requested query’s Coach
evidence and preferences, and preserve typed failures and Session refusals.
The optional host-only `includeQuota` clause controls allowance and pool
acquisition and projection. Omitted preserves direct Action demand; builtin
Capacity, Projections, Resets, Plan fit and Coach request it explicitly. Capacity
still reads current allowance without requesting history. Non-quota slices do
not acquire allowance or replace the Account owner's retained allowance.
Accounting and Session-evidence HTTP adapters omit this clause as well.
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

Accounting dispatch is acknowledged by the shared read owner before a new
Resource read publishes or traverses retained Session inputs. This waits for
request issuance, never its response. A newly acquired view shows its loading
shell until that issuance before rendering rich retained facts. Unchanged admitted
accounting can present immediately; later refreshes preserve visible facts.
Successfully admitted, unchanged Session
inputs return directly; only pending or changed inputs allocate asynchronous
read continuations. The same input owner retains invalidation and cancellation.

A selected layout's loading shell withdraws widget Resource demand until its
document is admitted. Outgoing frame registrations cannot start another batch
while they are being removed. Same-document refresh and viewport changes retain
their existing admitted demand.

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
When Project titles collide, the toolbar and the Action's Project choices use
the same Machine or checkout place in their titles, where one is available.
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
Coach Apply still requires current evidence after a source or settings change.
Its nested query waits for its requested private evidence and binding-catalog
admission in this same Resource; it does not wait for independent allowance history.
Ordinary one-shot queries keep returning progressive snapshots. Undo uses the
owner's authorized conditional receipt, rather than an analytics query or renewed
advice; dismiss, snooze and restore likewise go directly to their preference owner.

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
Agent and MCP price Actions return the model count and provenance by default.
Supply `modelIds` to read exact catalog entries; unknown ids remain absent.
UI and CLI calls without selectors, and the native price HTTP routes, retain
the full catalog.
Malformed external entries are skipped individually so valid model prices can
still refresh. A file with no valid prices remains a failed refresh and retains
the previous cached or bundled catalog with error provenance.

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
The optional Account night-hours choice defaults to unset. Changing it reprojects
the existing Usage Resource's admitted facts and available recorded activity even
while private Session detail is pending; each query keeps its own fixed-offset
calendar. Changing or clearing the hours also reprojects retained witnessed
intervals, without inferring missing busy duration.
Presentation-only preferences, labels and entered prices likewise reproject those
admitted facts without reacquiring accounting, quota or private Session evidence.
The original resolved period and source as-of times remain unchanged. Accounting,
source, selector/eligibility and authority changes still demand acquisition;
presentation changes never substitute for fresh admission on those paths.

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
admits reversible proposals from real retained evidence. Only Apply queries
analytics to resolve its evidence key. Undo uses its original mutation receipt;
dismiss, snooze and restore update the exact preference key without requiring
it in current analytics. Dismiss/restore and snooze/unsnooze are safe, reversible
own-Account preferences with no default approval requirement, including for
terminal credentials. Apply and Undo retain required approval. These operations remain usable during an analytics
outage, but cannot overwrite an intervening mutation. MCP advice witnesses
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
pre-effect checks: after device delivery settles, its acknowledged or explicitly
unobservable outcome is preserved even if cancellation or Account retirement
arrived during completion. Departure does not retract the effect or authorize a
retry; mounted presentation still owns whether a retired view publishes results.
These are development-source contracts; source checks do not establish loaded UI or release
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

Selecting `contributions` in an export explicitly admits ordered accounting detail
through the same Resource (`includeContributions` in the host query, not an HTTP
accounting filter). Recap JSON/CSV asks for those rows on the export click; viewing
the card does not prefetch them. Delivery metadata (`summary`, `sessionIds`,
`sessionMembership`) is not an export section. Copy summary still selects totals
only, without admitting contribution or private Session/Work detail.

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
any quota observation exists. Session Agent/MCP execution retains its admitted
Home/Account origin: the host signs the finite writer's preparation reads and
presentation CAS under the same Action root. First use merges the existing legacy
presentation projection and the price in one source-versioned CAS. Independent
Settings, acknowledgement and history maintenance remains with catalog hydration.
The quota reader retains it even when the provider
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
each eligible account. In a batch, each query receives the quota status and
history for its own admitted range. Equivalent reads can share their result.
A current-only query receives current allowance without another query's
history or continuation. Each history result preserves any non-null
`nextCursor`, marking both
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
`confirmed` flag cannot grant it. After the Machine confirms an eligible found
source, dismissal records the opaque source ID in Account KV for that Machine.
The UI, CLI and Agent dispatch the Action to that Account owner. Discovery and
inventory separate dismissed sources from the normal picker. Agent and MCP
summaries include their opaque IDs under `summary.dismissedSourceIds`. Pass
`dismissed: false` with the same source ID to remove its marker. Consent and
capture remain governed by the Machine.

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

Machine browser roots, browse-directory reads and filename queries also enter
this family as `daemon.filesystem.listRoots`,
`daemon.filesystem.browseDirectory` and `daemon.filesystem.listFiles`. They retain
the original caller, Account, Machine, request and cancellation context through
ordinary Action availability and confirmation policy. The existing file-browser
and workspace-file-list request/response schemas and native handlers own path
restrictions, partial results and query budgets; their retained RPC methods are
transport aliases. Opening or retrying a browser does not grant UI authority to
the agent that opened it.

Filename queries capture the existing machine-RPC execution budget in their
admitted input before approval. The native scan starts that allowance when its
effect runs and can return partial results; a competing reply timer does not
discard those results. Caller cancellation still applies.

Authenticated Session browser continuation after a mounted command returns is
currently unsupported: the existing child carrier accepts Workflow children
and retires parent custody on command settlement. The UI refuses an unsupported
Session or signed-origin carrier with `admission_unavailable` instead of
borrowing an ambient Account RPC. Extending that continuation requires an
explicit child-wire and browser-lifetime contract change.

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

In 0.3 development, `file.view.preference.set` persists the File viewer chooser's
selector-sized intent through the answering client's captured Account settings
CAS. A `select` mutation chooses the built-in viewer or one qualified plugin
viewer; selecting `builtin` explicitly keeps the built-in viewer preferred.
A `clear` mutation removes only that selector's preference and restores ordinary
SDK matching. It does not reset the whole preference map. Temporary **Open as
text** remains tab-local. Policy refusal, a stale reviewed settings version or
an unconfirmed write leaves the current viewer and navigation unchanged. The
Action does not require the original File tab to remain mounted, so a delivered
plugin viewer uses the same admitted preference writer when returning to Default.

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
borrowing its owner's authority. The person's own UI copy uses the shared
present-user admission and retains its designed confirmation; it never supplies
a client-written waiver. These are development-source
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
In 0.3 development, the Account CLI and installed Session agents use the same
signed requester admission to read status for a shared Worker. A direct or Team
Use grant is sufficient. The receiving daemon uses the requester's Account to
read the Project rows.

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

In 0.3 development source, each reviewed Start admits its requester and Machine
once and inspects the SOURCE once. Approval preparation is a separate request.
Copy, setup and passive review retain that admission while preserving exact
declaration, destination, setup-consent and launch checks. Revocation after Start
admission does not interrupt it; the next Start refuses, and explicit Stop remains
available. These owner-test contracts do not certify a loaded service journey.

In unreleased 0.3, refused declared-Service Starts retain the supervisor's
content-free `failureCause` through the launcher response, retained Start operation and approved Action
replay. The native Start observer carries the supervisor's same failure facts
into operation settlement, including when the RPC completes successfully. The Action failure carries it at the top level, alongside `errorCode`;
`details.establishmentFailure` remains the structured process/bind diagnosis.
On a bind collision the public code is `project_service_start_unavailable` for
command and terminal services or `deployment_port_in_use` for Compose. Both
carry the nested `port_in_use` cause. Setup that autostarts a Service carries the
same failure details and uses the accepted setup's caller authorization.
Use matching development Protocol and daemon/client sources for the closed
launcher response. Earlier responses without a cause remain readable.

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
owner while preserving fresh effect-digest checks. Destination resolution admits
the original requester's selected destination once before native Stop. Later
placement observations retain exact Workspace, root and selected-destination
checks without repeating that requester admission; the fresh Start and native
Exec retain their own authorization boundaries.
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

The finite owner checks requester currentness once when its reservation starts,
then retains that admission through copy, setup and execution. The canonical Exec
owner still authorizes the exact launch. Stop propagates cancellation and waits
for physical settlement; revocation refuses the next request or dequeue rather
than interrupting already-admitted finite work. Exact declaration, effect and
physical-root checks remain distinct from repeated requester authorization, and
Home still authorizes each signed HTTP request at its destination. These are
0.3 development contracts, proven by focused owner tests rather than a claim of
loaded-runtime certification.

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

In 0.3 development, Service Move selects a worker using the Service's source
workspace to find its Sync component. Only enabled links with a usable native
session are candidates; paused or unavailable retained links do not make the
selection ambiguous. Two usable copies of that source workspace on the chosen
Machine still return `workspace_sync_target_ambiguous`.

In 0.3 development, a signed `projects.script.run` or `projects.compute.exec`
prepares its linked worker copy through the existing Sync `prepareBetween`
controller route. The original Action remains addressed to the worker. Its
installed sender attests the original envelope and exact preparation request;
Home rechecks that requester and the selected controller before forwarding it.
The controller opens purpose-bound requester custody, reads that Account's
current refs privately, and uses the incumbent relationship and root owners for
the clean barrier. Preparation does not borrow the custodian's Account sign-in,
publish the requester's graph as the daemon's graph, or authorize another Run.
An Agent or MCP tool in the requester's Session can propose a portable Script
with `selection: { kind: 'named', name: '<declaration>' }` and one exact Worker
Machine. Use the declaration name even when it wraps a detected Make target.
A detected native selection with an explicit Worker returns `primary_only`
before requesting Machine authorization. The requester's answering App presents that
Script, source checkout and Worker for confirmation. Only the App's confirmed
invocation can acquire a new Account root and submit the Run. The proposal
carries no Machine root. An admitted Workflow keeps its accepted Machine.
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
Original Account ingress signs this exact read without disclosing requester
credentials and requires Manage access to the addressed SOURCE. The raw Sync
inspection RPC remains restricted to the Machine custodian.
Its binding reaches the incumbent Sync committed-copy inspection owner, which
refreshes current Home rows around target inspection, checks current Manage
ingress and installation lifetime, and derives the review fingerprint from the
genuine committed receipt and physical root. The exact Home, relationship and
target produce the existing preview/removal identity, including `rootFingerprint`;
consumers do not calculate it. Not-owned and unavailable remain distinct from an
empty copy. For a committed copy on another Account's Machine, the installed
SOURCE forwards the original requester's exact relationship and target through
the existing relationship custody carrier. The target accepts only that retained
copy, original requester and SOURCE installation; this grants no general Machine
inspection access. A missing retained custody match is refused.
Preview after a WORKER daemon restart is refused because this custody is
process-local; use terminate to clean up that copy. A fresh admitted copy can
be previewed normally. No persisted inspection authorization is reconstructed.
The UI sends a reviewed retirement to the SOURCE through the same signed Account
Action as CLI. The controller uses that requester's authority for the selected
teardown Trust read.
No caller path, row presence or
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

In 0.3 development, agent, MCP and CLI callers can read linked-session readiness
with `sessions.external.status.get`, read transcript deltas with
`sessions.external.transcript.readAfter`, and request
`sessions.external.takeover.start`. The takeover Action carries the linked Session
id and destination intent; the host captures the current linked source for the
existing Machine operation. Readiness excludes private Machine observations,
and takeover results expose the shared operation reference and presentation.
Dangerous takeover follows the ordinary surface approval policy. Ephemeral
viewer leases and the predecessor takeover adapter remain internal.

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

In 0.3 development, `workflow.authoring.draft.get` reads the answering client's mounted Workflow editor (omit `draftId` to list drafts in the exact Home/Account scope). It returns the authored definition, block labels, settings, validation issues, dirty state and `draftRevision`. `.edit` accepts the same Protocol edit operations as `workflow.definition.edit` and an optional `settings` patch for description, project target, execution target and trigger drafts, guarded by `expectedDraftRevision`. Supply operations, settings or both; a combined edit is one undoable change and highlights changed blocks. Trigger settings use the desired rows and context returned by `.get`, not a durable trigger write. Native settings controls share this snapshot mutation owner, including on a new unsaved Workflow. Stale revisions, invalid edit operations and unavailable trigger restoration are refused without partial edits. Definition operations and description require document-edit access; a view recipient retains the native editor's personal target and trigger permissions, but not Undo, Redo or Discard authority. `.undo` and `.redo` use the existing editor history. These operations neither save nor run. `.save` is an explicit write through the host's existing validation, saved-revision CAS and trigger Save, and waits for its outcome. Remembering the editor's personal project target is best effort: a pending or unavailable Account-memory reader or a failed memory write does not refuse definition Save or skip trigger Save. Its definition and trigger child Actions retain the admitted caller's surface, authority, identity, provenance and restrictions; parent confirmation or approval bypass is not consent for a child Action. Agent trigger approval can keep Save pending without a trigger effect; native Save retains UI admission. Save preserves its existing sequence rather than becoming transactional: a definition or personal target already saved can remain committed if a later trigger write is refused, with pending trigger edits retained for retry. `.discard` follows the Action's approval policy. Saved-document Discard changes applies immediately without another confirmation and stays undoable. Discarding an unsaved draft retains the existing confirmation; Cancel keeps the draft. If a route change or import replaces the unsaved draft while confirmation is open, the confirmation is refused and the replacement's content and history stay intact. Conversation binding shares this mounted registration. No/ambiguous matching owner is `unavailable`, and a Home/Account mismatch is refused; no Action opens, loads or creates an editor. These client-placed Actions are exposed through Agent/MCP, conventional Voice and the existing answering-client CLI transport; raw RPC exposure remains disabled.

The shared edit operations include `upsert_role { role }` and `remove_role { roleId }` for definition-local roles. Upsert adds or replaces the canonical `WorkflowRoleV1` entry by its unchanged id, including inline name/instructions, engine and runs-as or a catalog-role pin. Remove deletes that local entry, restoring catalog inheritance for a referenced role. The native Roles editor dispatches these same operations as one history batch per edit; saved-definition validation and frozen Run role admission keep their existing owners. CLI commands follow the Action ids (`workflow authoring draft get|edit|undo|redo|save|discard`, `workflow run review draft set` and `workflow library view get|set|reset`). Friendly mounted-authoring commands exit nonzero for `refused` or `unavailable`, preserving the outcome in the failure details; `applied`, `unchanged` and available draft reads succeed. Review preparation and Library-view commands still operate only on the answering client's mounted owners, with their existing authority and confirmation rules.

The `workflow definition import <file|->` and `workflow definition export <id> [file|-]` adapters use the compiled command's option policy, including Machine and project targeting. Import from stdin consumes the dispatch cancellation signal before invoking the Action; cancellation does not wait for EOF or import a partial document.

The shared saved-definition owner applies `admitAgentStartV1` to agent create, update and edit, including child Actions from mounted draft Save and Save as copy. It checks the materialized permission ceiling even when an Action-only or Wait-only workflow starts no Agents, and resolves nested plugin workflows through the same materializer. The same ceiling governs Run admission: non-Agent leaves contribute declared permissions, including inherited defaults; omission grants no additional authority. Agent steps retain their canonical `default` permission when omitted, and resolved child starts contribute their effective permissions. An excessive ceiling returns `definition_exceeds_authority` with the policy cause before the Artifact write; the stored content and revision stay unchanged. Mounted draft Save retains the canonical failure code in its refusal's `reason` and keeps the local edits. Missing caller context is refused rather than treated as a human edit. Human definition edits remain unrestricted by Agent-start policy. Trigger writes consume that same ceiling and policy; import and capture only prepare unsaved content.

`workflow.run.review.draft.set` sets only the displayed human value buffer for an exact mounted hold (`draftId` is the invocation id, plus `runId` and `expectedContentRevision`). It preserves Keep my edits / Use newer when another result arrives and never publishes or accepts a result. Acceptance remains `workflow.run.invocations.complete_review`. Saved-definition edits and agent result publication keep their separate persisted contracts; mounted-draft Actions do not add another store or channel.

In unreleased 0.3 development source, Keep my edits preserves the person's exact
draft and advances its acknowledged content revision to the displayed Agent
publication. Use accepts that draft against the acknowledged revision with
human Account attribution. A later publication warns again and retains the
normal revision-CAS refusal until acknowledged; Use newer replaces the draft.

Review completion uses ordinary configurable Action approvals, without a
present-user floor. Supplied values take their provenance from host-admitted
caller context, including the original author of an approved replay: agent
values remain agent-published; human values retain the answering Account for
“Answered by you” or the person's name. Using the stored result preserves its
existing provenance. Retry acknowledgement requires the same value and source.

Mounted Workflow Actions use the existing Machine reverse-RPC room with the Home/Account scope and draft id in its address. Only the client that currently mounts that address registers it; another signed-in tab cannot answer through its generic client Action handler. Replacing or closing the draft retires its address. A scope-only Get uses the same room family for the mounted scope, and multiple answering clients are unavailable rather than selected by socket order. The exact installed Machine still authenticates the continuation: installation custody is checked on the sending daemon, not on the receiving App client. The answering client rechecks Account scope and normal Action approvals.

In 0.3 development, a presented new or saved Workflow editor publishes its name and mounted address through the existing current-UI context owner. `ui.current_context.read` returns a `workflow` entity whose `reference` contains `scope` and `draftId` for `workflow.authoring.draft.get`; a saved editor also supplies `workflowId` for saved-definition Actions. This identifies the editor without reading its authored content into the context projection. Draft mutations continue through their ordinary Action admission and approval owners.

Retained workspace destinations inherit the workspace's semantic focus. When Expo
hosts the route body itself, `WorkspaceRouteEntry` publishes its focused-scene
eligibility through the same focus owner. Both paths let the mounted editor
publish its entity; focusing a composer field adds its commands through the
existing command composition without replacing that entity.

`workflow.authoring.draft.save` and `workflow.definition.update` are safe Actions and do not require an approval card by default, including Agent/MCP requests. Explicit surface Require preferences or a selected approval profile can require review through the existing Action approval owner; draft Save's definition and trigger children keep their own policy. `approval.result: 'required'` describes result custody when review is required, rather than enabling review. The person's own UI admission described below does not exempt an agent request. A mutating reverse-RPC result of `outcome_uncertain` means the effect may have applied without its acknowledgement reaching the caller: read the mounted draft's revision and content before deciding whether to retry.

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

In unreleased 0.3 source, CLI `ui find` uses this same Action and the answering
app's mounted Find owner. `clientId` selects an answering app and `target`
selects its mounted surface; omission uses its focused or last-interacted surface.
An absent app returns `unavailable` with reason `noClient`; an absent Machine
transport retains its distinct transport failure. Existing Action policy and
confirmation apply to CLI calls as they do to the other declared surfaces.

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
Action share the daemon request writer, including request-identity validation
and result observation. Agent and MCP requests default to Ask, which the user
can change. The daemon checks that the Run belongs to the authenticated requester’s
Account before applying the answer.

### Notification webhooks and this app’s updates (development)

`notifications.webhooks.*` discovers configured channels without returning signing secrets and
adds, edits, removes or changes their signing secret through the captured Account settings writer.
The UI and Actions share the channel reducers and attention-policy mirror. Signing-secret input
uses the Action secret field, is removed from observations, and has live-only approval custody.
Webhook mutations retain ordinary dangerous-Action confirmation and do not send a notification.

In 0.3 development, `notifications.webhooks.test` sends one fixed diagnostic message to a
configured channel through the captured Account daemon's existing webhook sender and SavedSecret
signing owner. It asks first by default, including for agents. The receipt distinguishes
`delivered` (HTTP acceptance), `refused` with a reason, and `unreachable` with a diagnostic code;
it contains no response body or signing material. The expanded channel offers **Send test** and
**Retry** after failure. Each click is a new invocation, with no automatic retry or preference
change. A successful diagnostic does not validate enabled/topic/quiet-hour or privacy policy.

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
An explicit `{ refresh: true }` retries the UI Home's already-demanded registry
projections through their existing invalidation owner. This is the same Action
used by the Connected Services Retry controls; it adds no background demand.
The immediate result reports held facts while reacquisition completes. The CLI
reads its current admitted in-process registry directly.

In 0.3 development, give `{ machineId, service: { pluginId, localId } }` to
describe one service. Select the exact Machine from the Machine inventory and
copy the qualified service from the Account catalog. The existing custodian-only
Machine route returns the service descriptor and sign-in modes, peer-operation
availability and saved account profiles, or the owner's typed refusal.
The Action excludes opaque daemon diagnostics and credential contents.

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
promotion transaction. Service replacements can also pass `selectedSecrets`, a
field-id map of existing `{ ref, resourceRevision }` selections or `null`.
Omission preserves a field's reference, `null` clears it, and a selection replaces
it; a field cannot also contain an entered secret value. Required fields still
must be configured. Selection uses Saved Secret metadata and the existing
reference-revision admission, without acquiring the secret value. Account and
attempt replacements do not accept these selections.

Reads return values, readiness, configured secret field ids and service-scoped
`secretRefs` metadata, never secret material. In 0.3 development, inspecting an Account
authentication mode that declares no configuration returns `ready` with a null
revision and empty fields; it does not create a configuration record. A conflict leaves the caller's draft intact; an
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
ordinary purpose catalog revision check. During activation, the two retired
per-Agent Settings maps can seed an absent purpose catalog. An existing ready
catalog, including an empty or deleted catalog, takes precedence. Once the
catalog is ready, activation retires the two maps from current Settings and
retained Settings history. The service-level default account preference
continues to live in Settings.
In development source, edits to an active purpose or configuration catalog read
its admitted row without waiting for retained Settings-history maintenance.
An absent row still enters the existing catalog initialization path; ordinary
catalog observation continues to own source and history cleanup.

The development Protocol contract separates personal Account/group labels from a pool's
definition name: `accounts.rename` and `labels.set/reset` share the presentation-row writer,
while `pools.patch.displayName` still changes the definition. Acknowledgement Actions address
an exact adoption subject or Account/machine warning; explicit `false`, empty warning ids and
literal machine ids keep their meaning. The pool detail menu's Edit label uses `labels.set/reset`
through the existing inline name editor; Rename continues to edit the pool definition.
The unused development-only disclosure Actions and their metadata transfer path have been removed;
service-rail folding remains device-local.
The mounted Agent pool-adoption dismissal enters `acknowledgements.set` with
its captured Home and Account before the metadata owner writes its row.

Definite revoke and pool-delete results may carry the existing typed `metadataCleanup` outcome.
`cleanup-pending` preserves the acknowledged primary effect when related purpose/default or
personal-metadata cleanup cannot finish, including after the initiating Account retires.
Qualification is captured before deletion; unavailable preparation never blocks the primary
operation, and missing cleanup support is not evidence of completion. Unknown primary outcomes
remain unknown. These contracts are still being integrated into the captured UI/CLI producers;
their package and composed-runtime checks are pending.

### Bot template authoring (0.3 development)

`template.draft` writes an owner-private `bot_template.v1` Artifact and records
its reserved address in the source Session's owner-private work metadata. Each
Bot has one private draft: repeated agent requests update that address using the
current revision acquired by the Action owner. Agent and MCP inputs exclude
revisions; an editor save retains its explicit observed revision to detect stale
edits. The Action defaults to Allow for agents; the person's configured Action
policy still applies. `template.open` opens that draft in the current UI context. The draft
card returns a projected summary rather than private candidate content.

`template.release` defaults to Ask. Its reviewed operands capture the draft
revision, full SemVer, notes and selected named recipients. One admission covers
the release and its Can-copy grants through the existing Artifact sharing owner.
Grants are view access and confer no source Session access. A changed draft
returns the existing revision conflict. A retry reuses the release only when
content, version and notes match; a higher version deliberately creates a new
release even when content is unchanged. Publication may also capture the reviewed
`releasedAtMs`, so its package and direct-share release contain identical portable
bytes. A supplied timestamp must match on retry. Autosaves remain private and do
not update the released Artifact.

Template Actions admit the person's review once and use the executing host's
ordinary Account transport. Draft uses owner metadata tuple CAS; release permits
reviewed Account, Team and Group view grants. A reviewed signed-in link is a
child of that same host executor's release admission through
`artifact.public_link.create`. The server's Artifact owner decides the link
authority without template child-role knowledge. Link management uses the existing public-link Action family with
`audience:'signed_in'`; anonymous publication remains unavailable for templates.
Standalone link creation retains the existing present-user authority; scoped
automation creates a link through that reviewed release child.
In 0.3 development, public-link placement is selected by the Action spec from
the caller and surface. Only an absent or host caller on the CLI or UI person
surface uses Account placement; a person invoking the CLI receives the link in
their terminal without requiring an App. All other callers and surfaces,
including standalone MCP agents with waived approval, use the answering
client's existing approval and reverse-dispatch path. The issuing App receives
the capability once through `onPublicLinkIssued` and opens its issued-link Share
sheet with the selected anonymous or signed-in audience. The agent's result and
observation retain only the redacted creation receipt. A missing answering client
returns the existing typed client-unavailable refusal. Home and Account custody
remain bound to the answering client; list, revoke and audit retain their
Account owners. No capability is persisted for later recovery by Share.

`artifact.public_link.join` consumes a fragment from its transient host port,
checks the returned recipient against the host's captured Account/key, and
creates only the caller's ordinary view grant. Its result contains source
identity and follow availability, without the fragment or opened content.
Instantiate creates its private accepted base and recipient owner metadata using
ordinary resource owners. Named children run through the same host executor's
reviewed-child port, including creation, Instructions, memory and skills. Session
birth, data-key envelopes and Machine access-key binding use the ordinary bearer for Account credentials;
the Session owner checks ownership and the selected Machine before onboarding.
Restricted API tokens retain their signed parent token-only transport for content,
birth and onboarding, exact template HTTP-purpose checks and existing grants.
Full credentials have no template route grammar, separate
effect list or requester authorship authority: the format schema, reviewed
preview and consent confine template content.

The ordinary creator consumes the admitted requester's full encryption-currentness
fact through its host-private creation input. Without that fact, the existing
signed requester reader resolves it once; creation and rejoin reuse the result.
A Plain requester needs no Account encryption keys, including on an encrypted
custodian's Machine. A distinct E2EE requester without prepared Account custody
returns the existing `requester_account_material_unavailable` result before
template content or Session creation, even when a plugin source is readable.

`template.preview` reads one addressed release, including carried skill files.
Its optional `presentation` carries the Artifact owner's `ownerDisplayName` and
admitted `shared` fact from that same read. The existing neutral Account display
owner resolves the name; portable template bytes never establish authorship.
Missing names, unknown sharing and plugin sources remain unlabeled. The header
uses the release's existing version, without another version field or read.
`template.export_file` returns one exact bundle entry for client download; both
operations leave the recipient's inventory unchanged. `template.instantiate`
checks the requested release version and any supplied observed revision once.
An Agent may omit the revision; preparation retains the resolved revision in the
existing Action input and captures the release in the same approval preview, so
replay still refuses a source changed after review. An explicit stale revision refuses
before the card. The Action has Account placement. The
requester's host runs the admitted composition so birth can commit while the
selected Machine's daemon is asleep. Its reviewed children use ordinary Bot creation,
instruction, memory and skill owners. The host commits those resources and the
recipient's private accepted base before launching the Agent. Carried skills
are included only in that Session and keep the admitted instantiator's attribution.
The nested ordinary creation selection retains initial access, manager, primary
Team and Team credential bindings. E2EE recipient envelopes are prepared through
the existing Session envelope owner before copied content and the first Pending
input are admitted.

Agent and MCP callers may omit `creation.executionTarget` and `creation.agentTarget`.
The ordinary Session start owner resolves them from the authenticated calling
Session's current Machine and Agent before review and strict creation admission;
explicit choices remain unchanged. Directory intent remains explicit. The
advertised authoring schema and nested input hints describe those omissions and
the canonical Agent contribution identity. Other callers and reviewed child
requests retain the full creation schema.

The development setup review carries the recipient's software recipe choices,
Connected Account references and MCP input references. Required needs must be
resolved; optional needs can be skipped with their stated consequence. Software
uses the existing Machine setup plan/apply owners; MCP entries are recipient-owned
and included only in this Session. Inspecting the release acquires no credentials.
The ordinary recipient permission mode remains unchanged. One host-onboarding
input makes the first turn read-only: introduce the Bot and offer the first task.
The first task remains an offer. Creation-key recovery belongs to ordinary Session
creation; failures retain the born Session and created resource addresses.
The selected Machine owns later execution. Its immutable creation recipe carries
admitted deferred setup, while the content `beforeLaunch` continuation stays
local to the birth invocation and is never serialized as a callback.

`template.updates.diff` opens the retained accepted release, one addressed offered
release and the bound recipient instructions and skills. It does not read Memory.
The shared three-way text and skill owners compare the accepted base, current
recipient content and offered content. Conflicting text defaults to keeping local
edits; the person can take the author's text or retain both alternatives and edit
the result. `template.updates.apply` defaults to Ask and admits the selected
content and setup effects together. Each resource keeps its existing revision
check. Only after those writes and the private instance CAS succeed does the
accepted version/base advance. A partial failure returns applied and remaining
resources with recovery addresses; it neither rolls back successful writes nor
announces the offered version as accepted. Memory remains unchanged.
If Review again selects a newer release after resource creation succeeded but
Session inclusion failed, Update reuses those addresses and reconciles explicitly
taken skills and MCP definitions to the newly reviewed content through their
ordinary revision-checked writers before inclusion and base acceptance.
Apply ignores unrelated Session metadata changes while retaining the private
instance CAS and the selected instruction/skill revisions. Software uses ordinary
`machines.setup.plan` / `machines.setup.apply`; the ordinary setup/spawn admission
integration and live installer proof remain pending at the Machine setup owner.

`template.updates.skip` suppresses one offered version, while `template.follow.stop`
withdraws following. Both mutate only the private instance through its targeted
writer and retain the Bot, accepted base and source. Neither reports adoption.
Successful direct-copy and update settlement can send a best-effort accepted
version to the Artifact sharing owner. Existing `artifact.access.grants.list`
rows expose last-reported version summaries only to the template owner; there is
no additional recipient-list Action or Store reporting.

A Plain Account opening a signed-in link to an E2EE template receives
`recipient_key_unavailable` with reason `plain_account` and no copy controls.
Updates and copies need an encrypted Account; publishing the template to the
Store lets either Account mode use it. Opened bytes and the link fragment are
not Action operands.

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
indexes plaintext titles or provenance for E2EE Accounts. Public lists without
an explicit kind use the existing `browserListed=true` selection before paging
and opening headers on both CLI/daemon and UI hosts. Unknown ordinary kinds and
readable unclassified documents retain browser membership; classified internal
inventory does not contribute to public list work. Explicit `kind` or
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

In the same development source, `artifact.export` accepts
`{ artifactId, destination: 'client', fileName? }` for browser download or native
share/save. Text documents export as UTF-8 Markdown with a `.md` filename and
`text/markdown` media type. Prompt Library documents use the canonical prompt
reader to export their Markdown rather than their stored JSON envelope. The
saved document editor's overflow menu invokes this same Action; unsaved edits
remain in the editor. Binary documents retain their exact bytes and media type.

`artifact.export` also accepts
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
`storage.inventory.read` defaults to the authenticated Account. To read one
Discussion, pass `scope: { kind: 'discussion', discussionId }`. Home checks
current Discussion read access. A participant's Discussion inventory counts
attachments on messages they can read. The Discussion owner sees all attachments
billed to them in both Discussion and Account inventories. Discussion scope has
no Artifact limit.

The summary includes the measured total, per-kind sizes, and the nullable
Artifact limit. When configured, `artifactBilledBytes` gives the bytes counted
toward that limit. The physical total includes approval records and their
retained versions. Paged inventory also reports `kinds[kind].itemCount` for
the full scope, including items with an unmeasured size. A null size means
a kind has at least one unmeasured item. Earlier paged responses may omit
`itemCount`.
Profile picture, avatar and Team logo uploads record the normalized bytes
written. Older images remain unknown where their size was never retained.
Empty kinds count as zero. The optional `kinds` filter selects page items and
leaves the scope summary intact. Items are sorted largest first, with unknown
sizes last. Request the next page with the returned cursor. Rows carry an ID,
kind, size, storage location and date when available. Clients supply names.
Discussion attachment locations include the exact Discussion, message and
attachment IDs for the client to resolve names in one batched message read.
The existing HTTP usage projection remains available without `inventory=true`.

`artifact.list` accepts `sort: 'size_desc'`. Its `storedSizeBytes` covers the
Artifact's stored header, current body, provenance, retained versions and
distinct file blobs. Wrapped keys and row metadata are excluded. Shared
Artifacts contribute to the owner's inventory. `artifact.revisions.list`
with `projection: 'headers'` gives each retained version's size and date
without fetching its body. Several versions can refer to the same file. The
version size includes that file when linked, and the whole Artifact counts it
once. `artifact.revisions.trim` returns freed bytes and current Artifact
usage after removing old versions for one owned Artifact. It keeps the
current version and its file. Agents ask for approval by default.

`discussion.attachment.remove` takes the Discussion ID, message ID and blob ID.
Home admits the message author or Discussion owner. The message remains, and
the attachment read returns the blob ID and the Account ID of the person who
removed it. Agent requests ask for approval by default.

Optional document and Account budgets default to unlimited. A rejected write returns `quota_exceeded` with
`{budget,limitBytes,usedBytes}` in the canonical Action failure's `details`.
`usedBytes` is the projected storage after the attempted write. Delete or export
provides recovery; a rejected write changes neither content nor history.

Operators configure retention with `HAPPIER_ARTIFACT_REVISION_RETENTION_COUNT`
(default 10, zero disables retention), and optional byte limits with
`HAPPIER_ARTIFACT_DOCUMENT_LIMIT_BYTES` and
`HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES`. These are live policy entries in the
existing server configuration owner. The document limit covers its current
stored header, body, retained revisions and distinct stored blobs. The Account
limit counts these bytes across ordinary documents. In unreleased 0.3, approval records and their
retained versions are excluded from Account usage and the Account limit, but
remain subject to the document limit, which is checked first. Consents, notices
and deployment receipts still count toward both budgets. Plain server-sealing overhead
counts toward the billed bytes.

Sharing remains with `artifact.access.grants.*` and the server grant owner.
In 0.3 development, grant-list reads consume only the authenticated access
roster, without opening private Artifact content or preparing recipient keys.
Session-origin signed reads admit only the existing bodyless
`GET /v1/artifacts/:id/access/grants` route; listing grants does not authorize
content reads or grant mutations.
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
foreign read. One invocation is admitted once, after any Action hook has returned
its final operands, and dispatch spends that decision; a detached child is refused
at the next admission. In 0.3 development, a restricted `current_session` host can also
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
`clientRoutedActionIds.generated.ts` as the type-only effective client-capable set,
plus `tools/autoApprovedNames.generated.ts` for native Agent permission projections.
The safe-tool leaf contains safe Action MCP bindings, the four Action meta tools,
and `change_title` when `session_title_set` is safe. Permission consumers import
that leaf without loading Action schemas; the catalog remains the safety authority.
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
`check:action-type-map` compares the SDK outputs, generated placement type and safe-tool leaf without
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

In 0.3 development, connected-account routing choices use the admitted
Session's Machine RPC and the Account's connected-account and Team catalogs.
The read works with a stopped runner. A Machine RPC timeout reaches the form
as a typed failure with its options request ID. The CLI and Agent surfaces
submit the chosen route through the same `session.connected_services_auth.set`
Action and its existing approval policy.

Usage Project choices use the same admitted accounting inventory as the page.
Omit the period to list all known Projects in the admitted scope. A relative
period without an offset uses UTC, like `usage.query`. To get the same choices
as a person's page for a relative period, pass that person's
`timeZoneOffsetMinutes` in `draftInput`. When a caller supplies `limit`, it can
pass the returned `nextCursor` back as `cursor` with the same draft and search
to continue.

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
`chat.item.show` is the "Show here" of a transcript reply: it selects the visible
occurrence of a readable Session item in this viewer's transcript. Board and
panel surfaces render independently, with a fresh body when opened. The mounted
controller keeps the selected occurrence while that reply is demanded;
`unavailable` is the typed result when no such reply is visible. It changes
neither the item nor its Board placement.
The optional `occurrenceId` selects an existing mounted reply occurrence. An
unknown or retired occurrence returns `unavailable`; omitting it selects the
latest demanded reply. The reply's UI uses this same Action
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
Voice invokes this same Action, including the Work List/Map, show-more and
expand-map intents, and requires that same current Session/client binding.
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
protected. An owner may explicitly delete a retained Project Overview only when
the private Project-row owner finds no current reference; Forget itself never
deletes its bytes. The dedicated layout owner enforces this exception after
destructive acknowledgement. Generic Artifact Actions consume the existing internal-kind policy
and cannot read, manufacture, retag, update, delete or restore dashboard documents;
their dedicated widget and sharing Actions remain the admitted paths. Shared
Project and WorkBoard widget writes use actual admitted
Artifact sharing facts for the same configurable confirmation policy as shared
Session content, not the surface kind as a personal-write exemption. Optional
input `paths` select exactly which saved choices to set or reset against the
owner's current bindings; omitting them retains whole-binding replacement/reset.

## Agent backend readiness (0.3 development source)

`agents.backends.list` and the `agents.backends.enabled` / `execution.backends.enabled`
option sources share one composer, `listAgentBackendsWithReadinessV1`
(`packages/protocol/src/actions/executor/agents/agentBackendReadiness.ts`). When a Machine
is named (`machineId`, or the invoking Session's Machine for `subagents.delegate.start` and
`subagents.plan.start` options), each row carries `readiness`: the Machine Agent inventory
facts (`machines.agents.list`: installed, platform, dependencies, native sign-in) decided by
`resolveMachineAgentExecutionStateV1`, with the Account's connected-service default per Agent
(`agentsConnectedDefaultRoutesRead`, CLI `readAgentConnectedDefaultRoutes`, the same read the
background-task runner candidates use) satisfying authentication. A connected default that
cannot be read leaves sign-in unknown; without that dep only executable prerequisites decide.
Option sources keep `needsSignIn`, `notInstalled` and `unsupported` rows listed but disabled,
with the reason as the description; unknown never blocks. Rows are matched to inventory by
`findMachineAgentInventoryItemForTargetV1`, the same matcher the UI picker facts and the
default-Agent owner use.

Run start refuses a known not-ready Agent before any Run exists. Every Run start
(`execution.run.start`, `subagents.delegate.start`, `subagents.plan.start`, `voice_agent.start`,
`review.start`) passes `startExecutionRunWithSelection`, which calls
`refuseAgentStartWhenNotReadyV1` with the Machine that will run the Agent (the target Machine,
else the exact Machine from the V2 preflight, else the start context's baseline Machine, else the
Session's Machine). It reads the same per-target readiness as the option sources above. A
blocking state refuses that start with the existing spawn codes: `notInstalled` →
`agent_cli_missing`, `needsSignIn` → `agent_signed_out`, `unsupported` → `agent_cli_not_ready`,
in the existing run-start failure envelope (`details.executionRunStart.runCreation: 'noRunCreated'`).
In a fan-out start only that backend's item
fails. Unknown, checking or unreadable readiness admits, and launch stays the authority.

## Agent/MCP operation admission (0.3 development source)

An Action whose catalog spec declares `operation` returns to an Agent/MCP caller
when the receiving host admits it. The acknowledgement contains
`{ status: 'accepted', operationId, machineId }`; use the original invocation's
Home when addressing that Machine. This is not the
Action's completed result. Use the existing `action.operations.get` Action and
Activity observations to follow that same operation and read its terminal result.
Do not submit the effect again merely because it is still running. Receiving-host
execution keeps its existing operation cancellation and requester custody lifetime;
the MCP call adds no timer or operation state. Approved replay still waits for the
real terminal result so an approval receipt cannot settle on admission alone.
UI and CLI retain their existing observation behavior. Native finite Project
Actions and Project open retain their existing domain admission receipts and
operation addresses, owned by those domain runtimes.

The operation owner captures private `actor` references at root admission and
replaces them with the actual approving person at the normal pre-dispatch
boundary when approval arrives later. An accepted approval without a deciding
Account records unknown (`null`), so the initiating Agent is not shown as the
approver. Observation, retries and recovery retain the captured historical fact.
Current V2 reads carry it; the supported V1 compatibility projection omits it.
Deployment receipts consume this same accepted fact at their first execution
transition. `deriveActionActorV1` owns provenance selection, and
`useDeploymentActorPresentations` resolves names through the existing person,
Session Agent and Workflow/Automation readers. Qualified `onBehalfOf` references
keep their own Home; missing historical references stay unknown.

Ordinary replayable Agent/MCP approval requests return
`approval_request_created` with their existing Artifact handle before a person
answers. Read `approval.request.get` for their status and settled receipt. This
includes Account-target plugin Actions with ordinary inputs: execution placement
alone does not require live-only input custody. Declared secret inputs and explicit
`approvalInputCustody: 'live_only'` keep their existing live continuation contract;
a vendor timeout can still end that invocation. No secret is added to durable
approval storage to avoid that timeout.

Actions without an operation declaration retain their existing result contracts.
A long arbitrary command, contributed effect, explicit wait or external transport
may still outlast a vendor's tool timeout. Such paths require an owner decision
about their existing lifecycle; MCP does not manufacture an operation record.

If a forwarded tool call reaches the Happier MCP bridge deadline, its tool
result carries `isError: true` and `structuredContent.code` with the MCP
request-timeout code (`-32001`). The timeout applies to that call. The Session's
stdio relay can serve the next request while the Agent keeps the connection open.

A newly added runtime Machine can restore the serving own-server release while
an approved deployment rolls out its replacement. The archive holder uses the
existing signed Deploy child and checks the exact archive provenance before
starting the transfer. The deployment approval covers that download.

An own-server deployment reviews its runtime Machines before presenting the
approval request. When a remote review renders a saved private-service
reference, its receiving installation signs the Environment read with the
controller's existing deployment child packet. Home verifies that packet
against the same request and current placement. The referenced Environment,
its content, and the Machine reads keep their existing access rules. Deploy
preparation can read service inventory on a current installed runtime Machine
of that referenced Environment. The inventory request carries the same signed
reference and selects that exact Environment and Machine. The receiving Machine
checks the decoded operands on both plaintext and encrypted calls. Before Home
accepts a receipt, the signed review still uses requester admission. Afterward,
inventory calls use the active receipt and the current placement of the
referenced service.

An explicit Domain Add to reconcile after a restart starts a new Domain
operation. Home admits it against the current Environment, runtime Link, and
Domain revisions. Any native work uses the placements captured for that
pending operation. If the runtime Link revision changes before discovery,
Home refuses the stale request before creating a pending Domain. The Action
operation and approval result retain `target_link_revision_mismatch` and
`expectedTargetLinkRevision`. Refresh the Environment and review the Domain
action again. The deployment receipt
describes the incumbent workload. A settled Domain capture cannot authorize
new native work.

### Transport and header refusals (0.3 development source)

`not_authenticated` means Home answered an authentication refusal (HTTP 401/403).
Two other cases keep their own typed result:

- A caller with no Session Action transport (a detached native run, a CLI process
  outside a Session, an Agent call outside Session MCP) gets
  `action_transport_unavailable` from `sessionActionTransportUnavailable`
  (`apps/cli/src/mcp/runtime/sessionMcpLocalContext.ts`). Detached runs have no
  Action transport today; giving them a requester-Account transport is an open
  owner decision.
- A local external-Action header refusal (missing signing key or installation id,
  missing target, Home identity mismatch, an external credential without signed
  admission, or a port with no signed external carrier) returns the existing
  `action_failed` carrier with `details.authorizationRefusalReason`, built once by
  `externalActionHeaderRefusalFailure` (`apps/cli/src/api/externalActionHeaderRefusal.ts`).
  Ports that return failures call it; null-only adapters throw the same carrier
  through `requireExternalActionHeaders`.

## Operations outcome links (0.3 development source)

Operations Investigate uses the configured Triage handoff owner for placement:
receipt/Environment controller plus its Project Source workspace, or the
Machine's managed workspace when no folder is attached. `projects.list` retains
accepted workspace `sourceId`; `agents.backends.list` optionally projects the
ordinary New Session owner's exact `defaultTargetKey`. No new preferences are
stored. Missing/ambiguous placement or default Agent returns the closed
`placement_choice_required` presentation result with reason, qualified placement
candidates and exact Agent inventory keys. UI chooses explicitly through
`investigateWithPlacement`; it does not resolve placement or redirect to settings.

Investigate and trigger Workflow outcome presentation uses
`projectOperationsRunOutcome` and `useOperationsRunOutcome`. Callers supply the
already-opened canonical owners: the exact Triage handoff,
`useInboxReadySessionResult` projection and optional committed Session message
reference, or Workflow final result; the SCM pull request or Action
approval result; the qualified Action operation projection or deployment receipt;
and the existing deployment controller's live health feed plus its scope's
`serverId` as `healthServerId`. Missing links remain
absent. This composition does not parse Session prose to discover effects or
create a new result store, loader, timer or success flag.

The four fields remain independent: `finding`, `proposal`, `appliedEffect` and
`recovery`. A composed Session draft is only a handoff, an approval is only a
proposal, and a settled Action or historical receipt cannot establish recovery.
The original investigated receipt is passed separately as `subjectReceipt`;
`appliedEffect.receipt` can name a later remediation. Recovery correlates the same
Environment and runtime target link, or the exact
Machine/service row, then preserves the health owner's status and coverage.
Unknown or partial coverage remains visible. Subjects without a matching live
health owner expose unavailable recovery rather than borrowing Environment
health to claim that a backup, Machine setup or certificate recovered.

## Workflow inputs and complete review reads (0.3 development source)

Wait blocks may bind optional `input` references through the same document and
value-reference owners as Agent steps. The coordinator captures their values
before entering the human hold, without preparing a workspace, and publishes
them in the existing private invocation `progress.input`: `document` retains
the authored prompt, `input` holds the resolved values, and `renderedText`
holds the owner-rendered prompt. Readers use that text rather than formatting
the same facts again. As with Agent steps, absent optional Event references are
omitted from the resolved-value array; its positions are not a named-fact API.
An unanswered hold retains its captured input on resume.
Waits without bindings retain their existing behavior.

The built-in PR setup hold binds the provider's author login/id, association,
repository, PR number and pinned head, plus the saved Standard composition.
The Run's existing `acceptedContext.machineId` and `workspaceTarget.project`
describe Workflow execution placement; they do not assert an optional source
preparation destination or each reviewer Session's placement. Association is `internal`, `external` or
`unknown`; it does not establish that someone is a first-time contributor.
Approval continues the ordinary hold. Denial stops the Run through
`workflow.run.cancel`, before workspace preparation or review; there is no
separate PR denial result or approval endpoint.

Workflow and hook pickers use the ordinary admitted `action.spec.search` read.
Its optional `purpose: 'workflow_step'` selects executable Workflow steps;
`purpose: 'automation'` includes eligible host-internal effects for before/after
hooks, independently of their tool exposure. Both retain the Action owner's
enabled and credential decisions. `limit: null` requests every matching summary;
omission retains ordinary search paging. The CLI's `actions search` accepts
`--purpose` and `--limit-json null` through the same schema. These discovery
choices do not authorize execution. Event pickers use `workflow.events.list`
rather than interpreting a private daemon projection themselves.

Resource Link reads combine the admitted before/after Action metadata with the
resource's declared Events through the shared trigger-start owner. Native kinds
come from `automation.subjectKinds`; plugin kinds match the qualified declaration.
Completion Actions contribute one After choice; failure is an outcome filter.
Choices become ready only after both catalogs settle successfully. An Event
choice carries a setup-required seed for the existing Event editor, rather than
a fabricated configured source. The resource Link controller binds the selected
subject to the completed Action or Event trigger before writing, while the
ordinary trigger owner validates execution Project or Session lifetime.
Failed catalog reads expose Retry in the section and the open Link form. Both
retry the demanded reads on the mounted Account lifetime; a retained failed
reader does not prevent a new read after admission or transport recovers.

An Event-triggered Workflow can bind `trigger_event` references to declared
Event payload fields. In unreleased 0.3, an Action JSON binding may select an
object or array subtree; conditions, prompt inputs and Action text still select
scalar leaves. Save uses the Event schema owner's declared-property resolver,
and the receiving Action's input contract validates the bound JSON. Admission
copies only referenced scalar values and explicitly selected Action JSON
subtrees into the existing private accepted Workflow content envelope;
unreferenced payload siblings stay out of it. Create and update may supply `intendedTriggers` for draft
membership; otherwise validation uses stored triggers, without changing save
ordering. A removed Event produces a non-blocking `missing_reference` warning;
an invalid declared path blocks with `invalid_input`. Copies retain references
even when their triggers are not copied.
Inline definitions supplied to trigger add or update use the same validator
against the Event being enrolled, including retained inline references.

In unreleased 0.3, Event filters use the same pre-admission evaluator on the server
and executing host. Alongside `eq` and `in`, `gt`, `gte`, `lt` and `lte` compare numbers
numerically and decimal strings without losing precision, including signed,
fractional and exponent forms. Filter operands must match the declared payload
leaf type; numbers and strings are never coerced into each other. Missing fields
and non-decimal strings do not match an ordered comparison.

Action triggers use `event: { kind: 'action', phase: 'before' | 'after' }`;
plugin Events retain their qualified `{ pluginId, localId }` identity. One Action
phase declaration covers the trigger's whole Action set, and its payload retains
the actual invoked `actionId`. The declaration projects the canonical safe
`AutomationActionRunEvidenceV1Schema`: a reference such as `path: ['requestId']`
reads invocation provenance, while raw input, output and exception text have no
declared path. After evidence includes its terminal status. The trigger owner
supplies the same declaration to stored, intended and inline validation.

Action admission skips the Action-trigger index when a ready Home feature snapshot
reports `workflows` disabled or omits its enabled bit. When the snapshot is
unknown, admission still uses the existing index load. If that index read fails,
the Action keeps its result and includes
an `action_automations_not_checked` notice. Its `reason` is `server_unreachable`
for a classified transport failure without an HTTP response. A Home that responds
with an error retains its typed code, such as `database_connection_unavailable`
or `not_found`.

The CLI and daemon retain one Action-trigger index per Account and Home across
caller credentials. Pushed rows reach every retained consumer; each occurrence
HTTP request keeps its originating caller's credential and currentness callback.
If Home cannot acquire a transaction for an index read, the next Action
admission can seed the index again on the same connection.

In 0.3 development source, the Home derives shared Action-trigger reach when
the trigger is written, using the subject's existing edit/manage owner. It
recomputes that decision on later trigger edits; a caller's `reachesOthers`
claim grants no authority. For encrypted Machine, Session, approval-profile,
App, Environment and backup subjects, the Home compares the canonical subject
digest with identities admitted by those owners without opening private
trigger content. A retained Environment continues to use its Source owner's
management authority after Source removal. Logical Project rows and saved
health-check definitions currently have Account-private owners rather than a
shared management grant. Project keys belong to an Account's private rows, so
the same Home and Project key in two Accounts does not grant shared authority.
Plugin-kind subjects also remain owner-only; an embedded core resource id does
not turn a plugin identity into that resource's management grant. These cases,
and omitted subjects or view-only authors, mean “Runs only on your own Actions”.
An encrypted Database subject includes service and database names. Finite
restore requests can carry those operands, but the Home has no existing full
target census to bind a trigger digest to their management authority. An
unproved positive reach claim returns the existing typed
stored-content refusal; own-only authoring remains available. These remaining
bindings are not covered by the six-kind router validation.

Database subjects also accept the canonical worktree, manual and managed
deployment target bindings in unreleased 0.3 development. The deployment
databases owner supplies the managed identity's Home, Environment, Link and
logical database name. These bindings remain own-only; their Machine, Project
or Environment references do not establish a shared Database grant. Private
paths and Saved Secret references stay in protected authored intent, while the
structural selector contains only the canonical subject digest.

The Database list, Connect and describe read producers return an optional
`automationSubject` result on their descriptors. The producer resolves worktree
and manual bindings directly, and deployment services to the existing Environment,
service and database tuple. Managed bindings resolve at the deployment databases
owner to `{serverId, environmentId, targetLinkId, databaseName}`; provider project
and branch identifiers remain outside Automation identity. Managed bindings remain
own-only because no full-database shared grant is established by the Environment.
Deployment data-service reads retain subjects from one target read.
They retain the existing service-keyed `databaseSubjects` map and all managed
logical database subjects in `managedDatabaseSubjects[targetLinkId]`. A page must
select the exact logical database from that collection; a Link can contain several.

Trigger admission seals only referenced leaves in the private accepted snapshot.
Other Events, Run now, schedules and Session lifecycle admissions leave the value
absent. Text substitutes an empty string, conditions treat it as unset, and a
required whole-value Action binding fails with `invalid_input` before execution.
The editor reads current payload declarations through its trigger-set owner.

`workflow.run.start` also accepts `source: { kind: 'repo_file', path }` against
its ordinary Project target. The target host reads the file at the observed repository HEAD using
the existing `happier.workflow` version 1 import/export document format. The
start owner validates the document and freezes its definition, requested path
and immutable repository commit in the accepted Run. Local file edits are
excluded; the recorded commit identifies the document bytes used.
Repeating the same Run id rejoins the accepted snapshot without rereading the
file. Starting a new Run id reads the file again. No watcher or saved-definition
synchronization is involved.

In unreleased 0.3 development, `workflow.run.start` and scheduled occurrences
accept a shared Machine with a current `use` grant through the canonical Machine
admission owner. Revocation refuses the next Run; admitted Runs finish. Review
includes full-sign-in custody and trigger lifetime, with the guest's own Connected
Account credentials and no custodian-profile or native-login fallback. Machine
access does not widen private Run readership. Missing custody returns the typed
re-save/start-again refusal described in [requester custody](encryption.md#access-keys).

In unreleased 0.3 development source, a saved Workflow project target carries
optional Session placement separately from its portable definition. A saved
Machine selects the Run and workspace Machine before admission. Its new Sessions
use that Machine's `automationsWorkflows` policy unless an explicit configured
Sandbox was saved. That choice retains the qualified provisioner, preset and
lifecycle and must match the Machine's current configured entry. Workflow births
reach the same receiving `session.spawn_new` policy owner; an unavailable or
mismatched configured Sandbox returns `target_unavailable` without a host fallback.
A policy's own Directly choice applies normally. A per-start Directly override
requires interactive Manage and cannot come from an unattended Workflow.
Cloud preset placement is declared in the shared selection contract; admitted
acquisition and enrolled-guest continuation remain pending integration.

Schedule and reply-handoff workers in each API process wake after committed
schedule-cursor and ready/retry mutations. Durable rows remain authoritative;
healthy workers sleep until the next schedule or handoff-lease deadline without
periodic idle scans. The existing 10-second recovery timer remains only after a
failed database scan or admission. Startup scans recover persisted work.

Workflow step preparation keeps its pending invocation durable before effects.
Equal pending facts reuse the persisted progress, including for E2EE Runs.
Pending allocation and preparation facts do not refresh the Run's Account feed;
input admission still sends the existing origin-Session delivery hint and wake.
Running, terminal and attention transitions remain published, as do capacity
allocation and review replacement. These are 0.3 development-source contracts.

Saved health checks can enroll an ordinary executable Workflow through
`workflow.trigger.*` with a `pluginEvent` trigger, selecting the Machine-services
`health-check-failed` or `health-check-recovered` contribution. The same request
owner still accepts explicit `observationOnly` enrollment without an execution
target. Event admission returns `observed` for a valid observation-only occurrence,
allowing its committed notice and checkpoint without a Run. A rejected occurrence
cannot publish that notice. Executable enrollment still uses Event admission's
ordinary Run path; neither notices nor health-check ticks launch Workflows. See
[health Event ownership](plugin-platform.md#health-check-kind-declarations-03-development-source).
The internal `automation.event.admit` and `automation.conversation.admit` Actions
do not require confirmation by default. Explicit approval policies still apply.

The same catalog also exposes terminal Deployment receipt Events (failure,
success, promotion completion, cancellation, unknown outcome and rollback),
`managed-machine-setup-failed` and `mcp-update-available`. Managed setup reads
the retained operation settlement; MCP reads the registry tracker's exact
retained upstream observation. Their setup Actions enroll an observation start,
and committed Account row hints wake finite reads through existing authorized
Actions. Payloads contain structural identifiers, states, times and reference
digests; setup scripts, server configuration and upstream content stay private.
These are 0.3 development-source contracts.

`machine-offline` and `machine-online` read committed presence through
`machines.presence.read`, authorized by existing Machine access. Setup records
the current revision, so enrollment emits no initial-state Event. The existing
timeout and recovery owner retains the latest offline/online pair; ordinary
Event admission deduplicates their stable occurrence identities across replay.
These 0.3 development-source Events require the source stack database owner to
deploy `20261102101034_add_machine_presence_transitions` before producer/catalog
reload. Overwritten presence cycles are not a retained history.

Administrative Workflow input hints use the same strict Action schemas and the
editor's source contracts. Saved-definition mutations retain the complete
`{headerVersion, bodyVersion}` revision from `workflow.definition.get`; Run
controls use the numeric `run.revision`; invocation draft/review operations use
the decimal-string `contentRevision` and exact `{recordId}` invocation reference.
Discovery keeps these distinctions when eliciting edits, recovery and capture.

In 0.3 development source, unfiltered `workflow.run.invocations.list` accepts
`knownContentRevisions`, an ID-to-decimal-revision map from the retained invocation
store. The storage query excludes matching records before keyset pagination;
continuations bind that same map. Editor Test-run refreshes indexes and opens
the demanded step's exact progress, including a conditional ancestor when its
private branch choice is needed. A viewed Discussion opens missing or changed
round progress through the same reader. Complete outputs remain in the scoped
fact store; unchanged Run wakes reopen no historical bodies. Requests carry
the known index, so their input size still grows with retained invocation count.
Explicit invocation detail reads continue to own private recovery evidence.

Saved-definition authoring reads the authorized root Artifact directly. Plugin
destination discovery cannot block an edit or turn an acknowledged Save into a
failure. Mutation receipts project the saved root and report unresolved child
references; definition reads resolve reachable children and retain unavailable
references in `destinations.unresolvedWorkflowRefs`. Cancellation still propagates.
An unchanged normalized definition and metadata keep the current revision and
perform no Artifact update or sealing. A real edit still uses the complete
Artifact CAS revision. Only the owner can delete a Workflow definition; stale
header identity or revision does not prevent removal of the owner's damaged row.

Definition capture enters the same Workflow family feature gate before opening
selected Discussion messages. It validates the captured graph directly; it does
not invoke `workflow.validate` merely to discover availability.

Session-trigger Actions admit the caller's Session scope once and carry the
admitted authority, placement and exact firing claim through that Action's
reads and effects. Withdrawal applies at the next Action, not through repeated
post-write checks. Unrelated Sessions remain refused, and executable target
policy is still materialized separately. Account-wide trigger listing reads
Account-owned definitions without admitting each row's execution Session.
Workflow review dispatch likewise consumes the Session scope resolved during
that Action's host preparation; the next Action resolves a fresh scope.

`workflow.run.cancel` is the one public Run cancel Action for both queued automatic-trigger
Runs before Workflow custody and started Runs. It carries the displayed `expectedRevision`
through ordinary Action admission in the captured Home and Account. The server's existing
Workflow cancel owner selects the lifecycle phase; callers do not select a different Action.
The unreleased `automation.run.cancel` id is removed, not a compatibility alias. Existing HTTP
cancel routes delegate to the same owner and retain their established responses.
Cancellation keeps the Run record and is not declared irreversible. Its UI
control invokes that Action directly: only an effective Ask policy requests
approval, with no separate destructive confirmation. A started Run can return
`cancel_requested` before the daemon finishes stopping its children.

Other occurrence controls remain `automation.run.reply_handoff.retry` and
`automation.run.result.redeliver`; these are recovery and delivery operations, not cancel aliases.
Redelivery carries the reviewed occurrence's `expectedRevision` and authorizes
one further delivery of the retained result. All callers reach the existing V3
Automation mutation routes for those two operations; the UI publishes their returned bounded Run
through its captured Account cache. After canonical cancellation, the occurrence detail refreshes
through its existing reader. Off, Ask and Allowed use the shared Action policy,
with no caller-owned confirmation floor.

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
or schedules anything. Export accepts `{ definitionId }` for an authorized saved
Artifact or `{ draft }` for an unsaved definition, such as the `definition` from
`workflow.authoring.draft.get`. In 0.3 development source it also accepts
`{ workflow }` for a built-in or plugin reference from the Run start source options.
The catalog resolver reads the exact current definition and returns
`content_unavailable` when the reference cannot be resolved. Each input returns
a portable `happier.workflow` document and its canonical JSON. Only saved Artifact
exports carry an Artifact id, revision and metadata. The mounted editor uses the
same Action, with file picking and delivery handled by the platform.

The mounted new-session composer publishes its Workflow chooser through
`ui.current_context.read` and `ui.current_context.command.invoke`. Read the current
opaque command ids: `new-session.workflow.open` opens the same chooser, whose
`new-session.workflow.activate` command accepts `{ id }` for a currently offered
Workflow. Choosing one arms or changes this composer's selection without starting
it; `new-session.workflow.remove` clears that selection and retains the prompt.
The chooser's search and close commands share its existing selection-list owner.
Commands retire with their mount; execution still belongs to `workflow.run.start`.

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
The existing Automation deletion owner retires scheduling and assignments. Its
retention cleanup also deletes past Runs, including Runs set to keep forever.
The removal confirmation warns about this before deletion.
The Account lookup refuses foreign and Session-scoped sets,
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
examples return `requires_session` without a target. Ready results carry an
unsaved definition and may carry an authored trigger or an `eventSeed` for
deferred source setup. Resolve prepares the draft without saving, attaching,
scheduling or running it.

`workflow.events.list { machineId, serverId? }` reads the selected Machine's current
`automationEligibleEvents` contribution projection: event declarations, observation
transports and setup facts. It returns `{ machineId, events }`, not the private
configured-sources list. Missing eligibility support is unavailable; an explicitly
supported empty catalog is valid. This development read neither configures a
source nor admits an event occurrence.

In 0.3 development, a Machine presence declaration may bind its native transition
through `automation.source.nativeActivity`. Both Events hosts consume that binding
from the demanded catalog to open an ordinary, unconfigured Event draft with its
qualified reference, payload schema and `{ v, serverId, machineId }` setup input.
The Event setup Action owns the retained cursor, source identity and observation
transport; the live fact's timestamp is not a presence revision. Both Events hosts
retain native intent in the ordinary unsaved trigger draft.
The editor resolves it through its selected Runs-on Machine's existing demanded
catalog; opening a cold offline Machine fact does not contact the watched Machine.
A missing catalog or several matching declarations leaves setup unconfigured.

In 0.3 development source, `workflow.activity.list` reads Account-visible retained
Run membership through the existing Run list owner. It returns `{ retained, live }`;
`live` is `{ kind: 'unavailable', reason: 'ui_local_only' }` for Action callers.
Private Session/provenance selectors are not accepted by this read. Open a selected
Run with `workflow.run.get` for its authorized private content; retained membership
already carries available immutable admitted trigger causes.

The Events column and editor companion acquire one UI-local source per active
Home Account. It observes existing Session, Machine and Run sync facts only while
one host is open, records when listening began, and starts with a baseline rather
than reconstructing history. Both hosts share the demanded retained Run window
and local facts; unchanged updates and closed hosts produce no activity reads.
The source owns Run membership; the projection owns accumulated facts and frame
application. `workflow.events.list`
continues to describe eligible declarations, independently of activity.

The UI adapter `useWorkflowActivityFeed({ lifetime, active })` addresses the mounted
Account explicitly and shares the source, frame rows and retained continuation
between presented hosts. An inactive host subscribes to neither stream. Releasing
the last host withdraws live subscriptions; already requested Run membership and
observed facts remain UI-local for the Account lifetime, including selected-detail
handoff. Account retirement clears both.
Reopening starts a new producer baseline without reconstructing missed history.
Offline or failed reads retain visible data. Retry failure and recovery come from
the acquisition owner, including recovery whose retained rows did not change;
the adapter does not add a second retry policy or a persisted Event history.
First-page refresh merges into the requested window and uses the fresh server
cursor. Load more can traverse already known rows again; rows merge by Run id.

In unreleased 0.3 source, a Run fact seeds the existing `runLifecycle` trigger
with its exact Run source and observed condition. Events detail's **Automate
this…** and the editor companion's Add path share this seed owner;
Machine presence facts seed the declaration-owned Event setup described above.
The selected-detail presentation also exposes `runsStarted` from the already
demanded retained Run page. It compares immutable trigger occurrence keys
through the canonical occurrence owner, never event proximity. These are known
positive associations, not an exhaustive history: paging or a newly admitted Run
absent from the retained page can omit a match. Run lifecycle causes also project
`retained_cause` Event rows using their exact source tuple, condition and source
revision. Their receipt time remains available even after source revisions
coalesce; source history and results are not reconstructed. An exact matching live
observation keeps its observed state and time. The data intake does not itself render a Started link or
acquire missing Runs.

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
Discard of a saved mounted draft restores the saved version immediately and
remains undoable; only an unsaved draft retains the editor's discard confirmation. Explicit per-Action,
per-surface Ask first settings still win; Agent, CLI, MCP and automation defaults
and scoped Session-trigger admission remain unchanged.

In 0.3 development
source, an Agent, MCP or CLI caller may request retained legacy trigger conversion
through `workflow.trigger.update` with `confirmLegacyConversion: true` and the
reviewed inline target, project and `expectedRevision`. This input requires
person-class authority: automation asks by default and runs it once the user
waives that Ask; API tokens receive `present_user_required`. The existing approval presentation shows the reviewed conversion fields.
Opening retained private content still requires the existing present-user review.

Listing retained 0.2 triggers, including an explicit private-content review,
does not convert, pause or otherwise rewrite the Automation. Locked content
stays explicitly unavailable without opening retained keys. Conversion occurs
only on Save after the conversion warning; until then the original envelope,
enabled state, placement and trigger identities remain usable by 0.2 machines.

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

In unreleased 0.3 source, `workflow.trigger.list` accepts
`{ subject, contextSubjects?, limit?, cursor? }` for indexed attachment reads.
It returns `attached` rows with direct/context relation, safe author attribution,
available source status and the actor's latest started Run. Workflow visibility
comes from the existing Artifact header reader, including direct-person grants.
Unavailable Workflow references contribute only to `skippedNotSharedCount` for
subjects the viewer can currently read through the resource's existing access owner,
deduplicated by Trigger across those subjects and independent of pagination.
Each direct/context subject is admitted independently. Action-wide reads return
zero for this count because they establish no visible resource scope.
Private Workflow bodies and other Accounts' authored operands are not returned.
Omitted-subject applicability still depends on its structural producer.

The resource section controller consumes this selected page directly. Its `rows` contain direct
attachments; `also` contains admitted context attachments. `read.attachedPage` retains the cursor,
and `read.loadMore()` reads the next page while the producer's skipped count remains page independent.
An empty or failed first read keeps Retry available; a failed refresh retains the last page.
Canonical subjects can be read without execution placement; creation supplies its
separate `executionContext`. The retained service host adapts to its Machine's canonical subject.
Mounted resource hosts pass their physical Account as `accountLifetime`; explicit `null`
keeps the section unavailable without capturing the focused Account. Omission retains
the legacy host's credential binding.

The read Action `workflow.subjects.list` accepts `kind: 'healthCheck'` and optional
saved `{ automationId, triggerId }` source locators. It lists saved check identities
and config-free labels through the existing private source reader, without
enrolling probes. Source priority and deduplication precede pagination. Other
subject kinds retain their existing list Actions; plugin kinds use their
contributed list Action.

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
The same `workflow` selector accepts a saved-definition UUID. It projects only
that Artifact and its trigger summary through the existing library owner, without
listing the inventory or discovering plugins. A missing record returns no row;
an unreadable record retains the library's typed unavailable projection.
The exact saved selector `definitionId` accepts the same saved identity vocabulary
as get, including retained non-UUID ids. New definitions still require UUIDs.
It is mutually exclusive with `workflow`, `cursor` and `limit`. Board cards
request their visible saved IDs through the shared library reader without demanding catalog pages; each exact
read retains the definition owner's content and scheduler projection.
In 0.3 development, the consumed Account feed owns the library's content-change
fact. Artifact socket receipts materialize admitted rows, and a local save does
not publish a second query change. Exact Artifact facts refresh only their named
saved-definition candidates; source changes and unknown/reconnect recovery retain
the broad library read. A local deletion receipt retains immediate landing
feedback without invalidating the library; its feed row owns the refresh.
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
Workflow Action validate native trigger Action output without
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

In 0.3 development, Review & converge settles a round with no usable reviewer
result as failed. The Review retains the typed causes for each reviewer and
the child Workflow carries the first available cause in reviewer order. The
parent interrupts before Fix. A review with usable results and no findings
skips Fix. A partial round with findings can continue and names the reviewers
who did not finish. An unconfirmed launch still requires its native outcome.

Failed, interrupted and uncertain Workflow exits also settle the current Review
round from its retained reviewer receipts. Completed reviewers keep their results
and scores; failed reviewers retain their own typed causes, and reviewers that
never ran have no score. The round's coverage follows those reviewer outcomes
even when the containing Workflow failed or was cancelled. Paused Workflows and
human review holds keep their current round open for the existing continuation.

`reviews.comments.list` retains its paged default. Callers needing the complete
read can request `allPages: true`: the shared Action executor drains the existing
ReviewComment transport with the same scope, principal and cancellation signal.
The flag is Action-only, never sent to the server. A failed later page fails the
Action rather than returning partial findings. Review & converge uses this read
for both Judge evidence and its persisted convergence check.

In the 0.3 development implementation, structural filters, ordering and the
candidate-page limit run in SQL. File, folder, severity and taxonomy filters apply
within that demanded candidate page after opening its content. A page with no
displayed matches can still carry a continuation cursor; the next candidate page
loads only on explicit demand. Cancellation stops that demand, and a failed
continuation preserves the already loaded comments.

Final-panel fingerprint certification requires every reviewer to complete and
report complete finding materialization. Missing, partial or failed materialization
cannot authorize an identical-tree skip; the factual reviewed fingerprint remains
available in the reviewer result.

## Client configuration controls (0.3 development source)

`shell.column.get/set` operate on the answering client's mounted column owners. Their
CLI commands are `happier shell column get` and `happier shell column set`, compiled from
these same Action declarations. An explicit `clientId` addresses one connected client;
an ambiguous target returns the existing client-selection result without an effect. The optional
`column` selects `navigation` (the existing default), `main` or `side`. Main visibility is the
inverse of the scope's persisted `mainHidden`; a host must supply its main-column descriptor to
offer this control. Main and side sets can supply a registered `tab` id, including plugin tabs:
main selects a page and side opens its companion. A detail owner can publish optional `items`
alongside `tabs`, with each item's label, availability/reason, effective placement and stable
`pageKind`. Reading these descriptors loads no body. Missing mounted owners and unavailable controls retain their
typed unavailable results. The family remains a reversible view operation with its existing
default approval policy; user Action settings can still require approval. Arrangement is the
declared `appearance.paneArrangement` setting through `settings.get/set`, not another Action family.
When `tab` is supplied, that mounted owner's selection performs the presentation
effect; the executor does not issue an additional visibility change afterward.
Machine detail supplies its core and qualified plugin page ids on `main`, with `pageKind: 'machine'`.
Its UI strip and phone presenters invoke this same mounted selection owner; the existing route parser
clears the previous tab's nested parameters. Machine has no declared companion column, so `side` is unavailable.
Navigation reads and More/Customize do not acquire sibling resources or wake the Machine. Machine placement
edits use `settings.get/set` at `appearance.navigationPlacements`, addressing the existing desktop pages,
phone items or `pageTabs.machine` branch; they add no Action family or Account setting.
Workflow editor and run publish `workflowEditor` and `workflowRun` page metadata on `main`.
The editor's `side` adapter selects the existing Flow and Settings panes independently of the
Steps/Flow page; repeated companion selection toggles its existing pane. Run invocation inspection
retains the existing `DetailsPaneHost` owner. Page selection does not save a draft, start a run,
or change the selected invocation. Their desktop pages/companions and phone items use the same
`appearance.navigationPlacements` setting and existing mounted Action admission.
Environment publishes its canonical deployment tab ids on `main`, with `pageKind: 'environment'`;
`side` is unavailable. Its strip, phone bar/More and header navigation invoke the same mounted
selection owner. Existing route links retain their Settings section and Variables draft. Environment
placement edits address its own desktop pages, phone items or `pageTabs.environment` through
`appearance.navigationPlacements`, preserving Project preferences. Reading navigation and opening
More/Customize do not acquire secret values or initiate a deployment.
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

The matching 0.3 development desktop client accepts `session.open` with
`presentation: 'window'` to present the resolved Session through the same
destination-window owner used by generic tabs. Omission preserves ordinary main
navigation. A successful window result reports `opened` or `focused` with its
`windowId` and optional rectangle; a cancelled move reports `cancelled` without
claiming an open. Unsupported addressed clients use the existing
`unsupported_action` failure envelope. These presentation inputs require a
matching development client; older strict readers reject them.

`presentation: 'overlay'` is also a development-client input. It calls the main
renderer’s mounted overlay presentation handler for the resolved Home and
Session. An absent handler, including a non-desktop client, returns
`unavailable` without navigating the main workspace. The mounted main owner sets
the admitted Session target, then calls `desktop.notch.set {state:'pinned'}`.
An explicit open uses the resolved Home and Account and applies their desktop
channel and preview policy. Follow preferences and delivery mutes govern
automatic appearance in the notch.
The presentation interaction's `target:null` releases that target and its one
transcript consumer; retargeting, delivery withdrawal and disable also release
it. Faces and ordinary Session rows use this same action path. The device-local
`desktop.notchConversationPresentation` setting selects the overlay by default or
the existing Session window for **Open in Happier**. The previous Bot-only value
migrates with its destination intact. The existing effective privacy mode covers
the pinned Session’s recent message excerpts and asks before publication. Pinned-panel UI composition and N4's addressed draft transport have
separate owners in development source.

The overlay's person-initiated pinned-field edits use the existing draft owner's
direct transaction path, routed to the presenting window by
`applyDesktopSessionDraftTransaction`. Typing never creates an approval prompt,
including with a saved UI Require preference. Agent `composer.transaction.apply`
still uses ordinary Action admission with required approval; this adds no approval
mode or bypass flag.

`desktop.windows.open` is the single generic window entry for a qualified
workspace tab, destination href or pane tab. Its closed `target` includes
`accountId` and `serverId`; workspace targets name `tabId` and may qualify its
`layoutId`, destinations name `href`, and pane targets require `layoutId`,
`scopeId` and `tabKey` (`resourceId` remains optional legacy context). An optional
`windowId` retargets an existing window. Source tabs move through their existing
guards; opening the same qualified target reuses its window. Session window
presentation is documented under `session.open` above. The Action keeps the
existing safe/reversible approval default. The Action returns the window ID and
available rectangle when the native open or reuse succeeds. The renderer
reports readiness separately, and a source tab's transfer finishes only once
the destination can present it.

In 0.3 development source, the same input accepts `chrome: 'full'` with a
qualified Session, destination or `{kind: 'home', accountId, serverId}` target.
Without `windowId`, every full open creates an independent workspace, including
another view of the same Session. An explicit `windowId` focuses or retargets
that full window. Full opens do not move source tabs; workspace and pane move
targets retain destination chrome and reject `chrome: 'full'`. Omitting chrome
preserves destination-window behavior and approval defaults.

In matching unreleased 0.3 clients, `workspace.tabs.list` includes an `address`
qualified by Home, Account and layout. Pane rows describe their scope, key and
pane type rather than inventing a workspace destination. Pass that address to
`workspace.tabs.activate`, `workspace.tabs.move` or `workspace.tabs.close`.
These mutations still accept their legacy `tabId` input; send one addressing
form per call.

In 0.3 development source, the list also includes `windows` with native window,
Home, Account and layout ids, primary/secondary role, chrome and focus. Empty full
shells appear here without fabricated tabs. `workspace.tabs.activate` accepts
`{windowId}` as an alternative to either tab address and reveals that window
without retargeting it. Full-window tab activate/close operations continue at
the admitted mounted tab owner; closing a tab keeps its full shell alive.
To close the shell itself, discover its opaque **Close window** command through
`ui.current_context.read` and invoke it with `ui.current_context.command.invoke`.
It requests the same native Close as the window controls: main hides, and an
extra full window goes through its mounted dirty/draft guard. Acceptance of the
Close request does not imply that a later dirty prompt was confirmed.

In 0.3 development source, `desktop.notch.set` is a safe client Action on UI,
Agent and MCP surfaces, discoverable on Agent/MCP without default approval.
Its closed input is `{state?: 'rest' | 'open' | 'pinned', position?: number | {x,y}}`;
success returns `{applied:true}` and unsupported hosts return typed `unavailable`.
State is an input to the notch's renderer-owned presentation reducer: `open`
expands, `pinned` stays open, and `rest` releases it. Keyboard-initiated opens
request focus on the first control; native keyboard input is requested separately
by the composer. The command palette's “Open the notch” uses `{state:'pinned'}`.
Position uses visible-frame fractions: a number follows the current edge and
`{x,y}` addresses Floating; the native move owner applies and persists it.
Pointer movement uses the same native move owner, coalesced to one call per
animation frame, and commits once on release. Per-display positions live in
`window-state/notch-position.json`. Legacy local settings infer Dock only when
it is unset; a legacy bottom anchor or floating mode becomes Floating.
Native startup reads the current position file once on a best-effort basis.
Never-shipped pixel-offset files do not carry their former anchor or size, so
they remain untouched and the notch uses its default position until repositioned.
The QA fixture feeds the normal model producer and uses this same Action for
pin/release; it does not write a competing native sync payload.

In 0.3 development source, `desktop.displays.list {}` is a safe client read on
UI, Agent and MCP surfaces, discoverable on Agent/MCP without default approval
or capture-result approval. It returns `{displays, automaticResolvesTo}`; each
display carries `storageKey`, `name`, `builtIn`, `primary`, `connected` and
`inUse`. `automaticResolvesTo` is a display storage key or `null`. The native
display-choice owner supplies the same inventory to the Display setting and
the `desktop.displays.list` option source for `desktop.display`. Options include
Automatic, a confirmed Built-in display, Display with the Happier window and
`named:<storageKey>` entries, including remembered disconnected displays. The
read reports typed `unavailable` when the answering host cannot show the notch.

`desktop.display` stores `automatic`, `built_in`, `main`, or
`named:<storageKey>` as a device-local string. Automatic uses the connected
built-in display while the lid is open, otherwise the primary display. Main
follows the display containing the Happier window. An unplugged named display
falls back to Automatic while retaining its choice and its last-seen name in
the native `notch-position.json` record, so reconnecting restores the choice.
On Wayland without connector facts, built-in status is unknown and Automatic
uses the primary display.

The desktop's native main-to-destination hop continues the admitted built-in
client Action at its existing effect dispatcher. The wire owner projects the
dispatch context; process-local runtime facts and callbacks remain local.
Admission retains its actual surface and effective authority in the typed client
context, including for workspace close; transport does not invent those facts.
Missing or unknown surfaces remain unavailable.
The trusted native receiver uses `executeAdmittedClientAction`, so the hop does
not repeat Action settings or approval evaluation. Ordinary entry points still
use `execute` and its admission policy.

The declaration's host-only `clientPresenter: 'session'` marks mounted Session
effects: draft append, composer/prompt controls, Session Work and capture
delivery. Native forwarding and CLI reverse delivery consume that same fact.
Session navigation, workspace lifecycle and native capture controls keep the
main client's owner; an invoking Agent's Session does not change that placement.

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
mounts cannot retain an executable callback. Catalog-backed entries that can
execute with their current input invoke the original Action through ordinary
child admission, preserving caller policy. Entries needing interactive input
are excluded from agent invocation.

In 0.3 development, the palette discovers personally enabled `command_palette`
placements from the Action catalog. `buildActionDraftInput` consumes the
canonical contextual binder for the active Session, Machine and root; complete
input executes through the UI Action executor, while incomplete input opens the
existing Action input form. Bespoke launchers retain their existing callbacks.
Empty-query Search puts the current Session's commands first; typed Search
retains its matching order. Derived `action:<id>` and `session.action:<ui id>`
keyboard commands have no defaults and dispatch the same mounted palette row.

`workspace.tabs.*`, `workspace.groups.*`, `workspace.split` and
`workspace.resize` consume the mounted Workspace provider's navigation, reducer
and measured split controls. `session.open` can name a destination `tabId`;
the client must have that tab in its current workspace. No-tab opening retains
its existing Session navigation behavior. These controls do not create another
workspace store or infer layout measurements on headless hosts.

In the current development UI, opening or activating an entity keeps the selected
app section and its list. A split open requires the mounted canvas measurement
even when the destination is already open, and moves that existing tab beside
the requested pane. It does not silently turn an edge request into activation.
Plugin app pages keep their single instance. Phone opens retain the selected
main tab; split operations remain unavailable there.

In 0.3 development, Project page and checkout selection enters
`workspace.tabs.open` through the same UI Action admission. The optional
`replace` boolean carries replacement of the current navigation-history entry
to the mounted navigation owner; omission retains ordinary open behavior.
An exact source `tabId` retains that Project tab, and the existing unsaved-editor
guard can refuse navigation before any route or remembered selection changes.
This closed input requires a matching development answering client; older
strict readers refuse an unsupported operand rather than silently ignoring it.

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
client and discover `answeringClientId`, eligible `answeringClientIds`, and
`answeringClients` with device labels when advertised. The Runs view read
(`workflow.run.view.get`) returns the same answering-client metadata.
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

The safe `workflow.run.view.get/set/reset` Actions address the focused Runs
view for the same Home and Account. The read returns search, filters, loaded
matching Run keys, coverage and the selected Space. Set changes search and
supplied condition fields. Reset clears search and restores the selected
Space’s filters. All three use the same answering-client selection as the
Library and report unavailable when the addressed client has no focused Runs
view. Discover the mounted client with `happier workflow run view get --json`.
Use `happier workflow run view set` or `happier workflow run view reset` with
`--client-id` to address it. Voice exposes `workflow_run_view_get`,
`workflow_run_view_set` and `workflow_run_view_reset` through the same mounted
controller.

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
its source, planet intensity and digits, picture reference and layout, remembered
looks, background places and moments controls (`appearance.atmosphere*`). They use
`settings.get/set/reset`; the Account CAS owner reapplies nested intents to the
latest document and preserves sibling preferences.
`appearance.atmospherePlanetIntensity` accepts `quiet`, `calm` and `full`.
`appearance.atmospherePlanetDigits` accepts a boolean. Stored Account, Project
and profile planets from before the intensity setting read as Quiet and retain
their Digits choice and surrounding backdrop settings.
`appearance.homeBackgroundField` is an Account preference for Home's dot field.
It defaults to `animated` and also accepts `still` and `off`.
Full atmosphere and look-map
writes use the answering client's picture catalog to retain only differences
from each known picture's release look; an absent catalog entry retains its
authored overrides. Look entries contain `look`, `strength` (0–1) and `dissolve`.
The UI's Fade control is that dissolve style, not a separate numeric override.
`appearance.atmosphereShowOn` reads and sets `homeAtmosphere.showOn`, an array
representing a set of `home`, `new-session`, `projects`, `sessions` and `pages`.
Empty sets are valid; unknown places and duplicate entries are rejected by the
same strict setting schema used for full-object writes. Stored absent or unknown
sets recover to the authored layout's default: all five places for Wallpaper,
Home/New/Projects for Horizon. A layout change follows the new layout's default
when the place set still equals the previous default; custom sets survive.
Planet never supplies a backdrop on Sessions or
other pages. Project-linked Sessions and pages use the Project's override, or
inherit Home when the override is absent or `home`; membership comes from the
accepted Session/Project relationship, never a title or inferred path. The
resolver exposes visibility and the shared shell picture's backing. The shell
content-plane owner applies Sessions' existing reading coat once for every main
area while the picture is shown; individual pages do not select another coat.
This is the development contract; page
composition and the place picker are integrated by the Home atmosphere UI lane.
The saved picture reference remains the person's choice. Home and inheriting
surfaces share a display sample for the signed-in Account. The first display of
a new built-in choice starts its hourly idle rotation on that device.
The sample advances on an admitted resettle or a fresh arrival in the same run.
Relaunching starts with the saved picture again, and devices can show different
points in the rotation. Stored legacy timestamps are dropped on read. Choosing
the same picture again and automatic rotation leave Account settings untouched.
Own pictures, contributed pictures and explicit Project overrides keep their
selected picture. Look's picker shows
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

In 0.3 development source, `externalSessions.autoLinkSources` uses the same
Account Settings owner for source policies. Set a complete policy
`{machineId, qualifiedIdentity, sourcePolicyId, enabledAtMs}` to enable or update
that exact source. Set only `{machineId, qualifiedIdentity, sourcePolicyId}` to
remove it, preserving the existing removal input. Writes merge into the latest
Account value, retaining sibling policies and other external-session preferences;
`settings.get` returns the policy list. Both input forms use the existing
strict source-policy schemas and policy mutation owner.

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
Session desktop pages use `detailPages.session.desktop.pages`; Session companions and phone
items retain `sessionRail` and `sessionTabBar`. Other missing detail addresses use sparse
`detailPages[pageKind].desktop.{pages,companions}` or `.phone.items` branches. The existing
address mapper keeps Project desktop pages/companions on `projectTabBar`/`workspaceRail`.
Project phone items use `detailPages.project.phone.items`. Settings initialization seeds an absent
branch once from `projectTabBar`, normalizing `git` to `changes` and `browse`/`files` to `code`.
An explicit empty branch is initialized; later desktop edits and chrome mounts do not reseed it.
The mounted Project lends page ids to `shell.column.get/set` on `main` and companion ids on `side`
(for example, `changes` and `git`). Phone placement metadata comes from that single phone branch.
`pageTabs[pageKind]` stores the deliberate Cockpit phone Top/Bottom preference (default bottom).
Sparse writes preserve all other branches and their identities; reset supplies empty preferences
only for the addressed section. Stable kinds identify a presentation, never an individual record.
These preferences change only the named navigation surface; hiding an App-rail
icon does not hide its destination from the launcher, columns or command palette.
Unknown or temporarily removed item ids remain saved; current catalogs decide
which items can render. Stored reads drop unknown object fields, while Action
inputs reject them. Absent surface entries use their catalog defaults; mounting a
navigation surface does not write preferences. Device-local Action placement
requires the answering client and does not synchronize these preferences to the
Account or other devices.

In 0.3 development, the Database Workbench plugin declares the Account-scoped
`activityRefreshIntervalMs` field under plugin ID `happier.database`. Discover
the field and its current revision with `plugins.settings.list`, then use that
revision with `plugins.settings.set`. The default is 5,000 ms. A value of 0
selects manual refresh. The searchable Activity settings page edits the same
plugin record.

In 0.3 development, `settings.list` reaches the answering client's complete
declaration registry, including contributed settings. It does not substitute a
partial headless catalog. Ordinary calls return the complete catalog. Callers may
provide `maxBytes` to page full declarations within a UTF-8 JSON result budget;
`total` reports the matching count and `nextCursor` identifies the next offset.
Continue with that `cursor` and the same `pageId` filter until `nextCursor` is
absent. Voice supplies a budget derived from its encoded reliable transport
envelope. A budget too small for one declaration returns
`settings_discovery_budget_too_small` with `minimumBytes`; descriptors and their
allowed values are never truncated. The Delegation anchors and Create-session Action policy
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
sealing material refuses admission. `resolveActionApprovalRouting` answers both
sides of this deferral: the host's Actions settings with the full invocation, and
the Account's settings with the context the receiver sees (CLI surface, caller
authority). A host-only Ask that the Account answer cannot preserve returns
`approval_context_unavailable` before dispatch rather than creating an unsigned
approval (`isUnpreservableOriginalCliApproval`, shared by the credentialed CLI and
the CLI action harness).

The development UI Account relay projects mounted Plugin caller descriptors
onto the closed private requester invocation schema before native reads and
Session input admission. Process-local version, display and initiating-caller
metadata stays outside that carrier; Plugin identity, occurrence, source custody,
materialization and the original automation authority remain intact. This same
projection serves semantic workspace writes. Investigate's retained creation and
input identities survive an Agent chooser or uncertain send: resuming delivers
the receipt reference to the known Session through ordinary input admission.

`machines.managed.birth.get` is a 0.3 development Account read available through
the Action catalog and `machines_managed_birth_get` MCP binding. Given the exact
`homeId` and `managedId`, it returns `{ source }`: the originating workflow Run,
Session, or null when no stored relationship is found. Its ordinary server
transport (`POST /v1/machines/managed/actions/birth.get`) resolves both indexes
in one Account-scoped snapshot, with workflow birth taking precedence. Keep-scope lookup and
Retry use this same Action. It reads the existing non-content relationship
indexes, never a Session or Run inventory; a refused or malformed read fails
instead of presenting an absent relationship. It neither wakes a controller nor
changes the Keep rule.

Controller-placed managed Actions in 0.3 development use Home-issued Machine
admission even for the Account's own local controller. Their creation, inspection,
installation retry and control call protected Home endpoints; the private local
daemon control credential cannot supply that admission. The CLI's existing
`requiresOriginalAccountMachineActionProof` decision selects the same carrier
for local and remote controllers, without disclosing foreign Account custody
for an owned Machine.

Account-placed creation and control use those protected Home admissions without
inventing a controller. The unsigned mutation arm requires a nonlegacy Account
token with present-user authority; later row mutations require that row's
custodian and active request. A terminal token alone is not that authority.
The owning Account can admit Delete and re-attach its controller on a
controller-free row. The Home checks the new controller's exact installation.
An immediate Stop on a controller-free row returns `controller_unavailable` and
asks the owner to re-attach a controller. Managed Exec also returns
`controller_unavailable` before dispatch when the row has no controller.
The owner's original Account proof can carry the exact Stop or Delete through
cleanup on the Account's own daemon, even a shared one. That proof may come from
the app, the CLI or an approved Agent: the Action's approval default decides
consent, not a present-user floor. The row owner's API token can also admit
Delete if its grant allows `machines.managed.delete` on that daemon's Machine.
Home refuses tokens without that grant and tokens issued to another Account.
Other signed native follow-ups bind the signer to
the row's enrolled guest or an unshared custodian daemon. The same route owner
protects cancellation and setup decisions on paired rows.

For implicit paired-terminal immediate power and resize, the CLI reuses its own
daemon's existing signed-root ingress and the daemon's Account authority. An
absent or unreachable signer returns `daemon_unavailable` before changing the
Home intent or invoking the native role. Ordinary Account present-user foreground
execution remains daemon-free; explicit Machine placement retains its existing
Home admission. Controller-free paired-terminal `after-idle` remains an intent-only submission.
The native control's retained-row read carries its existing admitted control
root; Home binds that read to the same `homeId` and `managedId`.

The 0.3 development managed-intent result retains `accepted`, `conflict` and
`refused`. Its `operation` reference is optional: installed asynchronous
execution returns its real Action operation. Immediate foreground Account power
returns acceptance only after native execution and inspection complete. A
controller-bound `after-idle` control keeps that controller as its original
executor across approval. Its real Action operation retains the admitted intent,
waits for the guest idle/drain decision, submits the native effect and reports the
observation. Recording the intent alone does not schedule that work in the
automatic retention loop. Home admission alone is not immediate native success,
and a request ID is not an operation ID.

After a managed power intent is acknowledged by Home, a later controller HTTP
failure does not roll it back. In 0.3 development the controller returns
`action_outcome_unknown` and retains the same operation with an
`outcome_uncertain` observation. An unreadable admission acknowledgement also
retains an unconfirmed outcome, including an admit-control 503 with
`database_connection_unavailable` or `database_transaction_timeout`: neither code alone proves the intent
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
When the installed controller reconnects, its existing native observation
can settle an uncertain Stop on the original operation once Home confirms the
result for that resource and controller. Check now remains available for an
immediate observation. Read the managed row before retrying. Stop
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

In 0.3 development, `voiceConversations.connectedServices` selects the Local
Voice Agent's connected account or Pool with the same `ConnectedServiceBindingsV2`
value as New Session. It persists at
`voice.providers.local_conversation.config.agent.connectedServices`. Absent means
the Agent's Account default; explicit `null` means native sign-in and launches
with empty bindings, so an Account Pool default cannot fill it in. Fresh
Home/Global carriers and fixed-Agent turns consume this choice. Agent from
Session continues to inherit the coding Session's credentials. Existing saved
Voice settings need no migration; this preference requires a UI reload only.
Settings Actions report an absent choice with the existing `unset: true` result;
an explicit native choice round-trips as `value: null`.

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

In 0.3 development, `settings.invoke` at `pets.desktopOverlayResetPosition`
resets the answering desktop client's native pet position. It defaults to no
approval, while explicit Actions approval settings still apply. The Pets reset
row and palette command use this same operation and preserve notch placement,
visibility and settings.

In **unreleased 0.3 development**, Desktop app’s **Notch** section uses the
existing `settings.list/get/set/reset` family. Discovery exposes **Show Bots** at
`desktop.visibilityMode`; its stored values remain `attention_only`,
`active_sessions`, and `always_when_enabled`, labelled **When they need you**,
**While working**, and **Always**. Device preferences use the answering client;
Account pet enable/selection defaults keep their Account owner and device
inheritance. Existing Off/Ask/Allowed policy and declaration-specific approval
continue to apply to both UI and automated writes.

The old trigger, preview, pinned-presentation, auto-hide, and pet activity-mode
anchors are removed from discovery along with their controls. Writes to retired
anchors return the existing unknown/unavailable declaration result. Neither old
pet mode seeds Show Bots; an explicit stored Show Bots value wins, otherwise its
existing default applies. The removed preview preference never broadens admitted
Home/device privacy. Dock, Display, When idle, conversation presentation, the
full-screen preference and the Session window Bot rail (`desktop.windowBotRail`,
local key `desktopWindowBotRailEnabled`) share these existing Settings Actions; no
overlay- or window-specific settings Action family is introduced.

On the desktop app, `session.open` with `presentation: 'main'` means the main
window presents the Session. The window lifecycle owner
(`apps/ui/sources/desktop/window/appWindowRuntime.ts#presentDesktopSessionInMain`)
first returns a Session window that shows it (a source tab comes back; a
no-source Session then opens as a main tab) and shows main. Called inside a
Session window, the same Action forwards over the existing window-action
transport to main, which runs it through its own UI admission like the Capture
window's Open. The Session window Bot rail retargets in place with
`desktop.windows.open {windowId, target}`; its and the notch's right-click menus
take Open in window from the shared `useWorkspaceOpenActions` builder and supply
their second item (Open in Happier, Open in the overlay). Companion position is device-local
persistent UI state, while pet enable, selection, library and default/override
preferences remain intact.

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

Standalone realtime Voice advertises hot-path Actions directly. Planning,
delegation, and code-review launches retain their Voice bindings and full input
schemas through discovery rather than occupying the default tool catalog. Discover other
built-in Actions with `searchActionSpecs` and `getActionSpec`, then call the
transport tool `action_execute` with `{actionId, input}`. It uses the same Voice
Action executor, surface availability and approval policy as direct tools;
pending approval is not an executed effect. Results use the MCP-compatible
`{ok:true,result}` / `{ok:false,errorCode,error}` envelope and the target Action's
Voice privacy policy. This gateway cannot execute effects through identity-less
SDK callbacks or providers without stable effect custody, and is absent from
attached Agents' current-UI-only surface. Contributed plugin Actions still use
`action.invoke` through `invokeAction`.

In 0.3 development source, public review-comment operations, accepted-findings
Apply and current-Session presentation (including Work controls) use this same
Voice projection and executor. Triage's Orchestrate-this start also admits Voice
through its existing confirmed contributed Action. Account Role mutations,
Apply roles to reports, Launch Profile publishing and the Session approval-reviewer
toggle Action remain excluded from Voice. Session Role/notes edits and Role reads
retain their declared Voice bindings; surface parity does not waive approval or
provide a missing mounted presentation owner.

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
For a spoken briefing, Voice guidance selects `requestVoiceBrief` rather than
the broader Account `inbox_get` read. The native Voice tool exposes the existing
`ui.voice_global.brief.request` Action with its catalog-owned input schema. It
uses that same approval, mounted Home/Inbox and delivery path. In 0.3 development,
a request from another surface opens Home and resumes the admitted request when
its existing Brief producer mounts; it does not build a carrier-local Brief.
A genuinely unavailable owner retains its public failure phase and a non-retryable
result so the model can explain the missing owner rather than repeat the call. `invokeAction`
remains for contributed plugin Actions. A malformed native or legacy text Action
is refused before execution with a plain spoken explanation, without validator
field names or diagnostics.
In 0.3 development, a spoken Brief request uses the Account Inbox's Needs you
membership and total. Home's **Brief me** uses the retained sidebar shelf with
its current scope and filters. An unavailable shelf yields an unknown count.
Missing individual details are reported as incomplete coverage. Spoken groups use the app's disclosed Session labels,
including its fallback labels. An explicit Brief uses the Account content-sharing
switches; automatic Follow update levels do not suppress its requested names.
The snapshot supplies the exact remaining count for “and N more” instead of
inventing unnamed requests or reasons. Failures and ready work remain known
projected Inbox entries. An admitted Brief request leaves its spoken answer with the
mounted Brief delivery owner, including while Home demand-mounts Inbox, so the
calling Action turn does not race it with another model answer.
The privacy-projected Brief snapshot and its answering instructions travel as
per-request provider context. The visible user turn and Pending input contain
only the person's Brief request, rather than the serialized Inbox snapshot.
In 0.3 development, `ui.voice_global.companion.reveal` reveals the mounted Voice
section or opens the focused Session's Companion through its ordinary route.
Without a focused Session it uses the captured Voice target or conversation.
`ui.voice_global.transcript.set_visible` expands the mounted transcript, opening
Companion when needed; after End, showing it opens the same captured conversation
destination as **Open the conversation**. Hiding the transcript settles even
without a mounted panel. These presentation Actions never start audio. Missing
at-rest Session destinations report `voice_presentation_unavailable`; unavailable
captured post-End navigation reports `voice_conversation_navigation_unavailable`.
Disabled live transcript presentation reports `voice_transcript_unavailable`.
In 0.3 development, **Voice agent can approve requests** (`voice.canApproveRequests`)
defaults on for Local Voice and realtime modes exposing host decision tools. The
Voice agent may approve or deny any pending request on the person's behalf through
the existing decision owners, including requests surfaced in a brief.
The person's spoken request is the confirmation; prompt guidance tells the agent
to read back the request and follow that decision.
Decisions are attributed to the Voice agent acting for the person. Turning the
setting off requires a tap for the next decision, including on an ongoing call.
The Action executor reads the captured Account's current preference at admission.
A prepared decision retains its admission through execution. Explicit cancellation
of an approved but unclaimed request is a new decision and uses the current preference.
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
conversation, coding target, or retained transcript carrier for a targetless
direct-media call. Opening that carrier does not make the call executable through
Voice New or Continue.
An ended attempt from another Account is unavailable, never redirected to focus.
The conversation header names the service from its exact binding or the same
Account's captured ended attempt, never from the provider selected for the next Start.
Conversation and recovery navigation use the mounted workspace's existing tab
owner, falling back to Expo navigation only when no workspace is mounted.
Teleport exposes the existing daemon-backed operation to Agents and MCP under
the ordinary Account automation policy; it grants no approval authority.

In unreleased 0.3 source, `ui.voice_global.say.start {text}` speaks chosen text
on the answering client through the configured speech output. It waits for
completion or cancellation without opening a microphone or sending an Agent
turn. `ui.voice_global.say.stop {}` stops that read-aloud without ending the
conversation. Automated Say requests retain the ordinary Ask default; Stop
uses the existing safe-control policy, including explicit user overrides.
The output owner publishes preparing/speaking/idle for client controls, and
results distinguish completed, cancelled and typed unavailable outcomes.
Provider-owned synthesis boundaries still apply; the Action adds no text cap.
Say discards active or starting local input before speech; submitted transcription
and Agent work retain their lifetime. Reading continues through transcript navigation,
with Stop available in the global Voice control.

Field Dictation has separate `ui.voice_global.dictation.start`, `.finish`,
`.cancel` and `.dismiss` operations. Focus the actual editable field or its
Dictation control, then read its opaque commands with `ui.current_context.read`.
`ui.current_context.command.invoke` delegates each command to the same typed
Dictation Action; direct calls use that command's `commandId`. Start requires
approval by default for automated callers and existing device microphone consent.
The person's own UI Start is direct unless Settings → Actions requires Ask first. Finish inserts
editable words through the mounted field's insertion owner without Send;
cancel inserts nothing. Retired, hidden, disabled or other-Account fields return
typed unavailability rather than targeting another input. The existing current-UI
command composition adds the focused field's commands to the page's projection;
focusing or retiring that field preserves the mounted page's entity and commands.
Another field's focus retires the preceding field's command addresses. The existing
Dictation controller retains capture ownership; no draft or recorder is created
by the Action adapter.

In 0.3 development source, `ui.voice_global.history.search`, `.load_older`,
`.export` and `.clear` use the answering client's existing History consumer.
Search filters loaded text and provider names; explicit refresh rediscovers the
owned Voice conversations through the ordinary active and archived Session-list
owner. Ordinary user and Agent text belongs to that conversation's history;
direct-media provenance is not a second membership rule. Export streams the loaded or complete history,
optionally filtered, to the client's download/share target and returns file
metadata. Clear retains destructive approval and deletes the discovered owned
Voice conversations through ordinary Session deletion. The legacy direct-media
carrier is no longer a History search/export source. The History page lists
conversation metadata without starting a global transcript read. Its collection
search filters titles and text already loaded on this device; opening a
conversation uses the ordinary Session route to load only that conversation's
body. Explicit global transcript Actions retain the shared consumer's Account
currentness, pagination and delete-wins retirement.

The 0.3 development `settings.invoke` operations `voiceConversations.readiness`
and `voiceDictation.readiness` return the page/setup's semantic readiness and
recovery, alongside their inspection facts. Conversations include Hear, Think
and Speak. For Local Voice in Agent mode, the answering client refreshes the
selected Agent through Machine Agent inventory before reporting Think readiness.
The result distinguishes installation, sign-in, and Machine reachability from a
check that could not establish runtime readiness. Dictation includes its
recognition readiness. Device speech and
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

`session.draft.agent.set` addresses a mounted New Session or Session composer by its
exact draft reference. It applies the Agent target together with its model, mode and
configuration through the picker's existing selection writer, without opening
another draft or sending the prompt. On a Session it arms the next message through
the existing continuation picker; it does not replace the running Agent.
`session.draft.model.set` edits that armed continuation, and refuses when none is armed.
An unmounted or unavailable composer returns the existing unavailable result.
Mode and individual configuration edits use the same Action and retain the
authoring owner's typed overrides. These closed development Action inputs
require matching 0.3 hosts; the existing persisted draft format is unchanged.

The development Channels plugin declares Agent and MCP access for all management
Actions: connection setup, transfer, policy, deletion, pairing and recovery, plus
binding read, resolution, creation, update, enable/disable and deletion.
Observational prepare, retest, resolver and exact-read Actions keep their safe
classification. Writes retain their existing confirmation and the canonical
present-user approval flow before handler execution, along with revision,
target and lifecycle checks.
Pairing finalization still requires the proposal authenticated by the external
human; requesting an Action does not supply that proof. A direct destination
proved in a direct message is enabled at finalization; a shared destination or
shared proof location stays paused for review. The present person's exact
in-flow confirmation supplies approval without a second prompt, while explicit
Ask settings and automated-caller policy still apply. Accepted-loss and
ambiguous-delivery decisions retain their existing disclosures and never resend
an uncertain effect. Channels has no literal rename field: the displayed
endpoint label is not a newly writable preference.

These are development-source contracts, not a released availability claim.

In current development source, an attempted outward send interrupted by runtime
reload settles as `outcomeUnknown` unless provider reconciliation proves delivery,
with visible attention for an unknown result and no automatic resend. The retired runtime cannot settle it through a late-completion
continuation. The existing custody and owner-resolution Actions remain the
authorities for the result; reload does not prove a known-no-effect failure.

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
admission; the supervisor owns provider delivery outcome and child-binding completion.

Email starts a mail thread. In unreleased 0.3 development, Telegram starts a
forum-supergroup topic (`createForumTopic`, administrator `can_manage_topics`)
and Discord starts a public thread under a text channel (API v10
`POST /channels/{parent}/threads`, explicit `type: 11`; `CREATE_PUBLIC_THREADS`
and `SEND_MESSAGES_IN_THREADS` plus parent access). Both use the incumbent text
sender and ignore HTML. The first native chunk creates the child; the shared
splitter directs all later chunks there without `newThread`, retaining the
endpoint and accepted message IDs in the same custody. Creation or post-create
uncertainty parks in the existing `outcomeUnknown` / `delivery/resolve-v1` flow;
it never retries creation blindly. GitHub starts remain unsupported. No new
provider role, custody format, thread registry or Workflow sender is introduced.

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
New Boards require `intent.board.id` to satisfy the Artifact creation UUID schema;
invalid ids return `invalid_parameters` before Artifact access. Retained Board ids
remain readable and editable, and Session/task references keep their own id grammar.
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

Public browser Session creation forwards the authored recipe to the receiving
daemon's `session.spawn_new` Action owner. The browser does not prepare another
local spawn admission, including when its caller uses `prepare`. The receiving
owner supplies approval refusals to the existing browser confirmation flow.
Already admitted private birth continuations retain their enclosing Action's
authority; forwarding a public recipe does not turn it into such a continuation.
Native Account-plugin remote birth admits once at its initiating Account runtime;
the selected Machine consumes that admitted child/root through private lifecycle
transport. The receiving Machine does not admit it again or retarget the child.

Host Voice Session creation uses the ordinary `session.spawn_new` executor and
approval policy. Its admitted Home and Account supply the opaque creation
namespace, so a retry with the same creation key rejoins the same logical
creation without colliding with another Home or Account. Missing admitted scope
refuses creation. This namespace grants no permission: the host derives Voice
authority from the captured credential. An Account credential supplies
`present_user`; other credential kinds retain `account_automation`. The ordinary
Action approval policy still applies before creating a hidden conversation.

For 0.3 development builds, Voice can pass an explicitly requested model as
`spokenModelName` to `spawnSession`. The receiver uses the selected Agent and
Machine to run the same catalog matcher as `resolveActionOptions`. One match
becomes the exact model selection in the launch recipe. If the result offers
candidate labels, Voice reads them in full and submits the label the person
chooses. A candidate marked `needsModelPicker` requires the person to choose
the exact credential in the app. When the result has no labels, Voice asks for
an exact model name. When Voice omits the model, the ordinary launch defaults
apply.

In current 0.3 development, an explicit same-input retry of `session.spawn_new`
after a typed retryable creation error starts a new operation receipt while
retaining the original terminal receipt. The logical creation key and native
nonce remain unchanged: the ordinary creator still creates or rejoins the same
Session. Pending outcomes remain resume-only; success, nonretryable failure and
other Actions' terminal results continue to replay. This does not automatically
retry a failed start or turn a transport acknowledgement into birth success.
In this development source, a host creation rejoin reconciles its first input
with the original Pending or transcript admission. Identical authored text,
structured input and review payload return `alreadyAccepted` across CLI and
browser while preserving the first admission's attribution. Changed authored
input retains `session_input_idempotency_conflict`; an unavailable retained-input
read returns `outcomeUnknown` without another admission.

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

In unreleased 0.3, `launch_profiles.create` and `launch_profiles.save` accept the
same model selection in `profile.preferredModelSelection` that
`session.spawn_new` accepts in `modelSelection`. For a brokered Team model, use
`v: 2` with the exact Team model reference, including `source: 'team_resource'`
and `deliveryMode: 'brokered'`. To use the saved preference, pass the Profile's
`profileId` to `session.spawn_new` and omit the explicit model choice. Start
admits the Team selection against the caller's current Team access and the
chosen Machine. An explicit model choice takes precedence.

A Session `configuration` is an optional full snapshot. Its `mode`, `model` and
`permissionIntent` each carry `{ value, updatedAtMs }`; unset values are `null`.
Its `options` map carries `{ value, updatedAtMs }` for each option id. Model values
are strings, permission intents use the canonical `read-only` spelling, and
option values are scalars. Configuration choices name option ids; the Agent's
`agents.config_options.list` inventory owns their value choices. An empty
inventory does not require an empty snapshot: omit `configuration` when no
override is needed. The configuration schema sections expose this typed shape
after the existing strict JSON normalization.

In unreleased 0.3 source, `session.config_option.set` accepts `valueId: null`
to withdraw one option override through the same Session metadata intent writer.
The daemon resolves choices and publishes intent under the Session owner's
Account, including on Machines shared with the owner through a Use grant.
Withdrawal remains available when the selected model no longer offers the option
or another control disables it. A non-null value still requires an enabled,
currently offered choice. Null retains its existing configuration-intent meaning;
it is never converted to the string `"null"` or replaced with another model or value.
Use `happier actions invoke session.config_option.set` from the CLI to apply a
saved model's reasoning-effort option through that same Session owner.

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
Inline Workflow definitions choose who runs on `defaults` or a step's
`execution` with the flat `agentTarget` and optional `modelSelection`, or with
`roleId` for a Role; effort is the `reasoning_effort` entry in
`sessionConfigOptionOverrides`. `engine` only binds that choice to a declared
input or the current item and never carries a literal Agent, model or effort. Run
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

Computer recording adds `computer.recording.*` Actions alongside the shipped
Browser recording family. Both derive their spec from the shared recording
definition and use the same daemon recording lifecycle, encoder, Session-media
writer and retention owner. Start uses the existing Computer capture consent
and approval admission. It requires a Session-bound Computer source and a
`mediaTarget` in that same Session; Machine-person viewing alone grants no
authority to write another Session's media. Subsequent operations require the
original `sourceId`, caller source identity and admitted desktop scope. `listForTarget`, status and attach
return metadata or a media reference, never inline recording bytes. Stop stores
the recording through the existing Session-media pipeline. These are current
development-source contracts; the Computer recording UI is a separate consumer.

Native computer actions are machine-placed. Agent calls use the Session supplied by the
authenticated host context; a person opening Computer from a Machine uses a Machine-person
source identified by the verified requester Account, without an agent Session. Both use the
same computer owner and screen capture registry. Agent calls to `computer.targets.list`, `computer.target.select`,
`computer.control.interrupt` and `computer.control.handBack` require approval by default,
with per-action waivers through Actions settings and the existing bypass semantics.
Window enumeration can disclose other windows' titles, so it has its own approval default.
The daemon Computer route consumes the canonical Action policy admission without a second
present-user approval floor. Machine/Session isolation and selected-source consent still apply.
Approval preserves the agent's `account_automation` authority; it does not turn the caller
into a present user or grant observation consent merely for selecting or handing back.
When Happier prepares an agent's Computer proposal, its target lookup uses the existing
Account Action transport with the caller, Session context and automation authority intact. The
direct present-user Computer RPC serves only the person's controls.
User controls relayed through external Actions carry a Session envelope target, which the
existing locality resolver validates against the executing machine.
The person's own controls from Happier (choose, look, stop, hand back, privacy pane) reach the
same computer owner through the UI's one Action front door and runtime chain. In current 0.3
development source, the exact Home's shared Machine projection with Use selects
`daemon.computer.personal.actions.execute`; the existing `daemon.computer.actions.execute`
retains Manage admission for the host display. The personal route carries the verified RPC
requester to the same Computer owner, which confines target selection and control to that
person's desktop. A client-supplied display or Session id cannot change the requester scope.
Both routes attach through the daemon's shared
Machine RPC route owner after Machine registration, including transport replacement. Registration
does not depend on desktop or driver availability; an absent Computer owner returns `computer_unavailable`.
The route carries verified RPC caller authority and cancellation to the computer owner, defaulting
omitted authority to automation. A Session request names that Session; without one, the owner
derives the person from authenticated RPC admission, never a payload person id. It admits
only the control Action set, never agent input, whose
person-side equivalent travels as live-stream sideband controls. Guest viewing first asks
the installed Computer owner to admit the exact personal source occurrence. The existing
grant mint verifies that signed Home/person/source decision and current Machine access once,
then issues the closed v2 relay carrier with the custodian source and exact guest viewer tab.
The additive personal relay-start method verifies that Home signature before capture and
uses the same stream, shared Machine cipher, sideband controls and retirement signal. The
raw relay-start method requires Manage, preserving host-display authority while refusing
Use-only host viewing. In unreleased 0.3, a Session participant with Machine Manage
can open that Session's Computer view through the Home's optional recipient-safe
`computerMachineBinding` (`homeId`, `machineId`) detail projection (C79, 2026-11-13).
Other participants receive no binding; owner metadata stays owner-only. This routing
hint changes no server refusal or Machine authority floor. The raw route still refuses
Use on older receivers; the v1 grant mint remains custodian-only. On the host route, `computer.targets.list` without a
`displayId` lists the daemon's own X11 desktop (`DISPLAY`) or macOS's logical `primary` desktop; a machine without one returns
`computer_display_unavailable` and an unsupported desktop returns a typed `target_unsupported`
refusal, which the picker explains instead of showing an empty list.
Agent Computer use targets the Session's own machine (orchestrator ruling, 2026-10-01): the named flow is
computer use on the daemon's desktop, including a remote dev box. The UI lists and selects only on
the Session's machine, named by its chip; a request that names another machine opens on a typed
refusal (`computer_machine_mismatch`) and there is no cross-machine path in the UI. The computer
owner refuses a different machine id (`computer_machine_mismatch`). `daemon.computer.actions.execute`
remains person-side only; it has no agent variant.
The registry permits only one source identity (Session or Machine-person) to own overlapping native input targets at a time:
a display conflicts with windows on that display, while distinct background windows
can remain independently selected.
Another source identity's selection returns `computer_target_in_use`, including while the previous
owner drains. Confirmed close releases ownership; an unconfirmed close remains quarantined.
In development source, successful native process retirement acknowledges Stop sharing
even when the effect of earlier input remains unknown; that historical uncertainty
does not keep the retired share selected.
Consent stays with that source. Agent model media remains Session-scoped. A Session-less
person capture returns an ephemeral inline PNG instead of creating Session media or a hidden
Session. Session closure retires only its Session source; Machine-person selection ends on
Stop sharing or daemon disposal. The Machine viewer uses the existing target picker, stream,
control and input owners, with projection keys separated by Machine and person.
Browser and Computer viewing also share the gesture mapper and device-local
viewer mode owner. Direct input addresses the finger; trackpad input retains an
accelerated relative cursor. Browser held drag uses CDP press/move/release and
the existing control lifecycle releases held input when the viewer disconnects,
yields or closes. Computer drag settles atomically on release, with a local
cursor/trail rather than live desktop hold feedback, as approved on 2026-11-02.
Pinch and edge panning transform only the local picture. The viewer action hook
owns one-shot/locked modifiers and keyboard intent; the clipboard transfer
helper shares the local OS boundary while each source retains its existing
authenticated control transport. These describe development-source behavior.
Computer clipboard transfers use `computer.clipboard.read` and
`computer.clipboard.write` through that same scoped Computer owner, including
the personal desktop worker. They require the present person; Agent, MCP,
Plugin and public API projections exclude them. Clipboard payloads/results are
live-only and redacted from Action observations. The native driver returns a
typed unsupported result when clipboard transfer is unavailable; the viewer
action returns that failure to its caller instead of reporting success.
The close owner's `dispatched` answer identifies the retired `sourceId`. UI clients clear
only that matching source from their shared projection, without a confirmation read; a
replacement source survives an older acknowledgment. Failed or unknown completion keeps
the release affordance available.

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
The display's optional `captureId` identifies its stored `captureMedia` image, published
together by the successful daemon capture writer. A click-target ring may use that image
only when this id matches the input's capture id. A failed newer media write retains the
earlier image/id pair, so it cannot label an older image with newer coordinates.
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

The approved 0.3 simplification targets one admission and one material acquisition, followed by the physical bridge's full target/focus/frame/origin proof
after the last await. It removes intermediate permission/material re-reads; it retains acquisition-time Account/mode checks, observation hold/drain,
buffer zeroing, unknown/no replay and separate Submit/Remember. Native confidential fill is deferred after 0.3. This is the approved target contract,
pending the integrated implementation, live checks and security review; see the repository's 2026-10-29 owner rulings.

`browser.automation.secret.fill` requests an exact-target human choice through the
existing approval Artifact; its public input contains no credential. The private
continuation accepts a Saved Secret catalog choice or an ephemeral one-time value.
Always allow cannot supply that choice. Admission binds the deciding human's
Machine access and the original requester's origin. Secret acquisition consumes that
admission: before acquiring material it checks only the local cancel signal and that the
claimed request is still executing with the same exact input; an access change applies at
the next continuation.

Browser `snapshot` and `semanticSnapshot` retain masked text and structure on
password-bearing pages while omitting screenshot media. The capture owner is
described in the [Browser automation matrix](./browser-automation-verb-matrix.md).
Snapshots expose a credential target only for the focused, verifiable input.
In 0.3 development, a unique input `queryElements` result also publishes
`focusedCredentialTarget` for the queried field without moving or requiring focus,
so an agent can form the exact-target confidential Ask. Its `focusId` identifies
the field that must be focused at delivery. These paths share the isolated-world producer and the same tab, frame,
document, origin, locator and backend-node proof used again before confidential
delivery, which still requires the exact field to be focused. Unsupported field identity produces no fill target; raw typing is not a
confidential fallback.

The managed Browser producer qualifies only its actual live headless view as
unobservable by native capture. Other producers refuse confidential entry. Its
existing input/capture owner retains the confidentiality hold while the document
can reveal the value; handing control back does not release it. Field, focus and
document proof is checked at the final physical delivery boundary.
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

The 0.3 development `session.compact` Action requests manual compaction after
the current turn. It defaults to the caller's current Session and accepts optional
instructions when the Agent supports them. Admission returns `admitted`,
`already_pending`, or `unsupported`; admission is not native completion. Agent
calls to their own Session are allowed by default; calls to another or unproven
Session, including standalone MCP calls, ask by default. Existing approval
preferences can change these defaults. Native refusal remains visible through
the Session lifecycle. The composer retains its `/compact` text and Pending
behavior; both routes share the host's manual compaction admission.

In 0.3 development source, `session.turn.cancel` requests cancellation of the
current turn through the existing `abort` RPC. It keeps the Session process
available; `session.stop` requests process shutdown. Both the composer Stop
button and Agent/MCP/CLI requests enter the canonical Action executor.
For an installed Agent, Home admits a signed turn cancel for its own Session or
a Session it leads in the same Account, then routes it to that Session's
current publisher. A current-Session-only caller can cancel its own turn.
Session Stop is non-consequential and direct by default on UI, Voice and automation
surfaces; the person can configure Ask through the existing Action settings.
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

The development `session.permission_mode.set` Action defaults to `immediate`.
With `applyTiming: 'next_prompt'`, it stages the permission choice on the existing
Session draft without sending input, through the same client-hosted draft writer
as the permission picker. CLI, MCP and API calls use this same Action contract.

The composer's “From the next prompt” choice is retained with its draft. Send
enters the Send Action with that permission intent; selection alone does not
change the running turn or publish a Session mode. Embedded and standalone embed
composers use the same owner. A refused or unconfirmed Send retains the draft;
accepted Send clears only its captured intent revision, preserving a newer selection.
Recovered armed Agent-continuation custody performs the same revision-sensitive
clear after a delayed response or composer remount.
Agents can stage that intent through `session.permission_mode.set`, or explicitly
send with `permissionModeOverride`.
There is no daemon-retained pending permission mode.

## The three host-stamped facts

Three fields on a spec row are stamped by the host and never accepted from Action input. Together
they decide who may invoke an Action, where it runs, and how it reaches the Home.

In 0.3 development source, CLI credentials are captured once at Action admission.
External and Session MCP hosts likewise retain the credentials supplied at host
construction; later tool calls do not reread the local login file. Session hosts
retain explicit requester-custody checks and their existing request/turn cancellation.
Later local credential-file changes do not replace that invocation's bearer or
trigger another credential read. Local cancellation remains effective, and the
receiving server authenticates every call: a server-revoked token is refused on
its next call. Each fan-out recipient retains its own target/access admission.
UI Account-lifetime checks still prevent an old Account's result from appearing
in a replacement Account's screen.

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
authority from verified credential kind and surface. An account credential is
present-user on UI/RPC; a terminal credential (the person's CLI login) is
present-user on CLI/RPC. Voice, plugin, Agent and API-token
callers remain automation. Server verification owns the corresponding verified
credential authority; forwarded RPCs use its stamped `callerAuthority`.

There is no terminal present-user policy: no Account setting, machine
environment override or CLI command lowers a terminal login. Agent-, MCP- and
plugin-originated calls carry an explicit per-invocation `account_automation`
authority ceiling as caller attribution, which can only lower authority.

**`executionPlacement`** — `account`, `machine`, `session`, or `client`. External ingress resolves
an Action's execution target from this registry fact rather than from the id's prefix, so a new
Action cannot silently inherit a Machine route by being added next to one.

In 0.3 development, `session.status.get` and `session.activity.get` retain Session
target authority while reading the requester's authorized Home projection. Their
explicit empty `originalExecution.daemonIngressSurfaces` declaration lets original
CLI reads proceed without the Session publisher, including archived shared Sessions
without access to the owner's Machine metadata or worker. Omitted ingress declarations retain ordinary Session
publisher routing. Agent self-Session confirmation and exact Session API-token
targets remain unchanged; optional live status refresh stays best effort.

In 0.3 development, `client` executes on the answering app through admitted daemon reverse dispatch where that
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

Removing a trigger or its source stops future admission and preserves the owner's
Run history. The existing Account/operator age-retention policy still applies,
including `keepForever`; deleting a source is not a request to clear history.
Explicit Run-history deletion remains custody-safe. Removing a Team member
withdraws that member's access without changing the owner's history.

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
The invoking Home and Account select the current mounted owner, not a row filter:
an admitted Inbox may contain several Homes. Each row retains its originating
Home in its source, focus and route; a focus change does not rebind that identity.
Lead group roots likewise carry `{ kind: 'lead', serverId, sessionId }`, including
when the lead is unreadable. Grouping and duplicate suppression use Home + Session
identity, so equal Session ids on different Homes remain distinct. Workflow
origin ancestry and step folding use the Workflow attention window's Home.
The default headless snapshot reads the captured Account's owned notices and reports
missing app projections as partial. Use `inbox.get` with `projection: "automation_attention"`
to read one page of the invoking Home's Automation occurrences that need attention,
including occurrences without a linked Workflow Run. Follow `nextCursor` with the
same projection to read another page. Inbox uses this same Action and retained
Automation query for its attention window.
Discussion rows retain their exact message reference and Doc proposal disposition;
`coverage.discussions` reports complete, partial or unavailable source coverage.
An incomplete private Artifact source preserves other admitted rows in a `partial`
result, with notice coverage in `coverage.sources`. Pending reads retain
`isLoading`; failed or unreadable Artifact coverage sets `refreshFailed`. An empty
incomplete projection still returns `loading` or `unavailable`, never caught up.
A failed demanded Execution Run source likewise returns `partial` when useful
rows remain, with `live_items` coverage marked partial/content-unavailable. A
previously admitted terminal Run notice remains readable during a typed source
outage, but an access refusal, malformed reply or unknown failure withdraws it.
This does not create a second persisted notice or synthesize missing Run content
on a cold read.
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

Action Workflow triggers in unreleased 0.3 source observe executor invocations.
An authenticated request sent directly to a Home data route bypasses them (P02
D6). For example, a direct profile mutation at `/v1/account/profile` does not
become an `account.name.set` invocation. The UI's
`createHomeDomainActionExecutorForScope` and the CLI's `homeDomainAction` port in
`accountServerActionDeps.ts` are transport dependencies beneath the shared
executor; their HTTP calls do not start another Action or publish another Action
event. Home route authorization and native domain events still belong to their
existing owners. External callers that need Action admission and triggers use
`POST /v1/actions/:actionId`.


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
| **H** (person-class) | `requiredAuthority: 'present_user'` | Account security, root-token administration, sign-out-everywhere, plugin trust/install/secrets/hooks/grants, Runner activation and declared Team identity/directory administration. Scoped credentials (API tokens, embeds) never run or approve them. Host Agent, MCP and plugin callers default to Ask; the user can waive it per Action and surface, and the waived call runs (owner ruling 2026-10-29, no present-user floors). Token decisions and conversational input have the explicit admission exceptions below. |

In 0.3 development, the Account preference **Voice agent can approve requests**
(`voice.canApproveRequests`, default on) delegates approval and denial of pending
requests to the host's Voice agent in Local Voice and host-tool realtime modes,
acting for the person. Native Codex Realtime is excluded. This is a narrow decision
capability through the existing approval owners, not direct execution authority for
other effects. The original Account and request entitlements still apply. Turning
the setting off restores the tap requirement; Agent, MCP, API-token and other
non-Voice callers keep the authority rules below.

In development source, a local Voice carrier retains the normal permission intent
for UI Actions. Its native tool configuration disables coding tools, including
shell, file and patch tools; the structured Voice function remains its Action
transport. These requests reach the same client Action executor as realtime tools.
The qualified Codex 0.162.1 runtime still exposes native subagent tools despite
its multi-agent disable flags. Full carrier confinement is blocked on the Codex
runtime owner qualifying a release with native subagent-tool removal; 0.167.0
supports that control but is not the current qualified runtime.
The Voice binding supplies its exact synthetic carrier address to the Session
send owner, which refuses that address after target resolution, including selectors.
An ordinary Session bound through native Session Voice remains a valid target.
The existing spoken confirmation owner binds any required read-back to the exact operation.
Native permission prompts and replies use the current Account preference within
the Voice Run's signed authority. Turning off the preference during a call makes
the next permission prompt ask the person to use the approval card.
The shared Action catalog documents the approval-list tool alongside request
reads and decisions. Settings discovery publishes page ids derived from the
canonical setting declarations; omit `pageId` to find all displayed settings
instead of guessing a page id from its title. Local Voice consumes this same
catalog and executes the returned anchors through `settings.set`. A decision
refused with `present_user_required` is spoken as a tap requirement, preserving
the owner’s refusal rather than reporting a failed lookup.
The UI Action executor projects its resolved Voice authority on open Account
approval results as `voiceApprovalGuidance`. Voice tools pass `tap_required` or
`spoken_decision` through the existing request-sharing policy. The reverse RPC
keeps guidance inside a successful result and carries typed failure causes and
closed details on refusals. A Memory write refused by the bound Session's policy
returns `action_disabled` with `details.reason: session_memory_off`. Voice uses
that reason to explain the Session's setting. A decision Action still goes
through ordinary admission when invoked.
The provider privacy projection retains catalog operand names and declaration
labels while continuing to redact actual file paths and private Session titles.
An approval already applied by its host keeps its successful receipt if the
Voice approval preference changes while that receipt is returning. The next
invocation uses the changed preference.

`resolveCredentialActionAdmissionV1` admits `approval.request.decide` and
`session.permission.respond` for a present user or an API token with opt-in
`grant.approve`. In 0.3 development, host Agent/MCP callers may also invoke
`session.permission.respond`: the shared Action approval policy requires approval
by default on both surfaces, and the user may explicitly waive it per Action
and surface. Host Agent/MCP callers may decide ordinary approval requests only
when the user explicitly waives `approval.request.decide` on that surface in
Account settings or an explicitly selected Approval Profile. Inherited Team or
Group profiles can only tighten policy, and Session consent rows cannot delegate
approval decisions.
Without that waiver the decision returns `present_user_required`, without
creating a recursive approval. The waiver covers person-class and public-link
requests too, but never lets an agent decide its own request: the executor compares
the immutable requester provenance with the deciding Session before forwarding or
settling a decision. A person-created host request has no requesting Session and
may be decided by an explicitly Allowed agent; Session-origin requests retain the
same-Session prohibition. Missing immutable origin or deciding Session identity,
and replay of the request's own invocation id, are refused. These are development
contracts. API-token authority remains unchanged. A token also needs
membership in the decided request's target;
it does not need permission to execute the Action being approved. It may decide
a request it started itself, except that a token never approves a person-class
Action (scoped credentials are never a person); it can still reject that request.
Browser and computer control/recovery requests (Take control, Hand back, target
selection, permission-settings recovery, sandbox installation) follow the same
rules; there is no separate human-only decision list. `decisionAuthority.ts` owns
credential admission; the executor's decide branch owns the requester rule.
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
input: tokens need the exact Action grant or Send (which implies answering),
rather than `approve`. An answer-only grant does not permit message sending or
a child grant that adds Send. Other automation
callers outside those host Agent/MCP decision paths still need present-user
authority for these rows. In 0.3 development, the person's Voice answer uses shared
spoken confirmation when `voice.canApproveRequests` is on; an approving decision
receives read-back before execution. OFF and synthetic turns retain the existing
person approval flow; replay reaches the same question answer owner and is
attributed to the authenticated person. Waiving the prompt grants
no execution authority. `disposition: pass_up` remains an authenticated manager
disposition at that owner and does not use this Voice proposal path.
Discussion create, rename, archive, restore and private
read-state writes are person-class Actions. Agent/MCP calls use the same deferred
approval and replay owner by default and run directly once the user waives that Ask.
Read-state advances only the executing Account's private cursor. Discussion
reads remain safe automation Actions, and authored message posting retains its
separate dangerous approval default and visible Agent attribution.

In 0.3 development, Agent, MCP and trusted-plugin calls can invoke person-class
mutations, including
API-token update (including embed configuration), revocation,
and sign-out-everywhere. Requestability derives
from the Action's authority and custody metadata, not a mutation allowlist.
`resolveCredentialActionAdmissionV1` admits host automation; only scoped external
credentials are refused. The single approval policy requests a deferred approval
Artifact by default. A surface waiver or explicit false policy runs the Action
directly under ordinary admission (owner ruling 2026-10-29). Creating a PAT remains
a human-only UI action for 0.3 (owner ruling 2026-11-07); Agent/MCP creation is
refused before approval or execution.
The signed-root CLI catalog admits token creation, access updates, inventory
and revocation. The API-token catalog still excludes token self-management.
Credential-bearing input is the other custody exception: the admitted
invocation remains the blocking waiter and the Artifact holds only its safe
preview. Authenticated approval or exact-daemon replay delivers human authority
through that existing live continuation, never through an Artifact field. A
detached raw-input invocation cannot be replayed from durable history.
Direct API-token mutations remain refused. `account.apiTokens.list`
and `account.security.get` are ordinary Agent/MCP-exposed reads.
The decision owner refuses an API token's approval of a person-class Action. A
host agent with a waived decide may approve it, never its own request. Replay of a
stored approval of a person-class Action still requires authenticated present-user
RPC authority. For the built-in host Agent/MCP Account requests, the deciding app
reuses its authenticated Home adapter and existing execution claim, stamping the human
authority only on that approved replay. Other daemon-owned provenance stays on its
existing exact-daemon replay path.
If a dispatched replay loses its reply, the deciding app observes the retained
receipt without settling the daemon's work. The daemon may still be preparing
admission before its execution claim; an approved request remains available to
it. Unreadable receipts return uncertainty to the caller without a terminal
Artifact write. The claiming executor retains effect and receipt settlement.
In 0.3 development, the approved seven-rule model routes durable Account/client
effects to the approving app and Machine/Session effects with captured daemon
custody to that daemon. A direct present-user UI Ask without an originating
Machine resumes through the built-in app adapter; the reviewed operands still
select the Machine or Session effect.
Native deployment roots, including Domain changes and an unprepared target Link,
retain their controller Machine executor.
The shared `resolveApprovalExecutor` owns this choice for every requesting surface
and caller. Signed ingress remains immutable proposal provenance, and ordinary
admission still controls the effect. Live-only input and show-once results stay
with their original invocation. Invitation create/reissue links therefore reach
only that live caller; observations and history keep the material-safe summary.
Repeated decisions read the settled outcome without re-executing or revealing
the link again.
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
The signed Stop transport retains Delete's original admission and reviewed
Session operand through the owning Machine's receiver. It uses the same
reviewed Stop-child owner as Section archive; neither phase becomes a new
Action admission or a grant over another Account's Session.
Direct Home DELETE retains its inactive guard and typed absent/active/conflict
responses. The canonical Delete Action treats typed absence as successful deletion,
including after its Stop retry. The UI's captured Home adapter retires that Home's
local Session state after success or typed absence through the same retirement
owner as cross-device deletion; it does not wait for a socket echo. This projection
borrows the request authority's credential Account lifetime: changing focus does
not suppress cleanup, while an old Account's acknowledgement cannot retire a
replacement Account's local Session. Exact Session
route reads also retire stale local state when the Home proves Session absence.
An ambiguous 404 or a failed Stop is not absence evidence. Delete adds no separate
liveness read.

In 0.3 development, the same `session.delete` Action also accepts
`{ machineId, runId }` for a terminal detached conversation. This operand reaches
the exact online Machine through the existing Machine RPC transport. The daemon
bridge admits only the starting Account's detached record, using its existing
request scope, and refuses a running conversation. This branch has no Stop child.
It removes Happier's retained history and visibility marker; it never deletes or
opens the Agent's native conversation. Detached Run details use the existing
Delete control and Session confirmation. `{ sessionId }` keeps the Home route
and Stop and Delete behavior described above.

In current 0.3 development,
ordinary `session.open` navigates without starting a process. Explicit `intent: 'resume'`
resumes through the same Action admission and exact-Home Session reader; durable
approval retains that intent rather than settling it as navigation. It also accepts
`approvedNewDirectoryCreation: true` as explicit fresh-folder recovery consent;
that arm is person-class: it asks for approval by default on Agent/MCP and runs
once the user waives that Ask; API tokens receive `present_user_required`.
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

Settings → Sessions → Sections (`session.list.sections`, a navigation anchor with no
stored value) lists the selected Home's sections in `sortKey` order. Its rows
create, rename, change the icon of, reorder, archive all and remove sections only
through these section Actions, with the list's one removal confirmation. Folding
a mounted Sessions-list group is a mounted current-context command
(`ui.current_context.read` → `ui.current_context.command.invoke`) that writes the
same context-qualified device-local key as the group's chevron and the
`session.list.collapsedGroups` setting; it changes that one key only.

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
request. For a request with provider-offered native choices, an exact
`nativeChoice` selects one; a plain `decision` (Allow/Deny, Allow for Session,
Stop) selects the one offered choice with that decision and scope (Deny falls
back to an offered Stop when no denial is offered). No match, more than one
match, or extra grants a native offer cannot carry (mode, tool rules,
amendments) are unoffered. No Agent-owned permission policy or decision store is introduced.

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

In 0.3 development, a trusted creator can record `deciderRequirement: 'person'`
when creating a built-in approval request. An Action declares the consequence
of its admitted input through `approvalPolicy.deciderRequirementForInput`.
Automation and explicit approval requests with this requirement create an Ask
even with standing Allow or `bypassApprovals`. A present person’s direct
invocation keeps its existing routing and in-place confirmation. The decision
executor reads the stored requirement and accepts fresh approval only from
present-person credentials; reject and cancel retain the existing withdrawal rules.
The requirement is fixed for the life of the Artifact. Deferred replay consumes
the accepted decision. Requests created without the field use the existing
decision rules. Use matching development clients, daemon and SDK declarations
for the closed request shape.

### Database access in 0.3 development

`database.access.read` describes access for the selected database. Worktree and
manual database settings are changed through `database.access.set` on the Machine.
For a deployed database, the read result identifies the Environment policy and
its revision. Environment managers change that policy through
`deployments.environments.update`. A Preview uses its template's policy.

Worktree capture status, trace lists, endpoints, logs and costs follow ordinary
Worktree access. Agents must select an exact Worktree database target to list or
open queries or open trace details with SQL evidence. Without that selection,
those Actions return `database_target_required`. The selected database's own
agent access policy governs the read. People can read the generic partition
under the existing Worktree admission.

The selected target's agent level is **None**, **Read**, **Read and write (asks
first)** or **Read and write (no approval)**. The person must also have the
corresponding access to the target. The existing approval resolver applies the
asks-first floor and retains stricter personal settings. A reviewed ordered
write runs in one transaction. Parameter values and edited cell values go to
the live executor. The approval Artifact redacts those inputs, and the result
body returns to the live caller.

In 0.3 development, `account.plugins.data.erase` is available to Agents and MCP
through `account_plugins_data_erase`. It defaults to Ask through the ordinary
approval policy: requesting erasure creates an approval request, and the original
executor erases the selected plugin’s retained Account data after approval.

In 0.3 development, CLI Actions forwarded to the daemon with live-only results
return the typed
`approval_request_created` result and its Artifact id as soon as approval is
requested. The CLI presents that id and prompts for a decision, or approves with
`--yes`. The captured executor runs an approved deferred request through the
ordinary decision-to-execution path, independently of the original CLI
connection. A later `approval.request.get` collects the observation-safe
execution receipt; private result fields are returned only to the live person
deciding. The shared CLI approval consumer preserves the deciding call's typed
live result when its receipt arrives first. A receipt-only caller receives
`approval_result_held` for a successful Action with live-only result custody,
instead of treating that observation as the Action's typed result.
Actions requiring live-only input keep their existing retained-input
custody instead of persisting that input for deferred replay.
Daemon-hosted target-Action approvals retain the daemon's own Machine placement
when the origin has no Machine, including Account-target UI requests. The existing
approval decision route delivers consent to that daemon's retained invocation;
standalone live invocations continue without a daemon placement, even when their
registry can resolve a Machine. Only the daemon host that holds the waiter supplies
that private custody fact.
Retained CLI invocations use the same approval callback regardless of result
custody: the terminal presents the Artifact id and points to approval in the app
before prompting, while keeping the original invocation alive. Presented daemon
requests use the invocation's cancellation signal without a transport deadline.
Private-input-only requests keep their existing deferred acknowledgement lifetime. In `--json` mode, an `actions_invoke` envelope carrying
`approval_request_created`, `artifactId` and `actionId` is written to stderr;
stdout remains the final Action result. A decision from another surface closes
the pending prompt through the invocation's existing cancellation signal.
If a child Action needs its own approval, stderr identifies the child and its
Artifact and directs the requester to the app Inbox. With `--json` the notice
uses `approval_pending`. The original invocation waits for the child's decision
and returns its own result.

When a one-shot CLI call leaves a durable deferred approval for the app, it
returns `approval_request_created` as its final result and closes its approval
subscription. The app's Inbox can still decide the request. A progress event
for a blocking Action identifies the approval. The original invocation still
holds the private input or result.

In 0.3 development, a standalone CLI or saved-profile MCP approval whose live
invocation owns the operands publishes an Account RPC origin before creating its approval Artifact.
Another present-user client in that Account sends only the exact Artifact and
Home identifiers and its decision. The server authenticates that decision; the
original invocation validates the captured approval subject before its existing
decision and execution owners resume. Ordinary Artifact writes cannot supply
consent, and private operands stay in the original invocation, retaining its
Machine, Session and automation attribution. The origin closes
with that invocation; an unavailable origin returns a typed refusal.

Retained local Account authentication hosts keep their existing live approval
lifetime. Their retained client sends the decision and collects its typed result
on the same host that owns the authentication attempt.

While a CLI approval prompt is open, a remote rejection or recorded execution
result closes the prompt and settles the caller. Observing approval history does
not claim the daemon's execution or resubmit the original Action.

The CLI advertises and accepts `--wait` for Actions declaring an operation or
a terminal operation observer in their canonical spec. It observes the returned
operation address through the existing operation owner and preserves each
Action's settled result type. An approval alone does not add a `--wait` flag.

In 0.3 development, deciding an approval does not revalidate its execution origin
in the deciding app or terminal. The selected executor performs its ordinary
admission before claiming execution. A refusal before that claim leaves the
approval approved without an execution receipt, so the origin can execute it
after admission recovers. A claimed execution keeps its existing settlement and
unknown-outcome rules. Currentness adapters report a specific failed fact;
an unclassified refusal is unavailable context, not evidence of a stale origin.

In 0.3 development, a Discussion publication with an unknown outcome remains
linked to its original request in that Discussion. Its inline status reflects
the uncertainty and keeps the existing in-place Review recovery.
Declining a private Discussion draft settles its exact original Session reply
before recording the terminal approval Artifact. While that settlement is pending,
the origin card keeps its decision controls busy; a failure stays inline with its
typed reason and Retry. A lost reply acknowledgement is reconciled through the
same original reply before retrying the Artifact transition.

The shared approval creation owner validates its proposed body before writing.
In 0.3 development, an invalid body returns `approval_invalid` with schema issue
codes, paths and messages. `approval_request_conflict` identifies different
captured content under the same request identity; a failed body/header read is
invalid rather than a conflict.
The built-in creation subject comparison reports `details.mismatches` with fixed field names.
The approval-read and failure-history owners preserve those names through current
built-in receipts; operand values and credentials are excluded. Older receipts
and conflicts from other producers may omit these details.

In 0.3 development, a retained native plugin `discussion.post` or
`discussion.reply` keeps its open person approval when its executable generation
retires. The successor reconstructs the native operands from the existing
retained obligation and rejoins through the approval creation owner. Account,
Home, Machine, plugin, contribution, `localId` and canonical input must match;
generation custody and invocation correlation may change. The original consent
and decision remain unchanged: approval permits one publication, rejection none.
Explicit caller withdrawal still cancels; changed input cannot rejoin. The
successor's live factory-bound custody supplies execution, never a new person
authority or an executable origin reconstructed from an Artifact.
Attachment-bearing publications keep attempt identity: retirement cancels their
Ask and the successor asks again with its freshly materialized file paths.

Accepted glitch in 0.3 development: if a retained request retires with no
successor because the plugin is disabled or uninstalled, or the obligation is
dropped, its Ask stays open without an executor. Approving it cannot publish
while there is no matching successor. The stale Ask and absent publication are
visible and recoverable: the person can reject it or restore the plugin and
obligation so a matching successor can rejoin. There is no sweeper or timer.

Confidential fill approvals retain the exact value-free Action input. Its Home,
Session and Machine target need not repeat the requesting origin; the domain
admits that target when executing the person's private choice. Artifact
transitions route by the origin's portable Home identity. Retained development
origins may still contain a local profile name for captured input provenance;
that name does not establish a second Home authority. Private values remain
outside the durable approval body and transcript.

In 0.3 development, a missing required secret input on the consuming Action
opens that same confidential choice. Built-in input hints and plugin manifest
`widget: 'secret'` fields supply the declaration and their existing required-field
rules decide whether an absent value needs a choice. An omitted optional secret
(such as the MCP OAuth client secret) leaves approval to the ordinary Account
Action policy. Supplied secrets retain private custody. Callers invoke the actual
Action rather than a separate secret-request Action. The retained request has
no secret values, and the private continuation supplies one Once or Saved
choice per prompted path. The existing approval claim binds the exact request,
Home and Machine, and a repeated completed decision returns its recorded result.
The direct CLI uses its existing hidden terminal or stdin reader for these
fields. Remember is a separate Saved Secret write after successful consumption;
its failure must not replay the consuming Action.

The built-in `secrets.create` Action declares its inline `value` as required
when no external/passkey source was selected. An agent can submit the name and
kind, then the person supplies the value in this same confidential approval.
The private Saved Secret resource writer stores it and returns only the id and
reference. Metadata-only edits and source links do not ask for an inline value.
Managed identity provider create/secret replacement declare `clientSecret`;
Home settings derive their secret replacement fields from the server config
registry, including WorkOS keys. Identity, WorkOS and directory setup are
requestable from Agent/MCP with their existing authority and approval policy.
Directory/WorkOS connection Actions select configured providers or connections;
they do not introduce a second credential input or storage owner. Deployment
Variables use this declaration and continuation rather than a separate Ask card.

`ConfidentialSecretApproval` renders both declared Action inputs and exact-field
Browser entry in the existing approval detail. Each field accepts a masked Once
value or **Use a Saved Secret**. **Save for next time** is off initially and is
offered only for a typed value. Generic input requests use **Approve**;
**Dismiss** cancels without an answer and **Deny** rejects. Both clear the local
draft. The continuation reports Action execution and per-field save outcomes
separately, and unknown execution is not replayed. Published instructions live
with [Saved Secrets and profiles](../apps/docs/content/docs/agents/profiles.mdx#credentials-requested-by-actions-development).

The unreleased deployment-role co-land extends the existing host-child rule
(R5), not the approval engine. The host binds a declared role invocation to its
reviewed deployment parent and the receipt's recorded Environment, target link,
controller, operation, credential principal and native provider scope. Only that
exact child inherits the parent's reviewed steps and deployment grant;
an ordinary plugin Action receives no general `action.invoke` permission.
Missing or changed recorded scope is refused. The child's explicit Ask policy
is evaluated during receipt-free parent preparation, before reserving a receipt
or occupying the Environment's deployment slot. A registry lookup failure during
an own-server Deploy review returns the image selection and a typed cause in the
Action failure. The selection includes the Compose service and the image reference
when it is safe to disclose. Native command output stays private. If review
preparation fails, there is no approval or Receipt. When policy needs a new
approval, the ordinary approval request names the root deployment; its exact
approved replay performs normal admission and then creates the receipt. There
is no `waitingApproval` receipt state or separately replayable child bridge.
The same Account/daemon placement and credential-purpose owners execute the child; the
provider plugin does not become an approval or credential authority. The required
O1 settlement contract retains an accepted receipt's captured requester custody
after the requester leaves, without substituting daemon credentials. These
F1/O1 co-lands and full Account-handler integration remain under development
validation, not released availability.

Plugins are trusted, unsandboxed code. R5's private continuation marker binds
host admission against serialized claims from another person's token or agent;
it is not protection against plugin code. Policy evidence omits the captured
credential context so ordinary diagnostics cannot disclose it. No per-plugin
egress or capability fence is established by this rule.

An admitted finite deployment is allowed to finish if its plugin registry
occurrence retires after the provider accepts the send. Settlement still uses
the captured requester and the signed receipt writer's revision comparison.
A refused or lost settlement remains `outcome_unknown`; observing or deciding
the same request again must not resend the provider effect. This is not a grant
to start a new operation after retirement, nor a substitute for O1 custody.

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

In 0.3 development, original UI, voice and CLI input requiring Machine admission,
including encrypted Session-creation first input, carries `actionRequestAttributionV1` in its protected request
before content sealing. The message producer uses the sending Account credential,
checked against the Home-admitted Account binding on routed sends. Machine
ownership never supplies the requesting person, including on shared Machines.
Raw-RPC Session creation carries its authenticated present-person host authority
through the first-input handoff to this same sender. Automatic host creation
cannot establish a human requester from the execution credential; inherited
requester attribution remains unchanged.
Conflicting requester, input or persona claims are refused before admission.
The receiver retains this fact in protected input authority for the Agent's
subsequent Actions; authored message metadata cannot supply it. Sends that do not
require Machine admission keep their authenticated Account-receipt path. A routed
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

In unreleased 0.3 source, the Actions catalog's contextual-default owner assigns
required top-level `machineId` operands to the invoking Session's Machine when
omitted. Explicit Machine ids win. Session-bound agent/MCP tools project that
operand as optional only when the host has the Machine context; standalone
hosts keep the canonical required input and its typed refusal. The bound input
then follows ordinary Action admission and authorization. Optional Machine
filters, branch-specific operands and nested transfer destinations keep their
existing owner's selection semantics. Authored defaults remain for the optional
Memory window and Docker-prune Machine operands; workspace root defaults stay
on the owning Action.

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
Voice calls asking about the bound Session's Project can omit `query.scope`.
The App resolves the qualified Project from the opened Account's workspace
census and returns `target_unavailable` if it cannot establish the association.
Explicit scopes retain their existing meaning.

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
body shape is `{v: 1, index, topics: [{title, summary, facts}]}`. Readers and writers
use this same shape; stored reads discard additive unknown fields and reject malformed known fields.

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
Its `expectedMetadataRevision` is the caller's exact observed Session metadata
version, separate from the document's header/body revision. A stale submission
or approved replay returns typed `conflict` and retains the draft.
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
`expectedMetadataRevision` must match the first exact owner read, including on
approved replay. A changed or unavailable revision returns typed `conflict`
before a write; the caller keeps its draft and must review the current Session
before submitting again. The shared registered-field updater then captures that
field's value, reapplies the intent to refreshed metadata after a tuple conflict,
and returns `conflict` if the same field changed during the write. It preserves
concurrent values in other fields after that first admission.
Context's basis includes its ordered Session stack and inherited-entry suppression;
memory and voice each compare their own effective choice. Changes preceding the
first owner read cannot silently become a fresh basis for a stale reviewed edit.

Attachment admission still uses the qualified header/document-kind owner from
preparation and preserves typed `attachment_unavailable` failures. A refused
attachment retains a newly created reusable document and the editor's draft.
The lower-level explicitly revision-pinned tuple API and retained CLI durable
mutation custody keep their strict revision contract; semantic Actions compare
the caller revision once, then retain field-scoped retry checks. Composed loaded-runtime verification
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
not another Artifact or grant. Readers and writers use this same sectioned body.
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
an unavailable or denied attachment from a revision conflict. A Home transaction
that confirms rollback carries its typed code, such as
`database_transaction_conflict_exhausted`, through the attachment receipt.
UI receipt classification keeps this `saved_unattached` outcome separate from an
unsaved write conflict.
In 0.3 development, an identical `memory.remember` retry with the same Action
request identity rejoins the acknowledged document and retries attachment while
the admitted scope is still unattached. The Artifact owner derives its
Account-scoped identity from the request and destination. E2EE uses the existing
Account content key derivation. Plain uses the existing keyless derivation.
Recovery can also attach the saved reference through the existing scope context
writer at a fresh reviewed revision, then resume against the actual attachment.
Opening,
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

#### Saved approval profiles (0.3 development source)

In unreleased 0.3 source, a saved approval profile is a private
`approval-profile.v1` Artifact. Its body contains `kind` and `profile`; the
profile content is `{ name, actions?, approvalWaivedSurfaces? }`, and its id is
the Artifact id. The Account settings no longer contain profile bodies.

The Artifact/settings migration, held catalogs and overlay applier are unreleased
0.3 development code. Creation owns profile selection and captures the inherited
source bit; admission consumes the stored selection. Retained authoring copy paths
are still being corrected, and composed creation/runtime validation remains incomplete.

A profile is a per-Action overlay of the Account's Approval settings:
`{ id, name, actions?, approvalWaivedSurfaces? }`, where each `actions` row holds
only `enabled`, `disabledSurfaces` and `approvalRequiredSurfaces` and only the
Actions the person changed are stored. Placements and tool exposure stay Account
settings. There are no built-in profiles; a Blank profile equals Account settings.
Sessions, execution Runs, Workflow defaults and step execution selections, and
trigger context retain `approvalProfileId` references. Omission inherits the
owning invocation's selection; `null` detaches it. Session metadata stores the
reference privately in its runtime owner. Agent permission modes continue to
govern Agent tools separately from Action approval.

`actionsSettingsV1.machineApprovalProfiles` maps a Machine id to the person's
profile for new Sessions on that Machine. In unreleased Team setup source, the
creation context builder fills an absent member approval choice from this map;
the shared defaults resolver applies the [one field order](teams.md#managed-session-defaults)
and birth stores its result. Later Action admissions read only that stored id;
`null` or absence uses Account settings and never selects a Machine default.
Changing the map therefore affects new Sessions. An inherited project, Team or
Group choice also stores `approvalProfileTeamOrGroupDerived: true`, which the
existing profile applier consumes in tighten-only mode. An explicit choice,
including accepting the same id, clears the bit and permits full application.
These source changes still require the composed creation/runtime validation.

Profile rows are written by `actions.policy.set` `profileChange` (`create`,
`update`, `delete`). Updates and deletes carry the expected Artifact header/body
revision; a stale revision returns `currentness_conflict`. An unchanged update
writes and publishes nothing. `machine_default` remains a deliberate Account
preference. Deleting a profile also clears the Machine defaults that named it.
Generic Artifact writes cannot edit this internal kind.

Sharing uses the existing Artifact grants and encryption owner, with Account,
Team and Group principals. Can use maps to view access; Can edit maps to edit.
`actions.policy.get { profiles: true }` returns readable rows with their access,
owner and revision. The host binds the selected row once from its held catalog;
built-in and contributed Action routing consume that same bound value. Catalog refresh
follows the existing change stream and reconnect lifecycle, including kind-filtered
Artifact changes. The composed PostgreSQL/daemon journey is still unverified;
source-level checks do not establish that gate.

An Agent or MCP caller changing a child selection to a different profile, including
explicit `null`, defaults to Ask under `session.approval_profile.set`. Run profile
controls use this same preference; a broad `execution.run.action` or child-start
waiver does not waive profile changes. A person can deliberately waive the profile
control on its own surface. Direct UI and CLI selection keeps its existing policy.
Workflow selected-reference changes use the same routing owner at their existing
child Action admission, including stored defaults, nested steps and replayed leaves.
Deferred approval retains the original invocation's profile reference in
`executionOriginV1`; approving later does not replace it with the approving
person's selection or a subsequently changed parent Session selection.
The same origin producer captures the admitted execution target: an explicit
target stays exact; otherwise the host's admitted execution Machine owns replay.
Descriptive Machine provenance alone does not select an execution target.
A contextual Session id, including a standalone CLI/MCP host's `cli-global`,
does not select a new target after approval. Existing Machine/Home mismatch
and explicit Session target refusals remain in the replay currentness owner.
Fork and Continue preserve an omitted choice, including the source Session's
inherited-profile provenance, in unreleased 0.3 source. Explicitly selecting the
same profile accepts its full overlay.

#### "Allow for this Session" (0.3 development source)

In unreleased 0.3 source, a person can answer an Action's Ask for one Session with
two more rungs on the same approval-preference ladder. The first allows this
Action in this Session; the second allows this Action on one Machine or
Environment in this Session. The Session's rows live in one private Account
Artifact of kind `approval_session_consents.v1`, bound to the Session by the
server-gated `approvalSessionId`. The body is `{ v, kind, sessionId, rows }`, and
each row is `{ actionId, audience, scope?, mode: 'allowed' | 'ask_first' }`.
`actionId` is the policy identity (`profileActionId ?? actionId`), never a carrier
such as `action.invoke`. Nothing is stored per remembered call, and an approval
record is never written for one.

The record owners are Protocol `actions/sessionApprovalConsentsV1.ts` (record
reader and composer) and `actions/sessionApprovalConsentPolicyV1.ts` (writers and
eligibility). The Artifact kind has the private kind policy: no people sharing,
recipient or public link.

**Writers.** `createArtifact`/`updateArtifact`
(`apps/server/sources/app/artifacts/sessionApprovalConsentWriteAdmission.ts`)
admit a write whenever the current or next stored kind is the consent kind. That
covers create, re-kind, re-bind, header and body writes. The writer's verified
credential must be person-class, `account` or `terminal`: the same predicate as
`requirePresentUser` and the Account rung. The record may bind only to a Session
that the writer's Account owns. API tokens, Account Directory credentials and
ephemeral runners are refused, and so is binding to another Account's Session.
HTTP routes, the query-hint batch and the socket `artifact-create` /
`artifact-update` handlers pass the credential kind. Internal writers that pass
none are refused for this kind. Deleting the Session deletes its record.

**Composition.** `resolveProfiledActionsSettingsV1` applies the layers in this
order: Account settings, the person's full profile, the Session rows, the target
owner's Ask (database `readWriteAsk`), and the retained Workflow invitation. An
inherited Team or Group profile is applied tighten-only after the Session rows.
A Session Action row therefore replaces the Account or profile answer for that
Action and audience, including their narrower Machine or Environment rows (Q1).
A Session resource row is the most specific rung. A target owner's Ask, and an
inherited Team Ask on the Action rung, still win.

A Team, Group or project profile is a default rather than a lock: the
creation-stamped bit marks it, and the person's own explicit choice clears it.
An inherited Ask beating a member's own exact-scope Allowed (including a Session
Machine or Environment row) is Coordination's precedence change
(COORD-APPROVAL-FLOOR-1120).

**Admission.** The executor binds `context.sessionApprovalConsents` once per
admission from `deps.readSessionApprovalConsents` and replaces any
caller-supplied value. Rows apply only for the host-stamped caller
(`actionCaller.kind === 'session'`) and only when the invocation Account equals
the credential's Account. A CLI Session host answers only its own bound Session.
The daemon's Account-Action executor, which runs the Actions a Session runner
forwards (account-, Machine- and lifecycle-placed ones such as `machines.list`),
has no bound Session: it stamps the caller only after the turn witness matches
the Session its runtime capability is bound to, and that caller's rows apply.
`defaultSessionId`, an origin default or an input `sessionId` never selects rows.
The owner's Session process and the daemon hold the rows in memory, so an
admission does one lookup and no network read. A consent Artifact change on the
Account feed (the runner's, or the daemon's `apiMachine` feed) refreshes the held
rows, and the next admission waits for that refresh. A requester's Session on
another person's Machine reads its rows at each admission. A read failure applies
no rows, so the ordinary Ask returns.

The stored approval request carries `approvalScope` (`{ kind: 'machine', machineId }`
or `{ kind: 'environment', environmentId }`) when scope admission resolved one for
the invocation; an inherited Environment template is recorded as the template id
the preference reader answers on. It is presentation only: the approval sheet
offers the "on this Machine or Environment in this Session" rung exactly when it is
present, and replay re-admits its own scope.

The receiving Machine of a signed cross-Machine call runs its daemon-level
executor with the signed origin's caller. A Session caller's rows apply there
only under the same Account equality; a receiver-owned Ask is only used for the
original CLI finite path, which has no Session caller.

**Eligibility (Q6).** Some Actions are decided elsewhere and are never eligible:
approval controls and decisions, the per-plugin capture waiver, and approval-rule
changes (`actions.policy.set`, `actions.policy.reset`,
`session.approval_profile.set`). The router decides an approval-rule change's
Ask on the person's raw Account settings, so no profile or Session row waives
it. An explicit Account waiver stays the person's own choice. Writers refuse an
ineligible row with `session_approval_consent_unsupported`.

**Policy Actions.** These Actions take a `session` target:

- `actions.policy.get { session: { sessionId } }` lists the rows.
- `actions.policy.get { actionId, audience, session, scope? }` returns that row's mode.
- `actions.policy.set { actionId, audience, session, scope?, mode }` sets a row:
  `allowed` or `ask_first` saves it and `default` removes it.
- `actions.policy.reset { actionId, audience, session, scope? }` removes it.
- `actions.policy.set { sessionConsentsMove: { fromSessionId, toSessionId } }` moves the rows.

`get` is `account_automation`, so an agent may list and read rows. An agent's
`set` reaches the ordinary Ask, which is decided on Account settings. After the
person approves, the replay writes with the host's person-class credential,
which the gate admits for the Account's own Session. A person's own write from
their app is direct and has no second confirmation. People a Session is shared
with cannot add rows in this build. The terminal CLI keeps its existing danger
Ask for policy changes.

**Lifetime.** Resume and an Agent transition stay on the same Session record, so
the rows stay. A Continue after a failed resume moves the record (it is never
copied) through `sessionConsentsMove`. Fork, agent-initiated spawns, Workflows and
the legacy `session.continueWithReplay` ingress carry none.


`resolveActionApprovalRouting` applies the selected profile once, at the top:
`applyApprovalProfileOverlayV1` replaces the Account row and waiver list of each
Action the profile names for a member-chosen profile. For a captured Team/Group
or project default, it only adds Off and Ask requirements and retains the
member's stricter choices. The applier then consumes any admitted database
agent level supplied by the target owner: `readWriteAsk` requires Ask, while
`readWriteNoApproval` can waive the built-in Ask. It preserves the Account's
Ask or Off and the effective profile's Ask. The existing database type owns
this value. The applier performs no database access read.
These are invocation-local `targetApproval` inputs, not profile-body
fields or creation defaults. The ordinary evaluator decides on the resulting settings.
A member-chosen profile can therefore ask, allow or turn an Action Off exactly where
the Account screen could; it has no other waiver authority, and the egress,
authority and person-class defaults and scoped Machine/Environment preferences
apply as usual. Exact completed reviews retain the existing admitted-child/replay
behavior. Changing a profile's rows or a Machine default through `profileChange`
uses the same `session.approval_profile.set` control as changing a reference,
decided by the Account settings rather than by the profile being changed.
A Session-bound MCP host advertises through `createSessionActionSettingsView`,
the same overlay on its Account settings, so a profile's Off hides the tool.

A deleted, unavailable or inaccessible profile id resolves to Account settings with
typed `status: 'missing'` and the requested id. Approval metadata and deferred
results carry that resolution so a caller can show the warning. Deleting a
profile returns its Sessions to Account settings at their next Action.

In 0.3 development, CLI Action invocations with
`HAPPIER_SESSION_MCP_CONTEXT_FILE` use the Session's existing local MCP bridge,
including generated Action commands. The native agent MCP client and CLI use
the same context, socket and permission handlers. The context the Agent can read
names the socket only and carries no bearer; the socket admits the CLI, like the
relay, by kernel peer proof that it runs in this Session's Agent tree. The CLI
supplies no caller authority: the Session bridge admits the call as its agent and the
ordinary Action routing owner resolves its approval profile once. Pending
approval returns `approval_request_created` with its `artifactId` and creates
the ordinary Inbox approval; `--wait` also returns this pending result.
A missing, unreadable or retired advertised context fails without consulting
the person's credentials. Ending the Session retires the transport, including
for a process holding a captured context. Without a Session context, CLI Actions
retain the person's existing CLI behavior. The existing local transport supports
Linux and macOS; this change adds no Windows transport.

The Session bridge selects its Home and execution context. Generic Session
invocations reject standalone CLI transport selectors such as `--server-id`,
`--machine-id` and `--project-directory`; resource targets belong in the Action
input. Local file-transfer flags and CI-step generation require a person CLI.
The broad runner daemon bearer is never projected into the shell environment.

Approval profiles govern Happier Action admission, not arbitrary shell access.
Without Agent isolation, an Agent can read the person's stored credentials and
invoke the CLI separately. Isolation is the hard boundary protecting those
credentials. Isolated Agents currently share one OS user, so a deliberate Agent
could read a sibling Session's bridge token and act as that Session. A profile
does not provide isolation between those sibling Sessions.

The existing Account policy Actions own CRUD: `actions.policy.get` accepts
`{profiles:true}`, and `actions.policy.set` accepts `profileChange` with `create`,
`update` or `delete`. Existing Session attachment uses `session.approval_profile.set`
with its metadata revision; Run attachment uses the native
`execution.run.action` control `approval_profile.set`. Both accept a nullable
reference. The existing Workflow-definition and trigger update Actions own
their respective reference edits. Trigger `actionApproval: automatic|ask`
remains exact reviewed child consent, so it is distinct from the profile overlay.

`resolveActionApprovalRouting` is the single approval decision. It answers three things —
whether approval is `required`, which `flow` carries it, and what `result` custody applies — and
every host consumes that answer rather than re-deriving one. Hosts supply facts, never a boolean
answer (`ActionExecutorDeps`): `readActionsSettings` (the host's current Actions settings; a
Workflow invitation's retained restrictions are tightened with current ones by
`tightenActionsSettingsV1`), `readApprovalOwner` (`'receiver'` when a receiving signed root owns the
Ask, e.g. original CLI finite Project admission) and `readSettingsDeclarationOperation` (an installed
Settings declaration's operation, classified like the built-ins).

In 0.3 development, signed-root CLI requests with live-only input custody return
the executor's persisted approval receipt before the person decides. The daemon
retains the original private input and blocking invocation until decision or
shutdown; closing the acknowledged terminal request does not withdraw it.
Disconnecting before that receipt still cancels the request. Actions whose
results also require live custody keep their original blocking response.

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
In 0.3 development, page-level Browser control commands (navigation, history,
reload, stop, viewport and target changes) do not require a locator observation:
an intervening page change cannot invalidate their operands. The input owner still
enforces human control, confidentiality, settled effects and fresh observation after
hand back. DOM and coordinate automation retain their observation requirement.
Already-cancelled Browser commands, including controller transitions, return a
known no-effect failure before reaching control or CDP effects.

In 0.3 development, a trusted present person's own UI interaction supplies their
admission. Account Ask settings and approval-profile Ask or Require do not create
a self-approval request. Explicit Ask-on-UI preferences use native confirmation.
The Action's designed local confirmation and
host-discovered consequences still apply, including irreversible effects unless
the declaration chooses direct execution. Agent, Session, plugin and other-person
requests retain their approval policy. Home's signed admission preserves the
person's original UI invocation at the receiving executor. The executor owns its
confirmation host; a caller must not put another yes/no dialog or two-step button before the same Action.
Dialogs that collect a different scope, choose recovery after a refusal, or discard an unsent
local draft remain separate decisions.

For a confirmed live-only plugin Action on a mounted page, the receiving
Machine keeps the invocation active while its admitted Before checks run and
records their outcome on the existing receipt. A detached native confirmation
from an older development build cannot be approved from the Inbox. Retry the
Action from its mounted page.

For plugin installation in unreleased 0.3, the native confirmation and approval
Artifact paths carry the accepted daemon candidate through the same host-only
approved replay context. Plugin administration consumes that exact review rather
than preparing another change or rereading the approval Artifact at dispatch.
Native confirmation does not create an approval Artifact.

Unreleased 0.3 approval records preserve a signed ordinary Account automation
caller's descriptive `requestedSurface` (for example, MCP), even when its
immutable execution origin uses the host's UI/CLI representation. That label
selects caller-facing presentation; it does not confer present-user authority,
direct confirmation or replay consent. The strict origin retains the signed
Home, Account, request, target and input proof. Unsigned surface contradictions,
present-user relabeling and substituted targets remain invalid.

In unreleased 0.3 source, Action confirmation presentation has two independent
declaration fields. `confirmVerb` is a short literal phrase or the existing
localized-string shape `{ key, fallback }`; omission uses the host's localized
“Approve”. `irreversible: true` declares that the effect cannot be undone;
omission is not irreversible. The confirmation button and its destructive note
read that fact directly, never infer it from `sideEffectClass` or
`approvalPolicy.uiConfirmation`. `confirmVerb` changes presentation only. An
irreversible declaration retains the local UI confirmation unless the declaration
explicitly chooses direct UI execution. These fields do not change who may approve or
override execution authority. Plugin Action
declarations and the strict daemon Action projection carry the same optional
fields, resolving plugin keys through the plugin's admitted translation bundle.

An actual completed host confirmation can supply `presentUserConfirmation` for that exact
Action on UI or CLI; opening a form or pressing its ordinary submit button is not a completed
policy confirmation. A trusted person's direct UI submit answers the automation
default, while declared product reviews and contextual host preflight reviews remain.
Explicit per-surface Ask settings still apply to automation and other-person
requests, and waivers suppress the default for waivable Actions. Automation Runs
invoke their Action on the `agent` surface with `account_automation` authority and an
`automationRun` caller, the same surface as workflow steps (owner decision,
2026-11-15), so they follow Agent approval routing. A CLI approval prompt decides
only when a person is at an interactive terminal; otherwise the request stays open
for another surface to decide. The person's own
UI interaction retains the designed confirmation without a self-approval request.
Contextual safety uses that same policy; it does not grant execution authority. The executor supplies contextual safety
after input admission, never from a caller's assertion that a target is private.

In unreleased 0.3, an exact witnessed `workflow.run.start` approval can retain
its reviewed child Action ids and materialized inputs in the Run's private
`approvedOperation` accepted-snapshot field. The existing Run owner prepares
this value before sealing; ordinary starts and new-Run replay do not inherit
another Run's consent. The shared preparation seam for composite and CI producers
is `prepareWorkflowApprovedOperationSnapshot`; it stores no Actions Settings waiver.
Live-only, confidential or unsupported deferred inputs retain ordinary child approval.
Contributed Actions can retain exact reviewed operands when the accepted leaf's
frozen declaration includes its confidential input paths and the operand contains
no confidential values. Older snapshots without those declaration facts retain
ordinary child approval. The Run admission reader matches the accepted invocation
and approver Account before lending its consent through the same child issuer.
An authored producer-result reference can instead retain its block id, scope and
field path in that private snapshot. At child admission, the existing Workflow
owner resolves it from a completed invocation in the same Run and compares the
entire concrete semantic input before normal Action preparation. A missing result,
different Run or changed operand supplies no approval; the stored reference alone
never authorizes a variable input.

Host-reviewed children in unreleased 0.3 use one in-process issuer at the Action
executor. Host-local declarations may be static or select demanded children from
the parent's already-normalized input; only their closed resolved plan enters
the private review, never the selector or declaration itself. Prompt saves declare
their exact folder creation when requested, and Session Delete declares its exact
Stop target through this same preparation owner. The parent prepares the exact demanded Actions, roles, normalized
inputs; the Machine target comes from that input through ordinary Action routing,
not a second placement tuple. Their explicit Require choices
are folded into the parent's review. The admitted parent exposes a private
`hostReviewedChild` invocation port, which admits only an unambiguous exact match
against the declared plan. Deployment roles whose concrete operand is produced
by receipt admission declare their Action and role first; their existing domain
owner supplies the concrete input after admission. Prepared dispatch does not reread the
parent's policy. A parent demanding a default-Ask child must itself default to Ask,
and its review must show that demanded child. The private review preview retains
the role, Action and normalized input containing its target Machine. Deployment receipt admission is a domain
adapter into this issuer, not another proof owner.

An unreleased 0.3 host declaration can identify explicit runtime work with
`machineRuntimeDemandForInput`. The generic preparation owner passes its exact
Session or Machine target to the host's existing reviewed-child preparation;
passive observation and unresolved group selectors do not imply one Machine's
runtime demand. Host preparation may return children plus an invocation-private
`executeAdmittedAction` closure capturing its exact resolved target and operand;
only children enter the serialized review plan. The executor calls that closure
after approval and binding the original `hostReviewedChild` port, before operation
or effect dispatch. Its `execute(context)` continuation retains the same admitted
facts and child port; an already-admitted child does not discover fresh wake
demand. The continuation's optional prepared Machine target is retained as the
host-private `admittedMachineTarget`, not as a replacement for a signed Session
target or caller defaults. Existing Run exact-target routing refuses a moved
Session; Resume compares at its fresh Home-scoped target owner before transport,
instead of silently selecting the new Machine or moving the Session back.
Default and enqueued Send declare `activation: 'accepted-input'`: admission still
reviews their paid-wake child, but their accepted-input owner invokes it only after
enqueue/ACK for local delivery. Forwarding any Send through the public Action
transport requires the guest runtime before input can be accepted, so the shared
runtime-demand projection enters Home's existing managed wake before dispatch.
Explicit `requestedAction.kind: 'send_now'` also declares finite runtime demand
for local publisher delivery. The port's
`preparedChildren` projects concrete prepared facts;
only its existing exact-plan `invoke` grants child consent. These are in-process
contracts, never transported authority.

Managed Create's enrollment identity declares its demanded isolation children.
The original Account dispatcher carries an admitted parent through its existing
private requester invocation; controller dispatch retains the existing creation
codec. At the receiving managed adapter, the admitted Home and controller bind
the normalized Create, and the same child port matches its declared plan before
issuing child consent. An undeclared child retains ordinary Action approval.
The managed continuation alone is not a confirmation. These are unreleased 0.3
private host carriers, with no new credential or persisted approval format.

The same issuer can carry an admitted child's value-free Action, role and exact
input digest through the existing requester HTTP signer or Machine RPC source-execution signer. The installed signature
binds that projection together with the unchanged root and exact HTTP operands;
it is not another credential or an independently issuable approval. Home resolves
the domain's admitted-job scope once and passes its typed result to route
consumers. For a copied Environment, that scope is the Environment allocated by
the original create request key, not any Environment the Account can otherwise
manage. Catalog Domain children use that allocated Environment relation and
ordinary Domain admission; the root remains the original create. A native Publish
child likewise retains the original Publish root and exact prepared Deploy operand,
while its receiving Machine supplies ordinary target admission. Absent child
projections retain the existing signature format.

A person-confirmed operation can also retain its normalized parent projection
for trusted internal domain continuations through the same issuer. Dynamic plugin
`actions.execute` calls supply their concrete Action and input at invocation; they
need no predeclared child list or separate per-step policy read. The projection
is data, not a credential or transported proof. Original Account, requester and
custody admission remain authoritative. Saved triggers do not acquire this
person-confirmed continuation and still honor current child Require settings.
Contributed inputs retain their ordinary `action.invoke` envelope, including
scalar and omitted operands. The existing target owner normalizes the operand
before dispatch; the parent's consent matches that invocation's semantic input,
not a second operation inferred from declaration-produced defaults.

A reviewed Service Move keeps its original SOURCE envelope and requester when
invoking a physical receiving worker. That worker independently admits custody
and per-member placement before issuing its exact child continuation and entering
the existing child review. This continuation supplies neither a new local grant
nor a rewritten root Machine identity; ordinary native authorization and domain
revision checks still apply.

In development 0.3, an original host Service Stop Ask stays with the original
Account key-holder. Human CLI approval delivers the exact reviewed Stop through
the existing signed credential-free native carrier. The original Account keeps
the approval Artifact; replay does not disclose its sign-in or send a generic
`approval.request.decide` to the Service's Machine. Already signed native
approvals keep their originating Machine custody.

Development trigger saves can opt into exact-input consent with
`workflow.trigger.add { actionApproval: 'automatic', ... }` or the same choice
in a selected trigger's update patch. The host materializes the child inputs
and uses `prepareWorkflowApprovedOperation`; callers cannot supply the proof.
The existing private Automation definition stores `actionApprovals` keyed by
trigger id, and an authenticated occurrence retains that operation in its
accepted Run. The receiver reopens that selected enabled trigger before using
the existing exact Action/input comparison. A changed command or Action,
withdrawn consent, or stricter current Ask policy follows ordinary approval.
Choosing `ask` or disabling the trigger removes its saved consent. This writes
no Action preference and introduces no grant table. A saved Workflow can
authorize its declared native `workflow.trigger.add` step to add an enabled
once schedule to itself. The step pins the Workflow and project, and an
earlier step in the same accepted Run supplies the schedule. A different
step or Workflow, an edited declaration, or a recurring result needs ordinary
approval. Action-event checks can retain
structured `trigger_event` bindings for JSON stdin and declared environment values.
The saved operation pins the field structure, literal values and command operands;
the private Run reader resolves the variable fields from that accepted Run's Event
payload and matches the concrete invocation. Event values never become command
text or executable arguments. Deployment triggers use that
same `actionApproval` choice and record a `deployment_sha` binding: only the
commit SHA and invocation request key vary; the authored Home, Environment,
target link, source selectors, source method and busy behavior remain exact.
An Environment edit, including changing protection to Production, does not
withdraw this saved choice. Domain admission still validates the actual deploy.
The stored reader translates the former development-only deployment consent
record into the same operation using its original person proof and saved
program. It neither reads nor compares an Environment-content basis; new saves
write only `actionApprovals`.

Development API-token deployment consent is the optional
`ApiTokenGrantV1.deployApproval: 'automatic'` choice on an exact single-Environment
grant for `deployments.deploy` and `action.operations.get`, with no approval,
creation, Session or Machine grant. Direct grant authoring and deployment
authoring both use the existing person/approval-decider proof owner before
storage. The shared policy reads this choice after explicit Require; absence
uses ordinary approval policy. It does not reopen a token consent record or
read Environment content, and Production changes do not renew consent.

The receiving Action executor reopens the admitted Run and its exact invocation
at preparation and dispatch. Only an exact Action/input match supplies consent;
independent authority checks always apply. Ordinary stored consent still honors
current explicit Ask policy. For a person-reviewed Run, the fresh canonical Run admission
can instead resume its exact demanded child through the same host issuer,
without a second Ask. That invocation-scoped continuation is never stored or
transported with the consent object. Saved-trigger admission uses the same
issuer without a folded review, so its current explicit Require still applies.
The child's original Home-bound authorization and credential ceiling stay intact,
rather than borrowing the Setup parent's grant.
Missing, revoked, unreadable or mode-inconsistent evidence restores ordinary
approval policy. Existing Run access and plain/E2EE envelopes own disclosure;
this field grants no read access and is never public Action input or a
transported bypass. Same-Run reload retains the stored evidence without replaying
settled children. A current installed Run publisher can dispatch a reviewed
managed-Machine child to another Machine of the same Account only when Home
can open that Run's stored approval and match the exact Action/input, including
the receiving `machineId`. Home binds the execution authorization to that
receiver's installation; the publisher never signs as the receiver. The daemon
still applies its own exact-match/current-policy admission on the Agent surface.
Team-shared targets, unreadable evidence and retired publishers do not acquire
this cross-Machine authority; the incumbent assigned-host behavior is unchanged.

In 0.3 development, `workflow.trigger.add`, `workflow.trigger.update` and
`workflow.trigger.remove` use the shared dangerous-Action approval default on
Agent/MCP. Persisted surface waivers suppress approval, explicit Ask-first wins,
and a host's resolved policy is consumed once. Agent add/update also needs the
materialized `trigger_write` policy check; approval never supplies that authority.
The host-stamped approved continuation executes under that original request rather
than creating a second approval.

In unreleased 0.3, a committed trigger write returns its saved set revision
and the selected trigger revision when present. A failed follow-up appears in
the optional `postWriteFailure` Action failure envelope on that receipt.
A projection failure can leave the set's private details unavailable. A failed
Channels binding change leaves the saved trigger revision available for recovery.
The receipt carries the binding Action’s typed refusal when available. An
unclassified binding exception returns a generic Action failure. The CLI's
Account executor uses its contributed Action dispatcher for automatic PR
attachment. An uncoded attachment exception records the request ID, redacted
message and top frame in the executing CLI or daemon's local file log.
Older strict 0.3 readers require matching source for this result field.

Development FIN placement: `workflow.trigger.*` Actions own Account trigger data,
including triggers attached to a Session. Every Account host composes the one
Protocol trigger owner through `createAccountWorkflowTriggerActions` (CLI with its
credentials, the UI front door with its captured Account), so Account-owned trigger data
does not require a reachable Machine. Host-dependent facts do reach a Machine:
another caller's write (agent-start policy and materializer) is relayed to the
authorized host, and Keep going on an opened Session reads native-goal ownership over
that Session's `session.goal.get`. An unreachable host yields typed `target_unavailable`
when native Goal ownership cannot be established. After the Goal-only read
settles with no native owner, Keep going admission uses a separate non-waiting
read for the live runtime's selected-surface Role-policy result when needed.
A proven workspace-write refusal returns `role_policy_unenforceable` before the
trigger is added. An undecidable or omitted Role-policy result allows arming
once ordinary Session admission succeeds. The same Role-policy decision protects
the later Run start.

Before and After Action filters reference only the closed occurrence evidence.
Terminal outcome fields apply to After Actions. Raw Action input and output
are unavailable in both phases. Trigger add and update report an invalid
condition at the field pointer and name the fields available in its phase.

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
must not fabricate an empty link list. Removing a trigger or its set disables
scoped conversation ingress for bindings created automatically by Save while
preserving the Session's PR link. Explicit attachments and older bindings
without a recorded origin keep their existing state. Channels uses the current
Session-scoped Workflow trigger list to verify that each automatic binding's
creating trigger is gone before disabling it. A failed detach after deletion
appears in the committed receipt's `postWriteFailure`.

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
replayable CLI invocations also return `approval_request_created` with the Artifact id before exiting;
they do not silently retain the daemon HTTP request while waiting for a human decision.
Explicit `approval.request.create` uses the same surface and custody policy for its
target Action; an ordinary CLI/UI proposal can therefore execute after the requesting
invocation ends. Live-only input remains ineligible for explicit durable creation,
and live-only results reach the deciding person through deferred execution.
The operation has not executed when that result returns. In development source,
the mounted experimental Provider-model confirmation retains its exact invocation
through the existing blocking approval owner. Changing its Agent target, Home,
Account or Providers feature while approval is pending retires that intent. A later
Inbox approval cannot replay the retired field intent; the canonical executor
returns `approval_stale`. The shared approval policy still owns waivers, and a
successful live approval writes the confirmation once.

Ordinary approved results stay schema-complete in the private approval Artifact.
Durable Session/MCP proposals return deferred approval custody, and their caller
can read the settled private receipt. In 0.3 development, terminal deferred
Agent/MCP approvals with a Session caller outside Discussion reply settlement
deliver an observation-safe result to that original Session through existing host input admission, allowing an
ended turn to continue. The originating Account owns this delivery; standalone
CLI clients delegate publication to its origin daemon. A scoped execution proof
does not authorize the additional input. Result input
carries Account automation's default permission ceiling and no human permission
intent. Existing input identity joins repeated delivery attempts; an unavailable
input target returns its typed refusal while the execution receipt stays recorded.
Accepted or nested-approval acknowledgements do not publish a terminal result.
Public approval reads,
decisions and Action observations independently apply the Action's observation
projection; those redacted views are not caller receipts. This is a 0.3
development contract, not a claim about released availability.

In 0.3 development, a fresh deferred live-only result reaches the authenticated
deciding human through both direct approval execution and exact-daemon replay.
The shared decision-result owner selects that custody once. Repeated decisions
and recorded reads retain the observation projection; a receipt-only CLI caller
receives `approval_result_held` rather than an incomplete authentication result.
All callers of the shared UI approval continuation receive
`approval_result_held` in place of `invalid_action_output` when a live-only
Action ran successfully and its recorded observation cannot satisfy the Action
output schema. The continuation can still
return an existing schema-valid observation, such as an `awaitingManual` status
and attempt id. Voice treats `approval_result_held` as an executed operation
whose result stayed with the approving person and tells the agent to avoid
repeating the operation.

The result-custody exception is `approvalResultCustody: 'live_only'`: its raw result
must never become durable Artifact custody. An original present-user invocation
retains blocking result custody; an automated request with durable input defers
the result to the deciding person. Explicit proposal creation also defers because
it has no target invocation to retain. Each such row declares a required result
and a safe observation projection, which the spec schema enforces. Examples include:

- `teams.credentials.externalKeys.create`. Its result is `{ token, key }`. The bearer token
  reaches only the live caller, and the observation projection keeps just the non-secret `key`
  summary for the artifact.
- `account.apiTokens.create`. The API token is shown once and stored only as a digest, so like
  the external key it stays on the admitted invocation and never enters approval history.
  In current 0.3 development, creating a PAT is a human-only UI action.
  Agent/MCP creation, including Session-origin requests, is refused as
  `action_disabled` before approval or execution, so a new bearer never enters
  an agent flow. Agents/MCP may request PAT revocation through the normal
  approval card; the effect runs after the person approves. The creating
  person's live UI invocation receives the once-shown bearer, while approval
  history, observers and repeated decisions retain only the non-secret summary.
- `plugin.webhook.endpoint.ensure`. In 0.3 development, Agent/MCP can request endpoint
  setup as a person-class Action with a user-waivable approval default; a waived
  automated request runs directly and retains its intentional live result. A
  detached approval's deciding human can receive the fresh `liveExecution`.
  The live result can contain `oneTimeGeneratedSecret` and a capability URL.
  Observers, Session transcripts, approval history and repeat decisions retain
  endpoint metadata without the public URL or one-time secret.
  `plugin.webhook.endpoint.read` also keeps present-user authority and live-only
  result custody: its live URL is available to the caller, while retained
  observations contain endpoint metadata only.
  Plugin-provenance-only correspondence and target convergence are not Agent/MCP
  operations. Existing direct setup retains its live result; lost disclosure uses
  the existing Webhooks credential-rotation flow, not another endpoint or secret store.

For a present-user invocation, these rows retain the blocking result rather than
durable raw-result custody. Agent/MCP requests with durable input remain deferred and
return their Artifact reference; only the deciding human receives fresh live custody.
Private-input requests still retain their original invocation. In 0.3 development,
a successful approved effect returns `approval_result_held` to an automated caller
without live-result custody; the Artifact keeps the observation-safe execution receipt.
Obtaining a fresh live result uses the feature's existing retry or credential-rotation flow.
If the live invocation is lost, the secret is intentionally unrecoverable: revoke or
rotate it through the existing credential owner.

Public `approval.request.get` output omits signed execution authorizations,
signed-input proofs and original invocation envelopes. CLI, MCP, Agent and UI
Action reads share that projection; generic Artifact Actions reject approval
documents as internal. Authenticated Account/terminal Artifact storage remains
the private replay transport. Direct API-token and restricted Session-runner
credentials cannot use that raw transport. A keyholder who deliberately exports
or grants access to a private Artifact can still disclose its raw contents.

Signed HTTP requests in 0.3 development carry the existing execution authorization,
Machine signature, target and optional child proofs in a closed V1 JSON frame
(an installed controller's managed-policy proof, which embeds the original Action
authorization, uses the same frame as its only member),
identified by `x-happier-action-body: v1` for mutations. Signed GET reads use POST
at the original URL with `x-happier-action-body: get-v1` and the same frame without
a logical body. Home derives these read routes from the original GET routes,
preserving their scoped hooks, schema and handler; a routing constraint separates
them from ordinary POST operations at the same URL. The credential HTTP serializer moves
these proofs out of headers; Home unwraps the frame before route schema validation
and authenticates the original method, path and body with the existing verifier.
Unknown frame members and simultaneous proof headers are refused. The frame is
transport framing, not a new credential, admission or Action input version.
Unframed requests retain the existing verifier. Both CLI
and Home must load this development transport change before sending framed
requests; an older Home refuses the frame rather than accepting weaker proof.
A managed-policy proof binds the installed controller, custodian, managed row,
intent revision, purpose, and HTTP request. Full rows also bind the native
resource digest. For sealed presets, Home verifies the structural proof and the
installed controller opens the sealed resource. The controller keeps provider
coordinates and credentials inside the preset content.
Read proof bodies cannot follow a cross-origin redirect, under the same credential
redirect policy as signed mutation bodies. Header and body parser limits are unchanged.

The execution authorization has no fixed expiry. Approval settlement does not
invalidate its signature: spending it also requires the exact Machine signature,
current credentials and current source authority. The approval execution claim
prevents a repeated decision from executing the effect twice. An authorization
copied from a transcript alone cannot supply that Machine proof.

`approvalInputCustody: 'live_only'` is the input-side sibling, used for credential-bearing input
such as passwords. The artifact carries only the declared input projection from creation, and a
replay without the live invocation fails closed. CLI rows with either live-only custody declaration
retain their blocking invocation; Agent and MCP blocking callers are unchanged.
In 0.3 development, lost private invocation custody uses `approval_origin_unavailable`,
with reason `live_invocation_unavailable`, for both built-in and target Actions. Actual
subject or currentness changes retain `approval_stale`. Deciding a target request whose
live input invocation has ended settles its Artifact as `failed`
and `effectAttempted: false`. The Approve Action returns that typed refusal, including
on repeat decisions; the requester and Inbox can read the same terminal receipt.
Re-run the original Action to supply fresh live inputs. An attached caller instead
executes once with its retained input and receives its terminal result. Approval
history never acquires the omitted inputs, and durable-input replay is unchanged.

The development personal Saved Secret `secrets.create` and `secrets.update`
Actions use this live-only input custody when carrying a value or source. Their observation
projection omits both. The same Actions link an external vault descriptor through
the existing resource writer, using `source` instead of `value`; updates retain
the resource identity and revision line. The CLI accepts the external descriptor
with `--source-json` and does not prompt for a scalar value. External resources
remain personal: creating them with recipients, promoting them, or adding grants
is refused with `recipient_mode_unsupported` by the client for E2EE and the Home
for Plain content. Present-user UI writes act directly, while Agent,
CLI and MCP writes ask through the shared spec-owned policy. `secrets.list`
returns owned resource metadata only, including `secretRef`, the canonical reference
for binding consumers. A Deployment secret source uses that `secretRef` and
`updatedAt` as its `resourceRevision`; `secretId` remains the lifecycle operand
for update/delete and is not a binding reference. Create also returns the canonical
resource ref.
Supplying `secretId` to `secrets.list` selects one resource and includes `usedBy`,
the existing value-free Saved Secret reference census (`owner`, diagnostic `path`,
and optional owner-supplied `referrer: { kind, id, displayName? }`). Ordinary lists
do not run a census. `usedBy: null` means complete reference coverage is unavailable;
an empty array means the census found no references. The app reads held Account
Settings and catalog metadata, without fetching or polling; the CLI reuses the
existing delete preparation. Paths are diagnostic, never names or navigation ids.
The `updatedAt`/`expectedUpdatedAt` fields on these Actions are aliases for the
private resource's revision concurrency token, not wall-clock timestamps.
The existing encrypted/plain private-resource mutation owner remains the writer;
these Actions do not recreate the retired Account Settings secret writer.

The 0.3 development `secrets.shared.repair` Action exposes the Saved Secret
editor's **Finish sharing** recovery to UI, Agent and MCP callers. Its closed
input names only the resource and exact revision; its closed result reports
`complete` or `incomplete` with that identity and revision. The answering app
uses the existing Account encryption and recipient-envelope repair owner to
prepare only owed envelopes for the already-approved audience. Neither values,
data keys nor envelopes enter the public Action input or result. The existing
recipient-readiness view explains incomplete recovery. Automatic custody sweeps
and repair after approved writes remain internal owner maintenance.

The 0.3 development `secrets.shared.reveal` Action is a narrower client-only
person operation: exact shared reference/revision input, resource-management
admission, and a value-free displayed/hidden/cancelled result. The value is shown
only in the person's app and never returned to any caller. Agent and MCP callers
may request it as an ordinary default-Ask Action (owner ruling 2026-10-29): the
request creates a value-free approval Artifact, agents cannot answer their own
request, and the person's Allow replays it once in the approving app as that
person's own display. The requester and the Artifact receive only the value-free
outcome; a person may change the default to Allow per surface. CLI, RPC, Voice,
API-token and plugin surfaces are not offered it. Its mounted app controller owns transient display custody. Explicit Copy
is a gesture/result on that disclosure's metadata entry, not a second Action or an
automatic side effect. After an Allow the approving app opens a sheet holding the
same shared value row; the Allow is the only confirmation, and closing the sheet
before the value opens settles `cancelled`. This is 0.3 development behavior, not
a claim of released availability.

In 0.3 development, the Saved Secret page's two value-free reads are also
Actions for UI, Agent and MCP callers (not CLI, RPC or Voice):
`secrets.shared.disclosures.list { resourceId, cursor? }` pages the disclosure
history (who, when, which reference and revision, reveal and copy outcome) and
`secrets.shared.recipients.list { resourceId }` returns the envelope census as
recipient account, readiness or its unavailable reason, and envelope status,
with content keys and fingerprints removed. Both are safe, client-placed reads
with no default Ask: the answering app runs the same reader its screen mounts
with its own Home request, so the Home's owner-only admission decides both, and
a refusal arrives as its typed code. Neither returns a value, data key or
envelope; preparing envelopes stays with `secrets.shared.repair`.

In 0.3 development, `resolveApprovalExecutor` is the single replay-location owner,
exported through the existing `approvals/approvalRequestV1` entry point. It reads
the stored request and the Action's input-aware placement. Account and client
effects run in the approving app, regardless of the requesting surface or signed
carrier; Machine and Session effects with captured daemon custody run on that
Machine's daemon. A direct unsigned present-user UI Ask can have no originating
Machine. It then re-enters the built-in app adapter after approval, which sends
the effect to the Machine or Session selected by the reviewed operands. This
does not relocate signed or automated origins, private inputs or retained live
invocations.
Native Deploy, Rollback, Promote, Teardown, Domain add/remove/verify and unprepared
target Link roots return to their retained controller Machine. Domain add/remove replay uses
that host's operation acceptance; a missing acceptance or request identity keeps
`operation_unavailable` and names the missing fact in the stored execution error.

In 0.3 development, Rollback follows the same interactive review policy as
Promote. The controller shows the retained version, the version currently on
the target, and the effect on data. On an own-server rollback with a selected
pre-migration backup, confirmation authorizes replacing data from that backup.
When the UI confirms a review returned by the controller, the receiver rebuilds
it and compares the full review digest before admitting the effect. Approval
requests use the fixed prepared input, including when approved from the app,
the CLI prompt, or CLI `--approve`. Agent requests follow the Account's approval
policy and use the same prepared input under automatic approval. Preparation
pins the content Artifact and checks it when reopened. Home's receipt writer
checks the Environment and target-link revisions, the serving link, and the
Artifact and rollback operands on replay.

Failed approval executions also retain a validated, code-only cause and any
producer-authored `effectAttempted` value through settlement, public reads and CLI JSON.
An older execution without those diagnostics remains readable; a bare transport
refusal does not establish whether an effect was attempted.
Project Open retains its finite refusal details, including retry timing and
remediation, in approval and operation reads. Its materializer supplies the
effect boundary: a refusal before cloning records `false`; a known checkout
failure after cloning records `true`.
Native Domain failures name the failed native step and any known required fact.
The approved execution retains the existing host operation address, so the
person can read that operation's failure receipt after the call returns.
An implicit CLI Environment create with no daemon for its Account and Home
refuses before dispatch with `daemon_unavailable`, the configured Machine and
the `--machine-id` remedy. An explicit target uses the existing placement owner.
A Link with prepared content keeps its
Account executor. Public approval reads omit private signed authorization;
the retained Machine target still selects that daemon, which recovers replay
authorization from the original private Artifact before the effect.
Link preparation refusals retain their error code and add the failed step and a
closed reason to the stored execution error, excluding response bodies and keys.
At issuance, Home captures the Link's admitted Environment and its Account or
Team owner in the signed binding. Both preparation reads spend those facts:
target inventory is confined to that owner, and Environment get and the Link
mutation to that exact Environment on the bound Home. The purpose owner compares
the signed facts
without another Environment lookup per read; ordinary resource access remains
enforced by the receiving routes. Encrypted Link input exposes only its
Environment routing id, which the opener verifies against the sealed input.

In unreleased 0.3 source, `projects.readiness.read` binds its exact saved Project,
controller Machine and selected Environment revisions through the existing finite
read admission. Home admits Project access and selected Environment content at
issuance. Signed Project, Environment, Domain and content reads then spend that
scope through the existing custody readers. The encrypted request opener rejects
a different Project, controller or Environment selection. An empty Environment
selection still permits the Project's CI and security source facts; it does not
require a checkout or create a Session.

Session-authored Discussion publication retains its Session publisher. A client
effect with no available client port returns unavailable rather than moving to a
daemon. Private input, show-once results and explicitly retained host closures
stay with the original live invocation. Confidential fills use the person's live
value or Saved Secret choice. Missing live custody cannot become durable replay.
Retained native plugin Discussion publications follow the matching-successor
contract in [Approval is decided in one place](#approval-is-decided-in-one-place).
Retirement alone does not cancel those person decisions. Attachment-bearing
publications still need a fresh Ask with the successor's local file sources;
other live-only requests do not acquire successor custody through this exception.
For a daemon-owned live invocation the result includes `daemonMachineId`; clients
relay consent there without reconstructing the effect. Background plugin hosts
record their stamped Machine in the existing execution-origin target before
projecting away live materialization context. This routes a Channels Discussion
publication decision to its original daemon waiter, including retained file
inputs. A contextual Machine on an app plugin does not select a daemon.
Otherwise the original app closure or the standalone terminal's published address
owns the continuation.

CLI and UI adapters dispatch this answer and retain ordinary execution admission,
requester/credential checks, the execution claim and terminal receipt. Location
does not grant authority. Signed provenance remains unchanged on the Artifact,
and app-owned effects use the approving person's authenticated Home adapter.
New durable approvals use deferred flow; private or explicitly retained
invocations use blocking flow. Legacy V1 history stays readable and cannot be
reconstructed as a current executable origin.

In 0.3 development, plugin `discussion.post` and `discussion.reply` retain the
original invocation through approval and native settlement, including text-only
publications. Channels keeps the ingress attempt while that decision is pending;
approval resumes the same publication instead of creating another request.
An explicit rejection or cancellation settles that ingress as rejected with
`targetUnavailable` attention and no next due time. The approval Artifact keeps
the exact decision. Review that decision and repair the target or approval policy
before submitting a new input; a terminal refused input is not replayed.

In 0.3 development, approval Artifact bodies are private replay custody. A signed
external request retains `executionOriginV1.externalActionExecutionAuthorization`
and its input signature where required; the Home authorization is bound to the
original request and requires the selected Machine's signature and current Home
admission. It is not an Account login bearer. Installation-sealed requester
context, when present, remains private custody on that carrier.
The origin also retains the signed original envelope exactly when daemon ingress
admitted that same root with it; the origin producer keeps no second list of
roots. Replay therefore reopens the root for its reviewed children, such as a
Session spawn's setup and Agent readiness children, as the live invocation did.

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
intent. In 0.3 development, a matching Before Automation uses the existing `plugin_target_action`
continuation to record its checks before executing the mounted Action. A UI or Voice request
without required confirmation fails closed
with `plugin_action_current_intent_unavailable`, so a settings skew between UI and daemon refuses
rather than executes when approval is required. An explicit waiver is carried as `false`, not
absence: it overrides the non-safe/declared-confirmation default without changing the Action's
danger metadata. Explicit Ask-first remains required even for safe Actions; missing settings use
the manifest default and a failed settings read cannot waive approval. Catalog policy delegates
to that same requirement rule, with no trusted invocation surface inferred from a catalog read.
Agent, MCP, CLI, public API and automation ingresses use durable `plugin_target_action`
artifacts for their approval requests.

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
them. On the transition into a settled state (`rejected`, `canceled`, `executed`, `outcome_unknown` or `failed`, which
includes a failure before execution), they are replaced by the Action's own
`projectObservationInput`, never by caller-authored arguments. One owner decides this:
`packages/protocol/src/approvals/approvalRequestTransition.ts` (`decideApprovalRequestTransition`,
`settleApprovalRequestActionArgs`). Both artifact writers consume it, the CLI/daemon approval store
and the UI approval writer, and each commits with the revision it read. Only the winner of
`approved -> executing` performs the effect.

In 0.3 development, a producer's definitive pre-dispatch refusal can settle the
approved request as `failed`, preserving its typed reason and
`execution.effectAttempted: false`. The refusing producer carries that proof as
the strict Action failure's optional `effectAttempted: false`, including a
refusal returned across replay RPC. The deciding executor never infers it from
a reason-code list. The V2 settlement preserves producer `true` and `false`;
entering replay transport alone supplies neither. The claiming executor settles
an uncertain effect as `outcome_unknown` and omits `effectAttempted` when the
producer supplied no evidence. A deciding client that loses an exact-daemon
replay reply only observes the executor's receipt; it preserves approved inputs
while daemon admission is pending and never writes a competing terminal outcome.
Recovery and Workspace readback retain
that uncertainty without inventing a value. The existing V1 projection is unchanged.
A transport's explicit not-sent evidence still permits pre-dispatch
settlement. An already persisted execution receipt wins over a transport error.
The same settlement writer, input projection and Artifact CAS own both outcomes;
blocking waiters, public Action reads and mounted continuations consume the
terminal receipt. Repeating Approve returns that receipt and starts no effect.
Failure settlement also retains the lifecycle status its owner observed. The
shared transition writer checks that basis before its existing revision CAS,
so a pre-dispatch refusal cannot overwrite an execution claim that won meanwhile.
For a refused transition or revision CAS, the host writer also reports
`writeCommitted: false` on its private result. An identical executing body is
then another owner's claim, not proof that this invocation lost a successful
claim acknowledgement. This fact is neither stored nor added to a public Action
envelope; an absent fact retains the existing acknowledgement uncertainty.

An exact-daemon replay restores the signed requester's private ports before
claiming execution. If its Home is unavailable during preparation, the replay
returns the typed failure with `effectAttempted: false` and leaves the consent
unclaimed. The existing Artifact transition still selects a single executor.

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

In 0.3 development, immediate Action failures and failed operation observations
retain their error message alongside the typed code through completion, Workflow
invocation settlement and approval replay. Setup retains the native `mode_none`
refusal for disabled Machine administrator policy, with a readable reason and
recovery step. This refusal does not describe Account encryption access;
approval does not enable administrator access or change the Machine's policy.

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

Set `includeExecutionRunProfiles: true` on `review.engines.list` to read
`executionRunProfiles` from the same Machine profile catalog as the launcher.
Each descriptor carries its full declared `optionsSchema` and any
`optionsInputHints`. The hints identify the controls the launcher renders.

Detached `review.start` uses `target:{kind:'detached'}` and omits `sessionId`;
the discovery selector's explicit null is not a valid start input. Its declared
`cwd` uses the existing Execution Run working-directory schema. The captured
Machine context's Project directory takes precedence when present; otherwise
the authored detached `cwd` reaches the Run's top-level working location, not
only its review intent payload. This keeps a checkout review from starting in
the daemon's default directory.

In 0.3 development, the UI and CLI send `review.start` to the selected
Machine's requester daemon. An attached start uses the selected Session's
Machine, and a detached start uses the captured Machine selection. The Home uses
the same requester-owned work admission as Session start, including Machine
**Can use** grants. The daemon admits and settles the parent Review Action, so
its private After hook receives
the captured PR head and Review round from that settlement. On a shared
Machine the installed plugin runtime receives the receipt only when it serves
the invoking Account.

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
The target's `RpcHandlerManager` owns the native acknowledgement: cancellation
signals the handler, while the handler's settled success or failure is encoded
and acknowledged even if cancellation arrived during execution, encoding or
cleanup. Machine, Session and ephemeral receivers share this owner. The Home
retires a departed HTTP caller's wait; that connection cannot receive a late
reply. `waitForResultOnCancel: true` retains the existing cooperative wait for
callers that can still receive the result. Native deployment callers recover a
lost reply from their existing Action operation, without repeating the effect.
Cancellation cannot erase a settled result or retract bytes already emitted.

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

In unreleased 0.3 source, when `scm.pullRequest.openOrReuse` opens or reuses a
GitHub PR and the Session link cannot be confirmed, the Action returns
`effect_applied_with_warning` with the existing PR and the link refusal. The
remaining operation is attaching that PR to the Session. Channels creates or
rejoins the repository's polling connection during attachment. If the provider's
connection test refuses, the warning gives the recovery step and the request ID
recorded in the Channels log. The person can then attach the existing PR.

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

The phone-preview tools panel, viewer menu, Hide/Show controls and offered stream
Retry publish through the same mounted inventory. Header and sideband Close use
the same tools callback; Retry uses the existing relay lifecycle and is absent
while the tools panel hides the stream.

Home Customize, widget-area Organize and Project widget Expand/Collapse also
publish through this command owner. They use the human controls' same callbacks
and remain local to the mounted layout and viewer, without a persistence write.
The AppShell composes these host controls with a plugin page's authored commands
in its existing current record. Unmount, layout or viewer replacement and native
background retirement invalidate the old opaque command ids; no answering
mounted client means typed unavailability.

The Board's visible arrival Dismiss and task-source Retry also use their existing
local handlers through mounted commands. They update the displayed projection;
they do not add another Board writer.

The client-placed `clipboard.write { text }` is the shared copy effect for UI and
Agent/MCP callers, including Usage widgets' Copy query. Its existing safe default
remains configurable through ordinary Action settings. If the person requires
approval, copied text stays in the live invocation: the approval Artifact and
observation projection contain no text, and durable replay cannot reconstruct it.
The answering client must still be available to deliver the copy; approval does
not supply a clipboard or turn an unavailable delivery into success.

The development UI retains two platform/bootstrap exceptions. Browser text Copy
uses the clipboard owner's synchronous gesture path because WebKit requires the
write to begin in the click stack; native Copy retains Action admission. The
root crash fallback and unsupported-WebCrypto startup screen can copy diagnostic
details before an Account Action runtime is available. These exceptions do not
grant an Agent another clipboard path.

Pending-field and Session-requirement Saved Secret choices publish listed
identities or references only. Disabled choices retain their existing reason
and return typed unavailability. Selection does not return secret material;
consent, connection grants and persisted defaults retain their existing owners.

In unreleased 0.3 source, `files.save` is the shared client file handoff for native
and deployment log downloads and Agent/MCP/CLI callers. Its `source` accepts
`{ kind: 'text', text }` or `{ kind: 'deploymentLog', reference }`; the latter
walks the finite masked pages of `deployments.logs.read` for the selected build
or step reference. It refuses changed or unavailable sources without handing off
a partial file. `fileName` names the download, and ordinary client dispatch selects
the answering app. The result reports `saved` or chooser `canceled`; an unavailable
platform returns a typed refusal. File content stays in the live invocation and
is omitted from approval Artifacts and observations, as with `clipboard.write`.

Mounted approval launchers and enabled Review controls publish navigation to
their existing review handler. The review's existing Back command closes it.
These commands do not approve, confirm or repeat the pending operation.

`ui.current_context.read` and `ui.current_context.command.invoke` are client-local host Actions available to UI, Voice, Agent, MCP and CLI callers. In development source, the canonical CLI projections are `happier ui current-context read` and `happier ui current-context command invoke <commandId>`. The read returns the current navigation snapshot and complete opaque command inventory; invocation accepts only a currently published command id. Context data is strict JSON, and executable declarations and descriptors remain closed. The snapshot has no independent command-count or aggregate-byte ceiling: a growing filter or view inventory must not erase its entity or commands. Semantic command launch inputs retain their own operation boundary. The answering AppShell uses the same current-context reader and semantic dispatcher as Voice, retaining mount retirement, current Action availability, declared caller surfaces and approval policy. While a Details workspace is focused, the snapshot's area is `workspace`, and the entity and commands come only from what that workspace hosts, on phone and desktop alike; the page behind it and that page's host controls are withheld. CLI invocation requires that answering client; headless CLI/RPC hosts have no mounted execution owner and cannot substitute a successful local result.

In unreleased 0.3 source, mounted Browser, Computer, Services, Board and phone-preview presentation controls extend this same current-context command inventory. Read the answering app's inventory before invoking a drawer, tab, detail or device choice; command ids retire with their mounted owner. These commands reuse the UI's existing presentation state and do not change Browser interaction enablement, import credentials or disclose capability links. Generic current-context Actions currently refuse plugin-surface calls; their generated SDK DTOs do not establish plugin admission. Plugins retain `context.ui.present` for the supported Session presentation intents.

Browser annotation tool/style choices, diagnostics disclosure, download-bar
Dismiss and viewer presentation controls use those same mounted handlers.
Browser and Computer share the viewer tabs, input mode, keyboard panel and reset
controls. Confidential input, clipboard delivery and diagnostics consent remain
outside these presentation commands.
HTTP request expansion remains person-only because it reads selected bodies and
cookies; after the person opens it, a mounted Collapse command may close it.

The folded Machine row in managed-machine setup publishes an opener for the
controller chooser. Read the current context again after opening it and invoke
an enabled Machine's command to update the mounted setup. Its choices retire
when the chooser closes. The chooser uses the same controller selection as the
phone menu. To set a saved Machine scope, call `settings.set` with
`machines.administrationTarget`.

In unreleased 0.3 source, each presented Workspace sync relationship row also
publishes a Details command through that inventory. It opens the same details
view as pressing the row and retires when the row leaves the presented surface.

In unreleased 0.3 source, the Handoff picker publishes cancel, open Machine
picker, individual target Machine/sandbox configuration choices, configuration
back and the enabled transfer-data draft control. The shared Machine selector
marks presentation options once; Handoff opts in with its local draft callbacks.
Acquisition, pool resolution and persisted favourites have no draft command, and
this picker exposes no all-options activation command. Handoff
progress publishes conflicts, Details and choose-another when those controls
are shown. These commands use the same presentation handlers as the controls;
starting, retrying or resuming a handoff remains with its semantic Actions.

The Fork chooser publishes Configure, replay-settings navigation and technical
details while offered. Its unknown-outcome Check for Fork refreshes the Session
projection and finds the original request's child; retry-open uses the existing
child navigation. Neither command starts or repeats a Fork. Session header, Info,
Session row and transcript launchers carry the existing mounted-command bridge;
guarded close remains owned by the modal host.

The mounted Sync conflict view also publishes Back, comparison choices, local source
and target choices, and Ask Agent through that inventory. Ask Agent opens the
same authored Session draft as the button. Resolution still uses its existing
semantic Actions and review controls.

Add machine publishes its visible folder and ignored-content drafts and Cancel.
Linking still uses its existing semantic Actions and review controls.

Mounted Worker views publish output, capacity-sheet and handoff-settings
navigation, failure details, Back and a visible Discard draft. Destination choices
that save a preference remain on `projects.worker.preferences.set`; mounted
commands do not save preferences or start work.

The Computer picker also publishes pending target and access choices and its visible
Cancel control through that inventory. These choices update the same local draft
as the picker; sharing still requires the person's confirmation. Disabled access
choices preserve the picker's existing reason and refuse invocation.
The Computer viewer also publishes its offered stream retry and recovery Details
controls; retry uses the viewer's existing relay recovery handler.

In unreleased 0.3 source, each Usage/Vitals scrub lens publishes a fixed command
set rather than a command per chart bucket. Its chart-values command returns
the latest exact bucket titles, totals and rows. Invoke it without input to
discover available zero-based bucket indices, or with
`{bucket: 2, mode: 'read' | 'select'}` to read or hold one bucket. The fixed
row-selection command accepts `{row: '<id from the returned rows>'}` while a
bucket is held; dismiss releases the lens. New samples update invocation results
without changing command declarations. Datum tooltip commands likewise return
their exact value rather than embedding it in the command title. These commands
retain ordinary mounted admission, opaque ids and answering-client routing.

In unreleased 0.3 source, mounted local-command dispatch binds the original caller
to the invocation. Effectful handlers pass their existing mounted execution engine
to `invocation.execute(...)`, including when an existing queued or deferred flow
retains that invocation. The canonical ordinary-child owner derives the child
request identity and strips inherited parent consent; the mounted engine retains
its captured Account, private delivery ports and effect lifetime. Caller
cancellation remains effective, while an existing successor view can supply its
own effect signal. This preserves Agent attribution without a per-control caller
override, and leaves genuine touch confirmation on its existing path.

Plugin pages publish finite `executeAction` or route-owned `openSurface` commands rather than raw UI state. PRs & Issues uses this seam for its [mounted-page operations](triage-sources.md#mounted-page-actions-03-development); the current context carries that page's ephemeral Action address for typed operations requiring entry references or a lens.

The CLI current-context route has no browser-tab or mount selector. Its read and
invoke use the connected-client selection described above. An opaque command id
copied from another browser or mount does not address that publisher; the answering
app refuses an id it does not currently publish. Read the answering app's command
inventory before invoking it. A separately observed mounted Action address is
likewise meaningful only while that exact mount remains available; it does not
change the unaddressed route's receiving client.

## Finite Project command observation and output (0.3 development)

Named-task Secret requirements use persistent Project bindings by Saved Secret
reference. The Scripts page shows these bindings and offers the existing Saved
Secret picker to bind, replace or remove them. `projects.organization.update`
accepts `environmentBinding:{name,reference}` with the current Project row's
`expectedRevision`; `reference:null` clears that name. The existing Account
Project organization row owns persistence and conflict handling. Shared Secret
references retain their exact revision; Secret values are never Action operands.

At finite-run admission, UI, CLI and agent callers reach the same Project owner,
which selects bindings for the manifest's Secret requirements and resolves them
through the existing Saved Secret materializer on the execution host. A required
unbound Secret settles with `project_environment_binding_unavailable`; binding it
allows the next run to proceed. Clearing or changing a binding affects later
runs. An explicit `projects.compute.exec` invocation overlay overrides Project
defaults for that invocation. Materialized values remain in the host's launch
environment, outside Action payloads, operation records and logs.

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
Settled history is limited to 50 entries / 24 h. The installed daemon now retains
`projects.open` receipts and their request correspondence in device-local encrypted
files under the existing operation owner. A settled result survives restart;
an unfinished Open settles once as `action_outcome_unknown` with
`effectAttempted: true`, and rejoining its request never repeats the effect.
Unavailable receipt storage refuses a new Open before execution without blocking
ordinary daemon readiness. This is an unreleased 0.3 development contract; existing
process-local receipts cannot be recovered retroactively.

Other generic receipts remain process-local.
After a daemon restart, other process-local Project commands and prepared
transfers may run again under the same request id; receipt eviction also ends
request-id deduplication. Finite `projects.prepare`,
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

In unreleased 0.3, Machine setup's current operation snapshot carries ordered
`domainRef.steps`: `(planIndex, stepId)` identifies a row, `label` is its reviewed
localized title, and `state` is pending, running, succeeded, failed or cancelled.
An optional `failureCause` carries the native reason code, never process output
or script bytes. Apply, removal and updates share this producer; terminal and
task attachments retain the rows. The existing operation subscription publishes
only changed snapshots. Released V1 readers omit the Machine setup reference.

Confirming a saved Machine preset Review after its preset revision changes
returns `plan_changed`. The existing attachment stays in place and a fresh
Review can show the current revision. An unavailable candidate returns
`required_fact_unavailable`.

In unreleased 0.3, a failed finite Machine Setup or retained Project command also
carries closed `finiteCommand` failure details for current V2 operation and
approval readers: the execution phase, optional zero-based command index, exit
code and signal. A combined Setup failure can also carry the failed native Setup
operation's address and its retained terminal ID. Action details shows the
one-based step and exit code, and **See what ran** opens that terminal when the
receipt carries it. The existing terminal access rules apply. Command bodies,
environment values and process output stay outside the diagnostic. Released V1
operation and approval projections omit these details.

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
custodian's channel. The authenticated relay consumes the identity admitted at socket connect and
checks Account mode before user-scoped fanout. In development 0.3, the bearer is
verified once at connect and never again per RPC; the existing socket eviction
owner closes revoked credentials and PAT grant changes. A restricted PAT viewer
sees widened permissions after reconnect. Clients read the current qualified
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
writer succeeds. Without a selection, copied text uses the terminal's existing visible
truncation marker for retention gaps and its UTF-8 projection decoder; raw frames and
cursor/completeness metadata remain unchanged.

In development source, `projects.execution.output.copy` also accepts an explicit byte
selection on that same qualified operation. `byteOffset` is inclusive and
`selection.endByteOffset` is exclusive; for example:

```json
{ "serverId": "home", "machineId": "machine", "operationId": "operation",
  "byteOffset": 4, "selection": { "kind": "bytes", "endByteOffset": 12 } }
```

The selected-copy result adds `selection: { request, text, coverage: { complete, gaps } }`.
`request` is the admitted qualified copy request; `text` is the UTF-8 projection of only
the returned selected bytes. Frames passed to the clipboard are clipped to that interval,
without inserting text for missing bytes. Each missing interval carries its exact
`startByteOffset`, exclusive `endByteOffset`, and `evicted` or `not_returned` reason.
The existing read credit, frame limit and byte budget still apply; incomplete coverage
does not trigger a read-all or another fetch. UI, Agent, MCP and CLI use this same Action
and receipt. A rendered selection (`{ kind: 'rendered', startLine, endLine, text }`) without
a proven byte mapping returns `operation_output_selection_mapping_unavailable` before any
read or clipboard write. A matching development host must enforce or reject the selection;
an older strict input reader rejects the new operand. No persistence format or wire epoch
changes. Binding the borrowed terminal's real selection and the configured evidence handoff
remains a separate UI integration; this source contract does not establish that journey.

Borrowed output viewers are read-only subscriptions: closing one
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
envelope; routing carries only the qualified Doc and complete revision. A new
passage thread includes the Doc's current owner and accessible people through
the existing initial Discussion grants, including people with Team or Group
access. Thread replies inherit the root's Doc anchor.

Proposals retain the exact source passage (UTF-16 Markdown offsets and quote),
before/after text, reason and full base revision. Posting one changes no Doc text.
`doc.edit.propose` also accepts `discussionRef`, `localId`, `after` and an optional
`reason`. The shared Doc adapter reads the thread's latest committed passage
comment (including an explicit reattachment), then reads the current Doc through
`doc.read`. The shared passage owner places both the margin and the next proposal
on an accepted suggestion's replacement, including unambiguous relocation in later
revisions using the original quote-placement rule. A later explicit reattachment
takes precedence over an older acceptance. When preparing a new suggestion,
changed paragraph context does not detach an unchanged, unambiguous selection;
after Undo removes an accepted replacement, the retained selection can locate
the current paragraph again. Historical margin receipts keep their accepted quote.
This is development source behavior. The passage owner expands
the located highlight to its complete containing paragraph(s), then the adapter
binds that text, range and full revision before approval. A missing or ambiguous
passage returns `doc_passage_mismatch`. `after` replaces the entire paragraph span
verbatim; the original comment keeps its selected quote and offsets. Tool guidance
marks the selected span within the paragraph and asks the agent to preserve all
other text verbatim unless the person requests otherwise. Discussion intake reads
the current Doc once and recaptures that marked paragraph through the same passage
owner, so redo guidance does not reuse the old attachment or proposed replacement.
The original comment and reviewed suggestions retain their historical basis. The preview tints changed
words and notes changes outside the selection when that original span can be located
in the reviewed text. Approval replay keeps that reviewed basis
without another anchor or Doc read. The explicit `target`, `baseRevision` and
`before` form remains supported and retains its authored basis. Acceptance still
checks the exact reviewed revision and quote.
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

The proposal card and accepted notice share the existing UI Doc edit operation
owner for in-flight operations and immediate Undo acknowledgements. After a cold
page load, an accepted receipt reads the current Doc's provenance or, after a
later edit, retained revision history: the revision immediately after acceptance
must record restoration of the proposal's base body
version. That durable fact restores the card's Undone state and version, even
when subsequent edits exist. A later unrelated restore does not establish Undo.
Concurrent history reads for the same Doc share one in-flight request through
the Artifact Action client; settled history is not cached. No persisted proposal
state is added. If retention has removed the restore revision, the receipt cannot
recover that acknowledgement and retains its existing history guidance.

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
In 0.3 development source, a target Action whose receipt cannot be persisted
settles as `outcome_unknown` through the same approval transition writer. If
that settlement also fails, the next daemon startup selects its own `executing`
durable approvals, both built-in and target Actions, and settles them through
their existing transition writers after acquiring the daemon lock, before
opening ingress. The Account/Home-bound Artifact store owns this one startup
read; `resolveApprovalExecutor` identifies the claims owned by this daemon.
Daemon startup does not scan open approvals to repair development-era duplicates
or backfill list facts, and writes no per-Account migration settlement file.
Older 0.3 development rows with obsolete headers can be removed through their
Artifact deletion flow; no startup migration is provided.
Recovery invokes no Action and adds no polling lifecycle. App and live-invocation
claims remain with their original executor, whose process may outlive the daemon.
An unknown outcome means the effect may have happened. Decisions on that
approval are refused. Repeating the same request identity retains its terminal
record; requesting the operation again needs a fresh invocation identity, a new
approval and a fresh authenticated decision. Approval-detail recovery controls
remain a separate UI integration obligation.
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
The CLI and Agent Action use the same readiness reader. An unknown result
can include a closed `readiness.reason` such as `agent_inventory_unavailable`
when the reader cannot complete the target Machine's Agent inventory probe.
Saved configuration alone does not prove readiness; inaccessible or incomplete
evidence stays unknown. This read performs no repair. Each effect still rechecks
its own authority and binding. People/Bot readiness rendering remains in progress.

## Related

- [api.md](api.md) — the public Action API envelope, PAT authentication, targets, and limits.
- [cli-architecture.md](cli-architecture.md) — how a spec row becomes a CLI command.
- [peer-mediation.md](peer-mediation.md) — the Machine-RPC route classes and which methods may go direct.
- [session-collaboration.md](session-collaboration.md) — the Session-side owners many of these Actions call.

## Machine administrator effect prerequisites (0.3 development)

A missing or non-executable managed CLI settles a Machine administrator effect as
`not_applied` with `reasonCode: managed_cli_unavailable` and
`recovery: {kind: install_managed_cli, executablePath}`. Install or repair the
managed CLI at that exact Machine path, then retry the reviewed Action. Desired
policy success alone does not establish a host grant; selecting a policy never
installs a CLI. The native process boundary checks this prerequisite before sudo
starts, without inspecting protected sudoers content.

In Ask mode, the managed sudoers file uses `targetpw` and
`timestamp_timeout=0`. The effect runner authenticates the named administrator
with `sudo -k -S -u <administrator>`, then that administrator invokes
`sudo -k -S -u root` using its own existing sudo permission. The same transient
answer is supplied separately to each expected administrator prompt and cleared
when the root interpreter is ready. The private prompt reader accepts both the
classic prompt and the exact sudo-rs PAM wrapper while retaining the expected
password principal; see [Ubuntu's prompt differences](https://ubuntu.com/server/docs/reference/other-tools/sudo-rs/). Ask installs no administrator-to-root rule.
The administrator must differ from the daemon account; otherwise setup and
effects refuse with a typed recovery. During managed guest creation, the existing
administrator establishment step selects the local `sudo` or `wheel` group from
the host’s active conventional full-root sudoers grants, following included files
and directories, and appends membership only when that APPLY created the account.
Native sudo then confirms root access for the running CLI interpreter; an effective
denial remains a typed prerequisite failure. Aliased or otherwise custom grants
without a recognized direct group rule need native policy configuration or an
existing administrator. Adopted accounts keep their existing rights. If its own sudo permission or password is
unavailable, the effect explains that prerequisite before any setup mutation.
This chain requires fresh authentication for each effect on classic sudo and
sudo-rs; sudo-rs 0.2.13 does not support `runaspw` or `runas_default`. See its
[supported defaults](https://github.com/trifectatechfoundation/sudo-rs/blob/v0.2.13/src/defaults/mod.rs)
and [sudoers manual](https://github.com/trifectatechfoundation/sudo-rs/blob/v0.2.13/docs/man/sudoers.5.md).

For mixed root and daemon-user setup, P10 supplies the observed daemon identity
in the admitted request. The root interpreter resolves its native non-root UID
and drops to that account with `runuser` before applying daemon HOME/PATH.
`SUDO_USER` identifies the authenticating administrator after the two-hop Ask
chain; it does not select the daemon account.
Older development Ask drop-ins require native repair or guest recreation before
using this chain; this is an unreleased 0.3 correction.

Ordinary dedicated-user bootstrap commands run directly in the clean `happier`
environment when the carrier already has that UID. Other bootstrap principals
still switch through root into `happier`. Ordinary enrollment does not acquire
administrator access merely to re-enter the same account.

For native managed Retry, the installer consumes the existing `bootstrapInstalled`
completion fact to skip completed creation preparation while refreshing the CLI.
An unfinished bootstrap without that fact still requires privileged preparation.

## Machine reachability inspection (0.3 development)

`machines.reachability.inspect` observes a Machine even when its saved posture is
absent. A general inspection returns nullable `posture` and protected native
firewall facts in `observation.nativeFirewall`, using the existing root CHECK
interpreter without APPLY. Ask mode uses the existing attended elevation prompt.
Available facts include the actual SSH endpoints and their source ranges; unavailable native
facts name `requiredFact`. Desired posture is never treated as observed SSH
exposure. A provider-specific membership review reads only its selected provider.

While an Ask password question is pending, its operation supports cancellation.
Cancelling aborts the question and settles the operation as Cancelled before an
elevated process starts; closing the question view alone does not cancel it.

SSH firewall review and private-workload firewall reconciliation inventory the
owned Caddy bindings inside that same protected CHECK. The daemon account's
Docker permissions do not decide whether Ask can inspect them. The native Caddy
observer remains the binding authority: missing Docker, denied access or malformed
inventory returns its classified fact and remedy, rather than an empty binding
list. Only a successful empty native inventory establishes that no owned Caddy
container exists.

A plain `machines.reachability.inspect` on a Machine with no saved posture returns
`initialPostureReview.kind: 'required'` alongside its observation. If the existing
posture format can represent the observed SSH access, the review includes a
`configureInput` to save those settings unchanged. Submit that exact input to
`machines.reachability.configure` through normal approval. If no input is supplied,
use the native facts and the explicit change review. Domain setup preserves the
live SSH scope without reading or saving the Machine's reachability posture.
Changes to SSH access still go through the reviewed Configure action.

Reviewing an explicit first posture uses the same native observation as its plan
basis while `posture` stays null. Configure observes those facts again and rejects
`plan_changed` before saving if they differ from the reviewed digest. Unavailable
native facts return `required_fact_unavailable`; no default posture or SSH
decision is inferred. Existing saved-posture reviews retain their revision basis.

Recovery may carry optional `confirmedAtMs`, the time a person explicitly
confirmed that recovery path. A console confirmation remains `userAttested`,
not a native sign-in verification. It is saved in the existing posture through
the same reviewed configure Action; inspection never creates or refreshes it.
Older undated recovery values remain readable. This is an unreleased 0.3 closed
schema extension requiring matching development readers and writers.

The Network field hook projects native SSH endpoints separately from the saved
SSH policy. Its selected ingress capability describes availability and required
ports; it does not prove a service or Domain is exposed. Effective Docker
bindings alone likewise do not establish internet reachability. Joined-service
exposure must come from the admitted deployment and Domain owners.

Without the required administrator access, inspection returns the elevation
owner's typed refusal, such as `mode_none` or `not_preauthorized`. A missing
managed executable returns `managed_cli_unavailable` with the installation
recovery in `details.recovery: {kind: install_managed_cli, executablePath}`.
Inspection does not save a posture or change firewall
rules. The optional native-facts field is an unreleased 0.3 closed Protocol
extension requiring matching development readers; there is no persisted-format
migration or released compatibility adapter.

### Worker-link outcome reconciliation (0.3 development source)

An exact `approval.request.get` for an admitted `worker_clean_copy` link whose
execution is `outcome_unknown` asks the original source controller to observe the
original operation. The relationship owner matches its immutable definition and
uses the existing committed-copy custody reader at the target. A committed owned
copy settles the approval as executed. A missing relationship or owned copy
settles it as failed with `workspace_sync_relationship_not_committed` or
`workspace_sync_copy_absent`. An active creation, unreachable target, unavailable
observation or failed receipt update preserves the unknown outcome. A registered
WorkspaceRef alone is not evidence of a committed copy.

This read creates no link or copy and does not grant another execution claim.
It preserves the original approval subject, decision and execution start time,
and runs after the existing approval visibility admission. Older controllers
without the observation method leave the outcome unknown. Relationship listing
and conflict reads use Account placement; their WorkspaceRef or relationship
selects the controller without requiring a Session execution target.

### Deployment Prepare Session handoff (unreleased 0.3)

Deployment Prepare uses the existing reviewed-child port for its Session handoff.
The admitted workspace installation issues the derived spawn or message; the
original Session or Workflow remains the caller's provenance. A new Session uses
the existing Session-creation body proof, bound to Prepare's exact child,
workspace and brief. Its existing creation tag rejoins the same child on retry;
it does not authorize a second Session. The original source installation is never
impersonated. Workflow-origin integration remains pending with the existing
Workflow admission and protected-input owners.

## Managed runtime demand (0.3 development)

Standalone Sync flush declares its controller Machine through the Action spec's
`machineRuntimeDemandForInput`, as Send, Run and Terminal do. Shared wake
preparation first reads the exact target's Home-owned managed enrollment
reference. An ordinary Machine returns without managed inventory or a wake
continuation. Passive reads declare no runtime demand.

Finite CLI/agent Machine forwarding retains its original target and declares
runtime need through the sealed V2 operand and signed execution binding. Home's
existing finite-wake custody owner first verifies that the Action spec declares
finite runtime demand before consuming the sealed flag; native power still
requires managed access and Action policy. Public Action Send uses this finite
path for default, enqueued and Send-now delivery; after acceptance, Pending retains
its existing activation owner. Owner-enabled input wake also permits Use-only
Send callers; it grants no power authority to other finite Actions. The receiving
opener checks the declaration against the
original Action spec. Invocation-private child ports
never travel to another host.

Finite wake acknowledges the existing host Action operation before waiting for
approval or native power. Home observes that operation's terminal result before
dispatching the original input. A controller reconnect repeats only the read of
the admitted operation; it does not repeat native power or message delivery.
The operation owns execution cancellation after admission. Scheduler-owned
wakes retain their scheduler lifetime, and explicit operation cancellation
continues to stop admitted work.

Concurrent finite Sends for the same managed Machine join its active controller
wake operation before native preparation or power approval. Each admitted root
retains its own operation receipt and observes that shared result. A late root
may join while the wake advances the Machine intent revision; without an active
wake, the existing revision check still refuses stale input before native work.
Cancelling a follower stops its observation; explicit cancellation of the shared
operation still stops that operation. Different Machines remain independent.

**Run a finite command on a retained Machine.** `machines.managed.exec` accepts literal argv and optional guest cwd and environment
values. Home admits the retained Machine's custodian or a requester with guest
Manage. The signed controller starts an auto-stopped guest through the shared
wake owner and executes as the guest identity recorded at enrollment. The guest
can have its Happier daemon offline. The invocation has no command timeout.

Diagnostics **Run** is direct confirmation. An Ask is recorded in the requester's
Account. Exit status and bounded stdout and stderr belong to that requester's
operation. `action.operations.cancel` signals the provider invocation. A provider
that confirms only transport closure reports an unknown command outcome.

Existing-Session composer Send retains the Session input owner's mode, interrupt
and draft handling, then delegates delivery to the same Home Action transport.
Its authored message metadata uses the canonical Session metadata schema;
protected provenance is stripped before the receiving owner stamps admission.
The receiving input owner preserves authored `sentFrom` display context;
legacy CLI authoring retains its `cli` default.
Effective configuration travels through admitted Action fields. The canonical
full `modelSelection` preserves Team source and binding revision; it cannot be
combined with the legacy flat model aliases. Model grants are enforced before
dispatch, and metadata cannot override that admitted selection. Full selections
spend model admission in the Action executor. Flat aliases use the same grant
membership owner after exact receiver Agent and Provider resolution, before
writing input; both the host/member constraint and credential grant must allow
that resolved ref. An explicit native reset is refused under a model restriction;
an omitted override keeps the existing inherited-input contract.

The shared native power owner inspects vendor power before Start or Resume.
Confirmed-running resources skip native power and retain the existing guest
daemon startup path. A stored running observation cannot hide a vendor-side stop.

## Project creation from a starter or scratch (0.3 development)

`projects.starters.create` accepts a whole-repository registry starter or
`source.kind: 'scratch'` and composes the existing filesystem, SCM, Source and
Project open Actions. The review covers the source, Machine and destination,
repository forge, owner/name and visibility (private by default). The selected
target retains its provider identity and deployment base URL through the
canonical SCM publication owner. Existing
starter callers may still supply `starterId`; the repository forge defaults to
GitHub when omitted. Publication reuses an existing repository only when its
observed visibility matches the requested visibility; a mismatch returns the
normal SCM refusal before changing a remote or pushing. Agent invocation requires Ask;
a person's designed review directly confirms the operation. Children execute
through the existing host-child executor under that admission.

For a starter, the canonical SCM clone owner resolves the latest stable release,
falling back to the default branch when the repository has no stable release. It establishes
local `main`, publishes that branch with its original history to the person's
hosted repository on the selected forge and rebinds `origin`. The resolved SHA is returned as information;
it is not a catalog pin or another confirmation gate. Subdirectory starters are
not supported. Scratch creation refuses an existing or unavailable destination,
creates the directory and initializes an empty local `main`, then creates the
hosted repository and attaches `origin` without pushing the unborn branch. Its
result has no commit SHA or starter id; the new Session builds the application.
The Source owner
projects hosted discovery into its credential-free selector and saves the normal
Source. Project open registers the published checkout and associates its Source,
so the Project takes the new repository's identity rather than the upstream
starter's. Success
returns the Project key, Source id, repository URL, workspace and a Session
handoff. The handoff preserves the description as the first message; the caller
uses existing Session creation as a separately represented effect.

Disconnected SCM returns `scm_account_required` with the existing SCM connect
remediation before checkout or publication. A later failure retains completed
repository/Source/workspace facts in a typed partial result. After publication,
that result includes an opaque `resume` value. An explicit retry passes it with
the original reviewed input, reuses the published checkout and skips completed
SCM effects. If a Source was acknowledged, retry opens the Project against that
Source instead of creating another one. Before publication completes, recovery
remains with the existing SCM owners. Never automatically create another
repository. This is
development source behavior, not a statement of released UI availability.
Matching Protocol and SDK readers refresh together; older hosts do not expose
this new Action. Existing clone, publication, Source and Session contracts remain
with their current owners; no compatibility adapter or persisted format is added.
