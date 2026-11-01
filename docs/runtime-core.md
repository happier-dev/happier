# Agent runtime ownership

The host owns the executable Session and turn lifecycle. An Agent plugin supplies its native protocol, correlation and evidence through the public SDK; the host admits input, coordinates work, publishes lifecycle and writes the canonical transcript. Session interaction and finite Execution Runs use that same ownership boundary.

This page describes **0.3 development source**, not a shipped release or a completed live-validation gate. It is the standing architecture reference; approved plans remain the execution contract for their assigned work.

## Session input and inline references

The composer persists token-bearing text. Protocol's
[`inlineReferenceTokenV1.ts`](../packages/protocol/src/runtime/input/inlineReferenceTokenV1.ts)
owns `[label](happier-ref:<scheme>:<opaque>)`: the destination is the existing
percent-encoded MentionRef identity, and the nonempty label folds line breaks
to spaces and escapes `\`, `[` and `]`. The prefix is exported once as
`INLINE_REFERENCE_HREF_PREFIX_V1`. Labels are advisory presentation; tokens
do not create identity. A draft chip requires a matching typed reference range;
a message chip requires a matching envelope mention or attachment record.
Unbound tokens project to their label as plain text.

[`renderSessionInputContextPromptV1`](../packages/protocol/src/sessions/messages/sessionInputPromptContextV1.ts)
owns prompt composition. Its `references` input feeds
[`projectSessionInputReferencesV1`](../packages/protocol/src/sessions/messages/sessionInputReferenceProjectionV1.ts),
which rewrites tokens in place and renders one `<happier_references v="1">`
block for the distinct selected references. Ordinary input places that block
before the user text; `userTextPlacement: 'beforeContext'` preserves a native
command's first-line grammar while applying the same projection. Provenance,
browser and Discussion context retain their separate meanings and blocks.

| Bound reference | Readable marker |
| --- | --- |
| Dispatched image | `[Image #N]` |
| Other uploaded file or composer attachment | `[File: name]` |
| Uploaded directory | `[Folder: name]` |
| Workspace file or folder | `@path` or `@path/`, quoted when needed |
| Session | `@Session "label"` |
| Skill or vendor plugin | `$name` or `@name` |
| Workflow or widget | `@Workflow "label"` or `@Widget "label"` |
| Contributed reference | Its trigger and resolved label |

The CLI's
[`resolveStructuredInputProviderContext`](../apps/cli/src/agent/runtime/turns/resolveStructuredInputProviderContext.ts)
builds reference facts after finalizing dispatched image order. Image numbers
are derived by id from that order and never persisted. Upload descriptors in
`attachments.v1` and structured image inputs carry the tray id; contributed
attachments use their existing `instanceId`. An attachment retained after its
chip is deleted remains in the block without an in-text marker.

Session entries carry an id and read-with-a-tool guidance, never pasted
transcripts. Workflow and widget entries use current send-time identity/title
resolution and a read Action when one exists; unavailable references are data,
not a failed send. Contributed context is escaped as data. Existing resolved
context budgets remain in force; replay reservation measures the bounded
reference portion in UTF-16 units. Upload listings remain outside that budget.

New writes use this single projection rather than appending an upload listing
to message text. The [legacy reader](compatibility.md#composer-inline-references-03-development)
preserves 0.2-created messages and normalizes positioned legacy drafts.
[`messageStructuredReferences.ts`](../apps/ui/sources/components/sessions/transcript/references/messageStructuredReferences.ts)
owns inline bindings, legacy row entries and image numbers; its path scan
excludes inline-token ranges. Human readers share
[`messageDisplayText.ts`](../apps/ui/sources/components/sessions/transcript/messageDisplayText.ts),
while only the bound Markdown renderer consumes token-bearing source.

## Discussion input and answer lifecycle

In 0.3 development, a committed Discussion question enters the existing Follow
and Pending owners, not a separate Agent runner or delivery queue. Its exact
question, participant and `throughSeq` cutoff travel with protected input
custody into the host turn witness. Injected context and bounded Discussion
reads use that cutoff; this does not erase a native continuation's prior history.

Attachment hydration consumes that same protected source, not a new queue or Agent
plugin API. `readDiscussionInputMessages` supplies the exact original and admitted
ancestors; `materializeDiscussionInputAttachments` opens only their qualified Home
leaves with the Discussion key. The target-neutral `materializeSessionAttachments`
uses the receiving Session's existing encrypted upload/folder-finalization owner
and real issued handles before ordinary structured-file/native-image projection.
No path string supplied by Discussion content becomes local filesystem authority.
Final normal and steer dispatch share this preparation and the incumbent Pending
readmission before/after its asynchronous work. Missing sources, keys or issuance
produce `discussion_attachment_preparation_unavailable`; no attachment-bearing
original is silently downgraded to text. Source tests and loaded Home/runtime
validation remain separate evidence.

The existing Session reply owner arbitrates an explicit reply against the exact
turn's final-result fallback. The Discussion append transaction commits the
publication and settles that original together; a committed explicit reply
suppresses later fallback, including after a lost acknowledgement. Watch-policy
final outcomes are released without automatic Discussion publication. A private
draft instead hands off to the existing person-only Action review: publication
rechecks the approved body and current access; Decline settles the original
without posting. See [Discussion provenance and answer custody](session-collaboration.md#discussion-provenance)
for those owners, policy/review details and current integration limits, and
[Pending delivery](pending-delivery.md#live-runner-wake-up-recovery-development)
for receipt readmission and withdrawal. These are development-source contracts,
not a claim that every native or loaded-runtime journey is verified.

## Session and turn lifecycle

Codex's native failure reader recognizes an upstream JSON `model_not_found`
code even when app-server flattens the envelope into its error message. The
existing `provider_model_not_found` diagnostic asks the person to choose another
model without forwarding upstream prose. This development behavior does not
infer account entitlement or a later HTTP 503's cause from that earlier refusal.

After the native Session factory confirms open, the host publishes `session_opened`
through the existing durable turn-mutation owner before entering the Session loop.
Home clears an older closed startup issue from `Session.lastRuntimeIssue` without
allocating a new turn or changing the failed historical `SessionTurn`. The existing
`latestTurnStatusObservedAt` frontier advances with that resolution, so a late
heartbeat cannot restore the old issue. Non-startup issues and newer failures remain
unresolved. Failed local publication custody preserves the opened runtime, following
the existing lifecycle publication contract; accepted mutations use the durable
outbox's retry owner. This is an unreleased 0.3 contract under the all-component direct cut;
the strict V1 mutation envelope is unchanged and gains this host lifecycle arm.

Codex app-server can finish a native turn while an already-started tool is still running. The
host records the missing result truthfully. A later result for that exact native
thread, turn and known tool call corrects the same transcript row through the
existing source-timestamp and Message revision owner. It does not reopen the
completed turn or admit another input. Unknown calls, foreign threads and
duplicate completions cannot introduce another tool effect.

Session awareness keeps a completed foreground Turn separate from continuing background work.
`projectSessionAwarenessOperationalV1` suppresses operational readiness while the runtime still
reports background activity; `readSessionAwarenessWorkStatusV1` maps that activity to Working.
The Session-list presentation owner composes these facts with the Account's
`sessionListBackgroundWorkAttentionModeV1`: show a blue center dot on the working indicator for unread replies
(default), show unread status within Working, or temporarily move unread replies to Needs
attention. Reading returns the latter two to working presentation while work continues.
This preference never changes the Protocol-owned personal attention, read cursor, Follow or
access facts. Legacy owner rows translate their existing completion/read evidence before
using the same presentation policy.

Session capability edits converge through the host's
[`capabilitySelectionSynchronizer`](../apps/cli/src/agent/runtime/capabilitySelectionSynchronizer.ts).
It observes the canonical desired selection and applied metadata baselines plus
skill and MCP rules published through the host's captured Account subscription. MCP
observation retains the launch resolver's realpath, Project, Agent and plugin-item
context and its resolved server-selection baseline; it does not substitute a later
catalog for the launch decision. The
Session client's content-free `account-change` ingress and change-feed recovery
refresh the MCP and prompt-library catalogs for the admitted Home and captured
Account lifetime. The foreground Session's demanded Active Account MCP catalog
and an invocation-only Execution Run's captured MCP catalog retain their own
existing hydration owners; refreshing the Run holder does not refresh the
foreground Session's rules. They join the existing in-flight hydration and re-observe rows
after an invalidation. Refreshed rules reach the same synchronizer as Session
selection edits. The Protocol resolver compares effective selections after
Session overrides, so unrelated and overridden rule changes do not apply. The startup rule observation
remains the baseline until native acknowledgement or restart; an unavailable
rules read never becomes an empty rule set. Skills admission demands an absent or loading prompt-library catalog
through the existing captured Account hydrator. An in-flight observation is
not a completed unavailable read: admission must retain the resolved rule
context so later Account wakes can compare Machine and Project rule changes.
Completed unavailable reads retain their typed failure and do not become retries.
Skill delivery resolves referenced candidates from Reach rules and Session
overrides, then opens only selected Artifact bodies through the shared skill-plan
preparer. Startup, Session-owned Runs and live reapply do not enumerate unrelated
Account Artifacts. Machine previews still supply a complete choice inventory to
that same preparer; library listing and cache collection retain their inventory owners.
An exact Artifact read confirming absence makes retained skill rules and Session
includes inert: the deleted skill is not delivered and emits no load warning.
Read failures and malformed existing content remain unavailable; a readable
Artifact title supplies the warning's name when its skill content cannot be read.
The synchronizer waits for a settled turn and uses P3's `reapplySessionSkills` for declared library-skill
live reload. Native-skill overlay changes and MCP changes use the daemon's existing
restart-with-resume owner with reason `capability_selection_change` and
`force_current_cli`; they never create a fresh conversation as a fallback.
Turn/approval busy refusals wait for the next settled turn.
Capability replacement, runtime refresh and planned Connected Service switches
share the daemon's final replacement gate. It closes Run Start, Ensure and
Ensure-or-Start admission, including aliases declared by their canonical Actions,
at the receiving Session RPC owner and joins requests
already received, including authorization and cleanup before a public Run exists.
The same gate then rechecks child and foreground activity, captures the departing
process tree and verifies process identity before signalling. Creation cannot
enter during those asynchronous checks. Unrelated long-lived readers do not hold
the drain. A creation received during the hold waits under its own cancellation
lifetime without joining the already-received creation drain. Cancellation
retains typed `noRunCreated` evidence through local and transported dispatch.
Initial work admitted by Start remains active while Pending prepares its first
native input, even after the runtime address exists; that preparation cannot look
like an idle retained conversation to the replacement gate.
Before Start reaches the runner, a Session-targeted Machine Action can still be
preparing evidence or awaiting its acknowledgement. The receiving Action adapter
adds its Session and Action ids to the RPC owner's existing active execution
record. The daemon's same replacement activity projection consumes those records
through request cleanup. Read Actions and effects targeting another Session do
not block replacement; the refresh Action itself is excluded from its own check.
Native turn completion also remains active while the host publishes its result.
A profile-authored next part, including review narration, retains that activity
through preparation and Pending admission until the native Agent accepts it or
the host receives a definite refusal. Completed idle results remain replaceable.
The admission hold remains an in-flight private RPC
request after a separate readiness response. Existing request cancellation and
transport retirement reopen admission, without a release-message dependency or
an expiry timer. A clustered room broadcast can lose cancellation without
disconnecting the receiver. When creation encounters a closed gate, or a new
restart attempt encounters an older hold, the receiver checks that exact PID
and attempt through the existing authenticated local daemon control channel.
Only a definite retired result releases the hold; an unreadable daemon leaves
admission closed. The waiting creation registers its cancellation and existing
deadline before this read. Each read follows both that caller and the hold's
lifetime; a cancelled or disconnected creation settles as `noRunCreated`
without entering its handler or releasing an independently live hold. The daemon
retains the attempt's existing request signal on its tracked runner, without
persistence, polling or an expiry timer.
A signalled runner keeps the hold through retirement; normal
completion of the Connected Service deferral callback does not release it. The daemon
refuses to signal if that live request is lost during its final checks. The exact
runner PID and attempt pair readiness with its own hold; a delayed older request
cannot release or authorize another attempt.
An older runner without this operation returns `restart_admission_unsupported`
with the existing Stop-and-Resume recovery, rather than indefinite activity deferral;
security-driven request-auth source cutover retains its interrupting path.
Missing resume evidence
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
selection through Undo. Positive skill or MCP launch resolution takes precedence
over an earlier runner's retained rule-pending notice, preventing repeated
replacement before the first input. An attach's current-rule read alone cannot
acknowledge that notice. Explicit current terminal/Windows-hosted launch facts
take precedence over a retained daemon projection when deciding manual restart.
Host publication records the admitted
Agent's resume/live-reload facts in `agentRuntimeCapabilitiesV1.capabilitySelection`
so clients can decide timing without a live Machine round trip. Initial facts use
the descriptor returned by the admitted native factory, retained through host
identity decoration; launch options can predate that concrete runtime choice.
Daemon-started runners resolve these facts from their admitted retained Agent
catalog entry after native-source preparation. The retained leaf projects the
same experimental-resume predicate as the ordinary executable catalog, and
retires it on disposal; a process-global catalog cannot supply a different
generation's resume decision. Codex app-server therefore keeps its declared
experimental resume support for capability changes, while unsupported native
runtime choices continue to fail closed.
These source paths
still require the program's composed live journey before certification.

In 0.3 development source, Session input routing uses Pending's committed
`runtimeMachineTarget` through `readCurrentCommittedSessionInputMachineTargetInTx`.
Input can therefore reach its existing custody while a planned replacement has
no live publisher socket. Archive, Account access and current Machine installation
checks still apply. Runtime effects continue to require a current publisher.
If an admitted Session runtime effect has no current publisher, the existing
RPC classifier returns `target_unavailable`; a current publisher lacking the
method still returns `RPC_METHOD_NOT_AVAILABLE`. A submitted mutation whose
publisher disappears retains `RPC_OUTCOME_UNKNOWN`, not a retryable absence.
When the send requests Resume, the daemon consults the existing intended-respawn
state and signaled-restart PID set for that exact Session, after requester
validation. A pending replacement retains launch ownership; the replacement
consumes the canonical Pending row under its existing local-id deduplication.
This adds no input queue, retry, timer or restart state.

For app Resume in this development source, an issued Machine RPC whose outcome
cannot be confirmed retains `RPC_OUTCOME_UNKNOWN` through the existing Resume
result and `session.open` Action. The shared alert presents **Outcome unknown**
with check-before-retrying guidance and optional technical details. It neither
retries automatically nor claims success from a Ready projection or a completed
native turn; those facts do not establish that the outer RPC reply arrived.

The foreground Pending consumer honours the materialization owner's retry delay
for the same retained claim until settlement or caller cancellation. Repeated
uncertain acknowledgements do not exhaust a separate consumer retry allowance
or require a new Pending event. Results without a retry hint still wait for the
existing queue, metadata or connection wake; input is never enqueued again to
recover a lost settlement receipt. This is 0.3 development-source behavior.

Protected Session inputs re-enter that same Pending admission owner after host
prompt and checkpoint preparation, immediately before a new turn or in-flight
steer reaches the native Agent. A local queue copy or committed user transcript
row does not authorize dispatch after the Pending input is discarded. The host
refuses native delivery when admission is rejected, held or unavailable.
Protected originals retain independent
queue entries so one cancellation cannot reject a valid peer. This applies to
bundled and installed Agents; context-only host inputs retain their existing
separate admission owner.

The host's native foreground assistant projection waits for Home acknowledgement
before publishing terminal Turn anchors. The lifecycle joins the exact input's
existing Pending settlement attempt before reading acknowledged user sequences,
and retains the transcript writer's acknowledged assistant sequence in the
ordered per-turn projection. The bounded notification-preview snapshot is not
terminal-anchor authority; clearing it cannot discard a committed reply. A
foreground turn that emitted text but has no acknowledged reply sequence fails
transcript custody instead of publishing a successful empty result. Workflow
readers keep missing text in result-unavailable attention; an explicit pass
retains its distinct no-answer outcome. Recovery publishes that same attention
on the original invocation without advancing the Workflow or settling its input
custody; an outstanding Stop remains pending until its own outcome is known.
A settled attempt alone is not commit
evidence. The Session client keeps the existing
outbox and close/cancellation lifetimes; sidechain output retains its own path.
The [Session result reader](pending-delivery.md#correlated-session-answers-03-development)
owns observation of retained turns with incomplete anchors.

A host-proven native-mode startup refusal uses that same exact-input outcome
owner in 0.3 development source. Session creation can be acknowledged before its
caller offers the first input, so the failed host keeps its existing Pending
consumer available until ordinary Stop. Later originals receive the terminal
pre-effect refusal; no native prompt, Ready event or successful startup hook runs.
The native-open owner records a refused outcome through its existing runner
attestation before entering that resident refusal path. The daemon observes it
under the same exact runner and Agent-source custody as a committed open; it
never projects refusal as a successful native open. A cold Session startup
refusal does not allocate a synthetic Turn: no input has been admitted, and
the startup operation and exact Pending outcome retain its typed failure.
Other construction failures that publish a diagnostic Turn serialize its begin
and terminal mutations through the same lifecycle owner, including before
daemon turn-marker callbacks exist. A cold Session startup
operation retires the runner it spawned through the daemon's normal Stop owner
before reporting that original failure; it does not wait for a person to Stop.
The observation retains that exact tracked runner and its copied birth identity
for Stop's existing exact-runner selection. A replacement of the same Session
does not inherit the refused runner's cleanup or Stop mark. Failed or incomplete
retirement still reports the original typed startup refusal.
Workflow consumes the failed operation before offering its first input. Native
fork retains its existing child-retirement scope. A refused host without an
observed startup operation retains the late-input consumer described above.
Mode availability is checked before committing successful native-open attestation,
including when the plugin returns a Session before the host refuses its mode.
Plugins that apply configuration during native open publish their observed mode
inventory first. During open, the host checks that publication through its
canonical mode assertion without interrupting construction. A completed open
uses the final inventory and accepted current mode; a mode-specific failed open
uses the latest observed availability evidence from that attempt, retained across
producer cleanup. Later valid current-mode facts clear earlier refusal evidence.
A public error code without matching evidence retains ordinary cleanup.
Native forks observe the same attestation inside their fork owner's child
cleanup scope. The shared Project startup wrapper returns the physical child
identity to that owner, which attempts the existing Stop and archival cleanup
for a refused or exited child before reporting fork failure.
An attested refusal carries its captured runner witness into that same cleanup
scope. Cleanup uses local exact-runner Stop even when the child has a Machine;
incomplete or throwing Stop preserves the refusal without Session-wide fallback.
The existing retained-settlement owner reoffers a failed terminal-block write on
its normal connection/materialization wakes, without redelivering input. Generic
plugin errors, generation retirement and native-resume failures retain their
normal cleanup behavior. No Pending format or public plugin error contract changes.

In 0.3 development source, Role, prompt Artifact and Session Project association
preparation classify Home read failures through the shared endpoint policy.
Network, timeout and retryable HTTP failures publish the existing
`preparation_pending` issue. During startup,
the runner exits with failure after publishing that issue and releasing its
construction resources, so the daemon's existing respawn budget can retry with
the retained initial input. Definitive Home refusals publish terminal attachment
failure instead. File diagnostics retain only endpoint classification and status;
they do not include response bodies or request credentials. Loaded-daemon
recovery still requires the program's composed live replay.

Session metadata tuple publication uses the same Home endpoint failure policy.
A retryable HTTP failure may follow a committed write: the existing tuple
coordinator accepts an exact observed result or retries an unchanged source,
within its existing attempt budget and publisher-currentness checks. If the
result remains ambiguous during construction, the host publishes
`preparation_pending` before cleanup and exits with failure so the daemon can
retry startup with the retained initial input. This applies to bundled and
external Agent plugins without a provider-specific retry path.

Bootstrap HTTP 5xx failures from Account-mode/currentness reads, Machine and
Session admission, and Session/Machine access-key lookup or binding retain their
Home evidence through the same canonical issue classifier and command reporter.
Access-key preparation also retains timeout and network failures. During runner
creation it reuses Session creation's existing retry budget and backoff. Every
attempt rejoins the same creation tag and Session/Machine tuple;
a lost binding receipt never overwrites an established key. Exhaustion preserves
the preparation failure rather than reporting that no durable Session exists.
After Session custody exists, construction publishes `preparation_pending` before
cleanup; the runner preserves a nonzero exit for existing daemon recovery.
Account-mode bootstrap does not reinterpret Home unavailability as missing keys.
Authentication and definitive client refusals retain their existing disposition;
native Provider HTTP failures are not classified as Home preparation failures.
This is 0.3 development source; loaded-runtime recovery requires a separate replay.

Account catalog hydration also distinguishes a retryable Home-currentness read
failure from missing or mismatched E2EE material. The former retains the existing
`unreachable` catalog result; no private row is opened without successful
currentness admission. Optional MCP preparation may omit that unavailable catalog
with its existing notice. Strict MCP preparation instead publishes
`preparation_pending` and exits with failure so the daemon's existing respawn
owner can retry the retained input. Actual missing material remains closed and
does not acquire this transient recovery disposition.

Metadata PATCH transport uses that mutation's caller lifetime and cancellation,
including explicit Stop intent and terminal-control retirement. The generic
Session HTTP read timeout does not shorten a metadata mutation. CLI and UI Stop
both reach the owning daemon's physical Stop owner. In development source, their
Action adapter uses the incumbent exact-Machine dispatcher, preserving admitted
requester custody for local execution and authenticated RPC for other targets.
The Stop service reads either the physical daemon receipt or a requester
executor's canonical public Stop result for that exact Session; a confirmed
public receipt is not reparsed as an unavailable daemon, and an unconfirmed
receipt remains unconfirmed. Their
Account front doors classify `session.stop` once: an omitted public `stopIntent`
means `explicit_stop`; resource surfaces declare `lifecycle_control`. Internal
Stop ports require that intent. Info and CLI Stop persist the explicit hold before
the physical operation. Processes, widgets, Guard, Storage holder cleanup and
Machine Runs Stop release the runner without creating or clearing a hold, so the
next ordinary message remains eligible for automatic wake under the existing
resume policy. A pre-existing hold still applies. Both Account writers use the
Protocol `buildSessionStopHoldV1` record builder. UI uses the scoped Sync metadata
tuple writer and preserves the admitted Action context; automation cannot acquire
a person's hold. Failed or retired metadata authority prevents an explicit Stop,
including the runner-RPC fallback. This adds no Account credential to restricted Session runners and no
second Follow admission guard. A lost receipt
or cancellation after emission remains uncertain and does not prove retirement.
The daemon uses the admitted runner's matching Account credentials for its own
Stop metadata and retirement, without rebuilding requester execution services.
Foreign Account custody retains its existing requester authority checks. Local
control binds preparation and metadata writes to the request connection; an
unsettled explicit Stop returns `incomplete / explicit_stop_failed` rather than
claiming that its runner retired.

Admitted Follow originals retain their server-validated input admission receipt
through canonical and legacy message projections. A required original's transient
Home source-read failure uses the same pre-turn preparation wait, retaining the
exact input until recovery. Definitive Home refusals remain terminal. Optional
Follow context still omits unavailable content without turning it into required
input or a runner restart. These are 0.3 development-source contracts; loaded
original acceptance remains a separate live check.

In 0.3 development source, the daemon's planned-restart activity gate also reads
child work from the Session's live Execution Run manager. A retained idle Run
does not prevent replacement; an active child turn defers the signal. The execution
registry's existing change notifications wake that wait. The daemon lifetime or
Connected Account deferral owner cancels it before a late signal can escape.
Only accepted exact foreground-turn custody updates the restart deferral queue;
legacy transcript notifications without a turn identity retain their downstream
recovery role but cannot mark the foreground busy or clear a live turn. Busy
restart results identify the activity source in their existing diagnostics.
An unavailable child-activity observation refuses replacement with a partial
failure, rather than claiming that a turn is in progress.
Ordinary runner refresh also reads native Agent work through the existing
requester-qualified Session input live-work RPC. The host Runtime Activity owner
exposes its Agent slot separately from its Execution Run slot; an active child
therefore keeps the existing drain behavior rather than becoming a native busy
refusal. Active native work returns busy. A successful unknown or absent native
report permits refresh, preserving compatibility with non-reporting runners;
an actual read failure refuses replacement with the existing activity-observation
failure. The same native decision governs previews and signaling, and is checked
again after a child drain and process-tree capture. Session-wide Runtime Activity remains the aggregate presentation
and settlement projection, not a second native-work authority.

A manual app restart confirms possible interruption of background work. The
confirmed operation uses the unchanged ordinary V1 or process-attested recovery
V2 request through one dedicated authenticated machine/local-control route and
sets only the existing restart owner's internal native-interruption permission.
It never bypasses foreground-turn refusal, child draining, process identity or
Provider binding validation. A request reason is descriptive and cannot provide
this permission. On an older daemon that lacks the dedicated method, the app
sends the matching unchanged V1/V2 operation only after consent. Authentication,
cancellation and other failures do not trigger that fallback. Connected Service
switches and private request-auth source cutover retain their existing policies.
Refresh completion follows the canonical respawn operation through retirement,
preparation and its existing spawn budget; a separate handoff timer cannot expire
a healthy replacement. Equivalent refresh requests keep joining the reserved
attempt while it waits. The adopted-runner physical exit observer retains its
existing observation budget. Refresh eligibility
reflects explicit replacement support; unattested generation freshness remains
unknown and cannot authorize an automatic `if_stale` refresh.
Foreground-turn refusals keep their existing retry behavior. Credential retirement,
request-auth source cutover and other security retirement paths retain their
interrupting behavior. Refresh and respawn diagnostics retain the caller's reason
rather than labeling every planned replacement as a Connected Account switch.
The development `session.runtime.refresh` Action reads the hosting Machine's
current runner status and uses the banner's guarded `if_stale` request. Both
surfaces wait under the caller lifetime while the daemon defers replacement;
they do not impose a shorter client completion deadline.
Loaded-daemon replay requires the orchestrator's next authorized reload.

## Native Agent seam

In 0.3 development, foreground Stop aborts the prompt-loop lifetime and starts
native turn cancellation alongside permission withdrawal. A pending Home write
for withdrawn permission requests must not delay the native interrupt. The Stop
operation still joins both outcomes. Once the native runtime reports cancellation,
the host publishes its cancellation marker and cancelled turn independently of
pending transcript finalization. It still drains every durable text/tool write and
then appends acknowledged reply anchors to that same turn. Successful completion
continues to require transcript custody before publishing completion. Independent
Runs keep their own permission and cancellation lifetimes. A late acknowledged
partial can enrich the same unreturned cancelled reply; an already returned reply
is never replayed.

[`AgentRuntime`](../packages/plugin-sdk/src/agentRuntime/runtime.ts) has two mutually exclusive forms: a Session factory or an execution-only Run factory. A Session-capable Agent does not add an independent Run lifecycle. For Session-owned Runs, the host binds its Session runtime into the shared Execution Run adapter in [`nativeAgentExecutionRun.ts`](../apps/cli/src/agent/runtime/bridges/executionRun/nativeAgentExecutionRun.ts). Detached execution requires the Session factory's declared `executionRunContextV1` facet; it cannot fabricate a parent Session. The shared SDK implementation in [`executionRun.ts`](../packages/plugin-sdk/src/agentRuntime/executionRun.ts) owns correlated Run events, cancellation, terminalization and disposal for the finite/conversation adapters.

The engine registry's [`runtimeCore.ts`](../apps/cli/src/agent/runtime/registry/engineRegistry/runtimeCore.ts) resolves the admitted Agent runtime and composes host services. Agent code receives the scoped public context, not raw host lifecycle controls. Agent-native configuration in `RuntimeDescriptorV1.agent` is interpreted by its Agent; generic host code must not infer its meaning from an Agent id.

In 0.3 development source, an Agent's accepted native mode completion uses the
optional `session.services.modes.complete({ modeId })` operation. The host clears
only a matching saved mode selection through the canonical Session intent writer,
under the current runtime and publisher authority. `modes.bind` continues to
publish observed inventory and current-mode facts. Claude invokes completion for
Plan after an approved SDK permission or exact main-session native ExitPlanMode
acceptance; denial, feedback and failed native hooks do not clear Plan. The native
follow-up permission choice keeps its existing owner. A failed completion emits
a warning without changing the accepted tool result.

In 0.3 development source, daemon engine resolution carries the executable catalog
entry already acquired from its runtime lease into native-home and authentication
service composition. A declaration-only projection cannot supply those executable
hooks. A retained Session runner keeps its exact admitted contribution and catalog
entry, so its services remain bound to that generation.

Long-lived Runs retain their native interaction until host settlement under both
ephemeral and resumable retention. Retention determines recovery after settlement,
not whether a running conversation accepts another turn. Session-owned Runs
forward their foreground native tool calls and results through the existing
Run transcript publisher, which owns sidechain identity and publication custody.

Detached long-lived Runs select the same retained-interaction
eligibility owner as Session-owned Runs. They open the optional
`sessions.executionRunContextV1.openConversation` operation, which returns the
existing scope-neutral `AgentExecutionRunConversationRuntimeV1`. The host admits
each input, correlates its turn, and settles its output without disposing the
conversation. Host Run settlement disposes it. Missing conversation support
refuses that retained operation before native opening; the finite `open` facet
keeps its single-turn terminal semantics. Bundled and installed Agent factories
use the same operation discovery. Neither open nor recovery supplies a Happier
Session identity for a detached Run, and recovery retains canonical credential
preparation and exact native checkpoint admission.

Detached input admission uses the Run's permission-policy owner for both public
Actions and Agent input. Public input receives a fresh ceiling from the admitted
Run mode. Agent input preserves its original causal ceiling while its private
current caller mode bounds that turn; the host carries that mode through direct
IPC and input metadata into permission and nested Action admission. It never
passes the private mode in Agent SDK send options. An idle conversation has no
active input authority, and lost private authority refuses rather than inheriting
the opener's ceiling.

In 0.3 development source, host Exec executable resolution and launch preparation mark a typed
`PluginError` with `execLaunch: 'notStarted'` only when it refuses before starting
the requested process. The SDK's canonical `isPluginError` reader recognizes the
typed error across bundled SDK copies. A native send adapter must
also establish that its input was not dispatched: the launch marker alone does
not settle an earlier input's custody. Codex preserves a known prelaunch refusal
as `input-rejected` with its original code, which the shared Execution Run adapter
projects as `run-failed`; errors after native input dispatch remain outcome unknown.
This contract applies to host Exec services for bundled and installed Agents.

In 0.3 development source, Claude's SDK query correlates initial and in-flight
user input with native UUID acknowledgments requested through
[`--replay-user-messages`](https://code.claude.com/docs/en/cli-reference).
A successful stdin write alone leaves acceptance pending. A submitted record
without its matching nonsynthetic main-chain user acknowledgment at exit,
abort or disposal remains outcome unknown, preserving the existing Pending and
replay-seed custody without automatically resending it. The host's correlated
acceptance outcome retires the seed; native transcript resume proof remains
separate.

The new conversation operation also enforces each input's resolved public
`permissionIntent` before native input effects. The host derives it through the
same Run authority owner from the Run mode, original causal ceiling and current
caller mode; the original causal witness is not rewritten. Claude, Codex and ACP
use their existing native configuration owners to apply it, or refuse the input
when enforcement is unsupported. Host approval callbacks alone do not constrain
native tools running under an unrestricted opener policy. Finite V1 sends do not
receive this new option.

Claude's canonical `read-only` intent maps to native `plan`, not `dontAsk`:
allowed native writer rules must still reach the host's read-only decision.
When the SDK query has a host `canCallTool` callback, stdio retains prompt
ownership; an advanced custom prompt tool cannot redirect those approvals.
Standalone queries without that callback retain their custom prompt tool.
Claude's terminal controls consume that same mapping. Configured ACP requires a
concrete native permission-mode mapping from the existing Account catalog's
`runtime.permissionModeMapping` and refuses an unenforceable intent.
Kilo's launch-only policy can admit only an intent proven to match its canonical
launch environment; it refuses narrowing or unproven native overrides instead
of pretending to update the retained conversation.

In 0.3 development source, native Session and Session-owned Run launches share
[`launchEnvironment.ts`](../apps/cli/src/agent/runtime/launchEnvironment.ts).
It carries the admitted runner's command-search `PATH` and Windows `PATHEXT`
alongside explicit launch values, preserving explicit overrides and unsets through
the existing platform-aware environment composer. Other ambient credentials and
host controls remain private. Both Claude SDK and Codex isolated launches consume
this environment; terminal hosts retain their existing environment owner.

Runner-hosted plugin Exec requests also inherit this captured Session or Run
environment before daemon launch authorization, using the same platform-aware
composer. Explicit request values take precedence. Reused Session services read
the final scope after late profile or Provider materialization; Run services keep
their own scope. This applies to bundled and installed Agents.
Codex's live app-server Goal and usage checks use the opened runtime's retained
native client. The host selects `AgentSessionRuntime.goals` and
`AgentSessionRuntime.usageLimitRecovery` ahead of their factory facets;
factory controls remain the default for Agents without a per-open control.
The existing manifest declaration, native support signal, turn serialization,
publication and disposal fences still apply. This public SDK seam is shared by
bundled and installed plugins and introduces no native-client registry.
Codex's factory Goal facet serves inactive Sessions; a live call through that
facet refuses without spawning when the runtime-bound control is unavailable.
Codex ACP opens explicitly suppress native Goal controls because the ACP
transport has no native Goal port; the existing host Goal fallback applies.
Explicit app-server usage checks read fresh quota on the retained connection,
without launching a control process or disposing the Session's client. Inactive
checks retain their short-lived admitted control client. ACP has no retained
app-server quota connection and retains the factory quota probe.
Other runner-hosted control clients inherit the Session's scoped `CODEX_HOME`.
Fully resolved native launch tuples retain their already-composed environment.

Inactive native Goal, catalog and usage controls obtain their scope from the
daemon's admitted Session launch composition. The persisted Session snapshot
selects its Launch Profile and Connected Account; the existing spawn Profile,
Provider, Connected Account materializer and child-environment owners resolve
the native scope. The control retains those resources through acknowledgement
and cleanup. Missing admission, an unreadable binding or a different Account
returns `inactive_agent_launch_scope_unavailable` before native execution;
there is no fallback to the daemon's native account home. Bundled and installed
Agents consume the same host boundary. The control context carries this
admitted target `launchEnvironment`, so Codex passes its values to the native
client before startup-lock and SQLite argument
selection. `CODEX_SQLITE_HOME` selects that client's existing `sqlite_home`
override; inheriting the variable only at Exec authorization is too late for
that selection. Missing scope refuses before native execution. A caller
addressing another Session uses the target's live runtime or admitted inactive
scope, never the caller's native home.
This is development-source behavior; loaded-daemon replay remains separate
verification. A managed Provider whose final endpoint scope requires a running
Session is refused until that scope can
be admitted; inactive controls never substitute native-account defaults.

Session-owned bounded Runs whose Agent declares new-turn delivery keep the native
Session available until the host's bounded loop settles. A first native turn can
require the profile's structured-output repair turn; it does not complete the
host Run. The existing conversation adapter serves those turns, and host
settlement disposes the Session, including for ephemeral Runs.

In 0.3 development source, Session-owned Run output enters the Session's durable
transcript journal with sidechain provenance, including final results rendered
on the parent's tool call. Journal admission releases the Run's publication
wait without awaiting Home acknowledgement; the same outbox retains delivery
and recovery custody after native cleanup. An explicit `requireDelivery`
admission still waits for Home, preserving ordered foreground observations.
This correction requires a fresh runner for loaded-runtime replay.

Voice Run stop and Session disposal release acquired native runtimes before
joining their active turn or lifecycle work. The existing Voice instance owns
its chat, isolated commit, and provisionally opening chat replacement; retirement
releases each through the same runtime disposer. A late cancellation cannot
acquire a replacement after that instance has retired. This is development
source behavior, not a change to retention or the existing idle-lifetime policy.

A confirmed primary Run Stop remains successful if the optional sweep
for other matching Runs cannot load its inventory; that failure emits a cleanup
warning. A refused or unreachable primary Stop still reconciles against the
execution owner's exact Run state. Continuation on another client retires only
the departing client's local custody.

Session-owned child Runs retain their own transcript sidechain and interaction scope. They cannot publish the parent Session's work-state or active-input readiness; those projections belong to the main Session context. Finite and retained child contexts use the same Run-scoped work-state service, which reports Session projection as unavailable.

In 0.3 development source, child contexts compose the same ordered transcript
follow service and source projector as the main native Session. The retained
external-session source feeds the child's own native observer; display and user
source facts use the Run's sidechain writer and its current controller custody.
The parent supplies the committed-id baseline, not its active follow binding.
Run disposal releases only that child's source-follow resources.

Claude terminal replies enter the same correlated committed-text channel as SDK
replies before the host settles a child turn. The codec publishes only current
primary reply facts admitted by ordered source follow, with their native fact
identity. If a Stop hook names a reply not yet observed there, its completion
evidence waits for that reply; it does not start structured-output repair with an
empty Run buffer. Historical replay and native sidechains do not close that turn.

For main Sessions and Session-owned Runs, the terminal-follow producer uses
that complete durable baseline for both
historical replay and fresh initial admission. Native display facts already
committed through the SDK are not rewritten with a different native-source
timestamp. Source-observation receipts still reach the current native observer,
new display facts are published, and later live updates retain their normal
publication path. Home's same-identity timestamp and provenance checks are
unchanged.
The committed local-ID reader pages all Session scopes to completion under the
containing follow admission's cancellation and deadline, retaining identities
rather than message bodies. Total committed-history length does not make a
baseline incomplete; failed reads or a non-progressing cursor still refuse follow.

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
discover another catalog or populate a daemon singleton. Native child tool services
resolve the verified child's CLI metadata through the canonical Agent CLI resolver;
they do not inherit a different Agent's captured launcher. An exact captured launch
keeps its existing binding. Native offered-model evidence is read through that
snapshot's daemon service, using its admitted Agent catalog and the owning
Session's Account context. Unknown models still refuse structured-output admission;
Provider and Team selections cannot borrow a native model's capabilities.
Continued Review narration uses the controller's retained reader and Agent
projection; recovered Runs reacquire them through the same snapshot owner.
Admission prepares profile
prompt text through the existing daemon contribution service using that lease;
the Run retains the prepared instructions. Ordinary later resource reads still
obey publication fences. The existing controller occurrence retains its admitted
profile catalog for Pending, send, Actions, public projection and terminal hooks,
so another acquisition cannot replace a live Run's profile decisions.
Review scope, commit-message repository evidence and the fresh working-tree
comparison's commit-target witness are prepared over the same
runner-to-daemon services channel with the retained Run snapshot. The daemon
selects SCM through that snapshot's executable registry; the runner retains
profile lifecycle and does not construct an SCM registry. Commit-message
preparation preserves the requested path scope and the profile's existing
evidence budgets. The witness uses the existing SCM capture owner rather than
falling back to an absent runner-local registry. Missing, retired or foreign snapshot custody refuses
preparation before Run creation.
Inherited Provider admission and personal-Provider launch preparation also use
that retained executable registry over the same service. The tracked Session's
Account reader supplies settings and source currentness; the runner receives the
existing scoped environment, binding and exact redaction values. The retained
snapshot owns in-flight preparation and cleanup, including abandoned runner
exit. Typed incompatible/unverified child-choice details survive the service
boundary. Existing Team credential preparation keeps its separate authority.
Review host Action provenance and grant caller references instead read the
daemon's current registry through the authenticated tracked-runner service;
they do not turn a retained executable declaration into current write authority.
Review comment signing and sending await the existing current-source checks.
Session and Run bridge lifecycle notifications likewise dispatch through the
existing daemon contribution service, selecting the current registry for each
event. Child-event metadata does not replace the issuing parent Session's
transport authority; no runner-local catalog is populated.
These service consumers require the runner's canonical authority-file
environment. The daemon launch producer supplies it for daemon children;
the foreground CLI owns it for its Session lifetime and restores the previous
values at cleanup. Accepted Profile-secret re-admission refreshes both paths.
Deferred native preparation reads the accepted claim's current authority path
while retaining the original bootstrap identity and exact-source checks.
Loaded-runtime validation still requires a fresh runner after the CLI reload.
Runner-to-daemon service preparation belongs to the containing invocation,
including native launch preparation and Project setup or approval. The pending
working-tree correction binds its service proxy to that invocation's cancellation
and removes the implicit five-minute transport deadline. This correction is not
yet committed: the committed service client still defaults to 300,000 ms when no
timeout is supplied. Do not infer the correction from a fresh runner alone; it
requires the changed client and invocation binding to land and be loaded together.
Explicit caller deadlines remain effective. Response loss after dispatch retains
its unknown effect outcome rather than authorizing replay.
The bridge binds snapshot release to Run runtime
cleanup, and the daemon's existing tracked-runner exit cleanup releases abandoned
leases. New acquisition refuses unavailable or replaced authority with a typed
result; unknown operations on an older daemon cannot become an empty snapshot.
Omitted child selection consumes the parent's applied model/auth reader, while
explicit `agentDefault` and incompatible-Agent choice retain the canonical
child-selection rules. Inheritance joins the Session's internal controls-installation
notification, then the existing applied-selection registration promise. Complete
explicit selections for every requested role do not read or wait for the parent.
In 0.3 development source, ordinary Review Start with no model, credential route,
role or profile choice requests that existing `agentDefault` selection: the Account's per-Agent target
model takes precedence, then the Agent's own default. Explicit Review choices
retain their normal custody. `resolveExecutionRunAgentDefaultSelection` owns the
Account lookup for launch and for the daemon's `review.engines.list` inventory.
The inventory's optional `launchModelId` reports a concrete Account-configured
model; omission leaves the Start engine subline empty for the bare Agent default.
An explicit Team model suppresses that reviewer's default subline; the existing
Team picker names the chosen model.
The UI reads these daemon facts rather than choosing a model itself. This source
change still needs the composed live Review replay after the updated runtime loads.
Cancellation, controls withdrawal or replacement,
and fenced applied authority still refuse with
`execution_run_parent_selection_unavailable` and `noRunCreated`. Local file
diagnostics identify the unavailable reader or authority predicate. There is no
separate public readiness probe or startup deadline; each attempt rechecks applied
custody. A first parent turn alone does not certify the parallel daemon registration.
The daemon's applied-parent reader and Run credential
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
In 0.3 development source, the daemon's existing cancellation signal also owns
pending source preparation during initial and later registry resolution. Abort
joins the preparation process tree's retirement, prevents targeted fallback and
initial serving publication, and follows the existing startup cleanup path.
It does not add a startup deadline or shorten the helper's existing budgets.
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

Execution Run Connected Account materialization also waits for the canonical
root writer and credential preparation without a default HTTP deadline.
`HAPPIER_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS`, when explicitly configured,
sets the caller's deadline; the control client does not clamp it to ten minutes.
Elapsed queue or preparation time alone does not establish a failed child Run.

The lazy Run runtime supplies its existing disposal signal to Connected Account
materialization. The runner control client and daemon HTTP request lifetime carry
that cancellation into the canonical spawn-auth resolver. The daemon retains
this request lifetime through response delivery, and the materialization owner
keeps cancellation bound to the exact returned activation. Cancellation after
target registration or during delivery releases that activation through the
existing retained cleanup owner; a queued cancellation cannot release its
successor. HTTP write completion ends this connection observation; it does not
prove that the runner received the activation. The runner allocates the existing
activation identity before dispatch and retains the issuing daemon target. A
lost, invalid, mismatched or locally cancelled response releases that exact
activation on that daemon before it can become launch input. Release distinguishes
an already absent activation from retained cleanup failure; failure is not
reported as completed cleanup. This describes the 0.3 development-source
contract, not availability in an already loaded daemon or runner.

The established Connected Account owner admits one materialization snapshot
under a requester verification at entry and verifies the requester again before
returning the result. Nested field reads share only that invocation's custody;
they do not perform another Home/Machine/Session admission. Credential and
configuration revisions remain checked around the runtime callback, and field
reads retain cancellation, occurrence and observed configuration-revocation
checks. Completed materializations cannot lend authority to retained readers.
Refresh, revoke and other established operations keep their existing fences.

Executable Connected Account launch snapshots use the Agent catalog acquired
from their existing runtime-registry lease. Cold contribution declarations do
not contain every request-auth, file or environment launch fact. Reading them
alone can suppress capability production before the plugin opens; acquiring the
catalog later in materialization cannot repair that earlier snapshot. The
daemon's explicit spawn-environment handoff carries the materialized capability
into native launch without inheriting ambient host authority.
Retained runners reconstruct those static launch facts from their attested
source, not the daemon's newer global Agent, and release the activation with the
retained catalog lease. Hard revocation still refuses acquisition.

Ordinary Connected Account request-auth lookup and quota reporting inherit the
containing request's cancellation signal in 0.3 development source. Neither the
host service nor the SDK's generated private transport imposes a default phase
deadline: valid requester and credential verification can outlive the former
20-second host and 30-second transport cutoffs. Explicit caller-supplied budgets
still apply. Authentication recovery keeps its separate provider-recovery budget,
and capability, purpose, credential revision and currentness checks still run
before any bearer is disclosed.

Request-auth subjects retain the exact issuing purpose lease's in-memory
binding and materialization ports. Recovering a Session's requester Account
runtime can create another purpose owner; that recovery verifies current
requester custody but cannot replace the issuer's process-local lease map.
Capability authentication preserves these host-only ports without serializing
them. In development source, lookup refusal file logs preserve owner-issued
causes for malformed Home projections, missing or unfenced credential snapshots,
identity/revision mismatches, unavailable content or encryption material, and
purpose authorization failures. Binding and bearer callbacks share the same
cause projection. Unclassified failures add only the canonical content-free
error class and recognized exception code to the existing single lookup refusal
record; exception messages, payloads and arbitrary name/code fields are excluded.
Public request-auth errors retain their existing redacted envelope.

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

Daemon-launched runners request plugin MCP preparation through the existing
authenticated runner service bridge. The daemon retains the executable registry
lease across declaration projection and selected-server attachment; the runner
keeps directory selection, wire-name assignment, private native configuration and
tool-policy projection at their existing owners. Native-server discovery uses
that same lease so the wire-name owner can reserve names already loaded by the
Agent. Recorded Stop refuses new preparations. An applied MCP profile retires
its exact preparation when replaced or stopped. The daemon's tracked-process
cleanup also joins pending attachment work and disposes it on runner exit. HTTP
response completion does not end the Session-owned hosted endpoint. This private
development contract requires the daemon and runner to be reloaded together;
it adds no runner executable registry or public SDK operation.

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

The Host's selected-server MCP notice publisher, shared Skill-failure publisher
and optional prompt-library warning await the transcript journal's local admission, not the Home
delivery ACK. Successful admission persists the stable notice identity before
preparation returns; the same journal retries delivery and Home deduplicates it.
MCP journal-admission failure still throws to startup; Skill and prompt-library
notice failures retain their existing logged best-effort handling. Required
context, credential and post-admission currentness checks are unchanged.

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
than overriding that route with its HTTPS endpoint. An unavailable prompt-entry
transport keeps preparation pending, including for optional entries; definitive
absence can omit an optional entry with typed unavailable admission facts.
Optional plugin augmentation can report `prompt_library_unavailable` through
the committed capability notice, with no document or Account identifiers.
Required inputs, invalid or locked content, and cancellation retain their
fail-closed preparation path. Recovery is checked on the next preparation.

Independent daemon prompt augmentation and Account/Project source preparation
overlap before composition. The shared Protocol prompt-stack owner likewise
reads selected document addresses concurrently, then interprets their results
and failures in authored Account → Profile → Project → Session order. Duplicate
addresses share reads only within that preparation. Memory-off still admits
headers before deciding whether to read bodies; it never opens omitted Memory
bodies. Every document read settles before the stack returns or refuses, and
the Session plan's final Account and Profile fences still run before publication.

The Session host also prepares skills and MCP concurrently, joining both before
native open and retaining each owner's captured Account checks and cleanup.
Each selected OAuth MCP server opens its own capability concurrently; a strict
refusal waits for all issued siblings before retiring their capabilities.
Startup phase durations for skills and MCP therefore overlap and are not additive.

An explicit native refusal of startup instructions withdraws that capability for
the opened runtime incarnation. The replaceable host runtime forwards this fact
to the prompt loop, which uses its existing complete-plan prefix delivery instead
of reopening the same unsupported native path. A genuine runtime replacement
observes support again; no installed-binary capability cache or plugin-id special
case is involved.

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
Optional plugin augmentation retains the notice above; an unavailable selected
document remains pending. These source contracts require a rebuilt CLI
closure and fresh runner for loaded-runtime verification.

In current 0.3 development source, the daemon's [admission drain](../apps/cli/src/daemon/lifecycle/admissionDrain.ts) owns fresh-work quiescence. Temporary drain preserves accepted custody, native request-auth and daemon publications; reopening wakes the incumbent Automation claim loop and parked Workflow admission. Fresh turn and managed-process authorization remain closed during drain. An authorized opening or opened Session's fresh-work daemon-service request waits on that same drain under its request cancellation lifetime, then rechecks runner authority before dispatch. A reversible managed activity probe therefore cannot turn its overlap with a first turn into a terminal input refusal. No service effect enters before admission reopens. Plugin handoff retains its own exclusion and publication custody: fresh-work service requests wait for reopening, while refused publication ingress reports `daemon_draining`. Final shutdown uses `daemon_shutting_down`, including for a parked request. Final shutdown closes admission irreversibly and awaits the existing finite-operation owner's actual settlement before disposing native plugin leases, terminals or roots. Unconfirmed Stop retains that custody and keeps observation and explicit repeated Stop reachable; it does not prove settlement. Session-hosted Execution Runs ask that current daemon owner over the scoped control transport before creating a Run; an unavailable admission reply refuses the new start. Retained Run state stays with the [execution registry](../apps/cli/src/daemon/executionRunRegistry.ts), rather than becoming another drain decision or start registry. These source contracts are distinct from loaded-daemon certification.

The private Session-service request lifetime begins before its initial authority lookup and remains active through drain waiting, authority revalidation, dispatch and durable admission. Cancellation retires the waiter, withholds any unaccepted admission and clears its exact marker when cancellation occurs before acceptance is confirmed. The existing request-lifetime and admission owners retain that custody; no separate cancellation timer is added.

Control operations that already refuse closed admission keep that immediate-refusal policy, including Session spawn/replay, foreground admission/claim/options/release, runner restart, Connected Account switching and local-service actions. Their shared control-response projection reads finality from that same drain: a reversible temporary drain, unused-Stop probe or plugin handoff reports `daemon_draining`; only final shutdown reports `daemon_shutting_down`. HTTP transport and typed foreground-client errors retain the code, and the existing spawn-result and localized startup-failure owners carry it to the person. This changes the refusal diagnosis, without adding a wait or automatic retry to those operations.

The plugin-change service retains its own handoff exclusion custody and uses the same refusal codes in its existing `{ kind: 'unavailable', code }` envelope. Requests refused before preparation or after prepared-candidate cleanup report `daemon_draining` while reversible handoff holders remain; only the service's final stopped state reports `daemon_shutting_down`. Resuming every handoff holder reopens change admission unless the service has stopped. The authenticated change route, CLI diagnostic and development Actions preserve that cause.

Finite Windows PTY work now consumes the existing [native process-custody owner](../apps/cli/src/subprocess/supervision/processCustody.ts), not ConPTY's root-exit notification as a descendant-settlement fact. Its finite helper mode assigns the actual target to the same Job before execution, retains the Job until positive kernel membership absence, and returns the recorded root exit code. Ordinary managed-service helper semantics remain separate and unchanged. Completion-port notifications may be lost; explicit Stop queries/terminates that same established Job and a positive zero-membership result wakes the retained helper. A Get/Wait or output EOF alone is not this recovery. Consumer, native-platform and loaded-runtime validation remain open in development source.

POSIX natural-root uncertainty preserves the original exit waiter, cancellation subscription, output custody and finite reservation until a positive owned-group settlement or explicit recovery. That group witness does not itself prove that a non-disowned descendant in another process group exited; the job-control process-tree validation remains open. Native preparation's host-private Exec custody similarly must retain its actual supervisor resource through unconfirmed cleanup, rather than treating callback completion as process settlement.

### Session process custody (0.3 development)

The existing owner-metadata `lifecycleState: 'stopped'` and
`lifecycleStateSince` record a confirmed clean process end. The host Session loop
publishes them after native disposal for a clean Stop, graceful termination or
observed terminal exit with code zero, before semantic Session end. The daemon's
confirmed physical Stop publishes the same fact through its authenticated,
runner/attachment-fenced metadata retirement path. Startup and Resume restore
`running`. This is a process fact, separate from archive intent and the durable
explicit-Stop hold.

Heartbeat expiry, native crashes and lost observation do not publish `stopped`.
A confirmed unexpected runner exit clears that runner's `hostPid` and birth
witness, and removes its stale `running` lifecycle through daemon child-exit
tracking, before releasing the requester. The metadata CAS compares both PID
and birth time; an older exit cannot retire a replacement. A failed readiness
report may not have given the daemon a Session id, so startup retains its
failure-path CAS using the same tuple-guarded projection. Explicit Stop keeps its attachment-fenced
retirement and `stopped` publication described above.
A generic `runtime-ended` event is insufficient: it can report unexpected native
exit even when host cleanup exits zero. Disconnected status wording uses Stopped
only when the viewer can read the exact terminal lifecycle value; absent,
unrecognized or unreadable owner metadata stays Offline (list surfaces may keep
their Last seen wording). The string field remains tolerant of unknown values;
historical inactive Sessions are not backfilled from presence.

Several tracked runner generations can coexist while predecessor cleanup settles.
Private daemon-service ingress selects the generation matching both presented
capabilities, then performs the existing exact authority and currentness checks.
A mismatched predecessor is not a veto on its authorized successor and does not
lend that successor its authority.

The daemon's confirmed runner-exit path, both requested Stop and unexpected exit,
consumes [`endOwnerRemainder`](../apps/cli/src/daemon/processes/endOwnerRemainder.ts):
fresh census and the one ownership owner identify the Session's remaining proven
members for the one tree terminator. Unreadable evidence, replaced generations
and a resumed owner cannot authorize an older exit's sweep. Likely survivors feed
the same two-pass Left-behind owner; daemon startup also observes ended-owner
leftovers. These physical observations use retained requester attribution: they
never recover unrelated Account contexts or await Home admission/settings reads.
Native evidence stays fresh, including the final signal authorization; missing
attribution is not replaced with the custodian's identity. Interactive process
reads retain the existing requester-recovery path.
A deliberate process Action stamps the existing Session stop intent
before the first signal, so exit retirement records a person's kill rather than
restarting it as a crash. Explicit Stop of an already-dead tracked runner records
the same intent and awaits the existing exit lifecycle, final presence and inventory
settlement; physical absence alone is not a successful Stop receipt. An incomplete
settlement retains custody for an explicit retry. Once the terminal-host descriptor
is positively absent, historical launch metadata does not retain host custody or
block final-exit inventory retirement. Unreadable or replaced attachment evidence
still refuses retirement; Home finality, control-serviceability publication and
Session remainder cleanup retain their existing obligations.

Development-source durable resume admission has a separate
[Protocol-owned Stop record](../packages/protocol/src/sessions/metadata/sessionExplicitStopV1.ts).
Its shared reader distinguishes an absent record from malformed authority and
returns `eligible`, `held_by_person`, `archived`, `machine_unavailable` or
`authority_unavailable`; archive takes precedence over a hold. The hold includes
an admitted lead stopping a Session in its led subtree, with `managerSessionId`
recording that Stop's admitted creator. A person may resume either kind of hold.
The Session Action boundary admits led-subtree lifecycle targets for exactly
`session.stop`, `session.archive` and `session.unarchive`. Headless `session.open`
Resume of another Session is admitted only for the caller's direct managed child
(the led-subtree row's manager is the caller); `session.open` otherwise remains
current-Session-only. The existing `requestInactiveSessionResume` owner retains
its separate current-manager check and person-only handling of older holds
without creator evidence; it cannot widen that Action boundary.
Native launch rechecks the current manager, requester, Home and Machine; Action
enablement and approval policy still apply. Only successful exact native Resume
clears the observed hold; a transport acknowledgement cannot clear it.
Signed Stop metadata phases retain their original Action root for the exact
Session read and owner tuple. Home admits a Session caller's Stop through the
same current, readable recursive led-subtree owner used by Session listing.
Signed Open metadata phases remain bound to the original caller's own Session.
Ordinary Account access and current publisher admission still apply.
Clearing compares the observed request identity, so completing an older Resume
cannot erase a newer Stop. This metadata
contract does not replace physical Stop settlement or authorize a launch from
`active: false` alone.

In development source, automatic launch refusal retains that same closed reason
through the private launch-admission hook and the existing `launch_error` detail
on `SPAWN_VALIDATION_FAILED`. It is not a daemon-connectivity failure. Pending
activation preserves its retryable disposition and leaves the message queued;
the client submit result retains the detail. The composer reads the canonical
persisted admission to show “Stopped by you” with the existing Resume action,
instead of a generic queued message or a retained Guard wake promise. None of
these presentation facts can clear a hold or admit a launch. A loaded-daemon
replay remains separate from source validation.

Processes and widget Session Stop use the existing `lifecycle_control` intent
through the same exact-runner Stop owner as Guard: they free resources and let
the next ordinary message request wake. `recordSessionStopIntent` owns whether
an admitted Stop writes the durable hold. These resource controls neither write
nor clear a person/manager hold; Info → Stop session retains its `explicit_stop`
hold and still requires an admitted Resume. A Session's Start again/Undo result
remains `already_wakes_on_next_message`, without changing Stop metadata.
The physical Stop barrier, requester custody and later-Stop launch fencing
apply to both intents. This describes development source; loaded-daemon replay
is a separate validation step.

In development source, the hosting daemon can observe pending Session follows
without a receiver host. The existing exact-Session Account-change callback and
startup/reconnect visitor pass the strict inactive observation to
`sessionFollowOccurrenceDispatcher`. Original-backed events enter Pending there;
an unavailable dispatcher or source range cannot fall through to another wake.
Only a fully traversed source may offer a manager's no-original Turn outcome,
using the same `shouldWakeForSessionFollowWorkerUpdate` selector as live intake.
Transcript Goal changes and human messages cannot select that Turn-only wake.
The probe checks
the committed Home, Account, Machine and installation, opens the source under
the captured requester's Home, and delegates eligible launches to
`requestInactiveSessionResume`. An unrelated Session change does not start an
Account rescan. Selection and launch neither clear a Stop hold nor advance source
progress; the resumed host retains native admission and acceptance ACK ownership.
Loaded-runtime validation remains separate from these source mechanics.

Fresh positive zombie observations count as exited even if native ownership
enrichment has disappeared before reaping. Live and unknown members still require
the same current ownership proof before any signal.
Runner-bound control retirement may clear that runner's historical hosted
projection only while the descriptor remains absent and Home metadata still
matches the departed runner; a retained host or replacement runner refuses it.
Windows runner-held Jobs survive daemon restart without
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

Native Project preparation's existing failed-phase diagnostic includes the
pending sub-operation and, on cancellation, the aborted launch, ingress or
operation signals plus a fixed abort-reason category. Runner-authority refusals
name the failed snapshot, Session, source-custody, process or turn-witness
predicate. These diagnostics contain no exception text, paths or credential
values and do not change cancellation, retries or preparation deadlines.

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

In 0.3 development source, passive publications refresh only the owner that
invalidated its facts, retaining the other owners' latest projections within the
inventory lifetime. An Automation claim observation therefore does not demand a
fresh read of every settled Session. Explicit inventory and decision reads still
query every live owner; concurrent full reads share only an in-flight observation
at the same invalidation edge, never a completed or partial passive result.
New owner edges capture immediately, and superseded observations cannot publish
late or confirm idle. Disposal releases the retained projections.

In 0.3 development source, the daemon's Workspace Sync runtime compares Project
scope, WorkspaceRefs and relationships with its successful reconciliation input.
When no relationship belongs to the local controller and its activity coverage
is complete and empty, equal refreshes advance Project graph settlement without
enqueueing material Sync work or resetting the Machine's idle interval. Installed
local relationships retain native bootstrap and custody reconciliation, including
while their desired inputs are unchanged. Changed inputs retain normal busy
admission. Project withdrawal, failed or partial recovery, and supervised sidecar
replacement require reconciliation even when desired inputs are equal.

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
Healthy-process heartbeat checks retain process and terminal supervision, but
do not invalidate Session work: process presence proves no work-state change.
Actual host activity and lifecycle notifications still invalidate the inventory;
explicit reads, including final eligibility checks, query fresh live Session
work. Unavailable coverage remains unknown until a real notification or read
recovers it; a healthy process alone cannot authorize idle. Passive daemon-state
publication is not fresh decision authority: Guard, idle confirmation and storage
eligibility retain their explicit live reads.

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

Activity reads own short guest-local probes: the guest releases the probe before
replying with signed idle evidence, including when delivery or the controller's
operation later fails. The selected unused interval and approval wait retain no
probe drain and do not depend on a second resume RPC. The native-effect guard
confirms idle again and retains admission closure immediately before Stop/Delete;
once native IO may have started, an uncertain result does not reopen admission.

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

For controller-free Account rows, the same root issuer qualifies the signed
guest or private Account daemon through
`resolveSignedManagedAccountExecutorInTx`. Its existing signed binding carries
the exact power/delete input in `managedAdmission` and the retained guest in
`managedAccountExecutor`. Activity/drain spends that owner fact against the
active row, control request and intent; it does not repeat executor eligibility.
Plain and encrypted HTTP roots carry the same control projection. Native
controller roots retain their existing Manage admission and guest transport.
This is an unreleased 0.3 contract; it adds no signer or stored authority.

The daemon's managed-policy runtime rereads the current installation-signed controller census on controller-specific managed-row Account hints, its own Machine changes, targeted accepted Pending/Run work, Team admission changes and reconnect/recovery edges. The existing Account-feed reader classifies these wakes; unrelated Account, Pending and Run traffic does not schedule a census. Changes to an origin already held by a driver still reconcile that work. Managed controller replacement also invalidates the former Machine, so coalescing the managed Account row cannot hide retirement from its old controller. Daemon startup mounts that single subscription owner with the current Machine transport and retires it on replacement or shutdown. Replacing the retained native resource or enrollment retires the old held policy lifetime; the driver's own intent/submission progress does not. Selected idle/deadline waits remain with the native driver, not a polling loop. Automatic policy effects still pass through current Actions policy and its existing approval Artifact lifetime; installation signatures do not substitute for human Ask approval. Approval retains the same host operation and approved execution context. These development-source paths still require composed and loaded-runtime validation.

Policy preparation reviews the native effect without admitting a new desired
intent. The approved callback rechecks the retained row and then commits that
intent before native submission. A finite external Action also rechecks its
original Session publisher through the final guarded wake transport boundary;
retiring that publisher cannot leave a valid wake authority behind.

The installation-signed census also rediscovers canceled creations awaiting
immediate cleanup before resource/Machine binding. The same policy driver can
delete a declared, retained native-operation handle; unknown handles remain
recovery work and cannot supply a native target. No new cleanup queue is added.

## Background-service process custody (unreleased 0.3)

The plugin background-service lifecycle owner also runs host-owned background
services. It owns demand, coalesced follow-up runs, settlement and retirement;
`placement: 'process'` selects its child-process adapter rather than a second
runtime or managed-service registry. Launch uses the binary-safe Happier CLI
launcher and the shared
[`process custody`](../apps/cli/src/subprocess/supervision/processCustody.ts)
and supervision owners, including process-tree termination and Windows Job
custody. The ordinary process census observes that child independently of the
daemon.

The daemon retains admitted source custody, currentness and invocation authority.
The child runs the selected runner and consumed reader surfaces from that admitted
source. It cannot publish a catalog, admit Actions, start sibling contributions or
migrate public daemon databases independently. Its service bridge delegates those
operations to the existing bound daemon owners; public database callbacks and
transaction handles retain their original ownership.

A finite demand runner returns when its work is complete. The lifecycle joins
child termination before reporting successful demand settlement; the next demand creates a
new child.
Plugin retirement and daemon shutdown send abort and join that same path. A crash
is a visible background-service failure, not successful completion. Host placement
adds no idle timer: work settlement decides when a demand child ends. The
[plugin platform contract](plugin-platform.md#background-service-placement-unreleased-03)
owns declaration defaults, caller cancellation and process-service availability.

## Managed service custody (0.3 development)

The incumbent [managed-services owner](../apps/cli/src/plugins/runtime/invocation/services/managedServicesOwner.ts)
and [process supervisor](../apps/cli/src/plugins/runtime/invocation/services/managedProcessSupervisor.ts)
own both plugin-scoped services and host-admitted Project services. Project
admission carries the accepted Workspace, source-qualified declaration, cwd,
reviewed effect and authenticated requester attribution into the same semantic
entries. Built-in Project services do not fabricate plugin identities. Their
actual supervisor-issued instance id, not the stable declaration id, identifies
current controls; feed and preview consumers project the same handle and snapshot.

Native liveness inspection continues under the service watchdog. The supervisor
publishes lifecycle observations only when state, native phase, readiness or the
admitted endpoint changes. Successful ready samples still refresh
`lastHealthyAtMs` for direct snapshot reads; timestamp-only samples do not wake
lifecycle subscribers. Inspection failure withdraws running evidence once, and
recovery publishes the newly observed facts through the same owner.

Native output is collected only for a failure transition or one explicit failed
health inspection. Healthy and unchanged watchdog observations perform no log IO.
The optional public `ManagedServiceNativeLifecycleV1.logs` callback receives the
existing diagnostic byte budget and admitted invocation context; an adapter
without it retains the failure diagnostic without output. Built-in Compose
uses its already-admitted container IDs and a bounded Docker tail. The supervisor
sanitizes and retains this output as `native_service_output`; it is a bounded
failure diagnostic, not a long-lived Service output reader. Observed resource
death withdraws its endpoint before awaiting output, then publishes terminal
custody after collection so automatic cleanup cannot retire the output read.

The development Local Services launcher feed carries only diagnostic code,
severity and sanitized message while a managed lifetime is failed or unhealthy.
The strict launcher target schema and existing Services row target carry those
facts to the client; recovery omits them even if the supervisor retains earlier
diagnostics. Private diagnostic details and remediation never enter this projection.

An unexpected Project Service process exit is a failed lifetime, including an
endpoint-free command that exits immediately. The supervisor projects sanitized
output from that process's existing bounded terminal result; it adds no output
subscription or retention policy. After confirmed cleanup, the same semantic
entry retains the failed attempt and its supervisor-issued occurrence for review.
Failed native starters and native resources already stopped at initial inspection
use this same failure presentation. Explicit Stop clears the attempt; a freshly
reviewed retry replaces it through the incumbent owner, and a recovered running
target omits failure diagnostics. Unconfirmed cleanup retains actual custody and
cannot become a settled failed attempt or permission to start a replacement.

Complete Project binding reads join an in-flight establishment at this owner and
re-read its published handle before returning. A pending Start or Move therefore
keeps its native read pending rather than publishing a Machine-unavailable
failure. A failed establishment with confirmed cleanup returns its retained failed
attempt in complete reads, while its Start operation still rejects. Unsettled
establishment, retired custody and lost currentness refuse the complete read;
an incomplete snapshot never establishes absence or Start
permission. Ordinary diagnostic lists remain synchronous views of published
handles. The existing native establishment lifetime governs the wait.

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

In 0.3 development source, `session.status.set_reason {reason}` edits the current
Session's explanatory annotation through the registered `display.statusReason`
field. Its binding writes only `work.statusReason` through the existing metadata
CAS owner; `null` clears it. Host-stamped Session caller context fixes the source
Session, and the Action accepts no target selector. Runtime lifecycle, thinking,
process facts and work-item status-reason codes retain their existing owners.
Authorized readable awareness carries the explanation separately; locked or
unavailable content omits it. The UI can consume that projection without deriving
a second runtime status.

In 0.3 development source, an acknowledged Session birth can survive a failed
first native open without a published Agent runtime identity. Inactive recovery
uses the canonical qualified-target reader to recover that birth's admitted
creation target, keeping its existing Session, workspace and Pending custody.
Initial model and permission choices feed the ordinary snapshot arbitration;
newer saved intent still wins. An existing Agent identity takes precedence over
the birth recipe after a cutover. Explicit `session.open` resume and a newly
authorized Pending activation share this recovery owner.

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

OAuth capability issuance refuses an unavailable Connected Account credential
snapshot without fabricating material or borrowing another Account or Home.
That per-server `initial_admission` failure is not itself a Session startup
failure. `materializeMcpServerConfigRecord` owns strict refusal versus optional
server omission for ordinary, Agent-spawned and recovered Session startup;
the runner passes safe request-auth failure codes to that owner. Non-strict
startup skips the server and publishes the existing capability notice. Strict
MCP policy still refuses startup, and explicitly selected Saved Secrets retain
their typed refusal even under non-strict policy.

In 0.3 development, these selected-server startup notices await durable local
transcript admission, not the Home delivery ACK. The existing mutation journal
retains and retries the same notice; captured Account scope is still rechecked
before prepared MCP configuration returns. Other Session events keep their
existing delivery waits, and an explicit required-delivery admission cannot be
overridden by an optional diagnostic wait preference.

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
only with a reliable live inventory. GC runs at those lifecycle boundaries,
marking the complete Artifact-library inventory, first-party content and every
live Session/Run digest. Unknown Artifact-library inventory or an unreadable
session manifest blocks sweeping. Unpinned plugin delivery caches are evictable
without complete plugin-skill coverage from every Account Machine: each new
delivery rereads the plugin's canonical content before materialization.
Supporting files retain executable bits; native skill roots remain read-only inputs.
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

Memory-write and approval-request exposure admission uses the Account Artifact
store's read-only grants and public-share census, without opening Doc content or
preparing recipient keys. Both requests retain the original requester's signed
authority at the captured Home. Home admits only these exact reads under that
root; exposure inspection grants no content, key-repair or sharing mutation
authority.

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
not Machine-offline evidence; only an explicit target-unavailable response
records that failure. If this client's Account transport drops, retained Machine
presence becomes unknown until an authenticated presence update or admitted
Machine-presence census re-observes that Machine in the same Home and Account. Reconnecting
alone does not renew a retained heartbeat. The shared presence projection keeps
the Machine's identity, while execution admission remains closed for unknown
presence. A fresh observation restores the ordinary verdict, including offline;
the heartbeat grace is unchanged. Explicit Retry and refresh still issue the request that can establish
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

Repository code rollback has a separate host owner in 0.3 development source.
The Session runner binds `session.checkpoint_code_rollback` beside the repository
checkpoint lifecycle, using its Git context and the existing SCM rollback
executor. The host checks the Session, worktree and checkpoint scope before
applying the reverse patch and retains a backup checkpoint. Agent runtime facets
continue to supply native conversation rollback; they do not supply this Git
effect. The composed source test covers Action execution through the registered
Session RPC and real Git. Loaded-runner approval and file-state verification
remain separate evidence.

Claude native task completions use the plugin's existing task-notification
projector across SDK, terminal and transcript readers. Historical 0.2 metadata
results are accepted only as one tool result matching the origin's tool-use id;
their recorded failed/stopped status corrects the released false error bit.
Ordinary metadata retains its visibility filtering. These are development-source
contracts, not claims of released availability or loaded-provider validation.

The [input consumer](../apps/cli/src/agent/runtime/session/input/sessionProviderInputConsumer.ts) owns provider-input dispatch custody and admission quiescence. Ordinary dispatch and model-transition admission transfer use the same async custody scope. A runtime replacement initiated within an active dispatch retains that custody and drains other dispatches plus pending materialization; it does not wait for itself. External replacements drain all dispatches. Settled dispatch scopes cannot lend custody to later asynchronous continuations. This is a 0.3 development-source contract; native reply verification is separate evidence.

In 0.3 development source, OpenCode V1 input acceptance consumes its unique committed
native user message independently of the long V1 message HTTP response. Live
message/status events wake an authoritative inventory read; the native Session,
nonblank user identity, submitted prompt and creation time must bind to the current
host turn. Missing, foreign or ambiguous native identity leaves delivery unproven.
A later HTTP response failure cannot erase proven native acceptance or establish
native finality. Busy, compaction, tools and permissions retain their existing
native lifecycle; an assistant `finish:stop` alone does not settle the turn while
the native operation remains active. The plugin supplies this evidence through
the existing Session SDK input receipt; the host retains custody and turn ownership.

In 0.3 development, a missing launchable Agent CLI carries `agent_cli_missing` from both the command/terminal launch owner and the native plugin system-tool binding. Startup sanitization preserves that code; the primary Session issue classifier projects `dependency_failure` with static installation/path remediation. It does not expose raw startup error text or infer acceptance from a failed prerequisite.

The same closed startup-diagnostic owner preserves
`plugin_services_managed_provider_authority_unavailable` in the existing primary
Session issue and public status. Its fixed preview directs the reader to check
the Gateway and its Machine connection before retrying; private authority or
lease details never become the public error message.

In 0.3 development source, the runner diagnostic and primary Session issue also
retain the host's closed MCP preparation, runner-generation, daemon-authority,
unknown-outcome and shared skill-delivery refusal codes. Arbitrary plugin codes,
messages and details remain excluded. If the runner exits before native open,
the original launch operation uses the same requester-aware Home failure reader
as startup recovery. Only a known primary Session failure observed at or after
that runner's birth supplies its existing `launch_error` code and fixed preview;
stale, unknown or unreadable evidence retains `SPAWN_FAILED`. This diagnostic
projection does not change admission, Stop, retry policy or native-open authority.

The same mapping retains `team_credential_provider_selection_not_current` from
Team binding preparation through runner exit, the primary Session issue and
the original launch result. Its fixed preview asks the requester to review the
Team model selection before retrying; raw Home responses remain private.

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

Codex app-server transcript projection also has one owner for native tool
identity. Typed commands and their raw echoes share that identity; code-mode
`exec` envelopes are suppressed only when a newly observed native tool has one
eligible same-turn invocation. Yielded cells remain eligible after returning their
initial result. When several invocations could own the tool, their envelopes stay
visible, preserving independent failure evidence. A raw or typed echo of an
already observed native call cannot be attributed to another invocation.
Native approval subjects carry the tool call identity to the host permission
owner, while transient interaction custody remains host-stamped. Plain native
Sessions bind app-server model discovery to the host model publication service;
the host remains the writer of `sessionModelsV1`. External Provider catalogs
retain their authorized publication path. Native model display names pass through
the shared display-name resolver, and unobserved discovery preserves retained
facts rather than inventing a catalog or a friendly name.

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

In 0.3 development source, the host's ordered terminal transcript importer waits
for durable Home publication under the containing follow lifetime. The public
author-listener deadline does not limit that host work; cancellation and source
retirement still release its waiter. Post-admission loss travels through the
existing source-follow handle's failure observation to the Agent's evidence
ledger. Claude terminal and SDK paths retain unknown observation while the host
keeps its Activity publisher and Session or Run controls alive. A source failure
alone neither proves native process exit nor retires Home publisher authority.
These source contracts require a fresh runner after reload for live validation.

Fresh Claude SDK SessionStart hooks can precede creation of the native transcript.
In 0.3 development source, ordered history acquisition waits for the existing
authenticated accepted-prompt transcript proof; its pending observation scope
keeps Activity unknown. Successful source admission retires only that pending
scope, preserving real observation loss and outstanding native tasks. Refused
acquisition leaves the baseline pending rather than marking the native stream
lost, so later admission of the same binding can settle it. Authenticated native
restart receipts remain pending for the existing identity-filtered reconciliation
after actual history admission. Resumed
histories still acquire their historical baseline at SessionStart. This source
correction requires a fresh loaded-runtime replay; it does not clear a running
Session's retained observation loss.

Hosted `SessionStart` and `UserPromptSubmit` forwarders wait for the host hook
handler's acknowledgement under the native synchronous hook's timeout and process
lifetime, without a shorter local delivery deadline. Normal native progression
therefore waits for authenticated transcript grant and follower acquisition.
Other observational hooks, including qualified external Session hooks, retain
their non-controlling 500ms attempt. Failed HTTP delivery, transport error codes,
and unreadable secret-file error codes are reported on stderr without secrets, paths,
hook payloads, or response bodies. Transport rejection or disconnection still exits
without a native policy decision; missing transcript proof keeps Activity unknown.
The [native hook owner](https://code.claude.com/docs/en/hooks#timeouts) retains
cancellation and timeout behavior. This is a 0.3 development-source contract.

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

After the live prompt loop has taken input custody, retryable
`preparation_pending` failures retain that exact input before native dispatch.
They do not publish a failed Turn or write a provider-rejection block. The existing
recovery wait observes Session metadata/reconnect or new queue growth. Retained
preparation also retries using the offline reconnection owner's jittered backoff,
without an attempt cap, so silent Home recovery can resume the original input.
Event wakes can retry sooner; each attempt re-runs full preparation and its
currentness checks. Replay-seed retirement keeps its event-driven wait.
Required Follow originals preserve classified Home source-read failures through
the hydrator and reconciler into this same recovery wait. Definitive refusals
still block the input; optional Follow context retains its omission behavior.
This recovery adds no Pending row or provider acceptance and changes no HTTP
timeout.
Cancellation ends the wait without native delivery, leaving
durable input recovery with the existing Pending owner. Required context is
never omitted to make the retry succeed. Permanent preparation refusals retain
their existing typed rejection and failed-Turn path. This is 0.3 development
source; the loaded-daemon outage/recovery journey remains a separate check.

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
ACK wait. The trusted Discussion post/create handler likewise does not impose
a shorter timer on the publisher's serialized admission queue; current-publisher
checks and the transaction owner's resource budgets still apply after admission.
Connected shutdown retains the ordinary write lifetime while draining;
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
an exact turn end with a matching, committed non-positive receipt settles through
that same rejection path, preserving its decision and original mutation. Home
replays that decision by mutation id, so timer, reconnect and restart recovery
do not redeliver the deterministic refusal or report positive delivery. Unrelated queued
mutations can continue, while explicit failed prerequisites retain the existing
dependency-failure behavior. Authentication recovery, transient transport
failures and unmatched receipts keep their existing custody. This does not
relax the server's completion-anchor validation: the ordered host lifecycle
publishes acknowledged user, range and final assistant anchors together.
Loaded native completion and next-prompt recovery require a separate replay.

An exact daemon turn marker is local runner/admission authority, not proof that
Home has a `SessionTurn`. Input admission can record its host turn id before the
native Agent starts. The host lifecycle also records the exact marker before
admitting `begin` to runtime custody; a runner can exit between those operations
with no start row to deliver. Observed exit uses that same host id,
not the separate provider `agentTurnId`. A matching committed `missing-turn`
receipt is therefore a legitimate final refusal for conservative exit evidence.
It must settle through the rejection path above. Marker presence alone cannot
justify synthesizing a begin for an Agent turn that never started, and moving
marker publication after delivery would leave admitted local work without its
existing runner authority. This describes the 0.3 development lifecycle, not
historical attribution of every retained exit journal.

Tracked handoff accepts cancellation during preparation, then closes cancellation immediately before target launch begins publishing canonical Session metadata. Confirmation, commit and source cleanup use the completion signal after that point; a late cancel request cannot abandon the accepted target launch.

`SessionHandle.watch` follows committed retained transcript rows through the shared socket source and delivers complete text before advancing its reconnect frontier. Provisional stream deltas do not become retained message events. Cancellation ends the watcher; credential and plugin-occurrence checks prevent further delivery after retirement.

For cold native history catch-up, a Session factory may declare `transcriptIdentity`, its pure provider-owned identity codec. The bound `transcripts.reconcileSourceIdentities` operation uses the canonical paginated transcript reader and encryption/semantic decoder, filters conversation rows to the selected Agent, and supplies only the codec's declared correlation fields. It checks the current Session, plugin occurrence and native Session identity before and after the read. Unsupported, failed or malformed reads reject rather than becoming empty coverage. OpenCode hydrates its existing authored-ID tracker from exact committed identities, including witnessed 0.2 predecessor mappings and import IDs. Its current percent-encoded import IDs preserve opaque identity tuples; the predecessor codec compares complete constructed legacy or JSON-tuple IDs only after checking a separate exact native-session witness, never by splitting opaque IDs. Unprovable legacy coverage is reported through the existing informational Session-event and default log owners; only that historical snapshot is suppressed, so subsequent settled native turns can still sync. No new identity registry or transcript writer is introduced. These current-source contracts are distinct from full authenticated live validation of the composed 0.3 runtime.

Normal input and in-flight steer use the shared [host dispatch preparation](../apps/cli/src/agent/runtime/turns/prepareSessionInputForProviderDispatch.ts). It delegates selected skills, plugin references, attachments and media to the canonical structured-input resolver immediately before provider effect. The resolved envelope reaches the Agent through the same typed turn metadata, and its JSON projection counts toward required context before optional Follow context is fitted. Native slash commands retain their leading grammar with resolved context after it. Resolution failure is rejected before provider effect with its existing diagnostic and retryability; an undispatched replay-seed association is released. Steering rechecks Session binding, turn availability and admission after asynchronous preparation. This describes 0.3 development source, not completed loaded-runtime validation.

The [Session prompt-plan producer](../apps/cli/src/agent/prompting/coding/sessionPromptPlan.ts) prepares coding policy through the canonical Launch Profile reader, including authorized published-profile Artifacts. Prompt rendering, title-tool advertisement and permission admission consume that same prepared fact. Session-owned retained Runs read it through the existing internal runtime-control binding; their Run intent id is not a Launch Profile id. A missing or retired producer, or failed preparation, withholds title-tool advertisement and admission until the policy is available again. An unresolved profile retains the canonical Account-default policy. No new policy wire field or persisted policy copy is introduced.

The host fits retained WorkerUpdates against the current optional context allowance before dispatch. A still-deliverable wake that cannot fit stays with the input consumer until context/source, metadata, admission or user input changes; parking neither commits a transcript event nor acknowledges provider acceptance. Source admission is rechecked before parking, so a withdrawn wake releases custody even if it still cannot fit. User input keeps priority, and the retained wake is reconsidered afterward without selecting its producer again.

In 0.3 development source, every represented WorkerUpdate enters durable transcript custody under its completion identity before provider dispatch, including updates attached to ordinary input or in-flight steering. Context-only wakes use the same event publisher. Failed transcript admission withholds provider dispatch and leaves the producer's existing custody pending; exact provider acceptance retires that custody only after successful admission. Several worker cards may share one native input.

### Usage-limit reset continuation (0.3 development)

The shared Session usage-limit controller owns ordinary waits, including
foreground CLI sessions without a daemon. It uses the common recovery scheduler
and control router; optional native quota probes supply evidence rather than a
second continuation owner. A reported reset time can drive continuation without
a provider-specific probe. Missing timing uses the existing recovery backoff,
and transient probe failures retain the authorized wait. Inactive waits are
restored after machine-control registration and wake through fresh session
resolution. Native quota and credential failures without a Connected Account selection do not enter
Connected Account authentication recovery.

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
competing provider-local recovery path; ordinary live attempts use the shared
Session controller. Explicit ordinary user input goes through Pending
rather than waking an automatic continuation during pre-admission revalidation;
the dispatcher suppresses obsolete continuation when newer input is queued.
Automatic continuation revalidates the current issue and recovery intent before
admission. Cancellation, a replaced issue, newer user input
and disabled automatic resume take precedence; the original interrupted input is
never replayed. Readiness, account-switch and runtime-launch acknowledgements
alone do not dismiss a usage-limit warning. Accepted Pending admission hands
continuation custody to the existing queue and activation presentation; it does
not prove provider quota recovery. Explicit cancellation or subsequent Agent
activity can also end the wait presentation. A failed reset request releases its
checking state for retry. This development-source integration
still requires composed loaded-runtime validation.

Protocol's `buildUsageLimitIssueFingerprint` owns issue identity across reporting,
controls, and presentation. Runtime-auth classification captures the accepted
failure's identity and projects it separately from `runtimeAuthRecoveryAttemptId`.
Recovery timing, cancellation, and action targets apply to the current issue only
when their fingerprints match. Older opaque attempt fingerprints remain readable
but cannot establish that association. Live Check Now reads the public issue
through the Session's existing authenticated Home transport when needed; an
unavailable read returns an error, while a different issue uses its current local
controls. Explicit new input still supersedes prior automatic waits independently
of their issue identity.

### Goals without native controls (0.3 development source)

The Session Goal router retains native Goal controls when available. When no
native Goal adapter exists, `happierSessionGoalControlAdapter` stores the
objective as a Happier-origin item in the existing Session work-state field.
Writes use the target daemon's durable work-state custody; a missing writer
cannot acknowledge success. Other work-state sources retain their items.
The Goal control uses that daemon capability for Agents without a native Goal
declaration, including configured ACP and installed plugin Agents. Keep going
owns continuation for those Sessions; the host objective adds no native Goal
capability or second continuation loop.

Inactive Goal Set, Get and Clear from an Action host without work-state custody
route to the target Machine's registered daemon Goal handler, including when the
caller runs on that same Machine. Native Get can refresh the persisted work-state
projection, so it uses that custody too. The daemon invokes the declared inactive
facet and commits its projection through the existing mutation outbox. These
controls do not resume the Session unless the caller requests the existing
Set-with-resume operation.

For an opened native-Goal Agent, the host's native Session input dispatcher
serializes Set and Clear with new prompt dispatch. A mutation received during
an active turn waits for that turn's existing completion and publication boundary;
later queued input follows the mutation. The Goal receipt still waits for the
Agent's native acknowledgement, and Get reads the canonical work-state projection.
If that acknowledgement precedes release of the native transport, ordinary
input remains in the host dispatcher while the Agent's optional passive
`activeInput.waitForInputReady` observation settles. The host then rechecks
input custody and Session retirement before authorization and send; the Agent
does not own another prompt queue.
Queueing does not publish a synthetic Goal. Session retirement refuses queued
mutations before they reach the Agent. Loaded-runtime replay remains required
before this development-source correction is certified.

Native controls demand the existing Session event subscription before reading
the admitted native identity. Get immediately after Resume can therefore use a
replayed startup identity even before a transcript subscriber opens.
The host retains that accepted identity snapshot for the later subscriber;
observing it does not admit another turn or Goal transition.

Codex's App Server path opens and persists its zero-turn native thread during Session startup,
including when no startup instructions are supplied. The existing native
attachment owner makes that thread readable by later attachment and inactive
control clients. Live Goals use the client already holding the thread and
start no additional native process. This does not submit an ordinary prompt.
Pre-input Set and immediate Get use the same native Goal codec and host
work-state publisher as later controls; no pending-objective store is added.
A missing native thread retains the unavailable result and names the
`native_effect` failure phase.

On native Codex resume, the Goal source reads `thread/goal/get` before accepting
empty-state notifications. The resume response has no Goal field, and initial
absence before that read cannot clear a retained Goal. An explicit `goal: null`
read or a subsequent native clear publishes an empty source snapshot through
the same SDK work-state publisher. Missing or malformed Goal payloads leave the
retained projection intact. This is development-source behavior; the composed
Stop/Resume replay remains required on the loaded runner.

In 0.3 development source, the Session metadata publication owner and the
inactive daemon's work-state delivery compare the effective Goal before and after
the successful work-state commit, including a clear. Both use the same effective-Goal
comparison. A change appends one content-free `goal-changed` transcript original;
equal snapshots, usage/progress-only updates and refused writes append none.
Native reopen/readback compares the final updater's before-and-after Goal, not
the client's possibly stale or independently refreshed metadata snapshot.
Follow hydrates that original as a source-linked notice under the shared event
policy. The daemon uses its existing transcript custody and the same Goal event
local-ID codec. Its Account-authenticated HTTP append does not supply a live
publisher's authority; the current server personal-notification path requires that
authority, so the daemon append alone does not deliver a personal alert. Inactive
Goal changes remain available to Follow/Voice readers on their next read; no
separate off-source personal-alert authority is added (R-ORC-3).
The existing transcript append retries while the process lives. A crash
between the Goal commit and append may lose that follower notice; the committed
Goal remains durable and visible. No separate notice receipt or delivery ledger
is created.

Claude can persist an active Goal sentinel before its native command echo. The
Goal source joins that sentinel to the exact SDK command UUID through the echo's
`parentUuid`, then awaits the host publication acknowledgement. Set can settle
while native work continues; it does not wait for another active attachment or
provider completion. An unrelated sentinel or echo cannot acknowledge the command.
When an authenticated SessionStart changes the native Session id, the source
discards the preceding transcript's learned id before processing the new file.
The new sentinel can then join its exact command echo even when that idle query
starts a fresh native conversation.
Native settlement failures may carry the closed, content-free
`goalControlFailure.phase` receipt through the SDK, host router, Action result
and UI Goal operation reader. CLI JSON failure envelopes retain the same facet
under `error.goalControlFailure` in generic `actions invoke` and the shared
friendly-command presenter. The standalone CLI's daemon HTTP reader uses the
canonical Action failure projection to preserve the same strict facets while
excluding daemon-private top-level fields. The daemon's inactive native-control
adapter retains the same receipt when a live Session method is unavailable,
including before a native thread exists. Each projection validates the same closed facet
and drops malformed diagnostics without discarding the refusal. The runner's
existing RPC completion record logs that phase once; vendor error text, objective
content and local paths are excluded from this diagnostic facet.

In 0.3 development source, Codex Goal Get/Set/Clear failures also retain a
content-free stage, exception class and recognized error code in the existing
diagnostic/result `details`. This distinguishes client creation, initialization,
the exact native Goal RPC and host publication. Active and inactive adapters and
Session RPC projection share the Action-result diagnostic projector; arbitrary
plugin details, vendor messages, Goal text and paths are dropped. Unknown error
codes remain null. These fields diagnose a refusal without adding a retry or
changing its settlement phase.

The Codex control owner also records a closed local refusal condition rather than
native error prose. Codex 0.162.1 uses `-32600` for several distinct refusals;
that code alone does not prove disabled Goals or a missing thread. Only its exact
disabled-Goals refusal from a Goal RPC returns `unsupported` with
`codex_goals_disabled`. It does not override native configuration or resume a
thread. Missing-thread, ephemeral-thread and identity-mismatch conditions remain
content-free diagnostics under the existing unavailable result. Bundled and
installed Codex plugins share this control owner. Loaded QA acceptance remains
separate from the isolated native contract test.

An active origin Session receives Workflow continuation through its existing
context-only `workflow_step` queue. Preparing that input authorizes the exact
Session and workspace but does not resume or reconfigure a live runner.
Inactive origins still use canonical Session resume before the offer.

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

An authored `configuration.workspaceWrites` ceiling is committed before native
Session admission in the existing owner metadata's `runtime.workspaceWrites`
field. Attach retains it. The same Protocol workspace-policy reader combines
it with the selected Role: either denial wins, and removing or relaxing a Role
cannot relax an authored denial. An authored `allow` adds no ceiling. Native
admission refuses an Agent that does not declare enforcement of denial. Claude
enforces denial through its native launch
settings; an unchanged ceiling is not a live TUI directive. Happier Actions
that do not write the workspace keep their ordinary Action approval policy.

Session Role Actions read Account overrides and retained role sources through
the Session runtime's existing private owner-Account context. The shared prompt
library loader and Protocol parser serve that context and ordinary CLI Account
reads; private catalog preparation never publishes Settings or catalogs into the
focused Account. Credential retirement withdraws the private context rather than
borrowing the focused Account's Role policy. This is a development-source contract,
not certification of an already-loaded daemon or exported UI.

Public Session-owned Run starts with an explicit role, including Second opinion,
prepare that same private Account context before the shared agent-start policy
resolves and stamps the role. The request carries role identity only; installed
Agents use the same host preparation. A live Session supplies freshly resolved
roles from its retained role owner; its runner's cold built-in Agent inventory
cannot replace that installed-source observation. Standalone callers retain
their Account-backed inventory and the same Protocol role resolver. An unavailable
context returns `target_unavailable`; typed role-owner refusals retain their
error code. Both carry `details.executionRunStart.runCreation: 'noRunCreated'`
and a closed `refusal: { code, phase: 'agent_start_context' }`. The refusal code reuses
the existing availability reasons, including `role_overrides_unavailable` and
`role_source_incomplete`; role text, credentials and source payloads never enter
that evidence. The existing start-failure projection retains it through RPC
normalization. Loaded-runtime verification remains separate from this source
contract.

Creation origin, current turn initiator and causal work depth are separate host
facts. The [turn stamper](../apps/cli/src/agent/runtime/session/turn/stampTurnFacts.ts)
distinguishes user, agent-session, workflow and host input; a user turn has depth
zero, while the start-policy witness retains the Session's starter depth as well.

For accepted protected originals, root ownership comes from the admission receipt:
an Account receipt must name that Account; a Machine receipt must bind the exact
Account and source Session in `admittedTarget`. Follow and Discussion carriers
do not become direct originals merely because they have a user role. Inherited
roots retain their existing lineage, and exact Execution Run inputs remain outside
this Session-root selection. Reporting membership can change without rewriting
these facts. The shared start
policy enforces role engines, permission ceilings and the Account work-depth
limit; consumers do not infer authority from a tree row or worker result.

Autonomous conversation check-in is separate from that structural start policy.
The [exchange reducer](../packages/protocol/src/sessions/messages/autonomousExchangeV1.ts)
counts actual agent-caused new turns, including a `followUp` that starts a turn,
through the original input's host admission and accepted-turn facts. Selection,
enqueue, true same-turn steering, quiet context and returned answers do not count.
The Account setting `coordination.autonomousCheckIn` defaults to five starts;
`afterTurns: null` means Never pause. Continue, ten more and Stop control held
continuation through the same original-input owner. They do not reset causal
work depth, raise a permission ceiling or change an individual Run's turn budget.
Unavailable authority holds unstarted work; it does not create a host-local
counter. Cross-Account and exact-Run start integration remain separate validation
obligations, not guarantees supplied by this reducer.

The [Session reply path](pending-delivery.md#correlated-session-answers-03-development)
uses that original input's custody for one exact answer or typed terminal outcome.
An informational return adds no check-in count even when admitted to wake an idle
asker. The shared
[receiver decision](../packages/protocol/src/sessions/follow/sessionReceiverDeliveryV1.ts)
distinguishes wake intent, next-turn context, hold and drop; enqueue or resume
success alone is not proof of an accepted new turn. Follow and Discussion delivery
consume these owners rather than maintaining their own conversation caps.

In unreleased 0.3 source, successful file-review Discard and Restore Actions
emit one `file_review_note.v1` transcript item per receiving Session, covering
all affected paths; successful Undo emits the same item kind after its guarded
write. Keep emits none. Delivery uses the existing receiver's `next_turn`
intent and never resumes or steers the Agent. Authenticated Pending admission
stamps the closed, content-free `nextTurnNote: 'file_review_note.v1'` operand
into its existing receipt. The runtime validates the note and receipt, retains
it in the existing mode queue, and joins its text at final provider preparation
for the next actual input, leaving primary command grammar untouched,
without adopting the note's permission or primary-input identity.
Host-local and provider-native control commands leave notes retained; native
command bytes and represented input identities exclude them. The next ordinary
provider prompt carries and settles the retained facts. The same
receipt authorizes retained-context materialization; ordinary inputs cannot
claim that status through display metadata. Provider dispatch settles the
represented note through existing Pending custody. A note-delivery failure
remains separate from a successful file mutation and must not replay that
mutation. Publication requires advertised Pending revision 5 at the existing
sender/wire negotiation owners; unsupported or unknown Homes receive no note POST.
HEAD discard uses the existing backend's pre-mutation status inventory
to omit unchanged paths; unavailable status evidence reports note failure without
blocking the discard itself. Requeued inputs retain note identities without
rendering already-represented note text again. Composed runtime and presentation
validation remain program gates.

In 0.3 development, the content-free
[request attribution projection](../packages/protocol/src/actions/actionRequestAttributionV1.ts)
also remains separate from Session/process ownership and execution credentials.
Human input derives its requester from the authenticated Session admission receipt,
not authored labels. Protected machine input can retain that original admitted
cause; its immediate sender remains the separate protected source Session.
Queue batches and private native-turn/Action custody retain a copied cause rather
than a Session-global latest requester. Accepted Workflows retain it inside their
existing accepted origin. This observational value grants neither execution nor
approval authority; missing human identity never becomes the Bot owner's identity.
Spawn first-input handoffs preserve the invoking Action's admitted cause, including
for plugin and automation callers. Subsequent protected CLI inputs retain the
authenticated Account requester for Account and paired-terminal bindings. An
API-token root does not establish a human requester; terminal attribution does
not elevate its automation authority to present-person approval authority.
Local Agent/MCP tool execution copies the cause
from the same active-turn witness as its permission and input facts; the daemon
Action channel carries that witness through its existing projection. Neither path
derives the requester from the executing Account or the child Session's ownership.
Credentialed CLI hosts stamp the separate execution Account in their shared Action
context; Session-only transport credentials do not supply Account authority.

The strict [WorkerUpdate](../packages/protocol/src/sessions/relations/workerUpdateV1.ts)
envelope carries actual engine facts when available, owner outcome, source
pointer and optional deliverables. Truncated results require a source pointer.
It is host context, never a fabricated user message. A Session worker's pending
turn-end review postpones settled delivery. Follow policy selects quiet context
or a wake from the source outcome. The receiving machine's daemon can request
Resume for an eligible inactive lead through the existing input/resume owner;
an explicit Stop holds automatic delivery, archive drops new delivery, and an
unavailable machine leaves it pending. Busy receivers take context at an input boundary
without steering. Source and permission admission remain current at that
boundary; enqueue or Resume alone does not prove native acceptance.
Work/Inbox are projections of these owners, not a second turn scheduler or
permission ledger.

In 0.3 development source, Session Follow progress ACKs use the publisher owner's
Serializable snapshot path. They validate the exact current publisher, source
access, accepted input and route frontier in that transaction, without joining
the socket's heartbeat queue. Admitted original ACKs that advance manager or
explicit Follow progress publish the destination's content-free Account change,
as rule progress already does. The existing destination/audience admission and
post-lock authority recheck precede that settlement and publication. Repeated
settled ACKs publish no new wake; legacy no-original frontier ACKs allocate no
Account change cursor. An admission
deadline or unavailable transaction returns the typed `retryable` refusal. The
existing reconciler retains the accepted request and retries its ACK at the next
preparation boundary, suppressing another delivery of that accepted context while
the refusal persists. Successful or terminally refused requests retire this local
custody. For admitted originals, the provider-outcome normalizer passes its existing
Pending acceptance promise to the correlated Follow effect. Native replay custody
retires immediately; the reconciler joins that write before ACKing. The
reconciler re-observes the exact admitted receipt for the current publisher
generation after reconnect or Resume; it keeps the accepted original's represented
prefix rather than replacing it with newer source progress. A stale generation,
unverified acceptance or transport loss retains that original's request for the
next preparation boundary, without another native send. No-original context-only
wakes retain their existing at-least-once transport recovery behavior. Typed
semantic refusals and exceptions share the server's structured ACK phase/cause
diagnostic, without input content.
This adds no timer or durable delivery history across a host restart.

In 0.3 development source, content-free Account changes reach context-only input
through the Session client's existing changes-feed recovery owner. It wakes the
consumer for changes to that destination Session or its access, including Follow
destination invalidation and workflow origin delivery. Unrelated Account writes
leave the context consumer parked when the feed identifies the changed entities.
An unavailable feed, pruned cursor, full page or disabled changes sync retains
conservative re-observation. Exact destination broadcasts, reconnects and Execution
Run worker waiters retain their existing wake paths.

Quiet originals represented in a natural input retain their own Pending identities.
The host's exact-input acceptance binding records only the originals selected by
final Follow preparation, plus required returned-answer context. One primary
input remains the native Turn and permission witness. Its actual native acceptance
settles the represented originals through the same Pending writer before the
primary's write; each Follow ACK joins its own settlement. Neither transport
completion nor an omitted original earns acceptance.

Follow intake keeps an ordered prefix per source: a partially represented or
deferred original also defers its later originals, without blocking unrelated
sources. Source notifications reuse the receiver's existing prefix-admission
traversal, so a failed admission cannot be bypassed by a later notification.
After accepted progress, the destination invalidation re-enters that same
ordered range from its acknowledged cursor. The requester Account's own receiver
changes and reconnect/gap observations re-observe all configured sources,
including manager and explicit Follow without private rules. Private-rule
discovery filters unrelated source changes; currentness and binding lifetime
still govern every recovery.
A manager's optional terminal context likewise cannot consume a selected
transcript original that still belongs to admitted-input delivery. Both Account
reads and restricted Runner projections retain the original's stable local id;
an explicitly null id still permits legacy no-original context. Account Voice
keeps its independent original-reader lifetime. These are 0.3 development
contracts, not new queues, cursors or restart-durable delivery history.

In 0.3 development source, daemon-hosted plugins reach the live Session permission
owner through the existing Account-authenticated Session RPC for
`session.permission.remote.pending.list`, `session.permission.remote.respond`
and `session.user_action.remote.answer`. The invoking host copies `pluginId`
and `contributionLocalId` from its admitted invocation into the existing
[targeted Action envelope](../packages/protocol/src/actions/actionRpcTransport.ts),
outside the semantic Action input. Home requires `sessionOwner` admission,
including for pending reads: another Account's collaborator grant is insufficient.
The generic receiving adapter requires Home's `session.write` authorization and
binds the envelope target and Action input to that exact Session.

This route trusts installed code authenticated to the same Account to supply
plugin attribution. It provides no plugin sandbox or independent cryptographic
plugin attestation and adds no credential, signing path or plugin-currentness
service. The Session's existing permission handler remains the settlement owner:
it checks the exact mediator, source revision, turn and request, preserves
first-answer and retry semantics, and records the external human as
`pluginAsserted`. Transport attribution never turns that person into an
authenticated Happier Account user. Unsupported receivers refuse the operation;
the sender does not remove the stamp or use an ordinary Account-user answer.

Channels treats an `ownerMachineUnavailable` pending read from a stopped or
unreachable Session as an empty projection. Its regular Session observations
drive later reads, without unavailable-owner parking or a separate re-admission
trigger. This projection does not move pending state or settlement into the
daemon or Channels.

The approval reviewer is a request-scoped client of the existing permission
owner. That owner rejects ineligible effects before starting a no-tools review
with a redacted request, then rechecks current request/policy before an allow-once
claim. Human notification and human answers are not held behind review. Escalation
or failure leaves the human request pending; a successful automatic answer records
the reviewer actor and creates no reusable grant or permission-mode change.

Native interaction lifetime is separate from causal turn identity. Ordinary requests default to turn lifetime and retire with the matching terminal turn (including ordinary requests without a turn witness); native Codex asynchronous questions explicitly use occurrence lifetime. Those questions keep their causal turn id after completion and retire when their Session/plugin occurrence retires. The permission coordinator owns this distinction; terminal callbacks do not cancel every request owned by the plugin.

In 0.3 development source, an authored wait-mode question ends its exact host
turn as `waiting`. The host captures that intent before native cancellation or
completion and flushes transcript output without publishing a successful or
cancelled work outcome. Follow consumes the typed waiting turn through its
existing frontier and acceptance ACK, so later state echoes cannot wake the
manager again for that same turn. The answer uses the existing correlated
information-return path and the next admitted turn clears waiting. Explicit
Stop withdraws the question and settles the exact waiting turn; incidental
process exit keeps it available for recovery. Loaded-runtime verification
remains with the coordination program's composed journey.

In 0.3 development source, host-bound occurrence questions can ask for human input
before an admitted turn exists. The host stamps that question origin; it never
converts missing causal authority into permission to execute a tool. Claude's native
terminal dialogs use the existing rich Session permission bridge so their source,
exact choices, cancellation and terminal-application acknowledgement survive.
Workspace trust still needs the configured explicit trust policy or a person's answer.

In 0.3 development source, spawn and recipe `allowedTools` seed the existing
Session permission allowlist. `unlistedTools` defaults to `ask`; `deny` refuses
unlisted tools and ordinary native tool questions without publishing an approval request.
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

An empty tool allowlist with `unlistedTools: 'deny'` suppresses injected MCP
servers through Codex's config owner. Native admission validates that same
effective server set, so an inherited MCP map does not prevent a no-tools Run
from using a Connected Account or Provider binding. Runtime-version and native
configuration checks still apply; an unexpectedly enabled server refuses startup.

The managed Codex installer pins that same qualified release. Its manifest tag,
native admission check and sanitized repair guidance share the plugin's
`agent/cli/supportedRuntime.ts` owner. Unqualified newer system/native installs
remain usable for ordinary sessions, but confined launches refuse them and name
the supported version and `machines.agents.install` reinstall Action. Executable
source preference still applies after installation; verify the selected runtime
rather than assuming a managed reinstall displaced a system override.

Whole-Session permission reset reaches the existing Session request store even when the current coordinator has no local waiters, including after handler replacement. The store cancels pending requests and delivers their response targets. Cancellation waits for in-flight coordinator completion persistence before writing the terminal result; plugin-scoped cancellation retains its owner filter and performs no write when neither local nor persisted requests match. The store returns the exact occurrences selected by its committed write, so the coordinator also rejects matching provider waiters published while an older completion was draining, without retiring a replacement occurrence.

Cancellation removes only the cached decisions it captured before persistence, so a newer decision created while an older scope stops remains available. A cancellation that starts before a queued native decision applies prevents that new application; recovery of an already-applied native choice retains its existing receipt boundary.

ACP Stop cancels the provider independently of permission-state persistence. A failed permission cancellation retains the request for retry and emits the default file-log event `permission_request_cancellation_persistence_failed` with the error type, without request content or the error payload. At the generic Session Stop entry point, `reset({ scope: 'foreground' })` withdraws foreground prompts, including saved prompts without local waiters, while preserving independently scoped execution-Run prompts and cached decisions. Selection uses the canonical Run request identity at the committed store write; the shared permission store and Session/Run allowlists remain alive. A rejected foreground reset leaves native turn cancellation reachable and records `permission_reset_failed`; a rejected native cancellation records `runtime_cancel_failed` in the default file log. Other reset callers retain the acknowledged-write contract.

Session rebinding republishes the coordinator's admitted request context, including its original creation time, source, turn and native MCP identity. An offline client without a readable snapshot keeps that identity. MCP catalog preparation has not yet admitted a permission request and stays unpublished across rebinding until preparation finishes.

The native permission-hook HTTP owner aborts its callback signal before sending its finite timeout response, and also aborts on a disconnected response. Claude's SDK and unified terminal callbacks forward that signal through the existing permission engine. The final unclaimed waiter withdraws response admission synchronously; the existing observed-retirement path then persists the exact cancellation asynchronously. The HTTP deadline does not await an arbitrary callback or journal write. A failed write retains the exact request for lifecycle retry and keeps it unavailable to late answers. The default file log records `permission_request_cancellation_persistence_failed` with the error type, without request content or the error payload.

When a native terminal dialog has already applied a selected choice, the running Session's request store retains that finalized completion if its acknowledged Agent-state write fails. Reconnection or a later Agent-state write reoffers only the same pending identity; a replacement request, newer claim, cancellation or terminal result wins. The original waiter settles after the completion is acknowledged. A repeated matching answer rejoins that completion, and a competing answer cannot apply another native choice. This recovery does not replay the application callback, ordinary automatic policy decisions, or survive process exit.

Metadata and Agent-state retries use the current managed socket on every attempt. Reconnection can therefore finish the same operation within its existing retry budget.

Terminal Agent-state update failures report `session_agent_state_update_failed` in the normal file log, including when a best-effort caller absorbs the error. This record contains operation context only; it excludes request contents and server error payloads. It does not distinguish transport from local preparation failures and does not imply a replay guarantee.

In development source, a `message-delta` can supply the same stable `messageId` as its
`transcript-message-committed` event. The host stream bridge uses that identity for live and
durable rows and separates distinct messages within a turn. When an unnamed foreground
stream receives its native committed fact, the writer finalizes that channel's existing
row under its generated localId, including an already durable checkpoint, with the
authoritative text and `happierStreamSegmentV1.sourceMessageId`. Assistant and reasoning
segments remain independent; later outputs in the turn start new segments. Cancellation
retains the interrupted checkpoint. Named streams use the same finalizer under their
native localId, including Session-scoped and sidechain output. A final snapshot replaces
the text even when empty, publishes terminal segment metadata, drains live publication
before durable admission, and retains unresolved custody for retry. Durable admission
preserves the caller's cancellation and deadline. A matching named writer takes precedence
over the unnamed foreground handoff; Session-scoped output does not acquire that unnamed handoff. Loaded native retry
recovery still requires a fresh runner after the CLI host reload.
Named message identity is shared across foreground and Session-scoped observations of
the same channel and sidechain. An authoritative final therefore uses the existing
writer's source timestamp instead of starting a second write under the same localId.
Live runtime events and terminal file-follow facts enter the same ordered Session
projector and share its active writer and acknowledged native-identity receipts.
If file-follow observes the final first, a delayed delta for that same native
message, channel and sidechain reuses the final receipt instead of reopening a
partial write. Only an explicitly foreground-scoped event can attach that receipt
to a turn.
An already foreground-owned segment retains its acknowledged final receipt until that
turn's next flush consumes it; the Session-scoped observation itself gains no turn scope.
The host's metadata reader recognizes the recorded source identity for both follow/replay
and cold reconciliation. Follow opens metadata through the existing Session-mode decoder
and retains both row and source identities in its paged baseline; plugins receive the
native identity in their existing reconciliation baseline, without a second dedupe owner.
The projector retains completed native source identities for its Session lifetime:
a repeated committed fact cannot finalize a later unnamed segment or duplicate a
Session-scoped row. Stored metadata is read through the canonical tolerant reader.
OpenCode derives its stable ID through the same
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
only foreground streams; a successful authoritative text commit retires only its matching
channel through the named identity or unnamed-segment handoff above. Native child turn identifiers stay
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

Experimental native Realtime Start is Session-owner-only in 0.3 development;
it runs on that owner's Agent account. The canonical Protocol RPC classification
requires `sessionOwner`, while shared editors retain ordinary input and question
answers. The server issues `authority: 'sessionOwner'` in the closed,
exact-Session `session.write` context only after verifying owner-classified Start.
The host requires that literal proof plus `present_user` before native Start or
input admission. Ordinary `session.write` and human authentication alone are not
owner proof; older relays without the proof fail only native Start closed.

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

Native MCP discovery and Account Actions use the admitted operation's existing
Account currentness check. Requester credentials come from protected Session
custody and are not compared with the Machine profile's `access.key`. The
bridge carries this same check into its Account, Follow and plugin Action
owners; retirement still refuses subsequent calls. Callers without captured
Account custody retain the profile credential check. This is development-source
behavior and requires a freshly loaded runner for live validation.

Retained requester Settings use the existing Account/Home user socket for both
Session and finite custody. The Settings publication owner applies envelopes to
the captured snapshot, fetches on version hints or reconnect, and withholds
Action admission while convergence is pending or unavailable. Action cancellation
ends only that reader's wait. Explicit demand rejoins this same owner and can
recover a failed hint. Unchanged policy requires no per-Action Settings,
Profile or Connected Account catalog refresh; explicit catalog demand retains
its existing owner. Custody retirement releases its subscription and private
snapshot. This development-source path still requires loaded-runtime replay.

Explicit requester Settings refresh shares one requester observation across its
Profile and Connected Account catalog readers and private snapshot commits.
It uses the existing preparation checkpoint owner, then checks fresh authority
outside that checkpoint before notifying consumers. A later refresh starts
fresh; revocation during a catalog read prevents successful publication.
Failed Settings observations preserve their transport error rather than becoming
a negative authority decision. Session startup retries these preparation reads
through the existing requester Home backoff under its original accepted startup
operation's cancellation lifetime. It retains the same operation and creation
identity; the retry does not include native launch. A caller without that
operation lifetime receives the existing typed retryable Home failure.

Within one requester credential binding, the first Machine proof discovers the
authenticated Account identity and Machine-access context. The middle read group
and the second Machine proof reuse that exact discovery only for this binding;
both Machine proofs still perform fresh signed Home verification. Discovery is
matched to the exact Home, credential, attribution and Session and ends with the
binding. Later invocations discover again.

Action preparation also uses this checkpoint for the bounded Agent-start group:
Role overrides, built-in Role sources, captured Settings and Agent inventory.
Prompt Library destination/storage-mode reads, ACP catalog reads and Profile catalog
admission join nested read-only preparation in an existing bounded observation;
ordinary and effect checkpoints still start fresh. Migration writes, retained-source/history maintenance and private
source/catalog publication leave the checkpoint before their existing effect fences.
Injected preparation/readers and Settings bootstrap also leave that read scope.
Catalog disclosure and final Agent-start context publication check fresh
requester authority; cancellation withholds the prepared start context.
Authorization preparation shares only its initial caller and Profile/encryption
reads; signed Home minting and final authorization publication retain fresh fences.

The established Connected Account owner also admits read-only status through the
same bounded snapshot scope as materialization. Nested field reads share its
Account admission; fresh entry and result-publication checks retain requester
revocation and cancellation. Credential and configuration revision checks remain
at the runtime callback boundaries. Later public operations start fresh, and
refresh, revoke and other effect operations retain their independent admission.

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

The admitted requester bootstrap also owns native Account credential eligibility.
Only verified requester and Machine-custodian identity equality permits the
Machine's native Agent login and configuration; UI, CLI and agent origin do not
change that decision. Workflow startup supplies its accepted Machine binding,
and recovery reconstructs the binding through the existing authenticated access
reader and signed Machine verifier. Foreign or missing bindings still require
an isolated requester home and cannot inherit custodian credentials. Spawn and
Connected Account refresh consume the same bootstrap decision.

Legacy Sessions without a protected requester file use the same authenticated
owner recovery whether retained attribution is present or absent. A retained
Home/Account/Machine/installation tuple must match the freshly verified owner;
attribution alone grants no custody. Existing foreign, malformed or revoked
custody remains a refusal. Resume and respawn consume this single recovery owner
before authorizing native launch.

In 0.3 development, retiring a stopped runner's terminal-control metadata uses
the daemon's authenticated Account writer when the retained Account, Home and
Machine all match. Home authorizes the write and the existing metadata tuple
writer checks Account encryption currentness. This retirement does not recreate
the departed runner's Settings, secret or Connected Account execution runtime.
Other requester identities retain their exact requester-custody recovery path.

The durable Session-deletion subscriber calls the existing daemon Stop owner
before removing managed directories, including when no managed directory was
allocated. Home inactivity does not prove a respawned runner has exited. Stop
fences pending automatic launches and retires tracked successors; an incomplete
Stop leaves the deletion change unacknowledged for the existing cursor retry.
These source paths require loaded-daemon replay before live certification.

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

Detached Project launch separately requires admitted requester custody: a
requester Session bootstrap or signed caller input authorization. A token-only
installed-CLI start supplies neither and refuses with
`project_requester_credentials_unavailable` before creating a Run. Account
defaults select the Agent configuration; they do not supply that launch authority.
Original authenticated CLI Run starts and cold Ensure/Send operations use the
existing Home Action admission even for an own local Machine. They reach the
same captured requester preparation port as app calls; raw token-only RPC stays
unprivileged.

Cold Project preparation carries admitted requester context through the existing
Run backend parameters. In 0.3 development source, nested preparation readers
share one requester authority observation within that preparation checkpoint.
Native effects, secret release, final launch, and resumption after setup review
start fresh checkpoints. Local custody retirement and observed Account encryption
changes still refuse within a checkpoint; no settled observation survives it.
The Run controller retains setup review with the shared
Action-operation review continuation; its existing Run id identifies the projected
operation. Review state is controller-lifetime state, not a second Run registry or
a persisted credential source. The Machine Action-operation runtime composes this
domain projection with its incumbent owners, and routes inspection, cancellation
and consent back to the original producer. For a Session-hosted Run, the daemon
projects the existing pending native-launch invocation under that same Run id.
Its lifecycle projection reads the Session Run controller through the existing
requester-scoped Session transport, and operation cancellation calls that
controller's Stop. Denying setup therefore settles the original Run rather than
leaving an independently running daemon projection. Terminal controller facts
cannot carry setup review, and a late Account decision cannot restart a stopped
or refused invocation.
The runner carries the Run's own cwd into snapshot-backed invocation preparation;
the accepted Account workspace rows decide Project membership for that cwd.
The parent Session's cwd cannot substitute, and missing Run cwd refuses preparation.
The Account Action `projects.prepare` with `heldOperationId` authenticates the
approving Account and resumes that retained invocation and reservation. The
runner's controller remains the Run lifecycle owner; native authorization does
not establish Run completion. Run Stop closes the invocation, aborts its review
and withdraws the projection. The Session-write RPC supplies no human setup
decision or Account identity. This development-source path requires daemon and
runner reload for loaded-runtime validation.
See [Project native environment production](cli-architecture.md#project-native-environment-production-03-development)
for the development-source launch contract and its remaining qualification limits.

The host-private Session reader combines the model-transition coordinator's
admitted applied target with the scoped daemon's existing applied Connected
Services registry. Pending intent alone neither supplies nor invalidates an
otherwise readable applied choice; an actual unresolved effect or unavailable
owner refuses inheritance. A configured next-prompt route admits its confirming
prompt but remains unavailable to this applied-selection reader until compatible
runtime evidence arrives; it does not lend pending intent to a child Run.
Pool references retain the pool, not its selected member, credential or activation. Cross-Agent Provider choices use the existing
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

Current development readers also recover the registry's former identity-encoded
sealed basenames. After checking the payload identity, the existing per-Run
writer publishes the current basename without replacing an existing current
copy, verifies that copy, then retires the former name. The same ingress handles
pending WorkerUpdates, so acceptance checkpoints and terminal delivery keep one
owner. Acceptance retires both validated names under that same per-Run writer;
an overlapping older scan cannot republish accepted delivery. Unreadable entries
remain retained and make observation incomplete; the
registry reports each unavailable entry once and reopens it when its observed
file, device key or protection state changes. This is retained development-data
recovery, not a second writer or a released format guarantee.

Existing process supervision records proven host death or PID reuse as
`execution_run_host_lost`, not transport disconnection or inconclusive process
recognition. The interrupted input
fails, the native handle determines recoverability, and the retained failure
points to the partial transcript. The same fact feeds reads, waits and the
existing acceptance-ACKed WorkerUpdate path. Neither an unpaired transcript
call nor a historical `running` result proves current liveness. Resumable control
state survives marker collection; ephemeral terminal state follows the existing
terminal visibility lifetime once pending parent delivery is settled.

Development WorkerUpdates classify Session, Execution Run and Workflow outcomes
through Protocol's `classifyWorkerUpdateEventV1`, using the shared Follow event
vocabulary. A failed or stopped source cannot become a successful completion
because its retained scheduling field says `finished`. Workflow attention is
eligible for intake while current and is withdrawn by the existing revision and
attention recheck after resolution. Authored Workflow input retains priority.

The development Execution Run and Workflow-origin inboxes ask the shared
`resolveWorkerUpdateFollowDeliveryV1` policy adapter whether an update may wake.
New Workflow Runs capture `follow.preferences`'s `runReportPolicy` in the accepted
snapshot's `resultDelivery` when origin reporting is requested. Direct and trigger
creation read that choice once; reports and resumed Runs use the frozen policy.
The origin input port applies its event selection during ordinary preparation and
its interrupt choice when taking a wake. Custom-off events supply neither input;
Quiet events remain available for the next natural turn. Historical snapshots
without a captured policy retain Important: successful results are quiet, while
failed/stopped results and current attention may wake. Delivery retains its existing
acceptance ACK; selecting a wake never consumes a different pending result.
This source implementation is not loaded-runtime certification.

The terminal error carrier reuses `SessionRuntimeIssueV1`: Run errors retain it
in `error.runtimeIssueV1`, Workflow leaf failures in `progress.reason.runtimeIssueV1`,
and receiver updates in `WorkerUpdateV1.runtimeIssueV1`. Retention, recovery and
prompt/card projections preserve source-reported usage-limit recovery details;
an absent reset time stays absent. Source Session hydration binds the issue to
the observed failed turn. This adds no error classifier or process-loss detector;
loaded-runtime validation remains a separate gate.

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

In current 0.3 development source, the execution registry names retained state,
WorkerUpdates and visibility markers with fixed-length identity digests. Exact
identities remain in their payloads, leaving native filename space for atomic
publication. WorkerUpdate conflict and acceptance checks still use sealed payload
identity; unreadable delivery custody prevents garbage collection. The Session
RPC registration owns one child-Run disposal promise, including idle retained
Runs. Physical runner retirement starts that disposal alongside foreground native
cleanup, before a suspended native disposal or Session close can strand children
from the departing generation. Session close joins the same promise before
releasing its Account snapshot and handler resources. Mode handoff and runtime
recovery keep the Session's independent child work; a planned replacement does
not adopt the retired generation's native children.
Before an admitted planned signal, the daemon's existing remainder owner captures
the exact runner process tree, including children tagged to logical Run owners.
Exit cleanup consumes those native PID/start witnesses before respawn. A live
replacement does not erase the departing generation's capture or become one of
its targets. Definitive Stop consumes this same remainder owner and reports its
physical cleanup outcome. Native cleanup therefore remains possible after the
old runner's graceful-disposal window ends; it does not depend on plugin disposal
or terminal publication finishing in that window.
Stop preserves each retiring generation's captured tree and checks every distinct
capture's result, reusing an already completed cleanup rather than repeating it.
These corrections require a fresh runner for loaded-runtime replay.

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
- The optional `startingInputId` on host `@happier/runtime/turn-start` is the accepted Queue input's exact `localId`, stamped by the host only after a real accepted native start. Plugin-supplied attribution is stripped; absence does not prove an input cause. This fact alone does not classify a turn as fixing work.
- In 0.3 development, `session.input.result.get({sessionId, localId})` reads that exact input's existing accepted-turn/start witness and canonical result. A waiting turn stays pending. Plugin callers must match their original admitted input authority and receipt; missing proof from an older server is unavailable, not completion. The read adds no queue, lifecycle or counter.
- The development Channels PR Watch consumer keeps one incumbent obligation/input pointer in its existing binding progress. An Address or Auto-fix batch charges that PR's allowance only when the exact accepted input has a host start witness, including a turn that diagnoses or asks a question. Notify and Analyse do not charge. Queued, uncertain or still-pending inputs hold later fixing delivery; completion clears the pointer, not the consumed count. Own/unknown pushes and passing checks do not clear unresolved feedback. A retained other-writer push ends its sequence once, after accounting for any outstanding input. The existing ingress retention owner preserves a referenced active input even after its first reply projects. Under approved AM-QC1, exhaustion continuation is a direct Watch Action with current binding-revision CAS and the effective finite Account allowance, not a C1 question or answer consequence. Existing retained-link polling schedules only original known-no-effect exhaustion blocks through the incumbent retry/due-work owner when current fixing policy and allowance permit; unrelated blocked causes and Stop/Off do not resume. Triage alone presents its Inbox/detail controls through the host's declarative contributed-Action path and normal viewer policy. Explicit configured-Fix attribution and a trustworthy all-feedback-resolved ending remain under integration; the input-result fact does not supply either.
- Auto-fix preparation reads the bound PR through the existing Session-targeted SCM Action and verifies its current native head against the accepted checkout after the ff-only pull. The frozen update remains historical evidence, including after an own push. Preparation checks the allowance without claiming the active input, then claims through the same binding CAS only after preparation succeeds; a known-no-start approval/preparation hold stays on the original ingress retry path. A failed claim retains no preparation proof, while uncertain sends reuse their existing proof and input identity. Retained old blocked preparation reservations are recovered only with the same explicit Auto-fix authority epoch and no preparation/accepted-input witness; changed policy and uncertain Address work are not inferred safe.
- Keep terminal/remote mode orchestration and cleanup at the host. An Agent declares its surfaces and native operations rather than choosing host policy.
- Keep UI activity and transcript views as projections of canonical facts. Retained UI data during refresh is not authority to admit new work.
- Retired public surfaces such as `RuntimeCoreV1`, `AcpSessionRuntimeV1`, `RuntimeControlContribution` and `RuntimeEventV1` must not regain consumers. [`agentRuntimeSurfaceContract.ts`](../packages/plugin-sdk/src/agentRuntimeSurfaceContract.ts) records the negative public contracts. Preserve a necessary released compatibility translator only at its seam, under [compatibility](compatibility.md#sdk-protocol-evolution).

## Related

[Plugin platform and SDK](plugin-platform.md), [Agent catalog](agents-catalog.md), [CLI architecture](cli-architecture.md), [Actions](actions.md), [encryption](encryption.md), [testing](testing.md).
