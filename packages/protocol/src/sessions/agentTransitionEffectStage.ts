import type {
  SessionAgentTransitionCurrentViewCommittedCodeV1,
  SessionAgentTransitionRejectedCodeV1,
  SessionAgentTransitionResultV1,
  SessionAgentTransitionSourceStoppedCodeV1,
} from './agentTransition.js';

/* ------------------------------------------------------------------------- *
 * The single construction site for every `session.agentTransition` result arm
 * ------------------------------------------------------------------------- */

/**
 * `SessionAgentTransitionResultV1` is a promise, not a label. `rejected`
 * guarantees `sourceEffect: 'none'` — the UI turns that into **Keep editing** —
 * and `partially_applied` with `applied: 'source_stopped'` guarantees that
 * nothing was committed, which is what makes resume-source safe.
 *
 * Those guarantees are properties of WHERE the flow is, not of the code the
 * author picked. Nine separate defects have been found and fixed one at a time
 * where an arm was returned from a state that could not honour it: a
 * `rejected('stale_selection')` after a committed cutover; a thrown fence
 * request treated as proof that no fence was applied; an already-target
 * reconcile routed back through a rejection; a reconcile reporting
 * `target_start_failed` for a target that was already running. Every one was a
 * local judgement that "this particular failure is provably pre-effect", and
 * every one was written by someone who had read the contract.
 *
 * So the contract stops being prose. The result arms are constructible ONLY
 * through the stage handle that proves the effect depth the flow has actually
 * reached, and each stage exposes exactly the arms truthful at that depth:
 *
 * | stage                          | may build                                            |
 * |--------------------------------|------------------------------------------------------|
 * | `SourceUntouched`              | `rejected`, `outcomeUnknown`                          |
 * | `SourceFenced`                 | `rejected` (reopens the fence first), `outcomeUnknown` |
 * | `SourceStopped`                | `sourceStopped`, `outcomeUnknown`                     |
 * | `CurrentViewCommitted`         | `accepted`, `committed`                               |
 *
 * A tenth instance of the class is therefore not a review finding, a lint
 * warning or a test that must be remembered: it does not compile. Once the flow
 * holds a `SessionAgentTransitionSourceStopped`, the `rejected` method does not
 * exist on it.
 *
 * `outcomeUnknown` is available at every depth EXCEPT the last, because it
 * claims nothing and can therefore never over-promise — until the depth itself
 * is an observed fact. Once the cutover is committed, "the daemon cannot
 * establish what happened" is no longer modest, it is false: the Session
 * demonstrably IS the target, and reporting otherwise leaves the client's armed
 * switch alive in front of a switch that already happened. Every remaining
 * uncertainty at that depth is a committed-view code.
 *
 * The stage also owns the correlation `localId`, so no site can omit it from an
 * arm that carries one or pair an arm with the wrong one.
 *
 * NOTE ON SCOPE — this module encodes what the DEPTH permits. It cannot decide
 * whether a given transport/runtime failure actually reached that depth; that
 * remains domain evidence owned by the daemon (for example, which stop outcomes
 * prove the runner was never signalled). What it removes is the ability to hold
 * that judgement and still name an arm the depth forbids.
 */

/**
 * Stage 1 — nothing has touched the source runtime, Session row, or input.
 *
 * `rejected` is truthful here and nowhere deeper.
 */
export type SessionAgentTransitionSourceUntouched = Readonly<{
  /**
   * The source is provably untouched and still running. Safe actions for the
   * client: Keep editing, or retry after revalidation.
   */
  rejected: (code: SessionAgentTransitionRejectedCodeV1) => SessionAgentTransitionResultV1;
  /** Nothing can be established. Claims no depth, so it is always truthful. */
  outcomeUnknown: () => SessionAgentTransitionResultV1;
  /**
   * A runtime input fence has been REQUESTED. Call this BEFORE issuing the
   * request, never after inspecting its answer: a fence request that throws or
   * times out proves only that no ANSWER arrived, not that no fence was
   * applied, and a `rejected` returned in that state leaves the source silently
   * refusing local provider input while the UI offers Keep editing.
   *
   * `reopen` is invoked by this module before every exit taken from the fenced
   * stage, so no exit site can forget it.
   */
  withInputFence: (reopen: () => Promise<void>) => SessionAgentTransitionSourceFenced;
  /** The stop returned its fully confirmed stopped outcome. */
  stopConfirmed: () => SessionAgentTransitionSourceStopped;
  /**
   * The target current view was OBSERVED already committed — the Session
   * already names the target Agent, which is this operation's own cutover seen
   * again (contract section 7.5), not a stale client view. Reporting a
   * rejection from here would promise an untouched source in front of a dead
   * runtime, so the depth advances on the observation itself.
   */
  cutoverObservedCommitted: () => SessionAgentTransitionCurrentViewCommitted;
}>;

