import { z } from "zod";

import { type Fastify } from "../../../types";
import { auth } from "@/app/auth/auth";
import { enforceLoginEligibility } from "@/app/auth/enforceLoginEligibility";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { readAuthOauthKeylessFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveKeylessAccountsAvailability } from "@/app/features/e2ee/resolveKeylessAccountsEnabled";
import { findOAuthProviderById } from "@/app/oauth/providers/registry";
import { db } from "@/storage/db";
import { oauthExternalRateLimitAuthParamsPerIp } from "./oauthExternalRateLimits";

/**
 * Trades an identity-provider access token for a Happier token on the account already
 * linked to that identity, so a headless machine (a dev box, a CI runner) that already
 * holds its owner's IdP token can sign in without interactive pairing.
 *
 * The provider decides whether the token is acceptable (`verifyExternalAccessToken`,
 * present only when the operator configured an allowed client list). The route then:
 * - honours only an existing identity link and never creates an account, so the
 *   provider's sign-in flow stays the one place that admits a user;
 * - refuses end-to-end encrypted accounts, which need the account secret to sign in;
 * - applies the same login eligibility check every authenticated request applies.
 */
export function registerExternalAuthTokenExchangeRoute(app: Fastify) {
    app.post("/v1/auth/external/:provider/token-exchange", {
        config: { rateLimit: oauthExternalRateLimitAuthParamsPerIp() },
        schema: {
            params: z.object({ provider: z.string() }),
            body: z.object({ accessToken: z.string().min(1) }),
            response: {
                200: z.object({ success: z.literal(true), token: z.string().min(1) }),
                401: z.object({ error: z.literal("invalid-token") }),
                403: z.object({
                    error: z.enum([
                        "token-exchange-disabled",
                        "client-not-allowed",
                        "account-disabled",
                        "provider-required",
                        "not-eligible",
                    ]),
                    provider: z.string().optional(),
                }),
                404: z.object({ error: z.enum(["unsupported-provider", "not-linked"]) }),
                409: z.object({ error: z.literal("restore-required") }),
                502: z.object({ error: z.literal("upstream_error") }),
                503: z.object({ error: z.literal("upstream_error") }),
            },
        },
    }, async (request, reply) => {
        const providerId = request.params.provider.toString().trim().toLowerCase();
        const provider = findOAuthProviderById(process.env, providerId);
        if (!provider) return reply.code(404).send({ error: "unsupported-provider" });

        const verify = provider.verifyExternalAccessToken;
        const keyless = readAuthOauthKeylessFeatureEnv(process.env);
        if (
            !verify ||
            !keyless.enabled ||
            !keyless.providers.includes(providerId) ||
            !resolveKeylessAccountsAvailability(process.env).ok
        ) {
            return reply.code(403).send({ error: "token-exchange-disabled" });
        }

        const verification = await verify({ accessToken: request.body.accessToken.trim() });
        if (!verification.ok) {
            if (verification.error === "client-not-allowed") return reply.code(403).send({ error: "client-not-allowed" });
            if (verification.error === "upstream_error") return reply.code(502).send({ error: "upstream_error" });
            return reply.code(401).send({ error: "invalid-token" });
        }

        const providerUserId = provider.getProviderUserId(verification.profile);
        if (!providerUserId) return reply.code(401).send({ error: "invalid-token" });

        const identity = await db.accountIdentity.findFirst({
            where: { provider: providerId, providerUserId },
            select: { accountId: true, account: { select: { publicKey: true, encryptionMode: true } } },
        });
        if (!identity) return reply.code(404).send({ error: "not-linked" });
        if (resolveEffectiveAccountEncryptionModeFromAccountRow(identity.account) === "e2ee") {
            return reply.code(409).send({ error: "restore-required" });
        }

        const eligibility = await enforceLoginEligibility({ accountId: identity.accountId, env: process.env });
        if (!eligibility.ok) {
            if (eligibility.statusCode === 401) return reply.code(401).send({ error: "invalid-token" });
            if (eligibility.statusCode === 503) return reply.code(503).send({ error: "upstream_error" });
            if (eligibility.error === "provider-required") {
                return reply.code(403).send({ error: "provider-required", provider: eligibility.provider });
            }
            return reply.code(403).send({ error: eligibility.error });
        }

        const token = await auth.createToken(identity.accountId);
        return reply.send({ success: true, token });
    });
}
