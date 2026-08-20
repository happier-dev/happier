# Agent transition (same-Session cross-Agent continuation)

How one Happier Session changes the coding Agent that runs it, in place, without
forking and without changing the Session id.

Published, user-facing documentation for this feature lives at
`apps/docs/content/docs/features/continue-with-another-agent.mdx`. This page is
the internal contract: canonical owners, ordering, effect depth, and the
operator surface.

Related internal pages: `feature-gating.md` (gate contract), `protocol.md` (wire
transport), `pending-delivery.md` (input custody), `agents-catalog.md` (Agent
vocabulary).

## Vocabulary

- **Source Agent** — the Agent running the Session when the switch is submitted.
- **Target Agent** — the Agent the reader armed.
- **Cutover** — the single server-side commit that moves the Session's current
  view onto the target Agent and writes the transcript divider.
- **Activation brief** — the bounded backward context pass handed to the target
  Agent through the existing Replay seed slot.
- **Native return** — a target Agent that already ran this Session on this
  machine resuming its own vendor conversation instead of starting fresh.

This is not session handoff, which moves a Session between machines and keeps
the Agent, and not forking, which creates a new Session.

## Canonical owners

| Concern | Owner |
| --- | --- |
| Transition mutation, ordering, effect depth | `apps/cli/src/session/agentTransition/sessionAgentTransitionCoordinator.ts` |
| "Can this Session continue at all / with this target?" | `apps/cli/src/session/agentTransition/sessionContinuationInspection.ts` |
| Activation brief composition (transition **and** rebuild) | `apps/cli/src/session/agentTransition/buildSessionAgentTransitionActivationBrief.ts` |
| Read-only rebuild behind the transcript card | `apps/cli/src/session/agentTransition/previewSessionAgentTransitionBrief.ts` |
| Same-machine native return records + eligibility | `apps/cli/src/session/agentTransition/agentNativeReturn.ts` |
| Request/result/preview schemas, effect ledger, unavailable presentation | `packages/protocol/src/sessionAgentTransition.ts` |
| Divider sidecar schema, localId derivation, the one divider reader | `packages/protocol/src/sessionAgentTransitionDivider.ts` |
| Seed retrieval, character budget, escaping, framing | `apps/cli/src/session/replay/resolveReplaySeedDraft.ts` + `packages/agents/src/sessions/replay/happierReplayPrompt.ts` |
| Current-view projection (including the one vendor resume-key writer) | `packages/agents` — `projectCurrentAgentSessionView` |
| Client eligibility per catalog row | `apps/ui/sources/components/sessions/agentPicker/resolveSessionAgentContinuationEligibility.ts` |
| Arming, arm scope, and the transition's correlation id | `apps/ui/sources/components/sessions/agentPicker/useInSessionAgentPickerControls.tsx` |
| Which destination one composer send reaches | `apps/ui/sources/sync/domains/session/input/resolveSessionComposerSendDestination.ts` |

Machine RPCs (`packages/protocol/src/rpc.ts`, registered in
`apps/cli/src/api/machine/rpcHandlers.ts`):

- `session.continuation.inspect` — read-only eligibility for one target.
- `session.agentTransition` — the mutation.
- `session.agentTransition.briefPreview` — read-only rebuild of a divider's brief.

All three run on the machine hosting the Session, and the daemon enforces that
rather than assuming it: `sessionIsHostedHere` refuses a Session whose recorded
machine is not this authenticated one, in the mutation and in inspection alike.
The client can legitimately address another machine — its RPC target is resolved
through the machine replacement chain — and the server routes by the named
machine without checking that it hosts the Session, so the daemon is the only
place the question can be settled. Inspection and the preview grant no authority
and persist nothing; the mutation revalidates every fact inspection reported.

## Preconditions

`inspectSessionContinuation` and `runSessionAgentTransition` share their
decisions so a selection cannot pass inspection and then be refused at cutover.

A Session is transitionable when all of these hold:

