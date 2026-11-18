import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { SessionRuntimeIssueV1Schema } from '../sessions/control/runtimeIssueV1.js';

/** Host receipts from the existing review comment publication owner. */
export const ReviewPublicationMaterializationSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('complete') }),
  z.strictObject({ kind: z.literal('partial'), errorCode: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('failed'), errorCode: z.string().check(z.minLength(1)) }),
]));
export type ReviewPublicationMaterialization = z.infer<typeof ReviewPublicationMaterializationSchema>;

/** Project receipts from a larger host-published result; absence is not success. */
export const ReviewPublicationEvidenceSchema = lazyZodSchema(() => z.object({
  reviewedFingerprint: z.optional(z.nullable(z.string())),
  commentIds: z.optional(z.array(z.string().check(z.minLength(1)))),
  materialization: z.optional(ReviewPublicationMaterializationSchema),
  reviewOutcome: ReviewReviewerOutcomeV1Schema.shape.reviewOutcome,
}));
export type ReviewPublicationEvidence = z.infer<typeof ReviewPublicationEvidenceSchema>;

/** Host-observed execution and publication evidence for one admitted selection. */
export const ReviewReviewerOutcomeV1Schema = lazyZodSchema(() => z.strictObject({
  key: z.string().check(z.minLength(1)), runId: z.optional(z.string().check(z.minLength(1))),
  outcome: z.enum(['completed', 'failed', 'cancelled', 'launch_failed']),
  reviewOutcome: z.optional(z.enum(['complete', 'partial', 'failed', 'unavailable'])),
  runtimeIssueV1: z.optional(SessionRuntimeIssueV1Schema),
  errorCode: z.optional(z.string().check(z.minLength(1))), materialization: z.optional(ReviewPublicationMaterializationSchema),
}));
export type ReviewReviewerOutcomeV1 = z.infer<typeof ReviewReviewerOutcomeV1Schema>;

/** Empty findings are complete only when every admitted executable reviewer published successfully. */
export function projectReviewRoundOutcomeV1(
  reviewerIds: readonly string[], outcomes: readonly ReviewReviewerOutcomeV1[],
): 'completed' | 'partial' | 'failed' {
  const byReviewer = new Map<string, ReviewReviewerOutcomeV1[]>();
  for (const outcome of outcomes) {
    const selected = byReviewer.get(outcome.key);
    if (selected) selected.push(outcome);
    else byReviewer.set(outcome.key, [outcome]);
  }
  const coverage = reviewerIds.map(key => {
    const selected = byReviewer.get(key);
    if (!selected) return 'failed';
    const states = selected.map(outcome => {
      if (outcome.outcome !== 'completed' || outcome.reviewOutcome === 'failed' || outcome.reviewOutcome === 'unavailable'
        || !outcome.materialization || outcome.materialization.kind === 'failed') return 'failed';
      return outcome.reviewOutcome === 'partial' || outcome.materialization.kind === 'partial' ? 'partial' : 'complete';
    });
    return states.every(state => state === 'complete') ? 'complete'
      : states.some(state => state !== 'failed') ? 'partial' : 'failed';
  });
  return coverage.every(state => state === 'complete') ? 'completed'
    : coverage.some(state => state !== 'failed') ? 'partial' : 'failed';
}
