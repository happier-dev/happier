import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { getStorage } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { resolveSessionMachineReachability } from '@/components/sessions/model/resolveSessionMachineReachability';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';

type SessionMachineReachabilityStorageState = Readonly<{
    machines?: Readonly<Record<string, Machine | undefined>>;
}>;

export function useSessionReachableMachineTarget(sessionId: string): { machineId: string; basePath: string } | null {
    const resolvedSessionId = normalizeSessionId(sessionId);
    return useSessionMachineTarget(resolvedSessionId);
}

export function useSessionMachineReachability(sessionId: string): Readonly<{
    machineReachable: boolean;
    machineOnline: boolean;
    machineRpcTargetAvailable: boolean;
}> {
    const machineTarget = useSessionReachableMachineTarget(sessionId);
    const resolvedMachineId = machineTarget?.machineId ?? null;

    const machineStatus = getStorage()(
        useShallow((state: SessionMachineReachabilityStorageState) => {
            const resolvedMachine = resolvedMachineId
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

    const machineRpcTargetAvailable = Boolean(machineTarget?.basePath);

    return React.useMemo(() => ({
        machineReachable,
        machineOnline: machineStatus.machineOnline,
        machineRpcTargetAvailable,
    }), [machineReachable, machineRpcTargetAvailable, machineStatus.machineOnline]);
}