- it has a non-empty workspace `path` in metadata;
- `resolveAgentIdFromSessionMetadata` can name its current Agent;
- `hasCanonicalHostedTranscript(metadata)` is true — i.e. neither an established
  `directSessionV1` (`{ v: 1, ... }`) nor a recorded `transcriptStorage:
  'direct'` spawn intent. A direct/external-transcript Session has no Happier
  conversation for another Agent to continue.

A target is supported when `resolveSessionContinuationTargetAgent` resolves it:
the selection carries no `providerConnectionId`, the `agentId` is in
`CATALOG_AGENT_IDS`, and it is not `customAcp` (configured ACP targets are
excluded in V1 — their create/resume/context contract is unproven). A target
equal to the current Agent is reported as available-but-not-a-transition
(`sameSessionTransition: false`), not as an error.

The client adds two Session-level facts before it asks a machine anything
(`resolveSessionAgentContinuationSessionReason`): no edit access → `read_only`;
`storageKind === 'direct'` → `external_session`. Non-`builtInAgent` catalog rows
resolve to `target_not_proven` locally.

## Flow

Numbered stages match the section comments in the coordinator.

**7.1 Preflight (no effects).** Resolve the Session, refuse archived Sessions,
decrypt metadata, apply the preconditions above. Resolve the target *before*
comparing against the expected current Agent, so a Session that already **is**
the target is recognised as this operation's own committed cutover seen again
(7.5) rather than as a stale client view. Sanitize the submitted input through
`sanitizeSessionUserMessageSendMeta` here, before the idle proof, so a rejected
mention or attachment fails with the source untouched.

**Strict idle.** `waitForSessionIdle` with the session-control stop timeout.
Not idle within that window → `rejected('source_not_idle')`. There is
deliberately **no** input-admission fence: `SessionProviderInputConsumer` has a
one-way close latch and no reopen, so an epoch subsystem would be new machinery.
Currentness is rechecked immediately before the stop instead; a final ordinary
prompt that wins that instant begins and is then interrupted by the normal stop
path.

**7.2 Departure record and stop.** Recheck `metadataVersion`, then capture the
departing Agent's native resume record (its vendor id plus the transcript head
*before* the stop — under-estimating that boundary costs one re-replayed turn,
over-estimating skips rows permanently). Then `requestSessionStop`.

- Stop request failed before any attempt → `rejected('source_stop_failed')`
  (the source is provably still running).
- Stop attempted but not confirmed → `outcome_unknown`. There is no allowlist of
  "pre-signal" stop reasons; the reasons are diagnostic only and `stop.stopped`
  is the depth.

**7.3 Project the target view.** Re-read the Session *after* the confirmed stop
and project from **those** bytes, because the CAS versions committed below come
from the same read. Resolve native-return eligibility first, then build the
activation brief bounded by the post-stop transcript head. The projection is
authoritative over `metadata.replaySeedV1`: either this operation's brief
occupies the slot or the slot is deleted. `applyTargetConnectedServiceBinding`
then resolves the target's connected-service binding through the same
account-default owner a new Session uses, minting a fresh materialization
identity; failure here degrades to native CLI auth rather than failing a
transition whose source is already gone.

**Cutover.** `commitSessionAgentTransitionCutover` commits the target current
view (CAS on `metadataVersion`/`agentStateVersion`) and the divider in one call.
A refused divider is split into `divider_conflict` (a different payload already
occupies the reserved localId — retrying re-derives the same conflict forever)
and `divider_missing`.

**7.4 Admit input, then activate.** Input custody is taken **before** the target
runtime is started, matching this tree's `sendSessionMessage` invariant:
starting a runtime with no durable Pending row creates work the user cannot
recover. `accepted` therefore means canonical admission **plus** a started
target; a failure after admission is `target_start_failed`, never a silent drop.

