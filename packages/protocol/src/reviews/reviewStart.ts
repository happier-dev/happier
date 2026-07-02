import { z } from 'zod';

import { ReviewScmScopeV1Schema } from './scope.js';

/**
 * Canonical, cross-surface input contract for starting reviews.
 *
 * This is not a “backend contract”. It is a generalized review intent input that
 * can be interpreted by different review engines (LLM prompt reviews, native CLIs).
 */

export const ReviewChangeTypeSchema = z.enum(['all', 'committed', 'uncommitted']);
export type ReviewChangeType = z.infer<typeof ReviewChangeTypeSchema>;

export const ReviewBaseSchema = z.union([
  z.object({ kind: z.literal('none') }).passthrough(),
  z.object({ kind: z.literal('branch'), baseBranch: z.string().min(1) }).passthrough(),
  z.object({ kind: z.literal('commit'), baseCommit: z.string().min(1) }).passthrough(),
]);
export type ReviewBase = z.infer<typeof ReviewBaseSchema>;

export const ReviewEngineIdSchema = z.string().trim().min(1);
export type ReviewEngineId = z.infer<typeof ReviewEngineIdSchema>;

export const ReviewEngineInputSchema = z.object({}).passthrough();
export type ReviewEngineInput = z.infer<typeof ReviewEngineInputSchema>;

export const ReviewEngineInputsSchema = z.record(ReviewEngineIdSchema, ReviewEngineInputSchema).default({});
export type ReviewEngineInputs = z.infer<typeof ReviewEngineInputsSchema>;
const DEFAULT_REVIEW_ENGINE_INPUTS: ReviewEngineInputs = ReviewEngineInputsSchema.parse({});

export const REVIEW_SCM_SCOPE_INPUT_KEY = 'scmReviewScope';

export const ReviewStartInputSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    engineIds: z.array(ReviewEngineIdSchema).min(1),
    instructions: z.string().trim().min(1),
    // Intentionally default to uncommitted changes: the common "review what I just changed"
    // flow should stay narrowly scoped unless the user explicitly broadens it.
    changeType: ReviewChangeTypeSchema.default('uncommitted'),
    base: ReviewBaseSchema.default({ kind: 'none' }),
    engines: ReviewEngineInputsSchema.prefault(DEFAULT_REVIEW_ENGINE_INPUTS),
    scmReviewScope: ReviewScmScopeV1Schema.optional(),
    permissionMode: z.string().min(1).default('read_only'),
  })
  .passthrough()
  // Intentionally no engine-specific requirements here: this is a generalized,
  // cross-surface intent input. Engines may interpret optional `engines.*` blocks.
  ;
export type ReviewStartInput = z.infer<typeof ReviewStartInputSchema>;
