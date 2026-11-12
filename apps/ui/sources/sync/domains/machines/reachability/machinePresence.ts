import { DEFAULT_MACHINE_ONLINE_GRACE_MS, isMachineOnlineV1, readMachinePresenceNextRefreshAtMsV1, type MachinePresenceV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { noteMachinePresenceLapse, readMachineActivity, readMachinePresenceAnswer, type MachineActivityFacts } from '../machineActivity';

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

export function resolveMachinePresence(
    machine: MachinePresenceV1 & MachineActivityFacts,
    nowMs = Date.now(),
): 'online' | 'offline' | 'unknown' {
    if (typeof machine.revokedAt === 'number' && machine.revokedAt > 0) return 'offline';
    if (!readMachinePresenceAnswer(machine)) return 'unknown';
    const activity = readMachineActivity(machine);
    const presence = { active: activity.active, activeAt: activity.activeAt, revokedAt: machine.revokedAt,
        presenceProtocolVersion: machine.presenceProtocolVersion };
    const graceMs = readMachineOnlineGraceMsFromEnv();
    const online = isMachineOnlineV1(presence, nowMs, graceMs);
    // A client-side grace lapse is a presence change with no arrival; the presence owner publishes it.
    const lapseAtMs = online ? readMachinePresenceNextRefreshAtMsV1(presence, nowMs, graceMs) : null;
    if (lapseAtMs !== null) noteMachinePresenceLapse(lapseAtMs, nowMs);
    return online ? 'online' : 'offline';
}

export function readMachineStatusNextRefreshAtMs(machine: MachinePresenceV1 & MachineActivityFacts, nowMs: number): number | null {
    if (!readMachinePresenceAnswer(machine)) return null;
    const activity = readMachineActivity(machine);
    return readMachinePresenceNextRefreshAtMsV1({ active: activity.active, activeAt: activity.activeAt, revokedAt: machine.revokedAt,
        presenceProtocolVersion: machine.presenceProtocolVersion }, nowMs, readMachineOnlineGraceMsFromEnv());
}

/** Compatibility adapter: null is an unanswered presence, never offline. */
export function isMachineOnline(machine: MachinePresenceV1 & MachineActivityFacts, nowMs?: number): boolean | null {
    const presence = resolveMachinePresence(machine, nowMs);
    return presence === 'unknown' ? null : presence === 'online';
}
