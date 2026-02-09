import { createHash } from "node:crypto";
import * as privacyKit from "privacy-kit";
import { z } from "zod";

import { type Fastify } from "../../../types";
import { connectExternalIdentity } from "@/app/auth/providers/identity";
import { auth } from "@/app/auth/auth";
import { Context } from "@/context";
import { encryptString } from "@/modules/encrypt";
import { findOAuthProviderById } from "@/app/oauth/providers/registry";
import { db } from "@/storage/db";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { validateUsername } from "@/app/social/usernamePolicy";
import { deleteOAuthStateAttemptBestEffort, loadValidOAuthStateAttempt } from "../connectRoutes.oauthStateAttempt";
import { log } from "@/utils/logging/log";
import {
    buildRedirectUrl,
    resolveOAuthPendingTtlMsFromEnv,
    resolveWebAppOAuthReturnUrlFromEnv,
} from "./oauthExternalConfig";
import { OAUTH_NOT_CONFIGURED_ERROR } from "./oauthExternalErrors";
import { oauthExternalRateLimitPerIp } from "./oauthExternalRateLimits";
import { oauthStateAttemptSchema } from "./oauthExternalSchemas";

export function registerOAuthCallbackRoute(app: Fastify) {
    app.get("/v1/oauth/:provider/callback", {
        config: { rateLimit: oauthExternalRateLimitPerIp() },
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
