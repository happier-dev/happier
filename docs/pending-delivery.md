# Pending delivery architecture

## Explicit non-interrupting delivery (development)

**Steer now** requests immediate delivery of the exact Pending row without
interrupting the agent. The server claims it as `send` when the foreground is
ready and `steer` while a turn is active. An idle live runner accepts it through
its ordinary prompt path. If active steering is unavailable before provider
effect, the runner retains the same prompt and identity in its existing queue
for the next safe input slot. **Send now** retains its separate interrupt-and-send
behavior.

The server's existing requested action accompanies the claimed provider action
through the runner queue. This preserves the distinction from automatic
`steer_if_active`: when that conditional steer becomes unavailable before effect,
the canonical Pending owner returns it to ordinary delivery admission, including
`after_runtime_idle`. Explicit steering does not require the foreground or
background activity summary to become idle first.

Claude terminal readiness uses positive native generation evidence even when a
turn-start lifecycle signal is missing or delayed. Input safety and provider
acceptance remain owned by the existing terminal readiness and custody paths.
Once a provider effect may have occurred, steering failures do not automatically
replay the prompt through ordinary delivery.

In development source, Claude's main-chain `[Request interrupted by user]` and
`[Request interrupted by user for tool use]` transcript markers both abort the
foreground turn through the shared transcript lifecycle classifier. This releases
a waiting **Send now** prompt through the existing arbiter; the interruption
itself does not establish provider acceptance of that follow-up.

## Composer busy-steer policy (development)

`decideSessionMessageDelivery` owns the requested action for ordinary composer
sends. Both configured delivery modes, **Queue in agent** and **Pending until
ready**, honor **Steer immediately** by durably enqueuing `steer_if_active` when
the session supports steering. An explicit per-send Pending intent or the
**Server pending** busy policy keeps `enqueue`. Runtime readiness and payload
steerability still gate delivery through the existing Pending owner.

The existing-session composer's send button offers per-message choices on long
press (or right-click on web): **Steer now** when steering is supported, **Queue**,
and **Send now (interrupt)**. Selecting a choice submits the current draft through
the same submission owner, overriding the saved send preference for that message.
A normal tap keeps the saved behavior; dismissing the menu preserves the draft.
Voice, Stop, pending-message editing, participant routing, and armed Agent
continuations retain their own actions without this menu.

Composer shortcuts in development source use the platform modifier: Command on
Apple platforms and Control elsewhere. Normal submit follows the saved delivery
preference. `Mod+Enter` selects the other noninterrupting action (steer when the
default queues; queue when the default steers). `Mod+Shift+Enter` explicitly
interrupts and sends. With no composer text or attachments, these two shortcuts
instead steer or interrupt-and-send the first queued row, respectively; they do
not replay history or create a new copy. An unavailable row or empty queue is a
no-op. Pending interrupt actions retain their confirmation, and failures leave
queued custody intact.

The send menu and hover/focus tooltip show the effective shortcuts, including
custom bindings. The existing persisted `composer.sendImmediate` command id now
names alternate send; `composer.sendPending` remains rebindable with no default,
and `composer.sendInterrupt` owns the new Shift binding. No settings format or
Pending wire shape changes. Explicit steering never selects interrupt as a fallback.


## UI settlement convergence (development)

Provider acceptance carries the exact Pending `localId` to `SessionClient`, which
requests server settlement. The server transaction commits or updates the
transcript message and removes that Pending row before publishing the message
event and the separate Pending count/version event.

