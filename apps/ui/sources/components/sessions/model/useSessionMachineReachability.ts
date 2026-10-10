import * as React from 'react';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { useMachinePresenceSummary } from './useMachinePresenceSummary';
import {
    resolveSessionMachineReachability,
    resolveSessionMachineReachabilityState,
    type SessionMachineReachability,
} from '@/components/sessions/model/resolveSessionMachineReachability';
import { useSessionMachineDisplayIdentity, useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';

export function useSessionReachableMachineTarget(sessionId: string, serverId?: string | null): { machineId: string; basePath: string } | null {
    const resolvedSessionId = normalizeSessionId(sessionId);
    return useSessionMachineTarget(resolvedSessionId, serverId);
}

export function useSessionMachineReachability(sessionId: string, serverId?: string | null): Readonly<{
    machineReachable: boolean;
    machineOnline: boolean;
    machineRpcTargetAvailable: boolean;
    machineReachability: SessionMachineReachability;
}> {
    const machineTarget = useSessionReachableMachineTarget(sessionId, serverId);
    const displayIdentity = useSessionMachineDisplayIdentity(sessionId, serverId);
    const resolvedMachineId = machineTarget?.machineId ?? (displayIdentity.machineId || null);

    const presence = useMachinePresenceSummary(serverId, resolvedMachineId);
    const machineKnown = presence.reachability !== 'unknown';
    const machineOnline = presence.reachability === 'reachable';

    const machineReachable = resolveSessionMachineReachability({
        machineIsKnown: machineKnown,
        machineIsOnline: machineOnline,
    });
    const machineReachability = resolveSessionMachineReachabilityState({
        machineIsKnown: machineKnown,
        machineIsOnline: machineOnline,
    });

    const machineRpcTargetAvailable = Boolean(machineTarget?.basePath) && machineReachable;

    return React.useMemo(() => ({
        machineReachable,
        machineOnline,
        machineRpcTargetAvailable,
        machineReachability,
    }), [machineReachability, machineReachable, machineRpcTargetAvailable, machineOnline]);
}
