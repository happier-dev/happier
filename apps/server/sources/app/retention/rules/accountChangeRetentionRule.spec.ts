import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();
const deleteMany = vi.fn();
const updateMany = vi.fn();

vi.mock('@/storage/db', () => ({
    db: {
        accountChange: {
            findMany,
            deleteMany,
        },
        account: {
            updateMany,
        },
    },
}));

describe('accountChangeRetentionRule', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('advances changesFloor only to the highest cursor that was actually deleted', async () => {
        findMany.mockResolvedValueOnce([
            { accountId: 'owner-a', kind: 'session', entityId: 'a-1', cursor: 1 },
            { accountId: 'owner-a', kind: 'session', entityId: 'a-2', cursor: 2 },
        ]);
        deleteMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 });
        updateMany.mockResolvedValueOnce({ count: 1 });

        const { runAccountChangeRetentionRule } = await import('./accountChangeRetentionRule');
        const result = await runAccountChangeRetentionRule({
            cutoff: new Date('2025-01-01T00:00:00.000Z'),
            batchSize: 10,
            dryRun: false,
            maxDeletesPerRulePerRun: 10,
        });

        expect(result.deleted).toBe(1);
        expect(deleteMany).toHaveBeenNthCalledWith(1, {
            where: {
                accountId: 'owner-a',
                kind: 'session',
                entityId: 'a-1',
                cursor: 1,
                changedAt: { lt: new Date('2025-01-01T00:00:00.000Z') },
            },
        });
        expect(deleteMany).toHaveBeenNthCalledWith(2, {
            where: {
                accountId: 'owner-a',
                kind: 'session',
                entityId: 'a-2',
                cursor: 2,
                changedAt: { lt: new Date('2025-01-01T00:00:00.000Z') },
            },
        });
        expect(updateMany).toHaveBeenCalledWith({
            where: {
                id: 'owner-a',
                changesFloor: { lt: 1 },
            },
            data: {
                changesFloor: 1,
            },
        });
    });
});
