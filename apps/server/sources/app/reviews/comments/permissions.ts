import { REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1, type ReviewCommentActorRefV1, type ReviewCommentStateV1, type ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import { type ReviewCommentCurrentIntentV1 } from '@happier-dev/protocol/reviews/comments/actions';
import { isWorkflowSessionScopeTargetV1, type ReviewCommentPrincipalHeaderV1 } from '@happier-dev/protocol/reviews/comments/actions';
import { type ReviewCommentStoredSourceV1, reviewCommentActorsEqualV1 } from '@happier-dev/protocol/reviews/comments/mutation';

import type { AccountEncryptionCurrentness } from "@/app/encryption/accountContentKeyAdmission";
import { ReviewCommentOperationError } from "./errors";
import type { ReviewAccessCapability } from '../reviewAccess';
export type { ReviewAccessCapability } from '../reviewAccess';

export type ReviewCommentPrincipal = Readonly<{
    accountId: string;
    reviewAccess?: ReviewAccessCapability;
    actor: ReviewCommentActorRefV1;
    grants?: readonly string[];
    currentIntent?: ReviewCommentCurrentIntentV1;
    storageMode?: "plain" | "e2ee";
    accountVersion?: number;
    accountEncryptionCurrentness?: AccountEncryptionCurrentness;
    workflowOriginSessionId?: string;
    workflowScope?: ReviewCommentPrincipalHeaderV1["workflowScope"];
    /** Current readable subtree proved by the server's Session relation owner. */
    ledSubtreeSessionIds?: readonly string[];
}>;

/** Ordinary CRUD consumes the admitted mode; legacy private rows belong to Account migration. */
export function assertReviewCommentOrdinarySourceAdmission(source: ReviewCommentStoredSourceV1, mode: "plain" | "e2ee"): void {
    const actualMode = source.source.layout === "canonical_v1"
        ? source.source.envelope.t === "plain" ? "plain" : "e2ee"
        : source.source.sourceMode;
    if (actualMode !== mode || (mode === "e2ee" && source.source.layout !== "canonical_v1")) {
        throw new ReviewCommentOperationError("review_comment_encryption_mode_mismatch", "Review Comment content does not match its admitted encryption mode");
    }
}

export function reviewCommentPrincipalSessionId(principal: Pick<ReviewCommentPrincipal, "actor" | "workflowOriginSessionId" | "workflowScope" | "reviewAccess">): string | undefined {
    if (principal.reviewAccess) return undefined;
    if (principal.actor.kind === "agent") return principal.actor.sessionId;
    if (principal.actor.kind === "workflow") {
        if (principal.workflowScope?.sessions.length === 1) return principal.workflowScope.sessions[0]!.sessionId;
        if (principal.workflowOriginSessionId) return principal.workflowOriginSessionId;
        throw new ReviewCommentOperationError("review_comment_permission_denied", "Workflow review scope requires its server-owned origin Session");
    }
    return undefined;
}

export function assertReviewCommentSessionScope(principal: Pick<ReviewCommentPrincipal, "actor" | "workflowOriginSessionId" | "workflowScope" | "ledSubtreeSessionIds" | "reviewAccess">, sessionId: string | undefined): void {
    if (principal.reviewAccess) return;
    if (principal.actor.kind === "workflow") {
        if (isWorkflowSessionScopeTargetV1({ originSessionId: principal.workflowOriginSessionId,
            scope: principal.workflowScope, sessionId })) return;
        throw new ReviewCommentOperationError("review_comment_permission_denied", "Review comment is outside the admitted Workflow invocation scope");
    }
    const ownSessionId = reviewCommentPrincipalSessionId(principal);
    if (ownSessionId && ownSessionId !== sessionId
        && !(principal.actor.kind === "agent" && sessionId && principal.ledSubtreeSessionIds?.includes(sessionId))) {
        throw new ReviewCommentOperationError("review_comment_permission_denied", "Review comment is outside the principal Session scope");
    }
}

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

export function isSameReviewCommentActor(left: ReviewCommentActorRefV1, right: ReviewCommentActorRefV1): boolean {
    return reviewCommentActorsEqualV1(left, right);
}

export function assertReviewCommentUserOrOriginalAuthor(params: Readonly<{
    actor: ReviewCommentActorRefV1;
    reviewAccess?: ReviewAccessCapability;
    comment: Pick<ReviewCommentV1, "author">;
}>): void {
    if ((!params.reviewAccess && params.actor.kind === "user") || isSameReviewCommentActor(params.actor, params.comment.author)) {
        return;
    }
    throw new ReviewCommentOperationError(
        "review_comment_permission_denied",
        "Only the original author may change this Review comment",
    );
}

export function assertReviewCommentTransitionActorAllowed(params: Readonly<{
    actor: ReviewCommentActorRefV1;
    reviewAccess?: ReviewAccessCapability;
    comment: Pick<ReviewCommentV1, "author" | "sessionId">;
    fromState: ReviewCommentStateV1;
    toState: ReviewCommentStateV1;
    workflowOriginSessionId?: string;
    workflowScope?: ReviewCommentPrincipalHeaderV1["workflowScope"];
    ledSubtreeSessionIds?: readonly string[];
}>): void {
    if (params.reviewAccess) {
        if (params.reviewAccess.level === "view") throw new ReviewCommentOperationError("review_comment_permission_denied", "Review Edit access is required to decide findings");
        return;
    }
    if (params.actor.kind === "user") return;
    if (params.actor.kind === "agent" || params.actor.kind === "workflow") {
        assertReviewCommentSessionScope(params, params.comment.sessionId);
        return;
    }
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

export function assertReviewCommentRedactionActorAllowed(actor: ReviewCommentActorRefV1, reviewAccess?: ReviewAccessCapability, author?: ReviewCommentActorRefV1): void {
    if (reviewAccess) {
        if (reviewAccess.level === "view" && (!author || !isSameReviewCommentActor(actor, author))) throw new ReviewCommentOperationError("review_comment_permission_denied", "Review Edit access is required to redact another author's comment");
        return;
    }
    if (actor.kind === "user") return;
    throw new ReviewCommentOperationError(
        "review_comment_permission_denied",
        "Only user principals may redact review comments",
    );
}

export function formatReviewCommentActorDispositionKey(actor: ReviewCommentActorRefV1): string {
    if (actor.kind === "plugin") return `plugin:${actor.pluginId}`;
    if (actor.kind === "agent") return `agent:${actor.agentId}:${actor.sessionId}`;
    if (actor.kind === "workflow") return `workflow:${actor.runId}`;
    return `user:${actor.userId}`;
}
