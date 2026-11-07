import { describe, expect, it } from 'vitest';

import { resolveCollectionSpaceSwipeCommit } from './collectionSpaceSwipe';

describe('collection space swipe', () => {
    const base = { width: 390, canPrevious: true, canNext: true, velocityX: 0 };

    it('commits past 30% of the width or on a flick toward the neighbour, else settles back', () => {
        expect(resolveCollectionSpaceSwipeCommit({ ...base, translationX: -130 })).toBe(1);
        expect(resolveCollectionSpaceSwipeCommit({ ...base, translationX: 130 })).toBe(-1);
        expect(resolveCollectionSpaceSwipeCommit({ ...base, translationX: -60 })).toBeNull();
        expect(resolveCollectionSpaceSwipeCommit({ ...base, translationX: -40, velocityX: -900 })).toBe(1);
        // A flick back against the drag does not commit.
        expect(resolveCollectionSpaceSwipeCommit({ ...base, translationX: -60, velocityX: 900 })).toBeNull();
        expect(resolveCollectionSpaceSwipeCommit({ ...base, canNext: false, translationX: -300 })).toBeNull();
    });
});
