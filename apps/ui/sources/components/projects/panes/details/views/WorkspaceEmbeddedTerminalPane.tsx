import * as React from 'react';
import { View } from 'react-native';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { EmbeddedTerminalPane } from '@/components/terminal/embedded/EmbeddedTerminalPane';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { useMachineTerminalSession } from '@/hooks/machine/useMachineTerminalSession';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { t } from '@/text';
import { useEmbeddedTerminalPresentation } from '@/components/terminal/embedded/useEmbeddedTerminalPresentation';
import { useSessionTerminalActionExecute } from '@/components/sessions/terminal/useSessionTerminalWorkspace';

export type WorkspaceEmbeddedTerminalPaneProps = Readonly<{
    scopeId: string;
    workspaceRefId?: string;
    machineId: string;
    rootPath: string | null;
    serverId: string;
    terminalInstanceId?: string;
    attachedTerminalId?: string | null;
    toolbarActionsStart?: React.ReactNode;
    closeOnUnmount?: boolean;
    workspace?: WorkspaceAddressV1;
    terminalKey: string;
    title?: string;
    focused?: boolean;
    chrome?: 'toolbar' | 'none';
}>;

export const WorkspaceEmbeddedTerminalPane = React.memo(function WorkspaceEmbeddedTerminalPane(props: WorkspaceEmbeddedTerminalPaneProps) {
    const terminalRendererRef = React.useRef<EmbeddedTerminalRendererHandle | null>(null);
    const machine = useMachinePresenceSummary(props.serverId, props.machineId);
    const machineReachable = machine.reachability === 'reachable';

    const terminalKey = props.terminalKey;

    const controller = useMachineTerminalSession({
        machineId: props.machineId,
        serverId: props.serverId,
        ...(props.attachedTerminalId === undefined ? {} : { attachedTerminalId: props.attachedTerminalId, readOnly: true }),
        cwd: props.rootPath,
        machineReachable,
        machineRpcTargetAvailable: true,
        terminalKey,
        terminalRef: terminalRendererRef,
        closeOnUnmount: props.closeOnUnmount ?? false,
        workspace: props.workspace,
        scopeId: props.scopeId,
        memberId: props.terminalInstanceId,
    });
    const presentation = useEmbeddedTerminalPresentation({ scopeId: props.scopeId, terminalKey,
        terminalId: props.terminalInstanceId ?? null, available: true, focused: props.focused,
        controller, terminalRef: terminalRendererRef });
    const execute = useSessionTerminalActionExecute(props.scopeId);
    const restart = React.useCallback(() => {
        if (props.terminalInstanceId) void execute('session.terminals.restart', { terminalId: props.terminalInstanceId });
    }, [execute, props.terminalInstanceId]);
    const surfaceController = React.useMemo(() => ({ ...controller, requestRestart: restart, onOpenApproval: presentation.onOpenApproval }), [controller, restart, presentation.onOpenApproval]);

    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <EmbeddedTerminalPane
                title={props.title ?? t('settings.terminal')}
                controller={surfaceController}
                terminalRef={terminalRendererRef}
                toolbarActionsStart={props.toolbarActionsStart}
                testIdPrefix="workspace-embedded-terminal"
                nativeSurfaceKey={terminalKey}
                chrome={props.chrome}
                machineName={machine.name}
                focused={props.focused}
                findSurfaceId={presentation.findSurfaceId}
            />
        </View>
    );
});
