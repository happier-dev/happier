import { describe, expect, it } from 'vitest';
import type { ReviewListItemV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { applyReviewListPage, getReviewListSnapshot, reviewListKey, subscribeReviewList } from './list';

const scope = { serverId: 'reviews-list-home', accountId: 'alice' };
const input = { limit: 2 };
function row(reviewId: string): ReviewListItemV1 {
    return { reviewId, projectSourceId: null, workflowId: null, subjectKind: 'repository', sourceKind: 'direct',
        state: 'running', currentRoundOrdinal: 1, startedAt: 1, finishedAt: null, createdAt: 1, updatedAt: 1,
        counts: { total: 0, needsDecision: 0 } };
}

describe('Review list header publication', () => {
    it('retains unchanged rows and nested facts, suppresses equal publication, and isolates Accounts', () => {
        const key = reviewListKey(scope, input);
        const otherKey = reviewListKey({ ...scope, accountId: 'bob' }, input);
        const rows = Array.from({ length: 1000 }, (_, index) => row(`review-${index}`));
        applyReviewListPage(key, { items: rows, cursor: 'opaque-next' });
        const before = getReviewListSnapshot(key);
        let notifications = 0;
        const dispose = subscribeReviewList(key, () => { notifications += 1; });
        applyReviewListPage(key, structuredClone({ items: rows, cursor: 'opaque-next' }));
        expect(getReviewListSnapshot(key)).toBe(before);
        expect(notifications).toBe(0);
        const changed = structuredClone(rows);
        changed[0] = { ...changed[0]!, state: 'completed', finishedAt: 2 };
        applyReviewListPage(key, { items: changed, cursor: 'opaque-next' });
        const after = getReviewListSnapshot(key);
        expect(after.items?.[0]?.state).toBe('completed');
        expect(after.items?.[0]?.counts).toBe(before.items?.[0]?.counts);
        expect(after.items?.[1]).toBe(before.items?.[1]);
        expect(notifications).toBe(1);
        expect(getReviewListSnapshot(otherKey).items).toBeNull();
        dispose();
    });

    it('appends only an explicitly supplied candidate page and keeps the opaque continuation', () => {
        const key = reviewListKey(scope, { ...input, state: 'completed' });
        applyReviewListPage(key, { items: [row('one')], cursor: 'opaque:first' });
        applyReviewListPage(key, { items: [row('two')], cursor: 'opaque:second' }, true);
        expect(getReviewListSnapshot(key).items?.map(item => item.reviewId)).toEqual(['one', 'two']);
        expect(getReviewListSnapshot(key).cursor).toBe('opaque:second');
    });
});
