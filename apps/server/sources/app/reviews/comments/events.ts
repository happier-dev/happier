import {
    bindReviewCommentEventSensitiveEnvelopeV1,
    BoundReviewCommentEventSensitiveEnvelopeV1Schema,
    ReviewCommentEventRequestBindingV1Schema,
    ReviewCommentEventV1Schema,
    openReviewCommentEventSensitiveEnvelopeV1,
    sealReviewCommentEventSensitiveEnvelopeV1,
    StoredJsonContentEnvelopeSchema,
    reviewCommentEventSensitiveBindingMatchesV1,
    type BoundReviewCommentEventSensitiveEnvelopeV1,
    type ReviewCommentActorRefV1,
    type ReviewCommentEventV1,
    type ReviewCommentEventRequestBindingV1,
    type StoredJsonContentEnvelope,
} from "@happier-dev/protocol";

import { ReviewCommentOperationError } from "./errors";

export type ReviewCommentEventRuntime = Readonly<{
    now(): number;
    createId(prefix: string): string;
}>;

export function buildReviewCommentEvent(params: Readonly<{
    runtime: ReviewCommentEventRuntime;
    accountId: string;
    projectId: string;
    commentId: string;
    actor: ReviewCommentActorRefV1;
    serverRevision: number;
    eventKind: ReviewCommentEventV1["eventKind"];
    event: Record<string, unknown>;
    bulkActionId?: string;
    clientMutationId?: string;
    authorDeviceId?: string;
    clientLamport?: number;
}>): ReviewCommentEventV1 {
    return ReviewCommentEventV1Schema.parse({
        eventId: params.runtime.createId("review-comment-event"),
        commentId: params.commentId,
        accountId: params.accountId,
        projectId: params.projectId,
        eventKind: params.eventKind,
        actor: params.actor,
        createdAt: params.runtime.now(),
        serverRevision: params.serverRevision,
        bulkActionId: params.bulkActionId,
        authorDeviceId: params.authorDeviceId,
        clientLamport: params.clientLamport,
        event: {
            ...params.event,
            clientMutationId: params.clientMutationId,
        },
    });
}

export function bindReviewCommentEventSensitiveForStorage(params: Readonly<{
    event: ReviewCommentEventV1;
    requestBinding: ReviewCommentEventRequestBindingV1;
    storageMode: "plain" | "e2ee";
    eventEnvelope?: StoredJsonContentEnvelope;
}>): BoundReviewCommentEventSensitiveEnvelopeV1 {
    const event = ReviewCommentEventV1Schema.parse(params.event);
    let sensitive: StoredJsonContentEnvelope;
    if (params.eventEnvelope) {
        sensitive = StoredJsonContentEnvelopeSchema.parse(params.eventEnvelope);
    } else if (params.storageMode === "plain") {
        sensitive = sealReviewCommentEventSensitiveEnvelopeV1({
            mode: "plain",
            payload: {
                v: 1,
                requestBinding: params.requestBinding,
                details: event.event,
            },
        });
    } else {
        throw new ReviewCommentOperationError(
            "review_comment_encryption_mode_mismatch",
            "Review comment event-sensitive content must be encrypted for e2ee storage mode",
        );
    }
    if (
        (params.storageMode === "plain" && sensitive.t !== "plain")
        || (params.storageMode === "e2ee" && sensitive.t !== "encrypted")
    ) {
        throw new ReviewCommentOperationError(
            "review_comment_encryption_mode_mismatch",
            `Review comment event-sensitive envelope does not match ${params.storageMode} storage mode`,
        );
    }
    const bound = bindReviewCommentEventSensitiveEnvelopeV1({
        event,
        requestBinding: ReviewCommentEventRequestBindingV1Schema.parse(params.requestBinding),
        sensitive,
    });
    if (sensitive.t === "plain") {
        const opened = openReviewCommentEventSensitiveEnvelopeV1({
            event,
            bound,
            mode: "plain",
        });
        if (opened.status !== "available") {
            throw new ReviewCommentOperationError(
                "review_comment_invalid_request",
                "Review comment event request binding does not match the verified mutation",
            );
        }
    }
    return bound;
}

export function decodeReviewCommentEventSensitiveFromStorage(params: Readonly<{
    event: ReviewCommentEventV1;
    stored: BoundReviewCommentEventSensitiveEnvelopeV1;
}>): ReviewCommentEventV1 {
    const event = ReviewCommentEventV1Schema.parse(params.event);
    const stored = BoundReviewCommentEventSensitiveEnvelopeV1Schema.parse(params.stored);
    if (!reviewCommentEventSensitiveBindingMatchesV1({ event, bound: stored })) {
        throw new Error("review_comment_event_binding_mismatch");
    }
    if (stored.sensitive.t === "encrypted") {
        return ReviewCommentEventV1Schema.parse({
            ...event,
            event: {
                ...event.event,
                sensitiveEnvelope: stored.sensitive,
            },
        });
    }
    const opened = openReviewCommentEventSensitiveEnvelopeV1({
        event,
        bound: stored,
        mode: "plain",
    });
    if (opened.status !== "available") {
        throw new Error("review_comment_event_binding_mismatch");
    }
    return opened.event;
}
