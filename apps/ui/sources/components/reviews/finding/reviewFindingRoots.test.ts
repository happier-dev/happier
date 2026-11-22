import { expect, it } from 'vitest';

import { buildReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';

import { projectReviewFindingRoots } from './reviewFindingRoots';

it('sorts durable finding roots by severity and keeps report order within a severity', () => {
    const reviewId = 'review-with-findings';
    const makeRoot = (id: string, severity: 'low' | 'high', identityDigit: string) =>
        buildReviewCommentFixture({
            id,
            reviewId,
            findingIdentity: identityDigit.repeat(64),
            finding: { id, title: id, summary: 'Finding summary', severity, category: 'correctness' },
        });
    const low = makeRoot('low-root', 'low', '1');
    const firstHigh = makeRoot('first-high-root', 'high', '2');
    const secondHigh = makeRoot('second-high-root', 'high', '3');

    const { rows } = projectReviewFindingRoots(reviewId, [low, firstHigh, secondHigh]);

    expect(rows.map(row => row.rowId)).toEqual([firstHigh.id, secondHigh.id, low.id]);
});
