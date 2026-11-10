import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { AccountEncryptionModeSchema } from '../features/payload/capabilities/encryptionCapabilities.js';

export const AccountEncryptionModeResponseSchema = lazyZodSchema(() => z.strictObject({
  mode: AccountEncryptionModeSchema,
  updatedAt: z.number().check(z.int(), z.minimum(0)),
}));

export type AccountEncryptionModeResponse = z.infer<typeof AccountEncryptionModeResponseSchema>;

export const AccountRecipientEnvelopeUnavailableReasonSchema = lazyZodSchema(() => z.enum([
  'plain_account',
  'encryption_setup_required',
  'encryption_inconsistent',
]));
export type AccountRecipientEnvelopeUnavailableReason = z.infer<
  typeof AccountRecipientEnvelopeUnavailableReasonSchema
>;

// A public projection of the server's Account readiness decision, without binding material.
export const AccountRecipientEnvelopeReadinessSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available') }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: AccountRecipientEnvelopeUnavailableReasonSchema,
  }),
]));
export type AccountRecipientEnvelopeReadiness = z.infer<typeof AccountRecipientEnvelopeReadinessSchema>;

export const AccountEncryptionCurrentnessResponseSchema = lazyZodSchema(() => z.strictObject({
  mode: AccountEncryptionModeSchema,
  version: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
  // Additive presentation-currentness witness. Consumers that use it for
  // privacy must fail closed when an older Home omits it.
  settingsVersion: z.optional(z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER))),
  signingKeyFingerprint: z.nullable(z.string().check(z.minLength(1), z.maxLength(256))),
  contentKeyFingerprint: z.nullable(z.string().check(z.minLength(1), z.maxLength(256))),
  updatedAt: z.number().check(z.int(), z.minimum(0)),
  // Additive readiness witness: released Homes (and `../0.2`) answer this route
  // without it. Consumers that need readiness fail closed when it is absent
  // rather than rejecting the whole currentness read.
  recipientEnvelopeReadiness: z.optional(AccountRecipientEnvelopeReadinessSchema),
}));

export type AccountEncryptionCurrentnessResponse = z.infer<
  typeof AccountEncryptionCurrentnessResponseSchema
>;

export const AccountEncryptionCurrentnessErrorResponseSchema = lazyZodSchema(() => z.strictObject({
  error: z.literal('migration-required'),
  recipientEnvelopeReadiness: z.strictObject({
    status: z.literal('unavailable'),
    reason: z.enum(AccountRecipientEnvelopeUnavailableReasonSchema.options.filter((value): value is Exclude<(typeof AccountRecipientEnvelopeUnavailableReasonSchema.options)[number], 'plain_account'> => !(['plain_account'] as readonly string[]).includes(value))),
  }),
}));
export type AccountEncryptionCurrentnessErrorResponse = z.infer<
  typeof AccountEncryptionCurrentnessErrorResponseSchema
>;

export const AccountEncryptionModeUpdateRequestSchema = lazyZodSchema(() => z.strictObject({
  mode: AccountEncryptionModeSchema,
}));

export type AccountEncryptionModeUpdateRequest = z.infer<typeof AccountEncryptionModeUpdateRequestSchema>;
