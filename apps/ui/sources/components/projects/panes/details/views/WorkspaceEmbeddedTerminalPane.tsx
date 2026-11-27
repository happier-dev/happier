import * as React from 'react';
import { View } from 'react-native';
import { isManagedWorkspaceRefV2, type WorkspaceAddressV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { EmbeddedTerminalPane } from '@/components/terminal/embedded/EmbeddedTerminalPane';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { useMachineTerminalSession } from '@/hooks/machine/useMachineTerminalSession';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { t } from '@/text';
import { useEmbeddedTerminalPresentation } from '@/components/terminal/embedded/useEmbeddedTerminalPresentation';
import { useSessionTerminalActionExecute } from '@/components/sessions/terminal/useSessionTerminalWorkspace';

export type WorkspaceEmbeddedTerminalPaneProps = Readonly<{
    scopeId: string;
    presentationId?: string;
    workspaceRefId?: string;
    machineId: string;
    rootPath: string | null;
    serverId: string;
    terminalInstanceId?: string;
    attachedTerminalId?: string | null;
    readOnly?: boolean;
    operationStopPending?: boolean;
    toolbarActionsStart?: React.ReactNode;
    closeOnUnmount?: boolean;
    workspace?: WorkspaceAddressV2;
    terminalKey: string;
    title?: string;
    focused?: boolean;
    chrome?: 'toolbar' | 'none';
    ownerStatesExit?: boolean;
    /** Replaces a borrowed terminal after its byte stream finishes without emitting output. */
    emptyOutput?: React.ReactNode;
    sizing?: 'fill' | 'content';
}>;

export const WorkspaceEmbeddedTerminalPane = React.memo(function WorkspaceEmbeddedTerminalPane(props: WorkspaceEmbeddedTerminalPaneProps) {
    return <WorkspaceEmbeddedTerminalPaneContent key={props.terminalKey} {...props} />;
});

const WorkspaceEmbeddedTerminalPaneContent = React.memo(function WorkspaceEmbeddedTerminalPaneContent(props: WorkspaceEmbeddedTerminalPaneProps) {
    const terminalRendererRef = React.useRef<EmbeddedTerminalRendererHandle | null>(null);
    const machine = useMachinePresenceSummary(props.serverId, props.machineId);
    const machineReachable = machine.reachability === 'unknown' ? null : machine.reachability === 'reachable';

    const terminalKey = props.terminalKey;

    const controller = useMachineTerminalSession({
        machineId: props.machineId,
        serverId: props.serverId,
        ...(props.attachedTerminalId === undefined ? {} : { attachedTerminalId: props.attachedTerminalId,
            readOnly: props.readOnly ?? true }),
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
        presentationId: props.presentationId,
        terminalId: props.terminalInstanceId ?? null, available: true, focused: props.focused,
        controller, terminalRef: terminalRendererRef });
    const execute = useSessionTerminalActionExecute(props.scopeId);
    const restart = React.useCallback(() => {
        if (props.terminalInstanceId) void execute('session.terminals.restart', { terminalId: props.terminalInstanceId });
    }, [execute, props.terminalInstanceId]);
    const surfaceController = React.useMemo(() => ({ ...controller, operationStopPending: props.operationStopPending,
        requestRestart: restart, onOpenApproval: presentation.onOpenApproval }), [controller, props.operationStopPending, restart, presentation.onOpenApproval]);
    // No Session here: Ask goes where the Account's "Ask without a session" setting says (D-3).
    const managedWorkspace = Boolean(props.workspace && isManagedWorkspaceRefV2(props.workspace));
    const askSelection = React.useMemo(() => props.rootPath && !managedWorkspace
        ? { scopeId: props.scopeId, sessionId: null,
            workspaceScope: { serverId: props.serverId, machineId: props.machineId, rootPath: props.rootPath } }
        : null, [managedWorkspace, props.machineId, props.rootPath, props.scopeId, props.serverId]);

    if (props.emptyOutput != null && controller.status === 'exited' && controller.outputRetention?.empty === true) {
        return props.emptyOutput;
    }

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
                ownerStatesExit={props.ownerStatesExit}
                sizing={props.sizing}
                machineName={machine.name}
                focused={props.focused}
                findSurfaceId={presentation.findSurfaceId}
                askSelection={askSelection}
            />
        </View>
    );
});
