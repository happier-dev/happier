import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const ReviewQuestionStatusSchema = lazyZodSchema(() => z.enum([
  'open',
  'answered',
  'superseded',
]));
export type ReviewQuestionStatus = z.infer<typeof ReviewQuestionStatusSchema>;

export const ReviewQuestionSchema = lazyZodSchema(() => z.looseObject({
  id: z.string().check(z.minLength(1)),
  text: z.string().check(z.minLength(1)),
  findingIds: z.optional(z.array(z.string().check(z.minLength(1)))),
  status: ReviewQuestionStatusSchema,
}));
export type ReviewQuestion = z.infer<typeof ReviewQuestionSchema>;
