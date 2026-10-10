import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

export const HookIdV1Schema = lazyZodSchema(() => z.string().trim().min(1));
export type HookIdV1 = z.infer<typeof HookIdV1Schema>;
