import * as React from 'react';
import { Pressable } from 'react-native';

import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { WorkspaceDetailsPanel, type WorkspaceDetailsPanelHeaderActionRenderParams } from '@/components/projects/panes/WorkspaceDetailsPanel';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import { buildProjectRouteHref } from './projectRouteState';
import { useProjectRouteRouterRef } from './useProjectRouteRouterRef';
import { Icon } from '@/components/ui/icons/Icon';

export type ProjectDetailsMainPanelProps = Readonly<{
    workspaceRef: WorkspaceRefV1;
    scopeId: string;
    activeRootPath: string;
    activeWorktreeId?: string | null;
    onSelectRootPath: (path: string) => void;
    onRequestClose?: () => void;
    pluginUiProjection?: PluginUiProjectionModel | null;
    platform?: LocalServicePreviewPlatform;
}>;

export const ProjectDetailsMainPanel = React.memo((props: ProjectDetailsMainPanelProps) => {
    const deviceType = useDeviceType();
    const routerRef = useProjectRouteRouterRef();

    const renderHeaderActionsPrefix = React.useCallback((params: WorkspaceDetailsPanelHeaderActionRenderParams) => {
        if (deviceType !== 'phone') return null;
        return (
            <>
                <Pressable
                    onPress={() => routerRef.current.push(buildProjectRouteHref({
                        workspaceRefId: props.workspaceRef.id,
                        serverId: props.workspaceRef.serverId,
                        segment: 'changes',
                        activeRootPath: props.activeRootPath,
                        defaultRootPath: props.workspaceRef.rootPath,
                        activeWorktreeId: props.activeWorktreeId,
                    }))}
                    style={params.iconButtonStyle}
                    accessibilityRole="button"
                    accessibilityLabel={t('settings.sourceControl')}
                >
                    <Icon name="git-branch" size={16} color={params.iconColor} />
                </Pressable>
                <Pressable
                    onPress={() => routerRef.current.push(buildProjectRouteHref({
                        workspaceRefId: props.workspaceRef.id,
                        segment: 'code',
                        serverId: props.workspaceRef.serverId,
                        activeRootPath: props.activeRootPath,
                        defaultRootPath: props.workspaceRef.rootPath,
                        activeWorktreeId: props.activeWorktreeId,
                    }))}
                    style={params.iconButtonStyle}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.files')}
                >
                    <Icon name="folder" size={16} color={params.iconColor} />
                </Pressable>
            </>
        );
    }, [deviceType, props.activeRootPath, props.activeWorktreeId, props.workspaceRef.id, props.workspaceRef.rootPath, props.workspaceRef.serverId, routerRef]);

    return (
        <WorkspaceDetailsPanel
            workspaceRef={props.workspaceRef}
            scopeId={props.scopeId}
            activeRootPath={props.activeRootPath}
            activeWorktreeId={props.activeWorktreeId}
            displayPathOverride={props.workspaceRef.rootPath}
            showTerminalHeaderAction={false}
            onRequestClose={props.onRequestClose}
            pluginUiProjection={props.pluginUiProjection}
            platform={props.platform}
            renderHeaderActionsPrefix={renderHeaderActionsPrefix}
        />
    );
});
