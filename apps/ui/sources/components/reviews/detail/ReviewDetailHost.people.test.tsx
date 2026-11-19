import { describe, expect, it, vi } from 'vitest';

import type { ReviewHumanStateV1 } from '@happier-dev/protocol/reviews/reviewHumanV1';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

import { projectPeople, projectRound } from './ReviewDetailHost';

const human: ReviewHumanStateV1 = {
  reviewId: 'review-1',
  roundOrdinal: 2,
  requests: [
    { id: 'mika-1', roundOrdinal: 1, principal: { kind: 'account', accountId: 'mika' }, required: true, needsAccess: false },
    { id: 'mika-2', roundOrdinal: 2, principal: { kind: 'account', accountId: 'mika' }, required: true, needsAccess: false },
    { id: 'me-2', roundOrdinal: 2, principal: { kind: 'account', accountId: 'me' }, required: false, needsAccess: false },
  ],
  verdicts: [{ accountId: 'mika', roundOrdinal: 1, verdict: 'request_changes', submittedAt: 1, revision: 1 }],
  needsYou: { reviewId: 'review-1', roundOrdinal: 2, reason: 'review_needs_you', needsYou: true,
    requestedVerdict: true, pendingDecisions: false, canSubmitVerdict: true },
};

describe('Review page people', () => {
  it('draws each verdict inside its own round: round 1 keeps it, round 2 asks again and waits for the viewer', () => {
    const round1 = projectPeople({ human, round: 1, names: null, viewerAccountId: 'me' });
    expect(round1?.participants.map(person => [person.id, person.state])).toEqual([
      ['mika-1', 'reviewWalkthrough.detail.verdictChangesRequested'],
    ]);
    expect(round1?.status).toBe('done');
    const round2 = projectPeople({ human, round: 2, names: null, viewerAccountId: 'me' });
    expect(round2?.participants.map(person => [person.id, person.state, person.qualifier ?? null])).toEqual([
      ['mika-2', 'reviewWalkthrough.detail.askedAgain', null],
      ['me-2', 'reviewWalkthrough.detail.requestedFromYou', 'reviewWalkthrough.detail.optional'],
    ]);
    expect(round2?.status).toBe('waiting');
  });

  it('has no people row for a round nobody was asked to review', () => {
    expect(projectPeople({ human: { ...human, requests: [] }, round: 2, names: null, viewerAccountId: 'me' })).toBeNull();
  });

  it('draws no reviewers row for a round only people review', () => {
    const round = projectRound({ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2, reviewerIds: [], runs: [] });
    expect(round.groups).toEqual([]);
    const reviewed = projectRound({ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2, reviewerIds: ['s0:r0'], runs: [] });
    expect(reviewed.groups.map(group => group.id)).toEqual(['reviewers']);
  });
});
