import type { UsageQuerySourceState } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { describe, expect, it } from 'vitest';
import { canRetryUsageCoverageFailure } from './usageReadFailure';

describe('Work coverage recovery', () => {
    const cases = [
        { name: 'only refused Sessions', errorCode: 'work_evidence_failed', unreadSessions: { not_entitled: 2 }, retryable: false },
        { name: 'only failed Sessions', errorCode: 'work_evidence_failed', unreadSessions: { failed: 2 }, retryable: true },
        { name: 'only timed-out Sessions', unreadSessions: { timed_out: 2 }, retryable: true },
        { name: 'refused and failed Sessions', errorCode: 'work_evidence_failed', unreadSessions: { not_entitled: 1, failed: 1 }, retryable: true },
        { name: 'only unreachable Machines', errorCode: 'machine_offline', unreadSessions: { machine_unavailable: 2 }, retryable: false },
        { name: 'refused Sessions and unreachable Machines', errorCode: 'work_evidence_failed', unreadSessions: { not_entitled: 1, machine_unavailable: 1 }, retryable: false },
    ] satisfies readonly (Pick<UsageQuerySourceState, 'unreadSessions' | 'errorCode'> & { name: string; retryable: boolean })[];

    it.each(cases)('decides Retry for a settled partial read with $name', ({ name: _name, retryable, ...gap }) => {
        expect(canRetryUsageCoverageFailure({ source: 'work', status: 'partial', ...gap })).toBe(retryable);
    });
});
