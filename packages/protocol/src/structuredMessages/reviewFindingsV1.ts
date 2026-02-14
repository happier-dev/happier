import { z } from 'zod';

import { ReviewFindingSchema } from '../reviews/ReviewFinding.js';

export const ReviewTriageStatusSchema = z.enum([
  'accept',
  'reject',
  'defer',
  'needs_refinement',
]);
export type ReviewTriageStatus = z.infer<typeof ReviewTriageStatusSchema>;

export const ReviewTriageOverlaySchema = z.object({
  findings: z.array(z.object({
    id: z.string().min(1),
    status: ReviewTriageStatusSchema,
    comment: z.string().min(1).optional(),
  }).passthrough()),
}).passthrough();
export type ReviewTriageOverlay = z.infer<typeof ReviewTriageOverlaySchema>;

export const ReviewFindingsV1Schema = z.object({
  runRef: z.object({
    runId: z.string().min(1),
    callId: z.string().min(1),
    backendId: z.string().min(1),
  }).passthrough(),
  summary: z.string().min(1),
  findings: z.array(ReviewFindingSchema),
  triage: ReviewTriageOverlaySchema.optional(),
  limits: z.object({
    findingsTruncated: z.boolean().optional(),
    patchesTruncated: z.boolean().optional(),
  }).passthrough().optional(),
  generatedAtMs: z.number().int().nonnegative(),
}).passthrough();

export type ReviewFindingsV1 = z.infer<typeof ReviewFindingsV1Schema>;

export function parseReviewFindingsV1(payload: unknown): ReviewFindingsV1 | null {
  const parsed = ReviewFindingsV1Schema.safeParse(payload);
  if (!parsed.success) return null;
  return parsed.data;
}

