import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import { readReviewFindingDecisionV1 } from '@happier-dev/protocol/reviews/reviewTriageStatus';
export { findReviewCommentForFindingV1 as findCommentForFinding } from '@happier-dev/protocol/reviews/reviewFindingsApplyInputV1';

import type { ReviewFindingDecision } from './ReviewFindingRow';

export function readReviewFindingDecision(
    status: ReviewCommentV1['reviewTriageStatus'],
    state?: ReviewCommentV1['state'],
    pendingDecision?: ReviewCommentV1['reviewTriageStatus'],
): ReviewFindingDecision | 'undecided' {
    return readReviewFindingDecisionV1(status, state, pendingDecision);
}
