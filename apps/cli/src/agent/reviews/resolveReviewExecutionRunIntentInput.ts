import { ReviewStartInputSchema, type ReviewStartInput } from '@happier-dev/protocol';

import {
  ReviewFollowUpIntentInputSchema,
  type ReviewFollowUpIntentInput,
} from '@/agent/reviews/followUp/reviewFollowUpIntentInput';

export type ReviewExecutionRunIntentInputResolution =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'review_start'; input: ReviewStartInput }>
  | Readonly<{ kind: 'review_follow_up'; input: ReviewFollowUpIntentInput }>
  | Readonly<{ kind: 'invalid' }>;

export function resolveReviewExecutionRunIntentInput(
  intentInput: unknown,
  defaults?: Readonly<{ engineId: string; instructions: string }>,
): ReviewExecutionRunIntentInputResolution {
  if (typeof intentInput === 'undefined') {
    return { kind: 'absent' };
  }

  const followUp = ReviewFollowUpIntentInputSchema.safeParse(intentInput);
  if (followUp.success) {
    return { kind: 'review_follow_up', input: followUp.data };
  }

  const reviewStart = ReviewStartInputSchema.safeParse(intentInput);
  if (reviewStart.success) {
    return { kind: 'review_start', input: reviewStart.data };
  }

  if (defaults && intentInput && typeof intentInput === 'object' && !Array.isArray(intentInput)) {
    const normalized = ReviewStartInputSchema.safeParse({
      engineIds: [defaults.engineId],
      instructions: defaults.instructions,
      ...intentInput,
    });
    if (normalized.success) {
      return { kind: 'review_start', input: normalized.data };
    }
  }

  return { kind: 'invalid' };
}
