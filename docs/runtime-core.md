# Agent runtime ownership

The host owns the executable Session and turn lifecycle. An Agent plugin supplies its native protocol, correlation and evidence through the public SDK; the host admits input, coordinates work, publishes lifecycle and writes the canonical transcript. Session interaction and finite Execution Runs use that same ownership boundary.

This page describes **0.3 development source**, not a shipped release or a completed live-validation gate. It is the standing architecture reference; approved plans remain the execution contract for their assigned work.

Session capability edits converge through the host's
[`capabilitySelectionSynchronizer`](../apps/cli/src/agent/runtime/capabilitySelectionSynchronizer.ts).
It observes the canonical desired selection and applied metadata baselines plus
skill and MCP rules published through the host's captured Account subscription. MCP
observation retains the launch resolver's realpath, Project, Agent and plugin-item
context and its resolved server-selection baseline; it does not substitute a later
catalog for the launch decision. The
Session client's content-free `account-change` ingress and change-feed recovery
refresh the MCP and prompt-library catalogs for the admitted Home and captured
Account lifetime. They join the existing in-flight hydration and re-observe rows
after an invalidation. Refreshed rules reach the same synchronizer as Session
selection edits. The Protocol resolver compares effective selections after
Session overrides, so unrelated and overridden rule changes do not apply. The startup rule observation
remains the baseline until native acknowledgement or restart; an unavailable
rules read never becomes an empty rule set. Skills admission demands an absent or loading prompt-library catalog
through the existing captured Account hydrator. An in-flight observation is
not a completed unavailable read: admission must retain the resolved rule
context so later Account wakes can compare Machine and Project rule changes.
Completed unavailable reads retain their typed failure and do not become retries.
The synchronizer waits for a settled turn and uses P3's `reapplySessionSkills` for declared library-skill
live reload. Native-skill overlay changes and MCP changes use the daemon's existing
restart-with-resume owner with reason `capability_selection_change` and
`force_current_cli`; they never create a fresh conversation as a fallback.
Turn/approval busy refusals wait for the next settled turn. Missing resume evidence
or a launch mode requiring a person's restart leaves the selection pending, with
an apply-status projection rather than a queue or timer. Effective skill- and MCP-rule
changes publish that same projection with `source: 'rules'` before waiting for
settlement or native acknowledgement, so unchanged Session overrides cannot hide
the pending change. The one composer notice reads this status as well as explicit
selection markers, using the admitted Agent timing even before the sheet is opened.
Actual startup
or native acknowledgement clears it, and restoring the effective baseline
withdraws the refusal without reload. Attach preserves the applied baseline;
actual startup application or live-reload acknowledgement
clears the corresponding pending marker, as does restoring the known applied
selection through Undo. Explicit current terminal/Windows-hosted launch facts
take precedence over a retained daemon projection when deciding manual restart.
Host publication records the admitted
Agent's resume/live-reload facts in `agentRuntimeCapabilitiesV1.capabilitySelection`
so clients can decide timing without a live Machine round trip. These source paths
still require the program's composed live journey before certification.

## Native Agent seam

[`AgentRuntime`](../packages/plugin-sdk/src/agentRuntime/runtime.ts) has two mutually exclusive forms: a Session factory or an execution-only Run factory. A Session-capable Agent does not add an independent Run lifecycle. For Session-owned Runs, the host binds its Session runtime into the shared Execution Run adapter in [`nativeAgentExecutionRun.ts`](../apps/cli/src/agent/runtime/bridges/executionRun/nativeAgentExecutionRun.ts). Detached execution requires the Session factory's declared `executionRunContextV1` facet; it cannot fabricate a parent Session. The shared SDK implementation in [`executionRun.ts`](../packages/plugin-sdk/src/agentRuntime/executionRun.ts) owns correlated Run events, cancellation, terminalization and disposal for the finite/conversation adapters.

The engine registry's [`runtimeCore.ts`](../apps/cli/src/agent/runtime/registry/engineRegistry/runtimeCore.ts) resolves the admitted Agent runtime and composes host services. Agent code receives the scoped public context, not raw host lifecycle controls. Agent-native configuration in `RuntimeDescriptorV1.agent` is interpreted by its Agent; generic host code must not infer its meaning from an Agent id.

Session-owned child Runs retain their own transcript sidechain and interaction scope. They cannot publish the parent Session's work-state or active-input readiness; those projections belong to the main Session context. Finite and retained child contexts use the same Run-scoped work-state service, which reports Session projection as unavailable.

In 0.3 development source, both Session-derived Run adapters bind hook-server
and hook-plugin-directory creation to the child invocation lifetime. The child
retains its genuine parent Session identity but cannot reclaim that Session's
persisted hook port or overwrite its retained hook files. The existing hook
resource owner allocates and disposes the invocation resources. This correction
requires a fresh runner after the CLI reload for loaded-runtime validation.

In 0.3 development source, Session-owned Runs execute in the Session runner.
The runner-local registrar retains Session controls, sidechain/transcript delivery,
Pending and WorkerUpdate. Before admission it acquires a pinned executable snapshot
over the existing tracked-runner daemon service at
`/agent-runtime/session/services/v1`. The daemon's
[`snapshot producer`](../apps/cli/src/rpc/handlers/executionRuns/acquireExecutionRunRuntimeSnapshot.ts)
leases its canonical executable registry and derives admitted profiles and the
selected child Agent's retained source binding from that same lease. The runner
loads the child factory through the existing retained-source loader; it does not
discover another catalog or populate a daemon singleton. Admission prepares profile
prompt text through the existing daemon contribution service using that lease;
the Run retains the prepared instructions. Ordinary later resource reads still
obey publication fences. The existing controller occurrence retains its admitted
profile catalog for Pending, send, Actions, public projection and terminal hooks,
so another acquisition cannot replace a live Run's profile decisions.
The bridge binds snapshot release to Run runtime
cleanup, and the daemon's existing tracked-runner exit cleanup releases abandoned
leases. New acquisition refuses unavailable or replaced authority with a typed
result; unknown operations on an older daemon cannot become an empty snapshot.
Omitted child selection consumes the parent's applied model/auth reader, while
explicit `agentDefault` and incompatible-Agent choice retain the canonical
child-selection rules. The daemon's applied-parent reader and Run credential
materialization resolve the accepted runner through canonical tracked Session
identity, including wrapper launchers. The reader uses that Session's existing
runtime-registry target; Session exit retires Run credential authority using its
tracked runner PID.
Attached SCM summary Runs inherit the applied parent when available; otherwise
they use the configured summary model with the child Account's default route.
If that default belongs to another Agent, SCM submits it through canonical
Action admission only after the parent attempt proves that no Run was created;
profile input never changes an already admitted Agent target.
The bridge resolves this selection before preparing the summary profile so its
saved generator describes the admitted model. These are development-source
contracts pending loaded daemon/runner validation.
The generated RPC adapter retains schema-approved
`childChoice` details and discards unknown data. Target equality compares complete
Protocol Agent keys without treating the runner's global catalog as executable
admission; the daemon snapshot producer still proves the selected factory.
These source contracts require daemon and runner reload
together for loaded-runtime verification; they do not certify an already-running
Session or a released artifact.

In 0.3 development source, the daemon owns diagnostic refusal of runner
`plugin_services.prepare_v1`. Its preparation owner stamps the failing stage;
the control response carries a closed, bounded `{ code, stage }` cause and the
runner preserves it in `PluginError.details.cause`. The daemon writes the same
cause in one `runner_plugin_services_prepare_refused` local file-log line.
Raw exception messages, stacks, paths, credentials and arbitrary error details
are excluded. Refusals without a cause remain readable. This diagnostic changes
neither authority nor retry behavior; loaded QA replay remains a separate check.

