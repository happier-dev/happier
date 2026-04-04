import * as React from 'react';
import { Pressable } from 'react-native';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import { WorkspaceDetailsPanel, type WorkspaceDetailsPanelHeaderActionRenderParams } from '@/components/projects/panes/WorkspaceDetailsPanel';
import { WorkspaceWorktreeListSection } from '@/components/workspaces/scm/worktrees/WorkspaceWorktreeListSection';
import { buildProjectRouteHref } from './projectRouteState';

export type ProjectDetailsMainPanelProps = Readonly<{
    workspaceRef: WorkspaceRefV1;
    scopeId: string;
    activeRootPath: string;
    onSelectRootPath: (path: string) => void;
    onRequestClose?: () => void;
}>;

export const ProjectDetailsMainPanel = React.memo((props: ProjectDetailsMainPanelProps) => {
    const deviceType = useDeviceType();
    const router = useRouter();
    const workspaceScope = React.useMemo(() => ({
        serverId: props.workspaceRef.serverId,
        machineId: props.workspaceRef.machineId,
        rootPath: props.activeRootPath,
    }), [props.activeRootPath, props.workspaceRef.machineId, props.workspaceRef.serverId]);
    const { snapshot } = useWorkspaceScmSnapshotController(workspaceScope);

    const renderHeaderActionsPrefix = React.useCallback((params: WorkspaceDetailsPanelHeaderActionRenderParams) => {
        if (deviceType !== 'phone') return null;
        return (
            <>
                <Pressable
                    onPress={() => router.push(buildProjectRouteHref({
                        workspaceRefId: props.workspaceRef.id,
                        segment: 'git',
                        activeRootPath: props.activeRootPath,
                        defaultRootPath: props.workspaceRef.rootPath,
                    }))}
                    style={params.iconButtonStyle}
                    accessibilityRole="button"
                    accessibilityLabel={t('settings.sourceControl')}
                >
                    <Octicons name="git-branch" size={16} color={params.iconColor} />
                </Pressable>
                <Pressable
                    onPress={() => router.push(buildProjectRouteHref({
                        workspaceRefId: props.workspaceRef.id,
                        segment: 'files',
                        activeRootPath: props.activeRootPath,
                        defaultRootPath: props.workspaceRef.rootPath,
                    }))}
                    style={params.iconButtonStyle}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.files')}
                >
                    <Ionicons name="folder-outline" size={18} color={params.iconColor} />
                </Pressable>
            </>
        );
    }, [deviceType, props.activeRootPath, props.workspaceRef.id, props.workspaceRef.rootPath, router]);

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
            onRequestClose={props.onRequestClose}
            renderHeaderActionsPrefix={renderHeaderActionsPrefix}
            renderEmptyStateSupplementaryContent={renderEmptyStateSupplementaryContent}
        />
    );
});
