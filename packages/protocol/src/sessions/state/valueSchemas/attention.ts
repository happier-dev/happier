import { z } from 'zod';

export const SessionStateAttentionValueSchema = z
  .object({
    observedProgressToken: z.string().min(1).optional(),
    viewedProgressToken: z.string().min(1).optional(),
    observedAtMs: z.number().int().min(0).optional(),
    viewedAtMs: z.number().int().min(0).optional(),
  })
  .strict();
