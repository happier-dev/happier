import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
export { findReviewCommentForFindingV1 as findCommentForFinding } from '@happier-dev/protocol/reviews/reviewFindingsApplyInputV1';

import type { ReviewFindingDecision } from './ReviewFindingRow';

export function readReviewFindingDecision(status: ReviewCommentV1['reviewTriageStatus'] | undefined): ReviewFindingDecision | 'undecided' {
    return status === 'accept' || status === 'reject' || status === 'defer' ? status : 'undecided';
}
