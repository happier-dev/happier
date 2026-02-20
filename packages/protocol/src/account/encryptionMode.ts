import { z } from 'zod';

import { AccountEncryptionModeSchema } from '../features/payload/capabilities/encryptionCapabilities.js';

export const AccountEncryptionModeResponseSchema = z.object({
  mode: AccountEncryptionModeSchema,
  updatedAt: z.number().int().min(0),
}).strict();

export type AccountEncryptionModeResponse = z.infer<typeof AccountEncryptionModeResponseSchema>;

export const AccountEncryptionModeUpdateRequestSchema = z.object({
  mode: AccountEncryptionModeSchema,
}).strict();

export type AccountEncryptionModeUpdateRequest = z.infer<typeof AccountEncryptionModeUpdateRequestSchema>;

