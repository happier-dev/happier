# Pending delivery architecture

## Composer send choices (0.3 development)

The existing-session composer's send button offers per-message choices on long
press (or right-click on web): **Steer now** when the current session can steer,
**Queue**, and **Send now (interrupt)**. Selecting a choice submits the current
draft through the existing submission owner, overriding saved send preferences
for that message. A normal tap keeps the saved behavior; dismissal preserves the
draft. Dictation, Stop, pending-message editing, routed messages, and armed Agent
or route continuations retain their own actions without this menu.

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

## Follow-original replay (0.3 development)

Pending reads project `hostFollowInput` from the server-admitted Follow receipt,
beside the opaque input content. The UI admits that public original once and
uses its existing host-input recognition owner before request metadata settles
to authority. Authored request/provenance fields alone do not establish pending
host identity. The read projection exposes no private rule, permission or grant
witness and does not authorize delivery, wake, reply or ACK. Older responses
without the projection retain settled-authority recognition.

Queued host Follow input renders as a source notice rather than a person's
message bubble. Plainly queued or delivering updates from the same source fold
into one counted notice at the first row's position, with needs-you taking
precedence and the latest update chosen among equal states. Blocked, failed and
cancelling rows stay separate. This groups presentation only: every underlying
row keeps its identity, order and delivery custody. A needs-you Session notice
offers the existing source-opening action.

