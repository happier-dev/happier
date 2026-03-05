import type { Machine } from '@/sync/domains/state/storageTypes';

const DEFAULT_MACHINE_ONLINE_GRACE_MS = 60_000;
const MAX_MACHINE_ONLINE_GRACE_MS = 5 * 60_000;

let cachedGraceEnvRaw: string | null = null;
let cachedGraceEnvMs: number = DEFAULT_MACHINE_ONLINE_GRACE_MS;

function readMachineOnlineGraceMsFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS ?? '').trim();
    if (raw === cachedGraceEnvRaw) return cachedGraceEnvMs;

    // Must exceed the daemon keep-alive interval to avoid presence flicker.
    if (!raw) {
        cachedGraceEnvRaw = raw;
        cachedGraceEnvMs = DEFAULT_MACHINE_ONLINE_GRACE_MS;
        return cachedGraceEnvMs;
    }
    const parsed = Number.parseInt(raw, 10);
    const clamped = !Number.isFinite(parsed)
        ? DEFAULT_MACHINE_ONLINE_GRACE_MS
        : Math.max(0, Math.min(MAX_MACHINE_ONLINE_GRACE_MS, parsed));

    cachedGraceEnvRaw = raw;
    cachedGraceEnvMs = clamped;
    return cachedGraceEnvMs;
}

export function isMachineOnline(machine: Machine, nowMs: number = Date.now()): boolean {
    const revokedAt = machine.revokedAt;
    if (typeof revokedAt === 'number' && Number.isFinite(revokedAt) && revokedAt > 0) {
        return false;
    }

    const graceMs = readMachineOnlineGraceMsFromEnv();
    if (graceMs <= 0) return machine.active === true;
    const activeAt = typeof machine.activeAt === 'number' ? machine.activeAt : 0;
    if (!activeAt || !Number.isFinite(activeAt)) return machine.active === true;
    const ageMs = Math.max(0, nowMs - activeAt);
    return ageMs <= graceMs;
}
