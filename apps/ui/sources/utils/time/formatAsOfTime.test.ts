import { afterEach, describe, expect, it } from 'vitest';

import { commitPreferredLanguage } from '@/text/preferredLanguage';

import { formatAsOfTime } from './formatAsOfTime';

describe('formatAsOfTime', () => {
    afterEach(() => {
        commitPreferredLanguage(null);
    });

    // Today/older-day shapes are owned and pinned by plugin-ui asOfTime.test.ts; the host wrapper
    // owns only handing the app's language to that formatter.
    it('tells the time in the app language, not the runtime default locale', () => {
        const now = new Date(2026, 8, 29, 16, 0).getTime();
        const afternoon = new Date(2026, 8, 29, 15, 30).getTime();

        commitPreferredLanguage('de');
        expect(formatAsOfTime(afternoon, now)).toBe('15:30');

        commitPreferredLanguage('en');
        expect(formatAsOfTime(afternoon, now)).toBe('3:30 PM');
    });
});
