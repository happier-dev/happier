import * as React from 'react';

import { useAllMachines, useAllSessions, useProjectForSession, useSession } from '@/sync/domains/state/storage';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { resolveSessionMachineReachability } from '@/components/sessions/model/resolveSessionMachineReachability';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';

export function useSessionMachineReachability(sessionId: string): Readonly<{
    machineReachable: boolean;
    machineOnline: boolean;
    machineRpcTargetAvailable: boolean;
}> {
    const session = useSession(sessionId);
    const project = useProjectForSession(sessionId);
    const allMachines = useAllMachines();
    const allSessions = useAllSessions();

    const machineTarget = React.useMemo(
        () => readMachineTargetForSession(sessionId),
        [
            allMachines,
            allSessions,
            project?.key?.machineId,
            project?.key?.path,
            session?.metadata?.homeDir,
            session?.metadata?.host,
            session?.metadata?.machineId,
            session?.metadata?.path,
            sessionId,
        ],
    );
    const resolvedMachineId = machineTarget?.machineId ?? null;

    const resolvedMachine = React.useMemo(
        () => (resolvedMachineId ? allMachines.find((machine) => machine.id === resolvedMachineId) ?? null : null),
        [allMachines, resolvedMachineId],
    );

    const machineOnline = resolvedMachine ? isMachineOnline(resolvedMachine) : false;
    const machineReachable = resolveSessionMachineReachability({
        machineIsKnown: Boolean(resolvedMachine),
        machineIsOnline: machineOnline,
    });

    const machineRpcTargetAvailable = Boolean(machineTarget?.basePath);

    return { machineReachable, machineOnline, machineRpcTargetAvailable };
}