**7.5 Reconciliation.** A retry that finds the Session already naming the target
runs `reconcileAlreadyTargetedSession`, sharing the same activation/admission
implementation. Only a request that *also* expected the target is a genuine
`same_target` no-op.

### Result arms

`beginSessionAgentTransitionEffects` is a per-invocation effect ledger, and the
handle in scope is the only source of result arms.

- `rejected` is used **only** where the source is provably still running — its
  `sourceEffect: 'none'` is a promise the UI turns into a keep-editing action.
- Everything reachable after the confirmed stop rides `partially_applied`
  (`source_stopped` / `cutover_committed` depths) or `outcome_unknown`.
- `accepted` means the current view and divider committed and the exact
  submitted input was admitted.

### Correlation and idempotency

The submitted user-message `localId` is the single correlation key for the whole
transition. The divider's localId is derived from it
(`agent-transition:{submittedLocalId}`), which makes the divider exactly-once
with no receipt or marker persisted. The client mints that id per *armed choice*
— stable across re-renders and across an edited draft, replaced when the reader
picks a different Agent, model, mode or configuration — so retrying the same
armed switch re-admits one message instead of sending a second copy.

Encrypted divider content is derived deterministically from the localId, so a
retry re-derives byte-identical content and the message owner reconciles it as
the same row.

## What the arriving Agent receives

The brief is produced by `buildSessionAgentTransitionActivationBrief`, which
composes the transition-specific inputs and delegates retrieval, budget,
escaping and framing to the canonical Replay seed owner. It is carried in
`metadata.replaySeedV1` and prefixed onto the first provider-accepted prompt by
the existing seed owner; `seedText` is blanked the instant the target accepts it.

The frame is built with continuity `same_session_agent_change` — deliberately
not `previous_session`, which would print this Session's own id as its
predecessor. It can contain:

- a handoff header naming the situation and the source Agent, plus the Session
  title;
- for a fresh target, an explicit statement that the previous Agent's own
  conversation state does not carry over and the transcript below is a replay;
- an optional condensed summary block;
- the departing Agent's tracked work (`sessionWorkStateV1`), read through
  `readDisplayableSessionWorkStateV1`, attributed to that Agent and marked
  past-tense because the cutover cleared the field;
- the last user instruction, pinned when it falls outside the replayed window;
- the transcript tail;
- a replay-completeness notice when some rows could not be read;
- retrieval pointers — the Happier transcript-retrieval invocation for the
  target Agent, and the source Agent's own session-log path when one exists and
  the file is still present (resolved from the catalog-declared continuity-proof
  slot first, then the provider-owned `resolveAgentNativeSessionLogPath` hook).

The pass is bounded by **characters**, not message count.

An empty source (a Session where the reader switches before sending anything)
is `no_source_dialog`, which is a success with nothing to carry — not
`context_unavailable`.

## Native return

`agentNativeReturn.ts` keeps a **machine-local** record of each departing
Agent's vendor conversation id and the transcript head it had seen, because a
vendor session belongs to the machine that ran it.

When a target with such a record is chosen again on that machine:

- `evaluateVendorResumeEligibility` — the same owner the ordinary
  inactive-resume path consults — decides usability against the exact projected
  target view the cutover is about to commit and against this Account's
  settings (which carry per-Agent native-resume enablement and the Codex backend
  mode). Unavailable settings read as no explicit enablement: fail closed.
- The resume id travels through `projectCurrentAgentSessionView`
  (`nativeResumeId`), the one writer of a flat vendor resume key, which is what
  keeps the one-identity invariant true by construction.
- The brief then carries only the **away-delta** since that Agent's recorded
  departure, and the frame states the boundary instead of restating history the
  resumed conversation already holds.

There is deliberately **no** continuity proof, `stat()`, or liveness probe on
the recorded id. A stale or dead vendor session fails loudly at the first turn —
Claude raises `ClaudeAgentSdkResumeIdentityMismatchError`, Codex's
`thread/resume` throws with no fresh-start fallback — which is the same contract
every other Happier resume already has. The reader recovers through the
in-session picker.

