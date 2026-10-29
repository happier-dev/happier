import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDbMocks, installDbModuleMock } from '../../api/testkit/dbMocks';

const globalLockInsert = vi.fn();
const globalLockUpdateMany = vi.fn();
const globalLockFindUnique = vi.fn();
const globalLockDeleteMany = vi.fn();

const dbMocks = createDbMocks({
    globalLock: ["updateMany", "findUnique", "deleteMany"],
} as const);

dbMocks.db.globalLock.updateMany.mockImplementation((...args: any[]) => globalLockUpdateMany(...args));
dbMocks.db.globalLock.findUnique.mockImplementation((...args: any[]) => globalLockFindUnique(...args));
dbMocks.db.globalLock.deleteMany.mockImplementation((...args: any[]) => globalLockDeleteMany(...args));

installDbModuleMock({
    db: { ...dbMocks.db, $executeRaw: globalLockInsert },
    isPrismaErrorCode: (error: unknown, code: string) => {
        if (!error || typeof error !== 'object') {
            return false;
        }
        return (error as { code?: unknown }).code === code;
    },
});

vi.mock('@/utils/keys/randomKeyNaked', () => ({
    randomKeyNaked: vi.fn(() => 'lock-value'),
}));

describe('acquireRetentionSweepLock', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        globalLockDeleteMany.mockResolvedValue({ count: 1 });
    });

    it('rethrows insertion errors instead of trying to steal the lock', async () => {
        const createError = Object.assign(new Error('database unavailable'), { code: 'P1001' });
        globalLockInsert.mockRejectedValueOnce(createError);

        const { acquireRetentionSweepLock } = await import('./retentionSweepLock');

        await expect(acquireRetentionSweepLock({ ttlMs: 60_000 })).rejects.toBe(createError);
        expect(globalLockUpdateMany).not.toHaveBeenCalled();
        expect(globalLockFindUnique).not.toHaveBeenCalled();
    });

    it('steals an expired lock when insertion reports an existing row', async () => {
        globalLockInsert.mockResolvedValueOnce(0);
        globalLockUpdateMany.mockResolvedValueOnce({ count: 1 });
        globalLockFindUnique.mockResolvedValueOnce({ value: 'lock-value' });

        const { acquireRetentionSweepLock } = await import('./retentionSweepLock');

        const lock = await acquireRetentionSweepLock({
            ttlMs: 60_000,
            now: new Date('2026-01-01T00:00:00.000Z'),
        });

        expect(globalLockUpdateMany).toHaveBeenCalledWith({
            where: {
                key: 'server.retention.sweep',
                expiresAt: { lt: new Date('2026-01-01T00:00:00.000Z') },
            },
            data: {
                value: 'lock-value',
                expiresAt: new Date('2026-01-01T00:01:00.000Z'),
            },
        });
        expect(lock).not.toBeNull();

        await lock?.release();

        expect(globalLockDeleteMany).toHaveBeenCalledWith({
            where: {
                key: 'server.retention.sweep',
                value: 'lock-value',
            },
        });
    });
});
