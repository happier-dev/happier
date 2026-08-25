import { createHash, randomUUID } from "node:crypto";
import type { Fastify } from "@/app/api/types";
import type { ReviewCommentActorRefV1, ReviewCommentPrincipalHeaderV1 } from "@happier-dev/protocol";
import type { z } from "zod";
import {
    GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
    createReviewCommentPrincipalSigningInputV1,
    REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
    REVIEW_COMMENT_PRINCIPAL_HEADER_V1,
    ReviewCommentAttachEvidenceRequestV1Schema,
    ReviewCommentBulkTransitionRequestV1Schema,
    ReviewCommentClaimPublicationDispatchRequestV1Schema,
    ReviewCommentCreateRequestV1Schema,
    ReviewCommentEditRequestV1Schema,
    ReviewCommentGetRequestV1Schema,
    ReviewCommentListRequestV1Schema,
    ReviewCommentRedactRequestV1Schema,
    ReviewCommentReplyRequestV1Schema,
    ReviewCommentSetDispositionRequestV1Schema,
    ReviewCommentPrincipalHeaderV1Schema,
    ReviewCommentTransitionRequestV1Schema,
    reviewCommentMutationInputWithoutEventEnvelopeV1,
    stringifyReviewCommentPrincipalCanonicalJsonV1,
} from "@happier-dev/protocol";
import tweetnacl from "tweetnacl";

import {
    createReviewCommentOperations,
    type ReviewCommentOperations,
} from "./operations";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { db } from "@/storage/db";
import { ReviewCommentOperationError } from "./errors";
import type { ReviewCommentPrincipal } from "./permissions";
import { createSqlReviewCommentStore } from "./store";
import { resolveTrustedPluginPermissionGrants } from "@/app/plugins/permissions/resolve";

const DEFAULT_REVIEW_COMMENT_PRINCIPAL_PROOF_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_REVIEW_COMMENT_PRINCIPAL_PROOF_CLOCK_SKEW_MS = 60_000;

export type ReviewCommentRoutePrincipalResolver = (
    request: Readonly<{
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
    machineId: string;
    installationId: string;
}>> {
    if (params.headerPrincipal.actor.kind === "user") {
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
        const body = ReviewCommentCreateRequestV1Schema.safeParse(params.body);
        const logicalEffectBodySha256Base64Url = body.success
            ? createHash("sha256")
                .update(stringifyReviewCommentPrincipalCanonicalJsonV1(
                    reviewCommentMutationInputWithoutEventEnvelopeV1({ ...body.data }),
                ))
                .digest("base64url")
            : null;
        if (
            proof.method !== "POST"
            || proof.path !== "/v1/reviews/comments"
            || currentIntent.effectBodySha256Base64Url !== logicalEffectBodySha256Base64Url
            || params.headerPrincipal.actor.kind !== "agent"
            || currentIntent.agentId !== params.headerPrincipal.actor.agentId
            || currentIntent.sessionId !== params.headerPrincipal.actor.sessionId
            || !body.success
            || currentIntent.projectId !== body.data.projectId
            || currentIntent.workspaceId !== body.data.workspaceId
            || currentIntent.sessionId !== body.data.sessionId
            || currentIntent.runId !== body.data.runId
            || currentIntent.pluginId !== body.data.engineId
        ) {
            throw new ReviewCommentOperationError(
                "review_comment_permission_denied",
                "Review-comment current intent does not match the exact effect",
            );
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
        machineId: proof.machineId,
        installationId: proof.installationId,
    };
}

async function resolveDefaultPrincipal(request: Readonly<{
    userId: string;
    body?: unknown;
    method?: string;
    path?: string;
    headers?: Record<string, string | string[] | undefined>;
}>): Promise<ReviewCommentPrincipal> {
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
    if (!account || mode?.status !== "ready" || currentness?.status !== "ready") {
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
    const grantPluginId = actor.kind === "plugin"
        ? actor.pluginId
        : verifiedHeaderPrincipal?.currentIntent?.pluginId;
    const trustedGrants = grantPluginId
        ? await resolveTrustedPluginPermissionGrants({
            accountId: request.userId,
            machineId: verifiedHeaderPrincipal?.machineId,
            installationId: verifiedHeaderPrincipal?.installationId,
            pluginId: grantPluginId,
            capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
            targetScope: readReviewCommentCreateTargetScope(request.body),
            subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
        })
        : [];
    return {
        accountId: request.userId,
        actor,
        grants: trustedGrants.map((grant) => grant.capability),
        ...(verifiedHeaderPrincipal?.currentIntent ? { currentIntent: verifiedHeaderPrincipal.currentIntent } : {}),
        storageMode: mode.mode,
        accountVersion: account.seq,
        accountEncryptionCurrentness: currentness.currentness,
    };
}

function readReviewCommentCreateTargetScope(body: unknown): { kind: "project"; projectId: string } | null {
    if (!body || typeof body !== "object") return null;
    const projectId = (body as { projectId?: unknown }).projectId;
    if (typeof projectId !== "string" || projectId.trim().length === 0) return null;
    return { kind: "project", projectId: projectId.trim() };
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
    schema: z.ZodType<T>,
    input: unknown,
    code: ReviewCommentOperationError["code"],
): T {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;
    throw new ReviewCommentOperationError(code, "Review comment request is invalid");
}

export function registerReviewCommentRoutes(app: Fastify, options: ReviewCommentRoutesOptions = {}): void {
    const operations = options.operations ?? createDefaultOperations();
    const resolvePrincipal = options.resolvePrincipal ?? resolveDefaultPrincipal;

    app.get("/v1/reviews/comments", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const principal = await resolvePrincipal(withPrincipalRouteBinding(request, "GET", "/v1/reviews/comments"));
            return await operations.list({
                accountId: principal.accountId,
                input: parseReviewCommentRouteInput(
                    ReviewCommentListRequestV1Schema,
                    request.query ?? {},
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
            return await operations.get({
                accountId: principal.accountId,
                input: parseReviewCommentRouteInput(
                    ReviewCommentGetRequestV1Schema,
                    {
                        commentId: params.commentId,
                        ...(request.query ?? {}),
                    },
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

    app.post("/v1/reviews/comments/:commentId/publication/claim", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        try {
            const params = request.params as { commentId: string };
            const principal = await resolvePrincipal(withPrincipalRouteBinding(
                request,
                "POST",
                `/v1/reviews/comments/${encodeReviewCommentPathSegment(params.commentId)}/publication/claim`,
            ));
            return await operations.claimPublicationDispatch({
                ...principal,
                input: parseReviewCommentRouteInput(
                    ReviewCommentClaimPublicationDispatchRequestV1Schema,
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
}
