import { describe, expect, it } from 'vitest';

import {
    resolveNativeInvertedColdScrollIndex,
    resolveWebColdListScrollTarget,
    resolveWebHotColdScrollDecision,
} from './resolveWebHotColdScrollDecision';

describe('resolveWebHotColdScrollDecision', () => {
    it('scrolls to the cold index when the target is within cold items', () => {
        expect(resolveWebHotColdScrollDecision({ fullIndex: 3, coldCount: 10 })).toEqual({ kind: 'cold', index: 3 });
    });

    it('scrolls to the last cold index when the target is in the hot tail', () => {
        expect(resolveWebHotColdScrollDecision({ fullIndex: 10, coldCount: 10 })).toEqual({ kind: 'cold', index: 9 });
        expect(resolveWebHotColdScrollDecision({ fullIndex: 999, coldCount: 2 })).toEqual({ kind: 'cold', index: 1 });
    });

    it('pins to bottom when there are no cold items', () => {
        expect(resolveWebHotColdScrollDecision({ fullIndex: 0, coldCount: 0 })).toEqual({ kind: 'pin_to_bottom' });
    });

    it('maps every web scrollToIndex target through the cold-list data boundary', () => {
        expect(resolveWebColdListScrollTarget({
            fullIndex: 12,
            coldCount: 5,
            reason: 'prepend-recovery',
        })).toEqual({ kind: 'cold', index: 4, fullIndex: 12, reason: 'prepend-recovery' });

        expect(resolveWebColdListScrollTarget({
            fullIndex: 1,
            coldCount: 5,
            reason: 'jump-to-seq',
        })).toEqual({ kind: 'cold', index: 1, fullIndex: 1, reason: 'jump-to-seq' });

        expect(resolveWebColdListScrollTarget({
            fullIndex: 1,
            coldCount: 0,
            reason: 'prepend-recovery',
        })).toEqual({ kind: 'pin_to_bottom', fullIndex: 1, reason: 'prepend-recovery' });
    });
});

describe('resolveNativeInvertedColdScrollIndex', () => {
    // Inverted layout: displayItems (rendered) is newest-first. With 1 hot row carved, the full
    // rendered array is [hot(m4), cold(m3), cold(m2), cold(m1)] → fullCount 4, coldCount 3, and the
    // FlashList cold data is [m3, m2, m1].
    const fullCount = 4;
    const coldCount = 3;

    it('maps the live-tail / "bottom" target BELOW the hot tail (to the newest cold rendered row)', () => {
        // Rendered index 0 = the hot live-tail row. It is not in cold data, so the scroll target is
        // the newest cold rendered row (cold index 0) — bringing the hot tail's edge slot into view.
        expect(resolveNativeInvertedColdScrollIndex({ renderedFullIndex: 0, fullCount, coldCount })).toBe(0);
        // Rendered index 1 = the newest COLD row → also cold rendered index 0.
        expect(resolveNativeInvertedColdScrollIndex({ renderedFullIndex: 1, fullCount, coldCount })).toBe(0);
    });

    it('maps an older full row to the matching cold rendered row', () => {
        // Rendered index 3 = oldest row (canonical 0) → oldest cold rendered index (coldCount - 1).
        expect(resolveNativeInvertedColdScrollIndex({ renderedFullIndex: 3, fullCount, coldCount })).toBe(2);
        // Rendered index 2 → cold rendered index 1.
        expect(resolveNativeInvertedColdScrollIndex({ renderedFullIndex: 2, fullCount, coldCount })).toBe(1);
    });

    it('returns null for out-of-range or empty inputs so the caller keeps its original index', () => {
        expect(resolveNativeInvertedColdScrollIndex({ renderedFullIndex: -1, fullCount, coldCount })).toBeNull();
        expect(resolveNativeInvertedColdScrollIndex({ renderedFullIndex: 4, fullCount, coldCount })).toBeNull();
        expect(resolveNativeInvertedColdScrollIndex({ renderedFullIndex: 0, fullCount: 0, coldCount: 0 })).toBeNull();
    });
});
