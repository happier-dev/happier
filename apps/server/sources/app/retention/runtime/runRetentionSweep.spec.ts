import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RetentionPolicy } from '@/app/retention/config/retentionPolicyTypes';
import { createDbMocks, installDbModuleMock } from '@/app/api/testkit/dbMocks';

const findMany = vi.fn();
const deleteMany = vi.fn();
const repeatKeyFindMany = vi.fn();
const repeatKeyDeleteMany = vi.fn();

const dbMocks = createDbMocks({
    globalLock: ['findMany', 'deleteMany'],
    repeatKey: ['findMany', 'deleteMany'],
} as const);

dbMocks.db.globalLock.findMany.mockImplementation((...args: unknown[]) => findMany(...args));
dbMocks.db.globalLock.deleteMany.mockImplementation((...args: unknown[]) => deleteMany(...args));
dbMocks.db.repeatKey.findMany.mockImplementation((...args: unknown[]) => repeatKeyFindMany(...args));
dbMocks.db.repeatKey.deleteMany.mockImplementation((...args: unknown[]) => repeatKeyDeleteMany(...args));
installDbModuleMock({ db: dbMocks.db });

function createPolicy(): RetentionPolicy {
    return {
        enabled: true,
        intervalMs: 60_000,
        batchSize: 10,
        dryRun: false,
        maxDeletesPerRulePerRun: 25,
        domains: {
            sessions: { mode: 'keep_forever' },
            sessionMessages: { mode: 'keep_forever' },
            sessionSidechainMessages: { mode: 'keep_forever' },
            accountChanges: { mode: 'keep_forever' },
            voiceSessionLeases: { mode: 'keep_forever' },
            userFeedItems: { mode: 'keep_forever' },
            sessionShareAccessLogs: { mode: 'keep_forever' },
            publicShareAccessLogs: { mode: 'keep_forever' },
            terminalAuthRequests: { mode: 'keep_forever' },
            accountAuthRequests: { mode: 'keep_forever' },
            authPairingSessions: { mode: 'keep_forever' },
            repeatKeys: { mode: 'keep_forever' },
            globalLocks: { mode: 'delete_older_than', days: 7 },
            automationRuns: { mode: 'keep_forever' },
            automationRunEvents: { mode: 'keep_forever' },
        },
    };
}

describe('runRetentionSweep', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('continues through bounded transactions until the per-domain run budget is reached', async () => {
        findMany
            .mockResolvedValueOnce(Array.from({ length: 10 }, (_, index) => ({ key: `lock-${index}` })))
            .mockResolvedValueOnce(Array.from({ length: 10 }, (_, index) => ({ key: `lock-${index + 10}` })))
            .mockResolvedValueOnce(Array.from({ length: 5 }, (_, index) => ({ key: `lock-${index + 20}` })));
        deleteMany
            .mockResolvedValueOnce({ count: 10 })
            .mockResolvedValueOnce({ count: 10 })
            .mockResolvedValueOnce({ count: 5 });

        const { runRetentionSweep } = await import('./runRetentionSweep');
        const result = await runRetentionSweep({
            policy: createPolicy(),
            now: new Date('2025-01-08T00:00:00.000Z'),
        });

        expect(result.byRule.globalLocks).toBe(25);
        expect(deleteMany).toHaveBeenCalledTimes(3);
        expect(deleteMany.mock.calls.map(([input]) => input.where.key.in)).toHaveLength(3);
        expect(result.details.globalLocks).toMatchObject({
            deleted: 25,
            candidatesExamined: 25,
            batches: 3,
            stopReason: 'row_budget',
        });
    });

    it('advances through dry-run pages without recounting the first page', async () => {
        findMany
            .mockResolvedValueOnce(Array.from({ length: 10 }, (_, index) => ({ key: `lock-${index}` })))
            .mockResolvedValueOnce(Array.from({ length: 10 }, (_, index) => ({ key: `lock-${index + 10}` })))
            .mockResolvedValueOnce(Array.from({ length: 5 }, (_, index) => ({ key: `lock-${index + 20}` })));

        const { runRetentionSweep } = await import('./runRetentionSweep');
        const result = await runRetentionSweep({
            policy: { ...createPolicy(), dryRun: true },
            now: new Date('2025-01-08T00:00:00.000Z'),
        });

        expect(result.byRule.globalLocks).toBe(25);
        expect(deleteMany).not.toHaveBeenCalled();
        expect(findMany.mock.calls[0]?.[0]).not.toHaveProperty('skip');
        expect(findMany.mock.calls[1]?.[0]).toMatchObject({ skip: 10 });
        expect(findMany.mock.calls[2]?.[0]).toMatchObject({ skip: 20 });
    });

    it('stops between bounded batches when the sweep time budget expires', async () => {
        findMany.mockResolvedValue(Array.from({ length: 10 }, (_, index) => ({ key: `lock-${index}` })));
        deleteMany.mockResolvedValue({ count: 10 });
        const readClockMs = vi.fn(() => deleteMany.mock.calls.length === 0 ? 0 : 2);

        const { runRetentionSweep } = await import('./runRetentionSweep');
        const result = await runRetentionSweep({
            policy: { ...createPolicy(), sweepTimeBudgetMs: 1 },
            now: new Date('2025-01-08T00:00:00.000Z'),
            readClockMs,
        });

        expect(deleteMany).toHaveBeenCalledTimes(1);
        expect(result.details.globalLocks).toMatchObject({
            deleted: 10,
            batches: 1,
            stopReason: 'time_budget',
        });
    });

    it('round-robins active domains between database batches', async () => {
        findMany.mockResolvedValue(Array.from({ length: 10 }, (_, index) => ({ key: `lock-${index}` })));
        deleteMany.mockResolvedValue({ count: 10 });
        repeatKeyFindMany.mockResolvedValue(Array.from({ length: 10 }, (_, index) => ({ key: `repeat-${index}` })));
        repeatKeyDeleteMany.mockResolvedValue({ count: 10 });

        const { runRetentionSweep } = await import('./runRetentionSweep');
        const policy = createPolicy();
        const result = await runRetentionSweep({
            policy: {
                ...policy,
                maxDeletesPerRulePerRun: 20,
                domains: {
                    ...policy.domains,
                    repeatKeys: { mode: 'delete_older_than', days: 7 },
                },
            },
            now: new Date('2025-01-08T00:00:00.000Z'),
        });

        expect(result.byRule.repeatKeys).toBe(20);
        expect(result.byRule.globalLocks).toBe(20);
        expect(repeatKeyDeleteMany).toHaveBeenCalledTimes(2);
        expect(deleteMany).toHaveBeenCalledTimes(2);
        expect(repeatKeyDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(deleteMany.mock.invocationCallOrder[1]!);
        expect(deleteMany.mock.invocationCallOrder[0]).toBeLessThan(repeatKeyDeleteMany.mock.invocationCallOrder[1]!);
    });
});
