import { describe, expect, it } from 'vitest';

import { formatTranscriptNavigationClockTime } from './transcriptNavigationTimeFormat';

describe('formatTranscriptNavigationClockTime', () => {
    it('uses a compact 24-hour clock without an AM/PM suffix even in a 12-hour locale', () => {
        expect(formatTranscriptNavigationClockTime(new Date(2026, 9, 3, 15, 30).getTime())).toBe('15:30');
    });
});
