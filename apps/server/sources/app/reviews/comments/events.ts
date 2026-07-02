import {
    ReviewCommentEventV1Schema,
    type ReviewCommentActorRefV1,
    type ReviewCommentEventV1,
} from "@happier-dev/protocol";

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
        authorDeviceId: params.authorDeviceId,
        clientLamport: params.clientLamport,
        event: {
            ...params.event,
            clientMutationId: params.clientMutationId,
        },
    });
}
