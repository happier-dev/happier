import { z } from "zod/mini";
import { sanitizeDeviceLabel } from '@happier-dev/protocol/auth/deviceLabel';
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import { HomeQrPairingStatusV2Schema, verifyHomeQrRendezvousSecretV2 } from '@happier-dev/protocol/crypto/qrProvisioningV2';

import { db } from "@/storage/db";
import { isPrismaUniqueConstraintError } from "@/storage/prisma";
import { createServerFeatureGatedRouteApp } from "@/app/features/catalog/serverFeatureGate";
import { readCachedServerIdentityIdForHotPath } from "@/app/serverIdentity/serverIdentity";
import { PresentUserRequiredResponseSchema, requirePresentUser } from "@/app/api/utils/requirePresentUser";
import { type Fastify } from "../../types";
import { resolvePairingAuthPolicyFromEnv } from "./pairingAuthPolicy";
import {
    pairingAuthRateLimitConsumePerUser,
    pairingAuthRateLimitRequestPerIp,
    pairingAuthRateLimitStartPerUser,
    pairingAuthRateLimitStatusPerUser,
} from "./pairingAuthRateLimits";
import { cleanupExpiredAuthPairingSessions } from "@/app/retention/rules/authPairingSessionRetentionRule";

const BASE64URL_32_BYTES_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function decodeCanonicalBase64Url32(value: string): Uint8Array<ArrayBuffer> | null {
    if (!BASE64URL_32_BYTES_PATTERN.test(value)) return null;
    try {
        const decoded = privacyKit.decodeBase64(value, "base64url");
        const canonical = privacyKit.encodeBase64(decoded, "base64url").replace(/=+$/u, "");
        return decoded.length === 32 && canonical === value ? decoded : null;
    } catch {
        return null;
    }
}

const canonicalBase64Url32 = z.string().check(z.refine((value) => decodeCanonicalBase64Url32(value) !== null));
const notFound = z.strictObject({ error: z.literal("not_found") });
const serverIdentityUnavailable = z.strictObject({ error: z.literal("server_identity_unavailable") });

