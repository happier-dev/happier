import { z } from 'zod';

import { AccountSettingsSchema } from './accountSettings.js';

export const AccountSettingsStoredContentEnvelopeSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('plain'),
    v: AccountSettingsSchema,
  }),
  z.object({
    t: z.literal('encrypted'),
    c: z.string().min(1),
  }),
]);

export type AccountSettingsStoredContentEnvelope = z.infer<typeof AccountSettingsStoredContentEnvelopeSchema>;

