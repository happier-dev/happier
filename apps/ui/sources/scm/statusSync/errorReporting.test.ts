import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { capture } = vi.hoisted(() => ({
    capture: vi.fn(),
}));

vi.mock('@/track', () => ({
    tracking: {
        capture,
    },
}));

import {
    reportScmStatusSyncError,
    resetScmStatusSyncErrorReportingForTests,
} from './errorReporting';

describe('reportScmStatusSyncError', () => {
    beforeEach(() => {
        capture.mockReset();
        resetScmStatusSyncErrorReportingForTests();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reports only the error code and category, never paths, hostnames or raw error text', () => {
        reportScmStatusSyncError({
            projectKey: 'srv_self.example.internal:machine:/home/alice/repo',
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
        reportScmStatusSyncError({ projectKey: 'machine:/repo', error: new Error('/home/alice/secret-repo exploded') });

        expect(capture.mock.calls[0]?.[1]).toEqual({ errorCode: 'unknown', errorCategory: expect.any(String) });
        expect(JSON.stringify(capture.mock.calls)).not.toContain('alice');
    });

    it('throttles duplicate error reports for the same project+message bucket', () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);

        reportScmStatusSyncError({
            projectKey: 'machine:/repo',
            error: new Error('snapshot failed'),
        });
        reportScmStatusSyncError({
            projectKey: 'machine:/repo',
            error: new Error('snapshot failed'),
        });

        expect(capture).toHaveBeenCalledTimes(1);

        now.mockReturnValue(31_000);
        reportScmStatusSyncError({
            projectKey: 'machine:/repo',
            error: new Error('snapshot failed'),
        });
        expect(capture).toHaveBeenCalledTimes(1);

        now.mockReturnValue(62_000);
        reportScmStatusSyncError({
            projectKey: 'machine:/repo',
            error: new Error('snapshot failed'),
        });
        expect(capture).toHaveBeenCalledTimes(2);
    });

    it('evicts stale dedupe buckets when the cache grows to high cardinality', () => {
        const now = vi.spyOn(Date, 'now');
        now.mockReturnValue(1_000);

        reportScmStatusSyncError({
            projectKey: 'machine:/repo',
            error: new Error('retriable failure'),
        });
        expect(capture).toHaveBeenCalledTimes(1);

        for (let index = 0; index < 512; index += 1) {
            reportScmStatusSyncError({
                projectKey: `machine:/repo-${index}`,
                error: new Error(`error-${index}`),
            });
        }

        // Still inside the first report's dedupe window: only its eviction lets it emit again.
        now.mockReturnValue(2_000);
        reportScmStatusSyncError({
            projectKey: 'machine:/repo',
            error: new Error('retriable failure'),
        });

        expect(capture).toHaveBeenCalledTimes(514);
    });
});
