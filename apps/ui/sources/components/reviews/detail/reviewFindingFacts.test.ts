import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

import { reviewFindingFacts, reviewHistoryFacts } from './reviewFindingFacts';

describe('Review finding facts', () => {
  it('says how a finding stands in the opened round, and when it was already there', () => {
    expect(reviewFindingFacts({ appearance: 'new', scopeAttribution: undefined, roundOrdinal: 1 })).toEqual([]);
    expect(reviewFindingFacts({ appearance: 'new', scopeAttribution: undefined, roundOrdinal: 2 }))
      .toEqual(['reviewWalkthrough.detail.newInRound(round=2)']);
    expect(reviewFindingFacts({ appearance: 'still_there', scopeAttribution: 'pre_existing', roundOrdinal: 2 }))
      .toEqual(['reviewWalkthrough.detail.stillThere', 'reviewWalkthrough.detail.preExisting']);
    expect(reviewFindingFacts({ appearance: 'looks_addressed', scopeAttribution: 'unknown', roundOrdinal: 3 }))
      .toEqual(['reviewWalkthrough.detail.notFoundInRound(round=3)']);
    // Unknown stays unknown: no word is drawn for it.
    expect(reviewFindingFacts({ appearance: 'unknown', scopeAttribution: 'in_selected_changes', roundOrdinal: 2 })).toEqual([]);
  });

  it('states the history owner facts for a finding across runs, never a guess', () => {
    expect(reviewHistoryFacts({ priorRunCount: 4, openReviewCount: 2, newSincePrevious: false, inCurrentReview: true, inPreviousReview: true }))
      .toEqual(['reviewWalkthrough.detail.historyEarlierRuns(count=4)', 'reviewWalkthrough.detail.historyOpenElsewhere(count=2)']);
    expect(reviewHistoryFacts({ priorRunCount: 0, openReviewCount: 0, newSincePrevious: true, inCurrentReview: true, inPreviousReview: false }))
      .toEqual(['reviewWalkthrough.detail.historyNewSincePrevious']);
    expect(reviewHistoryFacts({ priorRunCount: 1, openReviewCount: 0, newSincePrevious: null, inCurrentReview: false, inPreviousReview: true }))
      .toEqual(['reviewWalkthrough.detail.historyEarlierRuns(count=1)', 'reviewWalkthrough.detail.historyNotFoundThisTime']);
  });
});
