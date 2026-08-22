# Same-Session Agent transition

One Happier Session keeps its identity and transcript while the Agent running it is replaced. The
product name is **Continue with another Agent**; the machine RPC is `session.agentTransition`.

> **Release status.** Unreleased. This exists in the current development source of `dev` and
> `remote-dev` and has **not** passed an integrated live gate. Do not describe it as available in a
> stable or preview build. Execution ledger and gate standing:
> `.project/plans/2026-08-15-same-session-cross-agent-continuation/PLAN.md` §12.4/§12.5; QA state:
> the sibling `QA-MATRIX.md`.

## What it is, and what it is not

A transition is a **planned restart of the existing Session runtime with a different committed Agent
descriptor**. It is not a Thread, a segment, a handoff saga, a second queue, a publisher-fencing
project, or a new Session-creation subsystem.

Adjacent concepts with their own owners:

| Concept | Changes | Owner |
|---|---|---|
| Agent transition | the Agent, in place | this page |
| Session fork / replay | creates a child Session | `apps/cli/src/session/actions/lifecycle/fork/**` |
| Session handoff | the owning Machine | `apps/cli/src/session/handoff/**` |
| Model selection | the model on the current Agent | `docs/providers.md` |

## Wire contract

`packages/protocol/src/sessions/agentTransition.ts` is the single owner. Methods are declared in
`packages/protocol/src/rpc/methods.ts`: `session.agentTransition` and
`session.continuation.inspect`.

The request is strict: `{ v: 1, sessionId, expectedCurrentAgentId, selection, input }`. `selection`
carries `agentId` plus optional `modelId`, `providerConnectionId`, `acpSessionModeId` and
`sessionConfigOptionOverrides`, and a `superRefine` requires `modelId` whenever
`providerConnectionId` is set. `input` extends the ordinary user-message send request with a
**required** `localId` — the caller's message is part of the operation, not a follow-up.

The result union discriminates on `type` and has four arms:

| Arm | Shape | Meaning |
|---|---|---|
| `accepted` | `{ localId }` | Cutover committed, divider appended, input admitted. |
| `rejected` | `{ code, sourceEffect: 'none' }` | Nothing happened. Codes: `unsupported_operation`, `forbidden`, `same_target`, `stale_selection`, `target_unavailable`, `source_not_idle`, `source_stop_failed`. |
| `partially_applied` | `{ localId, applied, code }` | A definite partial effect. `applied: 'source_stopped'` (source confirmed stopped, nothing committed; codes `context_unavailable`, `cutover_conflict`) or `applied: 'current_view_committed'` (the Session **is** the target; codes `divider_missing`, `divider_conflict`, `divider_unknown`, `target_start_failed`, `input_admission_failed`, `input_rejected`). |
| `outcome_unknown` | `{ localId }` | Genuinely indeterminate. Deliberately carries **no code**. |

`rejected`'s `sourceEffect: 'none'` is a promise, not decoration. Anything that could have touched
the source must not use this arm. `reconciliation_required` was removed as a wire code.

Arm construction is type-gated rather than conventional:
`packages/protocol/src/sessions/agentTransitionEffectStage.ts` exposes an effect-stage ledger
(`SourceUntouched` → `SourceFenced` → `SourceStopped` → `CurrentViewCommitted`) entered through
`beginSessionAgentTransitionEffects`. A handle only offers the arms its stage can truthfully make, so
a `rejected('...')` after a stop is not expressible. `rejectUndispatchedSessionAgentTransition` is
the one escape, for transport failures where the request provably never left the client.

Inspection returns `{ type: 'available', protocolVersion, sameSessionTransition }` or
`{ type: 'unavailable', reason }`. `sameSessionTransition` is the only field. A `nativeReturn`
diagnostic was removed under `AM-24`: it had zero readers on every released channel and cost a
protected-file read plus a `stat()` per offered target on every picker open.

## The transition divider

`packages/protocol/src/sessions/agentTransitionDivider.ts` owns the whole shape.

- Reserved localId prefix `agent-transition:`; the divider's id is
  `agent-transition:<submittedLocalId>`, which makes the operation idempotent by construction.
- Sidecar key `sessionAgentTransitionV1`, strict
  `{ v: 1, fromAgentId, toAgentId, sourceCutoffSeqInclusive }`.
- `sourceCutoffSeqInclusive` is **required**. It is the transcript-visible input to the bounded
  context pass that outlives the cutover — `replaySeedV1.seedText` is blanked the instant the target
  accepts it — so a divider without it could never explain its own boundary. Native return keeps its
  separate device-local `departureSeqInclusive` lower bound. `0` is a recorded "nothing was carried
  over", not an absence. A sidecar that omits the field fails the strict parse, so the row is not a
  divider at all and degrades to its stored prose through the same path an older reader takes; the
  only writer that ever produced that shape is an unreleased intermediate build of this feature.
- The row rides the **shipped** `type: 'message'` agent-event passthrough arm. No new
  `AgentEventSchema` variant was added, so old readers decode it as an ordinary informational event.
- `readSessionAgentTransitionDividerV1` is the single reader, and it requires **both** halves of the
  divider's identity: the reserved outer `localId` and a strictly valid sidecar. The sidecar alone is
  not proof — its key name is writable by anyone who can post an agent event, so a sidecar-only
  reader would let an authorized session writer silence their own row and manufacture an attribution
  boundary the transition never made. The reserved prefix is what makes the answer trustworthy,
  because every generic ingress refuses it (below). Nothing re-parses the shape.
