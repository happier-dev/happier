import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import { reviewCommentFindingScopeV1 } from '@happier-dev/protocol/reviews/comments/findingIdentity';
import { sortReviewFindingRows } from '@/components/sessions/reviews/findings/reviewFindingsMerge';

/** Durable roots and sealed payloads shared by native detail and embedded summaries. */
export function projectReviewFindingRoots(reviewId: string, comments: readonly ReviewCommentV1[]): Readonly<{
    roots: readonly ReviewCommentV1[];
    rows: readonly Readonly<{ rowId: string; finding: NonNullable<ReviewCommentV1['finding']>; comment: ReviewCommentV1 }>[];
    unavailableFindings: readonly ReviewCommentV1[];
}> {
    const roots = comments.filter(comment => {
        const identity = reviewCommentFindingScopeV1(comment);
        return identity?.[0] === 'review' && identity[1] === reviewId;
    });
    return {
        roots,
        rows: sortReviewFindingRows(roots.flatMap(comment => comment.finding
            ? [{ rowId: comment.id, finding: comment.finding, comment }] : [])),
        unavailableFindings: roots.filter(comment => !comment.finding),
    };
}
