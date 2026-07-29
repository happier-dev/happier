import {
    REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
    type ReviewCommentActorRefV1,
    type ReviewCommentCurrentIntentV1,
    type ReviewCommentStateV1,
    type ReviewCommentV1,
} from "@happier-dev/protocol";

import { ReviewCommentOperationError } from "./errors";

export type ReviewCommentPrincipal = Readonly<{
    accountId: string;
    actor: ReviewCommentActorRefV1;
    grants?: readonly string[];
    currentIntent?: ReviewCommentCurrentIntentV1;
    storageMode?: "plain" | "e2ee";
}>;

export function hasReviewCommentDirectWriteGrant(params: ReviewCommentPrincipal): boolean {
    return params.grants?.includes(REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1) === true;
}

export function assertReviewCommentDirectWriteGrant(params: ReviewCommentPrincipal): void {
    if (!hasReviewCommentDirectWriteGrant(params)) {
        throw new ReviewCommentOperationError(
            "review_comment_direct_write_permission_required",
            "reviews.comments.write.direct is required for direct review-comment writes",
        );
    }
}

export function assertReviewCommentPlainWriteStorageMode(params: ReviewCommentPrincipal): void {
    if ((params.storageMode ?? "plain") === "plain") return;
    throw new ReviewCommentOperationError(
        "review_comment_encryption_mode_mismatch",
        "Durable review comments cannot persist plain body, snapshot, or event envelopes for e2ee accounts",
    );
}

export function isSameReviewCommentActor(left: ReviewCommentActorRefV1, right: ReviewCommentActorRefV1): boolean {
    if (left.kind === "user" && right.kind === "user") return left.userId === right.userId;
    if (left.kind === "plugin" && right.kind === "plugin") return left.pluginId === right.pluginId;
    if (left.kind === "agent" && right.kind === "agent") {
        return left.agentId === right.agentId && left.sessionId === right.sessionId;
    }
    return false;
}

export function assertReviewCommentUserOrOriginalAuthor(params: Readonly<{
    actor: ReviewCommentActorRefV1;
    comment: ReviewCommentV1;
}>): void {
    if (params.actor.kind === "user" || isSameReviewCommentActor(params.actor, params.comment.author)) {
        return;
    }
    throw new ReviewCommentOperationError(
        "review_comment_permission_denied",
        "Only user principals and original authors may mutate this review comment",
    );
}

export function assertReviewCommentTransitionActorAllowed(params: Readonly<{
    actor: ReviewCommentActorRefV1;
    comment: ReviewCommentV1;
    fromState: ReviewCommentStateV1;
    toState: ReviewCommentStateV1;
}>): void {
    if (params.actor.kind === "user") return;
    if (
        params.fromState === "delegated"
        && (params.toState === "pending_review" || params.toState === "resolved")
        && isSameReviewCommentActor(params.actor, params.comment.author)
    ) {
        return;
    }
    throw new ReviewCommentOperationError(
        "review_comment_permission_denied",
        "Only user principals may moderate review-comment state",
    );
}

export function assertReviewCommentRedactionActorAllowed(actor: ReviewCommentActorRefV1): void {
    if (actor.kind === "user") return;
    throw new ReviewCommentOperationError(
        "review_comment_permission_denied",
        "Only user principals may redact review comments",
    );
}

export function formatReviewCommentActorDispositionKey(actor: ReviewCommentActorRefV1): string {
    if (actor.kind === "plugin") return `plugin:${actor.pluginId}`;
    if (actor.kind === "agent") return `agent:${actor.agentId}:${actor.sessionId}`;
    return `user:${actor.userId}`;
}