- `readSessionAgentTransitionDividerFromStoredRecordV1` layers the record-wrapper checks
  (`role: 'agent'`, `content.type: 'event'`) on top of that same reader; it is not a second reader.
- Rendered by `apps/ui/sources/components/sessions/transcript/agentTransition/AgentTransitionDividerRow.tsx`
  through `TranscriptSeparatorRow`, not through the generic event arm.

### The reserved prefix is an ingress boundary

Only the transition owner may write a reserved-prefix localId. Guards are in place at every writer
that can reach the transcript — observed in `apps/server/sources` at
`app/api/routes/session/registerSessionMessageRoutes.ts`, `app/api/socket/sessionUpdateHandler.ts`
(two sites), `app/session/pending/pendingMessageService.ts`,
`app/api/routes/session/pendingRoutes.ts`, and `app/session/sessionTranscriptWrite.ts`.

The last of those was a reproduced defect (`AM-19`): a `sessionShare`
collaborator at `edit` level forged a reserved localId through `/transcript/import` and received
HTTP 200 in both plaintext and E2EE, which would have let a non-owner permanently deny continuation
on any Session they can edit. The fix lives at the canonical historical-batch writer
`sessionTranscriptWrite.ts`, not at its HTTP adapter, because that writer has two callers.

**Enumerate reserved-prefix ingresses by writer, not by route.**

## Cutover: two transactions, on purpose

`apps/server/sources/app/session/agentTransition/applySessionAgentTransitionCutover.ts` is the
server owner. It does two things in sequence, not one:

1. `commitSessionAgentCurrentView` — one narrow transaction: owner access, `archivedAt = null`,
   `active = false`, metadata and version CAS, and clearing the current runtime-activity and
   source-runtime-request projections.
2. the divider, appended through the canonical message owner `createSessionMessage` as an ordered
   idempotent write.

The split is deliberate and must not be "fixed" by writing the divider inside the transaction.
`writeSessionTranscriptMessageInTx` already exists with two in-transaction callers, so the argument
is **not** that atomicity would need a new extraction. The argument is that a raw in-transaction
write bypasses eight behaviours `createSessionMessage` performs, all verified exercised: session
edit access, stored-content admission for the Account's encryption mode, hosted write authority,
message-role resolution, the activity/ready projection, participant change cursors, the read-cursor
advance and badge accounting that keep the divider from minting a phantom unread, and the
publication inputs the route emits — plus non-trusted localId reconciliation.

**Publisher fencing is not among them.** Fencing runs only on the trusted-provenance path, which
this write cannot use: it compares against a *current* Session publisher, and the source publisher is
gone by the time the cutover runs. Anyone re-defending the split argues those eight, never fencing.

A divider failure after a committed view is a real partial state and is reported as such:
`divider-conflict` → `partially_applied / current_view_committed / divider_conflict`, while
`divider-rejected` and `internal` both → `divider_missing`.

Idempotency survives because the message owner catches the `(sessionId, localId)` unique violation
and reconciles on the non-trusted path too — **overwriting on differing content**. That is precisely
why the service pre-checks rather than letting the constraint protect it.

## `attentionImpact` is derived, never persisted

`SessionMessage` has no `attentionImpact` column and no migration creates one. Every read re-derives
it from content, so a write-time "this row is quiet" value could never have worked.

The decision lands once, at the shared protocol owner `agentEventAttentionImpact(event, localId)`
(`packages/protocol/src/sessions/messages/transcriptRawRecordV1.ts`): a row whose
`readSessionAgentTransitionDividerV1` succeeds resolves to
`SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT`. Both re-read resolvers delegate there —
`resolveMessageAttentionImpact` on the server
(`apps/server/sources/app/session/messageAttentionImpact.ts`) and the client resolvers in
`apps/ui/sources/sync/domains/messages/messageUserAttention.ts`.

Three properties are load-bearing:

- `localId` is a **required** parameter, so the compiler proves every re-read supplies it. The
  exemption needs the reserved localId as well as the sidecar; without it, any authorized session
  writer could silence their own message by adding the sidecar key.
- the exemption is conditioned on a **valid** strict sidecar, not on `type === 'message'`. Adding
  `message` to the type-keyed no-attention set would silence every passthrough event.
- a malformed or wrong-version sidecar is **not** silenced. It stays attention-bearing.

The deciding test is client-side, over the canonical unread/meaningful-activity fold. A server-only
assertion passes while the product regresses.

## Historical Agent attribution

Owner: `apps/ui/sources/components/sessions/transcript/attribution/sessionTranscriptAgentAttribution.ts`.

`buildSessionTranscriptAgentAttributionIndex` walks the transcript once, collecting divider
boundaries through the single protocol reader. `resolveHistoricalAgentIdAtSeq` places a row strictly
after a divider with its `toAgentId` and a row at or before the earliest divider with that divider's
`fromAgentId`. Everything else returns `null`.

`null` means **keep the live answer**, not "render nothing" — every consumer falls back to its
existing live-metadata resolution, so an unswitched Session behaves exactly as before. The
no-divider index is a shared frozen empty object so an unswitched transcript never invalidates a memo.

