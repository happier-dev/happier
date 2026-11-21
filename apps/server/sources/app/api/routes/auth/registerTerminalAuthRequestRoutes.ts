import { z } from "zod/mini";
import * as privacyKit from "privacy-kit";
import { createHash } from "node:crypto";
import { TerminalApprovalSuccessSchema, type TerminalApprovalSuccess } from "@happier-dev/protocol/auth/terminalApproval";
import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { debug } from "@/utils/logging/log";
import { type Fastify } from "../../types";
import { terminalAuthRequestExpiresAt, type TerminalAuthRequestPolicy } from "./terminalAuthRequestPolicy";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import {
    PresentUserRequiredResponseSchema,
    requirePresentUser,
} from "@/app/api/utils/requirePresentUser";
import { inReadSnapshot, inTx, type Tx } from "@/storage/inTx";
import { evaluateProvisioningResponsePolicy } from "./provisioningResponsePolicy";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import {
    parseAuthenticationEvidenceSnapshot,
    resolveCurrentAuthenticationEvidenceInTx,
} from "@/app/auth/authenticationEvidence";
import { AuthTokenAuthenticationEvidenceSnapshotV1Schema, type AuthTokenAuthenticationEvidenceV1 } from '@happier-dev/protocol/auth/authToken';
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";
import { deploymentAppTerminalEnrollmentIsActiveInTx } from '@/app/deployments/deploymentAppEnrollment';

const BASE64_URL_REGEX = /^[A-Za-z0-9_-]+$/;
const EXPIRED_TERMINAL_AUTH_CLEANUP_LIMIT = 32;

type IsTerminalAuthExpired = (createdAt: Date) => boolean;

type RegisterTerminalAuthRequestRoutesContext = {
    terminalAuthPolicy: TerminalAuthRequestPolicy;
    isTerminalAuthExpired: IsTerminalAuthExpired;
};

async function resolveApprovedTerminalEvidenceInTx(
    tx: Tx,
    input: Readonly<{
        accountId: string;
        approvalTokenEpoch: number | null;
        snapshotValue: unknown;
    }>,
): Promise<Readonly<
    | { status: "current"; evidence: readonly AuthTokenAuthenticationEvidenceV1[] }
    | { status: "unavailable" }
>> {
    if (input.approvalTokenEpoch === null) return { status: "current", evidence: [] };
    const account = await tx.account.findUnique({
        where: { id: input.accountId },
        select: { tokenEpoch: true },
    });
    if (account?.tokenEpoch !== input.approvalTokenEpoch) return { status: "unavailable" };
    // Account devices can connect a terminal without a sign-in factor to pass on.
    // Team policy qualifies the resulting credential against its own requirements.
    if (input.snapshotValue === null) return { status: "current", evidence: [] };
    const snapshot = parseAuthenticationEvidenceSnapshot(input.snapshotValue);
    if (!snapshot) return { status: "unavailable" };
    const evidence = await resolveCurrentAuthenticationEvidenceInTx(tx, {
        env: process.env,
        accountId: input.accountId,
        evidence: snapshot.evidence,
    });
    return evidence.length > 0 ? { status: "current", evidence } : { status: "unavailable" };
}

async function cleanupExpiredTerminalAuthRequests(params: Readonly<{
    now: Date;
    ttlMs: number;
    excludeId?: string;
}>): Promise<void> {
    const expired = await db.terminalAuthRequest.findMany({
        where: {
            createdAt: { lt: new Date(params.now.getTime() - params.ttlMs) },
            ...(params.excludeId ? { id: { not: params.excludeId } } : {}),
        },
        orderBy: { createdAt: "asc" },
        take: EXPIRED_TERMINAL_AUTH_CLEANUP_LIMIT,
        select: { id: true },
    });
    if (expired.length === 0) return;
    await db.terminalAuthRequest.deleteMany({
        where: { id: { in: expired.map((row) => row.id) } },
    });
}

function buildTerminalAuthAuthorizedPayload(params: {
    token: string;
    response: string;
    serverIdentityId: string;
}): {
    state: "authorized";
    token: string;
    response: string;
    serverIdentityId: string;
} {
    return {
        state: "authorized",
        token: params.token,
        response: params.response,
        serverIdentityId: params.serverIdentityId,
    };
}

