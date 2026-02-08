import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";

import { type Fastify } from "../types";
import { auth } from "@/app/auth/auth";
import { resolveAuthPolicyFromEnv } from "@/app/auth/authPolicy";
import { Context } from "@/context";
import { decryptString, encryptString } from "@/modules/encrypt";
import { findOAuthProviderById } from "@/app/oauth/providers/registry";
import { connectExternalIdentity, disconnectExternalIdentity } from "@/app/auth/providers/identity";
import { db } from "@/storage/db";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { validateUsername } from "@/app/social/usernamePolicy";
import { deleteOAuthPendingBestEffort, loadValidOAuthPending } from "./connectRoutes.oauthPending";
import { deleteOAuthStateAttemptBestEffort, loadValidOAuthStateAttempt } from "./connectRoutes.oauthStateAttempt";
import { generatePkceVerifier, pkceChallengeS256 } from "@/app/oauth/pkce";
import { isLoopbackHostname } from "@/utils/urlSafety";
import { accountDisabledKey, disableAccount } from "@/app/auth/accountDisable";
import { log } from "@/utils/log";
import {
    ExternalOAuthErrorResponseSchema,
    ExternalOAuthFinalizeAuthRequestSchema,
    ExternalOAuthFinalizeAuthSuccessResponseSchema,
    ExternalOAuthFinalizeConnectRequestSchema,
    ExternalOAuthFinalizeConnectSuccessResponseSchema,
    ExternalOAuthParamsResponseSchema,
} from "@happier-dev/protocol";

const OAUTH_NOT_CONFIGURED_ERROR = "oauth_not_configured";
const PROVIDER_ALREADY_LINKED_ERROR = "provider-already-linked";
const RECOVERY_DISABLED_ERROR = "recovery-disabled";

function parseBooleanEnvFallback(raw: string | undefined, fallback: boolean): boolean {
    const v = (raw ?? "").toString().trim().toLowerCase();
    if (!v) return fallback;
    if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
    if (v === "0" || v === "false" || v === "no" || v === "off") return false;
    return fallback;
}

function isProviderResetEnabled(env: NodeJS.ProcessEnv): boolean {
    return parseBooleanEnvFallback(env.AUTH_RECOVERY_PROVIDER_RESET_ENABLED, true);
}

function parseAllowedOAuthReturnSchemes(env: NodeJS.ProcessEnv): Set<string> {
    const raw = (env.HAPPIER_OAUTH_RETURN_ALLOWED_SCHEMES ?? env.HAPPY_OAUTH_RETURN_ALLOWED_SCHEMES ?? "")
        .toString()
        .trim();
    const out = new Set<string>();
    if (!raw) return out;

    for (const part of raw.split(/[,\s]+/g)) {
        const trimmed = part.trim().toLowerCase();
        if (!trimmed) continue;
        if (!/^[a-z][a-z0-9+.-]*$/.test(trimmed)) continue;
        // Never allow these, even if explicitly configured.
        if (trimmed === "javascript" || trimmed === "data" || trimmed === "file" || trimmed === "vbscript") continue;
        // Never allow generic http redirects. Loopback http is handled separately.
        if (trimmed === "http") continue;
        out.add(trimmed);
    }
    return out;
}

function rateLimitPerIp() {
    return {
        max: 60,
        timeWindow: "1 minute",
    };
}

function rateLimitPerUser() {
    return {
        max: 60,
        timeWindow: "1 minute",
        keyGenerator: (request: any) => request?.userId?.toString?.() ?? request?.ip ?? "unknown",
    };
}

function isSafeWebRedirectUrl(env: NodeJS.ProcessEnv, url: URL): boolean {
    const scheme = url.protocol.replace(/:$/, "").toLowerCase();
    if (scheme === "https") return true;
    if (scheme === "http" && isLoopbackHostname(url.hostname)) return true;
    const allowed = parseAllowedOAuthReturnSchemes(env);
    return allowed.has(scheme);
}

function tryNormalizeSafeWebRedirectUrl(env: NodeJS.ProcessEnv, raw: string): string | null {
    try {
        const url = new URL(raw);
        if (!isSafeWebRedirectUrl(env, url)) return null;
        return url.toString();
    } catch {
        return null;
    }
}

