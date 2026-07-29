import * as React from 'react';

import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { useMachineTerminalSession } from '@/hooks/machine/useMachineTerminalSession';
import type { SessionTerminalMode } from './sessionTerminalMode';

export function useSessionEmbeddedTerminalPty(params: Readonly<{
    sessionId: string;
    terminalKey: string;
    terminalMode: SessionTerminalMode;
    terminalRef: React.MutableRefObject<EmbeddedTerminalRendererHandle | null>;
}>) {
    const machineTarget = useSessionMachineTarget(params.sessionId);
    const { machineReachable, machineRpcTargetAvailable } = useSessionMachineReachability(params.sessionId);
    const launch = React.useMemo(
        () => params.terminalMode === 'session_attach'
            ? { kind: 'session_attach' as const, sessionId: params.sessionId }
            : null,
        [params.sessionId, params.terminalMode],
    );

    return useMachineTerminalSession({
        machineId: machineTarget?.machineId ?? null,
        cwd: params.terminalMode === 'workspace_shell' ? machineTarget?.basePath ?? null : null,
        launch,
        machineReachable,
        machineRpcTargetAvailable,
        terminalKey: params.terminalKey,
        terminalRef: params.terminalRef,
    });
}
