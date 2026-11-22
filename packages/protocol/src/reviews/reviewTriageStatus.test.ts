import { describe, expect, it } from 'vitest';
import { isReviewFindingFixedV1, readReviewFindingDecisionV1, readReviewFindingFixCommitV1, reviewTriageNeedsDecisionV1 } from './reviewTriageStatus.js';

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

describe('fixed Review findings', () => {
  it('reads a resolved finding as fixed while it keeps its decision, until a new choice is pending', () => {
    expect(isReviewFindingFixedV1('resolved')).toBe(true);
    expect(readReviewFindingDecisionV1('accept', 'resolved')).toBe('accept');
    expect(isReviewFindingFixedV1('open')).toBe(false);
    expect(isReviewFindingFixedV1('dismissed')).toBe(false);
    expect(isReviewFindingFixedV1('resolved', 'accept')).toBe(false);
  });

  it('names the commit that fixed a resolved finding from its resolving transition, else its attached evidence', () => {
    const sha = 'a5c09e2b7f0d4c1e9a8b6c5d4e3f2a1b0c9d8e7f';
    const later = 'b'.repeat(40);
    const by = { kind: 'user' as const, userId: 'alice' };
    const resolved = (evidence: { kind: 'commit'; sha: string }[] | undefined) => ({ transitionId: 't2', fromState: 'open' as const,
      toState: 'resolved' as const, transitionedAt: 2, transitionedBy: by, ...(evidence ? { evidence } : {}) });
    const opened = { transitionId: 't1', toState: 'open' as const, transitionedAt: 1, transitionedBy: by };
    expect(readReviewFindingFixCommitV1({ state: 'resolved', transitions: [opened, resolved([{ kind: 'commit', sha }])] })).toBe(sha);
    expect(readReviewFindingFixCommitV1({ state: 'resolved', transitions: [opened, resolved(undefined)],
      evidence: [{ kind: 'commit', sha: later }] })).toBe(later);
    // Not fixed (yet, or any more): no commit to name, whatever evidence it carries.
    expect(readReviewFindingFixCommitV1({ state: 'open', transitions: [opened, resolved([{ kind: 'commit', sha }])] })).toBeNull();
    expect(readReviewFindingFixCommitV1({ state: 'resolved', transitions: [opened, resolved([{ kind: 'commit', sha }])] }, 'defer')).toBeNull();
    expect(readReviewFindingFixCommitV1({ state: 'resolved', transitions: [opened, resolved(undefined)] })).toBeNull();
  });
});