**No per-turn Agent evidence is read** (`AM-17`). A turn-based tier was rejected on data, not taste:
`dev` persists `turn.agentId` server-side but has no hydrated client read (no `sessionTurns` field on
`Session`; the live-socket and warm-cache paths carry only `rollbackEligibleTurnStarts`), so a
turn-based resolver would attribute correctly after a cold fetch and then silently degrade to neutral
after any live update. `remote-dev`'s `SessionTurnV1` has no `agentId` field at all.

**The one documented bound:** divider-boundary attribution is exact for every row written in the
ordinary flow, but a source row the canonical writers accept *after* the divider sequence — the
stop/cutover race — falls on the target's side and is attributed to the **target**. That is an
accepted approximation recorded at the resolver and pinned by a fixture that deliberately places such
a row in `targetAgentSeqs`. Do not rediscover it as a defect or answer it by rebuilding attribution.

## Runtime flow and its ordering rules

`apps/cli/src/session/agentTransition/sessionAgentTransitionCoordinator.ts` owns the daemon-side
sequence.

**The Session's recorded machine is NOT a gate.** Neither the mutation nor the inspection refuses a
Session because its recorded `machineId` names another machine, and that removal was deliberate. A
machine id is only a PROXY for "can this Session be continued here", and every failure the gate
claimed to prevent is already detected by the component that actually knows: `requestSessionStop`
finds no local process for a Session that is not here and reports it, the per-Agent native-return
record is DEVICE-LOCAL so its absence already degrades to a full replay, the cutover is server-side
and machine-agnostic, and activating the target on this host succeeds or fails loudly. The proxy was
wrong in both directions — it refused a user who had legitimately moved a Session to this host, while
still admitting a same-id Session whose vendor conversation had been deleted — so it removed real
capability to prevent nothing, and it cost one Account-scoped machine-replacement read per inspected
target.

The user's machine-replacement ruling — replacing a machine must not strand the Sessions the previous
one hosted — therefore holds **by construction** in this path: nothing here can refuse a replaced
machine. Session rows are never re-homed, so a recorded host stays the predecessor forever, and that
no longer matters.

The inactive goal, catalog and usage-limit controls keep their own locality gate
(`resolveMachineControlLocalityProof`, `apps/cli/src/session/machineControlLocality.ts`). That is a
different question: those controls read and write the Session's WORKSPACE FILESYSTEM and vendor
config, so a daemon that is not the host would answer from its own filesystem — silently and
plausibly wrong — rather than fail loudly.

A not-here Session reaches the stop and comes back `not_found`. Since `AM-27` that is no longer
`outcome_unknown`: the stop owner classifies it, and when the canonical Session row is observed
inactive it reports the confirmed `already_stopped` arm, so the transition proceeds normally. The
fix is at the stop owner, not a machine guess in the coordinator.

1. **Preflight, no source effect.** Transport resolve, session match, not archived, owner-metadata
   decrypt (failure is `forbidden`), external/linked-session exclusion,
   already-target reconciliation, currentness (`stale_selection`), target catalog and model
   resolution (`target_unavailable`), idle wait (`source_not_idle`).
2. **Quiesce and stop.** The input fence is taken *before* the request, so every pre-stop exit
   reopens it. Then `requestSessionStop`.
3. **Context.** Native eligibility is resolved before the brief; the bounded activation brief is
   built; `unavailable` is `partially_applied / source_stopped / context_unavailable`. An empty
   source is `available` with a `null` seed — collapsing it into `unavailable` stopped a fresh
   Session and then failed the transition.
4. **Cutover.** Seal the target current view, call the server owner, retry a `version-mismatch`
   exactly once by refetch-and-rebuild; a second loss is `cutover_conflict`.
5. **Custody, then activation.**

### "Confirmed stop" has an exact meaning

Confirmed is `isSessionStopConfirmed(stop)`, the predicate exported beside `SessionStopResult`. The
coordinator never reads `stop.stopped` or a status string itself: liveness is one fact with one
owner, and the transition consumes that owner's answer. Nothing on the target side happens before it
is true. Four mappings, and the second one is the easy mistake:

- resolution failed before any stop attempt (`session_not_found`, `session_id_ambiguous`,
  `session_lookup_timeout`, `unsupported`) → `rejected('source_stop_failed')`. Nothing was touched.
- **unconfirmed** (`physical_stop_unconfirmed`, `stopped_projection_unconfirmed`,
  `stopped_cleanup_incomplete`) → `outcome_unknown`. The source may already be gone, so
  `rejected`'s `sourceEffect: 'none'` would be a false promise, and `partially_applied` would be
  equally untruthful because no cutover occurred.
- **confirmed** — `stopped: true`, or `already_stopped`. Both mean the canonical Session row was
  observed inactive: the first after signalling a runtime, the second after finding none to signal.
  A cold Session is stopped, and treating "no runtime exists" as "could not determine" is what made
  it permanently untransitionable (`AM-27`).
- thrown or `null` → `outcome_unknown`.

The unconfirmed cases are derived from `SessionStopOutcomeSchema` and filtered through
`isSessionStopConfirmed` rather than listed, so a new outcome cannot silently fall into the wrong
arm in either direction.

### Custody precedes activation

`AM-13`: input custody is taken immediately **after** cutover and **before** target activation.
`sendSessionMessage`'s invariant is enqueue-then-resume, so activating a runtime with no durable
Pending row behind it creates unrecoverable work if anything fails in that window.

