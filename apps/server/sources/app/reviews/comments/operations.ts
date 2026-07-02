import {
    ReviewCommentV1Schema,
    type ReviewCommentActorRefV1,
    type ReviewCommentAttachEvidenceRequestV1,
    type ReviewCommentAttachEvidenceResponseV1,
    type ReviewCommentBulkTransitionRequestV1,
    type ReviewCommentBulkTransitionResponseV1,
    type ReviewCommentCreateRequestV1,
    type ReviewCommentCreateResponseV1,
    type ReviewCommentEditRequestV1,
    type ReviewCommentEditResponseV1,
    type ReviewCommentGetRequestV1,
    type ReviewCommentGetResponseV1,
    type ReviewCommentListRequestV1,
    type ReviewCommentListResponseV1,
    type ReviewCommentRedactRequestV1,
    type ReviewCommentRedactResponseV1,
    type ReviewCommentReplyRequestV1,
    type ReviewCommentReplyResponseV1,
    type ReviewCommentSetDispositionRequestV1,
    type ReviewCommentSetDispositionResponseV1,
    type ReviewCommentStateV1,
    type ReviewCommentTransitionRequestV1,
    type ReviewCommentTransitionResponseV1,
    type ReviewCommentTransitionV1,
    type ReviewCommentV1,
    StoredJsonContentEnvelopeSchema,
} from "@happier-dev/protocol";

import { ReviewCommentOperationError } from "./errors";
import { buildReviewCommentEvent } from "./events";
import {
    assertReviewCommentDirectWriteGrant,
    assertReviewCommentRedactionActorAllowed,
    assertReviewCommentTransitionActorAllowed,
    assertReviewCommentUserOrOriginalAuthor,
    formatReviewCommentActorDispositionKey,
    isSameReviewCommentActor,
    type ReviewCommentPrincipal,
} from "./permissions";
import { validateReviewCommentSnapshot } from "./snapshots";
import type { ReviewCommentStore } from "./store";
import {
    appendReviewCommentTransition,
    assertReviewCommentTransitionAllowed,
    assertReviewCommentTransitionEvidence,
} from "./transitions";

export type ReviewCommentOperationRuntime = Readonly<{
    now(): number;
    createId(prefix: string): string;
}>;

export type ReviewCommentCreateOperationParams = ReviewCommentPrincipal & Readonly<{
    input: ReviewCommentCreateRequestV1;
}>;

export type ReviewCommentGetOperationParams = Readonly<{
    accountId: string;
    input: ReviewCommentGetRequestV1;
}>;

export type ReviewCommentListOperationParams = Readonly<{
    accountId: string;
    input: ReviewCommentListRequestV1;
}>;

export type ReviewCommentMutationOperationParams<TInput> = ReviewCommentPrincipal & Readonly<{
    input: TInput;
}>;

export interface ReviewCommentOperations {
    create(params: ReviewCommentCreateOperationParams): Promise<ReviewCommentCreateResponseV1>;
    list(params: ReviewCommentListOperationParams): Promise<ReviewCommentListResponseV1>;
    get(params: ReviewCommentGetOperationParams): Promise<ReviewCommentGetResponseV1>;
    transition(params: ReviewCommentMutationOperationParams<ReviewCommentTransitionRequestV1>): Promise<ReviewCommentTransitionResponseV1>;
    edit(params: ReviewCommentMutationOperationParams<ReviewCommentEditRequestV1>): Promise<ReviewCommentEditResponseV1>;
    reply(params: ReviewCommentMutationOperationParams<ReviewCommentReplyRequestV1>): Promise<ReviewCommentReplyResponseV1>;
    redact(params: ReviewCommentMutationOperationParams<ReviewCommentRedactRequestV1>): Promise<ReviewCommentRedactResponseV1>;
    setDisposition(params: ReviewCommentMutationOperationParams<ReviewCommentSetDispositionRequestV1>): Promise<ReviewCommentSetDispositionResponseV1>;
    attachEvidence(params: ReviewCommentMutationOperationParams<ReviewCommentAttachEvidenceRequestV1>): Promise<ReviewCommentAttachEvidenceResponseV1>;
    bulkTransition(params: ReviewCommentMutationOperationParams<ReviewCommentBulkTransitionRequestV1>): Promise<ReviewCommentBulkTransitionResponseV1>;
}

