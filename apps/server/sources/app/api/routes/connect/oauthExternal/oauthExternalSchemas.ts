import { z } from "zod";
import {
    AccountEncryptionMigrateExternalAuthBindingDigestV1Schema,
} from "@happier-dev/protocol";

export const oauthStateAttemptSchema = z.object({
    provider: z.string(),
    pkceCodeVerifier: z.string(),
    nonce: z.string(),
    webAppOAuthReturnUrl: z.string().optional(),
});

export const connectPendingSchema = z.object({
    flow: z.literal("connect"),
    provider: z.string(),
    userId: z.string(),
    profileEnc: z.string(),
    accessTokenEnc: z.string(),
    refreshTokenEnc: z.string().optional(),
});

const authPendingSharedSchema = z.object({
    flow: z.literal("auth"),
    provider: z.string(),
    profileEnc: z.string(),
    accessTokenEnc: z.string(),
    refreshTokenEnc: z.string().optional(),
    suggestedUsername: z.string().nullable().optional(),
    usernameRequired: z.boolean().optional(),
    usernameReason: z.string().nullable().optional(),
});

const authPendingLegacyKeylessSchema = authPendingSharedSchema.extend({
    authMode: z.literal("keyless"),
    proofHash: z.string(),
}).strict();

const authPendingLegacyKeyedSchema = authPendingSharedSchema.extend({
    publicKeyHex: z.string(),
}).strict();

const authPendingV2Schema = authPendingSharedSchema.extend({
    v: z.literal(2),
    proofHash: z.string(),
}).strict();

export const authPendingSchema = z.union([
    authPendingV2Schema,
    authPendingLegacyKeylessSchema,
    authPendingLegacyKeyedSchema,
]);

export const accountEncryptionFirstKeyStepUpPendingSchema = z
    .object({
        v: z.literal(3),
        flow: z.literal("auth"),
        purpose:
            z.literal("account_encryption_first_key"),
        provider: z.string().min(1),
        userId: z.string().min(1),
        providerUserId: z.string().min(1),
        proofHash: z.string().regex(/^[0-9a-f]{64}$/),
        requestDigest:
            AccountEncryptionMigrateExternalAuthBindingDigestV1Schema,
    })
    .strict();

export const oauthAuthPendingSchema = z.union([
    authPendingSchema,
    accountEncryptionFirstKeyStepUpPendingSchema,
]);