This is not the removed held carrier. The carrier was cut because a durable row existing *before*
cutover could be claimed by the source; after cutover the source is terminal and the Session already
is the target, so only the target can claim it. The daemon holds the input snapshot only from RPC
receipt to post-cutover enqueue.

Admission goes through the ordinary owner in both trees — `sendSessionMessage` with
`resumeInactiveSession: false`, so custody lands before the runtime starts. The trees differ in
shape, not behaviour: `remote-dev` extracted `apps/cli/src/session/services/admitSessionUserMessage.ts`,
while `dev` calls the same owner through the coordinator-local `admitExactInput`. Neither is a second
admission decision-maker, and neither tree should grow one.

## State disposition

The transition calls `projectCurrentAgentSessionView` with `agentScopedCurrentState: 'clear'`. The
projector, its `carry` / `clear` policy, and the one-flat-vendor-key rule are documented in
`agents-catalog.md#session-current-agent-identity-one-flat-vendor-key`; do not restate the key list
here or in a third place.

Two dispositions are easy to get wrong and are worth naming:

- **Permission intent carries.** It is Session-global Happier safety intent, not Agent state. A
  transition must never quietly loosen it.
- **Archive state is untouched.** It is user intent. The source stop must leave the Session inactive
  and resumable, which is why archive-on-termination was removed at the termination-archive owner
  rather than suppressed locally (`AM-1`).

- **Work state is captured before it is cleared.** `sessionWorkStateV1` has two clauses in §8, and
  they belong to different owners. The coordinator's brief builder is the last reader of the source
  view before the cutover, so it reads the snapshot through `readSessionWorkStateV1FromMetadata`
  (`readDisplayableSessionWorkStateV1` in `remote-dev`) and hands it to the replay owner as
  `workState`; the projector then drops the field. The items are a structured projection rather than
  transcript prose, so without the capture the in-flight plan is deleted at the cutover and the
  target continues the same Session unaware of it. This was half implemented — clear only — until
  2026-08-17 (`F-10`).

  Because the projector clears the field and the arriving Agent republishes into the same durable
  key, the capture is only possible from the departing Agent's own current view. The brief owner
  therefore takes that view as an explicit `departingAgentCurrentView` input — separate from the
  Session-global metadata it also reads — and reads the work-state snapshot and the departing
  Agent's native log path from nowhere else. The read-only rebuild behind the transcript card
  (`session.agentTransition.briefPreview`) passes `null`, because after the fact those keys hold the
  CURRENT Agent's live values and nothing per-boundary distinguishes them: the divider records only
  the cutoff and the Agent pair. Both components are therefore OMITTED from a rebuild rather than
  approximated, and the card's own reconstruction notice states the omission.

## Context handed to the target

The brief is built by the existing replay owner: `resolveReplaySeedDraft` →
`buildHappierReplayPromptFromDialog`, with `kind: 'same_session_agent_change'` and strategy
`recent_messages`. `summary_plus_recent` is deliberately excluded — it would start an LLM summary run
in a window where the source is already stopped and the user is waiting.

One true total cap: `configuration.replaySeedMaxChars`, from `HAPPIER_REPLAY_MAX_SEED_CHARS`
(default 120 000, bounded 1 024–200 000). No local maximum competes with it. The seed's own framing is
subtracted from the cap, and the Happier Session-reference block appended at dispatch is reserved
inside the **same** total by `fitHappierReplaySeedWithinTotalBudget` — the block is never truncated,
the transcript tail gives way, and an empty fit leaves the seed unsettled for the next dispatch.
Unlike fork, the transition does not honour a per-request `maxSeedChars` override.

That total is counted in **UTF-16 code units**, and `packages/agents/.../happierReplayPrompt.ts` owns
the unit: every length it measures and every slice it takes is `String.prototype.length`. The
reservation `HAPPIER_REPLAY_SEED_DISPATCH_RESERVED_CHARS` is therefore equal to the reference block's
bound only because the block's renderer enforces that bound in the same unit. The mention domain
around it counts code points, so this is the one place the two meet: bounded in code points, a
Session titled with emoji could render a block inside its own bound that still cost up to twice what
was reserved, and the refit below — designed to be a no-op — would delete transcript the seed was
entitled to. UTF-16 length dominates code-point length, so the stricter unit satisfies both
contracts; `sessionReferenceBlock.test.ts` asserts the rendered block against the constant so the two
packages cannot drift apart silently.

That refit can still genuinely bite, and after the unit was settled that is the ONLY way it does: the
seed is built against the budget of whichever ingress sealed it and fitted against the dispatching
daemon's. A fork or UI `maxSeedChars` may be larger than this daemon's `replaySeedMaxChars`, and
because a sealed seed retires only on provider acceptance it also outlives a daemon restart — so an
operator who lowers `HAPPIER_REPLAY_MAX_SEED_CHARS` makes the next dispatch of an already-sealed seed
give way to the new, smaller total. That is the guard working rather than a defect: obeying the cap
in force at dispatch is the point of the cap, and pinning the sealing-time value would let a stale or
larger per-request budget defeat the limit the operator set. No reservation can pre-empt it either —
the sealing daemon cannot reserve against a cap that does not exist yet.

