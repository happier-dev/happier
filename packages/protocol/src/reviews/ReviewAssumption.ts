import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

export const ReviewAssumptionSchema = lazyZodSchema(() => z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  findingIds: z.array(z.string().min(1)).optional(),
}).passthrough());
export type ReviewAssumption = z.infer<typeof ReviewAssumptionSchema>;
