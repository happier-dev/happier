import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const ReviewQuestionStatusSchema = lazySchema(() => z.enum([
  'open',
  'answered',
  'superseded',
]));
export type ReviewQuestionStatus = z.infer<typeof ReviewQuestionStatusSchema>;

export const ReviewQuestionSchema = lazySchema(() => z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  findingIds: z.array(z.string().min(1)).optional(),
  status: ReviewQuestionStatusSchema,
}).passthrough());
export type ReviewQuestion = z.infer<typeof ReviewQuestionSchema>;
