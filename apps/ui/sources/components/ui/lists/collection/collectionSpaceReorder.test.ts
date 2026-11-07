import { describe, expect, it } from 'vitest';

import { resolveCollectionSpaceReorder } from './collectionSpaceReorder';

describe('resolveCollectionSpaceReorder', () => {
    const ids = ['my-work', 'happier', 'website', 'infra'];

    it('turns a staged place into the space it lands before, or the end', () => {
        expect(resolveCollectionSpaceReorder(ids, 'infra', { anchorId: 'happier', placement: 'before' }))
            .toEqual({ op: 'reorder', spaceId: 'infra', beforeSpaceId: 'happier' });
        expect(resolveCollectionSpaceReorder(ids, 'my-work', { anchorId: 'infra', placement: 'after' }))
            .toEqual({ op: 'reorder', spaceId: 'my-work', beforeSpaceId: null });
        // Horizontal strip: "after" a tab is before its right-hand neighbour.
        expect(resolveCollectionSpaceReorder(ids, 'my-work', { anchorId: 'happier', placement: 'after' }))
            .toEqual({ op: 'reorder', spaceId: 'my-work', beforeSpaceId: 'website' });
    });

    it('refuses a place that leaves the order as it is or names a space that is gone', () => {
        expect(resolveCollectionSpaceReorder(ids, 'happier', { anchorId: 'website', placement: 'before' })).toBeNull();
        expect(resolveCollectionSpaceReorder(ids, 'gone', { anchorId: 'website', placement: 'before' })).toBeNull();
    });
});
