import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

/** Presentation only: storage and Action inputs retain milliseconds or a ratio. */
export const SettingNumberDisplayV1Schema = lazyZodSchema(() => z.discriminatedUnion('unit', [
  z.strictObject({ unit: z.literal('s'), divisor: z.literal(1000) }),
  z.strictObject({ unit: z.literal('%'), divisor: z.literal(0.01) }),
]));

export type SettingNumberDisplayV1 = z.infer<typeof SettingNumberDisplayV1Schema>;
