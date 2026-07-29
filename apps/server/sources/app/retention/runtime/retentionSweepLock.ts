import { acquireGlobalLock } from '@/storage/globalLock';

const RETENTION_SWEEP_LOCK_KEY = 'server.retention.sweep';
export async function acquireRetentionSweepLock(params: {
    ttlMs: number;
    now?: Date;
}): Promise<{ release: () => Promise<void> } | null> {
    return acquireGlobalLock({
        key: RETENTION_SWEEP_LOCK_KEY,
        ttlMs: params.ttlMs,
        now: params.now,
    });
}
