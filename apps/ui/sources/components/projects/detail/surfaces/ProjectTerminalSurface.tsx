import * as React from 'react';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { EmbeddedTerminalToolbarIconButton } from '@/components/terminal/embedded/EmbeddedTerminalToolbarIconButton';
import { openProjectTerminalDetailsTab } from '@/components/projects/detail/openProjectTerminalDetailsTab';
import { WorkspaceEmbeddedTerminalPane } from '@/components/projects/panes/details/views/WorkspaceEmbeddedTerminalPane';
import { t } from '@/text';

export const ProjectTerminalSurface = React.memo((props: Readonly<{
    scopeId: string;
    workspaceRefId: string;
    machineId: string;
    rootPath: string;
    serverId: string;
    terminalInstanceId?: string;
    closeOnUnmount?: boolean;
}>) => {
    const pane = useAppPaneScope(props.scopeId);

    const toolbarActionsStart = React.useMemo(() => (
        <EmbeddedTerminalToolbarIconButton
            testID="workspace-embedded-terminal-new-tab"
            accessibilityLabel={t('terminalEmbedded.openNewTabA11y')}
            onPress={() => openProjectTerminalDetailsTab({
                openDetailsTab: pane.openDetailsTab,
                cwd: props.rootPath,
            })}
            icon="add-outline"
        />
    ), [pane, props.rootPath]);

    return (
        <WorkspaceEmbeddedTerminalPane
            scopeId={props.scopeId}
            workspaceRefId={props.workspaceRefId}
            machineId={props.machineId}
            rootPath={props.rootPath}
            serverId={props.serverId}
            terminalInstanceId={props.terminalInstanceId}
            toolbarActionsStart={toolbarActionsStart}
            closeOnUnmount={props.closeOnUnmount}
        />
    );
});
