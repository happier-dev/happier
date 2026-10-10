# Pending delivery architecture

## Quota reset starts (development)

Reset start changes the requested action of one already admitted main-conversation
Pending row to `reset_start`; it does not enqueue another input. The binding names
the qualified B source, record, meter, and exact accepted history witness. Protected
reset dates and window details stay in the Account-mode B envelope, not in Pending
metadata. The server's canonical provider selector withholds this action before
claiming delivery, independently of the connected runner's version.

The existing admitted Machine recovery scheduler opens the exact witness and current
B observation. Its shared readiness evaluator requires current authority, a fresh
usable observation, and the witnessed actual window transition. Unknown, stale,
changed, or unavailable facts leave the same input held with an explicit reason.
Existing Pending updates, reconnect, and settled quota-loop ticks wake this owner;
the hold has no arbitrary expiry or separate durable queue.

Release uses the installed Machine socket and the ordinary requested-action CAS.
The server rechecks the retained admission target, current installation and reset
operation support before replacing the exact witnessed hold with ordinary enqueue
and authorizing existing activation. User cancellation uses semantic withdrawal;
once delivery custody is consumed it reports the existing delivered/unknown outcome,
not successful cancellation. Unsupported Machines cannot admit the reset action.
The incumbent Home Pending Input revision 4 identifies support for this arm and
its release/read transports. The daemon publishes reset operation support only
when that cached Home revision is available and its actual reset owner is mounted;
older or unavailable Homes retain their existing capability projection.

Quota reads obtain source-filtered waiting metadata from the existing Pending read
owner, under canonical Session access. Its `authorityCurrent` fact comes from the
same admission checks used by set/release. Clients open B to project readiness; the
server does not decrypt quota facts. Predecessor UI readers treat an unknown non-null
requested action as an unsupported blocked row rather than defaulting it to enqueue.
Current delegation is not a promise that a daemon is online or that its private
requester custody is readable. Foreign hosted Sessions use the already admitted
requester runtime context and currentness checks; missing or retired contexts cannot
borrow the custodian's B credentials. Only the captured Machine recovery owner can
release after its actual B opens succeed. Ordinary shared Session input remains
supported, but shared edit permission alone cannot author an owner-Account reset.

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

## UI settlement convergence (development)

Pending provider acceptance carries the exact `localId` through `SessionClient`
to server settlement. The server transaction
commits or updates the transcript message and removes that Pending row.
Transcript and Pending state are then published through separate events.

