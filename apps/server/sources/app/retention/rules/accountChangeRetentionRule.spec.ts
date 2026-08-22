import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDbMocks, createDbTransactionMock, installDbModuleMock } from '../../api/testkit/dbMocks';
import { applyEnvValues, restoreEnv, snapshotEnv } from '@/testkit/env';

const findMany = vi.fn();
const deleteMany = vi.fn();
const updateMany = vi.fn();
const executeRawUnsafe = vi.fn();
const envSnapshot = snapshotEnv();

const dbMocks = createDbMocks({
    accountChange: ["findMany", "deleteMany"],
    account: ["updateMany"],
} as const);
const dbTransactionMock = createDbTransactionMock(() => ({
    ...dbMocks.db,
    $executeRawUnsafe: (...args: unknown[]) => executeRawUnsafe(...args),
}));

dbMocks.db.accountChange.findMany.mockImplementation((...args: any[]) => findMany(...args));
dbMocks.db.accountChange.deleteMany.mockImplementation((...args: any[]) => deleteMany(...args));
dbMocks.db.account.updateMany.mockImplementation((...args: any[]) => updateMany(...args));

installDbModuleMock({ db: dbTransactionMock.wrapDb(dbMocks.db) });

let retentionRule: typeof import('./accountChangeRetentionRule');

describe('accountChangeRetentionRule', () => {
    // `installDbModuleMock` uses `vi.doMock`, which is not hoisted, so the rule
    // can only be imported after the mocks are registered. That first import
    // pulls `@/storage/prisma` — and with it the PGlite/Prisma client graph —
    // which measured 24.2 s and 26.1 s on this host against the unit suite's
    // 20 s `testTimeout`. The cost is paid once for the whole file, so it is
    // loaded here, sized from that measurement, instead of being charged to
    // whichever test happens to run first.
    beforeAll(async () => {
        retentionRule = await import('./accountChangeRetentionRule');
    }, 120_000);

    beforeEach(() => {
        applyEnvValues({
            HAPPY_DB_PROVIDER: undefined,
            HAPPIER_DB_PROVIDER: 'sqlite',
        });
        vi.clearAllMocks();
        dbTransactionMock.transaction.mockClear();
        executeRawUnsafe.mockResolvedValue(1);
    });

    afterEach(() => {
        restoreEnv(envSnapshot);
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

        const { runAccountChangeRetentionRule } = retentionRule;
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
        expect(executeRawUnsafe).toHaveBeenCalledWith(
            'UPDATE "Account" SET "settingsVersion" = "settingsVersion" WHERE "id" = ?',
            'owner-a',
        );
        expect(dbTransactionMock.transaction).toHaveBeenCalledTimes(1);
    });

    it('advances dry-run pages instead of recounting the first candidates', async () => {
        findMany.mockResolvedValueOnce([
            { accountId: 'owner-a', kind: 'session', entityId: 'a-11', cursor: 11 },
            { accountId: 'owner-a', kind: 'session', entityId: 'a-12', cursor: 12 },
        ]);

        const { runAccountChangeRetentionRule } = retentionRule;
        const result = await runAccountChangeRetentionRule({
            cutoff: new Date('2025-01-01T00:00:00.000Z'),
            batchSize: 2,
            dryRun: true,
            dryRunOffset: 10,
            maxDeletesPerRulePerRun: 2,
        });

        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 2 }));
        expect(result).toEqual({ deleted: 2, candidatesExamined: 2, hasMore: true });
        expect(deleteMany).not.toHaveBeenCalled();
    });
});