Keeping the frame whole while deleting the rows it names would tell the target Agent it already holds
messages that were dropped on the way out, and it would page *before* them — skipping them for good.
**So the frame makes no claim about the body.** The `More history:` block keeps only what no deletion
can falsify: which Session holds the transcript, and where the source Agent's native log is. The
range-bearing lines — `Already inlined below: … seq A to B.`, the paging anchor, the rendered cursor,
and the re-request note — are emitted at the **head of the `Recent transcript:` region**, above every
line they name. Both truncators keep a *suffix* of that region and drop oldest-first, so the claim
survives only when every row it names survived, and is deleted with them otherwise. Degrading to no
claim is the safe direction: the target no longer knows what it already holds, so it re-reads a tail
it has — costing tokens, stating nothing false. Reconciling the two after the fact was attempted
twice and is not the mechanism; the second attempt restated the claim onto "the newest inlined seq",
a row the sealed text cannot prove is still present.

Placement alone is not the guarantee, because placement only constrains the *fit*. The claim is also
**verified at render time**, immediately before it is emitted: every row the span names must be
present in the lines below it, **whole** and in order, each matched by its entire rendered line. The
rows it checks are not only the ones the span *names*. The target pages **backwards** from the span's
oldest end, so every row of the pointer's own Session at or above that cursor is one paging can never
reach — including a row lying *above* the span, which the span names nothing of — and it must be
present below on the same terms. Rows below the cursor are exempt, because paging reaches them — but a
row whose `seq` the retrieval never knew is exempt from nothing, because nothing places it relative to
the cursor at all; it has to be present below whatever the span says, and when it is not, the span is
refused even though every numbered row it names is there. Each row is also matched only against the
lines of **its own seq space**: two Sessions can render byte-identical turns, and a foreign copy
standing in for a dropped own row is the same permanent skip. If any is missing or clipped, the claim
is not emitted and the pointer degrades to the no-range
wording — `None of that transcript is inlined below.` plus a cursor that starts at the newest
message. This is what closes the builder's own clip: when the newest turn alone overflows the region
the builder keeps a marked fragment of its TEXT and still counts the row kept, so the span would
otherwise name a message the seed truncated, and the target would decline to re-fetch it. The check
is deliberately indifferent to *which* step clipped, so a future step that clips cannot reopen this.
It cannot see what it is not given: rows the bounded retrieval never fetched are outside the span by
construction, and the dispatch-time refit runs after the seed is sealed — there the suffix rule above
is the mechanism, and it holds because the claim block survives the refit only when the body was not
trimmed at all.

The three range-bearing **openings** are reserved scaffold markers in their own right —
`Already inlined below:`, `To read older context, page BACKWARDS from seq `, and `Requesting seq ` —
and untrusted content the **frame** renders containing one is defanged exactly as `Recent transcript:`
is. The reservation is charged by SLOT, not by position. A replayed turn always carries its `User: ` /
`Assistant: ` label and so cannot open a line — a reserved sentence inside one is prose, and it is
delivered byte-identical, because mangling real context to prevent nothing costs as much as the
forgery would. The summary and the pinned last user instruction are rendered **unlabelled**, one
escaped line each, and both are transcript-derived: without the reservation either block can *be* a
range claim the target Agent cannot tell from the framer's own. The Session title and the work items
sit behind their own prefixes and could not open a line either, but they are defanged as well, because
they render *before* the transcript marker and the dispatch-time split finds that marker by scanning
the seed rather than by matching a line. All three openings are reserved because they carry the same
statement in three grammars — the span, the cursor that moves onto it, and the note that its text is
already inlined.

Three consequences worth knowing. The span scan starts at the **newest** row and stops at the first
row that *declares* another Session; if any row it reaches is unnumbered, or does not ascend with its
turns, the window claims **no range at all**. Rows above that declared break are never examined by the
scan, so `[own@5, own@3, parent@9, own@40, own@41]` claims `40 to 41` — only `40, 41` are scanned, and
the render-time check above is what covers what lies above the break. And a fork chain, which concatenates rows from more than one Session — each with its
own seq space, and able to ascend straight across the join — claims only the **newest unbroken run of
rows in the Session the retrieval pointer names**, because one `A to B` span over two spaces promises
rows the seed never carried. A row says which space its `seq` belongs to; undeclared reads as the
pointer's own, which is the window every single-Session retrieval builds. And a seed sealed
by the *predecessor* layout, which put the claim in the frame, has that claim **removed** rather than
rewritten when the refit deletes rows; the native-log line survives, because it states nothing about
which rows are inlined.

The departing Agent's work state is a segment of that same total, rendered by the seed builder as a
`Work state:` block ahead of `Recent transcript:` — one escaped line per item carrying only kind,
status and title. It is bounded to a quarter of the cap so it cannot starve the tail, drops whole
lines with a marked omission when it does not fit, and lives in the frame, so the dispatch-time fit
keeps it while transcript lines give way. `Work state:` is a reserved scaffold marker: frame-rendered
untrusted content that contains it is defanged like `Recent transcript:` and `Summary:`.

The seed retires on provider **acceptance**, not composition, so a rejected or cancelled first
dispatch does not lose the context.

## Feature gate

`sessions.agentSwitching`, server-represented, `defaultFailMode: 'fail_closed'`, depends on
`sessions`. Catalog: `packages/protocol/src/features/catalog.ts`.

