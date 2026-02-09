import { z } from "zod";

export const oauthStateAttemptSchema = z.object({
    provider: z.string(),
    pkceCodeVerifier: z.string(),
    nonce: z.string(),
});

export const connectPendingSchema = z.object({
    flow: z.literal("connect"),
    provider: z.string(),
    userId: z.string(),
    profileEnc: z.string(),
    accessTokenEnc: z.string(),
    refreshTokenEnc: z.string().optional(),
});

export const authPendingSchema = z.object({
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
