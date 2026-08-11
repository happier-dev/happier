import { describe, expect, it } from 'vitest';

import { formatElapsedDuration } from './formatElapsedDuration';

/**
 * The one elapsed formatter (C9). Four incompatible ones exist in the corridor today —
 * `formatDurationMs` (ms/s/m·s), the transcript workflow agent row's own duration (s or m·s),
 * `WorkflowActivityView.formatFooter` (s or m·s), `tools.common.elapsedSeconds` (fractional
 * seconds) — so the same 95 seconds reads four ways in one screen.
 *
 * The contract that distinguishes this from all four: a clock face under an hour (`m:ss`, fixed
 * width, no unit noise) and localised hour/minute units above it.
 */
describe('formatElapsedDuration', () => {
    it('renders a clock face under an hour so a column of rows stays column-aligned', () => {
        expect(formatElapsedDuration(0)).toBe('0:00');
        expect(formatElapsedDuration(42_000)).toBe('0:42');
        expect(formatElapsedDuration(65_000)).toBe('1:05');
        expect(formatElapsedDuration(59 * 60_000 + 59_000)).toBe('59:59');
    });

    it('truncates rather than rounds, so a display never claims a second that has not elapsed', () => {
        expect(formatElapsedDuration(999)).toBe('0:00');
        expect(formatElapsedDuration(59_999)).toBe('0:59');
    });

    it('switches to localised hour and minute units at exactly one hour', () => {
        expect(formatElapsedDuration(60 * 60_000)).toBe('1h 00m');
        expect(formatElapsedDuration(60 * 60_000 + 4 * 60_000 + 30_000)).toBe('1h 04m');
        expect(formatElapsedDuration(26 * 60 * 60_000)).toBe('26h 00m');
    });

    it('clamps impossible inputs to zero instead of rendering a negative or NaN clock', () => {
        expect(formatElapsedDuration(-5_000)).toBe('0:00');
        expect(formatElapsedDuration(Number.NaN)).toBe('0:00');
        expect(formatElapsedDuration(Number.POSITIVE_INFINITY)).toBe('0:00');
    });
});
