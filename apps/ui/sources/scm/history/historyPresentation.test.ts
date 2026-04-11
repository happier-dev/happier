import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    formatScmHistoryTimestamp,
    formatScmHistoryTimestampAccessibilityLabel,
} from './historyPresentation';

describe('historyPresentation', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('formats SCM history timestamps from Unix milliseconds', () => {
        vi.useFakeTimers();
        const now = new Date('2026-04-10T12:00:00.000Z');
        vi.setSystemTime(now);

        expect(formatScmHistoryTimestamp(now.getTime() - 60_000)).toBe('1m');
    });

    it('returns a readable accessibility label for valid timestamps', () => {
        vi.useFakeTimers();
        const now = new Date('2026-04-10T12:00:00.000Z');
        vi.setSystemTime(now);

        expect(formatScmHistoryTimestampAccessibilityLabel(now.getTime() - 60_000)).toBeTruthy();
    });

    it('returns an empty label for invalid timestamps', () => {
        expect(formatScmHistoryTimestamp(Number.NaN)).toBe('');
        expect(formatScmHistoryTimestamp(0)).toBe('');
        expect(formatScmHistoryTimestampAccessibilityLabel(Number.NaN)).toBe('');
        expect(formatScmHistoryTimestampAccessibilityLabel(0)).toBe('');
    });
});
