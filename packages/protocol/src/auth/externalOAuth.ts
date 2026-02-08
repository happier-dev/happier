import { z } from 'zod';

export const ExternalOAuthParamsResponseSchema = z.object({ url: z.string().min(1) }).strict();
export type ExternalOAuthParamsResponse = z.infer<typeof ExternalOAuthParamsResponseSchema>;

export const ExternalOAuthErrorResponseSchema = z.object({ error: z.string().min(1) }).strict();
export type ExternalOAuthErrorResponse = z.infer<typeof ExternalOAuthErrorResponseSchema>;

export const ExternalOAuthFinalizeAuthRequestSchema = z
  .object({
    pending: z.string().min(1),
    reset: z.boolean().optional(),
    username: z.string().min(1).optional(),
    publicKey: z.string().min(1),
    challenge: z.string().min(1),
    signature: z.string().min(1),
    contentPublicKey: z.string().min(1).optional(),
    contentPublicKeySig: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasContentKey = typeof value.contentPublicKey === 'string';
    const hasContentSig = typeof value.contentPublicKeySig === 'string';
    if (hasContentKey !== hasContentSig) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'contentPublicKey and contentPublicKeySig must be provided together',
      });
    }
  });

export type ExternalOAuthFinalizeAuthRequest = z.infer<typeof ExternalOAuthFinalizeAuthRequestSchema>;

export const ExternalOAuthFinalizeAuthSuccessResponseSchema = z
  .object({ success: z.literal(true), token: z.string().min(1) })
  .strict();
export type ExternalOAuthFinalizeAuthSuccessResponse = z.infer<typeof ExternalOAuthFinalizeAuthSuccessResponseSchema>;

export const ExternalOAuthFinalizeConnectRequestSchema = z
  .object({
    pending: z.string().min(1),
    username: z.string().min(1),
  })
  .strict();

export type ExternalOAuthFinalizeConnectRequest = z.infer<typeof ExternalOAuthFinalizeConnectRequestSchema>;

export const ExternalOAuthFinalizeConnectSuccessResponseSchema = z.object({ success: z.literal(true) }).strict();
export type ExternalOAuthFinalizeConnectSuccessResponse = z.infer<typeof ExternalOAuthFinalizeConnectSuccessResponseSchema>;
