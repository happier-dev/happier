import type { ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ReviewArtifactV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';

import { t } from '@/text';

type ReviewRound = ReviewArtifactV1['rounds'][number];

/** How one reviewer of a round ended, as the page says it beside its name. */
export type ReviewRoundReviewerOutcome =
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type ReviewRoundReviewer = Readonly<{
  reviewerId: string;
  name: string;
  /** Settled result from the round, or progress from its execution while the round remains open. */
  outcome: ReviewRoundReviewerOutcome;
  runId?: string;
  startedAt?: number;
  finishedAt?: number;
  /** Findings its run reported, when its Machine answered for it. */
  findingsCount: number | null;
  /** Its run as its Machine last answered (Agent and model), when read. */
  run: ExecutionRunPublicState | null;
}>;

/** One reviewer run's last read, keyed by run id (`useReviewQuestionRuns`). */
export type ReviewRoundReviewerRead = Readonly<{
  run: ExecutionRunPublicState | null;
  findingsCount: number | null;
}>;

const OUTCOME_KEYS = {
  running: 'reviewWalkthrough.collection.stateRunning',
  completed: 'reviewWalkthrough.collection.stateCompleted',
  partial: 'reviewWalkthrough.collection.statePartial',
  failed: 'reviewWalkthrough.collection.stateFailed',
  cancelled: 'reviewWalkthrough.collection.stateCancelled',
} as const satisfies Record<ReviewRoundReviewerOutcome, string>;

export function reviewRoundReviewerOutcomeLabel(outcome: ReviewRoundReviewerOutcome): string {
  return t(OUTCOME_KEYS[outcome]);
}

/**
 * A round's reviewer by name: the name the round recorded for it, else "Reviewer N" by its place in the round.
 * Its positional id ("step-1-reviewer-1") is an internal key and is never shown.
 */
export function reviewRoundReviewerName(
  round: Pick<ReviewRound, 'reviewerIds' | 'reviewerDisplayNames'>,
  reviewerId: string,
): string {
  const name = round.reviewerDisplayNames?.[reviewerId];
  if (name) return name;
  const index = round.reviewerIds.indexOf(reviewerId);
  return t('reviewWalkthrough.detail.reviewerRun', {
    count: index >= 0 ? index + 1 : 1,
  });
}

/**
 * Settlement owns individual results and timing. Continued executions can outlive a round, so their current state
 * supplies progress only while the round is open. Historical settled rounds without individual records stay aggregate-only.
 */
export function projectReviewRoundReviewers(
  round: Pick<ReviewRound, 'state' | 'reviewerIds' | 'reviewerDisplayNames' | 'reviewerOutcomes' | 'runs'>,
  reads: ReadonlyMap<string, ReviewRoundReviewerRead> | undefined,
): readonly ReviewRoundReviewer[] {
  if (round.state !== 'running') return (round.reviewerOutcomes ?? []).map(reviewer => ({
    reviewerId: reviewer.reviewerId, name: reviewer.displayName ?? reviewRoundReviewerName(round, reviewer.reviewerId),
    outcome: reviewer.outcome, runId: reviewer.runId, startedAt: reviewer.startedAt, finishedAt: reviewer.finishedAt,
    findingsCount: null, run: null,
  }));
  return round.reviewerIds.map((reviewerId, index) => {
    const reference = round.runs[index];
    const read = reference?.kind === 'execution' ? reads?.get(reference.runId) ?? null : null;
    const status = read?.run?.status ?? null;
    const ended: ReviewRoundReviewerOutcome | null = status === null || status === 'running' ? null
      : status === 'succeeded' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed';
    return { reviewerId, name: reviewRoundReviewerName(round, reviewerId), outcome: ended ?? 'running',
      runId: reference?.runId, startedAt: read?.run?.startedAtMs, finishedAt: read?.run?.finishedAtMs,
      findingsCount: read?.findingsCount ?? null, run: read?.run ?? null };
  });
}
