import { describe, expect, it } from 'vitest';

import { resolveWebTranscriptPrependRangeReservePx } from './webTranscriptPrependRangeReserve';

describe('resolveWebTranscriptPrependRangeReservePx', () => {
    it('reserves the missing scroll range while virtualized prepend measurement is below the captured baseline', () => {
        expect(resolveWebTranscriptPrependRangeReservePx({
            baselineScrollHeight: 1200,
            currentScrollHeight: 900,
        })).toBe(300);
    });

    it('does not reserve range once measurement catches up or grows past the baseline', () => {
        expect(resolveWebTranscriptPrependRangeReservePx({
            baselineScrollHeight: 1200,
            currentScrollHeight: 1200,
        })).toBe(0);
        expect(resolveWebTranscriptPrependRangeReservePx({
            baselineScrollHeight: 1200,
            currentScrollHeight: 1400,
        })).toBe(0);
    });

    it('ignores sub-pixel and invalid measurements', () => {
        expect(resolveWebTranscriptPrependRangeReservePx({
            baselineScrollHeight: 1200.8,
            currentScrollHeight: 1200.1,
        })).toBe(0);
        expect(resolveWebTranscriptPrependRangeReservePx({
            baselineScrollHeight: Number.NaN,
            currentScrollHeight: 900,
        })).toBe(0);
        expect(resolveWebTranscriptPrependRangeReservePx({
            baselineScrollHeight: 1200,
            currentScrollHeight: Number.POSITIVE_INFINITY,
        })).toBe(1200);
    });
});
