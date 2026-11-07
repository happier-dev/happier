import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineReplaced } from '@/sync/domains/machines/identity/machineIdentityTypes';

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
    if (isMachineReplaced(machine)) return false;

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

/** Next presence transition; consumers register this deadline with the shared runtime clock. */
export function readMachineStatusNextRefreshAtMs(machine: Machine, nowMs: number = Date.now()): number | null {
    if (!isMachineOnline(machine, nowMs)) return null;
    const graceMs = readMachineOnlineGraceMsFromEnv();
    const activeAt = typeof machine.activeAt === 'number' ? machine.activeAt : 0;
    if (graceMs <= 0 || !activeAt || !Number.isFinite(activeAt)) return null;
    // Online includes the grace boundary, so the first offline instant is one millisecond later.
    const deadline = activeAt + graceMs + 1;
    return Number.isFinite(deadline) && deadline > nowMs ? deadline : null;
}

export function getMachineDisplayName(
    machine:
        | Readonly<{ id?: string | null; metadata?: Readonly<{ displayName?: string | null; host?: string | null }> | null }>
        | null
        | undefined,
): string | null {
    const displayName = typeof machine?.metadata?.displayName === 'string' ? machine.metadata.displayName.trim() : '';
    if (displayName) return displayName;

    const host = typeof machine?.metadata?.host === 'string' ? machine.metadata.host.trim() : '';
    if (host) return host;

    const id = typeof machine?.id === 'string' ? machine.id.trim() : '';
    return id || null;
}
