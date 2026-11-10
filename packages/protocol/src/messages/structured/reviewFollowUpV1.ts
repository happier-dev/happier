import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { ReviewAssumptionSchema } from '../../reviews/ReviewAssumption.js';
import { ReviewFindingSchema } from '../../reviews/ReviewFinding.js';
import { ReviewQuestionSchema } from '../../reviews/ReviewQuestion.js';
import { ExecutionRunStructuredRunRefSchema } from './executionRunStructuredRunRef.js';

export const ReviewFollowUpV1Schema = lazyZodSchema(() => z.looseObject({
  parentRunRef: ExecutionRunStructuredRunRefSchema,
  threadId: z.string().check(z.minLength(1)),
  findingIds: z.optional(z.array(z.string().check(z.minLength(1)))),
  replyToQuestionId: z.optional(z.string().check(z.minLength(1))),
  requestMarkdown: z.string().check(z.minLength(1)),
  answerMarkdown: z.string().check(z.minLength(1)),
  updatedFindings: z.optional(z.array(ReviewFindingSchema)),
  questions: z.optional(z.array(ReviewQuestionSchema)),
  assumptions: z.optional(z.array(ReviewAssumptionSchema)),
  generatedAtMs: z.number().check(z.int(), z.nonnegative()),
}));

export type ReviewFollowUpV1 = z.infer<typeof ReviewFollowUpV1Schema>;

export function parseReviewFollowUpV1(payload: unknown): ReviewFollowUpV1 | null {
  const parsed = ReviewFollowUpV1Schema.safeParse(payload);
  if (!parsed.success) return null;
  return parsed.data;
}
