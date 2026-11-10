import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

export const SessionStateAcpConfigOptionValueSchema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    configId: z.string().check(z.trim(), z.minLength(1)),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    updatedAt: z.number(),
  }));
