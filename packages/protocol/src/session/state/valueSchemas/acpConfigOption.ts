import { z } from 'zod';

export const SessionStateAcpConfigOptionValueSchema = z
  .object({
    v: z.literal(1),
    configId: z.string().trim().min(1),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    updatedAt: z.number().finite(),
  })
  .strict();
