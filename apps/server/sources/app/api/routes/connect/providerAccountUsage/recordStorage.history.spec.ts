import { describe, expect, it, vi } from 'vitest';
import { prismaRuntime, type TransactionClient } from '@/storage/prisma';
import { readProviderAccountUsageHistoryPageRows } from './recordStorage';

describe('provider usage history row capture', () => {
    it('pages rows without a PostgreSQL JSONB relation aggregate', async () => {
        const entries = [1, 2, 3].map(value => ({ id: `observation-${value}`, observedAt: new Date(value), payload: { value } }));
        // Prisma is the storage boundary. PostgreSQL rejects the relation aggregate
        // before returning rows when accepted payloads exceed its JSONB array limit.
        const findUnique = vi.fn().mockRejectedValue(new prismaRuntime.PrismaClientUnknownRequestError(
            'Error querying the database: PostgresError { code: "54000", message: "total size of jsonb array elements exceeds the maximum of 268435455 bytes" }',
            { clientVersion: '6.19.2' },
        ));
        const findMany = vi.fn().mockResolvedValue(entries);
        const storage = { providerAccountUsageRecord: { findUnique }, providerAccountUsageHistory: { findMany } } as unknown as
            Pick<TransactionClient, 'providerAccountUsageRecord' | 'providerAccountUsageHistory'>;
        await expect(readProviderAccountUsageHistoryPageRows({ accountId: 'owner', recordId: 'record',
            history: { range: { startAtMs: 0, endAtMs: 10 }, pageSize: 2 } }, storage))
            .resolves.toEqual({ entries: entries.slice(0, 2), nextCursor: { id: 'observation-2', observedAtMs: 2 } });
        expect(findMany).toHaveBeenCalledTimes(1);
        expect(findUnique).not.toHaveBeenCalled();
    });
});