In development source, Claude's Agent SDK and legacy remote runtimes share
`createClaudeRemotePromptSettlementTracker`. They request the documented
[`--replay-user-messages`](https://code.claude.com/docs/en/cli-reference) acknowledgment and correlate its main-chain user UUID
with the exact submitted Pending prompt. Local enqueue, SDK iterable consumption,
and stdin writes do not settle Pending or retire its replay handoff. A submitted
prompt without acknowledgment has an uncertain delivery outcome; its handoff
remains available and Pending does not automatically resend it. Inputs rejected
before submission remain retryable. Matching acknowledgment echoes carry
provider-only context and are excluded from the visible transcript. Locally
handled commands retain their explicit local settlement.

In development source, Claude unified terminal reports exact transcript-proven acceptance before stopping
for missing required session hooks. The hook failure still stops the wrapper and
surfaces a runtime issue; it does not make an already accepted prompt undelivered
or eligible for replay. The arbiter owns this ordering even when the transcript
evidence arrives while the terminal injection is still completing.

An in-flight Claude unified-terminal steer stays pending while Claude holds it in
its native queue. `UserPromptSubmit` can fire at enqueue and does not prove that
Claude has consumed the steer. The arbiter accepts a steer from its exact
transcript consumption evidence; the existing queued-command matcher correlates
the native enqueue/remove episode with its main-chain `queued_command` attachment.
The session scanner observes that evidence after awaiting earlier visible-message
commits, including known resumes and rows appended while the replay baseline loads.
There is no separate acceptance-only follower of the resume transcript.
Hookless discovery identifies the main transcript without settling Pending; its
newly created transcript enters that same ordered live importer from the first row.
The queued indicator and exact-row interrupt action remain owned by terminal
custody until that acceptance. Prompts injected to start a new turn may still use
their exact submission hook as acceptance evidence.

In development source, identical unresolved Claude terminal attempts remain
ambiguous: transcript text and a new provider UUID cannot identify a Pending
row. Already ambiguous evidence and delayed echoes of hook-confirmed prompts
cannot settle a later attempt. Exact canonical retirement removes the retired
attempt's correlation without reporting provider acceptance; new unique evidence
can then settle a remaining attempt.

The UI's canonical pending snapshot owns exact server-row reconciliation.
Receiving a committed user message whose `localId` matches a displayed
`server_pending` row requests that snapshot, even when the transcript reducer
already contains the identical message. Transcript equality does not establish
Pending freshness. The committed twin alone cannot authorize row removal: a
snapshot may legitimately retain it. Local-outbox reconciliation and repeated
message side effects keep their existing owners; this recovery adds no polling.

The pending snapshot owner coalesces the complete read and reconciliation while
the session's Pending version, transcript, decryption context, and captured
transport lifetime remain unchanged. A newer receipt, transcript update, or local
Pending edit starts a fresh server read, bypassing
generic HTTP in-flight sharing. Publication rejects reads captured before the
current Pending version, including first-open sessions with no loaded transcript
sequence. Socket receipts publish their version before awaiting transcript
materialization; row retirement still waits for that materialization. Existing
acceptance and committed-sequence fences continue to protect in-flight sends and
legitimate durable Pending/transcript coexistence.

In development source, acceptance fences bind to the refresh outstanding when
HTTP success arrives. Waiting for response-body identity validation cannot attach
that earlier acceptance to a newer read that already proves row removal. The
shared requested-action entry point reconciles the exact session on row
`not-found` and `action-conflict`, then preserves the original action error. This
covers Send now, steering, and resume actions without UI-owned row removal.

To distinguish settlement from display failures, inspect the canonical Pending
read for the exact session and `localId`. A retained server row points to
acceptance or settlement; an absent server row with a stale mounted Pending row
points to client convergence. Host contention can delay either path and is not
itself evidence of a projection defect.

Accepted settlement retries transient server `internal` errors, transaction
unavailability, and lost socket acknowledgements through the same exact-`localId`
operation while its session/runtime authority remains current. This retries only
the idempotent server settlement, never provider input. Existing server-directed
delays and the acknowledgement-loss retry cadence govern retry waits; reconnect,
runtime replacement, and close retain their existing cancellation fences.

The session runner records each scheduled retry in its file log. When an accepted
row remains unresolved after a non-retryable outcome, it records a file-only info
diagnostic with the session and `localId`. This includes server no-ops or
not-found responses without exact committed proof, and unexpected resolution
crashes. The diagnostic is present at the default session file log level and
does not write to the provider's interactive terminal.

## Live runner wake-up recovery (development)

Pending counts and versions come from the server's projection. A materialization
acknowledgement without that projection, including the released-server adapter,
retains the last server state. It does not decrement counts or increment versions:
the same claim's post-commit hint may already have arrived during transcript lookup.
Older snapshots and hints remain unable to replace newer pending state.

The session client owns pending-input wake subscriptions. A transient socket
disconnect does not end those subscriptions: idle and active-turn consumers must
still observe later eligibility updates. Caller cancellation and client close
release the client's listeners. The runtime separately aborts its consumer when
the turn or session ends.

Idle and active consumers share the same wake handling. The existing backoff for
unavailable adapters does not periodically materialize the queue. Reconnect does
not bypass settings convergence, admission, or the Pending row's blocked state;
an explicitly blocked message still requires its existing Retry action.

If the session socket stays connected after a transient server-feature probe
failure, a later pending materialization attempt reuses the session client's
connection-readiness convergence. It re-probes that same connection and, for
the current Runtime Activity contract, waits for the publisher's snapshot
settlement before claiming input.
Authentication failures and unsupported contracts still fail closed; this
recovery adds no polling or reconnect side effects.

In current development source, an admitted prompt does not wait for the daemon's
`prompt_or_steer` lifecycle response. That notification informs recovery and
switching; it is not input authorization. A delayed or failed notification does
not block the Pending row. Exact turn-marker and terminal notifications retain
their existing serialized lifecycle handling.

## Claude startup activity (development)

The Claude remote launcher publishes its prelaunch activity through the existing
provider activity adapter before waiting for Pending input on each SDK or legacy
provider launch. Those runners start their provider process only after input arrives.
Waiting for their stream observer to publish activity would deadlock delivery
configured as `after_runtime_idle`.

A confirmed exit of an owned Claude process retires its tracked provider tasks
through the shared activity ledger and publishes idle immediately. Local, legacy
remote, Agent SDK, and unified-terminal runners use that same owner. The retired
tasks are recorded at the default `info` file-log level. Closing an SDK stream or
transport alone does not prove process exit: its owned child must actually exit,
and the remote query finishes that cleanup before a replacement query can reuse
the ledger. Native launchers report the native child's actual exit over their
private IPC channel; the owner drains that channel before deciding whether the
provider stopped. A launcher exit code or signal alone cannot establish that fact.
The standalone binary payload includes the shared native-exit sidecar. Claude's
launch-mode classifier follows symlinks to the same real path that the launcher
imports. The launcher also reports when it imports the provider into its own
process; its actual exit then proves provider exit, including extensionless links
to JavaScript. Filesystem classification alone never retires provider tasks.
Agent SDK process capture qualifies direct provider/runtime invocations separately
from Windows shell shims. A shim's exit alone retains unknown task inventory;
successful owned tree cleanup can establish stop when it observed the live root.
Local Windows shell exits use the same uncertainty rule. An abort or operation
error from a running child does not settle its physical-exit waiter; cleanup and
task retirement still wait for actual exit.
Unverified owned cleanup or an unexpected native launcher exit whose provider
termination cannot be confirmed ends the runner instead of retrying into the same
ledger; unresolved task identities remain unknown. Native children may keep stream
pipes open after launcher death, so unverified exit reporting does not wait for
those pipes to close.

Positive provider-stop evidence remains authoritative through delayed observation
loss and task records. The existing prelaunch boundary opens observation for the
next provider attempt; installing an observer alone does not undo a stop. After
that boundary, hooks without launch provenance can still make observation unknown.

An external terminal host's pane death or clean exit status does not supply the
private native-exit proof. Its lost observation retains task identities as unknown;
an expected prompt-input exit remains a normal session end, while unexpected host
death takes the fatal runtime path.

Losing only observation, such as the transcript feed, retains task identities and
demotes their activity to unknown. Fresh native evidence can confirm a task again;
a confirmed process exit settles the retained inventory. Prelaunch publication
does not install the new stream observer. Each owned local process attempt uses
this publication before activating its installed scanner, including retries after
process failure. Unified-terminal attachment retains its observation startup
because the attached provider may already be working.

Local fast-start retains a deferred session client across the switch to remote.
That wrapper must forward provider input outcomes and delivery-state reads to the
attached `SessionClient`, which owns acceptance and settlement. Buffering or
submitting a provider prompt alone does not settle its Pending row.
The same forwarding preserves the all-blocked queue signal used by Claude's
ready notification, so blocked messages do not suppress completion indefinitely.

Claude remote capability reports register the runner with the daemon using the
Happier session ID. The Claude session ID identifies the provider transcript and
must not replace the daemon's Happier session identity. Otherwise a subsequent
wake can miss the live runner and attach a second one; replacing the publisher
turns unresolved delivery claims into `delivery_outcome_uncertain`.

## Current Queue V2 activation ownership

Pending Queue V2 remains the sole durable owner of message custody, ordering, and exact-row actions. An inactive-session start request is a small session-level authorization for one exact eligible queued row; it is not another message-delivery state machine and does not change that row's delivery priority.

- The server transaction that mutates Pending rows is the only writer of the current activation authorization. Pending Input V2 accepts `resumeWhenAvailable` as a mutation command, applies it atomically to the existing Session authorization, and never persists it as a second row-level desired state.
- `Session.lastActiveAt` is the lifecycle fence. An authorization at or before that value is stale and is not projected. Publisher activity therefore invalidates an old start request without a second client-owned timestamp.
- The Pending activation hint is lossy notification only. The authorization persisted on `Session` is authoritative.
- The daemon on the session's exact owning machine is the only unattended starter. It consumes live hints and one finite reconnect scan through the same activator, re-reads the session and exact Pending row, and then uses the existing inactive-session resume path.
- Machine unreachability leaves the request in `waiting`. A genuine terminal inability to start records `failed`; it is not retried merely because a daemon reconnects. When the machine is reachable, explicit **Retry** uses the canonical manual resume action. While it is offline, **Process when online** re-arms the same exact Session authorization without changing the row's delivery action.
- Current clients delegate unattended starts only when the server advertises Pending Input V2 and the exact target machine advertises daemon activation support. Otherwise they retain the released direct-resume compatibility path.
- The account preference has one three-state owner. All ordinary inactive/offline input persists as FIFO `enqueue`. `when_available` additionally arms the exact Session authorization; `online_only` makes at most one user-present UI resume attempt when the exact machine is currently reachable; `manual` only persists the row. The default is `online_only`.
- Neither `when_available` nor `online_only` changes an ordinary row to `send_now`; that action remains reserved for an explicit immediate-delivery request. If reachability changes or an `online_only` attempt fails, Pending custody remains without authorization for a later unattended start.
- The banner action **Process when online** re-arms the exact Session authorization. **Retry** uses the existing manual resume action when the machine is reachable. **Keep queued** clears the authorization and preserves FIFO delivery. These actions do not change the account preference or create a second activation path.

This design intentionally has no polling loop, lease, generation, retry counter, or client-side activation clock. Pending owns the payload; the server owns activation intent; session activity fences staleness; and the daemon owns process start.

> **Superseded attempt-design record (2026-07-14).** Queue V2 is the only active pending-delivery system. `attempt_v1` will not be activated: its runtime/protocol branches are removed after the live exact-selector contract is extracted, and its schema/migrations are squashed or forward-contracted from bounded persistence evidence. Current authority and markers: `.project/plans/pending-delivery-attempt-v1-and-session-lifecycle-reliability-unification.md`. Everything below this notice is historical design evidence, not implementation or cutover instruction.

## Historical attempt design

Pending Queue V2 remains the released durable payload and ordering owner. The following describes the abandoned admission-off attempt proposal.

## Canonical ownership

- `SessionPendingMessage` owns the exact encrypted/plain envelope, stable `localId`, role, position, and retained row disposition.
- Enqueue selects `tag_queue_v2` or `attempt_v1` once. A retry reuses the persisted selection and cannot change it.
- `packages/protocol/src/sessionMessages/pendingDeliveryAttemptV1.ts` owns only bounded attempt identity, claim selectors, the pure transition table, exact-coordinate release, and derived presentation.
- `pendingDeliveryAttemptAdmission.ts` owns the single fail-closed server admission decision. Feature advertisement, enqueue selection, and the dormant claim registrar all consume that same decision; it remains hard-disabled until the cutover gates pass.
- `pendingDeliveryAttemptEnqueueSelection.ts` translates that admission decision into the immutable protocol selected by the enqueue transaction. It is not a second gate.
- `pendingDeliveryAttemptAuthorization.ts` maps bounded human actions to the existing session access levels. Runtime claim authority remains a separate R0 concern.
- D1 will own the sole durable aggregate transaction service. Routes, sockets, workers, runtimes, providers, and UI must not write attempt or row lifecycle state directly.
- Runtime Activity remains externally owned. Pending will later consume only its typed decision and exact revision; it does not infer, time out, or write Activity truth.

## Admission boundary

There is one server-owned admission decision. It drives the advertised `sharing.pendingDeliveryAttempts` bit, immutable protocol selection at enqueue, and registration of the dormant claim transport. The decision is currently hard false; missing, malformed, or non-true advertised values therefore select the released queue contract.

The decision only makes the attempt corridor reachable; it does not authorize an individual claim. Claim authorization belongs to the D1/R0 aggregate transaction and must prove the persisted attempt contract, session active-attempt coordinate, current authenticated runtime authority, exact attempt identity, expected revision, and scoped unlogged idempotency key.

Disabling the gate must never prevent exact completion, cancellation, ambiguity resolution, or recovery of already persisted attempt work.

## Attempt kernel

One public attempt id identifies an attempt but grants no authority. The pure kernel recognizes:

`reserved → write_authorized → custody_observed → accepted`

Only exact attempt identity and expected revision can advance a state. Custody is nonterminal and never acceptance. Weaker synchronous provider submission terminates as `handoff_acknowledged`, which remains observably distinct from `accepted`.

Pre-write terminal outcomes are `retryable`, `blocked`, `cancelled`, and `dead_letter`. Post-authorization uncertainty terminates as `ambiguous`; it is never automatically retried. Owner resolution is explicit.

The session active-attempt coordinate is released only when it still equals the exact terminal attempt id. A stale terminal completion cannot clear a successor.

Head and owner-authorized exact-target dispatch share one selector contract. Exact-target dispatch identifies the stable `localId` and the deliberate `send_now | steer` override; it cannot request reorder or substitute another row.

## Derived presentation

Coarse presentation is a pure derivation from retained row disposition plus the current/latest attempt facts. No writable queued/delivering/custody/accepted twin is permitted.

- no attempt projects queued;
- reserved/write-authorized project delivering;
- custody-observed projects custody;
- terminal outcomes retain their exact names, including `handoff_acknowledged` and `ambiguous`.

The public shape may contain bounded row/attempt correlation, phase, outcome, reason, and revision. It must never contain the scoped idempotency key, provider secrets, raw evidence, content, or private runtime authority.

## Human actions

Viewers may inspect derived state. Editors may enqueue, edit/reorder/discard/restore safe pending rows, cancel before write, and request ordinary dispatch/steer/interrupt actions. Provider cancellation, hide/mark-handled, ambiguity resolution, and duplicate-risk resend are owner-only and remain distinct operations.

Human ownership never substitutes for authenticated current-runtime authority, the scoped claim idempotency key, expected-revision CAS, or exact provider evidence. UI removal is not provider cancellation and cannot delete replay fences.

## Physical compatibility fence

D1 persists attempt-retained rows with `status='attempt_queued'`. The released June materializer selects only `status='queued'`, so it cannot select those rows. Public projection maps `attempt_queued` to queued without creating a writable lifecycle shadow.

The fence, aggregate kernel, and admission-off schema exist in Remote and Dev. They remain unreachable from production enqueue because the single admission decision is hard false; cutover remains blocked until a real provider claim/evidence/mutation consumer is proven.

## Deferred work

Exact provider evidence history is deferred. A future evidence phase may add bounded, crash-safe attempt-bound receipts after provider capabilities and retention requirements are proven. D0 defines no receipt-scope registry, receipt key history, evidence capability catalog, provider declaration, or provider-specific branch.

Provider cancellation transport, consumed provider evidence adapters, owner resolution UI, cutover migration, and live ship proof remain downstream corridors. A separate runner incarnation or cryptographic claim-verifier layer must not be added unless a discriminating executable failure proves the existing authenticated channel, revision CAS, and scoped idempotency key insufficient.

## Deletion gate

Before production cutover, searches must show no active alternate owner for:

- numeric protocol floors or floor-to-contract mapping;
- per-session protocol promotion or cohort admission;
- a separate claim feature gate;
- receipt-scope/evidence-history capability scaffolding;
- provider/catalog pending-attempt capability constructors;
- direct durable transition writers outside the future aggregate;
- mutable coarse attempt presentation state;
- automatic retry after possible provider write;
- provider or Runtime Activity branching in the shared kernel.