Protected `next_turn` Follow input remains informational context until a real
input starts native work; Resume alone does not turn it into a wake. A newly
admitted `wake` can start eligible idle work through the existing receiver and
resume owners. Retained context joins the dispatched prompt and settles only
when represented in its actual native acceptance, as described under
[UI settlement convergence](#ui-settlement-convergence-development).

An Account-issued Follow original is identified by its source Session, original
sequence, event and authenticated admission receipt. Its delivered content is
derived from that source event. After host admission freezes Pending custody,
a freshly authorized, matching replay rejoins the existing input as
`alreadyAccepted` (HTTP `didWrite: false`); it never replaces retained content, receipt, claim or
queue position, and does not prove provider acceptance or advance the source
frontier. Changed event, delivery intent, receipt or content mode still refuses.

Every replay of that frozen Pending row passes through its request-equality
owner. Plaintext must match the retained original plaintext digest, even after host settlement
replaces request metadata with protected authority. An encrypted retry carrying
an equality tag must match the retained tag. Account-issued encrypted Follow
originals carry no such tag on the Account HTTP route: fresh authorization and
the same canonical original identity permit only a no-op rejoin, including when
re-encryption produces different ciphertext. Home does not infer plaintext
equality from opaque bytes or store the retry's ciphertext. This identity-only
rule applies to frozen Account Follow custody; Machine-issued replay retains
its existing equality contract. No new proof field or route shape is required.

## Host retirement before dispatch (0.3 development)

Claiming an input transfers custody to the host; it does not prove native
dispatch. The Session client records the foreground prompt and steer effect
boundaries, including every original represented by a composed prompt. The
moment a runner begins retirement (termination signal or explicit stop, before
its runtime disposal starts), the client fences that boundary and settles only
claimed inputs that never crossed it as `host_retired_before_dispatch`; a
prompt still being prepared cannot dispatch while the runtime disposes, and
close repeats neither the fence nor the settlement. Native input still waiting
for host admission uses the same exact-input settlement when disposed.

A successor publisher returns only that proven pre-dispatch disposition to the
existing Pending queue, preserving its local id, content and requested action.
Inherited delivering claims remain `delivery_outcome_uncertain`; a late
pre-dispatch settlement cannot overwrite that uncertainty. Historical
`runtime_disposed_before_delivery` rows retain their existing behavior. A failed
close-time write supplies no replay proof, so replacement keeps the uncertainty
guard. This development correction requires the composed CLI/daemon replay on
the loaded runtime; source tests alone do not certify it.

## First-input admission and storage failures (development)

Pending position allocation runs through `inPendingQueuePositionTx`. Its shared
`acquireSessionAccountCursorLocksInTx` owner locks the complete publication audience
in Account id order, including the owner and manager Follow projection recipients.
On PostgreSQL, it then locks the Session row before admission reads, so concurrent
startup metadata or activity writes cannot commit between that read and the
queue-counter update. This Account-before-Session order retains same-Account
heartbeat protection and avoids owner-first cycles for mutually shared Sessions.
SQLite retains its single-writer transaction behavior. Serialization recovery
belongs to `inTx`; admission adds no separate retry policy.

After that recovery is exhausted, a PostgreSQL write-conflict rollback, Prisma's
explicit expired-query transaction rollback, or failure to acquire a transaction
before its callback starts is a definite Machine-input
rejection, `session_input_storage_unavailable`. An indeterminate database commit
remains `outcomeUnknown`. The daemon carries the admission result back to the
new-session UI, which retains the prompt as a draft and shows the canonical
rejection explanation instead of treating a known failure as an uncertain send.
The CLI create result likewise preserves the existing nested `initialInput`
disposition: creating the Session does not establish that its first message was
accepted. Unclassified transaction errors and earlier ambiguous attempts remain
uncertain; the expiry classification adds no retry or input redelivery.
Neither result automatically resends the prompt. A rolled-back first admission
does not itself make the Session's empty hosted transcript unreadable.

## Caller-owned external handoff (0.3 development)

Voice reserves input with `deliveryMode: external_handoff` before dispatching
it through its admitted provider or Execution Run. This reservation belongs to
the caller and cannot be materialized by the Session's main runner. Its admission
checks current Session input access, archive state and content mode; it does not
require the transcript carrier's retained main-runner Machine placement to be
available. The provider or Run ingress still admits actual execution. Ordinary
runner-bound input retains exact Machine-target admission. The existing handled
settlement commits the accepted transcript and retires the reservation.

## Correlated Session answers (0.3 development)

`session.message.send` has one canonical `reply` intent: `none`, `wait`, or
`return`. Legacy boolean `wait` remains an ingress adapter; combining it with
`reply` is invalid. An observation timeout or cancellation ends observation,
not accepted execution, and is not an answer, pass, or task expiry. New reply
intent fails closed when the target Home does not support its protocol.

In 0.3 development, the shared reply-capability reader distinguishes an
affirmative unsupported result from an unavailable read. Transport failures,
authentication failures, missing scoped authorization and invalid responses
hold the exact input with `outcomeUnknown`; they cannot permanently reject it
as `session_input_target_update_required`. Recovery retains the original local
id. The current Home's `404 { error: 'Session not found' }` is also unavailable:
it masks missing Session access rather than proving the capability route absent.
An absent route still reports unsupported. The reader logs only the route,
Session id and content-free failure class.

`none` creates no answer obligation. `wait` observes one exact answer inline;
ending that observation does not promise an unsolicited later return. `return`
retains the admitted return destination when its inline consumer retires. A
caller-provided `timeoutSeconds` bounds observation only, without a separate
coordination deadline. Run-lifetime waiting remains the distinct
`execution.run.wait` owner; neither parent idleness nor a Run's terminal status
substitutes for the exact submitted input's outcome.

The original Pending input owns optional strict reply progress. Materialization
carries that progress to the same input's committed `SessionMessage`; there is
no separate obligation table. It retains admitted source correlation, exact
accepted turn, one immutable outcome, and inline/return disposition. Result text
remains in its normal encrypted/plain message envelope. Explicit answers and
passes name the original input; an unrelated later final or publication cannot
fulfill it. A committed explicit publication wins over automatic final fallback.
Failed, cancelled, passed, and terminal-without-result outcomes remain distinct.
For a cancelled foreground turn with an exact committed assistant-message anchor,
the outcome retains that result reference. The authorized result reader resolves
its `partialText` and message reference for inline replies or late return;
original-input progress contains no partial plaintext. A later assistant row
cannot replace missing or unreadable partial content. Cancellation without a
committed partial keeps its payload-free outcome.

Protected Workflow V2 invocation inputs use that same reply intent and original
custody, retaining their derived Workflow input localId through Pending retirement.
The Workflow producer requests `wait` and its observer reads the typed original
outcome; a pass does not depend on response text. The existing Workflow progress
retains that typed outcome across restart, independently of selected result text.
A reference-only answer with no readable text needs attention rather than becoming
fabricated text. Historical inputs with authoritative reply status `none` retain
exact-input transcript observation. Unavailable reply custody holds. When an
unfulfilled original names its accepted Workflow turn, the same result reader can
observe that terminal turn only if its Workflow invocation also matches the
protected input identity. A completed turn whose final-message anchor is missing
can supply text only from committed, foreground assistant rows tagged with that
exact runtime turn; stale range anchors do not substitute for that identity.
Explicit original outcomes still take precedence, and an active or unmatched
turn, provisional text, or a later foreign reply cannot complete the input.
V2 input remains host-authored:
a return destination requires admitted source-Session correlation, and it cannot
claim a person's composer origin or downgrade to V1 to acquire reply support.

The existing `waitForSessionInputResult` observes this custody and resolves an
answer's exact committed message, not the latest assistant text. A strict
`SessionMessageRefV1` contains the captured Home, Session, and actual committed
message id; Pending ids, local ids, and turn ids are never message references.
Normal current access and content-mode checks still precede disclosure.

In 0.3 development, `session.input.result.get` with `projection: 'reply'`
reads that same original reply custody for agents and CLI callers, including
queued inputs before transcript materialization. It returns the canonical
`available`, `none` or `unavailable` projection without loading answer bodies;
omitting `projection` keeps the existing native input-result read. Plugin
callers retain their original producer/receipt check before reading progress.
Single and batch HTTP reads share demanded set acquisition beneath the original
input owner, preserving Pending precedence and current access/source checks.
The shared portable SQL binding boundary chunks queries without limiting the
requested result set. Observation never consumes or changes reply progress.

Inline consumption and late-return release use the original input's authenticated
CAS. Late recovery runs in the existing owning Machine daemon, using a finite
indexed page of original inputs on startup, reconnect, or a content-free hint.
That daemon may acknowledge returned custody, not author outcomes or consume
them inline. Missing current requester credentials/access leave custody pending;
hosting a foreign Session does not authorize borrowing another Account's keys.
Lost acknowledgments rejoin the deterministic returned-input identity.

Receiver check-in requires the current Account snapshot to be network-confirmed.
The snapshot publisher admits the first network confirmation of a cached revision
even when its version is unchanged, preserving equal preference values and
publishing that readiness once. Later equal-version confirmations remain no-ops.
This lets retained unstarted input pass its existing admission check without
changing preferences or resending the input.

Daemon-routed Actions settle inline/release through
`session.message.reply.observe.v1` on the existing authenticated SessionAction
transport. Its strict input names only the original request Session, local id,
and `inline` or `release`; the current source Session delegates to its existing
reply mutation. It cannot author an outcome or choose another return destination.

Native Run Stop settles the exact admitted turn as cancelled using the host's
existing terminal fact, even after its native transcript writer retires. The
host retains the exact committed partial's local id with that native input turn,
including when a later tool call leaves no final answer. On cancellation it
resolves that id to the actual committed message reference through the existing
transcript reader. Its fulfillment mutation carries a content-free native
binding: Run id, sidechain and committed local id. The current publisher and
accepted-turn checks remain mandatory; the reply owner checks the binding
against the original input's Run/sidechain and exact committed row after that
input. Encrypted metadata is never treated as server-readable proof. Only the
reference enters reply custody; the authorized reader resolves partial text.
An unavailable committed reference leaves fulfillment pending, while a turn
with no committed partial keeps bare cancellation. C3/C4 retain attribution and
publication ownership. A crash
between a native terminal transcript commit and the reply-custody callback can
still leave the ask pending. Current Machine return recovery reads only fulfilled
original custody and cannot author outcomes; re-asking remains the recovery for
that window. Workflow `wait` observation has the exact accepted-turn recovery
above; it does not author an original reply outcome or a return delivery. No
terminal sidecar or separate recovery store is used.

`deliverSessionMessageReply` is the host-only delivery entry point shared with
question answers. It reuses ordinary Pending admission and receiver policy:
idle wake, busy next boundary, person-Stop hold, archive refusal, and offline
retention. Both `wait` and `continue` question answers use that receiver policy:
a busy asker receives the answer at its next boundary, and an idle asker can
resume through the existing inactive-session resume owner.
Returned information has no acknowledgment obligation and does not reset the
autonomous exchange. Its protected actual sender selects mute policy; display
attribution never supplies source authority. Original question/input owners
choose the destination and answer eligibility; authored metadata cannot do so.
An answer returned to an Account-origin Ask keeps that original input's exchange
root through the existing committed-acceptance reader. The return itself does
not count as a turn; a later actual autonomous child counts at the same original.

A person's Ask may supply an exact `returnToSessionId` with `reply: 'return'`.
Current present-person admission binds that destination as protected
`replyIntent.humanOrigin.sessionId`; it never invents an Agent source turn.
The accepted target input supplies the original request local id and retains
this binding through materialization and late recovery. A public destination
field alone grants neither present-person authority nor access, and human,
Agent and Discussion return origins cannot be combined. A shared target may
belong to another Account: the original authenticated receipt retains the
requester, while the target's publisher retains execution authority. Target
settlement rechecks the requester's input permission and private return
destination and its audience through the canonical context-disclosure policy.
An admitted Machine signed into the requester's Account recovers through the
existing indexed original-input inventory and returns with its own credentials;
the ordinary send owner resolves the return Session's current hosting Machine.
the target's Account receives no authority over the private source. Result
reads and return acknowledgments recheck target read access and source input
access. Revocation leaves the original result retained without disclosure.
The composed composer
journey still needs its owning loaded-runtime validation. Voice later-return
binds its captured Session through the existing Action person-approval flow.
Only a real present-person approval decision admits that human-origin return;
the Voice tool itself remains Account automation and cannot manufacture a causal
turn or approve its own request. A saved approval waiver does not supply human
authority. The current source path supports screen confirmation, not an inferred
person decision from a generic spoken tool call. Ordinary Voice wait remains inline.

Public Session sends may also carry the existing raw-ingress `structuredInput`
envelope. Admission retains its validated exact references in the existing
Message metadata envelope; it does not reconstruct them from display text. A
client must refuse an endpoint that would silently ignore this field, including
on an informational `reply: 'none'` send. Source-bound attachments additionally
require the target's actual preparation contract; copying a source handle or
local path into a target payload is not admission.

Targeted Composer staged media captures an immutable source submission through
the existing custody owner, then creates independent target-bound snapshots.
Cross-Machine preparation reads the source through `inspectComposerContent` and
the existing staged-media reader upload. Raw target handles reach the target's
normal finalizer; admitted SessionMedia output is not sent back as raw input.
The prepare RPC's optional typed `sourceComposerRef` keeps the captured source
identity separate from a Pending edit's possibly rotated admission local id.
Existing settlement carries each exact release intent (handle, execution target,
owner and claimant), releasing submission snapshots after finalization while
retaining the mutable source draft. Enqueue acknowledgment alone does not
release those bytes. This is development-source behavior, not loaded-runtime or
all-media support certification.

Request equality ignores only validated staged-media transport handle ids;
content identity, selection, presentation, destination, reply and requested
action remain equality-bearing. The same serializer owns plain digests and
keyed encrypted-request evidence. This lets a fresh target snapshot rejoin an
uncertain send without another lookup or equality owner. Pre-fix development
evidence included those ids and can refuse a retry after this change; existing
data remains readable, with no intermediate-shape migration or fallback.

Captured review context uses the existing typed `reviewComments` snapshot at raw
ingress and the existing review-comment builder at transcript admission. Its
source references, anchors, selected bodies and context arrays are not rebuilt
from a rendered summary. The media bridge preserves only schema-valid incumbent
review/attachment envelopes through its generic privacy sanitizer; unrelated
metadata still follows that sanitizer. This does not authorize a caller-supplied
file path or turn review context into an admitted attachment selection.

Legacy uploaded files travel as target-Session-issued handles, not source paths.
The same target prepare RPC resolves them through its actual upload owner before
Pending records the incumbent attachment descriptors. Later materialization
therefore does not depend on the upload process's in-memory handle map. Retry
uses the original Pending/Message correspondence and canonical request equality;
it cannot change the ordered handles or authored action. A target missing the
required prepared metadata is refused before creating a new Pending input.
Native image admission still verifies the actual workspace file, path and hash
through the existing attachment verifier. Native URI sources retain the ordinary
uploader's file-reader lifetime rather than promising a new immutable byte store.
If the issuing process loses an upload before original admission, preparation
returns `session_attachment_upload_checkpoint_stale` only after the existing
Pending/Message reader establishes no original input and the actual issued
record is missing. The Composer removes only the matching attempted upload
checkpoint, keeping the source draft and message local id. The next explicit
retry uploads again; there is no automatic retry loop. Ambiguous, transport and
unclassified failures retain the checkpoint, while an already admitted input
continues to rejoin its original descriptors after the upload store retires.

Channels retains its external endpoint, original external-message correlation
and outward delivery custody. It consumes this exact Session input/result owner;
Session answer return does not create a second external send or a Channels
outbox. Automation's immutable final-result handoff remains its own contract.

## Autonomous check-in (0.3 development)

Protected Pending admission and the native Session Turn owner share one count on
the admitted input's exchange root. Admission alone does not spend allowance:
the exact accepted input must join its actual new-turn witness. Same-turn
supplements, steering and returned answers do not count. At the Account's current
check-in limit, the next autonomous input remains Pending with
`autonomous_check_in`; the root's person can Continue, allow ten more starts, or
Stop through the existing revision-bound exchange control.

The receiver Account's Pending reader includes `autonomousExchangeRoot:
{sessionId, localId}` only on a queued `autonomous_check_in` hold whose original
root is readable and belongs to that Account. Shared viewers and restricted
Session runtimes do not receive the pointer. The client keeps this exact pair as
`pendingAutonomousExchangeRoot` for the existing exchange controls; absence on
an older Home leaves those controls unavailable. Continue releases the hold and
removes the pointer from the Pending projection. No latest-message lookup or new
exchange authority is introduced.

Within one Account, causal inputs retain their original root. A cross-Account
agent cause instead joins the receiving Session's current Account-local root.
If it has no prior local input, the protected incoming input becomes that local
root. Only the receiver's current check-in setting and native starts apply;
neither the foreign actor nor their private preference crosses the boundary,
and the foreign root is not mutated. Follow wake admission uses the same local
root read; Discussion source observation no longer holds an otherwise authorized
original solely because its author belongs to another Account. Pending still
enforces the receiver's check-in before the effect. This changes autonomous
start accounting, not the separate cross-Account late-return contract above.

Run-caused Session wakes use the receiving side's exchange: the most recent
protected person-written input in that Session is their root, not an inherited
root on a later agent input or a fabricated parent input of the Run. With no
person-written input, the exact Run occurrence supplies the root through its
existing deterministic Follow input identity. Only an actual new native turn
spends allowance; quiet Run context and personal Inbox delivery do not. A new
person-written input resets the receiving exchange. Existing Stop and check-in
controls still apply; missing parent lineage never creates a separate hold.

Exact Execution Run targets are excluded from this Session check-in count. They
remain bounded by their own lifecycle; their parent Session's own autonomous
turns are already counted. They do not inherit the parent's Stop/busy/check-in
projection, and do not require a Run-to-Session start-witness protocol.

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

## Claude background activity and delivery readiness (development)

`after_runtime_idle` consumes the existing Runtime Activity projection. Claude's
SDK runtime keeps task activity in one ledger keyed by native Session and task id.
An owned SDK stream or an exact native tool call associates the task with its
actual query object. This association is independent of transcript presentation.
A successful resume transfers the task to its newer query; terminal facts and
process exits from the older query cannot settle the resumed execution.

Losing a query observer demotes its unresolved tasks to unknown while retaining
their exact identities. Only that query's observed native process exit settles
its owned tasks. Foreground completion and query disposal do not prove process
exit. Failed physical disposal retains unknown activity, reports a default
warning, and preserves the original provider failure delivered to the caller.
Explicit SDK retirement attempts all registered owned queries, including queries
whose earlier cleanup failed. Releasing source observation cannot skip those
physical cleanup attempts. Retirement rejects failed cleanup, preserving the
original single failure or all failures with their cause. Transient control query
creation uses the same owner and cannot begin after retirement starts.
Cancellation prioritizes the foreground turn while it is in flight. After local
foreground completion, even while its query is still draining,
a background task is targeted only through its known query owner; an uncorrelated
shared hook does not authorize choosing an arbitrary query. TaskStop and TaskOutput
hooks use the target owner captured by their exact tool call; an uncorrelated
shared hook cannot settle a task owned by another query.

A first-party SDK local presentation prepares invocation hook resources separately
from the retained remote Session endpoint. Preparation grants no task authority.
The host reports an actual launch before that local binding can own activity in
the same ledger, including a resumed task with the same native tuple. Older SDK
hooks cannot attribute their observations to that binding. The launch builder's
explicit direct-child qualification and actual process closure settle only that
local owner; an unproven wrapper outcome loses observation. Failed preparation
releases its pending resources, and cleanup failures remain observable without
undoing positive provider-close evidence. External or unattributed tasks remain
conservative when the last SDK query exits, because that exit does not prove a
separate terminal process stopped. The unified terminal's current owned host can
publish physical provider-close proof through
its scoped exit subscription and settle Activity without another prompt. Wrapper
death, post-spawn errors, and SessionEnd alone remain unknown. A confirmed dead
pane demotes unresolved activity to unknown; an inconclusive liveness probe
preserves the last active facts. Explicit unified disposal loses observation of
unresolved tasks and projects unknown, whether physical cleanup succeeds or fails;
already proven native closure remains idle. Retained or external hosts without this
subscription remain conservative; see the Claude
terminal host ownership contract in [CLI architecture](./cli-architecture.md).
The SDK execution adapter preserves the same launch builder's
`providerExitOwnership: 'direct'` qualification through the existing system-tool
resolution. It emits `providerStopped: true` only with an actual exit or signal
from that exact resolved invocation. Shell-wrapper exit and missing qualification
retain unknown Activity; a numeric root exit code is not provider-stop proof.
The Agent terminal host retains that launch qualification when projecting its
immediate child exit to the Agent runtime.
A managed child operation error, including cancellation after launch, does not
settle its physical-exit waiter. Its owner still awaits actual child exit.
A completed query observation can report idle without releasing its physical
query owner. The same activity ledger retains that owner for Session disposal
until confirmed provider stop, so failed cleanup is retried and reported even
after all of that query's tasks completed. Delayed activity from the completed
observer remains ignored.
Completing a pending source-history baseline releases only its own observation
gap. Lost query observation, unresolved unattributed tasks, and a genuine
source-history observation loss still keep Activity unknown. Historical terminal
pages are admitted through the same bounded source owner as fresh pages; the
provider readers already support that replay projection. Delayed task-cancellation
responses clear only the captured task and turn, preserving a newer resumed owner.

The host owns delivery of this projection to the server. Binding or retiring a
runtime keeps Activity unknown until a provider snapshot supplies its state. The
first runtime listener refreshes the canonical provider watch if prompt-outcome
observation had already started it, so its current snapshot is still delivered.
A rejected publication
reports one default warning per failed enqueue, including when callers await it.
The projection retains its existing retry and ordering behavior.

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

In 0.3 development source, the Claude plugin's transcript lifecycle mapper treats
the exact main-chain `[Request interrupted by user]` and
`[Request interrupted by user for tool use]` markers as foreground aborts on both
text and user-prompt observation paths. The existing input owner can then release
a waiting **Send now** prompt; the abort does not prove acceptance of that follow-up.

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

Retained next-turn Follow originals and returned answers are informational
context, not additional native Turn or permission witnesses. The current host
binds only the exact originals represented in its final dispatched prompt to
the primary input's actual native outcome. Their existing Pending settlements
precede the primary's settlement; an omitted original is not thereby accepted.
Exact claim, publisher and target checks still precede settlement. The operation-scoped retained-context
proof is described in [compatibility](compatibility.md#retained-quiet-input-03-development).

For ACP in 0.3 development source, provider effect correlated to the exact
dispatched prompt witnesses consumption even before `session/prompt` responds.
The public ACP producer emits `input-accepted` through the existing host
settlement path before releasing that turn's buffered output. A later typed
turn failure retains the output and failure cause but does not return the input
to Pending; a user retry is a new input. Transport loss without witnessed
effect remains unknown. Previously blocked rows can accept later exact
acceptance evidence through the same Pending owner. A terminal turn or an
admitted user transcript row alone cannot reconstruct missing historical
acceptance evidence. Loaded-runtime and historical-row replay remain separate
validation from this source contract.

An opted-in ACP hard cap settles the submission waiter even when the Agent has
not replied. Mode/configuration updates alone are not prompt-turn effects and
leave delivery uncertain; actual correlated prompt output remains acceptance
evidence. The cap does not create a second acceptance or timeout owner.

Uncertain recovery in development source uses the same configurable Action
policy on UI, CLI and Agent surfaces. `session.pending.markHandled` resolves
confirmed historical main-conversation input without resending it;
`session.pending.dismiss` archives uncertain custody; and
`session.pending.sendAsNew` atomically replaces it with the server-owned new
Pending identity. These dangerous operations default to Ask first. They delegate
to the existing authenticated Pending routes and `pendingMessageService`
transitions, preserving their access, idempotence and settlement checks.
Dismiss and Send-as-new support exact Execution Run targets; Mark handled has
no target-run operation. Withdrawal still reports delivered/unknown custody
instead of substituting for these explicit recovery decisions. Local outbox
Retry Send remains a retry of its existing operation.

Native Session retirement fences incoming evidence before disposing the Agent.
At that fence, the host publishes the existing exact custody-unknown outcome for
each unresolved input, before waiting for native cleanup. Slow or failed cleanup
therefore cannot leave that input labeled Delivering solely because disposal has
not finished. Accepted, rejected and already-uncertain inputs retain their prior
evidence. This does not prove pre-effect rejection or authorize automatic replay;
the existing explicit recovery Actions retain uncertain custody.
The host's replaceable native-runtime adapter keeps this exact-outcome callback
bound through disposal, then retires its binding epoch even if cleanup fails.
Runtime events and model sources are fenced when retirement begins; that fence
must not discard the custody outcome produced by retirement itself.

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

In development source, acceptance fences bind to the recipient's refresh
outstanding when HTTP success arrives. Waiting for response-body identity
validation cannot attach that earlier acceptance to a newer read that already
proves row removal. The shared requested-action entry point reconciles the exact
Home, Account, Session and recipient on row `not-found` and `action-conflict`, then
preserves the original action error. This covers Send now, steering, and resume
actions without UI-owned row removal.

To distinguish settlement from display failures, inspect the canonical Pending
read for the exact Session, target, and `localId`. A retained server row points
to acceptance or settlement; an absent server row with a stale mounted Pending
row points to client convergence. Host contention can delay either path and is
not itself evidence of a projection defect.

Accepted settlement retries transient server `internal` responses, lost ACKs,
and typed transaction-unavailable responses for the lifetime of the existing
Session/runtime authority. These retries settle the same exact accepted
`localId`; they never re-inject input into the Agent. The existing typed server
delay is retained, and internal failures reuse the response-loss retry cadence.
Retries stop on Session close, connection/consumer replacement, exact retirement,
or a permanent settlement error. Each retry is recorded in the default Session
file log without writing to the Agent terminal.

When an accepted row remains unresolved after a non-retryable settlement result,
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
handles. Snapshot projection reads the finalized admitted attachment selection,
not the draft staged-media input; an attachment-only row remains a queued Message
even when its text is empty. Successful enqueue acknowledges that exact accepted
fact to the daemon after the server ACK; failure before local custody or a
confirmed cancellation
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

Pending counts and versions come from the server's projection. A materialization
acknowledgement without that projection retains the last server state; it does
not decrement counts or increment versions. The existing projection owner also
rejects older snapshots and hints, so a delayed empty response cannot hide a
newer pending row. Execution Run inputs retain their separate admission owner.

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
an explicitly blocked message still requires person recovery. A confirmed
`provider_rejected_before_acceptance` ends that delivery attempt, not custody of
the original input. Its Pending row remains visible with the rejection reason:
the person can remove it, or deliberately send it again through the existing
Send now/Steer now controls. The shared `session.pending.action.set` Action can
also rearm that same original; it clears the previous provider action and block.
Resuming the Session alone does none of these things.

`delivery_outcome_uncertain` means an effect may already exist. Its visible
recovery is Dismiss, Mark handled after confirming it was handled, or an explicit
duplicate-risk Send as new through the Actions described above. It cannot be
blindly retried, edited, or removed as though nothing was sent. These ordinary
blocked predecessors retain FIFO for later `enqueue` input, including addressed
Discussion asks; addressing grants neither a queue-priority override nor proof
of native acceptance. Later rows remain Queued, with the predecessor defer
reason, while the earlier blocked row owns its explanation and repair controls.
The per-row Retry Send control is for a failed local outbox operation, not a
second recovery owner for uncertain server custody.

In 0.3 development, Send as new is shown only when the server's Pending recovery
projection permits it. Originals with reply custody, including addressed
Discussion asks, cannot be copied to a new identity; Dismiss remains available.
The server derives this eligibility from the same reply-custody fact checked by
the recovery mutation, without exposing reply progress. An absent or malformed
projection supplies no Send as new eligibility.

Session Follow originals also re-enter Pending's settlement owner before a
provider effect. The existing Follow owner checks the original's current
relations and rules, including the exact manager attachment. A removed or
replaced attachment cannot keep an unstarted original executable; a surviving
overlapping Follow reason remains usable. If losing the route also removes its
source observation, the host asks Pending to recheck the exact retained input
before reporting unavailable Follow context. Confirmed `session_input_cancelled`
retires that input's local custody and releases the next queued input without a
failed turn or Follow ACK. Unavailable reads retain custody, and this check never
replays or cancels provider-accepted work. Resolved questions whose route still
exists retain the source hydrator's current, opened request check.

For Discussion inputs in 0.3 development, the committed append owner selects
the exact `(discussionId, messageId, participantSessionId, throughSeq)` tuple.
Follow intake carries it in `discussionAddressing` and the original reply
destination; the authenticated Machine receipt binds the same tuple to the
admitted receiver. Materialization and the private host turn witness retain it.
Injected question context and bounded `discussion.read` requests cannot advance
to a later feed cutoff; a second question has its own original and cutoff.

Before a provider effect, Pending's
[settlement/readmission owner](../apps/server/sources/app/session/pending/pendingMessageService.ts)
reopens the original reply progress and receipt, including for materialized input. It checks
their exact tuple, the committed question, current participation, access and
delivery mute; newly supplied request metadata is not replacement authority.
A released or revoked original cannot dispatch. Participant removal or
Discussion archive withdraws outstanding returns in that same original custody;
reinvitation cannot revive a withdrawn ask. The client preserves Pending's
`session_input_cancelled` result as a definite withdrawal at the shared final
dispatch boundary. Normal input and in-flight steer then end quietly before a
provider effect: they create no failed turn, second rejection settlement or
synthetic ready/finished notification. The next unrelated input remains eligible.
Other admission refusals, holds and unknown outcomes retain their existing
failure/recovery handling. This does not override ordinary
blocked-predecessor FIFO or the unknown-effect recovery above. The canonical
checks are `validateInputSettlementDomainFactsInTx` with the
[Session reply owner's](../apps/server/sources/app/session/messages/sessionMessageReply.ts)
`isDiscussionReplyDestinationCurrentInTx` and `withdrawDiscussionInputRepliesInTx`;
see [Discussion provenance](session-collaboration.md#discussion-provenance)
for cutoff, explicit/final arbitration and private-review consequences. Native
continuation isolation remains a separate composed-validation obligation.

## Current Queue V2 activation ownership

This section describes development behavior that is not yet a released contract. Pending Queue V2 remains the sole durable owner of message custody, ordering, and exact-row actions. An inactive-session activation request is a small session-level authorization for one exact eligible queued row; it is not another message-delivery state machine and does not change that row's delivery priority.

Shared-editor input can arm inactive Session activation through the managed
Machine's accepted-input wake policy only while it is asleep and
`wakeOnAcceptedMessage` is enabled.
Otherwise it stays queued, including on a running managed Machine, just as on an
ordinary Machine. Owner-authored input retains its existing explicit-resume behavior.

- The resumable inactive composer remains usable while its exact target machine or daemon is offline. Ordinary submissions persist in Pending while the session continues to present its offline status. An input that first requires remote attachment upload or preparation stays in its draft if that step is unavailable; it is not queued with attachments silently omitted.
- The account preference **Automatic resume after sending** (`sessionInactiveResumePolicy`) has one three-state owner. All ordinary inactive/offline input persists as FIFO `enqueue`. `when_available` additionally arms the exact Session authorization; `online_only` makes at most one user-present UI resume attempt when the exact machine is currently reachable; `manual` only persists the row. The default is `online_only`.
- Neither `when_available` nor `online_only` changes an ordinary row to `send_now`; that action remains reserved for an explicit immediate-delivery request. If reachability changes or an `online_only` attempt fails, Pending custody remains without authorization for a later unattended start.
- The user-present public launch request observes the daemon's last physical Stop at invocation. An earlier Processes, Guard or widget Stop does not veto that new request, but a later Stop still retires its launch admission. This is not person Resume intent: native launch still rechecks persisted automatic-resume eligibility and requester custody, and cannot clear a person-Stop hold. Retained internal recovery does not inherit public-request freshness.
- The banner action **Process when online** re-arms the exact Session authorization. **Retry** uses the existing manual resume action when the machine is reachable. **Keep queued** clears that authorization while preserving FIFO delivery. These actions do not change the account preference or create a second activation path.
- The server transaction that mutates Pending rows is the only writer of the current activation authorization. The current main-conversation Pending wire accepts `resumeWhenAvailable` as a mutation command, applies it atomically to the existing Session authorization, and never persists it as a second row-level desired state. Execution-run-targeted input cannot author this Session activation command.
- UI recovery and Agent/MCP/CLI callers share `session.pending.action.set` (`session pending action set` in the CLI). It updates the exact `sessionId`/`localId` through that existing PATCH owner, preserving `requestedAction` when explicitly rearming with `resumeWhenAvailable: true`. The Action uses the ordinary approval policy; managed wake still requires current Manage and its fire-time policy Ask. Reset holds retain their separate witnessed reset-start Action.
- Activation stays bound to its exact `requestId` and `requestedAt`. Publisher registration and keepalive prove process presence before Agent admission; they preserve the authorization so a later definite startup refusal can still settle it.
- The Pending activation hint is lossy notification only. The durable server-owned session authorization is authoritative, and the daemon consults it both after a live hint and during one finite reconnect scan.
- The daemon on the session's exact owning machine is the sole unattended starter for modern activation. It re-reads the session and exact Pending row, applies the existing external-session safeguards, and then uses the existing internal automatic-resume port. Retained `user_request` execution authorization identifies the original input; it is not fresh person Resume intent and cannot clear a person-Stop hold. On this unattended path, only the current Pending invocation, after those reads, can restore a Guard-stopped runner; a cached tuple in background spawn options is not current input demand. Both owning-Account and requester recovery retain that distinction, as does automatic Follow intake. The existing person/manager Resume path remains separate. A temporarily unavailable automatic launch leaves activation waiting rather than reporting a terminal startup failure. This mechanism does not take over an external or Direct session.
- Machine or daemon unreachability leaves the authorization waiting. A typed `broker_unavailable` launch refusal also preserves accepted input and activation while the guest or credential broker reconnects; direct UI wake and daemon recovery consume the same broker-failure classification. Existing reconnect, runner recovery and explicit Resume can continue that input without another enqueue. A genuine terminal start failure is recorded as failed and is not retried merely because a daemon reconnects. When the machine is reachable, explicit **Retry** uses the canonical manual resume action; while it is offline, **Process when online** re-arms the exact authorization. There is no periodic polling, unbounded retry loop, or exactly-once delivery guarantee.
- For an admitted managed wake, the failure writer ignores `runtime_start_failed` while compute is stopped, unknown, lost, or still reconciling a submitted native effect. The authorization and original input remain waiting for the managed policy owner. Its signed reports settle definite Ask or native failures with the managed-start failure codes; ordinary Agent-start failure can settle after compute is observed running.
- Once compute is observed present and running with no submitted native effect, the controller does not create another Start or Ask for the retained input. An incumbent native reconciliation keeps its existing lifetime until it settles.
- A failed managed-policy census read leaves an existing held invocation waiting. The next successful census can retire a withdrawn or replaced origin; runtime shutdown and explicit operation cancellation still retire it. Approval and native-effect admission revalidate current authority before any power effect.
- Claiming or resolving the exact Pending row, withdrawing it, or choosing **Keep queued** clears that exact authorization. **Auto-resume options** leads to the account preference for future sends.
- Modern delegation requires server Pending Input V2 support and activation capability from the session's exact target machine. Older or mixed components retain the existing direct-wake fallback rather than treating unattended daemon activation as available.

The durable banner derives the user-facing state from this ownership: waiting while the machine is offline, waiting while the daemon is reachable, queued without activation, or terminal start failure. Pending owns the payload and exact authorization settlement; the daemon owns unattended process start. A stale failure report cannot replace a later rearmed authorization.

In current development source, a terminal activation refusal also retains
`pendingActivationFailureDetails` on the Session read projection. Its closed
fields name the activation reason, spawn error code and retained-runner
serviceability reason when available. The exact failure CAS stores these facts
in the existing failure column; an ordinary runtime-start failure reports
`runtime_start_failed`. The daemon's existing rejection log carries the same
facts once the CAS succeeds. A stale report cannot replace newer activation
state, and the original Pending input remains in custody. Native error prose,
paths, credentials and input content are excluded. This is source behavior,
not evidence that an already-running daemon or server has loaded it.

The existing runner supervisor also settles a definite construction dependency
failure after the startup webhook. It accepts only a failure from that runner's
occurrence, the launch's exact activation stamp, and the current admitted Home,
Account, Session, Machine and installation. Cross-Account reporting uses the
Session requester's recovered credentials. `preparation_pending` and unavailable
plugin catalogs keep their existing recovery path; an optional MCP omission or
the broad `mcp_request_auth_unavailable` diagnostic alone is not a definite
startup refusal. A host continuation refusal (runner exit 78) reaches this same
failure reader before requester custody is released, even though it suppresses
automatic respawn. This observation also runs with
`HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED=false`; explicit Stop still suppresses it.
Only the same occurrence's failed primary Session issue and
exact activation stamp can settle the input. An unavailable Home observation or
stale target leaves it waiting. A generic Agent error without that terminal
runner evidence does not establish a continuation refusal. Runner failure logs
record the exit phase and shared code-only error projection.

Cold requester preparation records a failed phase's allowlisted error class,
code, HTTP status and source frames through the shared code-only diagnostic;
exception messages, response bodies and schema issue text remain private.
A known definite Session-read refusal can reach that same failure CAS only
after fresh requester recovery proves the exact Home, Account, Session,
Machine and installation, and the current authorization and Pending row still
match. The failed read itself grants no authority. Unavailable or cancelled
reads, persistently unreadable authority, changed admission and stale hints
leave activation waiting. The managed compute guard above still applies.
This is development source behavior and requires a daemon reload.

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

In 0.3 development, native team-member and broadcast recipients have no supported native input route. The send owner refuses them with `session_input_target_update_required` before Pending admission or inactive-session resume; it does not reinterpret them as main-conversation input. A retained `participant_message.v1` envelope reaching primary intake is likewise refused before batching or steer. Main input and the separately admitted exact execution-run route retain their existing contracts.

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

`reply: 'wait'` on a targeted send extends the existing Session wait coordinator above Pending; predecessor `wait: true` is an ingress spelling for that observation. It binds the admitted `(sessionId, runId, localId)` to the retained runtime's exact sidechain, turn, and occurrence evidence. Parent-Session idle, a sibling run's completion, and a generic or terminal run status never complete it, and it does not call `execution.run.wait`. A timeout stops only the observation — it does not cancel, discard, or replay the admitted input.

`SessionInputAdmissionResultV1` reports the outcome as `accepted`, `alreadyAccepted`, `rejected` with a `SESSION_INPUT_ADMISSION_REJECTION_CODES_V1` code, or `outcomeUnknown`. `outcomeUnknown` retains its `localId` together with a bounded admission code so the caller can reconcile the exact input through the ordinary retry identity; nothing collapses it into a codeless failure, and no wait table, receipt ledger, or per-run completion counter is added.

Recovery after activation uses ordinary Pending state. A failed or uncertain target delivery is observed and retried through the same queued/blocked lifecycle and `localId` identity as main-conversation input; there is no rollback ledger, dual writer, or compatibility mirror for target rows.

The authenticated author and admission receipt survive target preparation and acceptance. Machine-authored input retains its null Account author, including when explicitly sent as new. Editing content or changing the requested action clears prior equality evidence so a later admission cannot reuse evidence for a different request.

In 0.3 development source, direct materialization and socket delivery preserve the
validated `inputAdmissionReceipt` through canonical and legacy message bodies.
The host queue consumes that original receipt, not reconstructed display facts.
Required Follow originals use the [runtime preparation recovery](runtime-core.md)
path for transient Home source reads, retaining their exact Pending identity;
definitive refusals keep the existing terminal settlement.

Configured Execution Run and Workflow Run Follow inputs retain their exact
terminal occurrence id or Workflow revision in that receipt. The existing
destination observation returns an `admitted_run_input`, rather than inventing
a parent Session frontier. The host rechecks that custody before rendering a
Run-result reference at provider dispatch. Wake originals start a turn; quiet
originals join the next real input. Neither executes the stored notice text as
a command. The same provider-acceptance owner settles the exact Run cursor;
the Follow ACK names that original and cannot advance it before native input
acceptance. Replays reuse the admitted input identity, not a new Pending path.

These are development contracts. Target support must be negotiated independently of the existing Queue V2 support; older main-conversation clients continue using the null-target path.

## Human authorship in development

The authenticated input-admission receipt records who submitted an accepted human input. Pending admission derives it from the final transaction-scoped Session access decision. Direct authenticated input uses the same admission builder; runtime observations and transcript-only Voice writes do not become human-authored merely because their message role is `user`.

`SessionPendingMessage.authorAccountId` and `SessionMessage.authorAccountId` are nullable relational projections of that receipt. The committed projection supports historical-contribution filtering before Session pagination. It does not grant access, assign responsibility, create a participant roster, or enroll anyone for notifications. Pending materialization and provider-anchor rejoin retain the original receipt and refuse a conflicting non-null author projection. Deleting an Account clears its foreign-key projection while preserving the immutable receipt.

Authenticated page, Pending, and realtime projections use the same Account display-profile leaf. A historical author need not retain current access for another authorized reader to see the byline. A deleted Account has a null profile; missing or invalid admission evidence has no Account attribution. Public/external transcript projections keep their separate coarse actor contract and do not disclose this Account identity or profile. The additive wire field distinguishes an omitted `accountActor` from an explicit null: an older producer's omission preserves previously known metadata, while a current null retracts it.

After deploying the current writers and the nullable-column migration, run the provider-neutral backfill against the explicitly selected database from `apps/server`:

```sh
HAPPIER_DB_PROVIDER=sqlite DATABASE_URL='file:/absolute/path/to/happier-server-light.sqlite' pnpm run session-message-author:backfill
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

## Managed forwarding wake (0.3 development)

Finite CLI/agent Machine forwarding declares runtime demand to the shared
reviewed wake owner and waits for the enrolled guest before dispatching the
original work. Forwarded Send retains accepted-input activation: enqueue and
ACK precede wake. Passive list/get operations do not request power. See
[Managed runtime demand](actions.md#managed-runtime-demand-03-development).
