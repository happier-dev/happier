import { z } from 'zod';

import { AccountEncryptionModeSchema } from '../features/payload/capabilities/encryptionCapabilities.js';

export const AccountEncryptionModeResponseSchema = z.object({
  mode: AccountEncryptionModeSchema,
  updatedAt: z.number().int().min(0),
}).strict();

export type AccountEncryptionModeResponse = z.infer<typeof AccountEncryptionModeResponseSchema>;

export const AccountEncryptionCurrentnessResponseSchema = z.object({
  mode: AccountEncryptionModeSchema,
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  signingKeyFingerprint: z.string().min(1).max(256).nullable(),
  contentKeyFingerprint: z.string().min(1).max(256).nullable(),
  updatedAt: z.number().int().min(0),
}).strict();

export type AccountEncryptionCurrentnessResponse = z.infer<
  typeof AccountEncryptionCurrentnessResponseSchema
>;

export const AccountEncryptionModeUpdateRequestSchema = z.object({
  mode: AccountEncryptionModeSchema,
}).strict();

export type AccountEncryptionModeUpdateRequest = z.infer<typeof AccountEncryptionModeUpdateRequestSchema>;
