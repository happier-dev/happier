import * as React from 'react';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { useMachinePresenceSummary } from './useMachinePresenceSummary';
import {
    resolveSessionMachineReachability,
    type SessionMachineReachability,
} from '@/components/sessions/model/resolveSessionMachineReachability';
import { useSessionMachineDisplayIdentity, useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { describeMachinePresenceSummary } from '@/utils/sessions/machinePresenceLine';

export function useSessionReachableMachineTarget(sessionId: string, serverId?: string | null): { machineId: string; basePath: string } | null {
    const resolvedSessionId = normalizeSessionId(sessionId);
    return useSessionMachineTarget(resolvedSessionId, serverId);
}

export function useSessionMachineReachability(sessionId: string, serverId?: string | null): Readonly<{
    machineReachable: boolean;
    machineOnline: boolean;
    machineRpcTargetAvailable: boolean;
    machineReachability: SessionMachineReachability;
    /** The machine's last heartbeat, said only while it is unreachable: the honest time of the last known state. */
    machineLastSeenAt: number | null;
    /** A created machine's native power word ("Asleep", "Starting") with its name; null when there is none to say. */
    machinePower: Readonly<{ machineName: string | null; word: string }> | null;
}> {
    const machineTarget = useSessionReachableMachineTarget(sessionId, serverId);
    const displayIdentity = useSessionMachineDisplayIdentity(sessionId, serverId);
    const resolvedMachineId = machineTarget?.machineId ?? (displayIdentity.machineId || null);

    const presence = useMachinePresenceSummary(serverId, resolvedMachineId);
    const machineKnown = presence.machineIsKnown ?? presence.reachability !== 'unknown';
    const machineOnline = presence.reachability === 'reachable';

    const machineReachable = resolveSessionMachineReachability({
        machineIsKnown: machineKnown,
        machineIsOnline: machineOnline,
    });
    const machineReachability = presence.reachability;

    const machineRpcTargetAvailable = Boolean(machineTarget?.basePath) && machineReachable;

    const machineLastSeenAt = presence.lastSeenAt ?? null;
    // The same presence owner the Machines rail and picker read: native lifecycle words only, never connectivity.
    const machinePowerWord = describeMachinePresenceSummary(presence).nativeWord ?? null;
    const machineName = presence.name;
    const machinePower = React.useMemo(() => machinePowerWord ? { machineName, word: machinePowerWord } : null,
        [machineName, machinePowerWord]);

    return React.useMemo(() => ({
        machineReachable,
        machineOnline,
        machineRpcTargetAvailable,
        machineReachability,
        machineLastSeenAt,
        machinePower,
    }), [machineReachability, machineReachable, machineRpcTargetAvailable, machineOnline, machineLastSeenAt, machinePower]);
}
