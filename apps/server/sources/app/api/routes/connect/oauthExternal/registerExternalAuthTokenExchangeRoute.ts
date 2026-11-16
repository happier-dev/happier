import { z } from "zod/mini";

import { type Fastify } from "../../../types";
import { auth } from "@/app/auth/auth";
import { readOAuthAuthenticationEvidenceInTx } from "@/app/auth/authenticationEvidence";
import { enforceLoginEligibility } from "@/app/auth/enforceLoginEligibility";
import { isEffectiveHomeAuthMethodActionEnabled, isEffectiveHomeAuthMethodActionEnabledInTx } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { resolveOAuthRuntimeById, resolveRuntimeInTx } from "@/app/auth/providers/identityProviderCatalog";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { resolveKeylessAccountsAvailability } from "@/app/features/e2ee/resolveKeylessAccountsEnabled";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { oauthExternalRateLimitAuthParamsPerIp } from "./oauthExternalRateLimits";

/** Validates an explicitly allowed external bearer and signs into an existing plain Account. */
export function registerExternalAuthTokenExchangeRoute(app: Fastify) {
    app.post("/v1/auth/external/:provider/token-exchange", {
        config: { rateLimit: oauthExternalRateLimitAuthParamsPerIp() },
        schema: {
            params: z.object({ provider: z.string() }),
            body: z.object({ accessToken: z.string().check(z.minLength(1)) }),
            response: {
                200: z.object({ success: z.literal(true), token: z.string().check(z.minLength(1)) }),
                401: z.object({ error: z.literal("invalid-token") }),
                403: z.object({
                    error: z.enum(["token-exchange-disabled", "client-not-allowed", "account-disabled", "provider-required", "not-eligible"]),
                    provider: z.optional(z.string()),
                }),
                404: z.object({ error: z.enum(["unsupported-provider", "not-linked"]) }),
                409: z.object({ error: z.enum(["restore-required", "auth_provider_configuration_changed"]) }),
                502: z.object({ error: z.literal("upstream_error") }),
                503: z.object({ error: z.literal("upstream_error") }),
            },
        },
    }, async (request, reply) => {
        const env = await readRequestHomeEnv(request);
        const providerId = request.params.provider.trim().toLowerCase();
        const runtime = await resolveOAuthRuntimeById(env, providerId);
        if (!runtime) return reply.code(404).send({ error: "unsupported-provider" });
        const verify = runtime.provider.verifyExternalAccessToken;
        if (!verify || !resolveKeylessAccountsAvailability(env).ok || !await isEffectiveHomeAuthMethodActionEnabled({
            env, methodId: providerId, actionId: "login", mode: "keyless",
        })) return reply.code(403).send({ error: "token-exchange-disabled" });

        const verification = await verify({ accessToken: request.body.accessToken.trim() });
        if (!verification.ok) {
            if (verification.error === "client-not-allowed") return reply.code(403).send({ error: "client-not-allowed" });
            if (verification.error === "upstream_error") return reply.code(502).send({ error: "upstream_error" });
            return reply.code(401).send({ error: "invalid-token" });
        }
        const providerUserId = runtime.provider.getProviderUserId(verification.profile);
        if (!providerUserId) return reply.code(401).send({ error: "invalid-token" });
        const identity = await db.accountIdentity.findFirst({
            where: { provider: providerId, providerUserId },
            select: { id: true, accountId: true },
        });
        if (!identity) return reply.code(404).send({ error: "not-linked" });

        const eligibility = await enforceLoginEligibility({ accountId: identity.accountId, readEnv: async () => env });
        if (!eligibility.ok) {
            if (eligibility.statusCode === 401) return reply.code(401).send({ error: "invalid-token" });
            if (eligibility.statusCode === 503) return reply.code(503).send({ error: "upstream_error" });
            if (eligibility.error === "provider-required") return reply.code(403).send({ error: eligibility.error, provider: eligibility.provider });
            return reply.code(403).send({ error: eligibility.error });
        }

        const result = await inTx(async (tx) => {
            const current = await resolveRuntimeInTx(tx, { env, reference: runtime.reference, purpose: "oauth_finalize" });
            if (!current.ok) return { error: "auth_provider_configuration_changed" } as const;
            if (!await isEffectiveHomeAuthMethodActionEnabledInTx(tx, {
                env, methodId: providerId, actionId: "login", mode: "keyless",
            })) return { error: "token-exchange-disabled" } as const;
            const linked = await tx.accountIdentity.findFirst({
                where: { id: identity.id, accountId: identity.accountId, provider: providerId, providerUserId },
                select: { account: { select: { publicKey: true, encryptionMode: true, contentPublicKey: true, contentPublicKeySig: true } } },
            });
            if (!linked) return { error: "not-linked" } as const;
            const currentness = deriveAccountEncryptionCurrentnessFromRow(linked.account);
            if (currentness.status !== "ready" || currentness.currentness.encryptionMode === "e2ee") {
                return { error: "restore-required" } as const;
            }
            const authenticationEvidence = await readOAuthAuthenticationEvidenceInTx(tx, {
                accountId: identity.accountId, providerId, runtimeFingerprint: current.reference.runtimeFingerprint,
            });
            if (!authenticationEvidence) return { error: "not-linked" } as const;
            return { token: await auth.createTokenInTx(tx, identity.accountId, undefined, {
                kind: "account", authority: "present_user", authenticationEvidence,
            }) } as const;
        }, { isolationLevel: "Serializable" /* Current provider, identity, Home login policy and credential evidence share one admission. */ });
        if (result.token !== undefined) return reply.send({ success: true, token: result.token });
        if (result.error === "token-exchange-disabled") return reply.code(403).send({ error: result.error });
        if (result.error === "not-linked") return reply.code(404).send({ error: result.error });
        return reply.code(409).send({ error: result.error });
    });
}
