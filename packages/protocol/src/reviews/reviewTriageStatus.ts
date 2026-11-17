import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import type { ReviewCommentStateV1 } from './comments/v1.js';

export const ReviewTriageStatusSchema = lazyZodSchema(() => z.enum(['accept', 'reject', 'defer', 'needs_refinement']));
export type ReviewTriageStatus = z.infer<typeof ReviewTriageStatusSchema>;

/** Deferred and clarification decisions still require a person's attention. */
export const REVIEW_TRIAGE_NEEDS_DECISION_STATUSES_V1 = ['defer', 'needs_refinement'] as const satisfies readonly ReviewTriageStatus[];

export const REVIEW_COMMENT_TERMINAL_DECISION_STATES_V1 = ['resolved', 'dismissed'] as const satisfies readonly ReviewCommentStateV1[];

export function reviewTriageNeedsDecisionV1(status: ReviewTriageStatus | undefined, state?: ReviewCommentStateV1, redacted = false): boolean {
  return !redacted && !REVIEW_COMMENT_TERMINAL_DECISION_STATES_V1.some(candidate => candidate === state)
    && (status === undefined || REVIEW_TRIAGE_NEEDS_DECISION_STATUSES_V1.some(candidate => candidate === status));
}
