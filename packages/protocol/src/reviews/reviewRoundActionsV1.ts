import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { ScmComparisonSchema } from '../scm/comparison.js';
import { ScmComparisonCaptureInputSchema } from '../scm/diffSummary.js';
import { ReviewRoundBindingV1Schema } from './reviewArtifactV1.js';
import { ReviewStartInputSchema } from './reviewStart.js';
import { ExecutionRunStartResponseSchema } from '../execution/runs/responseSchemas.js';
import { WorkflowRunStartResultV1Schema } from '../workflows/actionsV1.js';

/** The first workflow stage consumes initial admission or prepares the next pass. */
export const ReviewPrepareRoundInputV1Schema = lazyZodSchema(() => z.strictObject({
  reviewRound: ReviewRoundBindingV1Schema,
  reviewInput: ReviewStartInputSchema,
  comparison: z.optional(ScmComparisonSchema),
  comparisonCapture: z.optional(ScmComparisonCaptureInputSchema),
  previousRoundContext: z.optional(StrictJsonValueSchema),
}));
export type ReviewPrepareRoundInputV1 = z.infer<typeof ReviewPrepareRoundInputV1Schema>;

/** Actual admitted binding and captured evidence, shared by every leaf in this pass. */
export const ReviewPreparedRoundV1Schema = lazyZodSchema(() => z.strictObject({
  reviewRound: ReviewRoundBindingV1Schema,
  comparisonId: z.optional(z.string().check(z.minLength(1))),
  comparison: z.optional(ScmComparisonSchema),
}));
export type ReviewPreparedRoundV1 = z.infer<typeof ReviewPreparedRoundV1Schema>;

/** Paired with the prepared-round value in a Session leaf's retained input. */
export const ReviewSessionInputV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('review_session.v1'),
  reviewerId: z.string().check(z.minLength(1)),
}));

export const ReviewSettleRoundInputV1Schema = lazyZodSchema(() => z.strictObject({
  reviewRound: ReviewRoundBindingV1Schema,
  reviewerResults: z.array(StrictJsonValueSchema),
}));
export type ReviewSettleRoundInputV1 = z.infer<typeof ReviewSettleRoundInputV1Schema>;

/** A fresh native retry is always an explicit choice after unavailable continuation. */
export const ReviewNativeNewRoundInputV1Schema = lazyZodSchema(() => z.strictObject({
  fresh: z.optional(z.boolean()),
}));

/** Explicit native routing preserves the existing workflow Run-id replay contract. */
export const ReviewNewRoundInputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ runId: z.string().check(z.minLength(1)) }),
  z.strictObject({ runId: z.string().check(z.minLength(1)), sessionId: z.string().check(z.minLength(1)),
    ...ReviewNativeNewRoundInputV1Schema.shape }),
  z.strictObject({ runId: z.string().check(z.minLength(1)), target: z.strictObject({ kind: z.literal('detached') }),
    ...ReviewNativeNewRoundInputV1Schema.shape }),
]));

export const ReviewNativeNewRoundResultV1Schema = lazyZodSchema(() => z.looseObject({
  ...ExecutionRunStartResponseSchema.shape,
  reviewRound: ReviewRoundBindingV1Schema,
  comparisonId: z.optional(z.string().check(z.minLength(1))),
}));

export const ReviewNewRoundResultV1Schema = lazyZodSchema(() => z.union([
  WorkflowRunStartResultV1Schema,
  ReviewNativeNewRoundResultV1Schema,
]));
