import * as React from 'react';

import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { useAllMachines, useAllSessions, useProjectForSession, useSession } from '@/sync/domains/state/storage';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { resolveSessionMachineReachability } from '@/components/sessions/model/resolveSessionMachineReachability';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolveSessionMachineId } from '@/sync/domains/session/directSessions/resolveSessionMachineId';

export function useSessionReachableMachineTarget(sessionId: string): { machineId: string; basePath: string } | null {
    const resolvedSessionId = normalizeSessionId(sessionId);
    const session = useSession(resolvedSessionId);
    const project = useProjectForSession(resolvedSessionId);
    const allMachines = useAllMachines();
    const allSessions = useAllSessions();
    const sessionMachineId = resolveSessionMachineId(session?.metadata);

    return React.useMemo(
        () => readMachineTargetForSession(resolvedSessionId),
        [
            allMachines,
            allSessions,
            project?.key?.machineId,
            project?.key?.rootPath,
            session?.metadata?.homeDir,
            session?.metadata?.host,
            sessionMachineId,
            session?.metadata?.path,
            resolvedSessionId,
        ],
    );
}

export function useSessionMachineReachability(sessionId: string): Readonly<{
    machineReachable: boolean;
    machineOnline: boolean;
    machineRpcTargetAvailable: boolean;
}> {
    const allMachines = useAllMachines();
    const machineTarget = useSessionReachableMachineTarget(sessionId);
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
