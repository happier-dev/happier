import * as React from 'react';

import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { useMachineTerminalSession } from '@/hooks/machine/useMachineTerminalSession';

export function useSessionEmbeddedTerminalPty(params: Readonly<{
    sessionId: string;
    terminalKey: string;
    terminalRef: React.MutableRefObject<EmbeddedTerminalRendererHandle | null>;
}>) {
    const machineTarget = useSessionMachineTarget(params.sessionId);
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
