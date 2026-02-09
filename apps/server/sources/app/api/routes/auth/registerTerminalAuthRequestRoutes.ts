import { z } from "zod";
import * as privacyKit from "privacy-kit";
import { createHash } from "node:crypto";
import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { debug } from "@/utils/logging/log";
import { type Fastify } from "../../types";
import { type TerminalAuthRequestPolicy } from "./terminalAuthRequestPolicy";

const BASE64_URL_REGEX = /^[A-Za-z0-9_-]+$/;

type IsTerminalAuthExpired = (createdAt: Date) => boolean;

type RegisterTerminalAuthRequestRoutesContext = {
    terminalAuthPolicy: TerminalAuthRequestPolicy;
    isTerminalAuthExpired: IsTerminalAuthExpired;
};

export function registerTerminalAuthRequestRoutes(
    app: Fastify,
    context: RegisterTerminalAuthRequestRoutesContext,
): void {
    const { terminalAuthPolicy, isTerminalAuthExpired } = context;

    app.post('/v1/auth/request', {
        schema: {
            body: z.object({
                publicKey: z.string(),
                supportsV2: z.boolean().nullish(),
                claimSecretHash: z.string().length(43).regex(BASE64_URL_REGEX).nullish(),
            }),
            response: {
                200: z.union([
                    z.object({ state: z.literal('requested') }).strict(),
                    z.object({ state: z.literal('authorized'), token: z.string(), response: z.string() }).strict(),
                    z.object({ state: z.literal('authorized') }).strict(),
                ]),
                409: z.object({ error: z.literal('claim_mismatch') }),
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
            const token = await auth.createToken(answer.responseAccountId!, { session: answer.id });
            return reply.send({
                state: 'authorized',
                token: token,
                response: answer.response
            });
        }

        return reply.send({ state: 'requested' });
    });

    // Get auth request status
    app.get('/v1/auth/request/status', {
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
        schema: {
            body: z.object({
                publicKey: z.string(),
                claimSecret: z.string().min(1).max(256).regex(BASE64_URL_REGEX),
            }),
            response: {
                200: z.union([
                    z.object({ state: z.literal("requested") }),
                    z.object({
                        state: z.literal("authorized"),
                        token: z.string(),
                        response: z.string(),
                    }),
                ]),
                409: z.object({ error: z.literal("claim_not_supported") }),
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

        const now = Date.now();
        const claimedAtMs = authRequest.claimedAt ? authRequest.claimedAt.getTime() : null;
        if (claimedAtMs != null && now - claimedAtMs > terminalAuthPolicy.claimRetryWindowMs) {
            await db.terminalAuthRequest.delete({ where: { id: authRequest.id } }).catch(() => {});
            return reply.code(410).send({ error: "consumed" as const });
        }

        if (!authRequest.claimedAt) {
            // Ensure single-consumer semantics, but allow best-effort retry within a short window.
            const claimUpdate = await db.terminalAuthRequest.updateMany({
                where: { id: authRequest.id, claimedAt: null },
                data: { claimedAt: new Date(now) },
            });
            if (claimUpdate.count === 0) {
                return reply.code(410).send({ error: "consumed" as const });
            }
        }

        const token = await auth.createToken(authRequest.responseAccountId!, { session: authRequest.id });
        return reply.send({
            state: "authorized",
            token,
            response: authRequest.response,
        });
    });

    // Approve auth request
    app.post('/v1/auth/response', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                response: z.string(),
                publicKey: z.string()
            })
        }
    }, async (request, reply) => {
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
        const publicKeyHex = privacyKit.encodeHex(publicKey);
        const authRequest = await db.terminalAuthRequest.findUnique({
            where: { publicKey: publicKeyHex }
        });
        if (!authRequest) {
            return reply.code(404).send({ error: 'Request not found' });
        }
        if (isTerminalAuthExpired(authRequest.createdAt)) {
            await db.terminalAuthRequest.delete({ where: { id: authRequest.id } }).catch(() => {});
            return reply.code(404).send({ error: "Request not found" });
        }
        if (!authRequest.response) {
            await db.terminalAuthRequest.update({
                where: { id: authRequest.id },
                data: { response: request.body.response, responseAccountId: request.userId }
            });
        }
        return reply.send({ success: true });
    });
}
