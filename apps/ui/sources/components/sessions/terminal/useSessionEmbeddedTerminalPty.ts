import * as React from 'react';
import type { SessionTerminalTargetV1 } from '@happier-dev/protocol/terminal/workspace';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';

import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { useMachineTerminalSession } from '@/hooks/machine/useMachineTerminalSession';
import type { SessionTerminalMode } from './sessionTerminalMode';

export function useSessionEmbeddedTerminalPty(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    terminalKey: string;
    scopeId?: string;
    memberId?: string;
    terminalMode: SessionTerminalMode;
    terminalTarget?: SessionTerminalTargetV1;
    available?: boolean;
    terminalRef: React.MutableRefObject<EmbeddedTerminalRendererHandle | null>;
}>) {
    const machineTarget = useSessionMachineTarget(params.sessionId, params.serverId);
    const { machineReachable, machineReachability, machineRpcTargetAvailable } = useSessionMachineReachability(params.sessionId, params.serverId);
    const target = params.terminalTarget;
    const explicitMachineId = target?.kind === 'machine_shell' || target?.kind === 'terminal_view' ? target.machineId : null;
    const explicitMachinePresence = useMachinePresenceSummary(params.serverId, explicitMachineId);
    const kind = target?.kind ?? params.terminalMode;
    const launch = React.useMemo(
        () => kind === 'session_attach'
            ? { kind: 'session_attach' as const, sessionId: params.sessionId }
            : target?.kind === 'workspace_shell' || target?.kind === 'machine_shell' ? target.launch ?? null : null,
        [params.sessionId, kind, target],
    );

    return useMachineTerminalSession({
        serverId: params.serverId,
        machineId: params.available === false ? null : explicitMachineId ?? machineTarget?.machineId ?? null,
        cwd: target?.kind === 'machine_shell' || target?.kind === 'terminal_view' ? target.cwd : kind === 'workspace_shell' ? machineTarget?.basePath ?? null : null,
        launch,
        attachedTerminalId: target?.kind === 'terminal_view' ? target.terminalId : undefined,
        readOnly: target?.kind === 'terminal_view',
        workspace: target?.kind === 'terminal_view' ? target.workspace : undefined,
        sessionId: params.sessionId,
        machineReachable: explicitMachineId
            ? explicitMachinePresence.reachability === 'unknown' ? null : explicitMachinePresence.reachability === 'reachable'
            : machineReachability === 'unknown' ? null : machineReachable,
        machineRpcTargetAvailable: explicitMachineId ? true : machineRpcTargetAvailable,
        terminalKey: params.terminalKey,
        scopeId: params.scopeId,
        memberId: params.memberId,
        terminalRef: params.terminalRef,
    });
}
