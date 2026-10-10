import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';

export const SessionStateReadStateValueSchema = lazyZodSchema(() => z
  .object({
    v: z.literal(1),
    sessionSeq: z.number().int().min(0),
    pendingActivityAt: z.number().finite().min(0),
    updatedAt: z.number().finite().min(0),
  })
  .strict());
