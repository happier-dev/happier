import { t } from '@/text';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { resolveMachineReachability, type MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';
import { formatLastSeen } from '@/utils/sessions/sessionUtils';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveManagedMachineWorkStatus, resolveWorkStatusTone, type WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import { readMachineActivity } from '@/sync/domains/machines/machineActivity';
import type { MachinePresenceV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';

export type MachinePresenceLine = Readonly<{
    online: boolean;
    status: 'online' | 'offline' | 'unknown';
    /** Native retained power when known, otherwise ordinary connectivity/last-seen. */
    label: string;
}>;

type ManagedPresenceOverride = Pick<WorkStatusPresentation, 'state' | 'word'>;
export type MachineManagedPresence = Readonly<{
    online: ManagedPresenceOverride | null;
    offline: ManagedPresenceOverride | null;
}>;

/** Retain native status words, rather than the protected managed inventory row, in rendered rows. */
export function projectMachineManagedPresence(
    machine: Pick<MachinePresenceV1, 'revokedAt'> & Readonly<{ id?: string }>,
    managedMachine?: ManagedMachineV1 | null,
): MachineManagedPresence | null {
    if (!managedMachine) return null;
    const read = (online: boolean): ManagedPresenceOverride | null => {
        const status = resolveManagedMachineWorkStatus({ online, managedMachine, machineId: machine.id, revokedAt: machine.revokedAt });
        return status ? { state: status.state, word: status.word } : null;
    };
    const online = read(true);
    const offline = read(false);
    return online || offline ? { online, offline } : null;
}

/**
 * The presence half of a machine's status line, shared by every surface that lists machines with a
 * status line (the home hub's Machines section, the machine picker rows), so a machine reads the
 * same wherever it appears. Callers append their own facts after it ("· Update available").
 */
export function describeMachinePresenceLine(
    machine: MachinePresenceV1 & Readonly<{ id?: string; presence?: null }>,
    nowMs?: number,
    managedPresence?: MachineManagedPresence | null,
    scope?: MachineReachabilityScope | null,
): MachinePresenceLine {
    if (machine.presence === null) return { online: false, status: 'unknown', label: '' };
    const activity = readMachineActivity(machine);
    const reachability = machine.id ? resolveMachineReachability(scope, { ...machine, ...activity, id: machine.id }, nowMs) : 'unknown';
    const presenceOnline = isMachineOnline(machine, nowMs);
    const online = reachability === 'reachable';
    // A fresh heartbeat with a failed request from this Home is a live machine this Home cannot
    // reach, not an offline one ("Offline · last seen just now" contradicts itself). "Offline"
    // stays for a stale heartbeat.
    const word = reachability === 'unknown' ? t('common.unknown') : online ? t('settingsOverview.machineOnline')
        : presenceOnline
            ? t('settingsOverview.machineUnreachableFromHome')
            : t('settingsOverview.machineOffline', { lastSeen: formatLastSeen(activity.activeAt ?? 0) });
    const presentation = managedPresence?.[online ? 'online' : 'offline'] ?? resolveWorkStatusTone({ kind: 'machine', facts: {
            online: reachability === 'unknown' ? null : online, word, needsYouCount: 0, runningSessionCount: 0,
        } });
    const resourceAbsent = presentation.state === 'resource_absent';
    return {
        online: online && !resourceAbsent,
        status: resourceAbsent ? 'offline' : reachability === 'unknown' ? 'unknown' : online ? 'online' : 'offline',
        label: presentation.word,
    };
}