export function registerTerminalAuthRequestRoutes(
    app: Fastify,
    context: RegisterTerminalAuthRequestRoutesContext,
): void {
    const { terminalAuthPolicy, isTerminalAuthExpired } = context;

    app.post('/v1/auth/request', {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.terminalRequest.poll") },
        schema: {
            body: z.object({
                publicKey: z.string(),
                supportsV2: z.nullish(z.boolean()),
                claimSecretHash: z.nullish(z.string().check(z.length(43), z.regex(BASE64_URL_REGEX))),
            }),
            response: {
                200: z.union([
                    z.strictObject({ state: z.literal('requested'), expiresAt: z.number().check(z.int()) }),
                    z.strictObject({
                        state: z.literal('authorized'),
                        token: z.string(),
                        response: z.string(),
                        serverIdentityId: z.optional(z.string()),
                    }),
                    z.strictObject({ state: z.literal('authorized') }),
                ]),
                409: z.object({ error: z.enum([
                    'claim_mismatch',
                    'credential_authentication_evidence_unavailable',
                ]) }),
                410: z.object({ error: z.literal('expired') }),
                401: z.object({
                    error: z.literal('Invalid public key')
                })
            }
        }
    }, async (request, reply) => {
        const tweetnacl = (await import("tweetnacl")).default;
        if (String(request.body.publicKey).length > 512) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }
        let publicKey: ReturnType<typeof privacyKit.decodeBase64>;
        try {
            publicKey = privacyKit.decodeBase64(request.body.publicKey);
        } catch {
            return reply.code(401).send({ error: 'Invalid public key' });
        }
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }

        const publicKeyHex = privacyKit.encodeHex(publicKey);
        const requestId = createHash("sha256").update(publicKeyHex).digest("hex").slice(0, 12);
        debug({ module: 'auth-request' }, `Terminal auth request - id: ${requestId}`);

        const claimSecretHash = (request.body.claimSecretHash ?? null) ? String(request.body.claimSecretHash) : null;

        const existing = await db.terminalAuthRequest.findUnique({
            where: { publicKey: publicKeyHex },
        });
        await cleanupExpiredTerminalAuthRequests({
            now: new Date(),
            ttlMs: terminalAuthPolicy.ttlMs,
            excludeId: existing?.id,
        }).catch(() => {});

        if (existing && isTerminalAuthExpired(existing.createdAt)) {
            await db.terminalAuthRequest.delete({ where: { id: existing.id } }).catch(() => {});
            return reply.code(410).send({ error: "expired" as const });
        }

        if (existing && claimSecretHash && existing.claimSecretHash !== claimSecretHash) {
            return reply.code(409).send({ error: "claim_mismatch" as const });
        }

        const answer = existing
            ? await db.terminalAuthRequest.update({
                where: { id: existing.id },
                data: {
                    ...(typeof request.body.supportsV2 === "boolean" && existing.supportsV2 !== request.body.supportsV2
                        ? { supportsV2: request.body.supportsV2 }
                        : {}),
                },
            })
            : await db.terminalAuthRequest.create({
                data: {
                    publicKey: publicKeyHex,
                    supportsV2: request.body.supportsV2 ?? false,
                    ...(claimSecretHash ? { claimSecretHash } : {}),
                },
            });

        if (answer.response && answer.responseAccountId) {
            // If this request is claim-gated, never return the bearer token on the unauthenticated polling endpoint.
            if (answer.claimSecretHash) {
                return reply.send({ state: "authorized" as const });
            }
            const serverIdentityId = await getOrCreateServerIdentityId(process.env);
            const tokenResult = await inReadSnapshot(async (tx) => {
                const resolved = await resolveApprovedTerminalEvidenceInTx(tx, {
                    accountId: answer.responseAccountId!,
                    approvalTokenEpoch: answer.approvalTokenEpoch,
                    snapshotValue: answer.authenticationEvidence,
                });
                if (resolved.status === "unavailable") {
                    return { status: "evidence_unavailable" } as const;
                }
                return { status: "created", token: await auth.createTokenInTx(tx, answer.responseAccountId!, { session: answer.id,
                    ...(answer.deploymentAppEnrollment !== null ? { deploymentAppEnrollment: answer.deploymentAppEnrollment } : {}) }, {
                    kind: "terminal",
                    authority: "account_automation",
                    ...(resolved.evidence.length > 0 ? { authenticationEvidence: resolved.evidence } : {}),
                }) } as const;
            });
            if (tokenResult.status === "evidence_unavailable") {
                return reply.code(409).send({ error: "credential_authentication_evidence_unavailable" as const });
            }
            return reply.send(buildTerminalAuthAuthorizedPayload({
                token: tokenResult.token,
                response: answer.response,
                serverIdentityId,
            }));
        }

        return reply.send({ state: 'requested', expiresAt: terminalAuthRequestExpiresAt(answer.createdAt, terminalAuthPolicy) });
    });

    // Get auth request status
    app.get('/v1/auth/request/status', {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.terminalRequest.status") },
        schema: {
            querystring: z.object({
                publicKey: z.string(),
            }),
            response: {
                200: z.object({
                    status: z.enum(['not_found', 'pending', 'authorized']),
                    supportsV2: z.boolean()
                })
            }
        }
    }, async (request, reply) => {
        const tweetnacl = (await import("tweetnacl")).default;
        if (String(request.query.publicKey).length > 512) {
            return reply.send({ status: 'not_found', supportsV2: false });
        }
        let publicKey: ReturnType<typeof privacyKit.decodeBase64>;
        try {
            publicKey = privacyKit.decodeBase64(request.query.publicKey);
        } catch {
            return reply.send({ status: 'not_found', supportsV2: false });
        }
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            return reply.send({ status: 'not_found', supportsV2: false });
        }

        const publicKeyHex = privacyKit.encodeHex(publicKey);
        const authRequest = await db.terminalAuthRequest.findUnique({
            where: { publicKey: publicKeyHex }
        });

        if (!authRequest) {
            return reply.send({ status: 'not_found', supportsV2: false });
        }

        if (isTerminalAuthExpired(authRequest.createdAt)) {
            await db.terminalAuthRequest.delete({ where: { id: authRequest.id } }).catch(() => {});
            return reply.send({ status: "not_found", supportsV2: false });
        }

        if (authRequest.response && authRequest.responseAccountId) {
            return reply.send({ status: 'authorized', supportsV2: authRequest.supportsV2 });
        }

        return reply.send({ status: 'pending', supportsV2: authRequest.supportsV2 });
    });

    app.post("/v1/auth/request/claim", {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.terminalRequest.claim") },
        schema: {
            body: z.object({
                publicKey: z.string(),
                claimSecret: z.string().check(z.minLength(1), z.maxLength(256), z.regex(BASE64_URL_REGEX)),
            }),
            response: {
                200: z.union([
                    z.object({ state: z.literal("requested") }),
                    z.object({
                        state: z.literal("authorized"),
                        token: z.string(),
                        response: z.string(),
                        serverIdentityId: z.optional(z.string()),
                    }),
                ]),
                409: z.object({ error: z.enum([
                    "claim_not_supported",
                    "credential_authentication_evidence_unavailable",
                ]) }),
                401: z.object({ error: z.literal("unauthorized") }),
                410: z.union([z.object({ error: z.literal("expired") }), z.object({ error: z.literal("consumed") })]),
            },
        },
    }, async (request, reply) => {
        const tweetnacl = (await import("tweetnacl")).default;
        if (String(request.body.publicKey).length > 512) {
            return reply.code(410).send({ error: "expired" as const });
        }
        let publicKey: ReturnType<typeof privacyKit.decodeBase64>;
        try {
            publicKey = privacyKit.decodeBase64(request.body.publicKey);
        } catch {
            return reply.code(410).send({ error: "expired" as const });
        }
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            return reply.code(410).send({ error: "expired" as const });
        }

        const publicKeyHex = privacyKit.encodeHex(publicKey);
        const authRequest = await db.terminalAuthRequest.findUnique({
            where: { publicKey: publicKeyHex },
        });
        if (!authRequest) {
            return reply.code(410).send({ error: "expired" as const });
        }

        if (isTerminalAuthExpired(authRequest.createdAt)) {
            await db.terminalAuthRequest.delete({ where: { id: authRequest.id } }).catch(() => {});
            return reply.code(410).send({ error: "expired" as const });
        }

        if (!authRequest.claimSecretHash) {
            return reply.code(409).send({ error: "claim_not_supported" as const });
        }

        let claimSecretBytes: Buffer;
        try {
            claimSecretBytes = Buffer.from(String(request.body.claimSecret), "base64url");
        } catch {
            return reply.code(401).send({ error: "unauthorized" as const });
        }

        const computedHash = createHash("sha256").update(claimSecretBytes).digest("base64url");
        if (computedHash !== authRequest.claimSecretHash) {
            return reply.code(401).send({ error: "unauthorized" as const });
        }

        if (!(authRequest.response && authRequest.responseAccountId)) {
            return reply.send({ state: "requested" as const });
        }

        // Resolve every fallible part of the response before publishing the one-shot
        // claim. A failed identity lookup or token mint must leave the request retryable.
        const serverIdentityId = await getOrCreateServerIdentityId(process.env);
        const tokenResult = await inReadSnapshot(async (tx) => {
            const resolved = await resolveApprovedTerminalEvidenceInTx(tx, {
                accountId: authRequest.responseAccountId!,
                approvalTokenEpoch: authRequest.approvalTokenEpoch,
                snapshotValue: authRequest.authenticationEvidence,
            });
            if (resolved.status === "unavailable") {
                return { status: "evidence_unavailable" } as const;
            }
            return { status: "created", token: await auth.createTokenInTx(tx, authRequest.responseAccountId!, { session: authRequest.id,
                ...(authRequest.deploymentAppEnrollment !== null ? { deploymentAppEnrollment: authRequest.deploymentAppEnrollment } : {}) }, {
                kind: "terminal",
                authority: "account_automation",
                ...(resolved.evidence.length > 0 ? { authenticationEvidence: resolved.evidence } : {}),
            }) } as const;
        });
        if (tokenResult.status === "evidence_unavailable") {
            return reply.code(409).send({ error: "credential_authentication_evidence_unavailable" as const });
        }
        const authorizedPayload = buildTerminalAuthAuthorizedPayload({
            token: tokenResult.token,
            response: authRequest.response,
            serverIdentityId,
        });

        const claimUpdate = await db.terminalAuthRequest.updateMany({
            where: { id: authRequest.id, claimedAt: null },
            data: { claimedAt: new Date() },
        });
        if (claimUpdate.count === 0) {
            return reply.code(410).send({ error: "consumed" as const });
        }

        return reply.send(authorizedPayload);
    });

    // Approve auth request
    app.post('/v1/auth/response', {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.terminalRequest.complete") },
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            body: z.strictObject({
                response: z.string(),
                publicKey: z.string(),
                responseKind: z.optional(z.enum(["tokenOnly", "dataKey"])),
                authorizeUnattendedTeamAccess: z.optional(z.boolean()),
            }),
            response: {
                200: TerminalApprovalSuccessSchema,
                400: z.object({ error: z.literal("invalid_provisioning_response") }),
                401: z.object({ error: z.literal("Invalid public key") }),
                403: PresentUserRequiredResponseSchema,
                404: z.object({ error: z.literal("Request not found") }),
                409: z.strictObject({
                    error: z.enum([
                        "provisioning_kind_mismatch",
                        "provisioning_material_unavailable",
                        "already_completed",
                        "enrollment_unavailable",
                    ]),
                }),
                426: z.strictObject({ error: z.literal("terminal_provisioning_update_required") }),
            },
        }
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        debug({ module: 'auth-response' }, `Auth response endpoint hit - user: ${request.userId}`);
        const tweetnacl = (await import("tweetnacl")).default;
        if (String(request.body.publicKey).length > 512) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }
        let publicKey: ReturnType<typeof privacyKit.decodeBase64>;
        try {
            publicKey = privacyKit.decodeBase64(request.body.publicKey);
        } catch {
            return reply.code(401).send({ error: 'Invalid public key' });
        }
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }
        const responseKind = request.body.responseKind;
        if (!responseKind) {
            return reply.code(426).send({ error: "terminal_provisioning_update_required" });
        }
        const publicKeyHex = privacyKit.encodeHex(publicKey);
        const requestedUnattendedAccess = request.body.authorizeUnattendedTeamAccess === true;
        const approved = (hasEvidenceSnapshot: boolean) => {
            const receipt: TerminalApprovalSuccess = requestedUnattendedAccess && !hasEvidenceSnapshot
                ? { success: true, unattendedTeamAccess: "authentication_evidence_unavailable" }
                : { success: true };
            return { status: "success", receipt } as const;
        };
        const outcome = await inTx(async (tx) => {
            const authRequest = await tx.terminalAuthRequest.findUnique({
                where: { publicKey: publicKeyHex },
            });
            if (!authRequest) return { status: "not_found" } as const;
            if (isTerminalAuthExpired(authRequest.createdAt)) {
                await tx.terminalAuthRequest.deleteMany({ where: { id: authRequest.id } });
                return { status: "expired" } as const;
            }
            if (!authRequest.supportsV2) return { status: "update_required" } as const;
            if (authRequest.deploymentAppEnrollment !== null && !await deploymentAppTerminalEnrollmentIsActiveInTx(
                tx, authRequest.deploymentAppEnrollment, request.userId)) return { status: 'enrollment_unavailable' } as const;

            const account = await tx.account.findUnique({
                where: { id: request.userId },
                select: {
                    publicKey: true,
                    encryptionMode: true,
                    contentPublicKey: true,
                    contentPublicKeySig: true,
                    tokenEpoch: true,
                },
            });
            if (!account) return { status: "material_unavailable" } as const;
            const policy = evaluateProvisioningResponsePolicy({
                account,
                responseBase64: request.body.response,
                responseKind,
            });
            if (policy.status === "rejected") {
                return { status: "policy_rejected", reason: policy.reason } as const;
            }

            if (authRequest.response !== null || authRequest.responseAccountId !== null) {
                const existingAuthorized = authRequest.approvalTokenEpoch !== null;
                return authRequest.response === request.body.response
                    && authRequest.responseAccountId === request.userId
                    && existingAuthorized === requestedUnattendedAccess
                    ? approved(authRequest.authenticationEvidence !== null)
                    : { status: "already_completed" } as const;
            }
            const evidence = requestedUnattendedAccess
                ? await resolveCurrentAuthenticationEvidenceInTx(tx, {
                    env: requestHomeEnv,
                    accountId: request.userId,
                    evidence: request.authTokenAuthenticationEvidence,
                })
                : [];
            const evidenceSnapshot = evidence.length > 0
                ? AuthTokenAuthenticationEvidenceSnapshotV1Schema.parse({ v: 1, evidence })
                : null;
            const completed = await tx.terminalAuthRequest.updateMany({
                where: {
                    id: authRequest.id,
                    response: null,
                    responseAccountId: null,
                },
                data: {
                    response: request.body.response,
                    responseAccountId: request.userId,
                    authenticationEvidence: evidenceSnapshot,
                    approvalTokenEpoch: requestedUnattendedAccess ? account.tokenEpoch : null,
                },
            });
            if (completed.count === 1) return approved(evidenceSnapshot !== null);
            const raced = await tx.terminalAuthRequest.findUnique({
                where: { id: authRequest.id },
                select: { response: true, responseAccountId: true, approvalTokenEpoch: true, authenticationEvidence: true },
            });
            return raced?.response === request.body.response
                && raced.responseAccountId === request.userId
                && (raced.approvalTokenEpoch !== null) === requestedUnattendedAccess
                ? approved(raced.authenticationEvidence !== null)
                : { status: "already_completed" } as const;
        });

        if (outcome.status === "success") {
            return reply.send(outcome.receipt);
        }
        if (outcome.status === "expired") {
            return reply.code(404).send({ error: "Request not found" });
        }
        if (outcome.status === "not_found") return reply.code(404).send({ error: "Request not found" });
        if (outcome.status === "update_required") {
            return reply.code(426).send({ error: "terminal_provisioning_update_required" });
        }
        if (outcome.status === "material_unavailable") {
            return reply.code(409).send({ error: "provisioning_material_unavailable" });
        }
        if (outcome.status === "already_completed") {
            return reply.code(409).send({ error: "already_completed" });
        }
        if (outcome.status === 'enrollment_unavailable') return reply.code(409).send({ error: 'enrollment_unavailable' });
        const statusCode = outcome.reason === "invalid_provisioning_response" ? 400 : 409;
        return reply.code(statusCode).send({ error: outcome.reason });
    });
}
