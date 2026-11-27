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

    it('reports the error code and category only: no machine id, project key or error text', () => {
        reportScmStatusSyncError({
            projectKey: 'machine-123:/repo',
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
            projectKey: 'machine-123:/repo',
            error: Object.assign(new Error('boom'), { scmErrorCode: 'fatal: /home/me/repo' }),
        });

        expect(capture.mock.calls[0]).toEqual(['scm_status_sync_failed', { error_category: 'unknown' }]);
    });

    it('throttles duplicate error reports for the same project+message bucket', () => {
        vi.spyOn(Date, 'now')
            .mockReturnValueOnce(1_000)
            .mockReturnValueOnce(1_000)
            .mockReturnValueOnce(31_000)
            .mockReturnValueOnce(62_000);

        reportScmStatusSyncError({
            projectKey: 'machine:/repo',
            error: new Error('snapshot failed'),
        });
        reportScmStatusSyncError({
            projectKey: 'machine:/repo',
            error: new Error('snapshot failed'),
        });

        expect(capture).toHaveBeenCalledTimes(1);

        reportScmStatusSyncError({
            projectKey: 'machine:/repo',
            error: new Error('snapshot failed'),
        });
        expect(capture).toHaveBeenCalledTimes(1);

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

        now.mockReturnValue(62_000);
        reportScmStatusSyncError({
            projectKey: 'machine:/repo',
            error: new Error('retriable failure'),
        });

        expect(capture).toHaveBeenCalledTimes(514);
    });
});
