import * as React from 'react';
import { Pressable } from 'react-native';
import { Ionicons, Octicons } from '@expo/vector-icons';

import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import { WorkspaceDetailsPanel, type WorkspaceDetailsPanelHeaderActionRenderParams } from '@/components/projects/panes/WorkspaceDetailsPanel';
import { WorkspaceWorktreeListSection } from '@/components/workspaces/scm/worktrees/WorkspaceWorktreeListSection';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import { buildProjectRouteHref } from './projectRouteState';
import { useProjectRouteRouterRef } from './useProjectRouteRouterRef';

export type ProjectDetailsMainPanelProps = Readonly<{
    workspaceRef: WorkspaceRefV1;
    scopeId: string;
    activeRootPath: string;
    activeWorktreeId?: string | null;
    forceOverviewMode?: boolean;
    onSelectRootPath: (path: string) => void;
    onRequestClose?: () => void;
    pluginUiProjection?: PluginUiProjectionModel | null;
    platform?: LocalServicePreviewPlatform;
}>;

export const ProjectDetailsMainPanel = React.memo((props: ProjectDetailsMainPanelProps) => {
    const deviceType = useDeviceType();
    const routerRef = useProjectRouteRouterRef();
    const workspaceScope = React.useMemo(() => ({
        serverId: props.workspaceRef.serverId,
        machineId: props.workspaceRef.machineId,
        rootPath: props.workspaceRef.rootPath,
    }), [props.workspaceRef.machineId, props.workspaceRef.rootPath, props.workspaceRef.serverId]);
    const { snapshot } = useWorkspaceScmSnapshotController(workspaceScope);

    const renderHeaderActionsPrefix = React.useCallback((params: WorkspaceDetailsPanelHeaderActionRenderParams) => {
        if (deviceType !== 'phone') return null;
        return (
            <>
                <Pressable
                    onPress={() => routerRef.current.push(buildProjectRouteHref({
                        workspaceRefId: props.workspaceRef.id,
                        segment: 'git',
                        activeRootPath: props.activeRootPath,
                        defaultRootPath: props.workspaceRef.rootPath,
                        activeWorktreeId: props.activeWorktreeId,
                    }))}
                    style={params.iconButtonStyle}
                    accessibilityRole="button"
                    accessibilityLabel={t('settings.sourceControl')}
                >
                    <Octicons name="git-branch" size={16} color={params.iconColor} />
                </Pressable>
                <Pressable
                    onPress={() => routerRef.current.push(buildProjectRouteHref({
                        workspaceRefId: props.workspaceRef.id,
                        segment: 'files',
                        activeRootPath: props.activeRootPath,
                        defaultRootPath: props.workspaceRef.rootPath,
                        activeWorktreeId: props.activeWorktreeId,
                    }))}
                    style={params.iconButtonStyle}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.files')}
                >
                    <Ionicons name="folder-outline" size={18} color={params.iconColor} />
                </Pressable>
            </>
        );
    }, [deviceType, props.activeRootPath, props.activeWorktreeId, props.workspaceRef.id, props.workspaceRef.rootPath, routerRef]);

    const renderEmptyStateSupplementaryContent = React.useCallback(() => {
        if (snapshot?.repo.isRepo !== true) return null;
        return (
            <WorkspaceWorktreeListSection
                worktrees={snapshot.repo.worktrees ?? []}
                selectedRootPath={props.activeRootPath}
                onSelectRootPath={props.onSelectRootPath}
            />
        );
    }, [props.activeRootPath, props.onSelectRootPath, snapshot?.repo]);

    return (
        <WorkspaceDetailsPanel
            workspaceRef={props.workspaceRef}
            scopeId={props.scopeId}
            activeRootPath={props.activeRootPath}
            displayPathOverride={props.workspaceRef.rootPath}
            forceOverviewMode={props.forceOverviewMode}
            showTerminalHeaderAction={false}
            showFocusModeToggle={false}
            onRequestClose={props.onRequestClose}
            pluginUiProjection={props.pluginUiProjection}
            pluginSurfacePlacementScope="project"
            platform={props.platform}
            renderHeaderActionsPrefix={renderHeaderActionsPrefix}
            renderEmptyStateSupplementaryContent={renderEmptyStateSupplementaryContent}
        />
    );
});
