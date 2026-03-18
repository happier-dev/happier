import { beforeEach, describe, expect, it, vi } from 'vitest';

const globalLockCreate = vi.fn();
const globalLockUpdateMany = vi.fn();
const globalLockFindUnique = vi.fn();
const globalLockDeleteMany = vi.fn();

vi.mock('@/storage/db', () => ({
    db: {
        globalLock: {
            create: globalLockCreate,
            updateMany: globalLockUpdateMany,
            findUnique: globalLockFindUnique,
            deleteMany: globalLockDeleteMany,
        },
    },
    isPrismaErrorCode: (error: unknown, code: string) => {
        if (!error || typeof error !== 'object') {
            return false;
        }
        return (error as { code?: unknown }).code === code;
    },
}));

vi.mock('@/utils/keys/randomKeyNaked', () => ({
    randomKeyNaked: vi.fn(() => 'lock-value'),
}));

describe('acquireRetentionSweepLock', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        globalLockDeleteMany.mockResolvedValue({ count: 1 });
    });

    it('rethrows non-conflict create errors instead of trying to steal the lock', async () => {
        const createError = Object.assign(new Error('database unavailable'), { code: 'P1001' });
        globalLockCreate.mockRejectedValueOnce(createError);

        const { acquireRetentionSweepLock } = await import('./retentionSweepLock');

        await expect(acquireRetentionSweepLock({ ttlMs: 60_000 })).rejects.toBe(createError);
        expect(globalLockUpdateMany).not.toHaveBeenCalled();
        expect(globalLockFindUnique).not.toHaveBeenCalled();
    });

    it('steals an expired lock when create fails with a unique conflict', async () => {
        globalLockCreate.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: 'P2002' }));
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
