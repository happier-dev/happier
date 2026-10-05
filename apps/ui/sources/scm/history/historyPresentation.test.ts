import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    formatScmHistoryTimestamp,
    formatScmHistoryTimestampAccessibilityLabel,
    formatScmTimelineWhen,
    formatScmTimelineTime,
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

    it('says when a timeline item happened in the fewest words: the time today, the weekday this week, the date before', () => {
        const now = new Date(2026, 8, 29, 16, 30).getTime();
        const today = new Date(2026, 8, 29, 10, 44).getTime();
        const thisWeek = new Date(2026, 8, 27, 9, 0).getTime();
        const older = new Date(2026, 7, 12, 9, 0).getTime();
        expect(formatScmTimelineWhen(today, now)).toBe('10:44');
        expect(formatScmTimelineTime(today)).toBe('10:44');
        expect(formatScmTimelineWhen(thisWeek, now)).toBe(new Date(thisWeek).toLocaleDateString([], { weekday: 'short' }));
        expect(formatScmTimelineWhen(older, now)).toBe(new Date(older).toLocaleDateString([], { day: 'numeric', month: 'short' }));
        expect(formatScmTimelineWhen(Number.NaN, now)).toBe('');
    });
});
