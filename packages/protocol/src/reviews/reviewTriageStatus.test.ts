import { describe, expect, it } from 'vitest';
import { reviewTriageNeedsDecisionV1 } from './reviewTriageStatus.js';

describe('Review decision demand', () => {
  it('keeps undecided, deferred and clarification findings actionable without reopening decided findings', () => {
    expect(([undefined, 'defer', 'needs_refinement'] as const).map(status => reviewTriageNeedsDecisionV1(status))).toEqual([true, true, true]);
    expect(reviewTriageNeedsDecisionV1('accept')).toBe(false);
    expect(reviewTriageNeedsDecisionV1('reject')).toBe(false);
  });
  it('does not ask for another decision on terminal or redacted findings', () => {
    expect(reviewTriageNeedsDecisionV1(undefined, 'resolved')).toBe(false);
    expect(reviewTriageNeedsDecisionV1(undefined, 'dismissed')).toBe(false);
    expect(reviewTriageNeedsDecisionV1('defer', 'resolved')).toBe(false);
    expect(reviewTriageNeedsDecisionV1(undefined, 'open', true)).toBe(false);
    expect(reviewTriageNeedsDecisionV1(undefined, 'proposed')).toBe(true);
  });
});
