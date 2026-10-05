import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { getStorage, useServerScopedMachine } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import {
    resolveSessionMachineReachability,
    resolveSessionMachineReachabilityState,
    type SessionMachineReachability,
} from '@/components/sessions/model/resolveSessionMachineReachability';
import { useSessionMachineDisplayIdentity, useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';

type SessionMachineReachabilityStorageState = Readonly<{
    machines?: Readonly<Record<string, Machine | undefined>>;
}>;

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

    const scopedMachine = useServerScopedMachine(serverId, serverId ? resolvedMachineId ?? '' : '');
    const machineStatus = getStorage()(
        useShallow((state: SessionMachineReachabilityStorageState) => {
            const resolvedMachine = serverId ? scopedMachine : resolvedMachineId
                ? state.machines?.[resolvedMachineId] ?? null
                : null;
            return {
                machineKnown: Boolean(resolvedMachine),
                machineOnline: resolvedMachine ? isMachineOnline(resolvedMachine) : false,
            };
        }),
    );

    const machineReachable = resolveSessionMachineReachability({
        machineIsKnown: machineStatus.machineKnown,
        machineIsOnline: machineStatus.machineOnline,
    });
    const machineReachability = resolveSessionMachineReachabilityState({
        machineIsKnown: machineStatus.machineKnown,
        machineIsOnline: machineStatus.machineOnline,
    });

    const machineRpcTargetAvailable = Boolean(machineTarget?.basePath);

    return React.useMemo(() => ({
        machineReachable,
        machineOnline: machineStatus.machineOnline,
        machineRpcTargetAvailable,
        machineReachability,
    }), [machineReachability, machineReachable, machineRpcTargetAvailable, machineStatus.machineOnline]);
}
