import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { ReviewFindingSchema } from '../../reviews/ReviewFinding.js';
import { ExecutionRunStructuredRunRefSchema } from './executionRunStructuredRunRef.js';

import { ReviewTriageStatusSchema } from '../../reviews/reviewTriageStatus.js';
export { ReviewTriageStatusSchema, type ReviewTriageStatus } from '../../reviews/reviewTriageStatus.js';

export const ReviewTriageOverlaySchema = lazyZodSchema(() => z.looseObject({
  findings: z.array(z.looseObject({
    id: z.string().check(z.minLength(1)),
    commentId: z.optional(z.string().check(z.minLength(1))),
    status: ReviewTriageStatusSchema,
    comment: z.optional(z.string().check(z.minLength(1))),
  })),
}));
export type ReviewTriageOverlay = z.infer<typeof ReviewTriageOverlaySchema>;

export const ReviewFindingsV1Schema = lazyZodSchema(() => z.looseObject({
  runRef: ExecutionRunStructuredRunRefSchema,
  summary: z.string().check(z.minLength(1)),
  findings: z.array(ReviewFindingSchema),
  triage: z.optional(ReviewTriageOverlaySchema),
  limits: z.optional(z.looseObject({
    findingsTruncated: z.optional(z.boolean()),
    patchesTruncated: z.optional(z.boolean()),
  })),
  generatedAtMs: z.number().check(z.int(), z.nonnegative()),
}));

export type ReviewFindingsV1 = z.infer<typeof ReviewFindingsV1Schema>;

export function parseReviewFindingsV1(payload: unknown): ReviewFindingsV1 | null {
  const parsed = ReviewFindingsV1Schema.safeParse(payload);
  if (!parsed.success) return null;
  return parsed.data;
}