export function registerPairingAuthRoutes(app: Fastify): void {
    const gated = createServerFeatureGatedRouteApp(app, "auth.pairing.boundQrV2");
    const policy = resolvePairingAuthPolicyFromEnv(process.env);

    const forwardStartBody = z.strictObject({
        direction: z.literal("trusted_home_displays"),
        secretHash: canonicalBase64Url32,
    });
    // Immutable server-v0.2.11 clients sent exactly `{ secretHash }`. This is
    // a recognition-only refusal adapter: it never recreates the V1 lifecycle.
    const releasedV1StartBody = z.strictObject({
        secretHash: z.string().check(z.minLength(8), z.maxLength(128)),
    });
    const reverseStartBody = z.strictObject({
        direction: z.literal("requester_displays"),
        secretHash: canonicalBase64Url32,
        pairId: canonicalBase64Url32,
        expiresAtMs: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
    });
    const startBody = z.union([forwardStartBody, reverseStartBody, releasedV1StartBody]);
    const startResponse = z.strictObject({ pairId: z.string(), expiresAt: z.string() });
    const invalidProposedExpiry = z.strictObject({ error: z.literal("invalid_proposed_expiry") });
    const requestValidationError = z.looseObject({
        statusCode: z.literal(400),
        error: z.string().check(z.minLength(1)),
        message: z.string().check(z.minLength(1)),
    });
    const pairIdConflict = z.strictObject({ error: z.literal("pair_id_conflict") });
    const clientUpdateRequired = z.strictObject({ error: z.literal("client_update_required") });
    gated.post(
        "/v1/auth/pairing/start",
        {
            config: { rateLimit: pairingAuthRateLimitStartPerUser() },
            preHandler: [app.authenticate, requirePresentUser],
            schema: {
                body: startBody,
                response: {
                    200: startResponse,
                    400: z.union([invalidProposedExpiry, requestValidationError]),
                    403: PresentUserRequiredResponseSchema,
                    409: pairIdConflict,
                    426: clientUpdateRequired,
                },
            },
        },
        async (request, reply) => {
            if (!("direction" in request.body)) {
                return reply.code(426).send({ error: "client_update_required" });
            }
            const now = new Date();
            await cleanupExpiredAuthPairingSessions({ now, flow: "direct_qr" }).catch(() => {});

            if (request.body.direction === "requester_displays") {
                const expiresAtMs = request.body.expiresAtMs;
                if (expiresAtMs <= now.getTime() || expiresAtMs > now.getTime() + policy.ttlMs) {
                    return reply.code(400).send({ error: "invalid_proposed_expiry" });
                }

                const pairId = request.body.pairId;
                const secretHash = request.body.secretHash;
                const expiresAt = new Date(expiresAtMs);
                try {
                    const row = await db.authPairingSession.create({
                        data: {
                            id: pairId,
                            accountId: request.userId,
                            secretHash,
                            expiresAt,
                            flow: "direct_qr",
                        },
                        select: { id: true, expiresAt: true },
                    });
                    return reply.send({ pairId: row.id, expiresAt: row.expiresAt.toISOString() });
                } catch (error) {
                    if (!isPrismaUniqueConstraintError(error)) throw error;
                }

                const existing = await db.authPairingSession.findUnique({
                    where: { id: pairId },
                    select: { accountId: true, secretHash: true, expiresAt: true, flow: true },
                });
                if (
                    existing?.accountId === request.userId
                    && existing.flow === "direct_qr"
                    && existing.secretHash === secretHash
                    && existing.expiresAt.getTime() === expiresAtMs
                ) {
                    return reply.send({ pairId, expiresAt: existing.expiresAt.toISOString() });
                }
                return reply.code(409).send({ error: "pair_id_conflict" });
            }

            const expiresAt = new Date(now.getTime() + policy.ttlMs);
            const row = await db.authPairingSession.create({
                data: {
                    accountId: request.userId,
                    secretHash: String(request.body.secretHash),
                    expiresAt,
                    flow: "direct_qr",
                },
                select: { id: true, expiresAt: true },
            });
            return reply.send({ pairId: row.id, expiresAt: row.expiresAt.toISOString() });
        },
    );

    const requestBody = z.strictObject({
        pairId: z.string().check(z.minLength(1), z.maxLength(128)),
        secret: canonicalBase64Url32,
        publicKey: z.string().check(z.minLength(1), z.maxLength(256)),
        bindingProof: canonicalBase64Url32,
        homeServerIdentityId: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
        expiresAtMs: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
        deviceLabel: z.optional(z.string().check(z.maxLength(256))),
    });
    const requestOk = z.strictObject({ state: z.literal("requested") });
    const invalidKey = z.strictObject({ error: z.literal("Invalid public key") });
    const alreadyRequested = z.strictObject({ error: z.literal("already_requested") });
    const wrongHome = z.strictObject({ error: z.literal("wrong_home") });
    const wrongExpiry = z.strictObject({ error: z.literal("wrong_expiry") });

    gated.post(
        "/v1/auth/pairing/request",
        {
            config: { rateLimit: pairingAuthRateLimitRequestPerIp() },
            schema: {
                body: requestBody,
                response: {
                    200: requestOk,
                    401: invalidKey,
                    403: z.union([wrongHome, wrongExpiry]),
                    404: notFound,
                    409: alreadyRequested,
                    503: serverIdentityUnavailable,
                },
            },
        },
        async (request, reply) => {
            const localHomeServerIdentityId = readCachedServerIdentityIdForHotPath(process.env);
            if (!localHomeServerIdentityId) {
                return reply.code(503).send({ error: "server_identity_unavailable" });
            }
            if (request.body.homeServerIdentityId !== localHomeServerIdentityId) {
                return reply.code(403).send({ error: "wrong_home" });
            }

            const publicKeyRaw = String(request.body.publicKey);
            let publicKeyBytes: Uint8Array<ArrayBuffer>;
            try {
                publicKeyBytes = privacyKit.decodeBase64(publicKeyRaw);
            } catch {
                return reply.code(401).send({ error: "Invalid public key" });
            }
            if (
                publicKeyBytes.length !== tweetnacl.box.publicKeyLength
                || privacyKit.encodeBase64(publicKeyBytes) !== publicKeyRaw
            ) {
                return reply.code(401).send({ error: "Invalid public key" });
            }

            const pairId = String(request.body.pairId);
            const session = await db.authPairingSession.findFirst({
                where: { id: pairId, flow: "direct_qr" },
            });
            if (!session) return reply.code(404).send({ error: "not_found" });

            const now = new Date();
            if (session.expiresAt.getTime() <= now.getTime()) {
                await db.authPairingSession.deleteMany({ where: { id: session.id, flow: "direct_qr" } }).catch(() => {});
                return reply.code(404).send({ error: "not_found" });
            }
            if (session.expiresAt.getTime() !== request.body.expiresAtMs) {
                return reply.code(403).send({ error: "wrong_expiry" });
            }

            const rendezvousSecret = decodeCanonicalBase64Url32(String(request.body.secret));
            const rendezvousVerifier = decodeCanonicalBase64Url32(session.secretHash);
            if (
                !rendezvousSecret
                || !rendezvousVerifier
                || !verifyHomeQrRendezvousSecretV2(rendezvousSecret, rendezvousVerifier)
            ) {
                return reply.code(404).send({ error: "not_found" });
            }

            const bindingProof = String(request.body.bindingProof);
            const deviceLabel = sanitizeDeviceLabel(request.body.deviceLabel);
            const updated = await db.authPairingSession.updateMany({
                where: {
                    id: session.id,
                    flow: "direct_qr",
                    expiresAt: { gt: now },
                    requestedPublicKey: null,
                    requestedBindingProof: null,
                },
                data: {
                    requestedPublicKey: publicKeyRaw,
                    requestedBindingProof: bindingProof,
                    requestedDeviceLabel: deviceLabel,
                    requestedAt: now,
                },
            });
            if (updated.count === 1) return reply.send({ state: "requested" });

            const existing = await db.authPairingSession.findFirst({
                where: { id: session.id, flow: "direct_qr", expiresAt: { gt: now } },
                select: { requestedPublicKey: true, requestedBindingProof: true },
            });
            if (!existing) return reply.code(404).send({ error: "not_found" });
            if (
                existing.requestedPublicKey === publicKeyRaw
                && existing.requestedBindingProof === bindingProof
            ) {
                return reply.send({ state: "requested" });
            }
            return reply.code(409).send({ error: "already_requested" });
        },
    );

    const statusQuery = z.strictObject({ pairId: z.string().check(z.minLength(1), z.maxLength(128)) });
    gated.get(
        "/v1/auth/pairing/status",
        {
            config: { rateLimit: pairingAuthRateLimitStatusPerUser() },
            preHandler: [app.authenticate, requirePresentUser],
            schema: {
                querystring: statusQuery,
                response: {
                    200: HomeQrPairingStatusV2Schema,
                    403: PresentUserRequiredResponseSchema,
                    404: notFound,
                    503: serverIdentityUnavailable,
                },
            },
        },
        async (request, reply) => {
            const pairId = String(request.query.pairId);
            const session = await db.authPairingSession.findFirst({
                where: { id: pairId, flow: "direct_qr", accountId: request.userId },
            });
            if (!session) return reply.code(404).send({ error: "not_found" });

            const now = new Date();
            if (session.expiresAt.getTime() <= now.getTime()) {
                await db.authPairingSession.deleteMany({ where: { id: session.id, flow: "direct_qr" } }).catch(() => {});
                return reply.code(404).send({ error: "not_found" });
            }
            if (!session.requestedPublicKey && !session.requestedBindingProof) {
                return reply.send({ state: "pending", pairId: session.id, expiresAt: session.expiresAt.toISOString() });
            }
            if (!session.requestedPublicKey || !session.requestedBindingProof) {
                return reply.code(404).send({ error: "not_found" });
            }

            const localHomeServerIdentityId = readCachedServerIdentityIdForHotPath(process.env);
            if (!localHomeServerIdentityId) {
                return reply.code(503).send({ error: "server_identity_unavailable" });
            }
            return reply.send({
                state: "requested",
                pairId: session.id,
                expiresAt: session.expiresAt.toISOString(),
                homeServerIdentityId: localHomeServerIdentityId,
                requestedPublicKey: session.requestedPublicKey,
                bindingProof: session.requestedBindingProof,
                requestedDeviceLabel: session.requestedDeviceLabel ?? null,
            });
        },
    );

    const consumePairId = z.string().check(z.minLength(1), z.maxLength(128));
    const consumeBody = z.union([
        z.strictObject({ pairId: consumePairId }),
        z.strictObject({ pairId: consumePairId, intent: z.enum(["reject", "cancel"]) }),
    ]);
    const consumeOk = z.strictObject({ success: z.literal(true) });
    const alreadyDecided = z.strictObject({ error: z.literal("already_decided") });
    gated.post(
        "/v1/auth/pairing/consume",
        {
            config: { rateLimit: pairingAuthRateLimitConsumePerUser() },
            preHandler: [app.authenticate, requirePresentUser],
            schema: {
                body: consumeBody,
                response: {
                    200: consumeOk,
                    403: PresentUserRequiredResponseSchema,
                    404: notFound,
                    409: alreadyDecided,
                },
            },
        },
        async (request, reply) => {
            const now = new Date();
            const pairId = String(request.body.pairId);
            if (!("intent" in request.body)) {
                const deleted = await db.authPairingSession.deleteMany({
                    where: {
                        id: pairId,
                        accountId: request.userId,
                        flow: "direct_qr",
                        expiresAt: { gt: now },
                        OR: [
                            {
                                approvalStatus: null,
                                requestedPublicKey: null,
                                requestedBindingProof: null,
                            },
                            {
                                approvalStatus: "approved",
                                decidedAt: { not: null },
                            },
                        ],
                    },
                });
                if (deleted.count === 1) return reply.send({ success: true });
                await db.authPairingSession.deleteMany({
                    where: { id: pairId, accountId: request.userId, flow: "direct_qr", expiresAt: { lte: now } },
                }).catch(() => {});
                return reply.code(404).send({ error: "not_found" });
            }
            const intent = request.body.intent;
            let current = await db.authPairingSession.findFirst({
                where: {
                    id: pairId,
                    accountId: request.userId,
                    flow: "direct_qr",
                    expiresAt: { gt: now },
                },
                select: {
                    approvalStatus: true,
                    requestedPublicKey: true,
                    requestedBindingProof: true,
                },
            });
            if (!current) {
                await db.authPairingSession.deleteMany({
                    where: { id: pairId, accountId: request.userId, flow: "direct_qr", expiresAt: { lte: now } },
                }).catch(() => {});
                return reply.code(404).send({ error: "not_found" });
            }
            if (current.approvalStatus === "rejected") return reply.send({ success: true });
            if (current.approvalStatus === "approved") {
                return reply.code(409).send({ error: "already_decided" });
            }

            if (intent === "cancel") {
                const cancelled = await db.authPairingSession.deleteMany({
                    where: {
                        id: pairId,
                        accountId: request.userId,
                        flow: "direct_qr",
                        expiresAt: { gt: now },
                        approvalStatus: null,
                        requestedPublicKey: null,
                        requestedBindingProof: null,
                    },
                });
                if (cancelled.count === 1) return reply.send({ success: true });

                // The requester may have installed its bound tuple after the
                // preflight read but before this delete. Re-read that exact row
                // before deciding whether cancellation must become rejection.
                current = await db.authPairingSession.findFirst({
                    where: {
                        id: pairId,
                        accountId: request.userId,
                        flow: "direct_qr",
                        expiresAt: { gt: now },
                    },
                    select: {
                        approvalStatus: true,
                        requestedPublicKey: true,
                        requestedBindingProof: true,
                    },
                });
                if (!current) return reply.code(404).send({ error: "not_found" });
                if (current.approvalStatus === "rejected") return reply.send({ success: true });
                if (current.approvalStatus === "approved") {
                    return reply.code(409).send({ error: "already_decided" });
                }
            }
            if (current.requestedPublicKey === null || current.requestedBindingProof === null) {
                return reply.code(404).send({ error: "not_found" });
            }

            // Decide through a write-first compare-and-set. This makes the database
            // serialize rejection against account-response completion without first
            // pinning a stale read snapshot.
            const rejected = await db.authPairingSession.updateMany({
                where: {
                    id: pairId,
                    accountId: request.userId,
                    flow: "direct_qr",
                    expiresAt: { gt: now },
                    approvalStatus: null,
                    requestedPublicKey: { not: null },
                    requestedBindingProof: { not: null },
                },
                data: { approvalStatus: "rejected", decidedAt: now },
            });
            if (rejected.count === 1) return reply.send({ success: true });
            return reply.code(409).send({ error: "already_decided" });
        },
    );
}
