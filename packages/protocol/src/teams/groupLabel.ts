import { PrivateLabelReadV1Schema } from '../crypto/privateLabelV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

/** One recipient-safe Team Group label projection, reused by every Group reader. */
export const TeamGroupNameProjectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('available'), label: PrivateLabelReadV1Schema }),
  z.strictObject({ kind: z.literal('unavailable') }),
]));
export type TeamGroupNameProjectionV1 = z.infer<typeof TeamGroupNameProjectionV1Schema>;
