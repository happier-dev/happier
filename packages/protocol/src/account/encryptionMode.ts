import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { AccountEncryptionModeSchema } from '../features/payload/capabilities/encryptionCapabilities.js';

export const AccountEncryptionModeResponseSchema = lazyZodSchema(() => z.object({
  mode: AccountEncryptionModeSchema,
  updatedAt: z.number().int().min(0),
}).strict());

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
  z.object({ status: z.literal('available') }).strict(),
  z.object({
    status: z.literal('unavailable'),
    reason: AccountRecipientEnvelopeUnavailableReasonSchema,
  }).strict(),
]));
export type AccountRecipientEnvelopeReadiness = z.infer<typeof AccountRecipientEnvelopeReadinessSchema>;

export const AccountEncryptionCurrentnessResponseSchema = lazyZodSchema(() => z.object({
  mode: AccountEncryptionModeSchema,
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  // Additive presentation-currentness witness. Consumers that use it for
  // privacy must fail closed when an older Home omits it.
  settingsVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  signingKeyFingerprint: z.string().min(1).max(256).nullable(),
  contentKeyFingerprint: z.string().min(1).max(256).nullable(),
  updatedAt: z.number().int().min(0),
  // Additive readiness witness: released Homes (and `../0.2`) answer this route
  // without it. Consumers that need readiness fail closed when it is absent
  // rather than rejecting the whole currentness read.
  recipientEnvelopeReadiness: AccountRecipientEnvelopeReadinessSchema.optional(),
}).strict());

export type AccountEncryptionCurrentnessResponse = z.infer<
  typeof AccountEncryptionCurrentnessResponseSchema
>;

export const AccountEncryptionCurrentnessErrorResponseSchema = lazyZodSchema(() => z.object({
  error: z.literal('migration-required'),
  recipientEnvelopeReadiness: z.object({
    status: z.literal('unavailable'),
    reason: AccountRecipientEnvelopeUnavailableReasonSchema.exclude(['plain_account']),
  }).strict(),
}).strict());
export type AccountEncryptionCurrentnessErrorResponse = z.infer<
  typeof AccountEncryptionCurrentnessErrorResponseSchema
>;

export const AccountEncryptionModeUpdateRequestSchema = lazyZodSchema(() => z.object({
  mode: AccountEncryptionModeSchema,
}).strict());

export type AccountEncryptionModeUpdateRequest = z.infer<typeof AccountEncryptionModeUpdateRequestSchema>;
