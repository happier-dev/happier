import { z } from 'zod';

import { ReviewAssumptionSchema } from '../../reviews/ReviewAssumption.js';
import { ReviewFindingSchema } from '../../reviews/ReviewFinding.js';
import { ReviewQuestionSchema } from '../../reviews/ReviewQuestion.js';
import { ExecutionRunStructuredRunRefSchema } from './executionRunStructuredRunRef.js';

export const ReviewFollowUpV1Schema = z.object({
  parentRunRef: ExecutionRunStructuredRunRefSchema,
  threadId: z.string().min(1),
  findingIds: z.array(z.string().min(1)).optional(),
  replyToQuestionId: z.string().min(1).optional(),
  requestMarkdown: z.string().min(1),
  answerMarkdown: z.string().min(1),
  updatedFindings: z.array(ReviewFindingSchema).optional(),
  questions: z.array(ReviewQuestionSchema).optional(),
  assumptions: z.array(ReviewAssumptionSchema).optional(),
  generatedAtMs: z.number().int().nonnegative(),
}).passthrough();

export type ReviewFollowUpV1 = z.infer<typeof ReviewFollowUpV1Schema>;

export function parseReviewFollowUpV1(payload: unknown): ReviewFollowUpV1 | null {
  const parsed = ReviewFollowUpV1Schema.safeParse(payload);
  if (!parsed.success) return null;
  return parsed.data;
}
