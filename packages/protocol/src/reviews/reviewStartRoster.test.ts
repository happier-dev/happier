import { describe, expect, it } from 'vitest';

import { reviewReviewerIdsForStartV1, reviewReviewersForEngineIdsV1, ReviewStartInputSchema } from './reviewStart.js';

describe('the engine-id reviewer roster', () => {
  it('is the roster the canonical Review start admits, one selection per chosen engine in order', () => {
    const reviewers = reviewReviewersForEngineIdsV1(['engine-a', 'engine-b']);
    const admitted = ReviewStartInputSchema.parse({ reviewers, instructions: 'Review.' });

    expect(admitted.reviewers).toEqual([
      { kind: 'engine', engineId: 'engine-a' },
      { kind: 'engine', engineId: 'engine-b' },
    ]);
    expect(reviewReviewerIdsForStartV1(admitted)).toHaveLength(2);
  });
});