The server producer is `resolveSessionAgentSwitchingFeature`
(`apps/server/sources/app/features/sessionAgentSwitchingFeature.ts`), registered in
`serverFeatureRegistry.ts`, reading
`parseBooleanEnv(env[FEATURE_ENV_KEYS.sessionsAgentSwitchingEnabled], true)` —
**enabled by default**, with `HAPPIER_FEATURE_SESSIONS_AGENT_SWITCHING__ENABLED` as an operator
opt-out. The registry is resolved at process start, so a change needs a server restart.

Default-on and fail-closed are orthogonal and both correct here: a server that answers advertises
`true`; a missing or malformed bit resolves to the disabled default on the client
(`DEFAULT_GATE_DISABLED`). `sessions.folders` has the same combination.

**Authority is the server's.** The bit travels by the ordinary server-feature propagation every
other server-represented feature uses, so an operator who disables it on a server disables the
feature for the clients and Accounts of that server. There is no user toggle by design
(`settingsToggle: undefined` in the UI feature registry) and no per-Account switch.

**Enforcement reach.** The gate is enforced at the server boundary, not only at the client call
site. `registerSessionAgentTransitionRoute` carries
`createServerFeatureGatePreHandler('sessions.agentSwitching')` — the same shared gate every other
server-represented route uses — so a server whose owner sets the opt-out answers the cutover with
`404 { error: 'not_found' }` and the lifecycle mutation never runs. The cutover route is the only
place the switch becomes durable, so that one gate is sufficient to refuse the operation; the UI
still hides the surface from the same propagated bit, and a direct non-UI caller is refused rather
than served.

The daemon should still evaluate the feature decision **before it stops the source Agent**, so a
disabled server produces a clean refusal instead of a stopped source and a refused cutover. That is
a caller-side preflight over the same server bit, not a second decision-maker: the route remains the
authority.

This gate previously had **no producer at all**, so `readServerEnabledBit(...)` returned `false` in
every deployment, permanently, and the in-session rail never rendered. Registering an id in the
catalog is not enough — a server-represented gate needs a resolver in the server registry.

## Device-local native return

Returning to an Agent used earlier in the same Session resumes that Agent's own native session
instead of starting fresh, and the replay it is handed carries only what happened while it was away.

`AgentNativeResumeIdentityV1` is `{ v: 1, vendorResumeId }` — the Agent's own conversation id, in its
catalog's terms, and nothing else. There is deliberately **no continuity proof and no pre-check on
the recorded id** (`AM-24`): a dead id fails LOUDLY at the first turn — Claude raises
`ClaudeAgentSdkResumeIdentityMismatchError` and Codex's `thread/resume` throws with no fresh-start
fallback — so there was never a silent-zero-context path for a gate to prevent, and the gate was a
second decision-maker for a question the ordinary resume path already answers. It was never general
either: 15 Agents declare vendor resume and exactly one declared a proof field, so the canonical
Codex→Claude→Codex round trip had no gate at all. Whether a recorded id may be resumed **at all** is
still delegated to `evaluateVendorResumeEligibility` against the same projected target view the
cutover commits — that owner carries the launch-mode and account-enablement rules, which are not
proof. It is consulted on the RETURN only: those rules are transient and reversible, so they may
decide what this machine will launch now and must never decide what the departing Agent left behind.

Separately and still live: the Agent's own **session-log path**. It is catalog-declared (Claude's
`resume` config names `claudeTranscriptPath`) and published into Session metadata by the Agent's
runtime alongside the id whose conversation it names. It is a POINTER the handoff brief offers the
successor Agent so it can read what the predecessor wrote — existence-checked before it is printed,
because Agents prune and rotate logs — and it gates nothing. The declaration's key name is
predecessor vocabulary awaiting a generated-projection rename; see `AgentResumeConfig`.

Two dedupe owners for one concept caused the id/path pair to be dead on arrival once:
`agentSessionTurnInvariant` deduped `provider-session-id` on the **id alone** and dropped Claude's
same-id republish carrying the path before the pair-aware subscriber ran. Both owners now dedupe on
the pair. It is proven for the SDK launch mode only and has no live evidence.

### The delta boundary

The record also carries `departureSeqInclusive`: the transcript head the Agent had already seen when
it left (`AM-26`). On a native return the coordinator hands that bound to the brief, which threads it
to `hydrateReplayDialogFromForkChain` as `afterSeqExclusive` and on to
`fetchEncryptedTranscriptMessagesPage({ afterSeq })` — a **server-side** bound, so the walk neither
pages history it will discard nor spends its request ceiling on it. Reaching the bound is natural
termination: `reachedSourceStart` stays `true`, because a seed that reported it as a truncation would
tell the returning Agent that history is missing when nothing is.

The head is captured **before** the source stop, not after. The two numbers differ, and the asymmetry
decides which one is safe: a row that lands between the pre-stop instant and the confirmed stop may
never have reached the departing Agent, so an over-estimated boundary skips it PERMANENTLY, while an
under-estimate costs one re-replayed turn. The divider's `sourceCutoffSeqInclusive` is the post-stop
head and is deliberately a different number.

Starving a FRESH target is structurally impossible rather than merely avoided: the bound can only
come from that Agent's own departure record, and a target that never ran in this Session has none.

