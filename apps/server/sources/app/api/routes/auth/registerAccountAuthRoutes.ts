import { z } from "zod/mini";
import type { FastifyReply } from "fastify";
import * as privacyKit from "privacy-kit";
import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { type Fastify } from "../../types";
import { resolveAccountAuthRequestPolicyFromEnv } from "./accountAuthRequestPolicy";
import {
    PresentUserRequiredResponseSchema,
    requirePresentUser,
} from "@/app/api/utils/requirePresentUser";
import { inTx } from "@/storage/inTx";
import { readCachedServerIdentityIdForHotPath } from "@/app/serverIdentity/serverIdentity";
import { evaluateProvisioningResponsePolicy } from "./provisioningResponsePolicy";
import { BOX_BUNDLE_MIN_BYTES } from '@happier-dev/protocol/crypto/boxBundleFormat';
import { inspectTerminalProvisioningV3Payload } from '@happier-dev/protocol/crypto/terminalProvisioningV2';
import { isValidBoxBundlePublicKey, sealBoxBundle } from '@happier-dev/protocol/crypto/boxBundle';
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";

const MAX_PERSISTED_ENCRYPTED_TOKEN_CHARS = 16_384;
const EXPIRED_ACCOUNT_AUTH_CLEANUP_LIMIT = 32;

class DirectQrCompletionConflictError extends Error {}

type AccountAuthRequestInput = Readonly<{
    body: Readonly<{
        publicKey: string;
        pairId?: string;
        homeServerIdentityId?: string;
    }>;
}>;

async function cleanupExpiredAccountAuthRequests(params: Readonly<{
    now: Date;
    ttlMs: number;
}>): Promise<void> {
    const expired = await db.accountAuthRequest.findMany({
        where: { createdAt: { lt: new Date(params.now.getTime() - params.ttlMs) } },
        orderBy: { createdAt: "asc" },
        take: EXPIRED_ACCOUNT_AUTH_CLEANUP_LIMIT,
        select: { id: true },
    });
    if (expired.length === 0) return;
    await db.accountAuthRequest.deleteMany({
        where: { id: { in: expired.map((row) => row.id) } },
    });
}

function isCanonicalPersistedProvisioningResponse(value: string): boolean {
    try {
        const decoded = privacyKit.decodeBase64(value);
        return privacyKit.encodeBase64(decoded) === value
            && inspectTerminalProvisioningV3Payload(decoded) !== null;
    } catch {
        return false;
    }
}

function isCanonicalPersistedEncryptedToken(value: string): boolean {
    if (value.length === 0 || value.length > MAX_PERSISTED_ENCRYPTED_TOKEN_CHARS) return false;
    try {
        const decoded = privacyKit.decodeBase64(value);
        return decoded.length >= BOX_BUNDLE_MIN_BYTES && privacyKit.encodeBase64(decoded) === value;
    } catch {
        return false;
    }
}

function decodeCanonicalRequesterPublicKey(value: string): Uint8Array<ArrayBuffer> | null {
    if (value.length > 512) return null;
    try {
        const decoded = privacyKit.decodeBase64(value);
        return privacyKit.encodeBase64(decoded) === value && isValidBoxBundlePublicKey(decoded)
            ? decoded
            : null;
    } catch {
        return null;
    }
}

