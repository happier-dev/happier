import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { ProjectDetailsMainPanel } from '@/components/projects/detail/ProjectDetailsMainPanel';
import { ProjectBrowseFilesSurface } from '@/components/projects/detail/surfaces/ProjectBrowseFilesSurface';
import { ProjectGitSurface } from '@/components/projects/detail/surfaces/ProjectGitSurface';
import { ProjectTerminalSurface } from '@/components/projects/detail/surfaces/ProjectTerminalSurface';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { useProjectSurfaceActions } from '@/components/projects/detail/useProjectSurfaceActions';
import { useProjectSurfaceController } from '@/components/projects/detail/useProjectSurfaceController';
import type { ProjectMobileSurface } from './projectCockpitState';

type ProjectCockpitShellProps = Readonly<{
    workspaceRef: WorkspaceRefV1;
    scopeId: string;
    activeRootPath: string;
    activeWorktreeId?: string | null;
    surface: ProjectMobileSurface;
    onSelectRootPath: (path: string) => void;
}>;

export const ProjectCockpitShell = React.memo((props: ProjectCockpitShellProps) => {
    const { theme } = useUnistyles();
    const { navigateToSurface, syncSurface } = useProjectSurfaceController({
        scopeId: props.scopeId,
        workspaceRef: props.workspaceRef,
        activeRootPath: props.activeRootPath,
        activeWorktreeId: props.activeWorktreeId,
    });

    React.useEffect(() => {
        syncSurface(props.surface);
    }, [props.surface, syncSurface]);

    const workspaceCacheKey = React.useMemo(() => buildWorkspaceCacheKey({
        serverId: props.workspaceRef.serverId,
        machineId: props.workspaceRef.machineId,
        rootPath: props.activeRootPath,
    }), [props.activeRootPath, props.workspaceRef.machineId, props.workspaceRef.serverId]);

    const navigateToBrowse = React.useCallback(() => {
        navigateToSurface('browse');
    }, [navigateToSurface]);

    const {
        openFileInDetails,
        openFileInDetailsPinned,
        openReviewAllChanges,
        openStashDetails,
        openCreateWorktreeFlow,
        openCommitInDetails,
        revealInFilesTree,
    } = useProjectSurfaceActions({
        scopeId: props.scopeId,
        workspaceRef: props.workspaceRef,
        activeRootPath: props.activeRootPath,
        onRevealInFilesTreeNavigate: navigateToBrowse,
    });

    if (props.surface === 'browse') {
        return (
            <View testID="project-files-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                <React.Suspense fallback={<ProjectCockpitLoadingFallback color={theme.colors.textSecondary} />}>
                    <ProjectBrowseFilesSurface
                        workspaceCacheKey={workspaceCacheKey}
                        serverId={props.workspaceRef.serverId}
                        machineId={props.workspaceRef.machineId}
                        rootPath={props.activeRootPath}
                        onOpenFile={openFileInDetails}
                        onOpenFilePinned={openFileInDetailsPinned}
                    />
                </React.Suspense>
            </View>
        );
    }

    if (props.surface === 'git') {
        return (
            <View testID="project-git-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                <React.Suspense fallback={<ProjectCockpitLoadingFallback color={theme.colors.textSecondary} />}>
                    <ProjectGitSurface
                        serverId={props.workspaceRef.serverId}
                        machineId={props.workspaceRef.machineId}
                        rootPath={props.activeRootPath}
                        onOpenFile={openFileInDetails}
                        onOpenFilePinned={openFileInDetailsPinned}
                        onOpenReviewAllChanges={openReviewAllChanges}
                        onOpenStashDetails={openStashDetails}
                        onOpenCommit={openCommitInDetails}
                        onSelectWorkspacePath={props.onSelectRootPath}
                        onRequestCreateWorktreeFromAnotherBranch={openCreateWorktreeFlow}
                        onRevealInFilesTree={revealInFilesTree}
                    />
                </React.Suspense>
            </View>
        );
    }

    if (props.surface === 'terminal') {
        return (
            <View testID="project-terminal-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                <React.Suspense fallback={<ProjectCockpitLoadingFallback color={theme.colors.textSecondary} />}>
                    <ProjectTerminalSurface
                        scopeId={props.scopeId}
                        workspaceRefId={props.workspaceRef.id}
                        machineId={props.workspaceRef.machineId}
                        rootPath={props.activeRootPath}
                        serverId={props.workspaceRef.serverId}
                    />
                </React.Suspense>
            </View>
        );
    }

    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <ProjectDetailsMainPanel
                workspaceRef={props.workspaceRef}
                scopeId={props.scopeId}
                activeRootPath={props.activeRootPath}
                activeWorktreeId={props.activeWorktreeId}
                forceOverviewMode={props.surface === 'overview'}
                onSelectRootPath={props.onSelectRootPath}
            />
        </View>
    );
});

const ProjectCockpitLoadingFallback = React.memo((props: Readonly<{ color: string }>) => {
    return <PaneLoadingFallback color={props.color} paddingTop={0} showTypographyMetrics={false} />;
});
