import type { Machine } from '@/sync/domains/state/storageTypes';

function readMachineOnlineGraceMsFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS ?? '').trim();
    // Must exceed the daemon keep-alive interval to avoid presence flicker.
    if (!raw) return 30_000;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 30_000;
    return Math.max(0, Math.min(5 * 60_000, parsed));
}

export function isMachineOnline(machine: Machine, nowMs: number = Date.now()): boolean {
    const revokedAt = machine.revokedAt;
    if (typeof revokedAt === 'number' && Number.isFinite(revokedAt) && revokedAt > 0) {
        return false;
    }

    // If the server reports the machine as active, prefer that signal.
    if (machine.active) return true;

    const graceMs = readMachineOnlineGraceMsFromEnv();
    if (graceMs <= 0) return false;
    const activeAt = typeof machine.activeAt === 'number' ? machine.activeAt : 0;
    if (!activeAt || !Number.isFinite(activeAt)) return false;
    const ageMs = Math.max(0, nowMs - activeAt);
    return ageMs <= graceMs;
}
