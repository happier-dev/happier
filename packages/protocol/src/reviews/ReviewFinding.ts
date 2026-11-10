import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { ReviewFindingSeveritySchema, ReviewFindingCategorySchema } from './reviewFindingClassification.js';
import { ReviewCommentScopeV1Schema, ReviewCommentStateV1Schema, validateReviewCommentScopeV1 } from './comments/v1.js';
export { ReviewFindingSeveritySchema, ReviewFindingCategorySchema, type ReviewFindingSeverity, type ReviewFindingCategory } from './reviewFindingClassification.js';

export const ReviewFindingCommentReferenceV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)),
  state: ReviewCommentStateV1Schema,
  serverRevision: z.number().check(z.int(), z.positive()),
  ...ReviewCommentScopeV1Schema.shape,
  sessionId: z.optional(z.string().check(z.minLength(1))),
  runId: z.optional(z.string().check(z.minLength(1))),
}).check(z.superRefine(validateReviewCommentScopeV1)));

export const ReviewFindingSchema = lazyZodSchema(() => z.looseObject({
  id: z.string().check(z.minLength(1)),
  title: z.string().check(z.minLength(1)),
  severity: ReviewFindingSeveritySchema,
  category: ReviewFindingCategorySchema,
  filePath: z.optional(z.string().check(z.minLength(1))),
  startLine: z.optional(z.number().check(z.int(), z.minimum(1))),
  endLine: z.optional(z.number().check(z.int(), z.minimum(1))),
  summary: z.string().check(z.minLength(1)),
  whyItMatters: z.optional(z.string().check(z.minLength(1))),
  evidence: z.optional(z.string().check(z.minLength(1))),
  confidence: z.optional(z.number().check(z.minimum(0), z.maximum(1))),
  suggestion: z.optional(z.string().check(z.minLength(1))),
  patch: z.optional(z.string().check(z.minLength(1))),
  comment: z.optional(ReviewFindingCommentReferenceV1Schema),
  attributionConfidence: z.optional(z.string().check(z.minLength(1))),
}));

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type ReviewFindingId = string;
