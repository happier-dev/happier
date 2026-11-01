import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const ReviewAssumptionSchema = lazySchema(() => z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  findingIds: z.array(z.string().min(1)).optional(),
}).passthrough());
export type ReviewAssumption = z.infer<typeof ReviewAssumptionSchema>;
