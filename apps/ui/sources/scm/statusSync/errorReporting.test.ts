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

    it('tracks normalized source-control status sync failures without exposing raw project paths', () => {
        reportScmStatusSyncError({
            projectKey: 'machine:/repo',
            error: Object.assign(new Error('snapshot failed'), { scmErrorCode: 'COMMAND_FAILED' }),
        });

        expect(capture).toHaveBeenCalledTimes(1);
        const payload = capture.mock.calls[0]?.[1];
        expect(capture.mock.calls[0]?.[0]).toBe('scm_status_sync_failed');
        expect(payload).toMatchObject({
            projectScope: 'machine',
            message: 'snapshot failed',
            errorCode: 'COMMAND_FAILED',
        });
        expect(payload.projectFingerprint).toMatch(/^[0-9a-f]{8}$/);
        expect(payload.projectFingerprint).not.toContain('/repo');
        expect(payload.projectKey).toBeUndefined();
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
