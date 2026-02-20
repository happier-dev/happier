import { z } from "zod";
import * as privacyKit from "privacy-kit";
import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { resolveAuthPolicyFromEnv } from "@/app/auth/authPolicy";
import { enforceLoginEligibility } from "@/app/auth/enforceLoginEligibility";
import { type Fastify } from "../../types";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveEffectiveDefaultAccountEncryptionMode } from "@happier-dev/protocol";

export function registerKeyChallengeAuthRoute(app: Fastify): void {
    app.post('/v1/auth', {
        schema: {
            body: z.object({
                publicKey: z.string(),
                challenge: z.string(),
                signature: z.string(),
                contentPublicKey: z.string().optional(),
                contentPublicKeySig: z.string().optional()
            }).superRefine((value, ctx) => {
                const hasContentKey = typeof value.contentPublicKey === 'string';
                const hasContentSig = typeof value.contentPublicKeySig === 'string';
                if (hasContentKey !== hasContentSig) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: 'contentPublicKey and contentPublicKeySig must be provided together'
                    });
                }
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
        if (String(request.body.signature).length > 4096 || String(request.body.challenge).length > 4096) {
            return reply.code(401).send({ error: 'Invalid signature' });
        }
        let challenge: Uint8Array;
        try {
            challenge = privacyKit.decodeBase64(request.body.challenge);
        } catch {
            return reply.code(401).send({ error: 'Invalid signature' });
        }
        let signature: Uint8Array;
        try {
            signature = privacyKit.decodeBase64(request.body.signature);
        } catch {
            return reply.code(401).send({ error: 'Invalid signature' });
        }
        if (publicKey.length !== tweetnacl.sign.publicKeyLength) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }
        if (signature.length !== tweetnacl.sign.signatureLength) {
            return reply.code(401).send({ error: 'Invalid signature' });
        }
        const isValid = tweetnacl.sign.detached.verify(challenge, signature, publicKey);
        if (!isValid) {
            return reply.code(401).send({ error: 'Invalid signature' });
        }

        const authPolicy = resolveAuthPolicyFromEnv(process.env);

        let contentPublicKey: Uint8Array | null = null;
        let contentPublicKeySig: Uint8Array | null = null;
        if (request.body.contentPublicKey && request.body.contentPublicKeySig) {
            try {
                contentPublicKey = privacyKit.decodeBase64(request.body.contentPublicKey);
                contentPublicKeySig = privacyKit.decodeBase64(request.body.contentPublicKeySig);
            } catch {
                return reply.code(400).send({ error: 'Invalid content key encoding' });
            }
            if (contentPublicKey.length !== tweetnacl.box.publicKeyLength) {
                return reply.code(400).send({ error: 'Invalid contentPublicKey' });
            }
            if (contentPublicKeySig.length !== tweetnacl.sign.signatureLength) {
                return reply.code(400).send({ error: 'Invalid contentPublicKeySig' });
            }

            const binding = Buffer.concat([
                Buffer.from('Happy content key v1\u0000', 'utf8'),
                Buffer.from(contentPublicKey)
            ]);
            const isContentKeyValid = tweetnacl.sign.detached.verify(binding, contentPublicKeySig, publicKey);
            if (!isContentKeyValid) {
                return reply.code(400).send({ error: 'Invalid contentPublicKeySig' });
            }
        }

        // Create or update user in database
        const publicKeyHex = privacyKit.encodeHex(publicKey);

        const encryptionFeatureEnv = readEncryptionFeatureEnv(process.env);
        const effectiveDefaultEncryptionMode = resolveEffectiveDefaultAccountEncryptionMode(
            encryptionFeatureEnv.storagePolicy,
            encryptionFeatureEnv.defaultAccountMode,
        );

        const existingAccount = await db.account.findUnique({
            where: { publicKey: publicKeyHex },
            select: {
                id: true,
            },
        });
        if (!existingAccount && !authPolicy.anonymousSignupEnabled) {
            return reply.code(403).send({ error: "signup-disabled" });
        }

        if (existingAccount) {
            const eligibility = await enforceLoginEligibility({ accountId: existingAccount.id, env: process.env });
            if (!eligibility.ok) {
                // Eligibility can fail closed with 401 (invalid-token) when the account cannot be validated.
                // We intentionally surface a generic auth-style error for 401 to avoid leaking internal details.
                if (eligibility.statusCode === 401) return reply.code(401).send({ error: "Invalid token" });
                if (eligibility.statusCode === 403 && eligibility.error === "provider-required") {
                    return reply.code(403).send({ error: "provider-required", provider: eligibility.provider });
                }
                return reply.code(eligibility.statusCode).send({ error: eligibility.error });
            }
        }

        const user = await db.account.upsert({
            where: { publicKey: publicKeyHex },
            update: {
                updatedAt: new Date(),
                ...(contentPublicKey ? { contentPublicKey: new Uint8Array(contentPublicKey) } : {}),
                ...(contentPublicKeySig ? { contentPublicKeySig: new Uint8Array(contentPublicKeySig) } : {}),
            },
            create: {
                publicKey: publicKeyHex,
                encryptionMode: effectiveDefaultEncryptionMode,
                ...(contentPublicKey ? { contentPublicKey: new Uint8Array(contentPublicKey) } : {}),
                ...(contentPublicKeySig ? { contentPublicKeySig: new Uint8Array(contentPublicKeySig) } : {}),
            }
        });

        return reply.send({
            success: true,
            token: await auth.createToken(user.id)
        });
    });
}
