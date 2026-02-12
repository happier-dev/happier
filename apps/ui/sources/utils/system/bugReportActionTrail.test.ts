import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    clearBugReportUserActionTrail,
    configureBugReportUserActionTrail,
    getBugReportUserActionTrail,
    recordBugReportUserAction,
} from './bugReportActionTrail';

describe('bugReportActionTrail', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps a bounded action trail with sanitized metadata', () => {
        clearBugReportUserActionTrail();

        recordBugReportUserAction('open-settings', {
            route: '/settings',
            metadata: {
                count: 2,
                enabled: true,
                nested: { ignored: true },
                raw: 'ok',
            },
        });

        const trail = getBugReportUserActionTrail();
        expect(trail).toHaveLength(1);
        expect(trail[0]?.action).toBe('open-settings');
        expect(trail[0]?.route).toBe('/settings');
        expect(trail[0]?.metadata).toEqual({
            count: 2,
            enabled: true,
            raw: 'ok',
        });
    });

    it('trims oldest actions when max entries is exceeded', () => {
        clearBugReportUserActionTrail();

        for (let index = 0; index < 260; index += 1) {
            recordBugReportUserAction(`action-${index}`);
        }

        const trail = getBugReportUserActionTrail();
        expect(trail).toHaveLength(250);
        expect(trail[0]?.action).toBe('action-10');
        expect(trail[249]?.action).toBe('action-259');
    });

    it('returns only actions newer than the provided timestamp', () => {
        clearBugReportUserActionTrail();
        vi.useFakeTimers();

        const firstTs = new Date('2026-01-01T00:00:00.000Z');
        vi.setSystemTime(firstTs);
        recordBugReportUserAction('first-action');

        const secondTs = new Date('2026-01-01T00:01:10.000Z');
        vi.setSystemTime(secondTs);
        recordBugReportUserAction('second-action');

        const trail = getBugReportUserActionTrail({
            sinceMs: new Date('2026-01-01T00:01:00.000Z').getTime(),
        });

        expect(trail.map((entry) => entry.action)).toEqual(['second-action']);
    });

    it('preserves configured max actions after clearing the trail', () => {
        clearBugReportUserActionTrail();
        configureBugReportUserActionTrail({ maxActions: 2 });

        recordBugReportUserAction('a-1');
        recordBugReportUserAction('a-2');
        clearBugReportUserActionTrail();
        recordBugReportUserAction('b-1');
        recordBugReportUserAction('b-2');
        recordBugReportUserAction('b-3');

        const trail = getBugReportUserActionTrail();
        expect(trail.map((entry) => entry.action)).toEqual(['b-2', 'b-3']);
    });
});
