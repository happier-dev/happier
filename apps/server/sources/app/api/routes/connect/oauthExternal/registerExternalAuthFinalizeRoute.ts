import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";
import { z } from "zod";

import { type Fastify } from "../../../types";
import { connectExternalIdentity } from "@/app/auth/providers/identity";
import { auth } from "@/app/auth/auth";
import { resolveAuthPolicyFromEnv } from "@/app/auth/authPolicy";
import { accountDisabledKey, disableAccount } from "@/app/auth/accountDisable";
import { Context } from "@/context";
import { decryptString } from "@/modules/encrypt";
import { findOAuthProviderById } from "@/app/oauth/providers/registry";
import { db } from "@/storage/db";
import { validateUsername } from "@/app/social/usernamePolicy";
import { deleteOAuthPendingBestEffort, loadValidOAuthPending } from "../connectRoutes.oauthPending";
import { isProviderResetEnabled } from "./oauthExternalConfig";
import {
    PROVIDER_ALREADY_LINKED_ERROR,
    RECOVERY_DISABLED_ERROR,
} from "./oauthExternalErrors";
import { authPendingSchema } from "./oauthExternalSchemas";
import {
    ExternalOAuthFinalizeAuthRequestSchema,
    ExternalOAuthFinalizeAuthSuccessResponseSchema,
} from "@happier-dev/protocol";