async function requireComment(store: ReviewCommentStore, accountId: string, commentId: string): Promise<ReviewCommentV1> {
    const comment = await store.get({ accountId, commentId });
    if (!comment) {
        throw new ReviewCommentOperationError("review_comment_not_found", `Review comment not found: ${commentId}`);
    }
    return comment;
}

function assertReviewCommentEditActorAllowed(params: Readonly<{
    actor: ReviewCommentActorRefV1;
    comment: ReviewCommentV1;
}>): void {
    if (params.comment.flags.redacted) {
        throw new ReviewCommentOperationError("review_comment_permission_denied", "Redacted review comments cannot be edited");
    }
    if (params.actor.kind === "user" || isSameReviewCommentActor(params.actor, params.comment.author)) {
        return;
    }
    throw new ReviewCommentOperationError(
        "review_comment_permission_denied",
        "Only users and original authors may edit review comments",
    );
}

function assertReviewCommentReplyAllowed(parent: ReviewCommentV1): void {
    if (parent.flags.redacted || parent.state === "resolved" || parent.state === "dismissed") {
        throw new ReviewCommentOperationError(
            "review_comment_thread_closed",
            "Review comment thread is closed",
        );
    }
}

function redactedBodyForStorage(current: ReviewCommentV1, redactBody: boolean | undefined): ReviewCommentV1["body"] {
    if (redactBody === false) return current.body;
    const envelope = StoredJsonContentEnvelopeSchema.safeParse(current.body);
    if (envelope.success && envelope.data.t === "encrypted") {
        return current.body;
    }
    return "";
}

function assertValidReviewCommentSnapshot(snapshot: ReviewCommentCreateRequestV1["snapshot"]): void {
    try {
        validateReviewCommentSnapshot(snapshot);
    } catch (error) {
        throw new ReviewCommentOperationError(
            "review_comment_snapshot_invalid",
            error instanceof Error ? error.message : "Review comment snapshot is invalid",
        );
    }
}

