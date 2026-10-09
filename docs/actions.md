# The Actions platform

An **Action** is one named, schema-typed user intent — `session.list`, `teams.policy.set`,
`session.board.get` — declared once and projected to every surface it opts into: UI, Voice, Agent
tools, MCP, CLI, Machine RPC, the public HTTP API, and plugins. The point of the platform is that
a new capability is added by declaring a row, not by writing a command, a tool, a route, a
permission check and a confirmation dialog five times.

This page describes the platform's owners and its admission vocabulary. The public HTTP wire
contract lives in [api.md](api.md#external-action-api-developer-preview-source-contract); the CLI
host is in [cli-architecture.md](cli-architecture.md#action-derived-command-arguments).

## Canonical owners

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
| Whether an invocation needs approval, and which approval flow | `packages/protocol/src/actions/actionApprovalPolicy.ts` |
| Effective invocation authority and terminal policy composition | `packages/protocol/src/actions/invocationAuthority.ts` |
| Credential decision admission | `packages/protocol/src/actions/decisionAuthority.ts` |
| API-token action, target, model, mode and origin grant | `packages/protocol/src/auth/apiTokenGrant.ts` |
| Friendly CLI command projection | `packages/protocol/src/actions/actionCliProjection.ts` |
| CLI presentation, including demoting an ineffective success | `apps/cli/src/cli/actions/commandPresentation.ts`, `.../executeCommand.ts` |
| Machine-RPC route class for an Action-bearing method | `packages/protocol/src/machines/peer/mediation/rpc/routePolicyV1.ts` |

There is no server-side Action executor. Three hosts execute: the UI executor
(`apps/ui/sources/sync/ops/actions/defaultActionExecutor.ts`), the daemon executor
(`apps/cli/src/session/actions/createCliActionDeps.ts`, which also serves the CLI, Agents and
MCP), and the public API's relay to a daemon. A server-owned Action declares its Home path on
its spec row and the family clients build their requests from that declaration — see
`serverTransport` below.

In 0.3 development source, the UI host binds authenticated invocations to the explicitly
selected Home, or captures the active Home when the caller supplies none. It derives
authority from that Home's credential provenance and supplies an attempt request ID
for Account- and terminal-credential UI calls, preserving an existing request ID or creation key. Both
execution and preparation use this owner. UI domain clients do not generate approval
origins; the Protocol executor still validates strict provenance and enforces approval
policy before any effect. Agent, Voice and plugin callers retain their own provenance.
An attempt ID does not upgrade authority: terminal credentials retain automation
authority on UI, can request policy-required approval, and cannot decide it. The
approval UI preserves `present_user_required` and directs the person to an Account
sign-in on this Home or another device with that sign-in. Content-key custody and
Home ownership do not supply present-user authority.

## SDK Action declarations (0.3 development source)

### Filesystem mutations and finite transfers (development)

The filesystem Action family addresses an exact Machine and reviewed workspace
root. Create-directory, rename, delete and copy reuse the filesystem-policy and
mutation owners; destructive effects retain configurable dangerous-Action
approval (Ask first by default). Semantic RPC names refuse unsupported older
daemons instead of delivering rooted instructions to an older handler that
ignores the root. Retained incumbent RPC aliases translate their released input
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
linked-Machine read delegation remain unproven; generic Machine access is not a
replacement. Source-to-worker Start and confirmed Move are still being integrated,
not a completed or released capability.

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
Readonly committed-copy preview may include `sizeBytes`: observed logical
regular-file bytes including retained caches, excluding symlink targets. This
optional metric is neither transferred bytes nor a persisted custody fact;
missing measurement never implies an empty or current copy.

Personal copy retirement uses the same Sync relationship termination owner as
ordinary termination. Current dependent work and the reviewed definition are
checked before mutation; definition-only retirement preserves target bytes.
Optional reviewed removal additionally requires the original committed-copy
materialization evidence and exact physical-root custody. Replaced, symlinked or
user-created roots are refused. Unknown removal remains inspectable and does not
authorize a second deletion attempt at another path. Releasing root ownership or
aborting an uncommitted materialization is not committed-copy deletion authority.

Readonly personal copy review uses the incumbent committed-copy inspection RPC.
It refreshes current Home rows around target inspection, checks current Manage
ingress and installation lifetime, and derives the review fingerprint from the
genuine committed receipt and physical root. No caller path, row presence or
preview result grants deletion authority; removal remains the separately approved
`projects.worker.copy.retire` Action. This preview's composed validation is still
in progress in development source.

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

### Entity drop effects (development)

Entity dragging selects a semantic destination and calls its domain Action. There is no generic storage-mutating drag Action. Pointer release, staged keyboard, menus and agent requests consume the same current domain resolvers and writers: relation changes retain `session.reports_to.set`, organization uses `session.organization.move`, and workspace/Session-canvas navigation retains their tab and split owners. Workflow binding edits only the mounted draft's conversation; composer transactions insert typed context without sending it. Pending and todo reorder retain exact recipient/current membership semantics. Widget movement delegates to the configured placement owners rather than a drag-owned store.

The mounted [entity runtime](../apps/ui/sources/components/ui/treeDragDrop/entityDragDropRuntime.ts) revalidates the source, target and admission on completed release. Hover and cancellation do not write. A refused target returns its typed reason; dangerous effects use the existing configurable approval policy. UI input does not confer present-user authority on a plugin or agent. Once dispatch starts, an acknowledged refusal and an unknown outcome remain distinct; drag cancellation cannot rewrite an issued effect or replay it.

Client draft, canvas and picker Actions require their exact answering mounted owner and return typed unavailable when it is absent. Repository upload picking requests acquisition through the existing transfer owner; it does not fabricate OS file handles in JSON or promise upload completion. The generated [host Action reference](../apps/docs/content/docs/plugins/api/host-actions.mdx) owns the complete ids, inputs, outputs and execution placements. [Plugin source/target authoring](plugin-platform.md#entity-drag-sources-and-drop-targets-03-development) describes the declaration and Action allowlist seam. This is 0.3 development behavior, pending the composed loaded-platform journey.

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

Monaco remains focus-addressable while its native widget owns physical Find
shortcuts. Set, step and close use public editor actions. Its read projection
returns the last host-known query/options with `status: 'unavailable'` and
`unavailable: 'engineOwned'` for counts; native widget edits and counters are not
available through Monaco's public API.

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

`app.updates.*` observes and invokes the answering app’s existing platform update owner through
`useAppUpdateStatus`. The mounted shell summary keeps these operations available when the Updates
page closes; retiring the last consumer makes them unavailable. Update, Retry and Restart require
the operation currently offered by that owner, and Skip targets the exact offered desktop version.
Operation results report `requested`; progress and failure remain observable through Get rather
than being represented as an installation-success acknowledgement. These are client operations,
not daemon or server update engines.

### Connected Account configuration (development)

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

The development Protocol contract separates personal Account/group labels from a pool's
definition name: `accounts.rename` and `labels.set/reset` share the presentation-row writer,
while `pools.patch.displayName` still changes the definition. Acknowledgement Actions address
an exact adoption subject or Account/machine warning; explicit `false`, empty warning ids and
literal machine ids keep their meaning. Disclosure Actions are client-placed and address the
current device's existing local disclosure owner, not an Account row.

Definite revoke and pool-delete results may carry the existing typed `metadataCleanup` outcome.
`cleanup-pending` preserves the acknowledged primary effect when related purpose/default or
personal-metadata cleanup cannot finish, including after the initiating Account retires.
Qualification is captured before deletion; unavailable preparation never blocks the primary
operation, and missing cleanup support is not evidence of completion. Unknown primary outcomes
remain unknown. These contracts are still being integrated into the captured UI/CLI producers;
their package and composed-runtime checks are pending.

### Ordinary Account Artifacts (development)

The `artifact.*` family reads and publishes ordinary Account documents through
the existing mode-aware Artifact store. Create, update, delete, publish from file
and restore carry danger safety and require approval by default. Get, list,
revision list and storage usage are reads. CLI commands and MCP tools project
from these same catalog rows; the canonical schemas and generated SDK types
come from [`artifactActionsV1.ts`](../packages/protocol/src/artifacts/artifactActionsV1.ts).

List search, kind filtering and sorting operate on decrypted headers at the
key-holding host, using the existing paginated server list. The server never
indexes plaintext titles or provenance for E2EE Accounts. Publication copies
only from the authenticated caller's own validated workspace through the file
transfer owner, completes that transfer before creating content, and records
host-derived Session, Run, machine, path and digest provenance in the header.
Phase A publishes UTF-8 text; binary storage is a separate vertical.

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
foreign read. A host's `current_session` corpus remains own-Session-only, and an
`unavailable` corpus cannot authorize a subtree read. Relation membership does
not replace ordinary Home access or grant mutation rights. Caller identity,
turn depth and subtree membership cannot be supplied in Action input.

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
projection through the same producer. Existing public projections keep
validator slots opaque, erase validator-only string brands, and admit readonly JSON
inputs without changing normalized result types.

The retained Action-map producer derives each family from its selected canonical
schema expressions in an independent compiler program, then projects the generated
neutral declaration closure into SDK family modules and a small
`actionTypeMap.generated.ts` index. Each family program exits before the next starts;
its virtual declaration placement follows the module defining each canonical family
export, with no separate placement list or persisted Protocol DTO copies.
The producer never renders one whole-catalog structural map. Public support and the
declarative UI grammar are derived from their canonical owners by the same producer.
Stable public support exports remain derivation roots even when an Action schema
inlines their uses; recursive interfaces retain their canonical readonly heritage.
The SDK's declarative UI aliases consume that generated neutral grammar;
Protocol remains the runtime parser and policy owner. SDK runtime delegates and
validated values cross one private declaration-projection seam, retaining canonical
identity and validation without making SDK compilation depend on DTO freshness.

Use the SDK's `generate:action-type-map` command after editing canonical schemas.
`check:action-type-map` compares the SDK outputs without
writing source; the compiler correspondence suite independently verifies their types.
The authoritative local checkout owns all generated source writes. Its existing
derivation lock, publication lock, input fencing and cache cover every generated family
module and the index. Checks retain derivation custody and source fencing but do not
take the global publication lock. One independently filtered CI drift job checks
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

Saved groups use the `widgets.fragment.*` lifecycle and `widgets.group.add` to
insert independent copies through one atomic layout intent. They preserve group
options and child definitions, bindings and sizes, while allocating fresh group
and child ids. Editing a saved fragment does not update previously added groups.
Host-area presets use the existing area Artifact owner: reading missing content
does not write, the first edit persists the default layout with that edit, and
Reset returns an Undo capture guarded by the acknowledged revision. The generated
[host Action reference](../apps/docs/content/docs/plugins/api/host-actions.mdx)
owns the exact operation schemas.

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

The same development presentation subset admits `viewer.open` and
`viewer.source.select` with source `computer` or `browser`, plus `viewer.close`,
`viewer.expand` and `viewer.restore`. These affect only the answering client's
current Session presentation, never target selection, input control or Session
execution. Docking, corner and size remain host-local, not author operands.
The Session viewer's semantic UI callbacks enter the literal
`session.presentation.apply` Action. Its client executor uses the existing
Session-scoped RPC, authenticated focused binding and command/ACK owner; the
mounted presentation port applies the accepted command rather than dispatching
another Action. Account approval policy still applies. Geometry callbacks stay
local to the controlled frame.
When that UI invocation is configured Ask-first, its trusted host UI can settle
the existing V2 approval using the sealed original Session input. This narrow
replay does not expose the internal Action to API/plugin callers or permit
external-principal or Agent-origin internal replay.
The mounted source/frame port supplies availability; without it the current
presentation owner returns `unavailable`. Schema acceptance alone does not mean
the shared viewer shell is integrated or available in a loaded client.

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

Project dashboard Actions use that same instance/area corridor and Artifact
owner. Named documents contain main and aside in one revision; the default is
undeletable. Generic Artifact Actions consume the existing internal-kind policy
and cannot read, manufacture, retag, update, delete or restore dashboard documents;
their dedicated widget and sharing Actions remain the admitted paths. Shared
Project and WorkBoard widget writes use actual admitted
Artifact sharing facts for the same configurable confirmation policy as shared
Session content, not the surface kind as a personal-write exemption. Optional
input `paths` select exactly which saved choices to set or reset against the
owner's current bindings; omitting them retains whole-binding replacement/reset.

## Workflow inputs and complete review reads (0.3 development source)

`workflow.definition.list` opens saved definitions through the existing batched
Artifact read. Account pages return before unrelated plugin discovery; the existing
`nextCursor` carries the plugin continuation after the Account pages. The shared
library displays saved rows while that continuation is pending and retains them
if plugin discovery fails. A recognized Workflow header with missing or invalid required fields,
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
making them readable. Transport, authentication and Account-mode failures
remain request-wide, and an unopened header is never inferred to be a Workflow.
The lean row's `nextRunAt` is the earliest persisted occurrence among enabled
scheduled triggers in enabled Account-level sets, or null when none is scheduled.
The shared trigger summary owner reads this scheduler fact without opening private
trigger context or calculating schedules in clients or Boards.

Frozen Action input and output schemas use the same Protocol-owned draft-07
JSON Schema dialect and Ajv compiler. Self-contained `definitions` and `$defs`
may be referenced by document-local JSON Pointers (`#` or `#/…`), including
recursive references. The compiler retains these references rather than
expanding them into cyclic JSON. External references and undeclared schema
keywords are refused; no schema is fetched from a URL or file. This lets a
Workflow Action validate the native `session.trigger.remove` output without
weakening its recursive Workflow definition contract.

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

The existing server routing selects the lexicographically first eligible socket
id advertising the method in that Account's machine/method room, excluding the
calling socket. Action inputs still address their exact Session, composer or
mounted surface where supported; delivery does not elect a device or retarget
an absent view. Browser automation retains its separate exact-view controller
custody and interrupted-completion contract. Contributed plugin client Actions
retain their own artifact/schema and plugin-occurrence lifecycle dispatch.

When no handler is advertised, including by an older app without this method,
delivery returns typed unavailable: Find and the prompt picker return `reason: 'noClient'`, Next
returns `status: 'unavailable'`, and other Actions return an `unavailable`
failure. Missing required mounted owners remain distinct domain results. A lost
or invalid response after issuance reports `outcome_uncertain`; delivery never
retries an issued invocation. These are current development contracts, not
released availability or a completed loaded-runtime validation claim.

Standalone CLI execution has no bound answering app, so the registry's surface
normalizer still excludes client-placed Actions from CLI availability and
friendly command generation. The catalog's `placements` field lists UI
locations such as command palettes and menus; it does not report connected
clients. Tool exposure remains a separate policy: removing a transport-gap
override does not change the default Agent discovery budget.

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

`settings.list/get/set/invoke` discover U4 setting declarations by anchor. Explicit
declaration bindings name the canonical Account or device preference key or an
owner-backed nested field and its exact mutation schema;
Account writes use the captured Account-settings writer and device writes use
the local-settings owner. The closed Action envelope carries strict JSON values;
each declaration's canonical owner validates its scalar or compound mutation
shape. Choice descriptors remain scalar. The Workflows capacity and Run-history
retention anchors bind to the server-owned Automation settings record, not Account
preferences. The Workflows
Run settings controls use this same Action writer; field updates read the current
record and preserve its other fields. Derived values, sensitive preferences and
editors without an explicit value binding remain unavailable for writes: discovery
reports their access status and unsupported writes return a typed refusal.

In 0.3 development source, discovery derives `targetKinds` and `targetRequired`
from each declaration binding. `settings.get/set` accept an optional exact
`target`: `{kind: 'home', serverId}`, `{kind: 'team', serverId, teamId}` or
`{kind: 'team_identity_connection', serverId, teamId, connectionId}`. Home
targets must match the invocation's captured Home; Team and identity-connection
declarations require their resource target. Account and device preferences accept
no resource target. Unsupported kinds or a different Home return
`setting_target_mismatch` before a read or write. Team policy and identity
connection edits use their existing domain Actions and revision owners.

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
authority ceiling and Account encryption mode; own-Account delivery does not
disclose a private Account custody bundle.

Settings discovery, mutation and operations also respect the declaration's page feature
gate and host availability. Optional unset values are explicit, rather than
invented defaults. Compound choices keep their domain owner and update atomically.

The Conversations language anchor projects its title and write admission from the selected
consumer's declared language behavior. It is Reply in for independent reply preferences and
I speak for a service with one supported language for listening and replies. Unsupported or
unreadable consumers have no scalar writer; a retained unsupported language is unavailable,
not the service default. UI edits and Actions use the same preference owner and reject a
prepared language change after the selected consumer or its activation retires.

`settings.invoke` accepts a declared anchor and, for an executable Voice operation,
a closed operation input (a model-pack or voice id, diagnostic artifact/session,
revocation obligation, or diagnostic enable choice). Discovery advertises the
operation, its default approval requirement and whether it needs human interaction; callers cannot submit a
provider id, JSON path, gesture claim or confirmation token. Contributed Voice
settings operations share the UI's occurrence/currentness, real confirmation,
snapshot and Account-settings CAS owner. Provider-side success alone does not
mean its patch was saved: the result reports completion only after that owner
acknowledges the patch. Decline, unavailable prerequisites and uncertain write
outcomes remain explicit.

Credential selection and recipient review open the incumbent anchored control and report
`interaction_opened`, rather than completion. Credential values stay undisclosed
and scalar Get/Set remains refused. Curated moving-model aliases and privacy
opt-ins use the same real human confirmation for UI and exact settings mutations;
the mutation rechecks its admitted owner and Account scope before each CAS apply.
Declared speech endpoints share the rendered endpoint normalization and consent owner:
HTTPS clears insecure-origin consent, while HTTP consent is bound to the exact origin
and reachable execution computer and rechecked before each prepared mutation applies.

### Client-local Voice controls (development)

The `ui.voice_global.*` conversation and Brief Actions execute on the answering
client through its incumbent lifecycle, held-input, recovery and Inbox delivery
owners. Read the current attempt with `ui.voice_global.get`; mutations carry the
returned attempt identity, so later navigation cannot redirect a stop, mute or
hold operation. Starting a microphone, recovery that may reopen it, and Brief
request/retry require approval by default through the ordinary Action policy.
End, mute, dismissal and reads are direct by default. The current attempt read
reports captured destinations and actual availability, rather than promising
that an unsupported host can start Voice. Brief delivery remains demand-mounted
on the ready Home/Inbox surface; missing owners return typed unavailability.
Approvals inside a brief remain tap-only and cannot be answered by speech.

The development status result includes nullable `inUseVoice`: the qualified
contribution, declared voice field/value and display name accepted for the
current attempt. Unknown application remains null. A saved next-attempt Session
preference cannot relabel running audio; ending or replacing the attempt retires
that fact. Start distinguishes an exact Home-qualified Session target from
global mode, and both retain the ordinary configurable human approval policy.

`session.voice.preference.set` uses the registered `intent.voicePreference`
owner field. Null restores Account inheritance; a selection changes only a
provider-declared voice field, never the provider, credentials, model or speed.
The private owner work projection retains the choice without exposing it in
shared Session identity. Exact-target instruction preparation and all-carrier
application are separate integration obligations, not implied by accepting a
preference or returning an attempt status.

Executable Voice settings operations use `settings.invoke` and return typed
completion, cancellation or unavailability from the same operation owners used
by their controls. Destructive and secret-bearing operations default to approval;
platform audio gestures, consent and save prompts still apply. These are
development-source contracts, not a claim of availability in a released client.

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

The Channels plugin exposes its existing binding update and enable/disable
Actions to agent and MCP callers, retaining confirmation and revision checks.
It has no literal rename field: the displayed endpoint label is not a newly
writable preference.

These are development-source contracts, not a released availability claim.

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
so callers receive the mutation outcome. UI create, settings, remove, widget and drag
controls enter `boards.apply` before the optimistic queue; Retry re-enters the same
Action admission under its captured Home and Account. Live UI membership is supplied
only by the Board adapter, never trusted from agent input. A host without the Board Artifact
transport reports `unsupported_action`.

## Session-spawn model choices (0.3 development source)

Host Voice Session creation uses the ordinary `session.spawn_new` executor and
approval policy. Its admitted Home and Account supply the opaque creation
namespace, so a retry with the same creation key rejoins the same logical
creation without colliding with another Home or Account. Missing admitted scope
refuses creation. This namespace grants no permission: Voice retains
`account_automation`, including when it creates its hidden conversation before
a parent Session exists.

`action.options.resolve` for `session.spawn_new`'s `modelSelection` field returns
an optional strict `modelCatalog`: native choices from the existing Agent
inventory, plus the exact Machine's existing Provider picker projection. Generic
`options` remain native choices. Other fields and Actions do not receive this
catalog. A missing or failed Provider projection is `null`, not a fabricated
model list; native choices remain available.

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
Missing scope fails closed. This identity is only deduplication: Voice retains
Account-automation authority and the Action's existing approval requirement;
it does not become a present-user invocation.

## Notify me (0.3 development source)

`notifications.notify_me` is an Account-automation Action with `message`, optional
`title`, optional `open` (`session` or `workflow_run`), and optional `channels`.
`notifications.channels.available`, resolved through `action.options.resolve`,
projects the same configured push, webhook and plugin-channel owners used by
Activity delivery. Omitted channels select all available channels; an explicit
list restricts delivery, and removed channels are ignored. Delivery still follows
the Account's attention policy, quiet hours and preview privacy. The result reports
`attemptedChannels` and `deliveredChannels`; it does not create an Inbox item.

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
the UI's one Action front door and runtime chain. The route stamps `present_user` itself and names
the Session from the request; it admits only the present-user Action set, never agent input, whose
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
The registry permits only one Session to own an exact physical native target at a time.
Another Session's selection returns `computer_target_in_use`, including while the previous
owner drains. Confirmed close releases ownership; an unconfirmed close remains quarantined.
Consent and model media remain Session-scoped rather than shared across those Sessions.

An agent selection request supplies `requestedTarget`, a window-title or app suggestion,
and may supply an exact native `target`. The approval UI reads the suggestion from
`actionArgs.requestedTarget` and authoritative display facts from
`preview.computerApprovalDisplay`; a suggestion is not a host-verified title.
Both policy-routed and explicitly created approvals resolve these display facts from
the computer owner; caller-supplied preview facts cannot replace them.
The human may choose a different native identity and submit `computerTarget` and
`computerAccess` (`see` or `use`) with the
existing human-only `approval.request.decide` operation. The approval owner stores that
identity and access in the approved selection's `actionArgs.target` and `actionArgs.access`, preserving the machine,
Session and original agent authority. The blocking Session waiter consumes the decided
request, not the original proposal. Before storing an edited choice, the decision route
validates its exact identity against the deciding person's fresh native target list.
The current decision records `present_user` authority for that edit; the transition
owner permits only target/access changes at `open` → `approved`. Those approved
operands are immutable during execution, and the suggestion cannot replace them.

The selected capture source owns access for its lifetime. `computer.target.select`
defaults omitted access to `use`; an explicit `see` selection refuses `computer.input`
with `computer_access_read_only`, including approved or bypassed agent Actions. This does
not disable the person's own native stream controls. The selected-target response and
owner-resolved approval display report access and the native app display name when available.
Changing access replaces the selected source and requires fresh observation consent.

Window listing reports the pinned driver's app display name. Present-user listing may
also include a Session-free PNG thumbnail; agent listing never captures or returns preview
pixels. The development driver also lists the native logical primary desktop when
`get_screen_size` returns validated dimensions, reporting `displays: { status: 'available' }`.
This is not a physical-monitor catalog: pinned native 0.31.0 supplies no additional display
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
visible. The development executor uses the same installed native 0.31.0 driver for
Linux/X11 windows and the logical primary desktop, with macOS codecs beneath that owner.
macOS Screen Recording and Accessibility are checked independently; capture-only window
capture omits the Accessibility tree, does not grant input, and denied/unknown grants
refuse the affected operation. Window input retains native background delivery; desktop
input uses the pinned native foreground delivery rather than its unsupported background mode.
Desktop input consumes one exact capture binding and rechecks current dimensions/backing scale;
viewer frames use the existing separate read-only native process and cannot replace that
model binding. Unknown physical completion remains quarantined, never retried.
An explicit target reselection retires that source only after the old native
process has actually exited, then acquires a new source and requires its fresh
observation; it does not replay the unknown input. Window clicks use the same
host-side origin and dimension currentness checks as keyboard input. This is
not an atomic native origin guarantee. The pinned native pre-effect
`capture_target_mismatch` refusal remains known; generic tool failures do not
prove nondelivery.
Physical macOS permission/input certification and loaded picker/disclosure UI validation
remain separate evidence. Windows and Wayland executors remain unsupported.
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

## The three host-stamped facts

Three fields on a spec row are stamped by the host and never accepted from Action input. Together
they decide who may invoke an Action, where it runs, and how it reaches the Home.

**`requiredAuthority`** — `account_automation` or `present_user`. It is deliberately independent
of transport: a Personal Access Token and a trusted plugin both carry automation authority, while
an interactive host path can carry a present user. A row may declare it — the Team identity,
directory, and external-group-binding row builders declare present-user for anything whose
`sideEffectClass` is not `read` — and otherwise `resolveActionRequiredAuthority` resolves it
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
host has a machine client; absence is typed unavailable. Standalone CLI remains unsupported.

**`serverTransport`** — an optional `{ method, path }` pair naming the Home route that carries a
server-owned Action. It is a local declaration only: the domain route still owns wire validation
and authorization, and the field is intentionally excluded from serialization
(`serializeActionSpec` builds its output field by field and never copies it) because it is not a
cross-version wire contract. The family transports read it back from the registry —
`homeDomainActionTransportV1` throws if a registered family row declares none — so the request a
host builds and the schemas it parses come from one row rather than from a hand-kept client map.
`POST /v1/actions/:actionId` stays the single generic
external entry; a per-Action server route is the Home's data operation, never a second way to
invoke the Action.

## Classes Q, M and H

The Teams-program plans classify every Action row as Q, M or H. The letters are plan shorthand;
in source each class is a combination of existing fields, so there is no `class` column to read:

| Class | Source shape | Meaning |
|---|---|---|
| **Q** (query) | `safety: 'safe'`, `requiredAuthority: 'account_automation'` | A read. Agent-exposed by default. |
| **M** (agent may propose) | `safety: 'danger'`, `requiredAuthority: 'account_automation'` | A consequential mutation an Agent may invoke, reaching human consent through the derived approval floor rather than through a refusal. |
| **H** (human only) | `requiredAuthority: 'present_user'` | Account security, root-token administration, sign-out-everywhere, plugin trust/install/secrets/hooks/grants, Runner activation and declared Team identity/directory administration require present-user authority. Token decisions and conversational input have the explicit admission exceptions below. |

`resolveCredentialActionAdmissionV1` admits `approval.request.decide` and
`session.permission.respond` for a present user or an API token with opt-in
`grant.approve`. In 0.3 development, host Agent/MCP callers may also invoke
`session.permission.respond`: the shared Action approval policy requires approval
by default on both surfaces, and the user may explicitly waive it per Action
and surface. This does not widen API-token authority or let automation decide
`approval.request.decide` without its existing authority. A token also needs
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
`session.user_action.answer` is conversational
input: tokens need the Action grant, rather than `approve`. Other automation
callers outside that host Agent/MCP permission-answer path still need present-user
authority for these rows. The caller's
discussion operations are automation rows with Agent/MCP exposure off. Read-state
operations also admit Agent and MCP callers.

In 0.3 development, Agent, MCP and trusted-plugin calls can request present-user
mutations, including
API-token creation, update (including embed configuration), revocation,
sign-out-everywhere and terminal-present-user policy changes. Requestability derives
from the Action's authority and custody metadata, not a mutation allowlist.
`resolveCredentialActionAdmissionV1` admits these requests into the existing Ask-first
flow; it does not grant execution authority. The single approval policy requires a
deferred approval Artifact even when settings waive approval or a host supplies a false
approval hint. Credential-bearing input is the custody exception: the admitted
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
the daemon owns managed-folder cleanup), `session.folder.set` and `session.tags.set`
(the existing Session-organization assignment routes). `session.open` accepts
`approvedNewDirectoryCreation: true` as explicit fresh-folder recovery consent;
that arm requires mandatory present-user approval for Agent/MCP requests, even when
settings waive ordinary approval. Exact-daemon replay accepts human authority only
from authenticated RPC context, never an Artifact body or caller-authored payload.
Ordinary open/resume remains safe, automatic wake/resume never infers consent, and
`SESSION_DIRECTORY_MISSING` stays a typed recovery outcome.

The `session.folders.*` and `session.tags.*` list/create/rename/delete Actions project
the existing organization snapshot and upsert/delete routes. They do not introduce
another organization store. The host seals display envelopes for the persisted Account
encryption mode and opens them for an authorized read. Rename uses the existing upsert
contract, including the caller's retained key, parent and ordering fields.

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

### Memory search (0.3 development)

`memory.search` retains one Action spec and the existing daemon dependency. Its
existing MCP binding is `memory_search`; CLI/MCP exposure uses that same spec.
The CLI invocation is
`happier actions invoke memory.search --input-json '<input>'`. Session-bound tools
retain the current Session machine default, and standalone calls use explicit
machine/Home routing through shared Action admission and settings policy.

The implemented query schema accepts `corpora: ['sessions', 'documents']`.
Omitting it preserves transcript-only results. The implemented document-hit schema has `type: 'artifact'`, a
qualified doc reference, observed header/body revision and a facts/archive,
document, or named-topic `{type: 'topic', title}` location; these hits carry no transcript sequence numbers and cannot be
passed to `memory.get_window`. A document result must open through the
current library reader. The coverage schema admits optional `documents.state`
values `ready`, `pending` or `unavailable`; an older response without the field
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
when preparation succeeds without its block. Disabled or inherited-suppressed
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
ordinary instruction documents and skills. A required memory entry intentionally
suppressed by that choice is not a missing-document failure. Session
`disabledInheritedEntryIds` suppress matching Account/Profile/Project entry ids
before reads and never suppress an identically named Session entry. The switch
does not change upstream content or enabled state.

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

Valid empty Markdown succeeds. Optional entries skip definitive
absence; required missing entries and wrong-kind, malformed or locked content
return `attachment_unavailable`. Transient read failures return
`preparation_pending`, leaving retention and retry to the existing accepted-input
owner. New Session attachment intents admit `system_append`; this operation
restriction does not narrow the stored placement schema or discard retained
skill, composer-insert or provider-asset entries.

`session.instructions.set` maps to the registered `intent.context` writer. It
sets the enabled, required `session.instructions` entry in `work.promptStack`,
or detaches that entry when `ref` is null. The shared writer preserves other
entries, Role/Notes and unrelated metadata; detaching never deletes the Artifact.
Its `expectedMetadataRevision` is the reviewed Session metadata version, separate
from the document's header/body revision.
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
through `resolveSessionProjectPromptStack`. The third layer contains shared
Source attachments marked `context`, followed by the personal Project stack;
dashboard attachments are not prompt context. An unavailable association or
Source stays pending rather than silently dropping that layer. Spawned workers
prepare their own Account, own Profile and associated Source/Project layers, not
the Lead's Session entries or inherited-entry suppression. An explicitly selected
worker Profile is forwarded at launch and persisted after replay/source overlays.

Memory defaults apply only at creation: ordinary Sessions default off and Bots
default on, unless creation supplies an explicit choice. Account Settings Actions
address these preferences through `prompts.memoryUseInNewSessions` and
`prompts.memoryUseInNewBots`. Changing them does not rewrite existing Sessions'
choices. Retained Sessions without a stored choice use their Session-kind baseline.

Registered Session context writes carry the caller's reviewed
`expectedMetadataRevision` through the CLI/UI adapters to the shared metadata
tuple CAS. A stale basis returns a conflict rather than rebasing the reviewed
intent onto newer metadata. CLI durable mutation custody keeps the exact queued
intent and reviewed revision in its `metadata_tuple_conflict` refusal record,
preserving that draft for explicit review rather than automatic resubmission.
The nonvisual UI Action adapter does not own an editor draft; visual draft custody
belongs to the deferred Work editor. Attachment admission uses the same qualified
header/document-kind owner as preparation. The public CLI Action path preserves
typed `attachment_unavailable` admission failures and returns `conflict` for a
stale reviewed context or memory write without committing it. The equivalent UI
semantic checks and composed runtime verification remain open integration work.

These are landed, unreleased source contracts, not package or loaded-runtime
completion evidence. The visual Project Context and Session Work editors remain
deferred to the UI lane; their absence does not add another composition owner.

### Reviewed prompt-document updates (0.3 development)

`prompt_doc.get` returns the actual Artifact revision
`{headerVersion, bodyVersion}` with its current title and Markdown.
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
a reviewed Artifact revision and accept optional `topic`. Remember appends there; update identifies the fact
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

The first `memory.remember` may instead name a qualified Session and reviewed
metadata revision. This Session-targeted form requires the Session's current memory
choice to be on; an off choice refuses before document reads or creation. A Bot
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
the fact and returns the created document reference. Recovery attaches that
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
human control routes keep their existing present-user stamping.

The default floor has one present-user rule. A `present_user` invocation on the `ui` surface skips
the default danger floor, because the product UI confirms its ordinary dangerous Actions in its
own confirmation host (a destructive modal, for example) and a second, central approval would ask
twice. The CLI gets the same treatment only when its host has recorded a completed confirmation
for that exact Action (`presentUserConfirmation`). The exceptions are the policy-confirmed
Actions selected by `usesPresentUserUiPolicyConfirmation` and a host-proved contextual
`defaultSafety: 'danger'`. Their confirmation is this policy's default: it is required
on the present-user UI, and a user can waive it in Actions settings. A contextual safe
classification retains explicit per-surface Require settings; it does not become a
permission grant. The executor supplies contextual safety after input admission,
never from a caller's assertion that a target is private. These are development-source
rules, not a claim that every planned contextual Action is implemented. Do not give a
policy-confirmed Action a second picker-local prompt or domain approval resolver.
Persisted per-surface overrides and waivers are evaluated before the default floor
and win for waivable Actions.

Development FIN exception: agent writes through `workflow.trigger.add`,
`workflow.trigger.update` and `workflow.trigger.remove` require an existing
`approval.request`, even with an agent-surface waiver or a host's explicit false
approval hint. The single approval policy enforces this Account-trigger rule; it
does not apply to reads or present-user writes. Agent add/update also needs the
materialized `trigger_write` policy check; approval never supplies that authority.
The host-stamped approved continuation executes under that original request rather
than creating a second approval.

Development FIN placement: the eight `workflow.trigger.*` and `session.trigger.*`
Actions are Account data on the Automation owner. Every Account host composes the one
Protocol trigger owner through `createAccountWorkflowTriggerActions` (CLI with its
credentials, the UI front door with its captured Account), so Account-owned trigger data
does not require a reachable Machine. Host-dependent facts do reach a Machine:
another caller's write (agent-start policy and materializer) is relayed to the
authorized host, and Keep going on an opened Session reads native-goal ownership over
that Session's `session.goal.get`. An unreachable host yields typed `target_unavailable`.

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
The operation has not executed when that result returns. The exception is
`approvalResultCustody: 'live_only'`, where the exact invocation stays the blocking waiter because
its raw result must never become durable artifact custody; such a row must declare both a required
result and a safe observation projection, which the spec schema enforces. Two rows declare it for
a show-once bearer:

- `teams.credentials.externalKeys.create`. Its result is `{ token, key }`. The bearer token
  reaches only the live caller, and the observation projection keeps just the non-secret `key`
  summary for the artifact.
- `account.apiTokens.create`. The API token is shown once and stored only as a digest, so like
  the external key it stays on the admitted invocation and never enters approval history.
  An Agent/MCP request instead returns the Artifact immediately. Its approving present-user
  decision receives the fresh result once as `liveExecution`; the app adopts a created token
  into the existing API-token reveal controller for the Home and Account captured before
  the decision. It never mints another token or persists the bearer in the Artifact.
  Retirement of that Account/Home or modal teardown clears the reveal. If the requester
  supplied encryption access, the deciding app reveals the raw bearer, not a compound
  credential fabricated without the requester's wrapping material. Repeat decisions, Action
  observers and the persisted Artifact receive only the non-secret summary.

Because of this, a deferred approval of either row becomes a blocking one. If the live invocation
is lost, the result is intentionally unrecoverable: list and revoke the credential instead.
`approvalInputCustody: 'live_only'` is the input-side sibling, used for credential-bearing input
such as passwords. The artifact carries only the declared input projection from creation, and a
replay without the live invocation fails closed. CLI rows with either live-only custody declaration
retain their blocking invocation; Agent and MCP blocking callers are unchanged.
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
intent and creates no `plugin_target_action` approval artifact. A request without it fails closed
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

For immediate UI Actions in 0.3 development, caller cancellation does not erase
a returned effect disposition. Confirmed completion and explicit unknown
outcomes remain available while the captured Home/Account is still current;
true Account retirement still prevents disclosure. Reads and work not yet
dispatched remain cancellable. Voice applies the same result custody instead
of rewriting an acknowledged mutation as a cancellation or retrying it.
One-shot CLI Session and Machine RPC likewise preserve a valid decoded
acknowledgement. Cancellation can stop a pending call, but cannot erase its
received effect receipt or authorize a replay. Passive read observations retain
their caller-lifetime and reconnect withdrawal.

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

`ui.current_context.read` and `ui.current_context.command.invoke` are client-local host Actions available to UI, Voice, Agent and MCP callers. The read returns the existing bounded navigation snapshot and opaque command descriptors; invocation accepts only a currently published command id. The answering AppShell uses the same current-context reader and semantic dispatcher as Voice, retaining mount retirement, current Action availability, declared caller surfaces and approval policy. Headless CLI/RPC hosts do not have this mounted owner and are not advertised as executors.

Plugin pages publish finite `executeAction` or route-owned `openSurface` commands rather than raw UI state. PRs & Issues uses this seam for its [mounted-page operations](triage-sources.md#mounted-page-actions-03-development); the current context carries that page's ephemeral Action address for typed operations requiring entry references or a lens.

## Finite Project command observation and output (0.3 development)

The public operation Actions adapt the existing Account-scoped Machine operation
authority; they do not add an operation store or execution controller. Get may
wait for the admitted operation's terminal result without replaying its launch.
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

## Related

- [api.md](api.md) — the public Action API envelope, PAT authentication, targets, and limits.
- [cli-architecture.md](cli-architecture.md) — how a spec row becomes a CLI command.
- [peer-mediation.md](peer-mediation.md) — the Machine-RPC route classes and which methods may go direct.
- [session-collaboration.md](session-collaboration.md) — the Session-side owners many of these Actions call.
