import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RetentionPolicy } from '@/app/retention/config/retentionPolicyTypes';
import { createDbMocks, installDbModuleMock } from '@/app/api/testkit/dbMocks';

const findMany = vi.fn();
const deleteMany = vi.fn();

const dbMocks = createDbMocks({
    globalLock: ['findMany', 'deleteMany'],
    authPairingSession: ['findMany', 'deleteMany'],
    repeatKey: ['findMany', 'deleteMany'],
    automationWorkerClaimReceipt: ['findMany', 'deleteMany'],
    automationRun: ['findMany'],
    automation: ['findMany'],
} as const);

dbMocks.db.globalLock.findMany.mockImplementation((...args: unknown[]) => findMany(...args));
dbMocks.db.globalLock.deleteMany.mockImplementation((...args: unknown[]) => deleteMany(...args));
// Intrinsically expired pairing requests are swept even when their retention mode is keep_forever.
dbMocks.db.authPairingSession.findMany.mockResolvedValue([]);
dbMocks.db.authPairingSession.deleteMany.mockResolvedValue({ count: 0 });
dbMocks.db.repeatKey.findMany.mockResolvedValue([]);
dbMocks.db.repeatKey.deleteMany.mockResolvedValue({ count: 0 });
// Expiry and Account-owned automation retention run independently of operator keep_forever.
dbMocks.db.automationWorkerClaimReceipt.findMany.mockResolvedValue([]);
dbMocks.db.automationWorkerClaimReceipt.deleteMany.mockResolvedValue({ count: 0 });
dbMocks.db.automationRun.findMany.mockResolvedValue([]);
dbMocks.db.automation.findMany.mockResolvedValue([]);
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
            sessionSidechainMessages: { mode: 'keep_forever' },
            accountChanges: { mode: 'keep_forever' },
            usageEvents: { mode: 'keep_forever' },
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
            homeAdministrationEvents: { mode: 'keep_forever' },
        },
    };
}

describe('runRetentionSweep', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('continues through bounded database batches until the per-domain row budget is reached', async () => {
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
        expect(result.details.globalLocks).toMatchObject({
            deleted: 25,
            candidatesExamined: 25,
            batches: 3,
            stopReason: 'row_budget',
        });
    });
});
