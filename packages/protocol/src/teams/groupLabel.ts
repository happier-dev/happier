import { PrivateLabelReadV1Schema } from '../crypto/privateLabelV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

/** One recipient-safe Team Group label projection, reused by every Group reader. */
export const TeamGroupLabelProjectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('available'), label: PrivateLabelReadV1Schema }),
  z.strictObject({ kind: z.literal('unavailable') }),
]));
export type TeamGroupLabelProjectionV1 = z.infer<typeof TeamGroupLabelProjectionV1Schema>;

/** Existing Group-name consumers share the same label projection owner. */
export const TeamGroupNameProjectionV1Schema = TeamGroupLabelProjectionV1Schema;
export type TeamGroupNameProjectionV1 = TeamGroupLabelProjectionV1;
