import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

export const SessionStateAttentionValueSchema = lazyZodSchema(() => z.strictObject({
    observedProgressToken: z.optional(z.string().check(z.minLength(1))),
    viewedProgressToken: z.optional(z.string().check(z.minLength(1))),
    observedAtMs: z.optional(z.number().check(z.int(), z.minimum(0))),
    viewedAtMs: z.optional(z.number().check(z.int(), z.minimum(0))),
  }));
