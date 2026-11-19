import { describe, expect, it } from 'vitest';
import { readReviewFindingDecisionV1, reviewTriageNeedsDecisionV1 } from './reviewTriageStatus.js';

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

describe('effective Review finding decision', () => {
  it('projects dismissal as Ignore even when a prior acceptance was retained, without changing resolved decisions', () => {
    expect(readReviewFindingDecisionV1('accept', 'open')).toBe('accept');
    expect(readReviewFindingDecisionV1('accept', 'dismissed')).toBe('reject');
    expect(readReviewFindingDecisionV1(undefined, 'dismissed')).toBe('reject');
    expect(readReviewFindingDecisionV1('accept', 'dismissed', 'accept')).toBe('accept');
    expect(readReviewFindingDecisionV1('accept', 'dismissed', 'defer')).toBe('defer');
    expect(readReviewFindingDecisionV1('accept', 'resolved')).toBe('accept');
    expect(readReviewFindingDecisionV1('reject', 'resolved')).toBe('reject');
    expect(readReviewFindingDecisionV1('defer', 'open')).toBe('defer');
    expect(readReviewFindingDecisionV1('needs_refinement', 'open')).toBe('undecided');
    expect(readReviewFindingDecisionV1(undefined)).toBe('undecided');
  });
});
