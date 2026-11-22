import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';

/** The hosted Files, Walkthrough and sealed excerpts share the opened round's comment projection. */
export function filterReviewChangesComments(comments: readonly ReviewCommentV1[], selection: Readonly<{
  roundOrdinal: number;
  reviewerId: string | null;
}>): readonly ReviewCommentV1[] {
  return comments.filter(comment => (selection.reviewerId === null || comment.engineId === selection.reviewerId)
    && (comment.appearances?.some(appearance => appearance.roundOrdinal === selection.roundOrdinal)
      || comment.roundOrdinal === selection.roundOrdinal));
}