Anything refused degrades to a fresh target with the **full** bounded brief,
never to an arbitrary native session and never to a starved replay. A target
with no record passes `returningAgentLastSeenSeq: null` and cannot be starved,
because there is no bound to starve it with.

## Divider and the rebuilt context card

The divider is stored as an ordinary `type: 'message'` agent event carrying a
strict sidecar (`SessionAgentTransitionDividerV1Schema`: `fromAgentId`,
`toAgentId`, `sourceCutoffSeqInclusive`), so a reader predating the feature
still shows truthful prose. `readSessionAgentTransitionDividerV1` is the single
"is this a divider?" reader — attention resolvers, the separator renderer,
historical attribution and the bounded context pass all use it.

Both Agent ids are durable and may outlive the catalog; an unknown id degrades
to itself rather than to "Unknown".

`sourceCutoffSeqInclusive` is **required**, not optional. `0` is a recorded
"nothing was carried over"; a sidecar that omits the field fails the strict parse
and the row is not a divider at all — it degrades to its stored prose through the
same path a reader predating the feature takes. Nothing of this feature is in a
released build (`git grep sessionAgentTransitionV1` is empty at `cli-stable`,
`cli-preview`, `server-stable` and `ui-web-stable`), so the cutoff-less shape an
intermediate development build wrote is not an obligation and there is no
"recorded no bound" reader state.

Nothing of the brief is stored to show later: `replaySeedV1.seedText` is blanked
on acceptance and the metadata record keeps one seed per Session, so a
twice-switched Session has already lost the first. The card therefore
**rebuilds** on open, on the hosting machine, through
`session.agentTransition.briefPreview` → the *same*
`buildSessionAgentTransitionActivationBrief`, bounded by the *same* cutoff the
divider recorded. Running it client-side from the rendered transcript would
create a second decision-maker about what the Agent was sent.

Two components are deliberately **omitted** from a rebuild and stated as omitted
in the card, rather than refilled from today's values: the departing Agent's
tracked work and its own session log. Both are Agent-scoped current state whose
durable keys now hold the *incumbent's* values, so the rebuild passes
`departingAgentCurrentView: null`. This is why a rebuild can legitimately differ
from what was sent, and why the card says so.

Preview outcomes: `rebuilt` (with `briefText`), `empty` (nothing was carried
over), `unavailable` with `unsupported_session` (not retryable) or
`source_unreadable`.

## Client behaviour

- The picker is the running Session's Agent/engine picker in the composer. Each
  target row carries its own model/mode/config choice, rendered by the same
  owner New Session uses (`buildSessionAgentPickerDetailContent`).
- **Selection is arming**: there is no confirm step, and re-selecting the
  running Agent's row is the cancel gesture. Nothing is sent until the next
  message.
- The arm is scoped to `{feature gate open} × {rail offered} × {sessionId} ×
  {current Agent}`. Any of those moving discards the arm, including the
  persisted copy in the Session draft. A restored arm is re-validated against a
  *settled* rail — an unresolved gate looks exactly like a closed one and is
  never treated as proof of staleness.
- Rows still being inspected are held in the same restrained treatment as
  unavailable rows, so nothing can be armed before its machine has answered.
- One send has one destination (`resolveSessionComposerSendDestination`). It
  refuses rather than silently mis-delivering: `conflictingDestination` (the
  send would reach a voice adapter or execution run), `armedTargetUnreachable`
  (no machine), `unreconciledTransitionOutcome` (an earlier `outcome_unknown`
  window is still open).
- Inspection answers are keyed on both the client's connection generation and
  the machine's daemon generation; either moving discards every prior answer.
- `resolveSessionContinuationUnavailablePresentationV1` splits an
  operation-unavailable answer by machine presence: offline → `machine_offline`,
  online → `update_cli`, otherwise → `update_or_reconnect`. An inspection call
  that failed without establishing anything is `indeterminate` and presents as
  `update_or_reconnect`, never as a false "update the CLI" instruction.