The acceptance operation optionally retains the host-witnessed acceptance time,
actual delivery kind (`newTurn`, `followUp`, or `steer`), and turn identity in that
same user Message's `deliveryResolution`, using the explicit private Session-mode
envelope described in [encryption](encryption.md#private-accepted-delivery-and-human-completion-facts-03-development).
The canonical writer rejects mode mismatches before mutation, and replay preserves
the first retained facts. Missing historical detail remains unknown; requested
steering intent and server settlement time are not acceptance evidence. This adds
no transcript row, accounting event, or second lifecycle owner.

The UI applies transcript-authority filtering before matching committed user
`localId`s against displayed `server_pending` rows. Each matching queue requests
its canonical Pending snapshot even when the transcript reducer already holds
the identical message: transcript equality does not establish Pending freshness.
The existing Pending `recipient` selects either the main snapshot or the exact
execution-run snapshot. One message batch refreshes each matched target once.
Each snapshot reconciles only its own recipient and preserves sibling targets.

The committed twin alone does not authorize removal: a current server snapshot
may legitimately retain the row. Canonical snapshot reconciliation, local-outbox
custody, and repeated-message side effects keep their existing owners. This
recovery adds no polling or retry policy.

The pending snapshot owner coalesces the complete read and reconciliation for one
Home and recipient while the session's Pending version, transcript, decryption
context, and captured transport lifetime remain unchanged. A newer receipt,
transcript update, or local Pending edit starts a fresh server read, bypassing
generic HTTP in-flight sharing. Publication rejects reads captured before the
current Pending version, including first-open sessions with no loaded transcript
sequence. Socket receipts publish their version before awaiting transcript
materialization; row retirement still waits for that materialization. Existing
acceptance and committed-sequence fences continue to protect in-flight sends and
legitimate durable Pending/transcript coexistence.

To distinguish settlement from display failures, inspect the canonical Pending
read for the exact Session, target, and `localId`. A retained server row points
to acceptance or settlement; an absent server row with a stale mounted Pending
row points to client convergence. Host contention can delay either path and is
not itself evidence of a projection defect.

When an accepted row remains unresolved after its bounded settlement attempt,
the session runner records a file-only info diagnostic with the Session and
exact `localId`. This includes terminal transport failures, server no-ops
without exact committed proof, and unexpected resolution crashes. The
diagnostic is present at the default session file log level and does not write
to the Agent's interactive terminal.

## Composer custody (development)

`submitSessionUserMessage` checks confirmed Pending cancellation before reporting
outbound handoff. Cancelled input keeps its Composer and review drafts. The
public Sync submission entry point carries the caller's captured Account
lifetime; retirement fences draft clearing and further effects, while an
acknowledged or locally retained Pending input still reports
`persistence: 'pending'` with its exact `localId`.

Initial Queue submissions with raw Composer attachments use the same daemon
prepare admission as Pending edits before creating local outbox custody. An
unreachable prepare leaves the draft with its caller. Both writers use the same
canonical prepared-record builder, including SessionMedia metadata and staged
handles. Successful enqueue acknowledges that exact accepted fact to the daemon
after the server ACK; failure before local custody or a confirmed cancellation
uses the existing abandonment operation when cleanup is needed. Settlement and
cleanup remain fenced by the captured Pending owner, including callers without an
explicit Account lifetime. These are current-process admission effects, not a
new durable attachment-settlement queue.

Upload attachment drafts remain in their shared in-memory owner until explicit
clearing; opening additional Session or new-session scopes does not evict unsent
drafts. Prompt recall reads authored `displayText` through Session-core and
preserves its whitespace. An absent display value retains the expanded-text
fallback; an explicitly empty display value does not.

## Claude acceptance evidence (development)

Claude Unified's input arbiter requires a unique matching input before native
prompt evidence can settle Pending custody. Hook `prompt_id` and ordinary JSONL
`promptId` share one acceptance identity, normalized by Claude's lifecycle event
adapter. A transcript UUID supplies identity when no prompt ID exists; native
queued-command consumption uses its own transcript UUID. Turn IDs remain
lifecycle metadata because one turn can contain several inputs.

`UserPromptSubmit` can run when Claude enqueues an in-flight steer. It does not
prove that Claude has consumed that steer, including while injection is still
pending or after native terminal custody is established. Idle/new-turn prompt
acceptance keeps its existing hook behavior. In-flight acceptance instead uses
the exact native enqueue/remove/queued-command evidence, or the ordinary native
user row that consumes an interrupted queued prompt.

Claude binds the host's ordered External Session source importer before treating
its transcript as live acceptance evidence. That importer waits for the canonical durable outbox to receive delivery
acknowledgments for preceding visible rows before forwarding native observations to
Claude's existing matcher and input arbiter. A native `user` row carrying a tool
result remains visible output and therefore participates in that ordering. The
independent raw file follower supplies activity and usage evidence. Native
lifecycle observations, including compact and turn-ending boundaries, use the
same ordered importer so they cannot release Pending custody ahead of output. Fresh session discovery imports from the source's
beginning; authenticated resume replays history without accepting Pending inputs.
The committed transcript baseline loads before source follow admission. Known
resumes hold prompt injection until their authenticated identity and ordered source
binding are ready; fresh sessions replay forward from the source beginning.

The arbiter closes an evidence identity when it accepts an input or finds multiple
matching inputs. Replaying that proof cannot accept a newer same-text input,
even after an older candidate is retired. Closed evidence remains until runtime
disposal because durable ambiguous attempts have no time-based expiry. Evidence
seen before any matching input is registered remains replayable. Native events
without an evidence identity retain their existing unique-text matching behavior.

## Live runner wake-up recovery (development)

The session client owns pending-input wake subscriptions. A transient socket
disconnect does not end those subscriptions: idle and active-turn consumers must
still observe later eligibility updates. Caller cancellation and client close
release the client's listeners. The runtime separately aborts its consumer when
the turn or session ends.

Ordinary Pending updates and explicit queue reconciliation also refresh every
locally claimed main-conversation input, including blocked and archived uncertain
claims. The API client retires exact absent or definitively discarded custody;
a still-present archived uncertain row remains eligible for delayed acceptance.
An acceptance write already in flight retains its custody until that write ends.
The native host passes retirement through its existing active-input binding,
removes the exact unaccepted correlation, and releases an unstarted turn wait.
Claude clears the corresponding terminal queue entry and delivery record without
publishing acceptance or cancelling active provider work. Runtime disposal
unsubscribes the retirement listener.

Idle and active consumers share the same wake handling. The existing backoff for
unavailable adapters does not periodically materialize the queue. Reconnect does
not bypass settings convergence, admission, or the Pending row's blocked state;
an explicitly blocked message still requires its existing Retry action.

## Current Queue V2 activation ownership

This section describes development behavior that is not yet a released contract. Pending Queue V2 remains the sole durable owner of message custody, ordering, and exact-row actions. An inactive-session activation request is a small session-level authorization for one exact eligible queued row; it is not another message-delivery state machine and does not change that row's delivery priority.

- The resumable inactive composer remains usable while its exact target machine or daemon is offline. Sending persists the message in Pending, while the session continues to present its offline status.
- The account preference **Automatic resume after sending** (`sessionInactiveResumePolicy`) has one three-state owner. All ordinary inactive/offline input persists as FIFO `enqueue`. `when_available` additionally arms the exact Session authorization; `online_only` makes at most one user-present UI resume attempt when the exact machine is currently reachable; `manual` only persists the row. The default is `online_only`.
- Neither `when_available` nor `online_only` changes an ordinary row to `send_now`; that action remains reserved for an explicit immediate-delivery request. If reachability changes or an `online_only` attempt fails, Pending custody remains without authorization for a later unattended start.
- The banner action **Process when online** re-arms the exact Session authorization. **Retry** uses the existing manual resume action when the machine is reachable. **Keep queued** clears that authorization while preserving FIFO delivery. These actions do not change the account preference or create a second activation path.
- The server transaction that mutates Pending rows is the only writer of the current activation authorization. The current main-conversation Pending wire accepts `resumeWhenAvailable` as a mutation command, applies it atomically to the existing Session authorization, and never persists it as a second row-level desired state. Execution-run-targeted input cannot author this Session activation command.
- `Session.lastActiveAt` is the lifecycle fence. An authorization at or before that value is stale and is not projected, so newer session activity invalidates an old start request without a second client-owned clock.
- The Pending activation hint is lossy notification only. The durable server-owned session authorization is authoritative, and the daemon consults it both after a live hint and during one finite reconnect scan.
- The daemon on the session's exact owning machine is the sole unattended starter for modern activation. It re-reads the session and exact Pending row, applies the existing external-session safeguards, and then uses the existing inactive-session resume path. This mechanism does not take over an external or Direct session.
- Machine or daemon unreachability leaves the authorization waiting. A genuine terminal start failure is recorded as failed and is not retried merely because a daemon reconnects. When the machine is reachable, explicit **Retry** uses the canonical manual resume action; while it is offline, **Process when online** re-arms the exact authorization. There is no periodic polling, unbounded retry loop, or exactly-once delivery guarantee.
- Becoming active, resolving the exact Pending row, or choosing **Keep queued** clears that exact authorization. **Auto-resume options** leads to the account preference for future sends.
- Modern delegation requires server Pending Input V2 support and activation capability from the session's exact target machine. Older or mixed components retain the existing direct-wake fallback rather than treating unattended daemon activation as available.

The durable banner derives the user-facing state from this ownership: waiting while the machine is offline, waiting while the daemon is reachable, queued without activation, or terminal start failure. Pending owns the payload; the server owns activation authorization; session activity fences staleness; and the daemon owns unattended process start.

## Execution-run targets

The current development implementation uses one Pending store with the **Pending Input V3** target contract. A null `targetExecutionRunId` identifies the main conversation; a non-null value selects one exact execution run. Session Pending counters, main-queue reads, and inactive-session activation consider only null-target rows. Target reads, mutations, recovery, and materialization use the exact run resource and report that run's own queue counts.

`SessionPendingMessage` stays the only durable Session input queue. Ordinary and targeted input share one admission owner, one encryption path, one `(sessionId, localId)` identity, one equality-evidence contract, one materialization owner, and one retry contract; the destination is a column on that shared row rather than a second queue, outbox, per-route sequence, or run mirror. Main, run A, and run B therefore progress independently — an inactive destination cannot block another — while Session-wide operations stay Session-wide: publisher loss blocks all affected delivering rows, deletion and erasure cover every row, and queue-position allocation keeps its Session-wide sequence.

When Pending settlement commits a transcript row, that same transaction copies
the exact nullable Run target into server-private `SessionMessage` metadata. The
binding is not caller-authored and is not a client routing projection; it exists
only so terminal `(sessionId, localId)` retries can prove main-versus-targeted and
Run-A-versus-Run-B equality after the Pending row has been removed. A matching
Plain or E2EE retry rejoins the committed result, while a different or
unverifiable target fails with the ordinary idempotency-conflict result. This is
one continuation of Pending identity, not a transcript queue or routing owner.

The one operational routing fact is the strict `recipient` accepted by Session input admission: omitting it means the main conversation, and `{ kind: 'execution_run', runId }` selects one exact run. It is label-free — run titles, Agent names, and historical participant labels are display projections and never enter routing, equality, authorization, or pending acknowledgements. Transcript recipient and sidechain metadata are derived from the admitted durable target, so callers never author two routing facts.

New targeted input is admitted only after the daemon's cached server contract reports Pending Input V3; it does not fetch a second feature snapshot merely to decide one send. An unavailable snapshot is not evidence that a target is unsupported: it withholds the capability claim rather than publishing a false negative. Pending Input V3 writes and target claims additionally require the exact target Machine to advertise the current target-admission capability (`sessionInputAdmission` revision 2). That advertisement is a truthful statement that the claim, settlement, blocking, reconnect, and recovery consumers are installed; schema support alone is not enough. Mixed or incomplete components fail before a row is created or claimed and preserve the released main-conversation send path. The server remains authoritative: an old or incomplete component receives the operation-scoped `session_input_target_update_required` result without creating a row. A current accepted resolution binds the exact execution run and expected sidechain, fences the current publisher, and commits through the existing Pending transcript owner. Retries must agree with the committed sidechain and request identity. An unavailable target is blocked or rejected on that exact target path; it never redirects input into the main conversation or another run.

### Target classification is the daemon's Run registry

The server stores a structurally valid target without knowing whether that `runId` is current for the Session, so an admitted target row starts unclassified. The daemon Execution Run registry is the only classification authority, and it acts before claim, Provider effect, or transcript settlement.

Classification is driven by the parent Session's existing durable pending-version wake, not by a poller. `ApiSessionClient` observes each canonical pending update, notifies the exact affected run binding, and `ExecutionRunHostBridge.reconcilePendingExecutionRunTarget(runId)` fetches only the queued rows implicated by that wake. The three outcomes are:

- **Unknown stays queued.** No registry entry, a still-loading run, an already-in-progress or superseded resume, resource pressure, transport failure, or another indeterminate resume failure leaves the rows queued and user-discardable. Absence of evidence is never treated as proof of unavailability.
- **Resumable-but-unloaded stays queued.** A retained running run for this Session with no live controller is restored through the canonical `ensure({ resume: true })` owner while its rows remain queued and visible.
- **Positively unavailable is blocked.** Proof that the target belongs to another Session, is terminal, is not a retained interactive run (`runClass: 'long_lived'`, `retentionPolicy: 'resumable'`, `ioMode: 'streaming'`), has a cancelled or non-interactive controller, lacks its matching resume handle, or that the canonical ensure/resume owner returns its typed `permanent` classification for unsupported resume moves each queued row into the existing Pending `blocked` lifecycle with reason `session_input_target_unavailable`. The broad transport code `execution_run_not_allowed` is not itself terminal proof.

Blocking is a lifecycle transition on the existing row, not an effect: it performs no claim, no Provider call, and no transcript write, and the row keeps its ordinary Retry and discard actions. No outcome permits delivery to the parent Session or another run, and no preinsert daemon RPC, server-side run table, or client preflight is an authority for any of them.

Reconnect and restart recovery reuse exactly this path: the same registry and the same Pending row, reached through the ordinary wake, with no recovery queue or polling worker. A target row that exists before its run controller does is classified when the wake arrives.

### Waiting for an exact targeted turn

`wait: true` on a targeted send extends the existing Session wait coordinator above Pending. It binds the admitted `(sessionId, runId, localId)` to the retained runtime's exact sidechain, turn, and occurrence evidence. Parent-Session idle, a sibling run's completion, and a generic or terminal run status never complete it, and it does not call `execution.run.wait`. A timeout stops only the observation — it does not cancel, discard, or replay the admitted input.

`SessionInputAdmissionResultV1` reports the outcome as `accepted`, `alreadyAccepted`, `rejected` with a `SESSION_INPUT_ADMISSION_REJECTION_CODES_V1` code, or `outcomeUnknown`. `outcomeUnknown` retains its `localId` together with a bounded admission code so the caller can reconcile the exact input through the ordinary retry identity; nothing collapses it into a codeless failure, and no wait table, receipt ledger, or per-run completion counter is added.

Recovery after activation uses ordinary Pending state. A failed or uncertain target delivery is observed and retried through the same queued/blocked lifecycle and `localId` identity as main-conversation input; there is no rollback ledger, dual writer, or compatibility mirror for target rows.

The authenticated author and admission receipt survive target preparation and acceptance. Machine-authored input retains its null Account author, including when explicitly sent as new. Editing content or changing the requested action clears prior equality evidence so a later admission cannot reuse evidence for a different request.

These are development contracts. Target support must be negotiated independently of the existing Queue V2 support; older main-conversation clients continue using the null-target path.

## Human authorship in development

The authenticated input-admission receipt records who submitted an accepted human input. Pending admission derives it from the final transaction-scoped Session access decision. Direct authenticated input uses the same admission builder; runtime observations and transcript-only Voice writes do not become human-authored merely because their message role is `user`.

`SessionPendingMessage.authorAccountId` and `SessionMessage.authorAccountId` are nullable relational projections of that receipt. The committed projection supports historical-contribution filtering before Session pagination. It does not grant access, assign responsibility, create a participant roster, or enroll anyone for notifications. Pending materialization and provider-anchor rejoin retain the original receipt and refuse a conflicting non-null author projection. Deleting an Account clears its foreign-key projection while preserving the immutable receipt.

Authenticated page, Pending, and realtime projections use the same Account display-profile leaf. A historical author need not retain current access for another authorized reader to see the byline. A deleted Account has a null profile; missing or invalid admission evidence has no Account attribution. Public/external transcript projections keep their separate coarse actor contract and do not disclose this Account identity or profile. The additive wire field distinguishes an omitted `accountActor` from an explicit null: an older producer's omission preserves previously known metadata, while a current null retracts it.

After deploying the current writers and the nullable-column migration, run the provider-neutral backfill against the explicitly selected database from `apps/server`:

```sh
HAPPIER_DB_PROVIDER=sqlite DATABASE_URL='file:/absolute/path/to/happier-server-light.sqlite' yarn session-message-author:backfill
```

For PostgreSQL or MySQL, select `postgres` or `mysql` and supply that deployment's connection URL. The command keyset-pages bounded batches, validates receipts through Protocol, resolves surviving Accounts, and fills only still-null projections. It prints aggregate counts and exits unsuccessfully on a non-null disagreement. It never repairs the receipt from the author column. Stop unsupported older writers before the cutover; if one wrote during the transition, rerun after it has stopped. Enable Lane 09's author-based personal scopes only after the audit succeeds. An interrupted backfill may safely restart; it has no persistent worker or checkpoint.

Migration reconciliation and retained-database requirements remain in [Compatibility and version skew](compatibility.md#migration-history). These are development contracts, not certification of a released upgrade or the composed browser/native authorship journey.

## Automation input cancellation

In current development, authoritative Automation Run cancellation uses the same exact-input cleanup for existing and newly created Sessions. Once the canonical new-Session result is known, the Automation executor registers that Session for cleanup, including while waiting for the admitted input's final result. The existing pending adapter retires only the Run-derived input; if the server reports that exact pending row is absent, it asks the Session runtime to cancel only the active turn whose input identity still matches. A different, finished, unsupported, or unreachable turn never causes broad Session cancellation.

Ordinary claim, lease, or worker invalidation does not authorize this cleanup. Cancelling a Run preserves the produced Session and its history; it does not delete the Session or cancel unrelated later input. Automation Run settlement remains authoritative for any uncertain effect.

> **Superseded attempt-design record (2026-07-14).** Queue V2 is the only active pending-delivery system. `attempt_v1` will not be activated: its runtime/protocol branches are removed after the live exact-selector contract is extracted, and its schema/migrations are squashed or forward-contracted from bounded persistence evidence. Current authority and markers: `../remote-dev/.project/plans/pending-delivery-attempt-v1-and-session-lifecycle-reliability-unification.md`. Everything below this notice is historical design evidence, not implementation or cutover instruction.

## Historical attempt design

Pending Queue V2 remains Dev's released durable payload, ordering, delivery-state, and compatibility owner. The following describes the abandoned admission-off attempt proposal.

## D0 owners

- Enqueue chooses `tag_queue_v2` or `attempt_v1` once. A retry must preserve the persisted selection and cannot change protocol.
- `packages/protocol/src/sessions/messages/pendingDeliveryAttemptV1.ts` owns bounded public attempt identity, strict claim selectors, the pure transition table, exact active-coordinate helpers, automatic-retry classification, and derived presentation.
- `apps/server/sources/app/session/pending/pendingDeliveryAttemptEnqueueSelection.ts` owns the pure fail-closed selection decision. It is intentionally unwired and hard-disabled in D0.
- `apps/server/sources/app/session/pending/pendingDeliveryAttemptAuthorization.ts` maps bounded human actions onto Dev's existing session access levels.
- Dev Agent/plugin runtime architecture remains under `apps/cli/src/agent/**` and `packages/plugins/**`. D0 adds no runtime or provider adapter.

No writable coarse attempt state exists. Presentation is derived from retained attempt facts and row disposition.

## Feature boundary

`sharing.pendingQueueV2` and `sharing.pendingDeliveryState` remain the released queue and July delivery-state compatibility gates. They are not attempt admission.

There is one attempt gate: `sharing.pendingDeliveryAttempts`. It is server-represented, fail closed, depends on Pending Queue V2, and is advertised disabled in Dev. There is no second claim gate, per-session floor, promotion/cohort gate, or provider capability gate.

## Pure attempt lifecycle

The canonical path is:

`reserved -> write_authorized -> custody_observed -> accepted`

- Custody is nonterminal and is never acceptance.
- `handoff_acknowledged` is terminal but observably weaker than `accepted`.
- Possible-write failure becomes `ambiguous`; it cannot automatically retry.
- Only explicit pre-write `retryable` may automatically retry.
- Pre-write cancellation, provider cancellation request/result, owner ambiguity resolution, and hide/mark-handled remain distinct.
- Handled presentation retains the terminal outcome and replay fence.
- Every transition checks exact attempt identity, expected revision, and predecessor phase.
- Repeating a terminal command is rejected by revision or phase without mutation.

The public command union includes every accepted kernel command, including the payload-bearing `record_provider_cancellation_result` command.

## Selection and coordinate invariants

Claims use exactly one selector:

- `{kind:'head'}`; or
- `{kind:'exact_target',localId,ownerAuthorizedOverride:'send_now'|'steer'}`.

Exact-target selection carries no reorder or substitution field. D1 must prove the transaction either claims that exact row or fails.

Only one attempt id may occupy the session coordinate. Reacquiring the same id is idempotent; a competing id is rejected. Terminal release clears the coordinate only when it still names that exact attempt, so a stale completion cannot clear a successor.

## Human authorization

- Viewers may inspect derived state.
- Editors may enqueue, edit, reorder, discard, restore, cancel before write, dispatch, steer, and interrupt.
- Only the actual session owner may request provider cancellation, hide/mark handled, resolve ambiguity, or authorize duplicate-risk resend.
- Unknown action values and shapes fail closed.

These human permissions never substitute for the future runtime incarnation, claimant credential, revision CAS, or provider evidence.

## D1 and later boundaries

D1 will add the attempt child, `Session.activePendingAttemptId`, portable transaction/CAS behavior, and the physical `status='attempt_queued'` fence across PostgreSQL, SQLite, and MySQL. Public projection will continue to report retained attempt rows as queued. Admission remains off.

R0 later consumes the separate Runtime Activity authority's typed revision-bound decision and the reviewed runner-incarnation binding. Pending must not create its own Activity timer, infer Activity from foreground turns, or mint rival supervisor/generation authority.

D2 integrates exact attempt context through Dev's Agent/plugin runtime owners. D3 converts callers and UI. Released delivery-state writers and compatibility paths remain until their reviewed cutover corridor replaces them.

## Explicitly absent from V1

V1 has no receipt history, provider evidence journal, provider capability ceremony, numeric protocol floor, promotion cohort, second claim gate, caller-local admission switch, mutable row-level attempt lifecycle, provider branch in shared core, or automatic resend after possible write.

Secrets, raw provider evidence, content, and credentials never belong in public state, logs, metrics, transcript metadata, or UI.
