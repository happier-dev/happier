import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { ScmComparisonSchema } from '../scm/comparison.js';
import { ScmComparisonCaptureInputSchema } from '../scm/diffSummary.js';
import { ReviewRoundBindingV1Schema } from './reviewArtifactV1.js';
import { ReviewStartInputSchema } from './reviewStart.js';
import { ReviewFindingSeveritySchema } from './reviewFindingClassification.js';
import { ExecutionRunStartResponseSchema, type ExecutionRunPublicState } from '../execution/runs/responseSchemas.js';
import { WorkflowRunStartResultV1Schema } from '../workflows/actionsV1.js';
import { ExecutionRunActionResponseSchema } from '../execution/runs/index.js';

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
  newRoundCostConsent: z.optional(z.nullable(z.boolean())),
  inlineThreshold: z.optional(ReviewFindingSeveritySchema),
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

export type ReviewRunContinuityV1 =
  | Readonly<{ ok: true; continuity: 'continues' | 'fresh' }>
  | Readonly<{ ok: false; errorCode: 'review_follow_up_ended' | 'review_follow_up_not_resumable'
    | 'review_follow_up_resume_unavailable'; error: string }>;

/** Continuity from exact host facts; ordinary active-run admission remains with the Run owner. */
export function resolveReviewRunContinuityV1(
  run: Pick<ExecutionRunPublicState, 'status' | 'retentionPolicy' | 'lifecycle'>,
  input: Readonly<{ kind: 'new_round'; fresh?: boolean } | { kind: 'follow_up' }>,
): ReviewRunContinuityV1 {
  const continueRetained = input.kind === 'follow_up'
    || (!input.fresh && run.retentionPolicy === 'resumable');
  if (!continueRetained) return { ok: true, continuity: 'fresh' };
  if (run.status === 'cancelled' || run.status === 'failed' || run.status === 'timeout') {
    return { ok: false, errorCode: 'review_follow_up_ended', error: 'The review ended without a resumable result' };
  }
  if (run.retentionPolicy !== 'resumable') {
    return { ok: false, errorCode: 'review_follow_up_not_resumable', error: 'The review was not retained for follow-up' };
  }
  const state = run.lifecycle?.state;
  if (state !== 'current' && state !== 'recoverable' && state !== 'recoverable_with_input') {
    return { ok: false, errorCode: 'review_follow_up_resume_unavailable', error: 'The retained reviewer session is unavailable' };
  }
  return { ok: true, continuity: 'continues' };
}

/** A fresh native retry is always an explicit choice after unavailable continuation. */
export const ReviewNativeNewRoundInputV1Schema = lazyZodSchema(() => z.strictObject({
  fresh: z.optional(z.boolean()),
  /** Fresh acknowledgement of the paid reviewers displayed for this launch. */
  costConsent: z.optional(z.boolean()),
}));

/** Person-only records and explicit native routing share the existing Workflow replay Action. */
export const ReviewNewRoundInputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ reviewId: z.string().check(z.minLength(1)) }),
  z.strictObject({ runId: z.string().check(z.minLength(1)), costConsent: z.optional(z.boolean()) }),
  z.strictObject({ runId: z.string().check(z.minLength(1)), sessionId: z.string().check(z.minLength(1)),
    ...ReviewNativeNewRoundInputV1Schema.shape }),
  z.strictObject({ runId: z.string().check(z.minLength(1)), target: z.strictObject({ kind: z.literal('detached') }),
    ...ReviewNativeNewRoundInputV1Schema.shape }),
]));

export const ReviewNativeNewRoundResultV1Schema = lazyZodSchema(() => z.looseObject({
  ...ExecutionRunStartResponseSchema.shape,
  reviewRound: ReviewRoundBindingV1Schema,
  comparisonId: z.optional(z.string().check(z.minLength(1))),
  narration: z.optional(ExecutionRunActionResponseSchema),
}));

export const ReviewNewRoundResultV1Schema = lazyZodSchema(() => z.union([
  ReviewPreparedRoundV1Schema,
  WorkflowRunStartResultV1Schema,
  ReviewNativeNewRoundResultV1Schema,
]));
