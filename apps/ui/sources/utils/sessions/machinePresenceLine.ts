import { t } from '@/text';
import { getMachineDisplayName, isMachineOnline } from '@/utils/sessions/machineUtils';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { resolveMachineReachability, type MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';
import { formatLastSeen } from '@/utils/sessions/sessionUtils';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveManagedMachineWorkStatus, resolveWorkStatusTone, type WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import { readMachineActivity } from '@/sync/domains/machines/machineActivity';
import type { MachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
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
    machine: Pick<MachinePresenceV1, 'revokedAt'> & Readonly<{ id?: string }>
        & Partial<Pick<MachineDisplayRenderable, 'activity' | 'metadata' | 'managedMachineRef' | 'availability' | 'managedInputRuntime' | 'replacedByMachineId'>>,
    managedMachine?: ManagedMachineV1 | null,
): MachineManagedPresence | null {
    if (!managedMachine && !machine.managedInputRuntime?.state) return null;
    const read = (online: boolean): ManagedPresenceOverride | null => {
        const status = resolveManagedMachineWorkStatus({ online, managedMachine, machineId: machine.id, revokedAt: machine.revokedAt,
            nativeState: machine.managedInputRuntime?.state,
            machineName: getMachineDisplayName({ ...machine, managedName: managedMachine?.launch?.name }) });
        return status ? { state: status.state, word: status.word } : null;
    };
    const online = read(true);
    const offline = read(false);
    return online || offline ? { online, offline } : null;
}

/** One presentation of the selected presence and native lifecycle facts, with its one recovery. */
export type MachineRuntimePresence = MachinePresenceLine & Readonly<{
    nextAction: 'retry' | null;
    showStatus: boolean;
    /** The selected native lifecycle word, independent of daemon connectivity. */
    nativeWord?: string | null;
}>;

function presentMachinePresence(input: Readonly<{
    reachability: 'reachable' | 'unreachable' | 'unknown';
    presenceOnline: boolean | null;
    lastSeenAt: number | null;
    managed: ManagedPresenceOverride | null;
}>): MachineRuntimePresence {
    const online = input.reachability === 'reachable';
    const word = input.reachability === 'unknown' ? '' : online ? t('settingsOverview.machineOnline')
        : input.presenceOnline !== false ? t('settingsOverview.machineUnreachableFromHome')
            : t('settingsOverview.machineOffline', { lastSeen: formatLastSeen(input.lastSeenAt ?? 0) });
    const presentation = input.managed ?? resolveWorkStatusTone({ kind: 'machine', facts: {
        online: input.reachability === 'unknown' ? null : online, word, needsYouCount: 0, runningSessionCount: 0,
    } });
    const resourceAbsent = presentation.state === 'resource_absent';
    return {
        online: online && !resourceAbsent,
        status: resourceAbsent ? 'offline' : input.reachability === 'unknown' ? 'unknown' : online ? 'online' : 'offline',
        label: presentation.word,
        nativeWord: input.managed?.word ?? null,
        nextAction: !input.managed && input.reachability === 'unreachable' ? 'retry' : null,
        showStatus: Boolean(input.managed) || input.reachability === 'unreachable',
    };
}

/** Project/Services consume the same words as machine rows, without retaining protected inventory. */
export function describeMachinePresenceSummary(summary: MachinePresenceSummary): MachineRuntimePresence {
    return presentMachinePresence({ reachability: summary.reachability,
        presenceOnline: summary.presenceOnline ?? null,
        lastSeenAt: summary.lastSeenAt ?? null,
        managed: resolveManagedMachineWorkStatus({ online: summary.reachability === 'reachable',
            nativeState: summary.nativeState, machineName: summary.name ?? '' }),
    });
}

export function describeMachineRuntimePresence(
    machine: MachinePresenceV1 & Readonly<{ id?: string; presence?: null }>
        & Partial<Pick<MachineDisplayRenderable, 'activity' | 'metadata' | 'managedMachineRef' | 'availability' | 'managedInputRuntime' | 'replacedByMachineId'>>,
    nowMs?: number,
    managedPresence?: MachineManagedPresence | null,
    scope?: MachineReachabilityScope | null,
    connection?: 'reachable' | 'unreachable' | 'unknown',
): MachineRuntimePresence {
    if (machine.presence === null) return { online: false, status: 'unknown', label: '', nextAction: null, showStatus: false, nativeWord: null };
    const activity = readMachineActivity(machine);
    // Keep the admitted row identity so the activity owner's unanswered presence is preserved.
    const reachability = connection ?? (machine.id
        ? resolveMachineReachability(scope, machine as MachinePresenceV1 & Readonly<{ id: string }>, nowMs)
        : 'unknown');
    const nativePresence = managedPresence ?? projectMachineManagedPresence(machine);
    return presentMachinePresence({ reachability, presenceOnline: isMachineOnline(machine, nowMs),
        lastSeenAt: activity.activeAt ?? null,
        managed: nativePresence?.[reachability === 'reachable' ? 'online' : 'offline'] ?? null,
    });
}

/** Existing row API retains only the rendered line; recovery consumers use the same owner's full result. */
export function describeMachinePresenceLine(
    ...args: Parameters<typeof describeMachineRuntimePresence>
): MachinePresenceLine {
    const { online, status, label } = describeMachineRuntimePresence(...args);
    return { online, status, label };
}
