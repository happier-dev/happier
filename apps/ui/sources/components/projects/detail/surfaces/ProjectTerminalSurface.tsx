import * as React from 'react';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { IconButton } from '@/components/ui/buttons/IconButton';
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
        <IconButton
            testID="workspace-embedded-terminal-new-tab"
            iconName="add-outline"
            accessibilityLabel={t('terminalEmbedded.openNewTabA11y')}
            tooltip={t('terminalEmbedded.openNewTabA11y')}
            variant="plain"
            size={28}
            iconSize={18}
            onPress={() => openProjectTerminalDetailsTab({
                openDetailsTab: pane.openDetailsTab,
                cwd: props.rootPath,
            })}
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
