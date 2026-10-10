import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { ScmDiffSummaryRefineInputSchema } from '../scm/diffSummaryResult.js';
import { ReviewLaunchFailureSchema } from './reviewLaunchFailure.js';
import { ScmComparisonSchema } from '../scm/comparison.js';
import { ScmReviewFindingIdentitySchema } from '../scm/diffSummary.js';
export { ReviewLaunchFailureSchema, type ReviewLaunchFailure } from './reviewLaunchFailure.js';

// New routing/selection envelopes are closed; the existing review-start custodian
// retains its additive engine configuration independently.
export const ReviewNarratorSelectionSchema = lazyZodSchema(() => z.object({
  engineId: z.string().trim().min(1),
  modelId: z.string().trim().min(1).optional(),
}).strict());
export type ReviewNarratorSelection = z.infer<typeof ReviewNarratorSelectionSchema>;

export const ReviewWalkthroughObservationSchema = lazyZodSchema(() => z.object({
  kind: z.literal('review_walkthrough'),
  comparisonId: z.string().min(1),
  resultId: z.string().min(1).optional(),
  afterRevision: z.number().int().nonnegative().optional(),
}).strict());
export type ReviewWalkthroughObservation = z.infer<typeof ReviewWalkthroughObservationSchema>;

export const ReviewFindingIdentitySchema = ScmReviewFindingIdentitySchema;
export type ReviewFindingIdentity = z.infer<typeof ReviewFindingIdentitySchema>;

export const ReviewWalkthroughRequestSchema = lazyZodSchema(() => z.object({
  reviewRunIds: z.array(z.string().min(1)).min(1),
  comparisonId: z.string().min(1),
  narrator: ReviewNarratorSelectionSchema.optional(),
  launchFailures: z.array(ReviewLaunchFailureSchema).optional(),
}).strict());
export type ReviewWalkthroughRequest = z.infer<typeof ReviewWalkthroughRequestSchema>;

export const ReviewWalkthroughInputSchema = lazyZodSchema(() => ReviewWalkthroughRequestSchema.omit({ reviewRunIds: true, launchFailures: true }).extend({
  sessionId: z.string().min(1).optional(),
  runId: z.string().min(1),
  reviewRunIds: z.array(z.string().min(1)).min(1).optional(),
}).strict());
export type ReviewWalkthroughInput = z.infer<typeof ReviewWalkthroughInputSchema>;

/** The host-owned code basis a finished review's walkthrough actually reads. */
export const ReviewWalkthroughResponseSchema = lazyZodSchema(() => z.object({
  runId: z.string().min(1),
  callId: z.string().min(1),
  sidechainId: z.string().min(1),
  mode: z.enum(['continued_review', 'seeded_narrator']),
  state: z.enum(['writing', 'collecting']),
  comparisonId: z.string().min(1),
  comparison: ScmComparisonSchema,
  reviewRunIds: z.array(z.string().min(1)).min(1),
  observation: ReviewWalkthroughObservationSchema.optional(),
}).strict().refine((value) => value.comparison.id === value.comparisonId, {
  path: ['comparisonId'], message: 'Walkthrough must identify its captured comparison',
}));
export type ReviewWalkthroughResponse = z.infer<typeof ReviewWalkthroughResponseSchema>;

export const ReviewExplainFindingsRequestSchema = lazyZodSchema(() => z.object({
  reviewRunIds: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1),
  resultId: z.string().min(1),
  expectedRevision: z.number().int().min(0),
  findingIds: z.array(ReviewFindingIdentitySchema).min(1),
  instructions: z.string().trim().min(1).optional(),
}).strict());
export type ReviewExplainFindingsRequest = z.infer<typeof ReviewExplainFindingsRequestSchema>;

export const ReviewExplainFindingsInputSchema = lazyZodSchema(() => ReviewExplainFindingsRequestSchema.omit({ reviewRunIds: true }).extend({
  sessionId: z.string().min(1).optional(),
  runId: z.string().min(1),
  reviewRunIds: z.array(z.string().min(1)).min(1).optional(),
}).strict());
export type ReviewExplainFindingsInput = z.infer<typeof ReviewExplainFindingsInputSchema>;

/** Host-verified targeting, consumed through the existing canonical refinement Action. */
export const ReviewExplainFindingsRefinementSchema = lazyZodSchema(() => z.object({
  refinement: z.object({
    actionId: z.literal('scm.diffSummary.refine'),
    input: ScmDiffSummaryRefineInputSchema.refine((input) => input.output === 'walkthrough'),
  }).strict(),
}).strict());
