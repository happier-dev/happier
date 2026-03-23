import { z } from 'zod';

import { ReviewAssumptionSchema } from '../reviews/ReviewAssumption.js';
import { ReviewFindingSchema } from '../reviews/ReviewFinding.js';
import { ReviewQuestionSchema } from '../reviews/ReviewQuestion.js';
import { ReviewTriageOverlaySchema } from './reviewFindingsV1.js';
import { ExecutionRunStructuredRunRefSchema } from './executionRunStructuredRunRef.js';

export const ReviewPublicationOverlaySchema = z.object({
  findings: z.array(z.object({
    id: z.string().min(1),
    published: z.boolean(),
    publishedAtMs: z.number().int().nonnegative().optional(),
    publishedMessageRef: z.string().min(1).optional(),
  }).passthrough()),
}).passthrough();
export type ReviewPublicationOverlay = z.infer<typeof ReviewPublicationOverlaySchema>;

export const ReviewFindingsV2Schema = z.object({
  runRef: ExecutionRunStructuredRunRefSchema,
  summary: z.string().min(1),
  overviewMarkdown: z.string().min(1),
  findings: z.array(ReviewFindingSchema),
  questions: z.array(ReviewQuestionSchema).default([]),
  assumptions: z.array(ReviewAssumptionSchema).default([]),
  triage: ReviewTriageOverlaySchema.optional(),
  publication: ReviewPublicationOverlaySchema.optional(),
  limits: z.object({
    findingsTruncated: z.boolean().optional(),
    patchesTruncated: z.boolean().optional(),
  }).passthrough().optional(),
  generatedAtMs: z.number().int().nonnegative(),
}).passthrough();

export type ReviewFindingsV2 = z.infer<typeof ReviewFindingsV2Schema>;

export function parseReviewFindingsV2(payload: unknown): ReviewFindingsV2 | null {
  const parsed = ReviewFindingsV2Schema.safeParse(payload);
  if (!parsed.success) return null;
  return parsed.data;
}
