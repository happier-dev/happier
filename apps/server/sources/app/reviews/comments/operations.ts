import { createHash } from "node:crypto";
import { reviewCommentMutationInputWithoutEventEnvelopeV1 } from '@happier-dev/protocol/reviews/comments/content';
import { stringifyReviewCommentPrincipalCanonicalJsonV1, type ReviewCommentAttachEvidenceResponseV1, type ReviewCommentBulkTransitionRequestV1, type ReviewCommentBulkTransitionResponseV1, type ReviewCommentCreateResponseV1, type ReviewCommentEditResponseV1, type ReviewCommentGetRequestV1, type ReviewCommentGetResponseV1, type ReviewCommentListRequestV1, type ReviewCommentListResponseV1, type ReviewCommentRedactResponseV1, type ReviewCommentReplyResponseV1, type ReviewCommentSetDispositionResponseV1, type ReviewCommentTransitionResponseV1 } from '@happier-dev/protocol/reviews/comments/actions';
import { ReviewCommentPublicationTransportRequestV1Schema, type ReviewCommentPublicationTransportRequestV1, type ReviewCommentPublicationTransportResponseV1 } from '@happier-dev/protocol/reviews/comments/publicationTransport';
import { type ReviewCommentActorRefV1, type ReviewCommentAttachEvidenceRequestV1, type ReviewCommentCreateRequestV1, type ReviewCommentEditRequestV1, type ReviewCommentRedactRequestV1, type ReviewCommentReplyRequestV1, type ReviewCommentSetDispositionRequestV1, type ReviewCommentTransitionRequestV1, type ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import { projectReviewCommentStructuralMutationV1, type ReviewCommentStructuralMutationV1, type ReviewCommentPrepareMutationRequestV1, type ReviewCommentPrepareMutationResponseV1, type ReviewCommentCommitMutationRequestV1, type ReviewCommentCommitMutationResponseV1, type ReviewCommentStoredSourceV1 } from '@happier-dev/protocol/reviews/comments/mutation';
import { createReviewCommentCanonicalMutations } from "./mutations";

import { ReviewCommentOperationError } from "./errors";
import {
    assertReviewCommentSessionScope,
    reviewCommentPrincipalSessionId,
    assertReviewCommentOrdinarySourceAdmission,
    type ReviewCommentPrincipal,
} from "./permissions";
import { validateReviewCommentSnapshot } from "./snapshots";
import type { ReviewCommentStore } from "./store";

export type ReviewCommentOperationRuntime = Readonly<{
    now(): number;
    createId(prefix: string): string;
}>;

export type ReviewCommentCreateOperationParams = ReviewCommentPrincipal & Readonly<{
    input: ReviewCommentCreateRequestV1;
}>;

export type ReviewCommentGetOperationParams = Pick<ReviewCommentPrincipal, "accountId"> & Partial<Pick<ReviewCommentPrincipal, "actor" | "workflowOriginSessionId" | "workflowScope" | "ledSubtreeSessionIds" | "storageMode" | "reviewAccess">> & Readonly<{
    accountId: string;
    input: ReviewCommentGetRequestV1;
}>;

export type ReviewCommentListOperationParams = Pick<ReviewCommentPrincipal, "accountId"> & Partial<Pick<ReviewCommentPrincipal, "actor" | "workflowOriginSessionId" | "workflowScope" | "ledSubtreeSessionIds" | "storageMode" | "reviewAccess">> & Readonly<{
    accountId: string;
    input: ReviewCommentListRequestV1;
}>;

export type ReviewCommentMutationOperationParams<TInput> = ReviewCommentPrincipal & Readonly<{
    input: TInput;
}>;

export interface ReviewCommentOperations {
    prepareMutation(params: ReviewCommentPrincipal & Readonly<{ input: ReviewCommentPrepareMutationRequestV1 }>): Promise<ReviewCommentPrepareMutationResponseV1>;
    commitMutation(params: ReviewCommentPrincipal & Readonly<{ input: ReviewCommentCommitMutationRequestV1 }>): Promise<ReviewCommentCommitMutationResponseV1>;
    commitCreateBatch(items: readonly Readonly<{ principal: ReviewCommentPrincipal; input: ReviewCommentCommitMutationRequestV1 }>[]): ReturnType<ReturnType<typeof createReviewCommentCanonicalMutations>['commitCreateBatch']>;
    getStored(params: ReviewCommentGetOperationParams): Promise<{ comment: ReviewCommentStoredSourceV1 }>;
    listStored(params: ReviewCommentListOperationParams): Promise<{ items: ReviewCommentStoredSourceV1[]; cursor: string | null }>;
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
    claimPublicationDispatch(
        params: ReviewCommentMutationOperationParams<ReviewCommentPublicationTransportRequestV1>,
    ): Promise<ReviewCommentPublicationTransportResponseV1>;
}

async function requireComment(store: ReviewCommentStore, principal: ReviewCommentGetOperationParams): Promise<ReviewCommentV1> {
    const commentId = principal.input.commentId;
    const comment = await store.get({ ...principal, commentId });
    if (!comment) {
        throw new ReviewCommentOperationError("review_comment_not_found", `Review comment not found: ${commentId}`);
    }
    return comment;
}

function assertPlainReadMode(mode: ReviewCommentPrincipal["storageMode"]): void {
    if (mode === "e2ee") throw new ReviewCommentOperationError("review_comment_encryption_mode_mismatch", "Encrypted Review Comment reads require canonical stored transport");
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

function reviewCommentCreateRequestFingerprint(params: Readonly<{
    actor: ReviewCommentActorRefV1;
    input: ReviewCommentCreateRequestV1;
    storageMode?: "plain" | "e2ee";
}>): string {
    const {
        clientMutationId: _clientMutationId,
        eventEnvelope: _eventEnvelope,
        ...immutableInput
    } = params.input;
    const immutableSnapshot = "capturedAt" in params.input.snapshot
        ? (({ capturedAt: _capturedAt, ...snapshot }) => snapshot)(params.input.snapshot)
        : params.input.snapshot;
    return createHash("sha256")
        .update("happier.reviewCommentCreateRequest.v1\0")
        .update(stringifyReviewCommentPrincipalCanonicalJsonV1({
            actor: params.actor,
            input: {
                ...immutableInput,
                snapshot: immutableSnapshot,
                authorIntent: immutableInput.authorIntent ?? "propose",
            },
            storageMode: params.storageMode ?? "plain",
        }))
        .digest("hex");
}

export function assertReviewCommentCurrentIntent(params: Omit<ReviewCommentCreateOperationParams, "input"> & Readonly<{
    input: ReviewCommentCreateRequestV1 | Extract<ReviewCommentStructuralMutationV1, { actionId: "reviews.comments.create" }>["input"];
    contentCommitment?: string;
}>): void {
    const intent = params.currentIntent;
    const actor = params.actor;
    const input = params.input;
    const logicalInput = reviewCommentMutationInputWithoutEventEnvelopeV1({ ...input });
    const effectBodySha256Base64Url = params.contentCommitment ?? createHash("sha256")
        .update(stringifyReviewCommentPrincipalCanonicalJsonV1(logicalInput))
        .digest("base64url");
    if (
        !intent
        || !(actor.kind === "agent" ? intent.agentId === actor.agentId && intent.sessionId === actor.sessionId
            : actor.kind === "executionRun" ? intent.kind === "review_findings_materialization"
                && intent.runId === actor.runId && intent.agentId === actor.agentId
                && intent.sessionId === undefined && intent.workflowRunId === undefined
            : actor.kind === "workflow" && intent.kind === "review_findings_materialization" && intent.workflowRunId === actor.runId)
        || intent.projectId !== input.projectId
        || (intent.kind === "execution_run_host_action" && intent.workspaceId !== input.workspaceId)
        || (intent.kind === "review_findings_materialization"
            && (intent.workspace?.machineId !== input.workspace?.machineId || intent.workspace?.path !== input.workspace?.path))
        || (intent.kind === "review_findings_materialization" && (!input.findingIdentity || !input.engineId || intent.agentId !== input.engineId))
        || intent.sessionId !== input.sessionId
        || intent.runId !== input.runId
        || (intent.kind === "execution_run_host_action" && intent.pluginId !== input.engineId)
        || intent.effectBodySha256Base64Url !== effectBodySha256Base64Url
    ) {
        throw new ReviewCommentOperationError(
            "review_comment_permission_denied",
            "Direct review-comment writes require exact current intent",
        );
    }
}

export function createReviewCommentOperations(
    store: ReviewCommentStore,
    runtime: ReviewCommentOperationRuntime,
): ReviewCommentOperations {
    const canonical = createReviewCommentCanonicalMutations(store, runtime);
    const plain = async (params: ReviewCommentPrincipal & { input: Record<string, unknown> }, actionId: Parameters<typeof projectReviewCommentStructuralMutationV1>[0], fingerprint?: string) => canonical.applyPlain(params, projectReviewCommentStructuralMutationV1(actionId, params.input), params.input, fingerprint);
    return {
        prepareMutation: (params) => canonical.prepare(params, params.input),
        commitMutation: (params) => canonical.commit(params, params.input),
        commitCreateBatch: (items) => canonical.commitCreateBatch(items),
        async getStored(params) {
            const comment = await store.getSource({ ...params, commentId: params.input.commentId });
            if (!comment) throw new ReviewCommentOperationError("review_comment_not_found", "Review comment not found");
            assertReviewCommentOrdinarySourceAdmission(comment, params.storageMode ?? "plain");
            if (params.actor) assertReviewCommentSessionScope({ ...params, actor: params.actor }, comment.structural.sessionId);
            return { comment };
        },
        async listStored(params) {
            const sessionId = params.input.sessionId ?? (params.actor ? reviewCommentPrincipalSessionId({ ...params, actor: params.actor }) : undefined);
            if (params.actor && params.input.sessionId !== undefined) assertReviewCommentSessionScope({ ...params, actor: params.actor }, params.input.sessionId);
            const result = await store.listSources({ ...params, filters: { ...params.input, ...(sessionId ? { sessionId: params.input.sessionId ?? sessionId } : {}) } });
            for (const item of result.items) {
                assertReviewCommentOrdinarySourceAdmission(item, params.storageMode ?? "plain");
            }
            return { items: [...result.items], cursor: result.cursor };
        },
        async create(params) {
            assertValidReviewCommentSnapshot(params.input.snapshot);
            if (params.actor.kind !== "user" && (params.input.authorIntent === "open" || params.actor.kind === "agent" || params.actor.kind === "workflow" || params.actor.kind === "executionRun")) assertReviewCommentCurrentIntent(params);
            const result = await plain(params, "reviews.comments.create", reviewCommentCreateRequestFingerprint(params));
            return { comment: result.comments[0]!, replayed: result.replayed };
        },
        async list(params) {
            assertPlainReadMode(params.storageMode);
            const sessionId = params.input.sessionId ?? (params.actor ? reviewCommentPrincipalSessionId({ ...params, actor: params.actor }) : undefined);
            if (params.actor && params.input.sessionId !== undefined) assertReviewCommentSessionScope({ ...params, actor: params.actor }, params.input.sessionId);
            const result = await store.list({ ...params, filters: { ...params.input, ...(sessionId ? { sessionId: params.input.sessionId ?? sessionId } : {}) } });
            return { items: [...result.items], cursor: result.cursor };
        },
        async get(params) {
            assertPlainReadMode(params.storageMode);
            const comment = await requireComment(store, params);
            if (params.actor) assertReviewCommentSessionScope({ ...params, actor: params.actor }, comment.sessionId);
            return { comment };
        },
        async transition(params) { const result = await plain(params, "reviews.comments.transition"); return { comment: result.comments[0]! }; },
        async edit(params) { const result = await plain(params, "reviews.comments.edit"); return { comment: result.comments[0]! }; },
        async reply(params) { const result = await plain(params, "reviews.comments.reply"); return { comment: result.comments[0]!, parent: result.parent! }; },
        async redact(params) { const result = await plain(params, "reviews.comments.redact"); return { comment: result.comments[0]! }; },
        async setDisposition(params) { const result = await plain(params, "reviews.comments.setDisposition"); return { comment: result.comments[0]! }; },
        async attachEvidence(params) { const result = await plain(params, "reviews.comments.attachEvidence"); return { comment: result.comments[0]! }; },
        async bulkTransition(params) { const result = await plain(params, "reviews.comments.bulkTransition"); return { bulkActionId: result.bulkActionId!, updated: result.comments, failed: result.failed }; },
        async claimPublicationDispatch(
            params: ReviewCommentMutationOperationParams<ReviewCommentPublicationTransportRequestV1>,
        ): Promise<ReviewCommentPublicationTransportResponseV1> {
            if (params.actor.kind === "workflow") throw new ReviewCommentOperationError("review_comment_permission_denied", "Workflow review authority does not include publication");
            if (params.reviewAccess?.level === "view") throw new ReviewCommentOperationError("review_comment_permission_denied", "Review Edit access is required to publish findings");
            const input = ReviewCommentPublicationTransportRequestV1Schema.parse(params.input);
            const comments = new Map((await store.getSources({ ...params,
                commentIds: input.entries.map(entry => entry.happierCommentId),
            })).map(comment => [comment.structural.id, comment]));
            for (const entry of input.entries) {
                const comment = comments.get(entry.happierCommentId);
                if (!comment) throw new ReviewCommentOperationError("review_comment_not_found", "Review comment not found");
                assertReviewCommentSessionScope(params, comment.structural.sessionId);
            }
            const { publicationPlanId, targetKey, verdict, settlement } = input;
            const entries = input.entries.map((entry) => ({
                happierCommentId: entry.happierCommentId,
                publicationCorrelationId: entry.publicationCorrelationId,
            }));
            const claim = await store.claimPublicationDispatch({
                accountId: params.accountId,
                ...(params.reviewAccess ? { reviewAccess: params.reviewAccess } : {}),
                storageMode: input.mode,
                contentPublicKeyFingerprint: input.contentPublicKeyFingerprint,
                entries: input.entries.map((entry, index) => ({
                    commentId: entry.happierCommentId,
                    serverRevision: entry.expectedServerRevision,
                    publicationCorrelationId: entries[index]!.publicationCorrelationId,
                })),
                verdictPublicationCorrelationId: verdict?.publicationCorrelationId ?? null,
                targetKey,
                publicationPlanId,
                dispatchToken: runtime.createId("review-publication-dispatch"),
                ...(settlement === undefined ? {} : { settlement }),
                createdAt: runtime.now(),
            });
            return {
                disposition: claim.disposition,
                dispatchToken: claim.dispatchToken,
                publicationPlanId: claim.publicationPlanId,
                entries,
                verdict,
                instructions: {
                    entries: [...claim.instructions.entries],
                    verdict: claim.instructions.verdict,
                },
                priorResult: claim.priorResult,
            };
        },
    };
}