function resolveWebAppBaseUrlFromEnv(env: NodeJS.ProcessEnv): string {
    return (
        env.HAPPIER_WEBAPP_URL ??
        env.HAPPY_WEBAPP_URL ??
        "https://app.happier.dev"
    )
        .toString()
        .trim() || "https://app.happier.dev";
}

function resolveWebAppOAuthReturnUrlFromEnv(env: NodeJS.ProcessEnv, providerId: string): string {
    const normalizedProvider = providerId.toString().trim().toLowerCase();
    const encodedProvider = encodeURIComponent(normalizedProvider);

    const oauthBaseRaw = (env.HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE ?? env.HAPPY_WEBAPP_OAUTH_RETURN_URL_BASE ?? "")
        .toString()
        .trim();
    if (oauthBaseRaw) {
        const oauthBase = oauthBaseRaw.replace(/\/+$/, "");
        const suffix = `/${encodedProvider}`;
        let candidate: string;
        if (new RegExp(`${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/?$`).test(oauthBase)) {
            candidate = oauthBase;
        } else if (/^[a-z][a-z0-9+.-]*:\/\/$/i.test(oauthBase)) {
            candidate = `${oauthBase}${encodedProvider}`;
        } else {
            candidate = `${oauthBase}${suffix}`;
        }

        const normalized = tryNormalizeSafeWebRedirectUrl(env, candidate);
        if (normalized) return normalized;
    }

    const base = resolveWebAppBaseUrlFromEnv(env).trim();
    const suffix = `/oauth/${encodedProvider}`;
    if (!base) return `https://app.happier.dev${suffix}`;
    let candidate: string;
    if (new RegExp(`${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/?$`).test(base)) {
        candidate = base;
    } else if (/^[a-z][a-z0-9+.-]*:\/\/$/i.test(base)) {
        candidate = `${base}oauth/${encodedProvider}`;
    } else {
        candidate = `${base.replace(/\/+$/, "")}${suffix}`;
    }

    const normalized = tryNormalizeSafeWebRedirectUrl(env, candidate);
    if (normalized) return normalized;

    return `https://app.happier.dev${suffix}`;
}

function buildRedirectUrl(baseUrl: string, params: Record<string, string>): string {
    const url = new URL(baseUrl);
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
    }
    return url.toString();
}

function resolveOAuthPendingTtlMsFromEnv(env: NodeJS.ProcessEnv): number {
    const raw = (env.OAUTH_PENDING_TTL_SECONDS ?? env.GITHUB_OAUTH_PENDING_TTL_SECONDS ?? "").toString().trim();
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 600;
    const clampedSeconds = Math.max(60, Math.min(3600, seconds));
    return clampedSeconds * 1000;
}

function resolveOauthStateAttemptTtlMsFromEnv(env: NodeJS.ProcessEnv): number {
    const raw = (env.OAUTH_STATE_TTL_SECONDS ?? "").toString().trim();
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 600;
    const clampedSeconds = Math.max(60, Math.min(3600, seconds));
    return clampedSeconds * 1000;
}

const oauthStateAttemptSchema = z.object({
    provider: z.string(),
    pkceCodeVerifier: z.string(),
    nonce: z.string(),
});

const connectPendingSchema = z.object({
    flow: z.literal("connect"),
    provider: z.string(),
    userId: z.string(),
    profileEnc: z.string(),
    accessTokenEnc: z.string(),
    refreshTokenEnc: z.string().optional(),
});

const authPendingSchema = z.object({
    flow: z.literal("auth"),
    provider: z.string(),
    publicKeyHex: z.string(),
    profileEnc: z.string(),
    accessTokenEnc: z.string(),
    refreshTokenEnc: z.string().optional(),
    suggestedUsername: z.string().nullable().optional(),
    usernameRequired: z.boolean().optional(),
    usernameReason: z.string().nullable().optional(),
});

