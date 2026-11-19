import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { ReviewAssumptionSchema } from '../../reviews/ReviewAssumption.js';
import { ReviewFindingSchema } from '../../reviews/ReviewFinding.js';
import { ReviewQuestionSchema } from '../../reviews/ReviewQuestion.js';
import { ReviewQualityV1Schema } from '../../reviews/reviewPublicationEvidence.js';
import { ReviewTriageOverlaySchema } from './reviewFindingsV1.js';
import { ExecutionRunStructuredRunRefSchema } from './executionRunStructuredRunRef.js';
import { ReviewCommentProposalsV1Schema } from '../../reviews/comments/proposals.js';

export const ReviewPublicationOverlaySchema = lazyZodSchema(() => z.looseObject({
  findings: z.array(z.looseObject({
    id: z.string().check(z.minLength(1)),
    published: z.boolean(),
    publishedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
    publishedMessageRef: z.optional(z.string().check(z.minLength(1))),
  })),
}));
export type ReviewPublicationOverlay = z.infer<typeof ReviewPublicationOverlaySchema>;

export const ReviewFindingsV2Schema = lazyZodSchema(() => z.looseObject({
  runRef: ExecutionRunStructuredRunRefSchema,
  comparisonId: z.optional(z.string().check(z.minLength(1))),
  /** Number of files in the host's verified captured comparison inventory, when known. */
  fileCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  reviewOutcome: z.optional(z.enum(['complete', 'partial', 'failed'])),
  quality: z.optional(ReviewQualityV1Schema),
  summary: z.string().check(z.minLength(1)),
  overviewMarkdown: z.string().check(z.minLength(1)),
  findings: z.array(ReviewFindingSchema),
  questions: z._default(z.array(ReviewQuestionSchema), []),
  assumptions: z._default(z.array(ReviewAssumptionSchema), []),
  proposedComments: z.optional(ReviewCommentProposalsV1Schema),
  triage: z.optional(ReviewTriageOverlaySchema),
  publication: z.optional(ReviewPublicationOverlaySchema),
  limits: z.optional(z.looseObject({
    findingsTruncated: z.optional(z.boolean()),
    patchesTruncated: z.optional(z.boolean()),
  })),
  generatedAtMs: z.number().check(z.int(), z.nonnegative()),
}));

export type ReviewFindingsV2 = z.infer<typeof ReviewFindingsV2Schema>;

export function parseReviewFindingsV2(payload: unknown): ReviewFindingsV2 | null {
  const parsed = ReviewFindingsV2Schema.safeParse(payload);
  if (!parsed.success) return null;
  return parsed.data;
}
