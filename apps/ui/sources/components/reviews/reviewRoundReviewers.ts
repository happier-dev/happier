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
  /** How it ended, when the round's record or its run proves it; `null` when nothing does yet. */
  outcome: ReviewRoundReviewerOutcome | null;
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
 * Each reviewer of a round with how it ended, as far as the round proves it. A completed round means every reviewer
 * finished, and a failed or cancelled one that none did; a reviewer that recorded its score finished; a run read that
 * reached its end says how that run ended. A run read that still says "running" after the round settled is not an
 * outcome (a continued review's run stays alive), and a partial round does not say which of its reviewers fell short:
 * those reviewers carry no outcome until the round's record names one per reviewer (owed by round settlement, P02).
 * A round's runs keep its reviewers' order.
 */
export function projectReviewRoundReviewers(
  round: Pick<ReviewRound, 'state' | 'reviewerIds' | 'reviewerDisplayNames' | 'reviewerQuality' | 'runs'>,
  reads: ReadonlyMap<string, ReviewRoundReviewerRead> | undefined,
): readonly ReviewRoundReviewer[] {
  const scored = new Set(round.reviewerQuality?.map(reviewer => reviewer.reviewerId) ?? []);
  return round.reviewerIds.map((reviewerId, index) => {
    const reference = round.runs[index];
    const read = reference?.kind === 'execution' ? reads?.get(reference.runId) ?? null : null;
    const status = read?.run?.status ?? null;
    const ended: ReviewRoundReviewerOutcome | null = status === null || status === 'running' ? null
      : status === 'succeeded' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed';
    const outcome: ReviewRoundReviewerOutcome | null = round.state === 'running' ? ended ?? 'running'
      : round.state === 'partial' ? (scored.has(reviewerId) ? 'completed' : ended)
        : round.state;
    return { reviewerId, name: reviewRoundReviewerName(round, reviewerId), outcome,
      findingsCount: read?.findingsCount ?? null, run: read?.run ?? null };
  });
}
