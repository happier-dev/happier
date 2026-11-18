import { z } from "zod/mini";
import { AccountEncryptionMigrateExternalAuthBindingDigestV1Schema, AccountEncryptionMigrateExternalAuthProofSchema } from '@happier-dev/protocol/account/encryptionMigrate';
import { PASSWORD_MAX_UTF8_BYTES_V1 } from '@happier-dev/protocol/auth/accountPasswordCredential';
import type { Fastify } from "../../types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { isEffectiveHomeAuthMethodActionEnabled } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { PasswordHashOverloadedError } from "@/app/auth/password/passwordHashAdmission";
import { createNativePasswordFirstKeyStepUp } from "@/app/auth/password/nativePasswordFirstKeyStepUp";
import { requirePresentUser, PresentUserRequiredResponseSchema } from "@/app/api/utils/requirePresentUser";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";

export function registerNativePasswordStepUpRoutes(app: Fastify): void {
    app.post("/v1/auth/email/step-up", {
        preHandler: [app.authenticate, requirePresentUser],
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "auth.email.stepUp") },
        schema: {
            body: z.strictObject({ v: z.literal(1), password: z.string().check(z.maxLength(PASSWORD_MAX_UTF8_BYTES_V1)),
                purpose: z.literal("account_encryption_first_key"), requestDigest: AccountEncryptionMigrateExternalAuthBindingDigestV1Schema }),
            response: {
                200: z.strictObject({ externalAuthProof: AccountEncryptionMigrateExternalAuthProofSchema }),
                401: z.strictObject({ error: z.string() }),
                403: z.union([PresentUserRequiredResponseSchema, z.strictObject({ error: z.enum(["method_not_available", "authentication_failed"]) })]),
                503: z.strictObject({ error: z.literal("password_hash_overloaded") }),
            },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        if (!await isEffectiveHomeAuthMethodActionEnabled({ env: requestHomeEnv, methodId: "email_password", actionId: "login" })) {
            return reply.code(403).send({ error: "method_not_available" });
        }
        try {
            const externalAuthProof = await createNativePasswordFirstKeyStepUp({ accountId: request.userId,
                password: request.body.password, requestDigest: request.body.requestDigest });
            if (!externalAuthProof) return reply.code(403).send({ error: "authentication_failed" });
            return reply.send({ externalAuthProof });
        } catch (error) {
            if (error instanceof PasswordHashOverloadedError) return reply.code(503).send({ error: "password_hash_overloaded" });
            throw error;
        }
    });
}
