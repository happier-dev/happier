import { describe, expect, it } from 'vitest';

import { formatAsOfTime } from './formatAsOfTime';

describe('formatAsOfTime', () => {
    it('gives the time alone for a read made today, and adds the day for an older one', () => {
        const now = new Date(2026, 8, 27, 12, 0).getTime();
        const earlierToday = new Date(2026, 8, 27, 9, 5).getTime();
        const yesterday = new Date(2026, 8, 26, 18, 44, 1).getTime();

        const today = formatAsOfTime(earlierToday, now);
        expect(today).toBe(new Date(earlierToday).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
        expect(today).not.toMatch(/2026/);

        const older = formatAsOfTime(yesterday, now);
        expect(older).not.toBe(formatAsOfTime(yesterday, yesterday));
        // No seconds and no year: a quiet "as of", not a timestamp dump.
        expect(older).not.toMatch(/:01|2026/);
        expect(older).toContain(new Date(yesterday).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
    });
});
