# Agent runtime ownership

The host owns the executable Session and turn lifecycle. An Agent plugin supplies its native protocol, correlation and evidence through the public SDK; the host admits input, coordinates work, publishes lifecycle and writes the canonical transcript. Session interaction and finite Execution Runs use that same ownership boundary.

This page describes **0.3 development source**, not a shipped release or a completed live-validation gate. It is the standing architecture reference; approved plans remain the execution contract for their assigned work.

## Native Agent seam

[`AgentRuntime`](../packages/plugin-sdk/src/agentRuntime/runtime.ts) has two mutually exclusive forms: a Session factory or an execution-only Run factory. A Session-capable Agent does not supply a second finite Run implementation. The host binds its Session runtime into the shared Execution Run adapter in [`nativeAgentExecutionRun.ts`](../apps/cli/src/agent/runtime/bridges/executionRun/nativeAgentExecutionRun.ts). The shared SDK implementation in [`executionRun.ts`](../packages/plugin-sdk/src/agentRuntime/executionRun.ts) owns correlated Run events, cancellation, terminalization and disposal for the finite/conversation adapters.

The engine registry's [`runtimeCore.ts`](../apps/cli/src/agent/runtime/registry/engineRegistry/runtimeCore.ts) resolves the admitted Agent runtime and composes host services. Agent code receives the scoped public context, not raw host lifecycle controls. Agent-native configuration in `RuntimeDescriptorV1.agent` is interpreted by its Agent; generic host code must not infer its meaning from an Agent id.

Session-owned child Runs retain their own transcript sidechain and interaction scope. They cannot publish the parent Session's work-state or active-input readiness; those projections belong to the main Session context. Finite and retained child contexts use the same Run-scoped work-state service, which reports Session projection as unavailable.

In current 0.3 development source, the daemon's [admission drain](../apps/cli/src/daemon/lifecycle/admissionDrain.ts) owns fresh-work quiescence. Temporary drain preserves accepted custody, native request-auth and daemon publications; reopening wakes the incumbent Automation claim loop and parked Workflow admission. Fresh turn and managed-process authorization remain closed during drain. Plugin handoff retains its own exclusion and publication custody. Final shutdown closes admission irreversibly and awaits the existing finite-operation owner's actual settlement before disposing native plugin leases, terminals or roots. Unconfirmed Stop retains that custody and keeps observation and explicit repeated Stop reachable; it does not prove settlement. Session-hosted Execution Runs ask that current daemon owner over the scoped control transport before creating a Run; an unavailable admission reply refuses the new start. Retained Run state stays with the [execution registry](../apps/cli/src/daemon/executionRunRegistry.ts), rather than becoming another drain decision or start registry. These source contracts are distinct from loaded-daemon certification.

Finite Windows PTY work now consumes the existing [native process-custody owner](../apps/cli/src/subprocess/supervision/processCustody.ts), not ConPTY's root-exit notification as a descendant-settlement fact. Its finite helper mode assigns the actual target to the same Job before execution, retains the Job until positive kernel membership absence, and returns the recorded root exit code. Ordinary managed-service helper semantics remain separate and unchanged. Completion-port notifications may be lost; explicit Stop queries/terminates that same established Job and a positive zero-membership result wakes the retained helper. A Get/Wait or output EOF alone is not this recovery. Consumer, native-platform and loaded-runtime validation remain open in development source.

POSIX natural-root uncertainty preserves the original exit waiter, cancellation subscription, output custody and finite reservation until a positive owned-group settlement or explicit recovery. That group witness does not itself prove that a non-disowned descendant in another process group exited; the job-control process-tree validation remains open. Native preparation's host-private Exec custody similarly must retain its actual supervisor resource through unconfirmed cleanup, rather than treating callback completion as process settlement.

### Managed activity inventory

The daemon's [managed activity inventory](../apps/cli/src/daemon/lifecycle/managedActivity.ts) reads the incumbent Session/input, execution budget and marker, Action operation, PTY, Workflow, Service, transfer, Sync and installation owners. It is a private projection, not another work registry. Missing or failed applicable coverage remains unknown. The transfer bootstrap can prove absence when its canonical configuration explicitly disables direct transfer; an unavailable enabled owner cannot make that claim. The requester summary projector takes this same inventory input; its authenticated reader and authorized requester identities remain a separate Machine-access seam. Retention-only custody is not reduced to the summary's three public count columns.

Session absence requires exact committed runtime activity and a fresh Pending snapshot, including accepted, returned-batch, preparing and dispatched input custody. Content-free host notifications invalidate observations; they do not authorize idle. A foreign requester's unavailable Session transport remains unknown. External execution markers are observed on demand through the existing registry's native directory watcher; uncovered or failed observation cannot prove idle.