export function createReviewCommentOperations(
    store: ReviewCommentStore,
    runtime: ReviewCommentOperationRuntime,
): ReviewCommentOperations {
    async function transitionComment(params: ReviewCommentMutationOperationParams<ReviewCommentTransitionRequestV1> & Readonly<{
        bulkActionId?: string;
    }>): Promise<ReviewCommentTransitionResponseV1> {
        const current = await requireComment(store, params.accountId, params.input.commentId);
        if (params.input.expectedState && current.state !== params.input.expectedState) {
            throw new ReviewCommentOperationError("review_comment_conflict", "Review comment state did not match expectedState");
        }
        assertReviewCommentTransitionAllowed(current.state, params.input.toState);
        assertReviewCommentTransitionActorAllowed({
            actor: params.actor,
            comment: current,
            fromState: current.state,
            toState: params.input.toState,
        });
        if (
            params.actor.kind !== "user"
            && current.state === "delegated"
            && (params.input.toState === "pending_review" || params.input.toState === "resolved")
            && (!params.input.evidence || params.input.evidence.length === 0)
        ) {
            throw new ReviewCommentOperationError(
                "review_comment_invalid_transition",
                `${params.input.toState} requires typed evidence for non-user delegated completion`,
            );
        }
        assertReviewCommentTransitionEvidence(params.input.toState, params.input.evidence, params.input.reason);
        const now = runtime.now();
        const transition: ReviewCommentTransitionV1 = {
            transitionId: runtime.createId("review-comment-transition"),
            fromState: current.state,
            toState: params.input.toState,
            transitionedAt: now,
            transitionedBy: params.actor,
            reason: params.input.reason,
            evidence: params.input.evidence,
            bulkActionId: params.bulkActionId,
            clientMutationId: params.input.clientMutationId,
            authorDeviceId: params.input.authorDeviceId,
            clientLamport: params.input.clientLamport,
            serverRevision: current.serverRevision + 1,
        };
        const comment = appendReviewCommentTransition({ comment: current, transition, updatedAt: now });
        const event = buildReviewCommentEvent({
            runtime,
            accountId: params.accountId,
            projectId: comment.projectId,
            commentId: comment.id,
            actor: params.actor,
            serverRevision: comment.serverRevision,
            eventKind: "transitioned",
            clientMutationId: params.input.clientMutationId,
            authorDeviceId: params.input.authorDeviceId,
            clientLamport: params.input.clientLamport,
            event: {
                transition,
                bulkActionId: params.bulkActionId,
            },
        });
        await store.commit({
            accountId: params.accountId,
            comment,
            event,
            storageMode: params.storageMode,
            eventEnvelope: params.input.eventEnvelope,
        });
        return { comment };
    }

    return {
        async create(params) {
            assertValidReviewCommentSnapshot(params.input.snapshot);
            const direct = params.input.authorIntent === "open";
            if (direct && params.actor.kind !== "user") {
                assertReviewCommentDirectWriteGrant(params);
            }
            const now = runtime.now();
            const commentId = runtime.createId("review-comment");
            const state: ReviewCommentStateV1 = direct ? "open" : "proposed";
            const transition: ReviewCommentTransitionV1 = {
                transitionId: runtime.createId("review-comment-transition"),
                toState: state,
                transitionedAt: now,
                transitionedBy: params.actor,
                evidence: params.input.evidence,
                clientMutationId: params.input.clientMutationId,
                authorDeviceId: params.input.authorDeviceId,
                clientLamport: params.input.clientLamport,
                serverRevision: 1,
            };
            const comment = ReviewCommentV1Schema.parse({
                v: 1,
                id: commentId,
                accountId: params.accountId,
                projectId: params.input.projectId,
                workspaceId: params.input.workspaceId,
                sessionId: params.input.sessionId,
                runId: params.input.runId,
                engineId: params.input.engineId,
                findingId: params.input.findingId,
                anchor: params.input.anchor,
                snapshot: params.input.snapshot,
                body: params.input.body,
                bodyVersion: 1,
                edits: [],
                author: params.actor,
                state,
                flags: {},
                dispositions: {},
                threadId: commentId,
                evidence: params.input.evidence,
                transitions: [transition],
                fingerprint: params.input.fingerprint,
                linkedRefs: params.input.linkedRefs,
                suggestedFix: params.input.suggestedFix,
                createdAt: now,
                updatedAt: now,
                serverRevision: 1,
                metadata: params.input.metadata,
            });
            const event = buildReviewCommentEvent({
                runtime,
                accountId: params.accountId,
                projectId: comment.projectId,
                commentId,
                actor: params.actor,
                serverRevision: comment.serverRevision,
                eventKind: "created",
                clientMutationId: params.input.clientMutationId,
                authorDeviceId: params.input.authorDeviceId,
                clientLamport: params.input.clientLamport,
                event: { comment },
            });
            await store.commit({
                accountId: params.accountId,
                comment,
                event,
                storageMode: params.storageMode,
                eventEnvelope: params.input.eventEnvelope,
            });
            return { comment };
        },
        async list(params) {
            const result = await store.list({ accountId: params.accountId, filters: params.input });
            return { items: [...result.items], cursor: result.cursor };
        },
        async get(params) {
            return { comment: await requireComment(store, params.accountId, params.input.commentId) };
        },
        async transition(params) {
            return await transitionComment(params);
        },
        async edit(params) {
            const current = await requireComment(store, params.accountId, params.input.commentId);
            assertReviewCommentEditActorAllowed({ actor: params.actor, comment: current });
            if (params.input.expectedBodyVersion && current.bodyVersion !== params.input.expectedBodyVersion) {
                throw new ReviewCommentOperationError("review_comment_conflict", "Review comment bodyVersion did not match expectedBodyVersion");
            }
            const now = runtime.now();
            const edit = {
                editId: runtime.createId("review-comment-edit"),
                editedAt: now,
                editedBy: params.actor,
                previousBody: current.body,
                nextBody: params.input.nextBody,
                reason: params.input.reason,
            };
            const comment = ReviewCommentV1Schema.parse({
                ...current,
                body: params.input.nextBody,
                bodyVersion: current.bodyVersion + 1,
                edits: [...current.edits, edit],
                updatedAt: now,
                serverRevision: current.serverRevision + 1,
            });
            const event = buildReviewCommentEvent({
                runtime,
                accountId: params.accountId,
                projectId: comment.projectId,
                commentId: comment.id,
                actor: params.actor,
                serverRevision: comment.serverRevision,
                eventKind: "edited",
                clientMutationId: params.input.clientMutationId,
                authorDeviceId: params.input.authorDeviceId,
                clientLamport: params.input.clientLamport,
                event: { edit },
            });
            await store.commit({
                accountId: params.accountId,
                comment,
                event,
                storageMode: params.storageMode,
                eventEnvelope: params.input.eventEnvelope,
            });
            return { comment };
        },
        async reply(params) {
            const parent = await requireComment(store, params.accountId, params.input.parentCommentId);
            assertReviewCommentReplyAllowed(parent);
            const now = runtime.now();
            const commentId = runtime.createId("review-comment");
            const transition: ReviewCommentTransitionV1 = {
                transitionId: runtime.createId("review-comment-transition"),
                toState: "proposed",
                transitionedAt: now,
                transitionedBy: params.actor,
                evidence: params.input.evidence,
                clientMutationId: params.input.clientMutationId,
                authorDeviceId: params.input.authorDeviceId,
                clientLamport: params.input.clientLamport,
                serverRevision: 1,
            };
            const comment = ReviewCommentV1Schema.parse({
                v: 1,
                id: commentId,
                accountId: params.accountId,
                projectId: parent.projectId,
                workspaceId: parent.workspaceId,
                sessionId: parent.sessionId,
                runId: parent.runId,
                engineId: parent.engineId,
                findingId: parent.findingId,
                anchor: parent.anchor,
                snapshot: parent.snapshot,
                body: params.input.body,
                bodyVersion: 1,
                edits: [],
                author: params.actor,
                state: "proposed",
                flags: {},
                dispositions: {},
                parentCommentId: parent.id,
                threadId: parent.threadId,
                evidence: params.input.evidence,
                transitions: [transition],
                linkedRefs: parent.linkedRefs,
                createdAt: now,
                updatedAt: now,
                serverRevision: 1,
            });
            await store.commit({
                accountId: params.accountId,
                comment,
                storageMode: params.storageMode,
                eventEnvelope: params.input.eventEnvelope,
                event: buildReviewCommentEvent({
                    runtime,
                    accountId: params.accountId,
                    projectId: comment.projectId,
                    commentId: comment.id,
                    actor: params.actor,
                    serverRevision: comment.serverRevision,
                    eventKind: "replied",
                    clientMutationId: params.input.clientMutationId,
                    authorDeviceId: params.input.authorDeviceId,
                    clientLamport: params.input.clientLamport,
                    event: { parentCommentId: parent.id },
                }),
            });
            return { comment, parent };
        },
        async redact(params) {
            assertReviewCommentRedactionActorAllowed(params.actor);
            const current = await requireComment(store, params.accountId, params.input.commentId);
            if (current.flags.redacted || current.tombstone) {
                throw new ReviewCommentOperationError(
                    "review_comment_already_redacted",
                    "Review comment is already redacted",
                );
            }
            const now = runtime.now();
            const redactBody = params.input.redactBody !== false;
            const comment = ReviewCommentV1Schema.parse({
                ...current,
                body: redactedBodyForStorage(current, params.input.redactBody),
                edits: redactBody ? [] : current.edits,
                flags: { ...current.flags, redacted: true },
                tombstone: {
                    deletedAt: now,
                    deletedBy: params.actor,
                    reason: params.input.reason,
                    redacted: true,
                },
                updatedAt: now,
                serverRevision: current.serverRevision + 1,
            });
            const event = buildReviewCommentEvent({
                runtime,
                accountId: params.accountId,
                projectId: comment.projectId,
                commentId: comment.id,
                actor: params.actor,
                serverRevision: comment.serverRevision,
                eventKind: "redacted",
                clientMutationId: params.input.clientMutationId,
                authorDeviceId: params.input.authorDeviceId,
                clientLamport: params.input.clientLamport,
                event: { reason: params.input.reason, redactBody: params.input.redactBody ?? true },
            });
            await store.commit({
                accountId: params.accountId,
                comment,
                event,
                storageMode: params.storageMode,
                eventEnvelope: params.input.eventEnvelope,
            });
            return { comment };
        },
        async setDisposition(params) {
            const current = await requireComment(store, params.accountId, params.input.commentId);
            const actorKey = formatReviewCommentActorDispositionKey(params.actor);
            const comment = ReviewCommentV1Schema.parse({
                ...current,
                dispositions: { ...current.dispositions, [actorKey]: params.input.disposition },
                updatedAt: runtime.now(),
                serverRevision: current.serverRevision + 1,
            });
            const event = buildReviewCommentEvent({
                runtime,
                accountId: params.accountId,
                projectId: comment.projectId,
                commentId: comment.id,
                actor: params.actor,
                serverRevision: comment.serverRevision,
                eventKind: "disposition_set",
                clientMutationId: params.input.clientMutationId,
                authorDeviceId: params.input.authorDeviceId,
                clientLamport: params.input.clientLamport,
                event: { actorKey, disposition: params.input.disposition },
            });
            await store.commit({
                accountId: params.accountId,
                comment,
                event,
                storageMode: params.storageMode,
                eventEnvelope: params.input.eventEnvelope,
            });
            return { comment };
        },
        async attachEvidence(params) {
            const current = await requireComment(store, params.accountId, params.input.commentId);
            assertReviewCommentUserOrOriginalAuthor({ actor: params.actor, comment: current });
            const comment = ReviewCommentV1Schema.parse({
                ...current,
                evidence: [...(current.evidence ?? []), ...params.input.evidence],
                updatedAt: runtime.now(),
                serverRevision: current.serverRevision + 1,
            });
            const event = buildReviewCommentEvent({
                runtime,
                accountId: params.accountId,
                projectId: comment.projectId,
                commentId: comment.id,
                actor: params.actor,
                serverRevision: comment.serverRevision,
                eventKind: "evidence_attached",
                clientMutationId: params.input.clientMutationId,
                authorDeviceId: params.input.authorDeviceId,
                clientLamport: params.input.clientLamport,
                event: { evidence: params.input.evidence },
            });
            await store.commit({
                accountId: params.accountId,
                comment,
                event,
                storageMode: params.storageMode,
                eventEnvelope: params.input.eventEnvelope,
            });
            return { comment };
        },
        async bulkTransition(params) {
            const bulkActionId = params.input.bulkActionId ?? runtime.createId("review-comment-bulk");
            const updated: ReviewCommentV1[] = [];
            const failed: ReviewCommentBulkTransitionResponseV1["failed"] = [];
            for (const commentId of params.input.commentIds) {
                try {
                    const transitioned = await transitionComment({
                        accountId: params.accountId,
                        actor: params.actor,
                        grants: params.grants,
                        storageMode: params.storageMode,
                        bulkActionId,
                        input: {
                            commentId,
                            toState: params.input.toState,
                            expectedState: params.input.expectedState,
                            evidence: params.input.evidence,
                            reason: params.input.reason,
                            clientMutationId: params.input.clientMutationId,
                            authorDeviceId: params.input.authorDeviceId,
                            clientLamport: params.input.clientLamport,
                            eventEnvelope: params.input.eventEnvelope,
                        },
                    });
                    updated.push(transitioned.comment);
                } catch (error) {
                    if (!(error instanceof ReviewCommentOperationError)) {
                        throw error;
                    }
                    failed.push({
                        commentId,
                        errorCode: error.code,
                        error: error.message,
                    });
                }
            }
            return { bulkActionId, updated, failed };
        },
    };
}
