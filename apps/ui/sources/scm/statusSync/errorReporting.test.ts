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

import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';

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
        getPersistenceStorage().clearAll();
        vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 1, 9));
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reports only the error code and category, never paths, hostnames or raw error text', () => {
        reportScmStatusSyncError({
            serverId: 'srv_self.example.internal',
            error: Object.assign(new Error('fatal: could not read from /home/alice/repo (git@example.internal)'), {
                scmErrorCode: 'COMMAND_FAILED',
            }),
        });

        expect(capture).toHaveBeenCalledTimes(1);
        const [event, payload, options] = capture.mock.calls[0] ?? [];
        expect(event).toBe('scm_status_sync_failed');
        expect(payload).toEqual({ errorCode: 'COMMAND_FAILED', errorCategory: expect.any(String) });
        expect(options).toEqual({ serverId: 'srv_self.example.internal' });
    });

    it('reports an unknown failure without its message', () => {
        reportScmStatusSyncError({ error: new Error('/home/alice/secret-repo exploded') });

        expect(capture.mock.calls[0]?.[1]).toEqual({ errorCode: 'unknown', errorCategory: expect.any(String) });
        expect(JSON.stringify(capture.mock.calls)).not.toContain('alice');
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

        expect(capture.mock.calls.map(([, properties]) => (properties as { errorCode: string }).errorCode))
            .toEqual(['COMMAND_FAILED', 'NOT_REPOSITORY', 'unknown']);
    });

    it('reports the same error code again once a day has passed, also after a relaunch', () => {
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

    it('counts the day per analytics user, and reports nothing while signed out', () => {
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
