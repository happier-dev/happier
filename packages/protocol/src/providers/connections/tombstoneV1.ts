import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { ProviderConnectionIdSchema, ProviderContributionKeySchema } from '../ids.js';

export const ProviderConnectionTombstoneV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  id: ProviderConnectionIdSchema,
  contributionKey: z.nullable(ProviderContributionKeySchema),
  lastDisplayName: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  deletedAt: z.number().check(z.nonnegative()),
}));
export type ProviderConnectionTombstoneV1 = z.infer<typeof ProviderConnectionTombstoneV1Schema>;
