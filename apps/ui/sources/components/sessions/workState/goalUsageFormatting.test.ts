import { describe, expect, it } from 'vitest';

import { formatGoalTimeUsed } from './goalUsageFormatting';

describe('formatGoalTimeUsed', () => {
    it('formats sub-minute durations as seconds', () => {
        expect(formatGoalTimeUsed(0)).toBe('0s');
        expect(formatGoalTimeUsed(45)).toBe('45s');
    });

    it('keeps seconds at the sub-hour scale (live-timer feel)', () => {
        expect(formatGoalTimeUsed(190)).toBe('3m 10s');
    });

    it('drops the trailing 0s on exact minutes', () => {
        expect(formatGoalTimeUsed(120)).toBe('2m');
    });

    it('drops seconds at the hour scale for brevity', () => {
        expect(formatGoalTimeUsed(3 * 3600 + 5 * 60 + 12)).toBe('3h 5m');
    });

    it('clamps negative and undefined input to zero seconds', () => {
        expect(formatGoalTimeUsed(undefined)).toBe('0s');
        expect(formatGoalTimeUsed(-30)).toBe('0s');
    });
});
