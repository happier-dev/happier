import { isMachineReplaced } from '@happier-dev/protocol';

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

export function isMachineOnline(
    machine: Readonly<{
        active: boolean;
        activeAt?: number | null;
        revokedAt?: number | null;
    }>,
    nowMs: number = Date.now(),
): boolean {
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

/** Next presentation change from these presence facts, using the same grace owner as online status. */
export function readMachineStatusNextRefreshAtMs(
    machine: Parameters<typeof isMachineOnline>[0],
    nowMs: number,
): number | null {
    if (!isMachineOnline(machine, nowMs)) return null;
    const graceMs = readMachineOnlineGraceMsFromEnv();
    const activeAt = machine.activeAt;
    if (graceMs <= 0 || typeof activeAt !== 'number' || !Number.isFinite(activeAt) || activeAt === 0) return null;
    const expiresAtMs = activeAt + graceMs + 1;
    return expiresAtMs > nowMs ? expiresAtMs : null;
}

export type MachinePresenceCounts = Readonly<{ online: number; offline: number }>;

/**
 * How many of these machines are online and how many are not, by `isMachineOnline` (replaced
 * identities left out): the one count
 * behind every "2 online · 1 offline" (the Machines rail tooltip, its popover, Home's Machines
 * section, the Settings Machines row).
 */
export function countMachinePresence(
    machines: ReadonlyArray<Parameters<typeof isMachineOnline>[0] & Readonly<{ replacedByMachineId?: string | null }>>,
    nowMs: number = Date.now(),
): MachinePresenceCounts {
    let online = 0;
    let offline = 0;
    for (const machine of machines) {
        // An identity replaced by a newer one (a reinstall) is that machine's past, not an offline machine.
        if (isMachineReplaced(machine)) continue;
        if (isMachineOnline(machine, nowMs)) online += 1;
        else offline += 1;
    }
    return { online, offline };
}

export { getMachineDisplayName, resolveMachineDisplayNames } from './machineDisplayNames';
