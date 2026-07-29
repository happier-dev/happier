import * as React from 'react';
import { Platform, View } from 'react-native';

import { EmbeddedTerminalPane } from '@/components/terminal/embedded/EmbeddedTerminalPane';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { useMachineTerminalSession } from '@/hooks/machine/useMachineTerminalSession';
import { useMachine } from '@/sync/domains/state/storage';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { t } from '@/text';

export type WorkspaceEmbeddedTerminalPaneProps = Readonly<{
    scopeId: string;
    workspaceRefId: string;
    machineId: string;
    rootPath: string;
    serverId: string;
    terminalInstanceId?: string;
    toolbarActionsStart?: React.ReactNode;
    closeOnUnmount?: boolean;
}>;

export const WorkspaceEmbeddedTerminalPane = React.memo(function WorkspaceEmbeddedTerminalPane(props: WorkspaceEmbeddedTerminalPaneProps) {
    const terminalRendererRef = React.useRef<EmbeddedTerminalRendererHandle | null>(null);
    const machine = useMachine(props.machineId);
    const machineReachable = Boolean(machine && isMachineOnline(machine));

    const terminalInstanceId = props.terminalInstanceId?.trim() || null;
    const terminalKey = React.useMemo(
        () => terminalInstanceId
            ? `workspace:${props.workspaceRefId}:terminal:${terminalInstanceId}`
            : `workspace:${props.workspaceRefId}:terminal`,
        [props.workspaceRefId, terminalInstanceId],
    );

    const controller = useMachineTerminalSession({
        machineId: props.machineId,
        cwd: props.rootPath,
        machineReachable,
        machineRpcTargetAvailable: true,
        terminalKey,
        terminalRef: terminalRendererRef,
        closeOnUnmount: props.closeOnUnmount ?? false,
    });

    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <EmbeddedTerminalPane
                title={t('settings.terminal')}
                controller={controller}
                terminalRef={terminalRendererRef}
                toolbarActionsStart={props.toolbarActionsStart}
                testIdPrefix="workspace-embedded-terminal"
                nativeSurfaceKey={terminalKey}
                showQuickKeys={Platform.OS !== 'web'}
            />
        </View>
    );
});
