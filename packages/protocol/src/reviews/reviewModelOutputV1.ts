import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { ReviewFindingsV2Schema } from '../messages/structured/reviewFindingsV2.js';
import { ReviewModelFindingSchema } from './ReviewFinding.js';
import { ReviewQuestionSchema } from './ReviewQuestion.js';
import { ReviewAssumptionSchema } from './ReviewAssumption.js';

/** Model-authored initial review content, shared by native and Session reviewers. */
export const ReviewModelOutputV1Schema = lazyZodSchema(() => z.strictObject({
  ...z.pick(ReviewFindingsV2Schema, { reviewOutcome: true, summary: true, overviewMarkdown: true }).shape,
  reviewOutcome: z.nonoptional(ReviewFindingsV2Schema.shape.reviewOutcome),
  findings: z.array(ReviewModelFindingSchema),
  questions: z.array(z.strictObject(ReviewQuestionSchema.shape)),
  assumptions: z.array(z.strictObject(ReviewAssumptionSchema.shape)),
}));

export type ReviewModelOutputV1 = z.infer<typeof ReviewModelOutputV1Schema>;