export function registerAccountAuthRoutes(app: Fastify): void {
    const requestedSchema = z.strictObject({ state: z.literal('requested') });
    const rejectedSchema = z.strictObject({ state: z.literal('rejected') });
    const invalidKeySchema = z.strictObject({ error: z.literal('Invalid public key') });
    const requestNotFoundSchema = z.strictObject({ error: z.literal('Request not found') });
    const responseSuccessSchema = z.strictObject({ success: z.literal(true) });
    const provisioningErrorSchema = z.strictObject({
        error: z.enum([
            "invalid_provisioning_response",
            "provisioning_kind_mismatch",
            "provisioning_material_unavailable",
            "account_provisioning_update_required",
            "account_provisioning_inconsistent",
            "already_completed",
            "wrong_home",
            "home_identity_unavailable",
        ]),
    });
    const badRequestSchema = z.union([
        provisioningErrorSchema,
        z.looseObject({
            statusCode: z.literal(400),
            error: z.string().check(z.minLength(1)),
            message: z.string().check(z.minLength(1)),
        }),
    ]);
    const authorizedV2Schema = z.strictObject({
        state: z.literal('authorized'),
        tokenEncrypted: z.string(),
        response: z.string(),
    });

    const handleCommonRequest = async (
        version: 'v1' | 'v2',
        request: AccountAuthRequestInput,
        reply: FastifyReply,
    ) => {
        const publicKey = decodeCanonicalRequesterPublicKey(request.body.publicKey);
        if (!publicKey) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }

        const policy = resolveAccountAuthRequestPolicyFromEnv(process.env);
        const isExpired = (createdAt: Date): boolean => {
            const ageMs = Date.now() - createdAt.getTime();
            return ageMs > policy.ttlMs;
        };

        await cleanupExpiredAccountAuthRequests({ now: new Date(), ttlMs: policy.ttlMs }).catch(() => {});

        const publicKeyHex = privacyKit.encodeHex(publicKey);
        const existing = await db.accountAuthRequest.findUnique({
            where: { publicKey: publicKeyHex },
        });
        if (existing && isExpired(existing.createdAt)) {
            // Best-effort cleanup: expired requests should not linger indefinitely.
            await db.accountAuthRequest.delete({ where: { id: existing.id } }).catch(() => {});
        }

        const answer = await db.accountAuthRequest.upsert({
            where: { publicKey: publicKeyHex },
            update: {},
            create: { publicKey: publicKeyHex },
        });

        // Expiry also applies after response to avoid indefinite "wait arbitrarily long then fetch token" behavior.
        if (isExpired(answer.createdAt)) {
            await db.accountAuthRequest.delete({ where: { id: answer.id } }).catch(() => {});
            return reply.send({ state: 'requested' });
        }

        if (answer.response === null && answer.responseAccountId === null && answer.tokenEncrypted === null) {
            const pairId = request.body.pairId;
            const homeServerIdentityId = request.body.homeServerIdentityId;
            if (version === 'v2' && pairId && homeServerIdentityId) {
                const localHomeServerIdentityId = readCachedServerIdentityIdForHotPath(process.env);
                if (localHomeServerIdentityId === homeServerIdentityId) {
                    const rejectedPairing = await db.authPairingSession.findFirst({
                        where: {
                            id: pairId,
                            flow: "direct_qr",
                            requestedPublicKey: request.body.publicKey,
                            approvalStatus: "rejected",
                            decidedAt: { not: null },
                            expiresAt: { gt: new Date() },
                        },
                        select: { id: true },
                    });
                    if (rejectedPairing) return reply.send({ state: 'rejected' });
                }
            }
            return reply.send({ state: 'requested' });
        }
        if (answer.response !== null && answer.responseAccountId !== null && answer.tokenEncrypted === null) {
            return reply.code(426).send({ error: "account_provisioning_update_required" });
        }
        if (answer.response === null || answer.responseAccountId === null || answer.tokenEncrypted === null) {
            return reply.code(409).send({ error: "account_provisioning_inconsistent" });
        }
        if (
            !isCanonicalPersistedProvisioningResponse(answer.response)
            || !isCanonicalPersistedEncryptedToken(answer.tokenEncrypted)
        ) {
            return reply.code(409).send({ error: "account_provisioning_inconsistent" });
        }
        if (version === 'v1') {
            return reply.code(426).send({ error: "account_provisioning_update_required" });
        }
        const pairId = request.body.pairId;
        const homeServerIdentityId = request.body.homeServerIdentityId;
        if (pairId && homeServerIdentityId) {
            const localHomeServerIdentityId = readCachedServerIdentityIdForHotPath(process.env);
            if (homeServerIdentityId !== localHomeServerIdentityId) {
                return reply.send({ state: 'requested' });
            }
            const completedPairing = await db.authPairingSession.findFirst({
                where: {
                    id: pairId,
                    flow: "direct_qr",
                    accountId: answer.responseAccountId,
                    requestedPublicKey: request.body.publicKey,
                    approvalStatus: "approved",
                    decidedAt: { not: null },
                    expiresAt: { gt: new Date() },
                },
                select: { id: true },
            });
            if (!completedPairing) return reply.send({ state: 'requested' });
        }
        return reply.send({
            state: 'authorized',
            tokenEncrypted: answer.tokenEncrypted,
            response: answer.response,
        });
    };

    // Account auth request
    app.post('/v1/auth/account/request', {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.accountRequest.poll") },
        schema: {
            body: z.strictObject({
                publicKey: z.string(),
            }),
            response: {
                200: requestedSchema,
                401: invalidKeySchema,
                409: provisioningErrorSchema,
                426: provisioningErrorSchema,
            }
        }
    }, async (request, reply) => handleCommonRequest('v1', request, reply));

    // Account auth request (v2) - returns encrypted token and no plaintext token
    app.post('/v2/auth/account/request', {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.accountRequest.poll") },
        schema: {
            body: z.union([
                z.strictObject({ publicKey: z.string() }),
                z.strictObject({
                    publicKey: z.string(),
                    pairId: z.string().check(z.minLength(1), z.maxLength(128)),
                    homeServerIdentityId: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
                }),
            ]),
            response: {
                200: z.union([requestedSchema, rejectedSchema, authorizedV2Schema]),
                401: invalidKeySchema,
                409: provisioningErrorSchema,
                426: provisioningErrorSchema,
            }
        }
    }, async (request, reply) => handleCommonRequest('v2', request, reply));

    // Approve account auth request
    app.post('/v1/auth/account/response', {
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.accountRequest.complete") },
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            body: z.strictObject({
                response: z.string(),
                publicKey: z.string(),
                pairId: z.optional(z.string().check(z.minLength(1), z.maxLength(128))),
                homeServerIdentityId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
                responseKind: z.optional(z.enum(["tokenOnly", "dataKey"])),
            }),
            response: {
                200: responseSuccessSchema,
                400: badRequestSchema,
                401: invalidKeySchema,
                403: z.union([PresentUserRequiredResponseSchema, provisioningErrorSchema]),
                404: requestNotFoundSchema,
                409: provisioningErrorSchema,
                426: provisioningErrorSchema,
                503: provisioningErrorSchema,
            },
        }
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = decodeCanonicalRequesterPublicKey(String(request.body.publicKey));
        if (!publicKey || tweetnacl.box.publicKeyLength !== publicKey.length) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }

        const pairId = request.body.pairId;
        const homeServerIdentityId = request.body.homeServerIdentityId;
        const responseKind = request.body.responseKind;
        if (!pairId || !homeServerIdentityId || !responseKind) {
            return reply.code(426).send({ error: "account_provisioning_update_required" });
        }
        const localHomeServerIdentityId = readCachedServerIdentityIdForHotPath(process.env);
        if (!localHomeServerIdentityId) {
            return reply.code(503).send({ error: "home_identity_unavailable" });
        }
        if (homeServerIdentityId !== localHomeServerIdentityId) {
            return reply.code(403).send({ error: "wrong_home" });
        }

        const publicKeyHex = privacyKit.encodeHex(publicKey);
        const accountAuthPolicy = resolveAccountAuthRequestPolicyFromEnv(requestHomeEnv);
        const classifyCurrentCompletion = async () => await inTx(async (tx) => {
            const now = new Date();
            const pairing = await tx.authPairingSession.findFirst({
                where: {
                    id: pairId,
                    flow: "direct_qr",
                    accountId: request.userId,
                    requestedPublicKey: request.body.publicKey,
                },
                select: { approvalStatus: true, expiresAt: true },
            });
            if (!pairing) return { status: "wrong_binding" } as const;

            const authRequest = await tx.accountAuthRequest.findUnique({
                where: { publicKey: publicKeyHex },
                select: {
                    createdAt: true,
                    response: true,
                    responseAccountId: true,
                    tokenEncrypted: true,
                },
            });
            if (!authRequest) return { status: "not_found" } as const;
            if (now.getTime() - authRequest.createdAt.getTime() > accountAuthPolicy.ttlMs) {
                return { status: "expired" } as const;
            }

            const hasResponse = authRequest.response !== null;
            const hasResponseAccount = authRequest.responseAccountId !== null;
            const hasEncryptedToken = authRequest.tokenEncrypted !== null;
            const hasCompleteResponse = hasResponse && hasResponseAccount && hasEncryptedToken;
            const isCompleted = hasCompleteResponse
                && authRequest.responseAccountId === request.userId;
            if (pairing.approvalStatus === "approved") {
                return isCompleted
                    ? { status: "already_completed" } as const
                    : { status: "inconsistent" } as const;
            }
            if (pairing.approvalStatus !== null || hasCompleteResponse) {
                return { status: "wrong_binding" } as const;
            }
            if (hasResponse || hasResponseAccount || hasEncryptedToken) {
                return { status: "inconsistent" } as const;
            }
            if (pairing.expiresAt.getTime() <= now.getTime()) {
                return { status: "expired" } as const;
            }
            return { status: "inconsistent" } as const;
        });
        const outcome = await inTx(async (tx) => {
            const now = new Date();
            const pairing = await tx.authPairingSession.findFirst({
                where: {
                    id: pairId,
                    flow: "direct_qr",
                    accountId: request.userId,
                    requestedPublicKey: request.body.publicKey,
                },
                select: { id: true, approvalStatus: true, expiresAt: true },
            });
            if (!pairing) return { status: "wrong_binding" } as const;

            const authRequest = await tx.accountAuthRequest.findUnique({
                where: { publicKey: publicKeyHex },
            });
            if (!authRequest) return { status: "not_found" } as const;
            if (now.getTime() - authRequest.createdAt.getTime() > accountAuthPolicy.ttlMs) {
                await tx.accountAuthRequest.deleteMany({ where: { id: authRequest.id } });
                return { status: "expired" } as const;
            }

            const account = await tx.account.findUnique({
                where: { id: request.userId },
                select: {
                    publicKey: true,
                    encryptionMode: true,
                    contentPublicKey: true,
                    contentPublicKeySig: true,
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

            const hasResponse = authRequest.response !== null;
            const hasResponseAccount = authRequest.responseAccountId !== null;
            const hasEncryptedToken = authRequest.tokenEncrypted !== null;
            const hasCompleteResponse = hasResponse && hasResponseAccount && hasEncryptedToken;
            const isCompleted = hasCompleteResponse
                && authRequest.responseAccountId === request.userId;
            if (pairing.approvalStatus === "approved") {
                return isCompleted
                    ? { status: "already_completed" } as const
                    : { status: "inconsistent" } as const;
            }
            if (pairing.approvalStatus !== null || hasCompleteResponse) {
                return { status: "wrong_binding" } as const;
            }
            if (hasResponse || hasResponseAccount || hasEncryptedToken) {
                return { status: "inconsistent" } as const;
            }
            if (pairing.expiresAt.getTime() < now.getTime()) {
                return { status: "expired" } as const;
            }

            // Policy/material checks above may await long enough for the
            // approval window to close. Re-read the clock at the irreversible
            // credential-mint boundary rather than relying on transaction
            // entry time.
            if (pairing.expiresAt.getTime() <= Date.now()) {
                return { status: "expired" } as const;
            }
            const token = await auth.createTokenInTx(
                tx,
                request.userId,
                undefined,
                {
                    kind: "account",
                    authority: "present_user",
                },
            );
            const tokenEncrypted = privacyKit.encodeBase64(new Uint8Array(sealBoxBundle({
                plaintext: new TextEncoder().encode(token),
                recipientPublicKey: publicKey,
                randomBytes: tweetnacl.randomBytes,
            })));
            if (tokenEncrypted.length > MAX_PERSISTED_ENCRYPTED_TOKEN_CHARS) {
                return { status: "inconsistent" } as const;
            }
            const completed = await tx.accountAuthRequest.updateMany({
                where: {
                    id: authRequest.id,
                    response: null,
                    responseAccountId: null,
                    tokenEncrypted: null,
                },
                data: {
                    response: request.body.response,
                    responseAccountId: request.userId,
                    tokenEncrypted,
                },
            });
            if (completed.count === 1) {
                const finalizationNow = new Date();
                const finalized = await tx.authPairingSession.updateMany({
                    where: {
                        id: pairing.id,
                        flow: "direct_qr",
                        accountId: request.userId,
                        requestedPublicKey: request.body.publicKey,
                        approvalStatus: null,
                        expiresAt: { gt: finalizationNow },
                    },
                    data: { approvalStatus: "approved", decidedAt: finalizationNow },
                });
                if (finalized.count !== 1) throw new DirectQrCompletionConflictError();
                return { status: "success" } as const;
            }
            throw new DirectQrCompletionConflictError();
        }, { isolationLevel: "Serializable" /* Pairing response policy, Account credential currentness and token issuance share one snapshot. */ }).catch((error: unknown) => {
            if (!(error instanceof DirectQrCompletionConflictError)) throw error;
            return classifyCurrentCompletion();
        });

        if (outcome.status === "success") {
            return reply.send({ success: true });
        }
        if (outcome.status === "expired") {
            return reply.code(404).send({ error: "Request not found" });
        }
        if (outcome.status === "wrong_binding") {
            return reply.code(404).send({ error: "Request not found" });
        }
        if (outcome.status === "not_found") return reply.code(404).send({ error: "Request not found" });
        if (outcome.status === "material_unavailable") {
            return reply.code(409).send({ error: "provisioning_material_unavailable" });
        }
        if (outcome.status === "already_completed") {
            return reply.code(409).send({ error: "already_completed" });
        }
        if (outcome.status === "inconsistent") {
            return reply.code(409).send({ error: "account_provisioning_inconsistent" });
        }
        const statusCode = outcome.reason === "invalid_provisioning_response" ? 400 : 409;
        return reply.code(statusCode).send({ error: outcome.reason });
    });
}
