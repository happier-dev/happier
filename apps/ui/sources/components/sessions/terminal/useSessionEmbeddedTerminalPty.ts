import * as React from 'react';
import type { SessionTerminalTargetV1 } from '@happier-dev/protocol';
import { useMachine, useServerScopedMachine } from '@/sync/domains/state/storage';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { resolveSessionMachineReachability } from '@/components/sessions/model/resolveSessionMachineReachability';

import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { useMachineTerminalSession } from '@/hooks/machine/useMachineTerminalSession';
import type { SessionTerminalMode } from './sessionTerminalMode';

export function useSessionEmbeddedTerminalPty(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    terminalKey: string;
    terminalMode: SessionTerminalMode;
    terminalTarget?: SessionTerminalTargetV1;
    available?: boolean;
    terminalRef: React.MutableRefObject<EmbeddedTerminalRendererHandle | null>;
}>) {
    const machineTarget = useSessionMachineTarget(params.sessionId, params.serverId);
    const { machineReachable, machineRpcTargetAvailable } = useSessionMachineReachability(params.sessionId, params.serverId);
    const target = params.terminalTarget;
    const explicitMachineId = target?.kind === 'machine_shell' || target?.kind === 'terminal_view' ? target.machineId : null;
    const legacyMachine = useMachine(params.serverId ? '' : explicitMachineId ?? '');
    const scopedMachine = useServerScopedMachine(params.serverId, params.serverId ? explicitMachineId ?? '' : '');
    const explicitMachine = params.serverId ? scopedMachine : legacyMachine;
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
        initialCommand: target?.kind === 'workspace_shell' || target?.kind === 'machine_shell' ? target.initialCommand : undefined,
        attachedTerminalId: target?.kind === 'terminal_view' ? target.terminalId : undefined,
        readOnly: target?.kind === 'terminal_view',
        sessionId: params.sessionId,
        machineReachable: explicitMachineId ? resolveSessionMachineReachability({ machineIsKnown: Boolean(explicitMachine), machineIsOnline: explicitMachine ? isMachineOnline(explicitMachine) : false }) : machineReachable,
        machineRpcTargetAvailable: explicitMachineId ? true : machineRpcTargetAvailable,
        terminalKey: params.terminalKey,
        terminalRef: params.terminalRef,
    });
}
