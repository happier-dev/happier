import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { capture, analyticsUser } = vi.hoisted(() => ({
    capture: vi.fn(),
    analyticsUser: { id: 'anon-1' as string | null },
}));

vi.mock('@/track', () => ({
    tracking: {
        capture,
    },
    getTrackingAnonymousUserId: () => analyticsUser.id,
}));

import { reportScmStatusSyncError } from './errorReporting';

const DAY_MS = 24 * 60 * 60 * 1000;

function fail(scmErrorCode?: string, message = 'snapshot failed') {
    reportScmStatusSyncError({
        error: scmErrorCode ? Object.assign(new Error(message), { scmErrorCode }) : new Error(message),
    });
}

describe('reportScmStatusSyncError', () => {
    beforeEach(() => {
        capture.mockReset();
        analyticsUser.id = 'anon-1';
        vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 1, 9));
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reports the error code and category only, never the error text', () => {
        reportScmStatusSyncError({
            error: Object.assign(new Error('snapshot failed in /repo'), { scmErrorCode: 'COMMAND_FAILED' }),
        });

        expect(capture).toHaveBeenCalledTimes(1);
        expect(capture.mock.calls[0]).toEqual([
            'scm_status_sync_failed',
            { errorCode: 'COMMAND_FAILED', error_category: 'command' },
        ]);
    });

    it('reports an unrecognised error code as an unknown category, never as text', () => {
        reportScmStatusSyncError({
            error: Object.assign(new Error('boom'), { scmErrorCode: 'fatal: /home/me/repo' }),
        });

        expect(capture.mock.calls[0]).toEqual(['scm_status_sync_failed', { error_category: 'unknown' }]);
    });

    it('reports 3 identical failures in a day once', () => {
        fail('COMMAND_FAILED');
        fail('COMMAND_FAILED');
        fail('COMMAND_FAILED');

        expect(capture).toHaveBeenCalledTimes(1);
    });

    it('reports each error code once a day, whatever the error text', () => {
        fail('COMMAND_FAILED', 'one');
        fail('COMMAND_FAILED', 'two');
        fail('NOT_REPOSITORY');
        fail();
        fail(undefined, 'other text');

        expect(capture.mock.calls.map(([, properties]) => properties)).toEqual([
            { errorCode: 'COMMAND_FAILED', error_category: 'command' },
            { errorCode: 'NOT_REPOSITORY', error_category: 'repository' },
            { error_category: 'unknown' },
        ]);
    });

    it('reports the same error code again once a day has passed', () => {
        const now = vi.spyOn(Date, 'now');
        now.mockReturnValue(1_000_000);
        fail('COMMAND_FAILED');
        now.mockReturnValue(1_000_000 + DAY_MS - 1);
        fail('COMMAND_FAILED');
        expect(capture).toHaveBeenCalledTimes(1);

        now.mockReturnValue(1_000_000 + DAY_MS);
        fail('COMMAND_FAILED');
        expect(capture).toHaveBeenCalledTimes(2);
    });

    it('counts the day per analytics user, and reports nothing while analytics is not allowed', () => {
        analyticsUser.id = null;
        fail('COMMAND_FAILED');
        expect(capture).toHaveBeenCalledTimes(0);

        analyticsUser.id = 'anon-1';
        fail('COMMAND_FAILED');
        analyticsUser.id = 'anon-2';
        fail('COMMAND_FAILED');
        fail('COMMAND_FAILED');

        expect(capture).toHaveBeenCalledTimes(2);
    });
});