**The boundary only advances on accepted context (`REQ-STATE-03`).** The capture is still taken
before the stop, but it is no longer unconditional. It reads the activation seed slot the cutover
itself wrote: an activation brief is blanked and stamped `appliedToLocalId` the instant the provider
takes custody of the prompt it was prefixed to, so an unretired seed is the durable statement that
the departing Agent was handed context and never accepted it. Three outcomes follow, at
`captureDepartingAgentNativeResumeRecord`:

- **no structurally valid identity** — any earlier record is removed, as before;
- **the handed context was accepted, or none was handed** — the boundary advances to the pre-stop
  head;
- **context was handed and never accepted** — the boundary does **not** advance, so a later return
  cannot inherit a bound the Agent never reached. If the identity still in the view is the one this
  machine restored from the record, that strict native return also failed before acceptance, and the
  identity is invalidated instead of being re-offered unchanged on the next switch.

Acceptance is read, never re-derived: seed settlement and the cutoff advance share one fact through
`isReplaySeedV1PendingProviderAcceptance`. No proof file, liveness probe, read-back, TTL, generation
or sweep was added (`AM-24`). Covered by `QA-T-20`.

**Launch policy is a RETURN decision.** The capture records a structurally valid identity regardless
of Account settings; whether this machine may resume it is decided on the way back, by the same
`evaluateVendorResumeEligibility` owner the ordinary inactive-resume path consults. Evaluating it at
capture wrote `identity: null` for an Agent the user had temporarily disabled — deleting the only
copy of that continuity, which re-enabling the Agent could not recover.

`remote-dev` carries the same record and the same delta boundary, written byte-identically so one
machine's `~/.happier` round-trips between the two CLIs.

### The machine-local record

Store: `apps/cli/src/session/handoff/metadata/localSessionHandoffMetadataStore.ts`.

- Path `<activeServerDir>/session-handoff/agent-native-resume/<sha256(domain\0sessionId\0agentId)>.json`,
  domain-separated with `happier.local-agent-native-resume.v1`. Filenames carry no Session or Agent
  id; the plaintext keys inside are re-verified against the request.
- Written through `writeProtectedLocalStateFileAtomic` — directories `0700`, files `0600`, forbidden
  bits `0077`, tmp+rename, corrupt → `null` (fresh start, never a silent replace). The write reports
  nothing back: every read `safeParse`s, so a partial file already reads as absent, and both callers
  of the previous boolean discarded it (`AM-24`).
- Never uploaded, never Account material, not portable to another device — a vendor session belongs
  to the machine that ran it, so an id recorded here cannot be resumed anywhere else. That is scope,
  not secrecy (`REQ-PRIVACY-01`, narrowed by `AM-25`).
- Keys: exactly `v`, `happierSessionId`, `agentId`, `vendorResumeId`, `departureSeqInclusive`. The
  schema is `.strict()` and the seq is REQUIRED, so no predecessor-shaped record parses; that
  degrades one switch per (Session, Agent) to a fresh target plus the FULL replay and self-heals on
  the next departure.
- NOT discarded after the target starts (`AM-24`): a discard was not observable, and it was not GC
  either since nothing sweeps the directory. What makes that safe is that the id and the bound are
  written by the SAME departure, so a failed capture leaves both halves stale together and the replay
  bound is stale-LOW — a stale record OVER-covers and can never skip history.

## Compatibility

**New client against an old daemon.** `session.agentTransition` is rejected with
`RPC_ERROR_CODES.METHOD_NOT_AVAILABLE`, which the client op maps to the operation-scoped arm
`rejected('unsupported_operation')` with `sourceEffect: 'none'`. Inspection maps the same code to
`reason: 'operation_unavailable'`, and
`resolveSessionContinuationUnavailablePresentationV1` disambiguates old-daemon from offline using
Machine presence (`update_cli` / `machine_offline` / `update_or_reconnect`). The connection is never
failed wholesale; only this operation degrades. **Every other transport failure, and any unparseable
response, is `outcome_unknown` — never a rejection.**

**Old client against a new daemon/server.** Unchanged: the divider rides the shipped passthrough
event arm, and no existing fork/spawn/message vector changed shape.

**No intermediate-shape compatibility.** Nothing of this feature is in any released build —
`git grep sessionAgentTransitionV1` is empty at `cli-stable`, `cli-preview`, `server-stable` and
`ui-web-stable` — so shapes written only by an intermediate development build are not obligations.
The divider's `sourceCutoffSeqInclusive` is therefore required rather than optional, and there is no
"this divider recorded no bound" reader state. Do not reintroduce one.

**`sourceContext` uses the existing release-floor path, not a new negotiation surface** (`AM-22`).
`remote-dev` declares it at its machine-RPC creation ingress and resolves the recipe before any child
exists. `dev` deliberately does **not** carry it on the private
`SpawnDaemonSessionRequestCompatSchema`: that schema is strict, while the Action-receiving daemon
accepts the strict `SessionSpawnNewInputV2` and resolves the recipe before canonical creation.
Immutable `cli-v0.2.0` (`526aa0d`) and `cli-v0.2.1` (`b1d15a8`) had a permissive private spawn schema
that could silently strip an unknown `sourceContext`; they are a real released floor. The existing
Action/release-floor behavior therefore rejects or reports the operation unavailable, keeps the
draft/chip, and never retries as an ordinary unseeded child. No second capability negotiation or
private-carrier extension is justified.