export function registerExternalAuthFinalizeRoute(app: Fastify) {
    app.post("/v1/auth/external/:provider/finalize", {
        schema: {
            params: z.object({ provider: z.string() }),
            body: ExternalOAuthFinalizeAuthRequestSchema,
            response: {
                200: ExternalOAuthFinalizeAuthSuccessResponseSchema,
                400: z.object({ error: z.enum(["invalid-pending", "invalid-public-key", "invalid-signature", "username-required", "invalid-username"]) }),
                403: z.object({ error: z.enum(["signup-provider-disabled", "forbidden", "not-eligible", RECOVERY_DISABLED_ERROR]) }),
                404: z.object({ error: z.literal("unsupported-provider") }),
                409: z.union([
                    z.object({ error: z.literal("username-taken") }),
                    z.object({ error: z.literal(PROVIDER_ALREADY_LINKED_ERROR), provider: z.string() }),
                ]),
            },
        },
    }, async (request, reply) => {
        const providerId = request.params.provider.toString().trim().toLowerCase();
        const provider = findOAuthProviderById(process.env, providerId);
        if (!provider) return reply.code(404).send({ error: "unsupported-provider" });

        const policy = resolveAuthPolicyFromEnv(process.env);
        if (!policy.signupProviders.includes(providerId)) {
            return reply.code(403).send({ error: "signup-provider-disabled" });
        }

        const pendingKey = request.body.pending.toString().trim();
        if (!pendingKey) return reply.code(400).send({ error: "invalid-pending" });

        let publicKeyBytes: Uint8Array;
        let challengeBytes: Uint8Array;
        let signatureBytes: Uint8Array;
        try {
            publicKeyBytes = privacyKit.decodeBase64(request.body.publicKey);
            challengeBytes = privacyKit.decodeBase64(request.body.challenge);
            signatureBytes = privacyKit.decodeBase64(request.body.signature);
        } catch {
            return reply.code(400).send({ error: "invalid-public-key" });
        }
        if (publicKeyBytes.length !== tweetnacl.sign.publicKeyLength) {
            return reply.code(400).send({ error: "invalid-public-key" });
        }
        if (signatureBytes.length !== tweetnacl.sign.signatureLength) {
            return reply.code(400).send({ error: "invalid-signature" });
        }
        const signatureOk = tweetnacl.sign.detached.verify(challengeBytes, signatureBytes, publicKeyBytes);
        if (!signatureOk) {
            return reply.code(400).send({ error: "invalid-signature" });
        }
        const publicKeyHex = privacyKit.encodeHex(new Uint8Array(publicKeyBytes));

        let contentPublicKey: Uint8Array | null = null;
        let contentPublicKeySig: Uint8Array | null = null;
        if (request.body.contentPublicKey && request.body.contentPublicKeySig) {
            try {
                contentPublicKey = privacyKit.decodeBase64(request.body.contentPublicKey);
                contentPublicKeySig = privacyKit.decodeBase64(request.body.contentPublicKeySig);
            } catch {
                return reply.code(400).send({ error: "invalid-signature" });
            }
            if (contentPublicKey.length !== tweetnacl.box.publicKeyLength) {
                return reply.code(400).send({ error: "invalid-signature" });
            }
            if (contentPublicKeySig.length !== tweetnacl.sign.signatureLength) {
                return reply.code(400).send({ error: "invalid-signature" });
            }

            const binding = Buffer.concat([
                Buffer.from("Happy content key v1\u0000", "utf8"),
                Buffer.from(contentPublicKey),
            ]);
            const contentSigOk = tweetnacl.sign.detached.verify(binding, contentPublicKeySig, publicKeyBytes);
            if (!contentSigOk) {
                return reply.code(400).send({ error: "invalid-signature" });
            }
        }

        const pending = await loadValidOAuthPending(pendingKey);
        if (!pending) return reply.code(400).send({ error: "invalid-pending" });

        let parsedValue: z.infer<typeof authPendingSchema>;
        try {
            const parsed = authPendingSchema.safeParse(JSON.parse(pending.value));
            if (!parsed.success) {
                await deleteOAuthPendingBestEffort(pendingKey);
                return reply.code(400).send({ error: "invalid-pending" });
            }
            parsedValue = parsed.data;
        } catch {
            await deleteOAuthPendingBestEffort(pendingKey);
            return reply.code(400).send({ error: "invalid-pending" });
        }

        if (parsedValue.provider.toString().trim().toLowerCase() !== providerId) {
            return reply.code(403).send({ error: "forbidden" });
        }
        if (parsedValue.publicKeyHex !== publicKeyHex) {
            return reply.code(403).send({ error: "forbidden" });
        }

        let accessToken: string;
        let refreshToken: string | undefined;
        let pendingProfile: unknown;
        try {
            const tokenBytes = privacyKit.decodeBase64(parsedValue.accessTokenEnc);
            accessToken = decryptString(["auth", "external", providerId, "pending", pendingKey, publicKeyHex], tokenBytes);
            if (typeof parsedValue.refreshTokenEnc === "string" && parsedValue.refreshTokenEnc.trim()) {
                const refreshBytes = privacyKit.decodeBase64(parsedValue.refreshTokenEnc);
                refreshToken = decryptString(
                    ["auth", "external", providerId, "pending", pendingKey, publicKeyHex, "refresh"],
                    refreshBytes,
                );
            }

            const profileBytes = privacyKit.decodeBase64(parsedValue.profileEnc);
            const profileJson = decryptString(
                ["auth", "external", providerId, "pending", pendingKey, publicKeyHex, "profile"],
                profileBytes,
            );
            pendingProfile = JSON.parse(profileJson);
        } catch {
            return reply.code(400).send({ error: "invalid-pending" });
        }

        const providerUserId = provider.getProviderUserId(pendingProfile);
        if (!providerUserId) {
            await deleteOAuthPendingBestEffort(pendingKey);
            return reply.code(400).send({ error: "invalid-pending" });
        }

        const existingAccount = await db.account.findUnique({
            where: { publicKey: publicKeyHex },
            select: { id: true, username: true },
        });

        const alreadyLinked = await db.accountIdentity.findFirst({
            where: {
                provider: providerId,
                providerUserId,
                ...(existingAccount ? { NOT: { accountId: existingAccount.id } } : {}),
            },
            select: { id: true, accountId: true, showOnProfile: true },
        });

        const resetRequested = request.body.reset === true;
        if (alreadyLinked && !resetRequested) {
            return reply.code(409).send({ error: PROVIDER_ALREADY_LINKED_ERROR, provider: providerId });
        }

        const usernameProvidedRaw = request.body.username?.toString().trim() || "";
        let desiredUsername: string | null = null;

        let oldAccountForReset: { id: string; username: string | null; feedSeq: bigint } | null = null;
        if (alreadyLinked && resetRequested) {
            if (!isProviderResetEnabled(process.env)) {
                return reply.code(403).send({ error: RECOVERY_DISABLED_ERROR });
            }
            oldAccountForReset = await db.account.findUnique({
                where: { id: alreadyLinked.accountId },
                select: { id: true, username: true, feedSeq: true },
            });
            if (!oldAccountForReset) {
                return reply.code(409).send({ error: PROVIDER_ALREADY_LINKED_ERROR, provider: providerId });
            }
        }

        if (usernameProvidedRaw) {
            const validation = validateUsername(usernameProvidedRaw, process.env);
            if (!validation.ok) return reply.code(400).send({ error: "invalid-username" });
            desiredUsername = validation.username;
        } else if (oldAccountForReset?.username) {
            desiredUsername = oldAccountForReset.username;
        } else {
            const required = parsedValue.usernameRequired === true;
            if (required) return reply.code(400).send({ error: "username-required" });

            const suggested = parsedValue.suggestedUsername?.toString().trim() || "";
            if (!suggested) return reply.code(400).send({ error: "username-required" });

            const validation = validateUsername(suggested, process.env);
            if (!validation.ok) return reply.code(400).send({ error: "username-required" });
            desiredUsername = validation.username;
        }

        const taken = await db.account.findFirst({
            where: {
                username: desiredUsername,
                NOT: oldAccountForReset ? { id: oldAccountForReset.id } : { publicKey: publicKeyHex },
            },
            select: { id: true },
        });
        if (taken) {
            return reply.code(409).send({ error: "username-taken" });
        }

        if (alreadyLinked && resetRequested && oldAccountForReset) {
            const oldAccountId = oldAccountForReset.id;

            const identitySnapshot = await db.accountIdentity.findUnique({
                where: { id: alreadyLinked.id },
                select: {
                    id: true,
                    accountId: true,
                    provider: true,
                    providerUserId: true,
                    providerLogin: true,
                    profile: true,
                    token: true,
                    scopes: true,
                    showOnProfile: true,
                    eligibilityStatus: true,
                    eligibilityReason: true,
                    eligibilityCheckedAt: true,
                    eligibilityNextCheckAt: true,
                },
            });
            if (!identitySnapshot) {
                return reply.code(409).send({ error: PROVIDER_ALREADY_LINKED_ERROR, provider: providerId });
            }

            const newAccount = await db.account.create({
                data: {
                    publicKey: publicKeyHex,
                    ...(contentPublicKey ? { contentPublicKey: new Uint8Array(contentPublicKey) } : {}),
                    ...(contentPublicKeySig ? { contentPublicKeySig: new Uint8Array(contentPublicKeySig) } : {}),
                },
                select: { id: true },
            });

            try {
                await db.accountIdentity.delete({ where: { id: identitySnapshot.id } });
            } catch (error) {
                await db.account.delete({ where: { id: newAccount.id } }).catch(() => {});
                throw error;
            }

            const ctx = Context.create(newAccount.id);
            try {
                await connectExternalIdentity({
                    providerId,
                    ctx,
                    profile: pendingProfile,
                    accessToken,
                    refreshToken,
                    preferredUsername: desiredUsername,
                });
            } catch (error) {
                await db.accountIdentity
                    .create({
                        data: {
                            accountId: identitySnapshot.accountId,
                            provider: identitySnapshot.provider,
                            providerUserId: identitySnapshot.providerUserId,
                            providerLogin: identitySnapshot.providerLogin,
                            profile: identitySnapshot.profile as any,
                            token: identitySnapshot.token as any,
                            scopes: identitySnapshot.scopes,
                            showOnProfile: identitySnapshot.showOnProfile,
                            eligibilityStatus: identitySnapshot.eligibilityStatus,
                            eligibilityReason: identitySnapshot.eligibilityReason,
                            eligibilityCheckedAt: identitySnapshot.eligibilityCheckedAt,
                            eligibilityNextCheckAt: identitySnapshot.eligibilityNextCheckAt,
                        },
                    })
                    .catch(() => {});
                await db.account.delete({ where: { id: newAccount.id } }).catch(() => {});

                if (error instanceof Error && error.message === "not-eligible") {
                    await db.repeatKey.deleteMany({ where: { key: pendingKey } });
                    return reply.code(403).send({ error: "not-eligible" });
                }
                if (error instanceof Error && error.message === PROVIDER_ALREADY_LINKED_ERROR) {
                    await db.repeatKey.deleteMany({ where: { key: pendingKey } });
                    return reply.code(409).send({ error: PROVIDER_ALREADY_LINKED_ERROR, provider: providerId });
                }
                throw error;
            }

            const restoreOldIdentityBestEffort = async () => {
                await db.accountIdentity
                    .create({
                        data: {
                            accountId: identitySnapshot.accountId,
                            provider: identitySnapshot.provider,
                            providerUserId: identitySnapshot.providerUserId,
                            providerLogin: identitySnapshot.providerLogin,
                            profile: identitySnapshot.profile as any,
                            token: identitySnapshot.token as any,
                            scopes: identitySnapshot.scopes,
                            showOnProfile: identitySnapshot.showOnProfile,
                            eligibilityStatus: identitySnapshot.eligibilityStatus,
                            eligibilityReason: identitySnapshot.eligibilityReason,
                            eligibilityCheckedAt: identitySnapshot.eligibilityCheckedAt,
                            eligibilityNextCheckAt: identitySnapshot.eligibilityNextCheckAt,
                        },
                    })
                    .catch(() => {});
            };
            const deleteNewIdentityBestEffort = async () => {
                await db.accountIdentity
                    .deleteMany({ where: { accountId: newAccount.id, provider: providerId } })
                    .catch(() => {});
            };
            const deleteNewAccountBestEffort = async () => {
                await db.account.delete({ where: { id: newAccount.id } }).catch(() => {});
            };
            const clearDisableMarkerBestEffort = async () => {
                const key = accountDisabledKey(oldAccountId);
                if (!key || key === "auth_disabled_") return;
                await db.repeatKey.delete({ where: { key } }).catch(() => {});
            };

            try {
                await disableAccount({ accountId: oldAccountId, reason: `provider_reset:${providerId}`, env: process.env });
            } catch (error) {
                await deleteNewIdentityBestEffort();
                await restoreOldIdentityBestEffort();
                await deleteNewAccountBestEffort();
                throw error;
            }

            try {
                await db.$transaction(async (tx) => {
                    await tx.account.update({
                        where: { id: oldAccountId },
                        data: {
                            username: null,
                        },
                    });
                    await tx.account.update({
                        where: { id: newAccount.id },
                        data: {
                            username: desiredUsername,
                            feedSeq: oldAccountForReset.feedSeq,
                        },
                    });

                    await tx.userRelationship.updateMany({
                        where: { fromUserId: oldAccountId },
                        data: { fromUserId: newAccount.id },
                    });
                    await tx.userRelationship.updateMany({
                        where: { toUserId: oldAccountId },
                        data: { toUserId: newAccount.id },
                    });
                    await tx.userFeedItem.updateMany({
                        where: { userId: oldAccountId },
                        data: { userId: newAccount.id },
                    });
                });

                await db.accountIdentity.updateMany({
                    where: { accountId: newAccount.id, provider: providerId },
                    data: { showOnProfile: identitySnapshot.showOnProfile },
                });
            } catch (error) {
                await clearDisableMarkerBestEffort();
                await deleteNewIdentityBestEffort();
                await restoreOldIdentityBestEffort();
                await deleteNewAccountBestEffort();
                throw error;
            }

            await db.repeatKey.deleteMany({ where: { key: pendingKey } });

            const token = await auth.createToken(newAccount.id);
            return reply.send({ success: true, token });
        }

        const shouldSetUsername = !existingAccount?.username;

        const account = await db.account.upsert({
            where: { publicKey: publicKeyHex },
            update: {
                updatedAt: new Date(),
                ...(shouldSetUsername ? { username: desiredUsername } : {}),
                ...(contentPublicKey ? { contentPublicKey: new Uint8Array(contentPublicKey) } : {}),
                ...(contentPublicKeySig ? { contentPublicKeySig: new Uint8Array(contentPublicKeySig) } : {}),
            },
            create: {
                publicKey: publicKeyHex,
                username: desiredUsername,
                ...(contentPublicKey ? { contentPublicKey: new Uint8Array(contentPublicKey) } : {}),
                ...(contentPublicKeySig ? { contentPublicKeySig: new Uint8Array(contentPublicKeySig) } : {}),
            },
        });

        const ctx = Context.create(account.id);
        try {
            await connectExternalIdentity({
                providerId,
                ctx,
                profile: pendingProfile,
                accessToken,
                refreshToken,
            });
            await db.repeatKey.deleteMany({ where: { key: pendingKey } });
        } catch (error) {
            if (error instanceof Error && error.message === "not-eligible") {
                if (!existingAccount) {
                    await db.account.delete({ where: { id: account.id } }).catch(() => {});
                }
                await db.repeatKey.deleteMany({ where: { key: pendingKey } });
                return reply.code(403).send({ error: "not-eligible" });
            }
            if (error instanceof Error && error.message === PROVIDER_ALREADY_LINKED_ERROR) {
                if (!existingAccount) {
                    await db.account.delete({ where: { id: account.id } }).catch(() => {});
                }
                await db.repeatKey.deleteMany({ where: { key: pendingKey } });
                return reply.code(409).send({ error: PROVIDER_ALREADY_LINKED_ERROR, provider: providerId });
            }
            if (!existingAccount) {
                await db.account.delete({ where: { id: account.id } }).catch(() => {});
            }
            throw error;
        }

        const token = await auth.createToken(account.id);
        return reply.send({ success: true, token });
    });
}
