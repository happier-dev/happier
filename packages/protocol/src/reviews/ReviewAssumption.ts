import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const ReviewAssumptionSchema = lazyZodSchema(() => z.looseObject({
  id: z.string().check(z.minLength(1)),
  text: z.string().check(z.minLength(1)),
  findingIds: z.optional(z.array(z.string().check(z.minLength(1)))),
}));
export type ReviewAssumption = z.infer<typeof ReviewAssumptionSchema>;
