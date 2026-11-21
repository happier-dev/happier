import type { ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ReviewArtifactV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import type { ReviewVerdictKindV1 } from '@happier-dev/protocol/reviews/reviewHumanV1';
import {
  readReviewFindingDecisionV1,
  type ReviewFindingDecisionV1,
} from '@happier-dev/protocol/reviews/reviewTriageStatus';

type Round = Pick<
  ReviewArtifactV1['rounds'][number],
  'ordinal' | 'state' | 'startedAt' | 'finishedAt'
>;
type RunRead = Readonly<{
  runId: string;
  status: ExecutionRunPublicState['status'];
  finishedAtMs?: number;
  findingsCount: number | null;
  backendTarget: ExecutionRunPublicState['backendTarget'];
}>;

/** Who did it: a person (the viewer reads "You"), an Agent acting in a session, or a reviewer run. */
export type ReviewActivityActor =
  | Readonly<{ kind: 'account'; accountId: string }>
  | Readonly<{ kind: 'agent'; agentId: string }>
  | Readonly<{
      kind: 'run';
      backendTarget: ExecutionRunPublicState['backendTarget'];
    }>;

export type ReviewActivityEvent = Readonly<{
  id: string;
  at: number;
  actor: ReviewActivityActor | null;
}> &
  (
    | Readonly<{
        kind: 'decided';
        title: string;
        decision: ReviewFindingDecisionV1;
      }>
    | Readonly<{ kind: 'fixed'; title: string }>
    | Readonly<{ kind: 'verdict'; verdict: ReviewVerdictKindV1 }>
    | Readonly<{ kind: 'runFinished'; findingsCount: number | null }>
    | Readonly<{ kind: 'runDidntFinish' }>
    | Readonly<{
        kind: 'roundStarted' | 'roundFinished';
        round: number;
        state: Round['state'];
      }>
  );

function actorOf(ref: ReviewCommentV1['author']): ReviewActivityActor | null {
  if (ref.kind === 'user') return { kind: 'account', accountId: ref.userId };
  if (ref.kind === 'agent') return { kind: 'agent', agentId: ref.agentId };
  return null;
}

/**
 * The Review's Events feed (plan 04 C, lab `detail-activity`): who did what and when, newest first. A person's
 * decision, a fix landing, a verdict, each reviewer run of the opened round ending, and each round starting and
 * ending. A finding's own history across runs stays on its row; a workflow proposing findings is its run's event.
 */
export function projectReviewActivity(
  input: Readonly<{
    rounds: readonly Round[];
    comments: readonly ReviewCommentV1[];
    verdicts: readonly Readonly<{
      accountId: string;
      roundOrdinal: number;
      verdict: ReviewVerdictKindV1;
      submittedAt: number;
    }>[];
    runs: readonly RunRead[];
  }>,
): readonly ReviewActivityEvent[] {
  const events: ReviewActivityEvent[] = [];
  for (const round of input.rounds) {
    events.push({
      id: `round:${round.ordinal}:start`,
      at: round.startedAt,
      actor: null,
      kind: 'roundStarted',
      round: round.ordinal,
      state: round.state,
    });
    if (round.finishedAt !== null)
      events.push({
        id: `round:${round.ordinal}:end`,
        at: round.finishedAt,
        actor: null,
        kind: 'roundFinished',
        round: round.ordinal,
        state: round.state,
      });
  }
  for (const comment of input.comments) {
    const title = comment.finding?.title;
    if (!title) continue;
    for (const transition of comment.transitions) {
      const actor = actorOf(transition.transitionedBy);
      if (!actor) continue;
      const base = {
        id: `transition:${transition.transitionId}`,
        at: transition.transitionedAt,
        actor,
      };
      if (transition.toState === 'resolved')
        events.push({ ...base, kind: 'fixed', title });
      else {
        const decision = readReviewFindingDecisionV1(
          transition.reviewTriageStatus,
          transition.toState,
        );
        if (decision !== 'undecided')
          events.push({ ...base, kind: 'decided', title, decision });
      }
    }
  }
  for (const verdict of input.verdicts) {
    events.push({
      id: `verdict:${verdict.roundOrdinal}:${verdict.accountId}`,
      at: verdict.submittedAt,
      actor: { kind: 'account', accountId: verdict.accountId },
      kind: 'verdict',
      verdict: verdict.verdict,
    });
  }
  for (const run of input.runs) {
    if (run.status === 'running' || run.finishedAtMs === undefined) continue;
    const base = {
      id: `run:${run.runId}`,
      at: run.finishedAtMs,
      actor: { kind: 'run' as const, backendTarget: run.backendTarget },
    };
    events.push(
      run.status === 'succeeded'
        ? { ...base, kind: 'runFinished', findingsCount: run.findingsCount }
        : { ...base, kind: 'runDidntFinish' },
    );
  }
  return events.sort((left, right) => right.at - left.at);
}
