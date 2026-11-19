import { createHash, randomUUID } from "node:crypto";
import type { Fastify } from "@/app/api/types";
import type { ReviewCommentActorRefV1 } from '@happier-dev/protocol/reviews/comments/v1';
import type { ReviewCommentPrincipalHeaderV1 } from '@happier-dev/protocol/reviews/comments/actions';
import type { z } from "zod/mini";
import { createReviewCommentPrincipalSigningInputV1, isWorkflowSessionScopeTargetV1, readWorkflowActionInvocationV1, REVIEW_COMMENT_PRINCIPAL_HEADER_V1, ReviewCommentBulkTransitionRequestV1Schema, ReviewCommentGetRequestV1Schema, ReviewCommentListRequestV1Schema, ReviewCommentPrincipalHeaderV1Schema, stringifyReviewCommentPrincipalCanonicalJsonV1 } from '@happier-dev/protocol/reviews/comments/actions';
import { ReviewCommentAttachEvidenceRequestV1Schema, ReviewCommentCreateRequestV1Schema, ReviewCommentEditRequestV1Schema, ReviewCommentRedactRequestV1Schema, ReviewCommentReplyRequestV1Schema, ReviewCommentSetDispositionRequestV1Schema, ReviewCommentTransitionRequestV1Schema } from '@happier-dev/protocol/reviews/comments/v1';
import { ReviewCommentPublicationTransportRequestV1Schema } from '@happier-dev/protocol/reviews/comments/publicationTransport';
import { ReviewCommentPrepareMutationRequestV1Schema, ReviewCommentCommitMutationRequestV1Schema } from '@happier-dev/protocol/reviews/comments/mutation';
import { readReviewCommentPreparationReceipt } from "./mutations";
import tweetnacl from "tweetnacl";

