import { readMachineActivity } from '@/sync/domains/machines/machineActivity';
import { DEFAULT_MACHINE_ONLINE_GRACE_MS, isMachineOnlineV1, readMachinePresenceNextRefreshAtMsV1, type MachinePresenceV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';

let cachedGraceEnvRaw: string | null = null;
let cachedGraceEnvMs: number = DEFAULT_MACHINE_ONLINE_GRACE_MS;

export function readMachineOnlineGraceMsFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS ?? '').trim();
    if (raw === cachedGraceEnvRaw) return cachedGraceEnvMs;

    // Must exceed the daemon keep-alive interval to avoid presence flicker.
    if (!raw) {
        cachedGraceEnvRaw = raw;
        cachedGraceEnvMs = DEFAULT_MACHINE_ONLINE_GRACE_MS;
        return cachedGraceEnvMs;
    }
    const parsed = Number.parseInt(raw, 10);
    const graceMs = !Number.isFinite(parsed)
        ? DEFAULT_MACHINE_ONLINE_GRACE_MS
        : Math.max(0, parsed);

    cachedGraceEnvRaw = raw;
    cachedGraceEnvMs = graceMs;
    return cachedGraceEnvMs;
}

export function isMachineOnline(
    machine: MachinePresenceV1,
    nowMs: number = Date.now(),
): boolean {
    const activity = readMachineActivity(machine);
    return isMachineOnlineV1({ ...machine, active: activity.active, activeAt: activity.activeAt }, nowMs, readMachineOnlineGraceMsFromEnv());
}

/** Legacy Homes retain the canonical grace boundary; Home-owned presence never arms a client clock. */
export function readMachineStatusNextRefreshAtMs(machine: MachinePresenceV1, nowMs: number): number | null {
    const activity = readMachineActivity(machine);
    return readMachinePresenceNextRefreshAtMsV1({ ...machine, ...activity }, nowMs, readMachineOnlineGraceMsFromEnv());
}

export type MachinePresenceCounts = Readonly<{ online: number; offline: number; unknown: number }>;

export { getMachineDisplayName, resolveMachineDisplayNames } from './machineDisplayNames';
