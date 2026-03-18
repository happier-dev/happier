import { db } from '@/storage/db';
import { randomKeyNaked } from '@/utils/keys/randomKeyNaked';

const RETENTION_SWEEP_LOCK_KEY = 'server.retention.sweep';
const MIN_RETENTION_SWEEP_LOCK_TTL_MS = 30_000;

export async function acquireRetentionSweepLock(params: {
    ttlMs: number;
    now?: Date;
}): Promise<{ release: () => Promise<void> } | null> {
    const now = params.now ?? new Date();
    const ttlMs = Math.max(MIN_RETENTION_SWEEP_LOCK_TTL_MS, params.ttlMs);
    const expiresAt = new Date(now.getTime() + ttlMs);
    const value = randomKeyNaked(16);

    try {
        await db.globalLock.create({
            data: {
                key: RETENTION_SWEEP_LOCK_KEY,
                value,
                expiresAt,
            },
        });
        return {
            release: async () => {
                await db.globalLock.deleteMany({
                    where: {
                        key: RETENTION_SWEEP_LOCK_KEY,
                        value,
                    },
                }).catch(() => {});
            },
        };
    } catch {
        const updated = await db.globalLock.updateMany({
            where: {
                key: RETENTION_SWEEP_LOCK_KEY,
                expiresAt: { lt: now },
            },
            data: {
                value,
                expiresAt,
            },
        });
        if (updated.count !== 1) return null;

        const current = await db.globalLock.findUnique({
            where: { key: RETENTION_SWEEP_LOCK_KEY },
            select: { value: true },
        });
        if (!current || current.value !== value) return null;

        return {
            release: async () => {
                await db.globalLock.deleteMany({
                    where: {
                        key: RETENTION_SWEEP_LOCK_KEY,
                        value,
                    },
                }).catch(() => {});
            },
        };
    }
}
