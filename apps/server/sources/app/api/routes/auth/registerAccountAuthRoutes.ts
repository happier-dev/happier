import { z } from "zod";
import * as privacyKit from "privacy-kit";
import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { type Fastify } from "../../types";
import { resolveAccountAuthRequestPolicyFromEnv } from "./accountAuthRequestPolicy";

export function registerAccountAuthRoutes(app: Fastify): void {
    // Account auth request
    app.post('/v1/auth/account/request', {
        schema: {
            body: z.object({
                publicKey: z.string(),
            }),
            response: {
                200: z.union([z.object({
                    state: z.literal('requested'),
                }), z.object({
                    state: z.literal('authorized'),
                    tokenEncrypted: z.string(),
                    response: z.string()
                })]),
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

        const policy = resolveAccountAuthRequestPolicyFromEnv(process.env);
        const isExpired = (createdAt: Date): boolean => {
            const ageMs = Date.now() - createdAt.getTime();
            return ageMs > policy.ttlMs;
        };

        const publicKeyHex = privacyKit.encodeHex(publicKey);
        const existing = await db.accountAuthRequest.findUnique({
            where: { publicKey: publicKeyHex },
        });
        if (existing && isExpired(existing.createdAt)) {
            // Best-effort cleanup: expired requests should not linger indefinitely.
            await db.accountAuthRequest.delete({ where: { id: existing.id } }).catch(() => { });
        }

        const answer = await db.accountAuthRequest.upsert({
            where: { publicKey: publicKeyHex },
            update: {},
            create: { publicKey: publicKeyHex }
        });

        // Expiry also applies after response to avoid indefinite "wait arbitrarily long then fetch token" behavior.
        if (isExpired(answer.createdAt)) {
            await db.accountAuthRequest.delete({ where: { id: answer.id } }).catch(() => { });
            return reply.send({ state: 'requested' });
        }

        if (answer.response && answer.responseAccountId) {
            const token = await auth.createToken(answer.responseAccountId!);
            const ephemeralKeyPair = tweetnacl.box.keyPair();
            const nonce = tweetnacl.randomBytes(tweetnacl.box.nonceLength);
            const encrypted = tweetnacl.box(new TextEncoder().encode(token), nonce, publicKey, ephemeralKeyPair.secretKey);

            // Bundle format: ephemeral public key (32 bytes) + nonce (24 bytes) + encrypted token
            const tokenEncryptedBundle = new Uint8Array(ephemeralKeyPair.publicKey.length + nonce.length + encrypted.length);
            tokenEncryptedBundle.set(ephemeralKeyPair.publicKey, 0);
            tokenEncryptedBundle.set(nonce, ephemeralKeyPair.publicKey.length);
            tokenEncryptedBundle.set(encrypted, ephemeralKeyPair.publicKey.length + nonce.length);
            return reply.send({
                state: 'authorized',
                tokenEncrypted: privacyKit.encodeBase64(tokenEncryptedBundle),
                response: answer.response
            });
        }
        return reply.send({ state: 'requested' });
    });

    // Approve account auth request
    app.post('/v1/auth/account/response', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                response: z.string(),
                publicKey: z.string()
            })
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
        const authRequest = await db.accountAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(publicKey) }
        });
        if (!authRequest) {
            return reply.code(404).send({ error: 'Request not found' });
        }

        const policy = resolveAccountAuthRequestPolicyFromEnv(process.env);
        const ageMs = Date.now() - authRequest.createdAt.getTime();
        if (ageMs > policy.ttlMs) {
            await db.accountAuthRequest.delete({ where: { id: authRequest.id } }).catch(() => { });
            return reply.code(404).send({ error: 'Request not found' });
        }

        if (!authRequest.response) {
            await db.accountAuthRequest.update({
                where: { id: authRequest.id },
                data: { response: request.body.response, responseAccountId: request.userId }
            });
        }
        return reply.send({ success: true });
    });
}