In 0.3 development source, semantic withdrawal uses the existing [Pending mutation owner](../apps/server/sources/app/session/pending/pendingMessageService.ts) through `POST /v2/sessions/:sessionId/pending/:localId/withdraw` and its Run-scoped sibling. Its result distinguishes confirmed removal from consumed custody or uncertainty. Only confirmed removal can restore the captured structured composer document, and only while its Account/Home and document revision remain current. Legacy Pending `DELETE` remains a separate primitive: predecessor success without that semantic result is not proof that input was withdrawn. An older server's unsupported semantic POST must not fall back to a mutating DELETE. These wire semantics do not certify the still-unverified composed cold-wake or UI integration paths.

Aggregate idle begins only after all applicable owners prove settlement. Real owner invalidations reset that interval, and an asynchronous snapshot invalidated during its read cannot confirm idle. The authenticated guest bridge rechecks the exact retained row, revision and controller around a fresh closed-admission read. Its unused-stop cause can reopen independently of temporary drain, plugin handoff and irreversible shutdown. Only the safe activity decision is published through existing Machine daemon-state updates; references, attribution and content stay private. A committed idle bridge reply can additionally carry the current guest installation's signed evidence, binding that exact row and guest-measured interval. These are development-source contracts, not loaded-runtime certification.

An external after-idle Stop/Delete uses the original accepted Action root and
controller installation signature through the existing Machine transport. Home
derives the private activity/drain destination from that same current control
request and exact retained guest, while rechecking the original requester's
Manage admission. Only this proved controller receives its custodian guest key
envelope for the transport codec; requester Account key material is not borrowed.
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

## Session path and owners

| Responsibility | Canonical host owner |
| --- | --- |
| Session construction, runtime/context binding and startup | [`runHostSessionRuntime.ts`](../apps/cli/src/agent/runtime/session/loop/runHostSessionRuntime.ts) |
| Runtime event subscription, effective thinking, keepalive, mode orchestration and cleanup | [`session/loop/lifecycle.ts`](../apps/cli/src/agent/runtime/session/loop/lifecycle.ts) |
| Input pumping, permission-mode application, prompt admission and turn execution | [`runPermissionModePromptLoop.ts`](../apps/cli/src/agent/runtime/runPermissionModePromptLoop.ts) |
| Accepted turn facts and lifecycle publication | [`session/turn/lifecycle.ts`](../apps/cli/src/agent/runtime/session/turn/lifecycle.ts) |
| Runtime event validation and stream publication | [`agentSessionRuntimeEventStream.ts`](../apps/cli/src/agent/runtime/session/events/agentSessionRuntimeEventStream.ts) |
| Transcript event projection | [`projectRuntimeTranscriptEvent.ts`](../apps/cli/src/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent.ts) |

The lifecycle owner consumes validated `AgentSessionRuntimeEvent` evidence, projects turn/transcript facts and supplies the prompt loop's thinking setter. The strict event union is owned by [`runtime/agentSessionV1.ts`](../packages/protocol/src/runtime/agentSessionV1.ts); [`plugins/events/hostV1.ts`](../packages/protocol/src/plugins/events/hostV1.ts) validates Host Event payloads through that same schema. Native callbacks do not become a second host state machine. Historical replay/follow and external-session discovery remain distinct from live input and transcript publication; they must not start another prompt loop or durable transcript writer.

The [input consumer](../apps/cli/src/agent/runtime/session/input/sessionProviderInputConsumer.ts) owns provider-input dispatch custody and admission quiescence. Ordinary dispatch and model-transition admission transfer use the same async custody scope. A runtime replacement initiated within an active dispatch retains that custody and drains other dispatches plus pending materialization; it does not wait for itself. External replacements drain all dispatches. Settled dispatch scopes cannot lend custody to later asynchronous continuations. This is a 0.3 development-source contract; native reply verification is separate evidence.

In 0.3 development, a missing launchable Agent CLI carries `agent_cli_missing` from both the command/terminal launch owner and the native plugin system-tool binding. Startup sanitization preserves that code; the primary Session issue classifier projects `dependency_failure` with static installation/path remediation. It does not expose raw startup error text or infer acceptance from a failed prerequisite.

The Session MCP owner refuses an unavailable daemon plugin catalog with
`daemon_plugin_catalog_unavailable`, rather than interpreting it as an empty
catalog. Before the live loop takes ownership, the construction owner projects
this prerequisite failure through the canonical turn lifecycle and drains its
durable mutation admission before releasing Session custody. The issue uses
`dependency_failure` and static daemon-connection remediation; it does not imply
missing Agent credentials. Once startup is admitted, the standalone GET
notification stream uses the startup registrations without a fresh catalog read:
the MCP transport cannot dispatch tools from GET. POST requests and native tool
RPCs still require the current executable catalog and fail closed when it is
unavailable. Daemonless runtimes retain their explicitly supplied registry lease.
These are development-source contracts, not completed live proof.

