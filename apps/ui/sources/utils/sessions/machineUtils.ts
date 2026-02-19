import type { Machine } from '@/sync/domains/state/storageTypes';

function readMachineOnlineGraceMsFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS ?? '').trim();
    if (!raw) return 10_000;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 10_000;
    return Math.max(0, Math.min(5 * 60_000, parsed));
}

export function isMachineOnline(machine: Machine, nowMs: number = Date.now()): boolean {
    const revokedAt = machine.revokedAt;
    if (typeof revokedAt === 'number' && Number.isFinite(revokedAt) && revokedAt > 0) {
        return false;
    }

    if (machine.active) return true;

    // Avoid short-lived presence flicker: treat machines as reachable for a small grace window.
    const graceMs = readMachineOnlineGraceMsFromEnv();
    if (graceMs <= 0) return false;
    const activeAt = typeof machine.activeAt === 'number' ? machine.activeAt : 0;
    if (!activeAt || !Number.isFinite(activeAt)) return false;
    return (nowMs - activeAt) <= graceMs;
}
