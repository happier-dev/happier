import { DEFAULT_MACHINE_ONLINE_GRACE_MS, isMachineOnlineV1, readMachinePresenceNextRefreshAtMsV1,
    type MachinePresenceV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { noteMachinePresenceLapse, readMachineActivity } from '@/sync/domains/machines/machineActivity';

let cachedGraceEnvRaw: string | null = null;
let cachedGraceEnvMs = DEFAULT_MACHINE_ONLINE_GRACE_MS;

export function readMachineOnlineGraceMsFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS ?? '').trim();
    if (raw === cachedGraceEnvRaw) return cachedGraceEnvMs;
    const parsed = Number.parseInt(raw, 10);
    cachedGraceEnvRaw = raw;
    cachedGraceEnvMs = !raw || !Number.isFinite(parsed) ? DEFAULT_MACHINE_ONLINE_GRACE_MS : Math.max(0, parsed);
    return cachedGraceEnvMs;
}

export function isMachineOnline(
    machine: MachinePresenceV1,
    nowMs = Date.now(),
): boolean {
    const activity = readMachineActivity(machine);
    const presence = { active: activity.active, activeAt: activity.activeAt, revokedAt: machine.revokedAt,
        presenceProtocolVersion: machine.presenceProtocolVersion };
    const graceMs = readMachineOnlineGraceMsFromEnv();
    const online = isMachineOnlineV1(presence, nowMs, graceMs);
    // A client-side grace lapse is a presence change with no arrival; the presence owner publishes it.
    const lapseAtMs = online ? readMachinePresenceNextRefreshAtMsV1(presence, nowMs, graceMs) : null;
    if (lapseAtMs !== null) noteMachinePresenceLapse(lapseAtMs, nowMs);
    return online;
}

export function readMachineStatusNextRefreshAtMs(machine: MachinePresenceV1, nowMs: number): number | null {
    const activity = readMachineActivity(machine);
    return readMachinePresenceNextRefreshAtMsV1({ active: activity.active, activeAt: activity.activeAt, revokedAt: machine.revokedAt,
        presenceProtocolVersion: machine.presenceProtocolVersion }, nowMs, readMachineOnlineGraceMsFromEnv());
}

export type MachinePresenceCounts = Readonly<{ online: number; offline: number; unknown: number }>;

export { getMachineDisplayName, resolveMachineDisplayNames } from './machineDisplayNames';
