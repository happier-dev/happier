import { beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.fn();
const updateMany = vi.fn();
const findUnique = vi.fn();
const deleteMany = vi.fn();
const randomKeyNaked = vi.fn(() => 'retention-lock-value');

vi.mock('@/storage/db', () => ({
    db: {
        globalLock: {
            create,
            updateMany,
            findUnique,
            deleteMany,
        },
    },
}));

vi.mock('@/utils/keys/randomKeyNaked', () => ({
    randomKeyNaked,
}));

describe('retentionSweepLock', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        randomKeyNaked.mockReturnValue('retention-lock-value');
    });

    it('creates a new lock and releases it with the generated value', async () => {
        create.mockResolvedValueOnce({});
        deleteMany.mockResolvedValueOnce({ count: 1 });

        const { acquireRetentionSweepLock } = await import('./retentionSweepLock');
        const lock = await acquireRetentionSweepLock({
            ttlMs: 10_000,
            now: new Date('2026-01-01T00:00:00.000Z'),
        });

        expect(lock).not.toBeNull();
        expect(create).toHaveBeenCalledWith({
            data: {
                key: 'server.retention.sweep',
                value: 'retention-lock-value',
                expiresAt: new Date('2026-01-01T00:00:30.000Z'),
            },
        });

        await lock!.release();

        expect(deleteMany).toHaveBeenCalledWith({
            where: {
                key: 'server.retention.sweep',
                value: 'retention-lock-value',
            },
        });
    });

    it('updates an expired lock when create collides', async () => {
        create.mockRejectedValueOnce(new Error('duplicate'));
        updateMany.mockResolvedValueOnce({ count: 1 });
        findUnique.mockResolvedValueOnce({ value: 'retention-lock-value' });

        const { acquireRetentionSweepLock } = await import('./retentionSweepLock');
        const lock = await acquireRetentionSweepLock({
            ttlMs: 60_000,
            now: new Date('2026-01-01T00:00:00.000Z'),
        });

        expect(lock).not.toBeNull();
        expect(updateMany).toHaveBeenCalledWith({
            where: {
                key: 'server.retention.sweep',
                expiresAt: { lt: new Date('2026-01-01T00:00:00.000Z') },
            },
            data: {
                value: 'retention-lock-value',
                expiresAt: new Date('2026-01-01T00:01:00.000Z'),
            },
        });
        expect(findUnique).toHaveBeenCalledWith({
            where: { key: 'server.retention.sweep' },
            select: { value: true },
        });

        await lock!.release();

        expect(deleteMany).toHaveBeenCalledWith({
            where: {
                key: 'server.retention.sweep',
                value: 'retention-lock-value',
            },
        });
    });
});
