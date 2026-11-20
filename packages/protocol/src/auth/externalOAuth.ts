import { z } from '../zodRuntimePolicy.js';
import { TeamInvitationPostAuthContinuationV1Schema } from '../teams/invitation.js';

const ExternalOAuthParamsBaseResponseSchema = z.strictObject({
  url: z.string().check(z.minLength(1)),
  /** Present only when the request opted in and the server bound a desktop app return. */
  desktopAttemptId: z.optional(z.string().check(z.minLength(1))),
});

const AccountDirectoryOAuthParamsResponseSchema =
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalOAuthParamsBaseResponseSchema, {
    purpose: z.literal('account_directory'),
    credentialTarget: z.literal('account_directory'),
    endpointUrl: z.string().check(z.url()),
    endpointServerIdentityId: z.string().check(z.trim(), z.minLength(1)),
    canonicalServerUrl: z.string().check(z.url()),
    expiresAt: z.string().check(z.iso.datetime({ offset: true }), z.maxLength(64)),
  }));

const TeamOAuthParamsResponseSchema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalOAuthParamsBaseResponseSchema, {
  purpose: z.literal('team_admission'),
  teamId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  admissionReference: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
}));

export const ExternalOAuthParamsResponseSchema = z.union([
  AccountDirectoryOAuthParamsResponseSchema,
  TeamOAuthParamsResponseSchema,
  ExternalOAuthParamsBaseResponseSchema,
]);
export type ExternalOAuthParamsResponse = z.infer<typeof ExternalOAuthParamsResponseSchema>;

export const ExternalOAuthErrorResponseSchema = z.strictObject({ error: z.string().check(z.minLength(1)) });
export type ExternalOAuthErrorResponse = z.infer<typeof ExternalOAuthErrorResponseSchema>;

export const ExternalOAuthFinalizeAuthRequestSchema = z.strictObject({
    pending: z.string().check(z.minLength(1)),
    proof: z.optional(z.string().check(z.minLength(1))),
    reset: z.optional(z.boolean()),
    username: z.optional(z.string().check(z.minLength(1))),
    publicKey: z.string().check(z.minLength(1)),
    challenge: z.string().check(z.minLength(1)),
    signature: z.string().check(z.minLength(1)),
    contentPublicKey: z.optional(z.string().check(z.minLength(1))),
    contentPublicKeySig: z.optional(z.string().check(z.minLength(1))),
  }).check(z.superRefine((value, ctx) => {
    const hasContentKey = typeof value.contentPublicKey === 'string';
    const hasContentSig = typeof value.contentPublicKeySig === 'string';
    if (hasContentKey !== hasContentSig) {
      ctx.addIssue({
        code: "custom",
        message: 'contentPublicKey and contentPublicKeySig must be provided together',
      });
    }
  }));

export type ExternalOAuthFinalizeAuthRequest = z.infer<typeof ExternalOAuthFinalizeAuthRequestSchema>;

export const ExternalOAuthFinalizeAuthSuccessResponseSchema = z.strictObject({
    success: z.literal(true),
    token: z.string().check(z.trim(), z.minLength(1)),
    teamInvitationContinuation: z.optional(TeamInvitationPostAuthContinuationV1Schema),
  });
export type ExternalOAuthFinalizeAuthSuccessResponse = z.infer<typeof ExternalOAuthFinalizeAuthSuccessResponseSchema>;

export const ExternalOAuthFinalizeConnectRequestSchema = z.strictObject({
    pending: z.string().check(z.minLength(1)),
    username: z.string().check(z.minLength(1)),
  });

export type ExternalOAuthFinalizeConnectRequest = z.infer<typeof ExternalOAuthFinalizeConnectRequestSchema>;

export const ExternalOAuthFinalizeConnectSuccessResponseSchema = z.strictObject({
  success: z.literal(true),
  token: z.optional(z.string().check(z.trim(), z.minLength(1))),
});
export type ExternalOAuthFinalizeConnectSuccessResponse = z.infer<typeof ExternalOAuthFinalizeConnectSuccessResponseSchema>;
