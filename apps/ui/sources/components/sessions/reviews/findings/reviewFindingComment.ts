import type { ReviewCommentV1, ReviewFinding } from '@happier-dev/protocol';

import type { ReviewFindingDecision } from './ReviewFindingRow';

/** The durable comment a finding materialized into: its reference first, else its run-scoped id. */
export function findCommentForFinding(
    comments: readonly ReviewCommentV1[],
    finding: ReviewFinding,
    runId: string,
): ReviewCommentV1 | null {
    const referencedId = finding.comment?.id;
    if (referencedId) {
        const referenced = comments.find((comment) => comment.id === referencedId);
        if (referenced) return referenced;
    }
    return comments.find((comment) => comment.runId === runId && comment.findingId === finding.id && !comment.parentCommentId) ?? null;
}

export function readReviewFindingDecision(status: ReviewCommentV1['reviewTriageStatus'] | undefined): ReviewFindingDecision | 'undecided' {
    return status === 'accept' || status === 'reject' || status === 'defer' ? status : 'undecided';
}
