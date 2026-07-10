import { z } from 'zod';

import { ProviderConnectionIdSchema, ProviderContributionKeySchema } from '../ids.js';

export const ProviderConnectionTombstoneV1Schema = z.object({
  v: z.literal(1),
  id: ProviderConnectionIdSchema,
  contributionKey: ProviderContributionKeySchema.nullable(),
  lastDisplayName: z.string().trim().min(1).max(128),
  deletedAt: z.number().finite().nonnegative(),
}).strict();
export type ProviderConnectionTombstoneV1 = z.infer<typeof ProviderConnectionTombstoneV1Schema>;
