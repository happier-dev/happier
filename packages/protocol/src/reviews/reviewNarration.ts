import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { ScmDiffSummaryRefineInputSchema } from '../scm/diffSummaryResult.js';
import { ReviewLaunchFailureSchema } from './reviewLaunchFailure.js';
import { ScmComparisonSchema } from '../scm/comparison.js';
import {
  ScmReviewFindingIdentitySchema,
  ScmDiffSummaryOutputKindSchema,
} from '../scm/diffSummary.js';
export {
  ReviewLaunchFailureSchema,
  type ReviewLaunchFailure,
} from './reviewLaunchFailure.js';

// New routing/selection envelopes are closed; the existing review-start custodian
// retains its additive engine configuration independently.
export const ReviewNarratorSelectionSchema = lazyZodSchema(() =>
  z.strictObject({
    engineId: z.string().check(z.trim(), z.minLength(1)),
    modelId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }),
);
export type ReviewNarratorSelection = z.infer<
  typeof ReviewNarratorSelectionSchema
>;

export const ReviewWalkthroughObservationSchema = lazyZodSchema(() =>
  z.strictObject({
    kind: z.literal('review_walkthrough'),
    comparisonId: z.string().check(z.minLength(1)),
    resultId: z.optional(z.string().check(z.minLength(1))),
    afterRevision: z.optional(z.number().check(z.int(), z.nonnegative())),
  }),
);
export type ReviewWalkthroughObservation = z.infer<
  typeof ReviewWalkthroughObservationSchema
>;

/** Exact structured-output observation shared by retained review and SCM generators. */
export const ExecutionRunOutputObservationSchema = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [
    ReviewWalkthroughObservationSchema,
    (<T extends z.ZodMiniObject>(schema: T) =>
      z.core.clone(schema, {
        ...schema._zod.def,
        catchall: z.never(),
      }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(
      z.extend(ReviewWalkthroughObservationSchema, {
        kind: z.literal('scm_diff_summary'),
        output: ScmDiffSummaryOutputKindSchema,
      }),
    ),
  ]),
);
export type ExecutionRunOutputObservation = z.infer<
  typeof ExecutionRunOutputObservationSchema
>;

/** Exact saved output identity; an observation revision is separate from identity. */
export const ExecutionRunOutputRefV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('review_walkthrough'), comparisonId: z.string().check(z.minLength(1)),
    resultId: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('scm_diff_summary'), output: ScmDiffSummaryOutputKindSchema,
    comparisonId: z.string().check(z.minLength(1)), resultId: z.string().check(z.minLength(1)) }),
]));
export type ExecutionRunOutputRefV1 = z.infer<typeof ExecutionRunOutputRefV1Schema>;

// A re-export, not a copied const: this module sits in an import cycle with diffSummary, so it must not read that binding while loading.
export { ScmReviewFindingIdentitySchema as ReviewFindingIdentitySchema } from '../scm/diffSummary.js';
export type ReviewFindingIdentity = z.infer<
  typeof ScmReviewFindingIdentitySchema
>;

export const ReviewWalkthroughRequestSchema = lazyZodSchema(() =>
  z.strictObject({
    reviewRunIds: z
      .array(z.string().check(z.minLength(1)))
      .check(z.minLength(1)),
    comparisonId: z.string().check(z.minLength(1)),
    narrator: z.optional(ReviewNarratorSelectionSchema),
    launchFailures: z.optional(z.array(ReviewLaunchFailureSchema)),
  }),
);
export type ReviewWalkthroughRequest = z.infer<
  typeof ReviewWalkthroughRequestSchema
>;

export const ReviewWalkthroughInputSchema = lazyZodSchema(() =>
  (<T extends z.ZodMiniObject>(schema: T) =>
    z.core.clone(schema, {
      ...schema._zod.def,
      catchall: z.never(),
    }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(
    z.extend(
      z.omit(ReviewWalkthroughRequestSchema, {
        reviewRunIds: true,
        launchFailures: true,
      }),
      {
        sessionId: z.optional(z.string().check(z.minLength(1))),
        target: z.optional(z.strictObject({ kind: z.literal('detached') })),
        runId: z.string().check(z.minLength(1)),
        reviewRunIds: z.optional(
          z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
        ),
      },
    ),
  ).check(
    z.refine((input) => !input.target || input.sessionId === undefined, {
      path: ['target'],
      message: 'A detached review cannot target a Session',
    }),
  ),
);
export type ReviewWalkthroughInput = z.infer<
  typeof ReviewWalkthroughInputSchema
>;

/** The host-owned code basis a finished review's walkthrough actually reads. */
export const ReviewWalkthroughResponseSchema = lazyZodSchema(() =>
  z
    .strictObject({
      runId: z.string().check(z.minLength(1)),
      callId: z.string().check(z.minLength(1)),
      sidechainId: z.string().check(z.minLength(1)),
      mode: z.enum(['continued_review', 'seeded_narrator']),
      state: z.enum(['writing', 'collecting']),
      comparisonId: z.string().check(z.minLength(1)),
      comparison: ScmComparisonSchema,
      reviewRunIds: z
        .array(z.string().check(z.minLength(1)))
        .check(z.minLength(1)),
      observation: z.optional(ReviewWalkthroughObservationSchema),
    })
    .check(
      z.refine((value) => value.comparison.id === value.comparisonId, {
        path: ['comparisonId'],
        message: 'Walkthrough must identify its captured comparison',
      }),
    ),
);
export type ReviewWalkthroughResponse = z.infer<
  typeof ReviewWalkthroughResponseSchema
>;

export const ReviewExplainFindingsRequestSchema = lazyZodSchema(() =>
  z.strictObject({
    reviewRunIds: z
      .array(z.string().check(z.minLength(1)))
      .check(z.minLength(1)),
    cwd: z.string().check(z.minLength(1)),
    resultId: z.string().check(z.minLength(1)),
    expectedRevision: z.number().check(z.int(), z.minimum(0)),
    findingIds: z.array(ScmReviewFindingIdentitySchema).check(z.minLength(1)),
    instructions: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }),
);
export type ReviewExplainFindingsRequest = z.infer<
  typeof ReviewExplainFindingsRequestSchema
>;

export const ReviewExplainFindingsInputSchema = lazyZodSchema(() =>
  (<T extends z.ZodMiniObject>(schema: T) =>
    z.core.clone(schema, {
      ...schema._zod.def,
      catchall: z.never(),
    }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(
    z.extend(
      z.omit(ReviewExplainFindingsRequestSchema, { reviewRunIds: true }),
      {
        sessionId: z.optional(z.string().check(z.minLength(1))),
        target: z.optional(z.strictObject({ kind: z.literal('detached') })),
        runId: z.string().check(z.minLength(1)),
        reviewRunIds: z.optional(
          z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
        ),
      },
    ),
  ).check(
    z.refine((input) => !input.target || input.sessionId === undefined, {
      path: ['target'],
      message: 'A detached review cannot target a Session',
    }),
  ),
);
export type ReviewExplainFindingsInput = z.infer<
  typeof ReviewExplainFindingsInputSchema
>;

/** Host-verified targeting, consumed through the existing canonical refinement Action. */
export const ReviewExplainFindingsRefinementSchema = lazyZodSchema(() =>
  z.strictObject({
    refinement: z.strictObject({
      actionId: z.literal('scm.diffSummary.refine'),
      input: ScmDiffSummaryRefineInputSchema.check(
        z.refine((input) => input.output === 'walkthrough'),
      ),
    }),
  }),
);