export function connectOAuthExternalRoutes(app: Fastify) {
    //
    // External provider signup (no existing account required)
    //

    app.get("/v1/auth/external/:provider/params", {
        config: { rateLimit: rateLimitPerIp() },
        schema: {
            params: z.object({ provider: z.string() }),
            querystring: z.object({ publicKey: z.string() }),
            response: {
                200: ExternalOAuthParamsResponseSchema,
                400: ExternalOAuthErrorResponseSchema,
                403: ExternalOAuthErrorResponseSchema,
                404: z.object({ error: z.literal("unsupported-provider") }),
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

        let publicKeyHex: string;
        try {
            const publicKeyBytes = privacyKit.decodeBase64(request.query.publicKey);
            if (publicKeyBytes.length !== tweetnacl.sign.publicKeyLength) {
                return reply.code(400).send({ error: "Invalid public key" });
            }
            publicKeyHex = privacyKit.encodeHex(publicKeyBytes);
        } catch {
            return reply.code(400).send({ error: "Invalid public key" });
        }

        try {
            // Create a one-time state attempt record for PKCE + OIDC nonce binding.
            const ttlMs = resolveOauthStateAttemptTtlMsFromEnv(process.env);
            const pkceCodeVerifier = generatePkceVerifier(64);
            const codeChallenge = pkceChallengeS256(pkceCodeVerifier);
            const nonce = randomBytes(32).toString("base64url");

            let sid = "";
            for (let i = 0; i < 3; i++) {
                sid = randomKeyNaked(24);
                try {
                    await db.repeatKey.create({
                        data: {
                            key: `oauth_state_${sid}`,
                            value: JSON.stringify({ provider: providerId, pkceCodeVerifier, nonce }),
                            expiresAt: new Date(Date.now() + ttlMs),
                        },
                    });
                    break;
                } catch {
                    sid = "";
                }
            }
            if (!sid) {
                return reply.code(400).send({ error: "oauth_state_unavailable" });
            }

            const state = await auth.createOauthStateToken({
                flow: "auth",
                provider: providerId,
                sid,
                publicKey: publicKeyHex,
            });
            const scope = provider.resolveScope({ env: process.env, flow: "auth" });
            const url = await provider.resolveAuthorizeUrl({
                env: process.env,
                state,
                scope,
                codeChallenge,
                codeChallengeMethod: "S256",
                nonce,
            });
            return reply.send({ url });
        } catch (error) {
            if (error instanceof Error && error.message === OAUTH_NOT_CONFIGURED_ERROR) {
                return reply.code(400).send({ error: OAUTH_NOT_CONFIGURED_ERROR });
            }
            throw error;
        }
    });

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

            // Snapshot the old identity so we can restore it if reset fails.
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

            // Create the new account without a username first; we will transfer it after the identity is connected.
            const newAccount = await db.account.create({
                data: {
                    publicKey: publicKeyHex,
                    ...(contentPublicKey ? { contentPublicKey: new Uint8Array(contentPublicKey) } : {}),
                    ...(contentPublicKeySig ? { contentPublicKeySig: new Uint8Array(contentPublicKeySig) } : {}),
                },
                select: { id: true },
            });

            // Temporarily detach the identity from the old account so provider connect can run normally.
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
                // Restore identity on the old account (best-effort) and delete the new account.
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
                // Transfer username and migrate server-side social data (unencrypted).
                await db.$transaction(async (tx) => {
                    await tx.account.update({
                        where: { id: oldAccountId },
                        data: {
                            // Free the username so the new account can claim it.
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

                // Ensure the newly linked identity preserves the previous showOnProfile choice.
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

    app.delete("/v1/auth/external/:provider/pending/:pending", {
        schema: {
            params: z.object({
                provider: z.string(),
                pending: z.string(),
            }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.object({ error: z.literal("unsupported-provider") }),
            },
        },
    }, async (request, reply) => {
        const providerId = request.params.provider.toString().trim().toLowerCase();
        const provider = findOAuthProviderById(process.env, providerId);
        if (!provider) return reply.code(404).send({ error: "unsupported-provider" });

        const pendingKey = request.params.pending.toString().trim();
        if (!pendingKey) return reply.send({ success: true });

        const pending = await loadValidOAuthPending(pendingKey);
        if (!pending) return reply.send({ success: true });
        try {
            const parsed = authPendingSchema.safeParse(JSON.parse(pending.value));
            if (!parsed.success) return reply.send({ success: true });
            if (parsed.data.provider.toString().trim().toLowerCase() !== providerId) return reply.send({ success: true });
        } catch {
            return reply.send({ success: true });
        }

        await deleteOAuthPendingBestEffort(pendingKey);
        return reply.send({ success: true });
    });

    //
    // External provider connection (authenticated identity linking)
    //

    app.get("/v1/connect/external/:provider/params", {
        preHandler: app.authenticate,
        config: { rateLimit: rateLimitPerUser() },
        schema: {
            params: z.object({ provider: z.string() }),
            response: {
                200: ExternalOAuthParamsResponseSchema,
                400: ExternalOAuthErrorResponseSchema,
                404: z.object({ error: z.literal("unsupported-provider") }),
            },
        },
    }, async (request, reply) => {
        const providerId = request.params.provider.toString().trim().toLowerCase();
        const provider = findOAuthProviderById(process.env, providerId);
        if (!provider) return reply.code(404).send({ error: "unsupported-provider" });

        try {
            const ttlMs = resolveOauthStateAttemptTtlMsFromEnv(process.env);
            const pkceCodeVerifier = generatePkceVerifier(64);
            const codeChallenge = pkceChallengeS256(pkceCodeVerifier);
            const nonce = randomBytes(32).toString("base64url");

            let sid = "";
            for (let i = 0; i < 3; i++) {
                sid = randomKeyNaked(24);
                try {
                    await db.repeatKey.create({
                        data: {
                            key: `oauth_state_${sid}`,
                            value: JSON.stringify({ provider: providerId, pkceCodeVerifier, nonce }),
                            expiresAt: new Date(Date.now() + ttlMs),
                        },
                    });
                    break;
                } catch {
                    sid = "";
                }
            }
            if (!sid) {
                return reply.code(400).send({ error: "oauth_state_unavailable" });
            }

            const state = await auth.createOauthStateToken({
                flow: "connect",
                provider: providerId,
                sid,
                userId: request.userId,
            });
            const scope = provider.resolveScope({ env: process.env, flow: "connect" });
            const url = await provider.resolveAuthorizeUrl({
                env: process.env,
                state,
                scope,
                codeChallenge,
                codeChallengeMethod: "S256",
                nonce,
            });
            return reply.send({ url });
        } catch (error) {
            if (error instanceof Error && error.message === OAUTH_NOT_CONFIGURED_ERROR) {
                return reply.code(400).send({ error: OAUTH_NOT_CONFIGURED_ERROR });
            }
            throw error;
        }
    });

    app.post("/v1/connect/external/:provider/finalize", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ provider: z.string() }),
            body: ExternalOAuthFinalizeConnectRequestSchema,
            response: {
                200: ExternalOAuthFinalizeConnectSuccessResponseSchema,
                400: z.object({ error: z.enum(["invalid-pending", "invalid-username"]) }),
                403: z.object({ error: z.enum(["forbidden", "not-eligible"]) }),
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

        const pendingKey = request.body.pending.toString().trim();
        if (!pendingKey) return reply.code(400).send({ error: "invalid-pending" });

        const pending = await loadValidOAuthPending(pendingKey);
        if (!pending) return reply.code(400).send({ error: "invalid-pending" });

        let parsedValue: z.infer<typeof connectPendingSchema>;
        try {
            const parsed = connectPendingSchema.safeParse(JSON.parse(pending.value));
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
        if (parsedValue.userId !== request.userId) {
            return reply.code(403).send({ error: "forbidden" });
        }

        const validation = validateUsername(request.body.username, process.env);
        if (!validation.ok) return reply.code(400).send({ error: "invalid-username" });
        const username = validation.username;

        const taken = await db.account.findFirst({
            where: {
                username,
                NOT: { id: request.userId },
            },
            select: { id: true },
        });
        if (taken) return reply.code(409).send({ error: "username-taken" });

        let accessToken: string;
        let refreshToken: string | undefined;
        let pendingProfile: unknown;
        try {
            const tokenBytes = privacyKit.decodeBase64(parsedValue.accessTokenEnc);
            accessToken = decryptString(["user", request.userId, "connect", providerId, "pending", pendingKey], tokenBytes);
            if (typeof parsedValue.refreshTokenEnc === "string" && parsedValue.refreshTokenEnc.trim()) {
                const refreshBytes = privacyKit.decodeBase64(parsedValue.refreshTokenEnc);
                refreshToken = decryptString(
                    ["user", request.userId, "connect", providerId, "pending", pendingKey, "refresh"],
                    refreshBytes,
                );
            }

            const profileBytes = privacyKit.decodeBase64(parsedValue.profileEnc);
            const profileJson = decryptString(
                ["user", request.userId, "connect", providerId, "pending", pendingKey, "profile"],
                profileBytes,
            );
            pendingProfile = JSON.parse(profileJson);
        } catch {
            await deleteOAuthPendingBestEffort(pendingKey);
            return reply.code(400).send({ error: "invalid-pending" });
        }

        const ctx = Context.create(request.userId);
        try {
            await connectExternalIdentity({
                providerId,
                ctx,
                profile: pendingProfile,
                accessToken,
                refreshToken,
                preferredUsername: username,
            });
        } catch (error) {
            if (error instanceof Error && error.message === "not-eligible") {
                return reply.code(403).send({ error: "not-eligible" });
            }
            if (error instanceof Error && error.message === PROVIDER_ALREADY_LINKED_ERROR) {
                return reply.code(409).send({ error: PROVIDER_ALREADY_LINKED_ERROR, provider: providerId });
            }
            throw error;
        }

        await deleteOAuthPendingBestEffort(pendingKey);
        return reply.send({ success: true });
    });

    app.delete("/v1/connect/external/:provider/pending/:pending", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ provider: z.string(), pending: z.string() }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.object({ error: z.literal("unsupported-provider") }),
            },
        },
    }, async (request, reply) => {
        const providerId = request.params.provider.toString().trim().toLowerCase();
        const provider = findOAuthProviderById(process.env, providerId);
        if (!provider) return reply.code(404).send({ error: "unsupported-provider" });

        const pendingKey = request.params.pending.toString().trim();
        if (!pendingKey) return reply.send({ success: true });

        const pending = await loadValidOAuthPending(pendingKey);
        if (!pending) return reply.send({ success: true });
        try {
            const parsed = connectPendingSchema.safeParse(JSON.parse(pending.value));
            if (!parsed.success) return reply.send({ success: true });
            if (parsed.data.userId !== request.userId) return reply.send({ success: true });
        } catch {
            return reply.send({ success: true });
        }
        await deleteOAuthPendingBestEffort(pendingKey);
        return reply.send({ success: true });
    });

    app.delete("/v1/connect/external/:provider", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ provider: z.string() }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.object({ error: z.literal("unsupported-provider") }),
            },
        },
    }, async (request, reply) => {
        const providerId = request.params.provider.toString().trim().toLowerCase();
        const provider = findOAuthProviderById(process.env, providerId);
        if (!provider) return reply.code(404).send({ error: "unsupported-provider" });

        const ctx = Context.create(request.userId);
        await disconnectExternalIdentity({ providerId, ctx });
        return reply.send({ success: true });
    });

    //
    // OAuth callback (shared for auth + connect based on oauth-state token)
    //

    app.get("/v1/oauth/:provider/callback", {
        config: { rateLimit: rateLimitPerIp() },
        schema: {
            params: z.object({ provider: z.string() }),
            querystring: z
                .object({
                    state: z.string(),
                    code: z.string().optional(),
                    error: z.string().optional(),
                    error_description: z.string().optional(),
                })
                .refine((q) => Boolean(q.code) || Boolean(q.error), {
                    message: "Expected OAuth code or error",
                }),
        },
    }, async (request, reply) => {
        const providerId = request.params.provider.toString().trim().toLowerCase();
        const provider = findOAuthProviderById(process.env, providerId);
        const webAppUrl = resolveWebAppOAuthReturnUrlFromEnv(process.env, providerId);

        if (!provider) {
            return reply.redirect(buildRedirectUrl(webAppUrl, { error: "unsupported-provider" }));
        }

        const { code, state } = request.query;
        const oauthError = (request.query as any)?.error?.toString?.().trim?.() || "";

        const oauthState = await auth.verifyOauthStateToken(state);
        if (!oauthState || oauthState.provider !== providerId) {
            const stateHash = createHash("sha256").update(state, "utf8").digest("hex").slice(0, 12);
            log({ module: "oauth" }, `Invalid state token (sha256:${stateHash})`);
            return reply.redirect(buildRedirectUrl(webAppUrl, { error: "invalid_state" }));
        }

        const sid = oauthState.sid?.toString().trim() || "";
        if (!sid) {
            return reply.redirect(buildRedirectUrl(webAppUrl, { flow: oauthState.flow, error: "invalid_state" }));
        }
        const attempt = await loadValidOAuthStateAttempt(sid);
        if (!attempt) {
            return reply.redirect(buildRedirectUrl(webAppUrl, { flow: oauthState.flow, error: "invalid_state" }));
        }
        await deleteOAuthStateAttemptBestEffort(sid);
        let attemptJson: unknown;
        try {
            attemptJson = JSON.parse(attempt.value);
        } catch {
            return reply.redirect(buildRedirectUrl(webAppUrl, { flow: oauthState.flow, error: "invalid_state" }));
        }
        const attemptParsed = oauthStateAttemptSchema.safeParse(attemptJson);
        if (!attemptParsed.success) {
            return reply.redirect(buildRedirectUrl(webAppUrl, { flow: oauthState.flow, error: "invalid_state" }));
        }
        if (attemptParsed.data.provider.toString().trim().toLowerCase() !== providerId) {
            return reply.redirect(buildRedirectUrl(webAppUrl, { flow: oauthState.flow, error: "invalid_state" }));
        }

        const flow = oauthState.flow;
        const redirectBaseParams: Record<string, string> = { flow };

        if (oauthError) {
            return reply.redirect(buildRedirectUrl(webAppUrl, { ...redirectBaseParams, error: oauthError }));
        }

        const userId = flow === "connect" ? oauthState.userId : null;
        const publicKeyHex = flow === "auth" ? oauthState.publicKey : null;
        if (flow === "connect" && !userId) {
            return reply.redirect(buildRedirectUrl(webAppUrl, { ...redirectBaseParams, error: "invalid_state" }));
        }
        if (flow === "auth" && !publicKeyHex) {
            return reply.redirect(buildRedirectUrl(webAppUrl, { ...redirectBaseParams, error: "invalid_state" }));
        }

        if (!code) {
            return reply.redirect(buildRedirectUrl(webAppUrl, { ...redirectBaseParams, error: "missing_code" }));
        }

        try {
            const { accessToken, refreshToken, idToken, idTokenClaims } = await provider.exchangeCodeForAccessToken({
                env: process.env,
                code,
                state,
                pkceCodeVerifier: attemptParsed.data.pkceCodeVerifier,
                expectedNonce: attemptParsed.data.nonce,
            });
            const profile = await provider.fetchProfile({ env: process.env, accessToken, idToken, idTokenClaims });
            const login = provider.getLogin(profile) ?? "";

            if (flow === "auth") {
                const loginUsername = login ? login.toLowerCase() : null;
                let suggestedUsername: string | null = null;
                let usernameRequired = false;
                let usernameReason: "invalid_login" | "login_taken" | null = null;

                if (loginUsername) {
                    const loginValidation = validateUsername(loginUsername, process.env);
                    if (!loginValidation.ok) {
                        usernameRequired = true;
                        usernameReason = "invalid_login";
                    } else {
                        suggestedUsername = loginValidation.username;
                        const taken = await db.account.findFirst({
                            where: { username: suggestedUsername },
                            select: { id: true },
                        });
                        if (taken) {
                            usernameRequired = true;
                            usernameReason = "login_taken";
                        }
                    }
                } else {
                    usernameRequired = true;
                    usernameReason = "invalid_login";
                }

                const pendingKey = `oauth_pending_${randomKeyNaked(24)}`;
                let profileJson = "";
                try {
                    profileJson = JSON.stringify(profile);
                } catch {
                    return reply.redirect(buildRedirectUrl(webAppUrl, { ...redirectBaseParams, error: "invalid_profile" }));
                }
                const tokenEnc = privacyKit.encodeBase64(
                    encryptString(["auth", "external", providerId, "pending", pendingKey, publicKeyHex!], accessToken),
                );
                const profileEnc = privacyKit.encodeBase64(
                    encryptString(["auth", "external", providerId, "pending", pendingKey, publicKeyHex!, "profile"], profileJson),
                );
                const refreshTokenEnc =
                    typeof refreshToken === "string" && refreshToken.trim()
                        ? privacyKit.encodeBase64(
                              encryptString(
                                  ["auth", "external", providerId, "pending", pendingKey, publicKeyHex!, "refresh"],
                                  refreshToken,
                              ),
                          )
                        : undefined;
                const ttlMs = resolveOAuthPendingTtlMsFromEnv(process.env);
                await db.repeatKey.create({
                    data: {
                        key: pendingKey,
                        value: JSON.stringify({
                            flow: "auth",
                            provider: providerId,
                            publicKeyHex: publicKeyHex!,
                            profileEnc,
                            accessTokenEnc: tokenEnc,
                            ...(refreshTokenEnc ? { refreshTokenEnc } : {}),
                            suggestedUsername,
                            usernameRequired,
                            usernameReason,
                        }),
                        expiresAt: new Date(Date.now() + ttlMs),
                    },
                });

                if (usernameRequired) {
                    return reply.redirect(buildRedirectUrl(webAppUrl, {
                        ...redirectBaseParams,
                        status: "username_required",
                        reason: usernameReason ?? "invalid_login",
                        login,
                        pending: pendingKey,
                    }));
                }

                return reply.redirect(buildRedirectUrl(webAppUrl, { ...redirectBaseParams, pending: pendingKey }));
            }

            const ctx = Context.create(userId!);

            const account = await db.account.findUnique({
                where: { id: userId! },
                select: { username: true },
            });
            const existingUsername = account?.username?.toString().trim() || null;

            const loginUsername = login ? login.toLowerCase() : null;
            if (!existingUsername) {
                let requireUsername = false;
                let usernameReason: "invalid_login" | "login_taken" | null = null;

                if (!loginUsername) {
                    requireUsername = true;
                    usernameReason = "invalid_login";
                } else {
                    const loginValidation = validateUsername(loginUsername, process.env);
                    if (!loginValidation.ok) {
                        requireUsername = true;
                        usernameReason = "invalid_login";
                    } else {
                        const taken = await db.account.findFirst({
                            where: { username: loginValidation.username },
                            select: { id: true },
                        });
                        if (taken) {
                            requireUsername = true;
                            usernameReason = "login_taken";
                        }
                    }
                }

                if (requireUsername) {
                    const pendingKey = `oauth_pending_${randomKeyNaked(24)}`;
                    let profileJson = "";
                    try {
                        profileJson = JSON.stringify(profile);
                    } catch {
                        return reply.redirect(buildRedirectUrl(webAppUrl, { ...redirectBaseParams, error: "invalid_profile" }));
                    }
                    const tokenEnc = privacyKit.encodeBase64(
                        encryptString(["user", userId!, "connect", providerId, "pending", pendingKey], accessToken),
                    );
                    const profileEnc = privacyKit.encodeBase64(
                        encryptString(["user", userId!, "connect", providerId, "pending", pendingKey, "profile"], profileJson),
                    );
                    const refreshTokenEnc =
                        typeof refreshToken === "string" && refreshToken.trim()
                            ? privacyKit.encodeBase64(
                                  encryptString(
                                      ["user", userId!, "connect", providerId, "pending", pendingKey, "refresh"],
                                      refreshToken,
                                  ),
                              )
                            : undefined;
                    const ttlMs = resolveOAuthPendingTtlMsFromEnv(process.env);
                    await db.repeatKey.create({
                        data: {
                            key: pendingKey,
                            value: JSON.stringify({
                                flow: "connect",
                                provider: providerId,
                                userId: userId!,
                                profileEnc,
                                accessTokenEnc: tokenEnc,
                                ...(refreshTokenEnc ? { refreshTokenEnc } : {}),
                            }),
                            expiresAt: new Date(Date.now() + ttlMs),
                        },
                    });

                    return reply.redirect(buildRedirectUrl(webAppUrl, {
                        ...redirectBaseParams,
                        status: "username_required",
                        reason: usernameReason ?? "invalid_login",
                        login,
                        pending: pendingKey,
                    }));
                }
            }

            await connectExternalIdentity({ providerId, ctx, profile, accessToken, refreshToken });
            return reply.redirect(buildRedirectUrl(webAppUrl, { ...redirectBaseParams, status: "connected", login }));
        } catch (error: any) {
            const code = error instanceof Error ? error.message : "server_error";
            const safe =
                code === "missing_access_token" ||
                code === "invalid_profile" ||
                code === "profile_fetch_failed" ||
                code === "not-eligible" ||
                code === OAUTH_NOT_CONFIGURED_ERROR
                    ? code
                    : "server_error";
            return reply.redirect(buildRedirectUrl(webAppUrl, { ...redirectBaseParams, error: safe }));
        }
    });

}
