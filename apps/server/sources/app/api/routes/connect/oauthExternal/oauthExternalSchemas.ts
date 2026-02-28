import { z } from "zod";

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
