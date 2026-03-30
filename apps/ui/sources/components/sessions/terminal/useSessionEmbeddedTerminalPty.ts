import * as React from 'react';

import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import type { EmbeddedTerminalRendererHandle } from '@/components/sessions/terminal/embeddedTerminalRendererHandle';
import { useMachineTerminalSession } from '@/hooks/machine/useMachineTerminalSession';
import { useAllMachines, useAllSessions, useProjectForSession, useSession } from '@/sync/domains/state/storage';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';

export function useSessionEmbeddedTerminalPty(params: Readonly<{
    sessionId: string;
    terminalKey: string;
    terminalRef: React.MutableRefObject<EmbeddedTerminalRendererHandle | null>;
}>) {
    const session = useSession(params.sessionId);
    const project = useProjectForSession(params.sessionId);
    const allMachines = useAllMachines();
    const allSessions = useAllSessions();
    const machineTarget = React.useMemo(
        () => readMachineTargetForSession(params.sessionId),
        [
            allMachines,
            allSessions,
            params.sessionId,
            project?.key?.machineId,
            project?.key?.path,
            session?.metadata?.homeDir,
            session?.metadata?.host,
            session?.metadata?.machineId,
            session?.metadata?.path,
        ],
    );
    const { machineReachable, machineRpcTargetAvailable } = useSessionMachineReachability(params.sessionId);

    return useMachineTerminalSession({
        machineId: machineTarget?.machineId ?? null,
        cwd: machineTarget?.basePath ?? null,
        machineReachable,
        machineRpcTargetAvailable,
        terminalKey: params.terminalKey,
        terminalRef: params.terminalRef,
    });
}
