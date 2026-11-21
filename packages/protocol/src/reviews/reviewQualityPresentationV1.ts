import type { ReviewRoundQualityV1, ReviewRoundReviewerQualityV1 } from './reviewArtifactV1.js';

type ReviewerScore = Pick<ReviewRoundReviewerQualityV1, 'displayName' | 'score'>;
export type ReviewRoundQualityScoresV1<Reviewer extends ReviewerScore = ReviewerScore> = Readonly<
  Pick<ReviewRoundQualityV1, 'aggregation' | 'score'> & { reviewers: readonly Reviewer[] }
>;

export type ReviewPrRoundQualityV1 = Readonly<ReviewRoundQualityScoresV1 & { roundOrdinal: number }>;

export type ReviewRoundQualityPresentationV1<Reviewer extends ReviewerScore = ReviewerScore> = Readonly<
  Pick<ReviewRoundQualityScoresV1<Reviewer>, 'aggregation' | 'reviewers'> & { displayScore: number }
>;

/** The display score uses nearest-integer rounding, with ties going to the lower score. */
export function presentReviewRoundQualityV1<Reviewer extends ReviewerScore>(
  quality: ReviewRoundQualityScoresV1<Reviewer>,
): ReviewRoundQualityPresentationV1<Reviewer>;
export function presentReviewRoundQualityV1<Reviewer extends ReviewerScore>(
  quality: ReviewRoundQualityScoresV1<Reviewer> | null,
): ReviewRoundQualityPresentationV1<Reviewer> | null;
export function presentReviewRoundQualityV1<Reviewer extends ReviewerScore>(
  quality: ReviewRoundQualityScoresV1<Reviewer> | null,
): ReviewRoundQualityPresentationV1<Reviewer> | null {
  if (quality === null) return null;
  return { aggregation: quality.aggregation, displayScore: Math.ceil(quality.score - 0.5), reviewers: quality.reviewers };
}
