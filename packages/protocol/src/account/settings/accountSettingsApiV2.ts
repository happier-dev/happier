import { z } from 'zod';

import { AccountSettingsStoredContentEnvelopeSchema } from './accountSettingsStoredContentEnvelope.js';
import { lazySchema } from '../../lazySchema.js';

export const AccountSettingsV2GetResponseSchema = lazySchema(() => z
  .object({
    content: AccountSettingsStoredContentEnvelopeSchema.nullable(),
    version: z.number().int().min(0),
  })
  .strict());

export type AccountSettingsV2GetResponse = z.infer<typeof AccountSettingsV2GetResponseSchema>;

export const AccountSettingsV2UpdateRequestSchema = lazySchema(() => z
  .object({
    content: AccountSettingsStoredContentEnvelopeSchema.nullable(),
    expectedVersion: z.number().int().min(0),
  })
  .strict());

export type AccountSettingsV2UpdateRequest = z.infer<typeof AccountSettingsV2UpdateRequestSchema>;

export const AccountSettingsV2UpdateResponseSchema = lazySchema(() => z.union([
  z.object({
    success: z.literal(true),
    version: z.number().int().min(0),
  }),
  z.object({
    success: z.literal(false),
    error: z.literal('version-mismatch'),
    currentVersion: z.number().int().min(0),
    currentContent: AccountSettingsStoredContentEnvelopeSchema.nullable(),
  }),
]));

export type AccountSettingsV2UpdateResponse = z.infer<typeof AccountSettingsV2UpdateResponseSchema>;