## Feature gate and configuration

`sessions.agentSwitching` (`packages/protocol/src/features/catalog.ts`):
`representation: 'server'`, `defaultFailMode: 'fail_closed'`, depends on
`sessions`. The UI consumes it as `readServerEnabledBit(...) === true` at the
one place a target can be armed, so a closed gate means no inspection, no rail,
and no armed intent — and the submit path reads only the armed intent.

Server env (`apps/server/sources/app/features/catalog/featureEnvSchema.ts`,
`readFeatureEnv.ts`):

- `HAPPIER_FEATURE_SESSIONS_AGENT_SWITCHING__ENABLED` — parsed with a `true`
  default, so this is an **opt-out**. The feature is on unless an operator
  turns it off.

Daemon env (`apps/cli/src/configuration.ts`) — these bound the shared Replay
seed pass, so they also affect forking and source-context spawns:

- `HAPPIER_REPLAY_MAX_SEED_CHARS` — default `120000`, min `1024`, max `200000`.
  The minimum is not a round number: the prompt builder's frame floor is 814
  characters (pinned in `happierReplayPrompt.spec.ts`), and below that floor the
  builder correctly returns **no** seed rather than a frame with no transcript
  under it. `1024` sits above the measured floor with room to grow, so a clamped
  value can always deliver a real prompt. A caller-supplied `maxSeedChars` on
  the wire is not clamped here and may be lower.
- `HAPPIER_REPLAY_SEED_CANDIDATE_LIMIT` — default `500`, min `50`, max `500`.
- `HAPPIER_REPLAY_SEED_MAX_TRANSCRIPT_REQUESTS` — default `8`, min `1`, max `24`.
- `HAPPIER_REPLAY_SEED_TRANSCRIPT_DEADLINE_MS` — default `15000`, min `1000`,
  max `120000`. This walk runs after the source runtime is stopped and while the
  user is waiting.

## Compatibility

- The cutover response is one shape across trees: `200 { success, dividerSeq,
  dividerVerificationRequired? }`, `409`/`500` carrying the `effect` /`error`
  partial-effect discriminator, and `400`/`403`/`404` for the refusals that wrote
  nothing. A cutover the server refuses at any of those depths surfaces as
  `partially_applied` with `cutover_conflict` — the source is already stopped, so
  never as a no-effect rejection.
- A lost cutover CAS is retried EXACTLY once, after refetching the row and
  re-proving that it is unarchived and still on the source Agent. The target view
  is re-projected from the refetched bytes, so the retry cannot revert the write
  that moved the version. A second loss is a conflict, not a loop.
- `dividerVerificationRequired` is a demand this tree's own server never makes:
  it seals dividers deterministically by localId, so its byte comparison always
  settles authorship. A server that seals with a random nonce has to defer, and
  this daemon — which has no decrypt-and-compare path — reports that
  unattributable boundary as `divider_conflict` rather than activating on it.
- A daemon that predates the operation cannot answer
  `session.continuation.inspect`; the client presents that by machine presence
  rather than asserting a cause.
- The divider is an ordinary agent message event, so a client that does not
  understand the sidecar still renders truthful prose instead of nothing.
- Native-return records are machine-local and are not part of any wire or
  cross-machine contract.

## Implementation references

- `apps/cli/src/session/agentTransition/**`
- `apps/cli/src/session/replay/resolveReplaySeedDraft.ts`
- `packages/protocol/src/sessionAgentTransition.ts`,
  `packages/protocol/src/sessionAgentTransitionDivider.ts`
- `packages/agents/src/sessions/replay/happierReplayPrompt.ts`
- `apps/ui/sources/components/sessions/agentPicker/**`
- `apps/ui/sources/components/sessions/transcript/agentTransition/**`
- `apps/server/sources/app/features/sessionAgentSwitchingFeature.ts`
