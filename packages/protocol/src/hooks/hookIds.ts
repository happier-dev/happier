import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const HookIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
export type HookIdV1 = z.infer<typeof HookIdV1Schema>;