The daemon starter's readiness timeout bounds the starter's observation, not
plugin execution. The existing daemon plugin runtime owner awaits source
preparation, module loading, activation, primary Agent construction and initial
Resource admission before publishing the serving registry. Slow work remains
pending under its real occurrence lifetime and can settle without restarting
the daemon. Elapsed startup time is not a participant failure; real failures
retain their diagnosed unavailable result.
Required synchronous consumers do not receive an incomplete registry merely
because the starter stopped waiting. See [plugin preparation](plugin-platform.md#generated-ownership).

Session MCP bootstrap reads the same daemon plugin catalog through the existing
control client. `/plugins/catalog/read` has no implicit generic control timeout:
a loaded daemon's delayed response is not a catalog-unavailable fact. An explicit
caller deadline or cancellation still ends that caller's wait; actual transport
or catalog failures retain their existing unavailable result. This changes no
catalog authority, retry loop or Session lifecycle owner.

Applied Connected Account parent selection and Execution Run generation
currentness reads likewise follow their containing Session or Run operation,
without the generic control HTTP cutoff. Explicit caller deadlines and
cancellation remain effective; delayed reads do not prove retired authority.

Plugin-declared MCP servers in 0.3 development source enter
[`resolveSessionCapabilitiesV1`](../packages/protocol/src/reach/resolveSessionCapabilitiesV1.ts)
as `plugin:<pluginId>/<localId>` items. Catalog rules and Session selection
decide their inclusion together with Account-managed servers. Rules choose
defaults; an explicit Session include admits an existing item even
with no rules or rules only for another Machine or Agent. Agent support remains
an admission constraint, and the machine materializer retains its typed failures
and notices. Preview and runner preparation realpath both MCP and skill workspace
rule roots through the same machine path owner before Protocol containment;
stored and displayed root spellings remain unchanged.
The existing hosted loopback attaches selected dynamic registrations; it does not choose
servers independently. Forwarded MCP peer tools retain their original names
under the MCP SDK tool schema; host-authored hosted tools retain their existing
namespace validation. Static declarations use the existing executable owner
or remote bridge. Wire-name assignment reserves only enabled native servers
whose discovery source declares `loadedInHappierSessions: true`.

The public `services.mcp.resolveServers` signature is unchanged. Its host
implementation projects the applied runner set and never repeats a catalog or
rules resolution. Session-owned Runs receive their own applied projection;
detached Runs retain execution-run scope and cannot attach a declaration that
requires a Session. These source paths are not a claim of completed live QA.

The shared ACP cancellation owner releases the cancelled prompt's raw request
custody before publishing terminal turn state. This includes host-denied MCP
calls: the next admitted input must not race that cancellation and be refused
as a still-settling predecessor. Permission denial continues to cancel the
current prompt through the same owner; plugins do not own host turn state.

In 0.3 development source, known third-party MCP wire names resolve through the
runner's canonical item-identity map and Protocol's tool decision owner. Off
remains denied under full access and existing grants, including when a pending
permission answer is rechecked. Read classification requires both the server's
read-only opt-in and the tool's annotation. The built-in Happier server retains
its Actions policy. For an admitted native Session declaration, MCP entity-row
publication wakes the existing captured Account snapshot subscription and sends
the current projection through the ordinary configuration-update carrier;
Settings need not change. Invocation-only foreign-Account reads retain the
existing Saved Secret operation holder: MCP admission publishes the row into
that captured holder, and the owning Session or Machine's existing AccountChange
and reconnect wakes re-read demanded rows through it. A captured catalog failure
withdraws that holder's tool authority; credential retirement clears its readers
and subscriptions. A failed demanded MCP read does not prevent the Machine's
unrelated notification, Pending, or cursor convergence; cancellation or captured
Account retirement encountered during that demanded read still refuses the
catch-up. An already-retired holder has no catalog demand. These reads never
retarget the process's Active Account.
Ordinary foreground Sessions retain their captured Active Account scope and
lifetime; Session-derived Runs reuse the existing Session configuration carrier,
not a new detached-Run control method.

The 0.3 development approval logic preserves the host's validated `mcpTool`
identity through Session-core's stored request, transcript and pending-request
projections. Its Always-allow controller answers through the existing Session
permission owner, then writes `mcp.servers.tools.set` as the present user. A
failed catalog save retries that write only. Capability enablement uses the
existing `session.capabilities.set` approval and its review-only `reason`;
Always retains the deciding rule's Agent qualifier and writes through the rules
Action. The shared apply-notice producer reads the current desired/applied
metadata, so a stale preview cannot retain a cleared notice or claim a live
reload was acknowledged. Card rendering and composer placement remain separate
capabilities-program integration work.

In 0.3 development source, the shared runner MCP resolver publishes skipped
non-strict servers in one committed Session `message` per launch, deduplicated by
server name, while retaining its debug diagnostics. The typed
[`capabilityNoticeV1` sidecar](../packages/protocol/src/sessions/messages/sessionCapabilityNoticeV1.ts)
contains the server name, reason and optional library item id. Its canonical
reader validates the notice independently of the message; malformed or future
sidecars leave the fallback text readable. Explicit Saved Secret catalog failures
retain their existing fail-closed error path.

Pi's development MCP extension isolates each optional server's spawn,
initialize and tool-list failure, closes that failed connection and keeps
healthy tools callable. Its existing JSON stream carries the canonical notice
through the public transcript publisher, without raw peer error text that could
contain secrets. The runner's existing strict-mode fact travels with
`mcpServers` as `mcpServersStrictMode` on Session and Run requests; strict startup
failure closes all connections and refuses startup instead of continuing.

Pi's development input observer also uses the existing Happier tools extension.
Every conversation launch prepares that extension, including Sessions and Runs
without configured tools. The extension observes extension-origin text at Pi's
public `input` hook and sends it through the native RPC notification stream. The
Pi runtime consumes that observation before diagnostic logging and publishes one
session-scoped user transcript fact per submission through the existing host
projection. Host input keeps its existing recording owner; raw user-message
echoes do not create additional rows. A recorded submission may be transformed,
handled or cancelled later and does not prove final model delivery. Provider-started
turns continue through the existing Pi runtime and host turn invariant.
The same event-publication owner retains startup events until the first host
consumer attaches, then delivers them in order. Internal observers do not consume
that startup history; later observers retain the existing metadata catch-up.

In 0.3 development source, the shared Session loop captures a completed host
turn's nullable assistant preview in the ordered terminal transcript projection.
Ready notification dispatch consumes that captured result, preserving an empty
answer even if a provider successor has already produced text. Working state
continues to follow the canonical Session turn lifecycle, so host-loop cleanup
cannot mark an active provider successor idle.

In 0.3 development source, the [Session lifecycle](../apps/cli/src/agent/runtime/session/loop/lifecycle.ts)
activates the decorated runtime event stream for transcript projection. Delivery
outcome and typed identity registration are passive. The same lifecycle event
fanout supplies Runtime Activity and provider-session identity metadata, preserving
provider startup output until the transcript reader attaches. Native runtime
hooks continue to own prompt delivery, cancellation and turn completion.

In 0.3 development source, prompt Artifact preparation uses the admitted Session
HTTP route for the active Home; a saved descriptor supplies Home identity rather
than overriding that route with its HTTPS endpoint. Optional prompt entries with
an unavailable transport are omitted from the current prompt and retained as
typed unavailable admission facts. The Session prompt-plan producer reports
`prompt_library_unavailable` through the same committed capability notice, with
no document or Account identifiers. Required inputs, invalid or locked content,
and cancellation retain their fail-closed preparation path. Recovery is checked
on the next preparation.

An admitted prompt plan retains its prompt-library snapshot for the current
dispatch. A same-Account catalog refresh or row revision during preparation
does not withdraw that plan or prevent startup; the next preparation reads the
new snapshot, and skill changes use the existing synchronizer at settlement.
Account lifetime retirement, Settings changes and Profile authority changes
still withdraw prepared instructions and policy. Currentness compares those
authority facts and Account decryption material; independent MCP/catalog
maintenance, observation timestamps and equal-content Settings refreshes do
not withdraw a prepared prompt. The Account snapshot owner retains unchanged
preference and key identities when accepting a newer revision. Withdrawal
errors retain `context_source_unavailable` and identify the failed active or
captured Account, Settings, lifetime or Profile check in their typed `reason`.
Optional unavailable library content continues to produce the notice above
rather than blocking startup. These source contracts require a rebuilt CLI
closure and fresh runner for loaded-runtime verification.

In current 0.3 development source, the daemon's [admission drain](../apps/cli/src/daemon/lifecycle/admissionDrain.ts) owns fresh-work quiescence. Temporary drain preserves accepted custody, native request-auth and daemon publications; reopening wakes the incumbent Automation claim loop and parked Workflow admission. Fresh turn and managed-process authorization remain closed during drain. Plugin handoff retains its own exclusion and publication custody. Final shutdown closes admission irreversibly and awaits the existing finite-operation owner's actual settlement before disposing native plugin leases, terminals or roots. Unconfirmed Stop retains that custody and keeps observation and explicit repeated Stop reachable; it does not prove settlement. Session-hosted Execution Runs ask that current daemon owner over the scoped control transport before creating a Run; an unavailable admission reply refuses the new start. Retained Run state stays with the [execution registry](../apps/cli/src/daemon/executionRunRegistry.ts), rather than becoming another drain decision or start registry. These source contracts are distinct from loaded-daemon certification.

Finite Windows PTY work now consumes the existing [native process-custody owner](../apps/cli/src/subprocess/supervision/processCustody.ts), not ConPTY's root-exit notification as a descendant-settlement fact. Its finite helper mode assigns the actual target to the same Job before execution, retains the Job until positive kernel membership absence, and returns the recorded root exit code. Ordinary managed-service helper semantics remain separate and unchanged. Completion-port notifications may be lost; explicit Stop queries/terminates that same established Job and a positive zero-membership result wakes the retained helper. A Get/Wait or output EOF alone is not this recovery. Consumer, native-platform and loaded-runtime validation remain open in development source.

POSIX natural-root uncertainty preserves the original exit waiter, cancellation subscription, output custody and finite reservation until a positive owned-group settlement or explicit recovery. That group witness does not itself prove that a non-disowned descendant in another process group exited; the job-control process-tree validation remains open. Native preparation's host-private Exec custody similarly must retain its actual supervisor resource through unconfirmed cleanup, rather than treating callback completion as process settlement.

### Session process custody (0.3 development)

The daemon's confirmed runner-exit path, both requested Stop and unexpected exit,
consumes [`endOwnerRemainder`](../apps/cli/src/daemon/processes/endOwnerRemainder.ts):
fresh census and the one ownership owner identify the Session's remaining proven
members for the one tree terminator. Unreadable evidence, replaced generations
and a resumed owner cannot authorize an older exit's sweep. Likely survivors feed
the same two-pass Left-behind owner; daemon startup also observes ended-owner
leftovers. A deliberate process Action stamps the existing Session stop intent
before the first signal, so exit retirement records a person's kill rather than
restarting it as a crash. Windows runner-held Jobs survive daemon restart without
kill-on-close; after holder death, the owner tag and captured tree supply fallback
evidence. See [machine processes](cli-architecture.md#machine-processes-03-development).

Startup reattaches live runners through the existing Session markers. Dead-runner
markers instead enter [orphan settlement](../apps/cli/src/daemon/sessions/publishOrphanedStartupSessionEnds.ts)
on the machine transport's connected edge, not when asynchronous connection is
requested. The same serialized publication path retries retained evidence on
reconnect or publication resume. Marker cleanup follows durable exact-turn staging
and authoritative terminal capture/finalization. Obsolete evidence for a recovered
live Session is staged without ending that successor. Every retry also checks the
existing live-runner owner before capture and again before finalization, since a
Session can resume after the startup scan or while capture/staging is in flight.
Failed or quiesced settlement retains the evidence. This recovery does not signal
a surviving runner.

Generic native-IO roots without Run/service identity belong to Happier itself;
their spawner's existing abort/timeout owns cleanup, not a shared-tag sweep. An
instant-exit bare Exec with no observed native subtree settles its lease as
`ended` with `remainder: 'unobserved'`: nothing known to clean, not proof that no
descendant exists. A detached daemon-tagged child whose spawner's end is unproven
remains Proven Happier's, not Left behind. Captured subtrees and explicit Run or
service custody retain their existing confirmed-settlement requirements.

### Project finite worker execution (0.3 development)

The existing [worker admission owner](../apps/cli/src/workspaces/execution/projectWorkerAdmission.ts)
owns process-local FIFO admission and finite reservations, not a second Session
queue. The [finite Project Action owner](../apps/cli/src/workspaces/projectSetup/projectFiniteAction.ts)
captures the SOURCE declaration and exact target, reserves before clean Workspace
Sync preparation, then reviews copied TARGET definitions, setup and environment
before final PTY admission. Queue acceptance is not execution or setup completion;
copying, setup and running are observations of the same retained Action operation.
Cancellation while queued can prove no launch. After preparation/process custody
begins, uncertain cleanup retains that operation, output and reservation until the
canonical owner proves settlement. Inspect and explicit Stop observe/control the
same occurrence rather than replaying it or releasing capacity from elapsed time.

Worker-copy retirement uses the existing [Project worker Action](../apps/cli/src/workspaces/execution/projectWorkerAction.ts)
and Workspace Sync relationship owner. Active queue/preparation/process/Service/Sync
dependencies can refuse retirement. Removing a relationship definition and removing
copy bytes are distinct outcomes: confirmed definition retirement followed by
uncertain byte removal remains `outcomeUnknown`, requiring inspection, not automatic
retry. Long-lived Services use their managed-process/native custody owner and do
not consume the finite FIFO lifetime reservation. A confirmed Stop during Service
Move is retained before cancellable copying; unconfirmed Stop is not settlement.

These are development-source ownership contracts. New-machine acquisition, cold
wake, foreign-requester Source/Sync authority, compound placement-save + Move and
their composed live journeys remain separate integration obligations; this page
does not claim those paths are available or release-certified.

### Managed activity inventory

The daemon's [managed activity inventory](../apps/cli/src/daemon/lifecycle/managedActivity.ts) reads the incumbent Session/input, execution budget and marker, Action operation, PTY, Workflow, Service, transfer, Sync and installation owners. It is a private projection, not another work registry. Missing or failed applicable coverage remains unknown. The transfer bootstrap can prove absence when its canonical configuration explicitly disables direct transfer; an unavailable enabled owner cannot make that claim. The requester summary projector takes this same inventory input; its authenticated reader and authorized requester identities remain a separate Machine-access seam. Retention-only custody is not reduced to the summary's three public count columns.

Concurrent readers share an in-flight inventory observation at the same owner
invalidation edge. A new edge still captures immediately, invalidated snapshots
cannot confirm idle, and completed observations are never cached.

Publisher reconnect reads this same inventory through the reserved server-origin
Machine access-loss receiver. Only attribution matching the current Home, Machine
and installation supplies requester subjects. The Home combines them with
Session AccessKey subjects, revalidates current effective access, and delegates
cleanup to the existing Session, operation, terminal and Service owners. A surviving
grant preserves work; missing attribution or coverage remains incomplete rather
than a claim that all requester work was recovered.

Session absence requires exact committed runtime activity and a fresh Pending snapshot, including accepted, returned-batch, preparing and dispatched input custody. Content-free host notifications invalidate observations; they do not authorize idle. A foreign requester's unavailable Session transport remains unknown. External execution markers are observed on demand through the existing registry's native directory watcher; uncovered or failed observation cannot prove idle.

In 0.3 development source, that same Session live-work read also includes live
host subagents, Agent activity headlines, and pending permission/question requests.
A settled turn cannot prove absence while any of those remain active or unknown.
The runner retains the per-Session `settledAt` anchor; reconstructing the daemon
inventory does not restart it. Retained PTYs expose their own last-activity time.
Inventory subscribers receive owner invalidations even when another owner keeps
the aggregate busy, through the existing change-or-deadline wait primitive.

Guard eligibility reads drafts through the Session's current requester-qualified
Home credentials, scanning the canonical V2 Account draft listing for all of that
Session's address kinds without decrypting draft content. Unavailable or expired
authority, unsupported listings and incomplete reads cannot prove draft absence.
Eligibility also uses the canonical inactive-Session resume builder with fresh
owner metadata from that admitted transport; this read alone does not stop,
resume or discard a Session. The daemon's development-source memory ladder
consumes this predicate and the process-ownership owner's verdicts. The same
planner supplies its preview and execution choice; unknown ownership, activity,
visitor counts or recovery support cannot authorize a stop. Only a later minute
after exact process absence and the cooldown can establish measured relief.
The service rung targets only Project services with their captured Stop and
existing Start again. Every listener must have a known connection-free sustain
window, and the same live-work inventory must prove no working Session in that
Project workspace. Active subagents and waiting questions count as work; unknown
workspace or listener facts remain busy. Session-linked plugin services are not
service-rung targets: their Session is the stop and next-message wake unit.
Guard reads the existing LocalServices refresh's native observation before HTTP
presentation enrichment. The same single flight still owns the full published
inventory; a later Guard reader waits for its fresh successor rather than treating
an earlier completed socket observation as current.
Guard lifetime and watch cancellation retire only their awaiting reader, including
pending ownership and Session activity reads; the shared native/inventory producer
and its normal publisher remain live. This reuses the existing change-or-deadline
primitive without adding a timer or cancelling another consumer's work.
This does not certify the composed loaded daemon or the visual Guard tab.

The development CLI's [process census](../apps/cli/src/processes/census/processCensus.ts)
owns native observations for Guard, Processes, inventory and custody. Linux
consumers request their needed fields; inventory retains machine-wide ownership
evidence and enriches listener command ancestry. Its procfs adapter reads to EOF
without a 64 KiB allocation for each small file. Only successful process-local
page-size evidence is reused across captures; mutable ownership/command evidence
stays fresh. The census has no timer. Inventory ticks follow its existing watch
or summary demand, and Processes releases sampling when its last viewer leaves.

The current Session input-admission owner also receives `session.guard.notice`.
Its exact-current publisher writes the content-free shared `sessionGuardStateV1`
countdown or clears it, and a new runner clears the previous presentation on
startup while retaining the optional Session ceiling override. An explicit
`ceilingBytes: null` disables that Session's cap; absence inherits Machine policy.
The live publisher and authenticated inactive-Session metadata CAS share the
same override mutation. A stop receipt first records requested intent at
`activity/session_stop.v1` and commits that reference on the existing informational
transcript message. The exact runner's exit owner settles the same record to
stopped before retiring its requester resources; rejected eligibility and native
stop failures settle it to cancelled or failed. Publication uses that runner's
admitted requester Session record port, bound to its Home and current authority.
Failed exit publication retains the existing exit custody for retry. The mounted
transcript marker observes the current record through the Session record repository;
pre-stop intent never proves exit or freed memory. Stored record reads tolerate
unknown fields. The daemon remains the guard policy and stop owner and must not
stop on a failed receipt. Warning
delivery uses the existing Activity dispatcher, the current requester Account's
catalog and the shared Machines channel. These development-source seams do not
certify loaded-daemon behavior or the visual countdown/action consumers.

Linux scoped Session launches use the existing native support helper's
`scope-exec` operation to retain scope membership until the runner exits. It
reads that scope's `memory.events` OOM counters once before returning, including
when no Session soft ceiling is configured. The exact launch unit qualifies its
private exit capture; the existing ceiling/Activity owner consumes it before
remainder retirement and records positively witnessed kernel OOM kills. A signal
alone supplies no OOM attribution. The existing accepted-runner marker retains
the launch unit across daemon reattachment. This adds one small native wrapper
per scoped Session and no polling, OOM policy or collection change. macOS and
Windows retain their existing behavior without Linux OOM attribution. These are
development-source contracts, not certification of the composed loaded daemon.

Retained terminal warnings project `terminalGuardStateV1` through the existing
terminal list owner, without manufacturing a Session id. Machines warning data
carries the exact Session or terminal Action targets and a stable occurrence id.
Notification consumers bind its URL routing to an admitted Home before producing
complete Action inputs, rather than substituting the active Home.
The shared current-state predicate lets notification consumers dismiss a cleared,
replaced or completed warning. Session-custodied terminal warnings and ceiling
attention use the same requester runner's notice/dispatcher path without replacing
Session presentation. The terminal and guard owners retain cancellation and stop
authority; this data seam adds neither a clock nor a second notifier.

Memory-guard episodes use that same Machines notification channel once the
daemon reports calm or no remaining steps. The episode projection carries only
the Machine/episode identifiers, action counts, freed bytes and whether a look
is needed; private activity subjects, notes and requester attribution stay in
the activity owner. Session stop warnings remain separate occurrences in the
same channel, not a notification for every completed step.

In 0.3 development source, semantic withdrawal uses the existing [Pending mutation owner](../apps/server/sources/app/session/pending/pendingMessageService.ts) through `POST /v2/sessions/:sessionId/pending/:localId/withdraw` and its Run-scoped sibling. Its result distinguishes confirmed removal from consumed custody or uncertainty. Only confirmed removal can restore the captured structured composer document, and only while its Account/Home and document revision remain current. Legacy Pending `DELETE` remains a separate primitive: predecessor success without that semantic result is not proof that input was withdrawn. An older server's unsupported semantic POST must not fall back to a mutating DELETE. These wire semantics do not certify the still-unverified composed cold-wake or UI integration paths.

Aggregate idle begins only after all applicable owners prove settlement. Real owner invalidations reset that interval, and an asynchronous snapshot invalidated during its read cannot confirm idle. The authenticated guest bridge rechecks the exact retained row, revision and controller around a fresh closed-admission read. Its unused-stop cause can reopen independently of temporary drain, plugin handoff and irreversible shutdown. Only the safe activity decision is published through existing Machine daemon-state updates; references, attribution and content stay private. A committed idle bridge reply can additionally carry the current guest installation's signed evidence, binding that exact row and guest-measured interval. These are development-source contracts, not loaded-runtime certification.

An external after-idle Stop/Delete uses the original accepted Action root and
controller installation signature through the existing Machine transport. Home
derives the private activity/drain destination from that same current control
request and exact retained guest, while rechecking the original requester's
Manage admission. Only this proved controller receives its custodian guest key
envelope for the transport codec; requester Account key material is not borrowed.
The requester needs Manage on the controller, without a separate guest grant.
This narrow retained-control bridge does not grant ordinary guest access; loss of
controller Manage or retirement of the retained control closes it.
Reopening releases only an actually retained drain target and does not authorize
fresh activity reads or drain admission after retirement.

The daemon's managed-policy runtime rereads the current installation-signed controller census on existing Account, accepted Pending/Run and reconnect edges. Daemon startup mounts that single subscription owner with the current Machine transport and retires it on replacement or shutdown. Replacing the retained native resource or enrollment retires the old held policy lifetime; the driver's own intent/submission progress does not. Selected idle/deadline waits remain with the native driver, not a polling loop. Automatic policy effects still pass through current Actions policy and its existing approval Artifact lifetime; installation signatures do not substitute for human Ask approval. Approval retains the same host operation and approved execution context. These development-source paths still require composed and loaded-runtime validation.

Policy preparation reviews the native effect without admitting a new desired
intent. The approved callback rechecks the retained row and then commits that
intent before native submission. A finite external Action also rechecks its
original Session publisher through the final guarded wake transport boundary;
retiring that publisher cannot leave a valid wake authority behind.

The installation-signed census also rediscovers canceled creations awaiting
immediate cleanup before resource/Machine binding. The same policy driver can
delete a declared, retained native-operation handle; unknown handles remain
recovery work and cannot supply a native target. No new cleanup queue is added.

## Managed service custody (0.3 development)

The incumbent [managed-services owner](../apps/cli/src/plugins/runtime/invocation/services/managedServicesOwner.ts)
and [process supervisor](../apps/cli/src/plugins/runtime/invocation/services/managedProcessSupervisor.ts)
own both plugin-scoped services and host-admitted Project services. Project
admission carries the accepted Workspace, source-qualified declaration, cwd,
reviewed effect and authenticated requester attribution into the same semantic
entries. Built-in Project services do not fabricate plugin identities. Their
actual supervisor-issued instance id, not the stable declaration id, identifies
current controls; feed and preview consumers project the same handle and snapshot.

The reload controller retains that one Project custody owner across registry
replacement. Generation-scoped plugin bindings still retire normally. A native
adapter lifecycle is captured for one exact instance while its selected
occurrence is current. Inspection and new effects require current authority,
but retained Stop remains callable after definition or serving retirement.
Starter exit is not proof that the native resource stopped. Endpoint-free
processes report `running` without a URL; HTTP capability and native readiness
are observed separately from process lifetime.

For host-admitted Project services, the same supervisor retains the authorized
launch's selected native invocation capture after successful spawn. Launcher-root
exit or output closure cannot release it while an owned descendant may remain.
The existing cleanup owner releases it only after process-tree disposal and
observed terminal settlement succeed; an unconfirmed Stop retains the same
capture and cleanup for an exact retry. A native resource may truthfully report
its phase as stopped while its owned starter tree remains unproved: whole-service
custody stays unhealthy, not stopped, so the existing Stop policy keeps that retry
reachable. No-launch failures release normally, and ordinary Exec keeps its
existing output/root-wait lifetime. These are source-level contracts, not loaded
daemon or physical-device certification.

The authenticated final-effective Machine-access-loss receiver cancels preparing
Project services and stops entries matching the exact Home, requester Account,
Machine and installation. It rechecks the bound signed Home proof around awaited
cleanup. Serving authority retires immediately; unsupported or incomplete Stop
retains actual custody without retaining preview access. `cancelled_preparation`
requires definitively settled cleanup with no acquired instance, and `stopped`
requires definitive process/native termination. Ordinary shutdown retires this
same owner; no separate service census or registry supplies lifetime authority.

Shared subscription-backed Provider gateways use these same semantic entries in
unreleased 0.3 source. The admitted Home/Account, connection and execution
machine identify physical custody. Separate consumer claims retain exact
request-auth authority; final release joins that consumer's in-flight request
settlement before the owner can stop an idle process. An explicit Start retains
its own claim, with no invented idle timer. The Session runner retains its Agent
and a stable local delivery endpoint, not gateway process custody. New requests
re-admit private daemon access after replacement without replaying transport
failures. A saved remote placement reaches the same custody owner through the
existing machine broker/carrier; it cannot select another hub or local fallback.
See [Providers](providers.md#managed-subscription-backed-gateways) for source
authority and the remaining composed-validation boundary.

## Session path and owners

In 0.3 development source, the Session host's open context retains the admitted
Session transport's Home id and HTTP endpoint, Account credentials and Account
lifetime. Prompt, skills, MCP and role preparation consume that context rather
than selecting a saved Home profile or another endpoint. Each finite read may
capture newer material from the same Account lifetime; retirement still refuses
private reads and provider effects. Manual startup reads Machine policy after
the real Session supplies its binding, including deferred attachment. This
does not add another credential or routing authority.

The shared MCP startup reader admits an unavailable non-strict catalog as a
typed capability notice without removing the built-in Happier tools. Strict
MCP policy and Account custody/encryption failures retain their typed refusals.
Selected-server operations and execution-only detached Run admission continue
to require their catalog; detached Runs have a different output contract from
Session capability notices. Optional daemon plugin-tool catalog loss likewise
publishes a startup notice and permits bridge construction; it does not admit
an empty executable catalog. HTTP POST and native tool execution still demand
fresh daemon authority and refuse until recovery, through the existing inventory
owner. Required prompt, Role and admitted-context failures use the host's typed
`preparation_pending` publication before construction cleanup, without exposing
private Account or document facts. Loaded-runtime verification remains a
separate boundary from these source contracts.

Coding prompt preparation may omit unavailable optional Account library,
Artifact and automatic plugin-asset augmentation, publishing one private-safe
Prompt Library notice from the full-plan producer. A remembered required
selection prevents silent omission until a ready selection confirms deletion;
its old body is never read as a fallback. Selected Profile, Project and required
attachment admission remain strict. Ready captured coding records avoid repeating
catalog reads through the same hydration owner. The memory corpus rejects an
incomplete inventory before replacement or pruning; confirmed absence still
withdraws the corresponding indexed document.

Notes and live worker boundaries without a selected or inherited Role do not
demand unused Account Role inventory. Selected Role policy retains its own
required source admission. Prepared-plan freshness likewise belongs to the
full-plan producer: its currentness assertion is consumed again at native open
and provider dispatch after asynchronous preparation. Withdrawn facts cannot be
reconstructed from earlier returned text. A valid empty plan remains distinct
from withdrawal; string-only callers without that producer authority retain
their existing fallback contract.

In 0.3 development source, skill delivery consumes the canonical reach and
Session selection owners before the runner opens an Agent. The daemon alone
writes `<happierHome>/skills`: immutable digest-addressed bundles feed absolute
POSIX session links or Windows copies, with `session.json` retaining the digest
roots for both Sessions and their Runs. Runner exit releases the folder after
the existing replacement check; daemon re-adoption removes abandoned folders
only with a reliable live inventory. GC runs at those lifecycle boundaries and
skips sweeping if the library or any session manifest is unreadable. Supporting
files retain executable bits; native skill roots remain read-only inputs.
Remote library marks are read before entering the store mutation queue; the
current Session/Run roots and sweep remain serialized, so a slow GC read does
not prevent another Session's content from being materialized.
Foreground identity registration and marker persistence reuse the ordinary
daemon report owner before materialization, without admitting runtime readiness.
The existing heartbeat and exit owner retire those folders after a crash; a
Session-owned Run carries that parent's captured metadata/PID, not the resolver
process. Native registration enters the existing exit custody before awaiting
OS evidence; an unavailable, departed or mismatched recorded process cannot
republish a folder after retirement. A live foreground parent is registered
even when its own skill delivery uses only an index.

One pure skill-plan owner decides native masking, duplicate names and the
index fallback. An unreadable native root withholds every otherwise unmasked
selected skill, while keeping known masking evidence visible. Failure to read
content or reach the daemon never prevents the Session from starting; the host
publishes its existing capability notice. A Run uses its own Agent, cwd and
folder through the same resolver and SDK carrier.

In current development source, stack skill migration is additive. The Prompt
Library load owner adds deterministic Everywhere rules, the Profile owner adds
seeds, and the Project owner adds rules in each viewer's Account. Shared Project
attachments remain intact. Session startup classifies its own and inherited
bundle references through the Artifact reader before its metadata CAS: enabled
own entries become includes, and disabled inherited entry ids become excludes.
Profile seed and Session include migration mark consumed enabled entries with
`skillMigrationV1: true` on their existing stack entries in the same row CAS.
Subsequent loads skip those positive projections, so removing a seed or include
without Off remains effective. The retained marker never suppresses inherited
exclusion identity.
Account and Project migration use `consumedLegacyEntryIds` on the viewer's
existing `skill-rules` row instead: the scoped deterministic entry ids and rules
are written in one destination CAS. Rules Actions preserve consumption when a
rule is removed, and the migration skips consumed positives before reading
Artifacts. Shared Source attachments remain unchanged, with independent
consumption in each viewer's Account. The strict server row schema and tolerant
stored reader share the Protocol schema owner for this optional field.
The kept Account, Profile and Project rows retain entry-to-skill identity even
after a rule is removed or recreated. Disabled Profiles remain readable for this
retained identity purpose without becoming active context or adding new Session
seeds. Deferred native attach forwards its existing credentials to that same
preparation owner. Required inherited exclusions are classified independently
of positive Session attachments: an unreadable own bundle cannot erase a proven
exclude. If required inherited custody cannot be read or classified, the runner
uses its existing skill-unavailable result without preventing Session startup.
Privately captured Runs reuse the same row reader and selection calculation,
without publishing their Account snapshot into active process state.
Coding entries remain inert stored data; the stack resolver never pastes
skill-schema content. Generic bundles continue
to contribute their existing text. The same Prompt Library load owner drops
Voice skill entries through its existing row CAS (D32), without enabling them.
Malformed or unavailable source/target data cannot authorize migration writes.
The program's composed live journey remains a separate verification boundary.

Before capturing skill rules, the runner prepares the Session's selected Project
through that same context owner, including when no project rule exists yet.
It re-reads the captured Account's rules after migration. A failed Project
migration uses the existing skill-unavailable result and capability notice;
it does not refuse Session startup. Private invocation contexts keep their
captured Account/Home and never publish into the daemon's active Account.
The shared Artifact reader binds both ordinary Account credentials and
requester-scoped credentials to that invocation's captured Home transport.
Qualified references must resolve to the same bound Home through the existing
profile identity owner; saved profiles never supply another Account's material.
Invocation currentness is checked even when the reader reuses a cached store.

The host's [skills reapply operation](../apps/cli/src/prompts/skills/runtime/reapplySessionSkills.ts)
reuses that resolver and folder owner. A declared live-reload Agent acknowledges
the new delivery before the host publishes its applied plan; a native-root scan
or library inventory/content failure preserves the retained folder. Account
currentness is checked again after native acknowledgment before publication.
Unsupported launch
paths return a next-turn result, and reload errors return a failed result for
the capability-selection synchronizer's restart-with-resume path. Native-skill
disables remain launch-owned and require that restart rather than library reload.
The synchronizer and its composed Session journey are a separate integration
boundary from this operation's source contract.

The Session skill catalog reads the current acknowledged delivery at demand.
The host's [delivered-skill identity owner](../apps/cli/src/prompts/skills/runtime/resolveHappierSkillIdentity.ts)
recognizes both session paths and the immutable digest-cache paths Agents may
report, then publishes `origin: 'happier'` with the library `projectionRef`.
Containment and home-prefix spellings use the existing CLI path owner.
A reported native path retains its native identity even when its name matches.
A per-open refusal hides only that refused delivery; a later acknowledged reload
can publish its fresh delivery without restarting the host catalog reader.

Skill use in 0.3 development source is an Account fact separate from the skill's
Artifact revision. Declaring native plugins emit the strict `skill-usage` event;
the transcript projection resolves it through that same delivered-skill identity
owner and posts `/skills/usage` without committing a transcript message. A
successful `skills.read` inside a current Session plan uses the same daemon
recorder; reads without a Session do not record use. Native-only paths, stale
plans and failed content reads cannot authorize a usage write.
The request retains its source Account id and captured Home endpoint; the daemon
refuses observations for another Account or Home before reading its catalog.
Session-owned finite and retained Runs forward the native evidence through their
own resolved delivery and captured Account binding, without adding a Run event
or a second token-usage observation.

The daemon's `createSkillUsageRecorder` reads the captured Account's hydrated
`skill-usage` catalog and writes through the existing Prompt Library row CAS.
`planSkillUsageWriteV1` updates a skill only when its timestamp is absent or at
least one day old. The recorder reserves only concurrent in-flight attempts and
releases that reservation when the attempt ends. A refused write consumes no
daily interval; a later genuine use may re-plan from the stored timestamp.
Unavailable rows and conflicts drop the observation without replay; the existing
catalog refresh withdraws stale rows after a mutation receipt. A lost receipt
cannot bypass the same expected-revision CAS on a later use. This
network work stays outside the filesystem store queue. The row retains one
timestamp per skill, including historical ids, for the Skills read/list consumers.
`skills.list` and Session-less library `skills.read` join this row without
recording a use.
The list also projects its oldest timestamp as `usageObservedSince`; deleted
skill ids remain part of that observation bound. An empty or unreadable row
leaves the bound unknown, and an unreadable row supplies no last-used facts.
The shared `deriveSkillAccountStatusesV1` owner marks a skill unused only after
more than 30 days since its recorded use. Without a recorded use, both the
observation bound and the skill's creation must predate that boundary. UI
consumers suppress this status while the usage row is unavailable, including
when other library facts are retained for continuity. These are development
source contracts and do not claim complete native Agent observation.
Source tests do not certify the program's loaded vendor/daemon journey.

Machine skill installation in 0.3 development source is a separate, opt-in
custodian operation. The existing daemon Action executor copies a library bundle
to the selected Agents' declared user roots and preserves supporting-file modes.
It does not write plugin caches or overwrite an unmanaged skill. The existing
Account `external-links` CAS row retains machine/Home-scoped receipts with the
library digest and actual installed digest; new receipt writes omit the retired
sync-mode field, and the canonical reader folds legacy modes to manual. Account
artifact changes
and reconnect demand use those receipts to refresh matching unchanged copies.
Locally edited copies are refused; uninstall removes only a receipted matching
copy unless the custodian explicitly forces it. Account or Home retirement
refuses further effects, and receipt-write failures preserve the reported native
outcome without a retry queue.

Found in 0.3 development source uses the same declared-root scanner as masking,
including plugin roots for discovery only. `skills.found.list` reports directory
paths and plugin provenance. The existing download transfer accepts one of those
paths, re-scans it, and reads the bundle with its actual file modes; it does not
resolve prompt-asset adapter ids. Both hosts supply that reader to the single
`skills.found.read` / `skills.found.adopt` operation. Adoption creates library
content, then acknowledges its reach rules and optional Session include in order;
it keeps any acknowledged identity when a later step fails. A plugin-owned skill
is copied into the library without writing its plugin cache. UI reads retain the
exact selected Machine Home independently of the captured library Account.
Loaded daemon and browser verification is separate from these source contracts.

| Responsibility | Canonical host owner |
| --- | --- |
| Session construction, runtime/context binding and startup | [`runHostSessionRuntime.ts`](../apps/cli/src/agent/runtime/session/loop/runHostSessionRuntime.ts) |
| Runtime event subscription, effective thinking, keepalive, mode orchestration and cleanup | [`session/loop/lifecycle.ts`](../apps/cli/src/agent/runtime/session/loop/lifecycle.ts) |
| Input pumping, permission-mode application, prompt admission and turn execution | [`runPermissionModePromptLoop.ts`](../apps/cli/src/agent/runtime/runPermissionModePromptLoop.ts) |
| Accepted turn facts and lifecycle publication | [`session/turn/lifecycle.ts`](../apps/cli/src/agent/runtime/session/turn/lifecycle.ts) |
| Runtime event validation and stream publication | [`agentSessionRuntimeEventStream.ts`](../apps/cli/src/agent/runtime/session/events/agentSessionRuntimeEventStream.ts) |
| Transcript event projection | [`projectRuntimeTranscriptEvent.ts`](../apps/cli/src/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent.ts) |

Transport liveness, Machine reachability, host-owned Session work and viewer demand
are separate facts. In 0.3 development source, `machine-alive` renews the Machine
reachability lease without rereading or publishing peer endpoint content. The
loopback endpoint owner publishes listener changes and renews its advert at the
existing half-life deadline; startup, reconnect and publication resume reconcile
through the same Machine publisher. Session keepalive schedules the next configured
idle or thinking renewal, while host thinking and mode changes publish immediately.
Neither a live socket nor a renewed lease proves active work or service health.

AppShell plugin membership consumes the existing semantic Machine presence owner
and its next grace-expiry wake. Heartbeats can extend that deadline without
republishing unchanged membership; expiry and fresh-heartbeat recovery change
the physical lease. UI request admission uses
[`isMachineReachable`](../apps/ui/sources/sync/domains/machines/reachability/machineReachability.ts)
under the authenticated Home and Account. A reachability failure remains recorded
across heartbeats until a later successful request or an authenticated socket
reconnect clears that exact scope. An admitted Machine reconnect clears only that
Machine; re-establishing an Account socket clears only its captured Home and
Account. Missing optional RPC methods remain capability gaps, and a timeout is
reachability evidence only when the caller's own deadline expires without a
reply. Explicit Retry and refresh still issue the request that can establish
recovery, while retaining identity, credential-currentness and content-access
guards. Registry changes retain their existing currentness notifications.
These development-source contracts do not certify loaded-runtime performance.

File-backed JSONL observation retains the existing follower/controller and native
file-watcher owners. Healthy native observation wakes the follower on change;
bounded backlog and failed delivery still use its existing drain/recovery policy.
Watcher loss or unavailable parent directories enable fallback reads until native
observation recovers. File replacement, directory consumers and symlink targets
remain part of that same watcher lifecycle, rather than separate polling owners.

The lifecycle owner consumes validated `AgentSessionRuntimeEvent` evidence, projects turn/transcript facts and supplies the prompt loop's thinking setter. The strict event union is owned by [`runtime/agentSessionV1.ts`](../packages/protocol/src/runtime/agentSessionV1.ts); [`plugins/events/hostV1.ts`](../packages/protocol/src/plugins/events/hostV1.ts) validates Host Event payloads through that same schema. Native callbacks do not become a second host state machine. Historical replay/follow and external-session discovery remain distinct from live input and transcript publication; they must not start another prompt loop or durable transcript writer.

In 0.3 development source, assistant deltas and authoritative committed snapshots
share an exact message identity and host turn. The Session-owned Run adapter
projects those snapshots into the strict Run event union; foreground Run results
exclude history and child-sidechain commits. The execution controller replaces
the current message's draft, including an empty final snapshot, while retaining
earlier assistant messages. Its streamed transcript uses the existing writer's
replacement operation on that same active row. Agent producers publish a final
correction before beginning a later assistant message.

A settled cancelled turn can publish its real native rollback checkpoint through
the same host boundary as a completed turn. Exact provider identity and duplicate
checks remain enforced. A delayed committed user-message sequence can join that
retained checkpoint after cancellation; reset or disposal retires the join. A
turn without native checkpoint evidence remains unavailable for rollback.

Claude native task completions use the plugin's existing task-notification
projector across SDK, terminal and transcript readers. Historical 0.2 metadata
results are accepted only as one tool result matching the origin's tool-use id;
their recorded failed/stopped status corrects the released false error bit.
Ordinary metadata retains its visibility filtering. These are development-source
contracts, not claims of released availability or loaded-provider validation.

The [input consumer](../apps/cli/src/agent/runtime/session/input/sessionProviderInputConsumer.ts) owns provider-input dispatch custody and admission quiescence. Ordinary dispatch and model-transition admission transfer use the same async custody scope. A runtime replacement initiated within an active dispatch retains that custody and drains other dispatches plus pending materialization; it does not wait for itself. External replacements drain all dispatches. Settled dispatch scopes cannot lend custody to later asynchronous continuations. This is a 0.3 development-source contract; native reply verification is separate evidence.

In 0.3 development, a missing launchable Agent CLI carries `agent_cli_missing` from both the command/terminal launch owner and the native plugin system-tool binding. Startup sanitization preserves that code; the primary Session issue classifier projects `dependency_failure` with static installation/path remediation. It does not expose raw startup error text or infer acceptance from a failed prerequisite.

System-tool grants pin the selected absolute executable and captured arguments;
they do not clear the inherited host `PATH` used by an Agent's descendants.
The Agent binding's empty lookup `PATH` prevents a second executable selection,
not descendant command resolution. The grant producer owns that launch contract.

Codex Session and execution-run startup use one sanitizer for closed failure
codes and static messages, retaining bounded authentication and missing-state
facts without copying native error prose, payloads or causes. The host's primary
Session issue projector retains those Protocol-owned codes through publication.
Shared Codex control allocates its Unix socket through the SDK's secure temp
owner under `/tmp`, independent of a potentially overlong caller `TMPDIR`;
child-process environment and the existing Windows stdio path are unchanged.
These are development-source contracts, not certification of a loaded runner.

Current development source retains content-free failure diagnostics at the
existing owners. External Session follow identity admission returns a private
typed sub-reason and logs one local file record, including closed provider
failure codes and source-refusal codes where available. It never records source
paths, transcript rows or credentials. Outer source materialization failures
retain their closed registry/materialization cause before the bounded operation
owner discards the thrown error; retained-source validation failures keep their
own sub-reason even when the provider throws. Codex's terminal turn-failure owner logs
the classified failure reason, an admitted native error code when recognized,
and whether provider start was acknowledged. Unclassified failures remain
explicitly unclassified; these observations do not authorize input replay or
change Activity from unknown to idle.

Fresh Claude SDK SessionStart hooks can precede creation of the native transcript.
In 0.3 development source, ordered history acquisition waits for the existing
authenticated accepted-prompt transcript proof; its pending observation scope
keeps Activity unknown. Successful source admission retires only that pending
scope, preserving real observation loss and outstanding native tasks. Resumed
histories still acquire their historical baseline at SessionStart. This source
correction requires a fresh loaded-runtime replay; it does not clear a running
Session's retained observation loss.

A final successful Claude SDK result retires its still-observed query inventory
when no background task remains. Intentional query disposal then cannot turn
that completed observation into unknown Activity. Lost observations, pending
source baselines and unfinished native tasks retain their existing conservative
state. This is a development-source correction pending fresh loaded replay.

Machine and Session RPC dispatch in 0.3 development source uses the existing
[`RpcHandlerManager`](../apps/cli/src/api/rpc/RpcHandlerManager.ts) for one
content-free completion record. It measures dispatch through reply encoding and
cleanup with a monotonic clock, reuses the relay correlation or the encrypted
codec's existing call id, and generates a local id when neither exists. Opaque
transport ids are logged as digests; registered method names omit Machine/Session
scope. Known RPC error codes, admitted caller classes and private failed-admission
predicate labels replace raw error prose and stacks. Unclassified errors stay
explicitly unclassified. Completion uses the existing file info level, so ordinary
Session logging retains it; acknowledgement-projection failures join that same
record without changing the response. Resource handlers report predicates from their existing
admission checks; the diagnostic callback grants no authority and adds no wire field.
The existing daemon control timing owner suppresses successful `/ping` records,
keeps unmatched probes at debug and sends actual route failures to the file warning
logger. These source diagnostics require the next authorized loaded-runtime replay.

Signed direct Machine RPC in 0.3 development source reaches the same
`authorizeMachineRpcRequest` boundary as socket RPC. The peer adapter combines
the verified Home-signed Account with its installed Machine identity and content
mode, then supplies live admission checks to the handler. Public RPC parameters
cannot supply that authority. Handler exceptions remain typed RPC results in the
existing direct response envelope; `handler_unavailable` identifies a missing
handler. The client retains its conservative outcome disposition for that reply.
Loaded-daemon validation remains a separate check.

Prompt preparation failures during construction use the same canonical turn
lifecycle before Session cleanup releases durable delivery. The issue classifier
preserves `preparation_pending` or `attachment_unavailable` as `dependency_failure`.
Typed Home-resolution failures retain their specific code (such as `profile_missing`)
through preparation and lifecycle publication. All use
static document/Home remediation, without publishing private references or
raw error text. Required context remains fail-closed; the issue does not imply
that an Agent accepted the initial input. This is a development-source contract;
loaded-runtime failure visibility and explicit recovery need separate validation.

The daemon's existing runner-respawn owner reads this retained failed-turn issue
before automatic recovery. A deterministic primary Session dependency failure
observed after the exited runner's process start stops that
respawn cycle; the host's issue remains the user-visible authority. An issue from
an earlier runner cannot veto a fresh explicit Resume. This uses the existing
exit-custody process witness and restart scheduler, not another retry policy.
Transient `preparation_pending` and `daemon_plugin_catalog_unavailable` failures
keep the existing automatic recovery path. Fixing configuration followed by
explicit Resume admits a new runner; it does not silently resubmit uncertain input.

The Session MCP owner refuses an unavailable daemon plugin catalog with
`daemon_plugin_catalog_unavailable`, rather than interpreting it as an empty
catalog. Before the live loop takes ownership, the construction owner projects
this prerequisite failure through the canonical turn lifecycle and drains its
durable mutation admission before releasing Session custody. The issue uses
`dependency_failure` and static daemon-connection remediation; it does not imply
missing Agent credentials. Once startup is admitted, the standalone GET
notification stream uses the startup registrations without a fresh catalog read:
the MCP transport cannot dispatch tools from GET. POST requests and native tool
RPCs reuse the admitted inventory's catalog while the daemon projection fact and
Session connection epoch are unchanged. The [plugin projection signal](plugin-platform.md)
invalidates it; the next request reads once and an unavailable refresh fails
closed, rather than dispatching stale tools. Replies without that signal contract
retain per-request reads. Daemonless runtimes retain their explicitly supplied
registry lease; effect-time contributor occurrence admission is unchanged.
These are development-source contracts, not completed live proof.

Accepted spawn nonce observation uses the daemon Session startup budget by default. Explicit finite observation durations are not reduced by phase-local caps; detached abandoned-spawn stop/archive observation retains its separate ten-minute default. The CLI nonce observer, daemon nonce endpoint, target RPC handler and shared acknowledgement race re-arm long deadlines in Node-supported timer chunks. Relay forwarding retains Socket.IO's native signed-timer boundary (about 24.8 days), so these local owners do not establish unbounded end-to-end relay observation.

Creation, inactive resume, tracked handoff and detached cleanup reattach the same accepted spawn nonce through the existing RPC connection supervisor after transport loss. Reconnection resubmits the remaining observation budget; it never sends another spawn. The original deadline and cancellation span reconnect, and settlement retires the underlying observation. Late acknowledgements from a disconnected connection cannot settle the resumed waiter. This describes current development source, not loaded-daemon certification.

In 0.3 development source, Session socket ACK writes wait under the existing
connection supervisor while startup is offline. The transport's connect timeout
bounds an individual attempt; it does not also terminate the waiting Activity
publication or publisher claim. Online connection resumes the write, while
authentication failure or Session disposal rejects it. Session close starts the
existing write cancellation before draining pending lifecycle writes, so offline
Activity delivery cannot hold close open; the undelivered snapshot retains its
durable outbox custody for recovery. Connected shutdown still drains writes and
closes the Activity publisher before disconnecting. The transport retains its
per-attempt timeout and reconnect policy. This source recovery contract is
distinct from a successfully loaded native Agent turn.

Accepted Pending settlement and exact publisher-authority reads also follow
the containing server operation's lifetime in 0.3 development source. The
server's receive/publisher admission queues and transaction retries can outlast
the generic control ACK deadline, so these waits use transport failure or
Session disposal rather than that shorter timer. The existing Session client
retains witnessed acceptance by local input identity and reoffers the same
idempotent settlement on reconnect and before its queue's next materialization
round. Main and Execution Run custody remain separate; reconciliation never
redelivers an accepted input to the Agent or treats Pending absence as proof of
acceptance. Exact server acknowledgement and current publisher/binding checks
still govern retirement. Loaded-runtime recovery requires separate validation.

The same operation-owned ACK lifetime now covers ordinary Session metadata,
Agent-state and Activity writes, transcript/message commits, Pending
materialization/admission and Follow/Discussion publication in development
source. Socket connect convergence and credential admission occur before a
handler's own deadline, so a bounded transaction phase does not bound the full
ACK wait. Connected shutdown retains the ordinary write lifetime while draining;
offline shutdown cancels it, and accepted-input settlement keeps its separate
early retirement. Durable transcript delivery follows the selected Session
handle and its existing outbox custody. Released `session-end` handlers that
never acknowledge retain their bounded advisory probe and authoritative inactive
read rather than an indefinite ACK wait. This describes partial development-source
ownership, not completed certification: terminal credential-admission failure
currently can omit an ACK without retiring the Session transport, and retrying
metadata/state after supervisor socket replacement still needs current-transport
reacquisition. Integrated package and loaded-runtime validation remain separate
evidence. The outstanding correction and evidence are recorded in the
[ACK deadline audit](../.project/plans/2026-10-03-find-search-prompts/lanes/audit-r30-ack-deadlines.md).

In 0.3 development source, the shared Session mutation outbox preserves its
captured server destination through delivery composition. Non-lossy turn
mutations refused with HTTP 400 or 422 settle as
`session_turn_mutation_rejected` in the existing durable dead-letter journal;
restart recovery does not replay that deterministic refusal. Unrelated queued
mutations can continue, while explicit failed prerequisites retain the existing
dependency-failure behavior. Authentication recovery, transient transport
failures and unmatched receipts keep their existing custody. This does not
relax the server's completion-anchor validation: the ordered host lifecycle
publishes acknowledged user, range and final assistant anchors together.
Loaded native completion and next-prompt recovery require a separate replay.

Tracked handoff accepts cancellation during preparation, then closes cancellation immediately before target launch begins publishing canonical Session metadata. Confirmation, commit and source cleanup use the completion signal after that point; a late cancel request cannot abandon the accepted target launch.

`SessionHandle.watch` follows committed retained transcript rows through the shared socket source and delivers complete text before advancing its reconnect frontier. Provisional stream deltas do not become retained message events. Cancellation ends the watcher; credential and plugin-occurrence checks prevent further delivery after retirement.

For cold native history catch-up, a Session factory may declare `transcriptIdentity`, its pure provider-owned identity codec. The bound `transcripts.reconcileSourceIdentities` operation uses the canonical paginated transcript reader and encryption/semantic decoder, filters conversation rows to the selected Agent, and supplies only the codec's declared correlation fields. It checks the current Session, plugin occurrence and native Session identity before and after the read. Unsupported, failed or malformed reads reject rather than becoming empty coverage. OpenCode hydrates its existing authored-ID tracker from exact committed identities, including witnessed 0.2 predecessor mappings and import IDs. Its current percent-encoded import IDs preserve opaque identity tuples; the predecessor codec compares complete constructed legacy or JSON-tuple IDs only after checking a separate exact native-session witness, never by splitting opaque IDs. Unprovable legacy coverage is reported through the existing informational Session-event and default log owners; only that historical snapshot is suppressed, so subsequent settled native turns can still sync. No new identity registry or transcript writer is introduced. These current-source contracts are distinct from full authenticated live validation of the composed 0.3 runtime.

Normal input and in-flight steer use the shared [host dispatch preparation](../apps/cli/src/agent/runtime/turns/prepareSessionInputForProviderDispatch.ts). It delegates selected skills, plugin references, attachments and media to the canonical structured-input resolver immediately before provider effect. The resolved envelope reaches the Agent through the same typed turn metadata, and its JSON projection counts toward required context before optional Follow context is fitted. Native slash commands retain their leading grammar with resolved context after it. Resolution failure is rejected before provider effect with its existing diagnostic and retryability; an undispatched replay-seed association is released. Steering rechecks Session binding, turn availability and admission after asynchronous preparation. This describes 0.3 development source, not completed loaded-runtime validation.

The [Session prompt-plan producer](../apps/cli/src/agent/prompting/coding/sessionPromptPlan.ts) prepares coding policy through the canonical Launch Profile reader, including authorized published-profile Artifacts. Prompt rendering, title-tool advertisement and permission admission consume that same prepared fact. Session-owned retained Runs read it through the existing internal runtime-control binding; their Run intent id is not a Launch Profile id. A missing or retired producer, or failed preparation, withholds title-tool advertisement and admission until the policy is available again. An unresolved profile retains the canonical Account-default policy. No new policy wire field or persisted policy copy is introduced.

The host fits retained WorkerUpdates against the current optional context allowance before dispatch. A still-deliverable wake that cannot fit stays with the input consumer until context/source, metadata, admission or user input changes; parking neither commits a transcript event nor acknowledges provider acceptance. Source admission is rechecked before parking, so a withdrawn wake releases custody even if it still cannot fit. User input keeps priority, and the retained wake is reconsidered afterward without selecting its producer again.

### Usage-limit reset continuation (0.3 development)

The daemon's [runtime-auth recovery scheduler](../apps/cli/src/daemon/connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler.ts)
owns a wait for the exact failed turn and selected Connected Account. When a
directly selected account reaches its reported reset time, recovery admits the
configured continuation through the existing [continuation dispatcher](../apps/cli/src/daemon/connectedServices/continuation/createConnectedServiceContinuationMessageDispatcher.ts)
and [Pending delivery owner](pending-delivery.md). Pending activation owns any
required runtime attachment; restarting an idle runner alone is not continuation.
Queue admission and Agent acceptance are intermediate outcomes, not recovery
proof. The existing credential-qualified outcome owner must observe successful
execution.

Active Session RPC checks and CLI/MCP checks use the same exact daemon-owned
attempt and resume-prompt mode. A failed daemon check cannot fall through to a
competing provider-local recovery path; attempts without daemon ownership retain
their existing local controls. Explicit ordinary user input goes through Pending
rather than waking an automatic continuation during pre-admission revalidation;
the dispatcher suppresses obsolete continuation when newer input is queued.
Automatic continuation revalidates the current issue and recovery intent before
admission. Cancellation, a replaced issue, newer user input
and disabled automatic resume take precedence; the original interrupted input is
never replayed. This development-source integration still requires composed
loaded-runtime validation.

### Roles and managed work (0.3 development source)

Protocol's [role resolver](../packages/protocol/src/prompts/roles/resolveRoleSelectionV1.ts)
owns effective role fields; its
[renderer](../packages/protocol/src/prompts/roles/renderSessionRoleBlockV1.ts)
supplies the host prompt-plan role block. Plugins contribute source instructions
and preferences through the declarative catalog, not another prompt or Session
lifecycle owner. A Session's complete role snapshot and notes are owned by
`work.sessionRolesV1`. Worker starts copy the effective set; explicit same-Account
bulk application is separate from selecting a role or editing the lead later.
Context documents remain in the Session Context stack, not a role-memory field.
Native delegation remains the default where it satisfies the request; explicit
Happier-managed delegation uses the existing Session/Run start owners.

Session Role Actions read Account overrides and retained role sources through
the Session runtime's existing private owner-Account context. The shared prompt
library loader and Protocol parser serve that context and ordinary CLI Account
reads; private catalog preparation never publishes Settings or catalogs into the
focused Account. Credential retirement withdraws the private context rather than
borrowing the focused Account's Role policy. This is a development-source contract,
not certification of an already-loaded daemon or exported UI.

Creation origin, current turn initiator and causal work depth are separate host
facts. The [turn stamper](../apps/cli/src/agent/runtime/session/turn/stampTurnFacts.ts)
distinguishes user, agent-session, workflow and host input; a user turn has depth
zero, while the start-policy witness retains the Session's starter depth as well.
Reporting membership can change without rewriting these facts. The shared start
policy enforces role engines, permission ceilings and the Account work-depth
limit; consumers do not infer authority from a tree row or worker result.

The strict [WorkerUpdate](../packages/protocol/src/sessions/relations/workerUpdateV1.ts)
envelope carries actual engine facts when available, owner outcome, source
pointer and optional deliverables. Truncated results require a source pointer.
It is host context, never a fabricated user message. A Session worker's pending
turn-end review postpones settled delivery; inactive leads are not resumed just
because a result exists. Source and permission admission remain current at the
eligible input boundary. Work/Inbox are projections of these owners, not a second
turn scheduler or permission ledger.

The approval reviewer is a request-scoped client of the existing permission
owner. That owner rejects ineligible effects before starting a no-tools review
with a redacted request, then rechecks current request/policy before an allow-once
claim. Human notification and human answers are not held behind review. Escalation
or failure leaves the human request pending; a successful automatic answer records
the reviewer actor and creates no reusable grant or permission-mode change.

Native interaction lifetime is separate from causal turn identity. Ordinary requests default to turn lifetime and retire with the matching terminal turn (including ordinary requests without a turn witness); native Codex asynchronous questions explicitly use occurrence lifetime. Those questions keep their causal turn id after completion and retire when their Session/plugin occurrence retires. The permission coordinator owns this distinction; terminal callbacks do not cancel every request owned by the plugin.

In 0.3 development source, spawn and recipe `allowedTools` seed the existing
Session permission allowlist. `unlistedTools` defaults to `ask`; `deny` refuses
unlisted tools and native questions without publishing an approval request.
The existing permission matcher owns exact tool names, trailing MCP wildcards
(`mcp__server__*`), shell rules, and absolute scoped Read rules
(`Read(/attachments/**)`). Scoped reads require realpath containment, so a
symlink cannot grant access outside the selected directory. Tool policy travels
with private Session metadata and native configuration, not shared presentation.
The birth seed also preapproves listed external MCP calls for admitted Channels
inputs without producing a reusable remote grant. Later interactive approvals
remain source-bound; causal, workspace-role and Happier Action ceilings still
apply. A listed builtin writer does not bypass a read-only ceiling.

Agent adapters enforce that same policy at native bypass boundaries. Claude
removes unlisted built-ins and uses the existing fail-closed PreToolUse hook for
every remaining call; native `dontAsk` alone does not confine scoped reads.
Codex's supported native configuration removes shell and other ambient execution
tools, selects only matcher-approved MCP tools from the real server catalog, and
excludes the native `functions` code-mode namespace so MCP resource built-ins
cannot bypass the list. Its own WebSearch stays disabled unless listed.
Unsupported native surfaces refuse a confined launch rather than silently
ignoring policy. These are source contracts, not a claim that an already-running
daemon has loaded them; native runtime/model support must be verified at launch.
The current Codex MCP proof covers native app-server 0.162.1 with its own native auth
and a model whose actual native catalog declares `code_mode_only`. Direct-tool
models can bypass the namespace exclusion, so MCP-connected launches reject them
before a turn; unknown runtimes and external auth changes for those launches are
also rejected rather than using
another Account's model-catalog evidence. ACP, daemon-proxy and direct-terminal
variants without equivalent enforcement do not claim confinement.

Whole-Session permission reset reaches the existing Session request store even when the current coordinator has no local waiters, including after handler replacement. The store cancels pending requests and delivers their response targets. Cancellation waits for in-flight coordinator completion persistence before writing the terminal result; plugin-scoped cancellation retains its owner filter and performs no write for an empty local scope.

In development source, a `message-delta` can supply the same stable `messageId` as its
`transcript-message-committed` event. The host stream bridge uses that identity for live and
durable rows and separates distinct messages within a turn; Agents without a witness retain
the existing generated stream identity. OpenCode derives its stable ID through the same
provider-session/message helper used by history import, so cold reconciliation recognizes
streamed rows without a second persisted format or native-ID parser.

In current 0.3 development source, transcript output (`message-delta`, tools, file edits and
committed text) may omit the host `turnId`. Such output is Session scoped; output with a
`sidechainId` is also Session scoped, even when it records an originating host turn.
The shared [scope owner](../apps/cli/src/agent/runtime/session/events/runtimeTranscriptScope.ts)
keeps foreground lifecycle, token hooks, change tracking, tool execution and required
foreground transcript custody separate from this output. Foreground output with a turn
and no sidechain still requires the active host turn. All output retains strict schema,
Session identity, sequence and runtime-lifetime admission. Foreground boundaries flush
only foreground streams; a successful authoritative text commit retires its matching
stream through the existing stable message identity. Native child turn identifiers stay
in provider-owned evidence rather than claiming a host foreground turn.

Both the host and public SDK Session-to-Run projections admit assistant/reasoning
deltas and committed text only with proven foreground scope. An omitted turn id
does not authorize Run output. Claude captures the admitted turn with each SDK
query; output arriving after that query is cancelled or its foreground work
completes remains Session scoped even while a newer query runs. OpenCode carries
the provider owner's proven turn and child scope into its detached Run adapter,
preserving committed-message identity rather than relabelling snapshots.

Agent-specific protocol leaves live in `packages/plugins/<agentId>/src/agent/**`. Shared ACP composition, process/terminal transport and host lifecycle stay generic in the CLI. Detection, installation and process launch follow [binary runtime](binary-runtime.md); model-source selection and materialization follow [Providers](providers.md).

### Session Account-action authority (0.3 development)

The daemon's existing
[`createDaemonSessionAccountActionExecutor`](../apps/cli/src/daemon/agentRuntime/createDaemonSessionAccountActionExecutor.ts)
does not treat process/Session custody as permission to use its Account
credentials. Before executing an Account Action, and at the executor's
currentness boundary, it reads the exact Session through its authenticated Home
and requires the canonical owner projection plus current runtime custody.
Recipient, missing, malformed or retired callers refuse; they never borrow the
Machine custodian's Account. Shared requester execution uses its own admitted
per-Session requester Home and protected credential custody. This owner-only
guard is not that shared execution channel or loaded-runtime certification.

The development requester projection attaches private Account ports to the
existing `ExternalActionExecutionAuthorizationV1` carrier. Its non-enumerable
host-local facet contains the requester Project-row cipher and qualified Artifact
reader, not serialized keys. The strict wire authorization schema is unchanged.
The admitted bootstrap produces this facet; consumers check its currentness at
their Account effect. An arbitrary Machine request without that private producer
cannot select another Session's custody or borrow custodian Account material.

Same-account Machine starts stamp nonsecret Home, requester Account, Machine and
installation attribution from the verified Machine admission context. The
existing accepted-spawn marker writer and exact-process adoption carry these
facts across recovery; an old marker without them stays unknown. Attribution is
not authorization, and server metadata cannot manufacture it. The transient
admission-currentness callback stays with the live launch and is never persisted
as respawn state. In current 0.3 development, an original Account Action for a
shared Machine start carries installation-sealed requester custody. The existing
daemon `prepareRequesterSessionBootstrap` wrapper accepts that admitted Account
context as well as existing per-Session custody; attribution and currentness come
from the verified binding, never caller-authored spawn fields. Failed launch
cleans the prepared custody through the same owner. UI and CLI requester starts
use this Action path; raw custodian-only spawn methods remain refused. Existing
requester resume restores the original Session's protected custody through
`session.open`, without substituting the Machine custodian's Account. Other
foreign Session/run/workflow starts still refuse until their own requester
bootstrap is available. This is source behavior, not released availability or
loaded-runtime certification.

### Triggers at Session birth (0.3 development)

The strict [`session.spawn_new` input](../packages/protocol/src/sessions/creation/sessionSpawnNewInputV2.ts) accepts `initialTriggers` through the same Session trigger vocabulary as `session.trigger.*`. A birth draft supplies neither a source Session id nor a current-turn identity. The existing [Workflow trigger Action owner](../packages/protocol/src/actions/executor/workflowTriggerActions.ts) validates target and agent-start policy and seals the intent; UI, Agent and MCP callers do not write triggers after spawning.

The [layout-1 Session row writer](../apps/server/sources/app/session/create/layout1SessionRowWrite.ts) binds each intent to the newborn Session and invokes the canonical Automation creation and lifecycle-occurrence owners in the same transaction. Session, triggers and an eligible `sessionStarted` occurrence commit together, or a typed `initial_trigger_admission_failed` refusal rolls back the birth. Ordinary Session trigger CRUD still refuses retrospective `sessionStarted` registration. PR/CI and plugin-event sources cannot be admitted by this birth path until their source prerequisites are available. This describes current source wiring, not completed loaded-runtime validation or released availability.

For signed Session archives, the [archive route](../apps/server/sources/app/api/routes/session/registerSessionArchiveRoutes.ts) authenticates the claimed originating Run against its publisher, Account access and assigned Machine before passing it into the transactional lifecycle occurrence. The [Run cause codec](../apps/server/sources/app/automations/automationRunCauseCodec.ts) retains this optional archive-origin fact in the nullable `AutomationRun.causeOriginRunId` column, separate from private Account evidence and Session creation origin. The existing [trigger cause-chain owner](../apps/server/sources/app/automations/automationTriggerCauseChain.ts) follows that retained ancestry to suppress a trigger already responsible for the archive before admitting another Run. An unsigned archive does not infer archive ancestry from Session birth. This is an unreleased 0.3 source contract.

## Execution Run launch selection

In 0.3 development source, [`ExecutionRunHostBridge`](../apps/cli/src/agent/runtime/bridges/executionRun/ExecutionRunHostBridge.ts)
supplies attachment context to [`startExecutionRun`](../apps/cli/src/agent/runtime/bridges/executionRun/startExecutionRun.ts).
Its [child-selection owner](../apps/cli/src/agent/runtime/bridges/executionRun/runtime/openInputs.ts)
completes omitted model and credential-route choices before materialization.
Explicit native, Provider, role and Workflow choices keep precedence. Detached
work retains its independent Account-default contract.

The host-private Session reader combines the model-transition coordinator's
admitted applied target with the scoped daemon's existing applied Connected
Services registry. Pending intent alone neither supplies nor invalidates an
otherwise readable applied choice; an actual unresolved effect or unavailable
owner refuses inheritance. Pool references retain the pool, not its selected
member, credential or activation. Cross-Agent Provider choices use the existing
Provider authorization and Agent adapter owners, rather than another selector.

When the accepted native open proves no applied Connected Services, the runner
starts its initial absence registration with that daemon registry in the
background. Ordinary prompt admission does not await it. Child inheritance and
subsequent auth application join the same registration before using or changing
that authority; inheritance still reads the current applied registry and refuses
unavailable facts. Required launch authorization, credential preparation, Session
custody and prompt preparation retain their existing admission owners. These
are 0.3 development-source contracts; the startup phase records in the runner
and daemon support the next loaded-runtime latency probe.

Resolved safe choices stay in the existing retained Run launch record. Resume
does not consult a changed parent or Account default. The additive
`resolvedSelection` summary is a projection of that record, not another persisted
route or an authorization input. Start, activity, finish and host-loss markers
retain this same projection, and Run rows consume it with the Run's exact Home.
Older markers without a summary can use the matching transcript's summary;
absence is not permission to infer a route from current defaults.
Voice chat and commit resolve their choices
separately; unsupported Team custody refuses before a Voice Run is published.
These source contracts do not certify the composed loaded-runtime journey.

Managed Provider preparation for a Run consumes its actual admitted controller
occurrence and cancellation lifetime. The host-private source adapter supplies
the issued Account snapshot and qualified-purpose resolver to the incumbent
Provider catalog/source owners; it does not borrow another active Session's
Account or create a second scheduler. Direct Provider materialization revalidates
that source before commit/backend creation. Attached source operations use the
existing private runner-to-daemon transport and authenticated Session Run RPC;
the actual Run record must attest the accepted Provider connection/model and
Agent target as well as the current occurrence. A cleanup handle never supplies
that authority. After daemon replacement, a fresh read carries the original
proof and re-admits that same target; it does not replay an existing stream.
The composed loaded-runtime journey remains part of unreleased Providers
integration validation.

Voice Runs use the same controller-occurrence registry during native MCP
provisioning. The Voice manager supplies custody only after an actual nested
runtime exists and while its lifetime is live; accepted startup alone supplies
no proof. Its ready-state authority remains unpublished until startup settles.
Chat and isolated-commit runtimes share their controller occurrence, while a
resumed controller receives a new identity. Stop, replacement and settlement
retire the proof. OAuth request-auth issuance still requires the exact current
Run occurrence and parent Session through the existing broker check.

## Execution Run recovery and observation

Finite Run startup can recover an explicit Connected Account model rejection
before accepting the initial input. The Agent supplies sanitized rejection
evidence; the native host withholds terminal projection only while opening a
fresh Run with no observed progress or output. The existing lazy Run owner asks
the scoped daemon materialization bridge to validate that exact activation and
member, then disposes/releases it, rematerializes the next eligible pool member,
and replays the same unaccepted input. The pool coordinator owns the model
cooldown and selection. A rejected start is exempt from turn/hour switch limits;
accepted turns, partial output, unknown custody and native resume failures do
not authorize replay. Pool exhaustion names the requested model in a typed
error. The canonical detached Run host supplies descriptor-bounded native-home
reads and Run-scoped authentication refresh. Session and Run adapters share the
host refresh core and daemon refresh authority; the Run control channel retains
the exact runner and materialization activation, without inventing a Session id.
Session-owned Runs keep their genuine parent Session projections while binding
authentication refresh to the Run's own materialized account.
Refresh distribution notifies only current genuine Session targets; a Run's
shared runner PID or retained parent Session id does not authorize a Session update.
Refresh and acknowledgment continuation require exact member/generation and
persisted revision proof. Only the same live occurrence can accept its own
settled credential-revision transition; process replacement or reselection
invalidates that authority.
This is an unreleased source corridor, not a claim of loaded-daemon validation
or released availability. The corridor does not restart the parent Session.

In current 0.3 development source, accepted-turn failures in finite, retained
and detached Runs enter the existing Connected Account recovery pipeline before
terminal Run projection. Session and Run scope share classification, policy,
result disposition, temporary-throttle waiting and continuation admission;
scope adapters supply the exact target, account materialization and cancellation.
Provider-native failure facts without a member identity are qualified against
the current registered binding, never an invented account selection. A Run
disposes its failed native runtime before rematerializing, resumes the same native
conversation/checkpoint and sends only the configured continuation with a fresh
input identity. Partial output is retained; the accepted input is not replayed.
Stopping a Run's wait does not cancel or fence its parent Session. Refused
recovery or native resume failure follows the ordinary terminal failure path.
Pre-admission rejection and unknown input custody remain authoritative and do
not authorize automatic continuation, even when their diagnostics retain
provider health evidence. Successful native completion records the same
scope's outcome before completion waiters settle, clearing its capacity streak.
Account replacement preserves the Run's existing lifetime switch budget.
This is source behavior; the loaded-daemon journey still needs validation.

Native authentication is carried by `context.session.services.auth` for a
Session runtime and the existing `context.executionRun.services.auth` for a
detached Run. Both use the same daemon refresh owner, bound to their actual
scope and lifetime. A Session-owned Run refreshes its own materialization;
this capability neither requires nor grants general `services.sessions`
access. Action consumers with declared Session access retain their genuine
Session-handle auth API.

The execution host bridge retains private Run control state through the existing
device-local execution registry, sealed separately from disposable visibility
markers. Admission and checkpoints retain re-resolvable launch selections,
exact input observations and native resume identity; they do not retain active
turn authority or materialized credentials. Scoped reads and resume admission
recover this state at the bridge owner. A live foreign host's record does not
authorize another bridge to recreate its controller.

Existing process supervision records proven host death or PID reuse as
`execution_run_host_lost`, not transport disconnection or inconclusive process
recognition. The interrupted input
fails, the native handle determines recoverability, and the retained failure
points to the partial transcript. The same fact feeds reads, waits and the
existing acceptance-ACKed WorkerUpdate path. Neither an unpaired transcript
call nor a historical `running` result proves current liveness. Resumable control
state survives marker collection; ephemeral terminal state follows the existing
terminal visibility lifetime once pending parent delivery is settled.

In current development source, the existing connected-service home reclamation
scheduler also sweeps execution-run isolation homes. It reads live Run markers
and retained Run records through the execution registry, and uses the canonical
Run lifecycle projection to retain homes with a native resume handle. Unknown
custody prevents reclamation. The same sweep preserves non-symlink local
transcripts and manifest-declared resume state. Materialization persists the
Agent descriptor's native-state inventory separately from managed shared entries;
predecessor homes without that inventory retain their known native-state paths.
Unreadable or malformed inventory refuses reclamation, and shared native-home links alone
do not retain an orphan. Server Session references include active, inactive
and archived Sessions, and incomplete metadata or pagination refuses reclamation.
Materialization exit defers Session `csm_` homes to that server-aware sweep.
Exit, adopted-root and direct isolation cleanup preserve local resume state;
private declared native state survives credential rematerialization without
following shared-state links. Import, promotion and cleanup refuse redirected
child homes, including an aliased attempts directory, rather than following them
within or outside the configured base. Runtime and credential leases still retire at exit. The
existing orphan age and cleanup tick govern later reclamation, without another
timer or registry. These source contracts are not loaded-daemon certification.

Reopened retained Run records, control state, public markers and pending WorkerUpdates use the protocol's canonical stored-read projection: additive fields are dropped recursively, while malformed known facts still refuse. Custody comparison and acceptance ACK use that same projection. Device-local sealing, Run identity checks and new writes remain strict; stored-read tolerance does not authorize a new input or a different Run.

Current development source projects current execution-run work from the existing public `status`, `runClass` and optional `turnInFlight` through Protocol's `isExecutionRunActive`. A running long-lived handle with an observed `turnInFlight: false` remains available for follow-up without contributing background work. Bounded runs remain active through outcome settlement, while provisioning and older producers without a turn observation remain conservatively active. The bridge publishes work changes through its existing public-state source; the Session observer and roster consume the same classification. Voice work follows its existing setup, turn and lifecycle promises together with the current runtime turn witness. Reachability, retained lifetime and current work remain separate facts.

A retained provider-session handle proves which native session to resume, not that its state still exists. A definitive native resume rejection is classified by the Agent plugin; Codex's `thread/resume` application rejection for missing rollout state carries `AGENT_RESUME_PROVIDER_STATE_MISSING` through startup sanitization. The host resume owner records `execution_run_provider_state_missing`, and the lifecycle owner projects that retained Run as unavailable. Transient or unclassified failures remain indeterminate. Recovery never substitutes a fresh native thread for the requested identity.

CLI `execution.run.wait` observations reattach to the original Run through the existing connection supervisor after transport loss. Reattachment invokes the same daemon event-backed wait, without launching work, replaying input or polling `execution.run.get`. A disconnected occurrence cannot settle the observation with a late acknowledgement. Caller cancellation retires only that waiter. The service's original finite observation deadline spans connection, reconnect and snapshot output backpressure. Requests resubmit the remaining budget with the wire's existing one-second quantum, while the caller signal enforces the precise deadline. Expiration ends observation and returns `ok:false, code:'observation_timeout'` when no completed owner reply is available; it supplies no invented Run status and does not reconnect after expiration. Unbounded observations remain unbounded.

Input admission is not turn completion. The execution bridge's send acknowledgement
settles when the input is admitted, including bounded recovery; later output and
outcome settlement remain with the same retained Run. The existing
`execution.run.get({ waitForInputId })` request observes an exact current/last input
turn when its caller has that identity. It does not create input or await every
future turn of a long-lived Run. Run-terminal observation uses `execution.run.wait`
and the completion barrier below, rather than interpreting send success as output.

Terminal and combined terminal matches, including an initially terminal public snapshot, cross the host's completion barrier and then re-read the settled result. A terminal projection alone can precede transcript publication and retained completion custody, whose failure can change the Run's final status. Expiration during that barrier returns an observation timeout rather than matched completion. Passive state snapshots remain immediate projections, and an attention-only observation does not treat terminal state as an attention match.

The same observer accepts terminal, permission-attention, or combined conditions.
Attention is a projection of outstanding requests for the live controller
occurrence in the existing permission store, not a second permission ledger.
Passive observation returns an initial snapshot and then parks on the bridge's
existing state-change source with the last snapshot. Reconnect recovers current
state rather than missed event history, and snapshot delivery backpressure
survives reconnect. A deadline ends observation only; an unmatched attention
condition preserves the actual terminal snapshot in its timeout result. The
daemon re-arms long deadlines in Node-supported timer chunks without capping
the requested duration. Generic `wait`/`watch` consumers must explicitly adopt
these owner APIs; this source seam does not itself certify their integration.

## Retained SCM output publication

In 0.3 development source, a proven input refusal before any provider effect
settles an idle retained Run through the execution bridge's existing terminal
owner. The profile's terminal hook publishes failed saved outputs while retaining
usable earlier content. Pending keeps the refused input blocked; recovery admits
a separate input rather than replaying that refused row. A refused intervention cannot end
another active turn, and uncertain provider effects retain their existing custody.
Host pre-effect checks do not replace an incumbent turn's accepted input anchor.
Native dispatch installs its custody fence before effects are possible; only a
positive durable refusal can retain the active incumbent anchor. An unknown
native outcome continues to hold publication until its exact input is classified.
Loaded daemon/runner replay remains a separate validation boundary.

SCM explanation Runs use the existing `resumable` retention policy and
`long_lived` class within Session-owned or detached retained interaction. The host's
per-turn completion seam invokes `ScmDiffSummaryProfile`, validates structured
output against captured occurrences and publishes through the revisioned machine
result owner. A settled output does not imply that the native Run terminated;
ordinary chat does not write the result. Review narration consumes the same
publisher after findings settle. Detached narration retains null Session
association and uses the same Run sender, captured repository and protected
requester scope; Session narration keeps its Session Pending admission.
Input admission, cancellation, recovery and
generator replacement stay at their existing host owners. See
[SCM comparisons and walkthroughs](scm-diff-summary.md) for output, revision,
discussion and currently unverified integration contracts.

## Rules for changes

- Extend the owning host path and migrate its callers together. Do not add another Agent registry, lifecycle loop, prompt queue, permission owner, thinking flag or whole-metadata state writer.
- Use the canonical `AgentSessionRuntimeEvent` schema at ingress and its public SDK projection. Host lifecycle/session/runtime event namespaces are host-emitted; a plugin emits native evidence through the admitted Agent seam.
- Keep terminal/remote mode orchestration and cleanup at the host. An Agent declares its surfaces and native operations rather than choosing host policy.
- Keep UI activity and transcript views as projections of canonical facts. Retained UI data during refresh is not authority to admit new work.
- Retired public surfaces such as `RuntimeCoreV1`, `AcpSessionRuntimeV1`, `RuntimeControlContribution` and `RuntimeEventV1` must not regain consumers. [`agentRuntimeSurfaceContract.ts`](../packages/plugin-sdk/src/agentRuntimeSurfaceContract.ts) records the negative public contracts. Preserve a necessary released compatibility translator only at its seam, under [compatibility](compatibility.md#sdk-protocol-evolution).

## Related

[Plugin platform and SDK](plugin-platform.md), [Agent catalog](agents-catalog.md), [CLI architecture](cli-architecture.md), [Actions](actions.md), [encryption](encryption.md), [testing](testing.md).
