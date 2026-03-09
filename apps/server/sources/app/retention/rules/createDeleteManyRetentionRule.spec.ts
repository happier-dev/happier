import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RetentionPolicy } from '@/app/retention/config/retentionPolicyTypes';

const findMany = vi.fn();
const deleteMany = vi.fn();

vi.mock('@/storage/db', () => ({
    db: {
        globalLock: {
            findMany,
            deleteMany,
        },
    },
}));

function createPolicy(): RetentionPolicy {
    return {
        enabled: true,
        intervalMs: 60_000,
        batchSize: 100,
        dryRun: false,
        maxDeletesPerRulePerRun: 100,
        domains: {
            sessions: { mode: 'keep_forever' },
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

describe('createDeleteManyRetentionRule', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('re-checks the cutoff in deleteMany so refreshed rows are not deleted after candidate selection', async () => {
        findMany.mockResolvedValueOnce([{ key: 'retention-lock' }]);
        deleteMany.mockResolvedValueOnce({ count: 0 });

        const { createDeleteManyRetentionRule } = await import('./createDeleteManyRetentionRule');
        const rule = createDeleteManyRetentionRule({
            id: 'globalLocks',
            modelName: 'globalLock',
            primaryField: 'key',
            cutoffField: 'expiresAt',
        });

        await rule.run({
            policy: createPolicy(),
            batchSize: 10,
            dryRun: false,
            maxDeletesPerRulePerRun: 10,
            now: new Date('2025-01-08T00:00:00.000Z'),
        });

        expect(deleteMany).toHaveBeenCalledWith({
            where: {
                key: { in: ['retention-lock'] },
                expiresAt: { lt: new Date('2025-01-01T00:00:00.000Z') },
            },
        });
    });
});
