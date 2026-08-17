/**
 * Declaration-level closure of the transition arm-guarantee class.
 *
 * Nine defects of one class have been found and fixed one at a time: a result
 * arm returned from a state that could not honour the guarantee it carries —
 * almost always a `rejected(...)` whose `sourceEffect: 'none'` had already been
 * falsified by a stop, a committed cutover, or an applied admission fence.
 *
 * Every instance was a local judgement made by an author who had read the
 * contract, so prose, review and remembered tests have all now been shown not
 * to close it. These assertions do: an arm is constructible only from the stage
 * handle that proves the depth reached, and this fixture pins which arms each
 * stage may and may NOT expose. A tenth instance stops being a review finding
 * and becomes a compile error in `packages/protocol`.
 *
 * This file is type-only and emits nothing.
 */
import type {
  SessionAgentTransitionCurrentViewCommitted,
  SessionAgentTransitionSourceFenced,
  SessionAgentTransitionSourceStopped,
  SessionAgentTransitionSourceUntouched,
} from './sessionAgentTransitionEffectStage.js';

type Assert<Condition extends true> = Condition;
type Exposes<Stage, Arm extends string> = Arm extends keyof Stage ? true : false;
type Withholds<Stage, Arm extends string> = Exposes<Stage, Arm> extends true ? false : true;

/* --------------------------------------------------------------------- *
 * `rejected` promises `sourceEffect: 'none'`, which the UI turns into Keep
 * editing. It exists only while the source is provably untouched.
 * --------------------------------------------------------------------- */

type _UntouchedMayReject = Assert<Exposes<SessionAgentTransitionSourceUntouched, 'rejected'>>;

// A fence request that threw proves "no answer", not "no fence", so the fenced
// stage may still reject — but only through its own reopening exit.
type _FencedMayReject = Assert<Exposes<SessionAgentTransitionSourceFenced, 'rejected'>>;

// The tenth instance, refused: `rejected('stale_selection')` after the
// confirmed stop, and after the cutover committed.
type _StoppedCannotReject = Assert<Withholds<SessionAgentTransitionSourceStopped, 'rejected'>>;
type _CommittedCannotReject = Assert<Withholds<SessionAgentTransitionCurrentViewCommitted, 'rejected'>>;

/* --------------------------------------------------------------------- *
 * Depth may not be under-reported either: a committed cutover reported as
 * `source_stopped` tells the client the Session is still the source Agent.
 * --------------------------------------------------------------------- */

type _StoppedMayReportItsOwnDepth = Assert<
  Exposes<SessionAgentTransitionSourceStopped, 'sourceStopped'>
>;
type _CommittedCannotReportSourceStopped = Assert<
  Withholds<SessionAgentTransitionCurrentViewCommitted, 'sourceStopped'>
>;

/* --------------------------------------------------------------------- *
 * `accepted` claims canonical admission INTO a committed target view, so no
 * shallower stage may produce it.
 * --------------------------------------------------------------------- */

type _CommittedMayAccept = Assert<Exposes<SessionAgentTransitionCurrentViewCommitted, 'accepted'>>;
type _UntouchedCannotAccept = Assert<Withholds<SessionAgentTransitionSourceUntouched, 'accepted'>>;
type _FencedCannotAccept = Assert<Withholds<SessionAgentTransitionSourceFenced, 'accepted'>>;
type _StoppedCannotAccept = Assert<Withholds<SessionAgentTransitionSourceStopped, 'accepted'>>;
type _StoppedCannotReportCommittedCodes = Assert<
  Withholds<SessionAgentTransitionSourceStopped, 'committed'>
>;

/* --------------------------------------------------------------------- *
 * `outcomeUnknown` claims nothing, so it can never over-promise and is
 * available at every depth WHERE THE DEPTH IS NOT ITSELF AN OBSERVED FACT.
 * Once the cutover has committed, claiming nothing is no longer modest: the
 * Session demonstrably IS the target, and the codeless arm makes the client
 * keep an armed switch alive in front of a switch that already happened. Every
 * remaining uncertainty at that depth rides a committed-view code.
 * --------------------------------------------------------------------- */

type _PreCommitStagesMayReportOutcomeUnknown = Assert<
  Exposes<SessionAgentTransitionSourceUntouched, 'outcomeUnknown'> extends true
    ? Exposes<SessionAgentTransitionSourceFenced, 'outcomeUnknown'> extends true
      ? Exposes<SessionAgentTransitionSourceStopped, 'outcomeUnknown'>
      : false
    : false
>;
type _CommittedCannotReportOutcomeUnknown = Assert<
  Withholds<SessionAgentTransitionCurrentViewCommitted, 'outcomeUnknown'>
>;

/* --------------------------------------------------------------------- *
 * Both fenced exits are async because both reopen the fence first. A
 * synchronous fenced exit would be one a call site could take without the
 * reopen, which is the eighth instance exactly.
 * --------------------------------------------------------------------- */

type IsPromise<T> = [T] extends [Promise<unknown>] ? true : false;

type _FencedRejectionReopensFirst = Assert<
  IsPromise<ReturnType<SessionAgentTransitionSourceFenced['rejected']>>
>;
type _FencedUnknownReopensFirst = Assert<
  IsPromise<ReturnType<SessionAgentTransitionSourceFenced['outcomeUnknown']>>
>;

export type {};
