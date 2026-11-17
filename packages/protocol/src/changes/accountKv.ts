import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** Committed Account KV hints name addresses; values stay behind the mode-aware reader. */
export const AccountKvChangeHintV1Schema = lazyZodSchema(() => z.union([
    z.strictObject({ keys: z.array(z.string()) }),
    z.strictObject({ full: z.literal(true) }),
]));
export type AccountKvChangeHintV1 = z.infer<typeof AccountKvChangeHintV1Schema>;
