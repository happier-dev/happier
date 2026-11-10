import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

export const SessionStateReadStateValueSchema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    sessionSeq: z.number().check(z.int(), z.minimum(0)),
    pendingActivityAt: z.number().check(z.minimum(0)),
    updatedAt: z.number().check(z.minimum(0)),
  }));