import {
    createReviewCommentOperations,
    assertReviewCommentCurrentIntent,
    type ReviewCommentOperations,
} from "./operations";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { db } from "@/storage/db";
import { ReviewCommentOperationError } from "./errors";
import type { ReviewAccessCapability, ReviewCommentPrincipal } from "./permissions";
import { createSqlReviewCommentStore, readReviewCommentReviewIds } from "./store";
import { resolveReviewAccessInTx } from '../reviewAccess';
import { workflowRunIdentityWhere } from "@/app/workflows/workflowRunService";
import { resolveSessionAccessForOperation } from "@/app/session/access/sessionAccess";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { readSessionManagedSubtreeSessionIdsInTx } from "@/app/session/follow/sessionManagerSubtree";
import { resolveEffectiveSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";

const DEFAULT_REVIEW_COMMENT_PRINCIPAL_PROOF_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_REVIEW_COMMENT_PRINCIPAL_PROOF_CLOCK_SKEW_MS = 60_000;

export type ReviewCommentRoutePrincipalResolver = (
    request: Parameters<typeof readSessionAccessAuthenticationFromRequest>[0] & Readonly<{
        userId: string;
        body?: unknown;
        query?: unknown;
        params?: unknown;
        method?: string;
        path?: string;
        headers?: Record<string, string | string[] | undefined>;
    }>,
) => Promise<ReviewCommentPrincipal> | ReviewCommentPrincipal;

export type ReviewCommentRoutesOptions = Readonly<{
    operations?: ReviewCommentOperations;
    resolvePrincipal?: ReviewCommentRoutePrincipalResolver;
}>;

function defaultActorForUser(userId: string): ReviewCommentActorRefV1 {
    return { kind: "user", userId };
}

function createDefaultOperations(): ReviewCommentOperations {
    return createReviewCommentOperations(createSqlReviewCommentStore(), {
        now: () => Date.now(),
        createId: (prefix) => `${prefix}-${randomUUID()}`,
    });
}

function readHeaderValue(
    headers: Record<string, string | string[] | undefined> | undefined,
    name: string,
): string | null {
    const value = headers?.[name] ?? headers?.[name.toLowerCase()];
    if (Array.isArray(value)) {
        return value[0] ?? null;
    }
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readCanonicalMutationRequest(accountId: string, path: string | undefined, body: unknown) {
    if (path === "/v1/reviews/comments/mutations/prepare") return parseReviewCommentRouteInput(ReviewCommentPrepareMutationRequestV1Schema, body, "review_comment_invalid_request");
    if (path === "/v1/reviews/comments/mutations/commit") return readReviewCommentPreparationReceipt(accountId, parseReviewCommentRouteInput(ReviewCommentCommitMutationRequestV1Schema, body, "review_comment_invalid_request").receipt).request;
    return null;
}

function readReviewCommentPrincipalHeader(
    headers: Record<string, string | string[] | undefined> | undefined,
): ReviewCommentPrincipalHeaderV1 | null {
    const raw = readHeaderValue(headers, REVIEW_COMMENT_PRINCIPAL_HEADER_V1);
    if (!raw) return null;
    try {
        const decoded = Buffer.from(raw, "base64url").toString("utf8");
        return ReviewCommentPrincipalHeaderV1Schema.parse(JSON.parse(decoded));
    } catch {
        throw new ReviewCommentOperationError(
            "review_comment_permission_denied",
            "Invalid review-comment principal header",
        );
    }
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createReviewCommentPrincipalBodyHash(body: unknown): string {
    return createHash("sha256")
        .update(stringifyReviewCommentPrincipalCanonicalJsonV1(body ?? null))
        .digest("base64url");
}

function assertReviewCommentPrincipalProofFresh(proof: NonNullable<ReviewCommentPrincipalHeaderV1["proof"]>): void {
    const now = Date.now();
    const maxAgeMs = readPositiveIntegerEnv(
        "HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_MAX_AGE_MS",
        DEFAULT_REVIEW_COMMENT_PRINCIPAL_PROOF_MAX_AGE_MS,
    );
    const clockSkewMs = readPositiveIntegerEnv(
        "HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_CLOCK_SKEW_MS",
        DEFAULT_REVIEW_COMMENT_PRINCIPAL_PROOF_CLOCK_SKEW_MS,
    );
    if (proof.issuedAt > now + clockSkewMs || now - proof.issuedAt > maxAgeMs) {
        throw new ReviewCommentOperationError(
            "review_comment_permission_denied",
            "Review-comment principal proof is expired",
        );
    }
}

async function verifyReviewCommentPrincipalHeader(params: Readonly<{
    accountId: string;
    headerPrincipal: ReviewCommentPrincipalHeaderV1;
    method: string | undefined;
    path: string | undefined;
    body: unknown;
}>): Promise<Readonly<{
    actor: ReviewCommentActorRefV1;
    currentIntent?: ReviewCommentPrincipalHeaderV1["currentIntent"];
    workflowScope?: ReviewCommentPrincipalHeaderV1["workflowScope"];
    machineId: string;
    installationId: string;
}>> {
    if (params.headerPrincipal.actor.kind === "user"
        || (params.headerPrincipal.actor.kind === "executionRun"
            && params.headerPrincipal.currentIntent?.kind !== "review_findings_materialization")) {
        throw new ReviewCommentOperationError(
            "review_comment_permission_denied",
            "Review-comment principal header actor is not trusted",
        );
    }
    const proof = params.headerPrincipal.proof;
    if (!proof) {
        throw new ReviewCommentOperationError(
            "review_comment_permission_denied",
            "Review-comment plugin principal proof is required",
        );
    }
    assertReviewCommentPrincipalProofFresh(proof);
    if (!params.method || !params.path) {
        throw new ReviewCommentOperationError(
            "review_comment_permission_denied",
            "Review-comment principal proof request binding is required",
        );
    }
    if (proof.method !== params.method || proof.path !== params.path) {
        throw new ReviewCommentOperationError(
            "review_comment_permission_denied",
            "Review-comment principal proof request binding is invalid",
        );
    }
    if (proof.bodySha256Base64Url !== createReviewCommentPrincipalBodyHash(params.body)) {
        throw new ReviewCommentOperationError(
            "review_comment_permission_denied",
            "Review-comment principal proof body binding is invalid",
        );
    }
    const currentIntent = params.headerPrincipal.currentIntent;
    if (currentIntent) {
        const prepared = readCanonicalMutationRequest(params.accountId, proof.path, params.body);
        if (proof.method !== "POST" || (!prepared && (proof.path !== "/v1/reviews/comments" || !ReviewCommentCreateRequestV1Schema.safeParse(params.body).success)) || (prepared && prepared.mutation.actionId !== "reviews.comments.create")) {
            throw new ReviewCommentOperationError("review_comment_permission_denied", "Review-comment current intent requires its exact create effect");
        }
        if (prepared?.mutation.actionId === "reviews.comments.create") assertReviewCommentCurrentIntent({ accountId: params.accountId, actor: params.headerPrincipal.actor, currentIntent, input: prepared.mutation.input, contentCommitment: prepared.contentCommitment });
        else {
            const legacy = ReviewCommentCreateRequestV1Schema.parse(params.body);
            assertReviewCommentCurrentIntent({ accountId: params.accountId, actor: params.headerPrincipal.actor, currentIntent, input: legacy });
        }
    }
    const machine = await db.machine.findFirst({
        where: {
            accountId: params.accountId,
            id: proof.machineId,
        },
        select: {
            installationId: true,
            installationPublicKey: true,
            replacedByMachineId: true,
            revokedAt: true,
        },
    });
    if (
        !machine
        || machine.revokedAt
        || machine.replacedByMachineId
        || machine.installationId !== proof.installationId
        || !machine.installationPublicKey
    ) {
        throw new ReviewCommentOperationError(
            "review_comment_permission_denied",
            "Review-comment plugin principal proof machine is not trusted",
        );
    }
    const publicKey = new Uint8Array(machine.installationPublicKey);
    const signature = Buffer.from(proof.signatureBase64Url, "base64url");
    if (
        publicKey.length !== tweetnacl.sign.publicKeyLength
        || signature.length !== tweetnacl.sign.signatureLength
    ) {
        throw new ReviewCommentOperationError(
            "review_comment_permission_denied",
            "Review-comment plugin principal proof signature is invalid",
        );
    }
    const verified = tweetnacl.sign.detached.verify(
        createReviewCommentPrincipalSigningInputV1({
            actor: params.headerPrincipal.actor,
            ...(currentIntent ? { currentIntent } : {}),
            ...(params.headerPrincipal.workflowScope ? { workflowScope: params.headerPrincipal.workflowScope } : {}),
            proof: {
                v: proof.v,
                alg: proof.alg,
                machineId: proof.machineId,
                installationId: proof.installationId,
                issuedAt: proof.issuedAt,
                nonce: proof.nonce,
                method: proof.method,
                path: proof.path,
                bodySha256Base64Url: proof.bodySha256Base64Url,
            },
        }),
        new Uint8Array(signature),
        publicKey,
    );
    if (!verified) {
        throw new ReviewCommentOperationError(
            "review_comment_permission_denied",
            "Review-comment plugin principal proof signature is invalid",
        );
    }
    return {
        actor: params.headerPrincipal.actor,
        ...(currentIntent ? { currentIntent } : {}),
        ...(params.headerPrincipal.workflowScope ? { workflowScope: params.headerPrincipal.workflowScope } : {}),
        machineId: proof.machineId,
        installationId: proof.installationId,
    };
}

async function resolveDefaultPrincipal(request: Parameters<ReviewCommentRoutePrincipalResolver>[0]): Promise<ReviewCommentPrincipal> {
    const account = await db.account.findUnique({
        where: { id: request.userId },
        select: {
            publicKey: true,
            seq: true,
            encryptionMode: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    const currentness = account
        ? deriveAccountEncryptionCurrentnessFromRow(account)
        : null;
    const mode = account
        ? resolveEffectiveAccountEncryptionModeFromAccountRow(account)
        : null;
    if (!account) {
        throw new ReviewCommentOperationError(
            "review_comment_encryption_mode_mismatch",
            "Review comments are unavailable until Account encryption state is consistent",
        );
    }
    const headerPrincipal = readReviewCommentPrincipalHeader(request.headers);
    const verifiedHeaderPrincipal = headerPrincipal
        ? await verifyReviewCommentPrincipalHeader({
            accountId: request.userId,
            headerPrincipal,
            method: request.method,
            path: request.path,
            body: request.body,
        })
        : null;
    const actor = verifiedHeaderPrincipal?.actor ?? defaultActorForUser(request.userId);
    const canonicalRequest = readCanonicalMutationRequest(request.userId, request.path, request.body);
    const createBody = canonicalRequest?.mutation.actionId === "reviews.comments.create" ? canonicalRequest.mutation.input : request.body;
    const commitReceipt = request.path === "/v1/reviews/comments/mutations/commit"
        ? readReviewCommentPreparationReceipt(request.userId, ReviewCommentCommitMutationRequestV1Schema.parse(request.body).receipt) : null;
    const reviewAccess = commitReceipt?.reviewAccess ?? await resolveRequestReviewAccess(request, canonicalRequest?.mutation.input);
    if (!reviewAccess && (mode?.status !== "ready" || currentness?.status !== "ready")) {
        throw new ReviewCommentOperationError("review_comment_encryption_mode_mismatch", "Account encryption state is unavailable");
    }
    if (verifiedHeaderPrincipal?.currentIntent?.kind === "review_findings_materialization") {
        const body = canonicalRequest?.mutation.actionId === "reviews.comments.create" ? canonicalRequest.mutation.input : ReviewCommentCreateRequestV1Schema.parse(request.body);
        if ((actor.kind === "executionRun" || body.workspace) && body.workspace?.machineId !== verifiedHeaderPrincipal.machineId) {
            throw new ReviewCommentOperationError("review_comment_permission_denied", "Review findings must reference their signed host workspace");
        }
    }
    const workflow = actor.kind === "workflow"
        ? await db.automationRun.findFirst({
            where: workflowRunIdentityWhere({ runId: actor.runId, accountId: request.userId }),
            select: { originSessionId: true, claimedByMachineId: true, assignments: { orderBy: { priority: "asc" }, take: 1, select: { machineId: true } } },
        }) : null;
    const scopeSessionId = actor.kind === "agent" ? actor.sessionId
        : actor.kind === "workflow" ? workflow?.originSessionId : null;
    const workflowScope = verifiedHeaderPrincipal?.workflowScope;
    if (actor.kind === "workflow") {
        // The installed host may attest only for its assigned Run. Account
        // credentials or another installed Machine do not confer Run authority.
        if (!workflow || !verifiedHeaderPrincipal || workflow.assignments[0]?.machineId !== verifiedHeaderPrincipal.machineId
            || (workflow.claimedByMachineId !== null && workflow.claimedByMachineId !== verifiedHeaderPrincipal.machineId)) {
            throw new ReviewCommentOperationError("review_comment_permission_denied", "Workflow review host is unavailable");
        }
        if (workflowScope) {
            const identity = readWorkflowActionInvocationV1(actor.runId, workflowScope.actionRequestId);
            const [logical, invocation] = identity ? await Promise.all([
                db.workflowRunInvocation.findFirst({ where: { id: identity.logicalInvocationId, runId: actor.runId },
                    select: { parentRecordId: true, memberOrdinal: true } }),
                db.workflowRunInvocation.findFirst({ where: { id: workflowScope.invocationId, runId: actor.runId },
                    select: { parentRecordId: true, memberOrdinal: true, attempt: true, lifecycle: true } }),
            ]) : [null, null];
            if (!identity || !logical || !invocation || invocation.attempt.toString() !== identity.attempt
                || invocation.lifecycle === "superseded" || invocation.parentRecordId !== logical.parentRecordId
                || invocation.memberOrdinal !== logical.memberOrdinal) {
                throw new ReviewCommentOperationError("review_comment_permission_denied", "Workflow review invocation is unavailable");
            }
        }
    }
    const workflowMaterialization = actor.kind === "workflow" && verifiedHeaderPrincipal?.currentIntent?.kind === "review_findings_materialization";
    if (workflowMaterialization && verifiedHeaderPrincipal) {
        const body = canonicalRequest?.mutation.actionId === "reviews.comments.create" ? canonicalRequest.mutation.input : ReviewCommentCreateRequestV1Schema.parse(request.body);
        if (!workflow || workflow.assignments[0]?.machineId !== verifiedHeaderPrincipal.machineId
            || (workflow.claimedByMachineId !== null && workflow.claimedByMachineId !== verifiedHeaderPrincipal.machineId)
            || body.workspace?.machineId !== verifiedHeaderPrincipal.machineId
            || (body.sessionId !== undefined && !isWorkflowSessionScopeTargetV1({
                originSessionId: scopeSessionId, scope: workflowScope, sessionId: body.sessionId,
            }))) {
            throw new ReviewCommentOperationError("review_comment_permission_denied", "Workflow finding materialization does not match its assigned host");
        }
    }
    let ledSubtreeSessionIds: string[] | undefined;
    if (!reviewAccess && (actor.kind === "agent" || actor.kind === "workflow")) {
        if ((!scopeSessionId && !workflowScope?.sessions.length && !workflowMaterialization) || !request.authAuthority) {
            throw new ReviewCommentOperationError("review_comment_permission_denied", "Verified Session review authority is unavailable");
        }
        const access = scopeSessionId ? await resolveSessionAccessForOperation(db, {
            accountId: request.userId,
            sessionId: scopeSessionId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
            capability: request.method === "GET" ? "readTranscript" : "submitAgentInput",
        }) : null;
        if (access && access.status !== "allowed") {
            throw new ReviewCommentOperationError("review_comment_permission_denied", "Session review access is unavailable");
        }
        for (const address of workflowScope?.sessions ?? []) {
            const current = await resolveSessionAccessForOperation(db, {
                accountId: request.userId, sessionId: address.sessionId,
                authentication: readSessionAccessAuthenticationFromRequest(request),
                capability: request.method === "GET" ? "readTranscript" : "submitAgentInput",
            });
            if (current.status !== "allowed") {
                throw new ReviewCommentOperationError("review_comment_permission_denied", "Workflow review Session access is unavailable");
            }
        }
        if (actor.kind === "agent" && (request.method === "GET"
            || request.path?.endsWith("/transition") || request.path?.endsWith("/disposition")
            || canonicalRequest?.mutation.actionId === "reviews.comments.transition" || canonicalRequest?.mutation.actionId === "reviews.comments.setDisposition" || canonicalRequest?.mutation.actionId === "reviews.comments.bulkTransition")) {
            const authentication = readSessionAccessAuthenticationFromRequest(request);
            ledSubtreeSessionIds = await readSessionManagedSubtreeSessionIdsInTx(db, {
                accountId: request.userId, rootSessionId: actor.sessionId, authentication,
            });
            if (request.method !== "GET") {
                // Relation membership never supplies input authority. Intersect
                // the readable subtree with the canonical credential's access.
                const writable = await resolveEffectiveSessionAccessWhere({ tx: db,
                    accountId: request.userId, capability: "submitAgentInput", mode: "effective_access_v1", authentication });
                ledSubtreeSessionIds = (await db.session.findMany({
                    where: { AND: [writable.where, { id: { in: ledSubtreeSessionIds } }] }, select: { id: true },
                })).map((session) => session.id);
            }
        }
    }
    return {
        accountId: request.userId,
        actor,
        ...(reviewAccess ? { reviewAccess } : {}),
        ...(actor.kind === "workflow" && scopeSessionId ? { workflowOriginSessionId: scopeSessionId } : {}),
        ...(actor.kind === "workflow" && workflowScope ? { workflowScope } : {}),
        ...(ledSubtreeSessionIds ? { ledSubtreeSessionIds } : {}),
        ...(verifiedHeaderPrincipal?.currentIntent ? { currentIntent: verifiedHeaderPrincipal.currentIntent } : {}),
        storageMode: reviewAccess?.encryptionMode ?? (mode?.status === "ready" ? mode.mode : undefined),
        accountVersion: account.seq,
        ...(currentness?.status === "ready" && !reviewAccess ? { accountEncryptionCurrentness: currentness.currentness } : {}),
    };
}

/** Resolve structural membership, then consume the Artifact owner's one access decision. */
async function resolveRequestReviewAccess(request: Parameters<ReviewCommentRoutePrincipalResolver>[0], mutationInput?: unknown): Promise<ReviewAccessCapability | undefined> {
    const input = mutationInput ?? (request.method === "GET" ? request.query : request.body);
    const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const params = request.params && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
    const commentIds = Array.isArray(fields.entries) ? fields.entries.flatMap(entry => entry && typeof entry === 'object'
        && 'happierCommentId' in entry && typeof entry.happierCommentId === 'string' ? [entry.happierCommentId] : [])
        : Array.isArray(fields.commentIds) ? fields.commentIds.filter((id): id is string => typeof id === "string")
        : [params.commentId ?? fields.commentId ?? fields.parentCommentId].filter((id): id is string => typeof id === "string");
    const memberships = await readReviewCommentReviewIds(commentIds);
    const explicit = typeof fields.reviewId === "string" ? fields.reviewId : undefined;
    const bound = [...memberships.values()].filter((id): id is string => id !== null);
    const reviewId = explicit ?? bound[0];
    if (!reviewId) return undefined;
    if ([...memberships.values()].some(id => id !== reviewId)) throw new ReviewCommentOperationError("review_comment_permission_denied", "Comment targets must belong to one Review");
    const access = await resolveReviewAccessInTx(db, { actorAccountId: request.userId, reviewId });
    if (!access) throw new ReviewCommentOperationError("review_comment_not_found", "Review not found");
    if (!access.encryptionMode) throw new ReviewCommentOperationError("review_comment_encryption_mode_mismatch", "Review encryption state is unavailable");
    return access;
}

function encodeReviewCommentPathSegment(value: string): string {
    return encodeURIComponent(value);
}

function withPrincipalRouteBinding(
    request: Parameters<ReviewCommentRoutePrincipalResolver>[0],
    method: "GET" | "POST" | "PATCH",
    path: string,
): Parameters<ReviewCommentRoutePrincipalResolver>[0] {
    return {
        ...request,
        userId: request.userId,
        body: request.body,
        headers: request.headers,
        method,
        path,
    };
}

function sendOperationError(reply: any, error: unknown): unknown {
    if (error instanceof ReviewCommentOperationError) {
        const statusCode = error.code === "review_comment_not_found"
            ? 404
            : error.code === "review_comment_conflict" || error.code === "review_comment_idempotency_conflict"
                ? 409
                : 400;
        return reply.code(statusCode).send({ error: error.code, message: error.message });
    }
    throw error;
}

function parseReviewCommentRouteInput<T>(
    schema: z.ZodMiniType<T>,
    input: unknown,
    code: ReviewCommentOperationError["code"],
): T {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;
    throw new ReviewCommentOperationError(code, "Review comment request is invalid");
}

function parseReviewCommentRouteQuery(query: unknown): unknown {
    if (!query || typeof query !== "object") return query;
    const decoded: Record<string, unknown> = { ...query };
    if (typeof decoded.workspace === "string") {
        try {
            decoded.workspace = JSON.parse(decoded.workspace) as unknown;
        } catch {
            throw new ReviewCommentOperationError("review_comment_invalid_filter", "Review workspace query must be canonical JSON");
        }
    }
    if (decoded.includeHistory === "true") decoded.includeHistory = true;
    if (decoded.includeHistory === "false") decoded.includeHistory = false;
    if (typeof decoded.commentIds === "string") {
        try {
            decoded.commentIds = JSON.parse(decoded.commentIds) as unknown;
        } catch {
            throw new ReviewCommentOperationError("review_comment_invalid_filter", "Review comment selection must be canonical JSON");
        }
    }
    if (typeof decoded.limit === "string" && /^\d+$/.test(decoded.limit)) decoded.limit = Number(decoded.limit);
    if (typeof decoded.roundOrdinal === "string" && /^\d+$/.test(decoded.roundOrdinal)) decoded.roundOrdinal = Number(decoded.roundOrdinal);
    if (decoded["states[]"] !== undefined) {
        if (decoded.states !== undefined) throw new ReviewCommentOperationError("review_comment_invalid_filter", "Review states query cannot use conflicting encodings");
        decoded.states = decoded["states[]"];
        delete decoded["states[]"];
    }
    if (typeof decoded.states === "string") decoded.states = [decoded.states];
    return decoded;
}

export function registerReviewCommentRoutes(app: Fastify, options: ReviewCommentRoutesOptions = {}): void {
    const operations = options.operations ?? createDefaultOperations();
    const resolvePrincipal = options.resolvePrincipal ?? resolveDefaultPrincipal;

    app.post("/v1/reviews/comments/mutations/prepare", { preHandler: app.authenticate }, async (request, reply) => {
        try {
            const principal = await resolvePrincipal(withPrincipalRouteBinding(request, "POST", "/v1/reviews/comments/mutations/prepare"));
            return await operations.prepareMutation({ ...principal, input: parseReviewCommentRouteInput(ReviewCommentPrepareMutationRequestV1Schema, request.body, "review_comment_invalid_request") });
        } catch (error) { return sendOperationError(reply, error); }
    });
    app.post("/v1/reviews/comments/mutations/commit", { preHandler: app.authenticate }, async (request, reply) => {
        try {
            const principal = await resolvePrincipal(withPrincipalRouteBinding(request, "POST", "/v1/reviews/comments/mutations/commit"));
            return await operations.commitMutation({ ...principal, input: parseReviewCommentRouteInput(ReviewCommentCommitMutationRequestV1Schema, request.body, "review_comment_invalid_request") });
        } catch (error) { return sendOperationError(reply, error); }
    });

    app.get("/v1/reviews/comments", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const principal = await resolvePrincipal(withPrincipalRouteBinding(request, "GET", "/v1/reviews/comments"));
            const decoded = parseReviewCommentRouteQuery(request.query ?? {}) as Record<string, unknown>;
            const { stored, ...query } = decoded;
            const list = stored === "true" || stored === true ? operations.listStored : operations.list;
            return await list({
                ...principal,
                input: parseReviewCommentRouteInput(
                    ReviewCommentListRequestV1Schema,
                    query,
                    "review_comment_invalid_filter",
                ),
            });
        } catch (error) {
            return sendOperationError(reply, error);
        }
    });

    app.get("/v1/reviews/comments/:commentId", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const params = request.params as { commentId: string };
            const principal = await resolvePrincipal(withPrincipalRouteBinding(
                request,
                "GET",
                `/v1/reviews/comments/${encodeReviewCommentPathSegment(params.commentId)}`,
            ));
            const { stored, ...query } = request.query as Record<string, unknown> ?? {};
            const get = stored === "true" || stored === true ? operations.getStored : operations.get;
            return await get({
                ...principal,
                input: parseReviewCommentRouteInput(
                    ReviewCommentGetRequestV1Schema,
                    parseReviewCommentRouteQuery({
                        commentId: params.commentId,
                        ...query,
                    }),
                    "review_comment_invalid_request",
                ),
            });
        } catch (error) {
            return sendOperationError(reply, error);
        }
    });

    app.post("/v1/reviews/comments", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const principal = await resolvePrincipal(withPrincipalRouteBinding(request, "POST", "/v1/reviews/comments"));
            return await operations.create({
                ...principal,
                input: parseReviewCommentRouteInput(
                    ReviewCommentCreateRequestV1Schema,
                    request.body,
                    "review_comment_invalid_request",
                ),
            });
        } catch (error) {
            return sendOperationError(reply, error);
        }
    });

    app.patch("/v1/reviews/comments/:commentId", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const params = request.params as { commentId: string };
            const principal = await resolvePrincipal(withPrincipalRouteBinding(
                request,
                "PATCH",
                `/v1/reviews/comments/${encodeReviewCommentPathSegment(params.commentId)}`,
            ));
            return await operations.edit({
                ...principal,
                input: parseReviewCommentRouteInput(
                    ReviewCommentEditRequestV1Schema,
                    {
                        commentId: params.commentId,
                        ...(request.body as Record<string, unknown>),
                    },
                    "review_comment_invalid_request",
                ),
            });
        } catch (error) {
            return sendOperationError(reply, error);
        }
    });

    app.post("/v1/reviews/comments/:commentId/transition", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const params = request.params as { commentId: string };
            const principal = await resolvePrincipal(withPrincipalRouteBinding(
                request,
                "POST",
                `/v1/reviews/comments/${encodeReviewCommentPathSegment(params.commentId)}/transition`,
            ));
            return await operations.transition({
                ...principal,
                input: parseReviewCommentRouteInput(
                    ReviewCommentTransitionRequestV1Schema,
                    {
                        commentId: params.commentId,
                        ...(request.body as Record<string, unknown>),
                    },
                    "review_comment_invalid_request",
                ),
            });
        } catch (error) {
            return sendOperationError(reply, error);
        }
    });

    app.post("/v1/reviews/comments/:commentId/reply", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const params = request.params as { commentId: string };
            const principal = await resolvePrincipal(withPrincipalRouteBinding(
                request,
                "POST",
                `/v1/reviews/comments/${encodeReviewCommentPathSegment(params.commentId)}/reply`,
            ));
            return await operations.reply({
                ...principal,
                input: parseReviewCommentRouteInput(
                    ReviewCommentReplyRequestV1Schema,
                    {
                        parentCommentId: params.commentId,
                        ...(request.body as Record<string, unknown>),
                    },
                    "review_comment_invalid_request",
                ),
            });
        } catch (error) {
            return sendOperationError(reply, error);
        }
    });

    app.post("/v1/reviews/comments/:commentId/redact", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const params = request.params as { commentId: string };
            const principal = await resolvePrincipal(withPrincipalRouteBinding(
                request,
                "POST",
                `/v1/reviews/comments/${encodeReviewCommentPathSegment(params.commentId)}/redact`,
            ));
            return await operations.redact({
                ...principal,
                input: parseReviewCommentRouteInput(
                    ReviewCommentRedactRequestV1Schema,
                    {
                        commentId: params.commentId,
                        ...(request.body as Record<string, unknown>),
                    },
                    "review_comment_invalid_request",
                ),
            });
        } catch (error) {
            return sendOperationError(reply, error);
        }
    });

    app.post("/v1/reviews/comments/:commentId/disposition", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const params = request.params as { commentId: string };
            const principal = await resolvePrincipal(withPrincipalRouteBinding(
                request,
                "POST",
                `/v1/reviews/comments/${encodeReviewCommentPathSegment(params.commentId)}/disposition`,
            ));
            return await operations.setDisposition({
                ...principal,
                input: parseReviewCommentRouteInput(
                    ReviewCommentSetDispositionRequestV1Schema,
                    {
                        commentId: params.commentId,
                        ...(request.body as Record<string, unknown>),
                    },
                    "review_comment_invalid_request",
                ),
            });
        } catch (error) {
            return sendOperationError(reply, error);
        }
    });

    app.post("/v1/reviews/comments/:commentId/evidence", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const params = request.params as { commentId: string };
            const principal = await resolvePrincipal(withPrincipalRouteBinding(
                request,
                "POST",
                `/v1/reviews/comments/${encodeReviewCommentPathSegment(params.commentId)}/evidence`,
            ));
            return await operations.attachEvidence({
                ...principal,
                input: parseReviewCommentRouteInput(
                    ReviewCommentAttachEvidenceRequestV1Schema,
                    {
                        commentId: params.commentId,
                        ...(request.body as Record<string, unknown>),
                    },
                    "review_comment_invalid_request",
                ),
            });
        } catch (error) {
            return sendOperationError(reply, error);
        }
    });

    app.post("/v1/reviews/comments/bulkTransition", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const principal = await resolvePrincipal(withPrincipalRouteBinding(request, "POST", "/v1/reviews/comments/bulkTransition"));
            return await operations.bulkTransition({
                ...principal,
                input: parseReviewCommentRouteInput(
                    ReviewCommentBulkTransitionRequestV1Schema,
                    request.body,
                    "review_comment_invalid_request",
                ),
            });
        } catch (error) {
            return sendOperationError(reply, error);
        }
    });

    app.post("/v1/reviews/comments/publication/claim", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const principal = await resolvePrincipal(withPrincipalRouteBinding(
                request,
                "POST",
                "/v1/reviews/comments/publication/claim",
            ));
            return await operations.claimPublicationDispatch({
                ...principal,
                input: parseReviewCommentRouteInput(
                    ReviewCommentPublicationTransportRequestV1Schema,
                    request.body,
                    "review_comment_invalid_request",
                ),
            });
        } catch (error) {
            return sendOperationError(reply, error);
        }
    });
}