Accepted spawn nonce observation uses the daemon Session startup budget by default. Explicit finite observation durations are not reduced by phase-local caps; detached abandoned-spawn stop/archive observation retains its separate ten-minute default. The CLI nonce observer, daemon nonce endpoint, target RPC handler and shared acknowledgement race re-arm long deadlines in Node-supported timer chunks. Relay forwarding retains Socket.IO's native signed-timer boundary (about 24.8 days), so these local owners do not establish unbounded end-to-end relay observation.

Creation, inactive resume, tracked handoff and detached cleanup reattach the same accepted spawn nonce through the existing RPC connection supervisor after transport loss. Reconnection resubmits the remaining observation budget; it never sends another spawn. The original deadline and cancellation span reconnect, and settlement retires the underlying observation. Late acknowledgements from a disconnected connection cannot settle the resumed waiter. This describes current development source, not loaded-daemon certification.

In 0.3 development source, Session socket ACK writes wait under the existing
connection supervisor while startup is offline. The transport's connect timeout
bounds an individual attempt; it does not also terminate the waiting Activity
publication or publisher claim. Online connection resumes the write, while
authentication failure or Session disposal rejects it. The transport retains its
per-attempt timeout and reconnect policy. This source recovery contract is
distinct from a successfully loaded native Agent turn.

Tracked handoff accepts cancellation during preparation, then closes cancellation immediately before target launch begins publishing canonical Session metadata. Confirmation, commit and source cleanup use the completion signal after that point; a late cancel request cannot abandon the accepted target launch.

`SessionHandle.watch` follows committed retained transcript rows through the shared socket source and delivers complete text before advancing its reconnect frontier. Provisional stream deltas do not become retained message events. Cancellation ends the watcher; credential and plugin-occurrence checks prevent further delivery after retirement.

For cold native history catch-up, a Session factory may declare `transcriptIdentity`, its pure provider-owned identity codec. The bound `transcripts.reconcileSourceIdentities` operation uses the canonical paginated transcript reader and encryption/semantic decoder, filters conversation rows to the selected Agent, and supplies only the codec's declared correlation fields. It checks the current Session, plugin occurrence and native Session identity before and after the read. Unsupported, failed or malformed reads reject rather than becoming empty coverage. OpenCode hydrates its existing authored-ID tracker from exact committed identities, including witnessed 0.2 predecessor mappings and import IDs. Its current percent-encoded import IDs preserve opaque identity tuples; the predecessor codec compares complete constructed legacy or JSON-tuple IDs only after checking a separate exact native-session witness, never by splitting opaque IDs. Unprovable legacy coverage is reported through the existing informational Session-event and default log owners; only that historical snapshot is suppressed, so subsequent settled native turns can still sync. No new identity registry or transcript writer is introduced. These current-source contracts are distinct from full authenticated live validation of the composed 0.3 runtime.

Normal input and in-flight steer use the shared [host dispatch preparation](../apps/cli/src/agent/runtime/turns/prepareSessionInputForProviderDispatch.ts). It delegates selected skills, plugin references, attachments and media to the canonical structured-input resolver immediately before provider effect. The resolved envelope reaches the Agent through the same typed turn metadata, and its JSON projection counts toward required context before optional Follow context is fitted. Native slash commands retain their leading grammar with resolved context after it. Resolution failure is rejected before provider effect with its existing diagnostic and retryability; an undispatched replay-seed association is released. Steering rechecks Session binding, turn availability and admission after asynchronous preparation. This describes 0.3 development source, not completed loaded-runtime validation.

The [Session prompt-plan producer](../apps/cli/src/agent/prompting/coding/sessionPromptPlan.ts) prepares coding policy through the canonical Launch Profile reader, including authorized published-profile Artifacts. Prompt rendering, title-tool advertisement and permission admission consume that same prepared fact. Session-owned retained Runs read it through the existing internal runtime-control binding; their Run intent id is not a Launch Profile id. A missing or retired producer, or failed preparation, withholds title-tool advertisement and admission until the policy is available again. An unresolved profile retains the canonical Account-default policy. No new policy wire field or persisted policy copy is introduced.

The host fits retained WorkerUpdates against the current optional context allowance before dispatch. A still-deliverable wake that cannot fit stays with the input consumer until context/source, metadata, admission or user input changes; parking neither commits a transcript event nor acknowledges provider acceptance. Source admission is rechecked before parking, so a withdrawn wake releases custody even if it still cannot fit. User input keeps priority, and the retained wake is reconsidered afterward without selecting its producer again.

