import * as React from 'react';

import { useAllMachines, useProjectForSession, useSession } from '@/sync/domains/state/storage';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { resolveSessionMachineReachability } from '@/components/sessions/model/resolveSessionMachineReachability';
import { resolveSessionMachineRpcTarget } from '@/sync/domains/session/resolveSessionReachableMachineId';

export function useSessionMachineReachability(sessionId: string): Readonly<{
    machineReachable: boolean;
    machineOnline: boolean;
    machineRpcTargetAvailable: boolean;
}> {
    const session = useSession(sessionId);
    const project = useProjectForSession(sessionId);
    const allMachines = useAllMachines();

    const machineTarget = React.useMemo(
        () =>
            resolveSessionMachineRpcTarget({
                sessionId,
                sessionMachineId: typeof session?.metadata?.machineId === 'string' ? session.metadata.machineId : null,
                sessionHostHint: typeof session?.metadata?.host === 'string' ? session.metadata.host : null,
                sessionPath: typeof session?.metadata?.path === 'string' ? session.metadata.path : null,
                sessionHomeDir: typeof session?.metadata?.homeDir === 'string' ? session.metadata.homeDir : null,
                projectMachineId: project?.key?.machineId ?? null,
                projectPath: project?.key?.path ?? null,
                machines: allMachines,
            }),
        [
            allMachines,
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

    const sessionPath = typeof session?.metadata?.path === 'string' ? session.metadata.path.trim() : '';
    const projectPath = typeof project?.key?.path === 'string' ? project.key.path.trim() : '';
    const machineRpcTargetAvailable = Boolean(machineTarget?.basePath || sessionPath || projectPath);

    return { machineReachable, machineOnline, machineRpcTargetAvailable };
}
