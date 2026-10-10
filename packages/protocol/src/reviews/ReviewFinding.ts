import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { ReviewFindingSeveritySchema, ReviewFindingCategorySchema } from './reviewFindingClassification.js';
import { ReviewCommentScopeV1Schema, ReviewCommentStateV1Schema, validateReviewCommentScopeV1 } from './comments/v1.js';
export { ReviewFindingSeveritySchema, ReviewFindingCategorySchema, type ReviewFindingSeverity, type ReviewFindingCategory } from './reviewFindingClassification.js';

export const ReviewFindingCommentReferenceV1Schema = lazyZodSchema(() => z.object({
  id: z.string().min(1),
  state: ReviewCommentStateV1Schema,
  serverRevision: z.number().int().positive(),
  ...ReviewCommentScopeV1Schema.shape,
  sessionId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
}).strict().superRefine(validateReviewCommentScopeV1));

export const ReviewFindingSchema = lazyZodSchema(() => z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  severity: ReviewFindingSeveritySchema,
  category: ReviewFindingCategorySchema,
  filePath: z.string().min(1).optional(),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  summary: z.string().min(1),
  whyItMatters: z.string().min(1).optional(),
  evidence: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  suggestion: z.string().min(1).optional(),
  patch: z.string().min(1).optional(),
  comment: ReviewFindingCommentReferenceV1Schema.optional(),
  attributionConfidence: z.string().min(1).optional(),
}).passthrough());

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type ReviewFindingId = string;