Native interaction lifetime is separate from causal turn identity. Ordinary requests default to turn lifetime and retire with the matching terminal turn (including ordinary requests without a turn witness); native Codex asynchronous questions explicitly use occurrence lifetime. Those questions keep their causal turn id after completion and retire when their Session/plugin occurrence retires. The permission coordinator owns this distinction; terminal callbacks do not cancel every request owned by the plugin.

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
as respawn state. Foreign Session/run/workflow starts still refuse before using
custodian policy or credentials until their requester bootstrap is available.

### Triggers at Session birth (0.3 development)

The strict [`session.spawn_new` input](../packages/protocol/src/sessions/creation/sessionSpawnNewInputV2.ts) accepts `initialTriggers` through the same Session trigger vocabulary as `session.trigger.*`. A birth draft supplies neither a source Session id nor a current-turn identity. The existing [Workflow trigger Action owner](../packages/protocol/src/actions/executor/workflowTriggerActions.ts) validates target and agent-start policy and seals the intent; UI, Agent and MCP callers do not write triggers after spawning.

The [layout-1 Session row writer](../apps/server/sources/app/session/create/layout1SessionRowWrite.ts) binds each intent to the newborn Session and invokes the canonical Automation creation and lifecycle-occurrence owners in the same transaction. Session, triggers and an eligible `sessionStarted` occurrence commit together, or a typed `initial_trigger_admission_failed` refusal rolls back the birth. Ordinary Session trigger CRUD still refuses retrospective `sessionStarted` registration. PR/CI and plugin-event sources cannot be admitted by this birth path until their source prerequisites are available. This describes current source wiring, not completed loaded-runtime validation or released availability.

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
transcripts and manifest-declared resume state; shared native-home links alone
do not retain an orphan. Server Session references include active, inactive
and archived Sessions, and incomplete metadata or pagination refuses reclamation.
Materialization exit defers Session `csm_` homes to that server-aware sweep.
Exit, adopted-root and direct isolation cleanup preserve local resume state;
private declared native state survives credential rematerialization without
following nested shared-state links. Runtime and credential leases still retire at exit. The
existing orphan age and cleanup tick govern later reclamation, without another
timer or registry. These source contracts are not loaded-daemon certification.

Reopened retained Run records, control state, public markers and pending WorkerUpdates use the protocol's canonical stored-read projection: additive fields are dropped recursively, while malformed known facts still refuse. Custody comparison and acceptance ACK use that same projection. Device-local sealing, Run identity checks and new writes remain strict; stored-read tolerance does not authorize a new input or a different Run.

Current development source projects current execution-run work from the existing public `status`, `runClass` and optional `turnInFlight` through Protocol's `isExecutionRunActive`. A running long-lived handle with an observed `turnInFlight: false` remains available for follow-up without contributing background work. Bounded runs remain active through outcome settlement, while provisioning and older producers without a turn observation remain conservatively active. The bridge publishes work changes through its existing public-state source; the Session observer and roster consume the same classification. Voice work follows its existing setup, turn and lifecycle promises together with the current runtime turn witness. Reachability, retained lifetime and current work remain separate facts.

A retained provider-session handle proves which native session to resume, not that its state still exists. A definitive native resume rejection is classified by the Agent plugin; Codex's `thread/resume` application rejection for missing rollout state carries `AGENT_RESUME_PROVIDER_STATE_MISSING` through startup sanitization. The host resume owner records `execution_run_provider_state_missing`, and the lifecycle owner projects that retained Run as unavailable. Transient or unclassified failures remain indeterminate. Recovery never substitutes a fresh native thread for the requested identity.

CLI `execution.run.wait` observations reattach to the original Run through the existing connection supervisor after transport loss. Reattachment invokes the same daemon event-backed wait, without launching work, replaying input or polling `execution.run.get`. A disconnected occurrence cannot settle the observation with a late acknowledgement. Caller cancellation retires only that waiter. The service's original finite observation deadline spans connection, reconnect and snapshot output backpressure. Requests resubmit the remaining budget with the wire's existing one-second quantum, while the caller signal enforces the precise deadline. Expiration ends observation and returns `ok:false, code:'observation_timeout'` when no completed owner reply is available; it supplies no invented Run status and does not reconnect after expiration. Unbounded observations remain unbounded.

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

SCM explanation Runs use the existing `resumable` retention policy and
`long_lived` class within Session-owned retained interaction. The host's
per-turn completion seam invokes `ScmDiffSummaryProfile`, validates structured
output against captured occurrences and publishes through the revisioned machine
result owner. A settled output does not imply that the native Run terminated;
ordinary chat does not write the result. Review narration consumes the same
publisher after findings settle. Input admission, cancellation, recovery and
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