/**
 * Stage 2 — a fence request has been issued against the source runtime and the
 * stop has not yet been confirmed.
 *
 * Both exits are async because both reopen the fence first. That is the whole
 * point: `sourceEffect: 'none'` is false while the source is still refusing
 * local provider input, and a reopen that each call site has to remember is a
 * reopen that one call site will not.
 */
export type SessionAgentTransitionSourceFenced = Readonly<{
  rejected: (code: SessionAgentTransitionRejectedCodeV1) => Promise<SessionAgentTransitionResultV1>;
  outcomeUnknown: () => Promise<SessionAgentTransitionResultV1>;
  /**
   * The stop is confirmed. The fence lived in the retired source runner, so it
   * is deliberately NOT reopened here; the target lifecycle reopens its own
   * epoch when it starts.
   */
  stopConfirmed: () => SessionAgentTransitionSourceStopped;
}>;

/**
 * Stage 3 — the source is CONFIRMED stopped and nothing has been committed.
 *
 * `rejected` is unreachable from here on, at the type level.
 */
export type SessionAgentTransitionSourceStopped = Readonly<{
  sourceStopped: (code: SessionAgentTransitionSourceStoppedCodeV1) => SessionAgentTransitionResultV1;
  outcomeUnknown: () => SessionAgentTransitionResultV1;
  /** The target current view (and divider) committed. */
  cutoverCommitted: () => SessionAgentTransitionCurrentViewCommitted;
}>;

/**
 * Stage 4 — the Session IS the target Agent.
 *
 * `sourceStopped` is unreachable from here on: a committed cutover reported at
 * the shallower depth would tell the client the Session is still the source.
 *
 * `outcomeUnknown` is unreachable too, and this is the one depth where its
 * absence matters. It is the modest arm everywhere else because it claims
 * nothing; here the claim it makes — that the daemon cannot establish what
 * happened — is simply untrue, and the client answers it by keeping the armed
 * switch alive in front of a Session that has already switched. Whatever else
 * is unknown at this depth is named by a committed-view code.
 */
export type SessionAgentTransitionCurrentViewCommitted = Readonly<{
  /**
   * The exact `localId` received canonical message admission. This does not
   * claim provider acceptance.
   */
  accepted: () => SessionAgentTransitionResultV1;
  committed: (code: SessionAgentTransitionCurrentViewCommittedCodeV1) => SessionAgentTransitionResultV1;
}>;

function buildCurrentViewCommitted(localId: string): SessionAgentTransitionCurrentViewCommitted {
  return Object.freeze({
    accepted: () => ({ type: 'accepted', localId }),
    committed: (code) => ({ type: 'partially_applied', localId, applied: 'current_view_committed', code }),
  } satisfies SessionAgentTransitionCurrentViewCommitted);
}

function buildSourceStopped(localId: string): SessionAgentTransitionSourceStopped {
  return Object.freeze({
    sourceStopped: (code) => ({ type: 'partially_applied', localId, applied: 'source_stopped', code }),
    outcomeUnknown: () => ({ type: 'outcome_unknown', localId }),
    cutoverCommitted: () => buildCurrentViewCommitted(localId),
  } satisfies SessionAgentTransitionSourceStopped);
}

function buildSourceFenced(
  localId: string,
  reopen: () => Promise<void>,
): SessionAgentTransitionSourceFenced {
  return Object.freeze({
    rejected: async (code) => {
      await reopen();
      return { type: 'rejected', code, sourceEffect: 'none' };
    },
    outcomeUnknown: async () => {
      await reopen();
      return { type: 'outcome_unknown', localId };
    },
    stopConfirmed: () => buildSourceStopped(localId),
  } satisfies SessionAgentTransitionSourceFenced);
}

/**
 * Open the effect ledger for one transition invocation. Call it once, at the
 * top of the flow, and thread the returned handle forward: the handle in scope
 * is the proof of how far the transition got.
 */
export function beginSessionAgentTransitionEffects(
  params: Readonly<{ localId: string }>,
): SessionAgentTransitionSourceUntouched {
  const { localId } = params;
  return Object.freeze({
    rejected: (code) => ({ type: 'rejected', code, sourceEffect: 'none' }),
    outcomeUnknown: () => ({ type: 'outcome_unknown', localId }),
    withInputFence: (reopen) => buildSourceFenced(localId, reopen),
    stopConfirmed: () => buildSourceStopped(localId),
    cutoverObservedCommitted: () => buildCurrentViewCommitted(localId),
  } satisfies SessionAgentTransitionSourceUntouched);
}

/**
 * The one rejection raised before the transition was dispatched at all: the
 * request failed schema validation, or the process holds no credentials, so no
 * code addressed the Session and there is no `localId` to correlate.
 *
 * This is deliberately a separate, awkwardly named export rather than a second
 * way to build a rejection. Inside the flow the stage handle is the only
 * source of arms; reaching for this there is visibly wrong.
 */
export function rejectUndispatchedSessionAgentTransition(
  code: SessionAgentTransitionRejectedCodeV1,
): SessionAgentTransitionResultV1 {
  return { type: 'rejected', code, sourceEffect: 'none' };
}