**`remote-dev` → `dev` frontier.** The predecessor ships the same product, not a reduced one: same
Session, bounded context, shared Agent picker, unified fork flow, and the same device-local native
return. Its protocol lives in
flat files (`packages/protocol/src/sessionAgentTransition*.ts`) against `dev`'s
`sessions/agentTransition*`; the transition modules differ only in import paths, and the G0 ledger
records the shared wire vectors as byte-identical. A `dev` reader must accept a `remote-dev`-written
Session: one flat resume key. The native record and its delta boundary are now present in both trees
and written byte-identically, so the same `~/.happier` round-trips between the two CLIs. Neither
direction has a live mixed-version gate.

## Deliberately absent

Do not reintroduce these. Each was removed or rejected against evidence, and the reasoning is in
`PLAN.md` §1.6 and §12.2.

| Absent | Why |
|---|---|
| `createReplaySeededSession` | Duplicate creator; one canonical creator per tree. |
| Transition slots, held Pending carrier, writer fences | Replaced by the effect-stage ledger and post-cutover custody. |
| `reconciliation_required` wire code | Split into two definite partial depths plus `outcome_unknown` (`AM-3`). |
| `departureBoundaryContext`, `isTrustedAgentTransitionDepartureBoundaryV1` | Zero production consumers; producer hardcoded `false`. §9.1 says the bound *may* be applied and broader context is always safe (`AM-18`). |
| `sourceContextSpawn`, `nativeForkIntent`, `SessionAgentTransitionReviewReasonV1` | Zero readers, proven by two independent search paths (`AM-20`). |
| A native-resume continuity proof: `AgentNativeContinuityProofV1`, `hasObservedVendorResumeContinuityProof`, the `vendor_resume_continuity_proof_missing` reason code, the decision-time `stat()`, and the Claude-only divergence guard in `chooseVendorResumeId` | A dead vendor id fails LOUDLY in both Agents that support native resume, so there is no silent-zero-context path for a pre-check to prevent, and the gate was a second decision-maker for a question resuming already answers. It was never general either — 15 Agents declare vendor resume and exactly one declared a proof field (`AM-24`). |
| `nativeReturn` on `session.continuation.inspect`; the record write's read-back boolean; `discardAgentNativeResumeRecord`; `updatedAtMs` on the record | Zero readers each, and the first cost a protected-file read plus a `stat()` per offered target on every picker open (`AM-24`). |
| An Apply/confirm step in the picker | Selection *is* the arming; every other model picker in the product commits on selection. |
| *Check status* / *Resume source* / *Resume target* recovery controls, a recovery panel, a status RPC, polling, a second start path | Rejected as overengineered (`AM-23`). Automatic reconciliation plus the existing composer banner. |
| A transition-local archive disposition parameter | Archive-on-stop is fixed at the termination-archive owner (`AM-1`). |

## Recovery presentation

`apps/ui/sources/sync/domains/session/input/continueSessionWithArmedAgent.ts` is the **single**
client decision-maker. It maps both the daemon arm and the reconciled arm onto one internal
effect-depth, so no wire code is ever fabricated client-side, and a definite daemon arm is never
weakened by a later client view.

Presentation reuses the existing `WarningActionBanner` in `ComposerAuxiliaryFrame` with the existing
composer badge and collapse provider — no new primitive, no modal. `accepted` shows nothing;
`rejected`, refusals and `source_stopped` show a warning with **no action**, because the ordinary
send *is* the retry and reuses the same `localId`; `current_view_committed` offers `Resume session`
only once canonical facts show no live runtime, delegating to the same resume owner every other
inactive-Session affordance uses; `outcome_unknown` shows a neutral notice and blocks sending for one
reconciliation pass.

The send block is enforced at the destination owner
`resolveSessionComposerSendDestination` (refusal `unreconciledTransitionOutcome`), not inline in the
screen and not on the send button. Reconciliation reuses
`ensureSessionVisibleForMessageRoute(..., { forceRefresh: true })` + `refreshSessionMessages`, and
custody reuses `hasCanonicalOutboundHandoffForLocalId`.

**Accepted residual:** the preflight reconcile cannot distinguish "this cutover committed and its
divider append failed" from "another client already switched", because every per-request marker that
could separate them was deliberately removed. The arm guarantee still holds; the remaining obligation
is honest copy, not a new mechanism.

## Implementation references

- `packages/protocol/src/sessions/agentTransition.ts`, `agentTransitionDivider.ts`,
  `agentTransitionEffectStage.ts`, `forkPoint.ts`, `creation/sessionSpawnSourceContextV1.ts`
- `packages/protocol/src/sessions/messages/transcriptRawRecordV1.ts` (`agentEventAttentionImpact`)
- `packages/protocol/src/features/catalog.ts`
- `apps/cli/src/session/agentTransition/**`
- `apps/cli/src/session/handoff/metadata/localSessionHandoffMetadataStore.ts`
- `apps/server/sources/app/session/agentTransition/**`
- `apps/server/sources/app/features/sessionAgentSwitchingFeature.ts`
- `apps/ui/sources/components/sessions/agentPicker/**`,
  `apps/ui/sources/components/sessions/transcript/attribution/**`,
  `apps/ui/sources/sync/domains/session/input/**`, `apps/ui/sources/sync/ops/sessionAgentTransition.ts`
