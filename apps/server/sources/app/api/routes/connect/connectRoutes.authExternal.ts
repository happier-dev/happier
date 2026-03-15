import { z } from "zod";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";

import { type Fastify } from "../../types";
import { resolveAuthPolicyFromEnv } from "@/app/auth/authPolicy";
import { OAUTH_STATE_UNAVAILABLE_CODE } from "@/app/auth/oauthStateErrors";
import { findOAuthProviderById } from "@/app/oauth/providers/registry";
import { createExternalAuthorizeUrl } from "./oauthExternal/createExternalAuthorizeUrl";
import { oauthExternalRateLimitAuthParamsPerIp } from "./oauthExternal/oauthExternalRateLimits";
import { OAUTH_NOT_CONFIGURED_ERROR } from "./oauthExternal/oauthExternalErrors";
import { registerExternalAuthFinalizeRoute } from "./oauthExternal/registerExternalAuthFinalizeRoute";
import { registerExternalAuthFinalizeKeylessRoute } from "./oauthExternal/registerExternalAuthFinalizeKeylessRoute";
import { authPendingSchema } from "./oauthExternal/oauthExternalSchemas";
import { deleteOAuthPendingBestEffort, loadValidOAuthPending } from "./connectRoutes.oauthPending";
import { ExternalOAuthErrorResponseSchema, ExternalOAuthParamsResponseSchema } from "@happier-dev/protocol";
import { readAuthOauthKeylessFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveKeylessAccountsAvailability } from "@/app/features/e2ee/resolveKeylessAccountsEnabled";
import { resolveWebAppOAuthReturnUrlFromRequestHeaders } from "./oauthExternal/oauthExternalConfig";

export function connectAuthExternalRoutes(app: Fastify) {
    //
    // External provider signup (no existing account required)
    //

    app.get("/v1/auth/external/:provider/params", {
        config: { rateLimit: oauthExternalRateLimitAuthParamsPerIp() },
        schema: {
            params: z.object({ provider: z.string() }),
            querystring: z
                .object({
                    publicKey: z.string().optional(),
                    mode: z.enum(["keyed", "keyless"]).optional(),
                    proofHash: z.string().optional(),
                })
                .refine((q) => {
                    if (q.mode === "keyless") return Boolean(q.proofHash);
                    if (typeof q.proofHash === "string" && q.proofHash.trim()) return true;
                    return Boolean(q.publicKey);
                }, {
                    message: "Expected publicKey (legacy keyed) or proofHash (keyed or keyless)",
                }),
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

        const mode = (request.query as any)?.mode === "keyless" ? "keyless" : "keyed";
        const policy = resolveAuthPolicyFromEnv(process.env);
        const keyedAllowed = policy.signupProviders.includes(providerId);
        let keylessAllowed = false;
        if (mode === "keyless") {
            const keyless = readAuthOauthKeylessFeatureEnv(process.env);
            keylessAllowed = keyless.enabled && keyless.providers.includes(providerId);
            if (!keylessAllowed) return reply.code(403).send({ error: "keyless-disabled" });
            const availability = resolveKeylessAccountsAvailability(process.env);
            if (!availability.ok) {
                return reply.code(403).send({ error: availability.reason === "e2ee-required" ? "e2ee-required" : "keyless-disabled" });
            }
        } else {
            // Universal proofHash auth-start: allow if either keyed signup or keyless is allowed.
            const proofHashCandidate = String((request.query as any)?.proofHash ?? "").trim();
            if (proofHashCandidate) {
                const keyless = readAuthOauthKeylessFeatureEnv(process.env);
                keylessAllowed = keyless.enabled && keyless.providers.includes(providerId);
                if (!keyedAllowed && !keylessAllowed) {
                    return reply.code(403).send({ error: "signup-provider-disabled" });
                }
                if (keylessAllowed) {
                    const availability = resolveKeylessAccountsAvailability(process.env);
                    if (!availability.ok && !keyedAllowed) {
                        return reply.code(403).send({ error: availability.reason === "e2ee-required" ? "e2ee-required" : "keyless-disabled" });
                    }
                }
            } else if (!keyedAllowed) {
                return reply.code(403).send({ error: "signup-provider-disabled" });
            }
        }

        let publicKeyHex: string | null = null;
        let proofHash: string | null = null;
        if (mode === "keyed") {
            const proofHashRaw = String((request.query as any)?.proofHash ?? "").trim().toLowerCase();
            if (proofHashRaw) {
                if (!/^[0-9a-f]{64}$/.test(proofHashRaw)) return reply.code(400).send({ error: "Invalid proof" });
                proofHash = proofHashRaw;
            } else {
                try {
                    const publicKeyBytes = privacyKit.decodeBase64((request.query as any).publicKey);
                    if (publicKeyBytes.length !== tweetnacl.sign.publicKeyLength) {
                        return reply.code(400).send({ error: "Invalid public key" });
                    }
                    publicKeyHex = privacyKit.encodeHex(publicKeyBytes);
                } catch {
                    return reply.code(400).send({ error: "Invalid public key" });
                }
            }
        } else {
            proofHash = String((request.query as any)?.proofHash ?? "").trim().toLowerCase();
            if (!/^[0-9a-f]{64}$/.test(proofHash)) return reply.code(400).send({ error: "Invalid proof" });
        }

        try {
            const webAppOAuthReturnUrl = resolveWebAppOAuthReturnUrlFromRequestHeaders({
                env: process.env,
                providerId,
                headers: request.headers as any,
            });
            const url = await createExternalAuthorizeUrl({
                flow: "auth",
                env: process.env,
                providerId,
                provider,
                publicKeyHex,
                proofHash,
                ...(webAppOAuthReturnUrl ? { webAppOAuthReturnUrl } : {}),
            });
            if (!url) return reply.code(400).send({ error: OAUTH_STATE_UNAVAILABLE_CODE });
            return reply.send({ url });
        } catch (error) {
            if (error instanceof Error && error.message === OAUTH_NOT_CONFIGURED_ERROR) {
                return reply.code(400).send({ error: OAUTH_NOT_CONFIGURED_ERROR });
            }
            throw error;
        }
    });

    registerExternalAuthFinalizeRoute(app);
    registerExternalAuthFinalizeKeylessRoute(app);

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
}
