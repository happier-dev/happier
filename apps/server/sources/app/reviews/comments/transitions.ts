import {
    ReviewCommentV1Schema,
    reviewCommentStateTransitionRequiresEvidenceV1,
    type ReviewCommentEvidenceV1,
    type ReviewCommentStateV1,
    type ReviewCommentTransitionV1,
    type ReviewCommentV1,
} from "@happier-dev/protocol";

import { ReviewCommentOperationError } from "./errors";

const ALLOWED_TRANSITIONS: Readonly<Record<ReviewCommentStateV1, readonly ReviewCommentStateV1[]>> = Object.freeze({
    proposed: ["open", "dismissed"],
    open: ["delegated", "pending_review", "resolved", "dismissed"],
    delegated: ["open", "pending_review", "resolved", "dismissed"],
    pending_review: ["open", "resolved", "dismissed"],
    resolved: ["open"],
    dismissed: ["open"],
});

export function assertReviewCommentTransitionAllowed(
    fromState: ReviewCommentStateV1,
    toState: ReviewCommentStateV1,
): void {
    if (!ALLOWED_TRANSITIONS[fromState].includes(toState)) {
        throw new ReviewCommentOperationError(
            "review_comment_invalid_transition",
            `Cannot transition review comment from ${fromState} to ${toState}`,
        );
    }
}

export function assertReviewCommentTransitionEvidence(
    toState: ReviewCommentStateV1,
    evidence: readonly ReviewCommentEvidenceV1[] | undefined,
    reason?: string,
): void {
    if (reviewCommentStateTransitionRequiresEvidenceV1(toState) && !reason && (!evidence || evidence.length === 0)) {
        throw new ReviewCommentOperationError(
            "review_comment_invalid_transition",
            `${toState} requires evidence or reason`,
        );
    }
}

export function appendReviewCommentTransition(params: Readonly<{
    comment: ReviewCommentV1;
    transition: ReviewCommentTransitionV1;
    updatedAt: number;
}>): ReviewCommentV1 {
    return ReviewCommentV1Schema.parse({
        ...params.comment,
        state: params.transition.toState,
        updatedAt: params.updatedAt,
        serverRevision: params.comment.serverRevision + 1,
        transitions: [...params.comment.transitions, params.transition],
    });
}
