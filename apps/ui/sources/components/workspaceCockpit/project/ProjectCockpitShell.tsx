import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { ProjectDetailsMainPanel } from '@/components/projects/detail/ProjectDetailsMainPanel';
import { ProjectBrowseFilesSurface } from '@/components/projects/detail/surfaces/ProjectBrowseFilesSurface';
import { ProjectGitSurface } from '@/components/projects/detail/surfaces/ProjectGitSurface';
import { ProjectTerminalSurface } from '@/components/projects/detail/surfaces/ProjectTerminalSurface';
import { ProjectRightPanelBrowserView } from '@/components/projects/detail/browser/ProjectRightPanelBrowserView';
import { ProjectRightPanelServicesView } from '@/components/projects/detail/services/ProjectRightPanelServicesView';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { useServicesOpenInBrowser } from '@/components/sessions/localServices/useServicesOpenInBrowser';
import { useProjectSurfaceActions } from '@/components/projects/detail/useProjectSurfaceActions';
import { useProjectSurfaceController } from '@/components/projects/detail/useProjectSurfaceController';
import { useProjectRouteSurfaceSync } from '@/components/projects/detail/useProjectRouteSurfaceSync';
import type { ProjectMobileSurface } from './projectCockpitState';

type ProjectCockpitShellProps = Readonly<{
    workspaceRef: WorkspaceRefV1;
    scopeId: string;
    activeRootPath: string;
    activeWorktreeId?: string | null;
    surface: ProjectMobileSurface;
    isFocused: boolean;
    onSelectRootPath: (path: string) => void;
}>;

export const ProjectCockpitShell = React.memo((props: ProjectCockpitShellProps) => {
    const { theme } = useUnistyles();
    const { navigateToSurface } = useProjectSurfaceController({
        scopeId: props.scopeId,
        workspaceRef: props.workspaceRef,
        activeRootPath: props.activeRootPath,
        activeWorktreeId: props.activeWorktreeId,
    });
    useProjectRouteSurfaceSync({
        scopeId: props.scopeId,
        workspaceRef: props.workspaceRef,
        activeRootPath: props.activeRootPath,
        activeWorktreeId: props.activeWorktreeId,
        isFocused: props.isFocused,
        surface: props.surface,
    });

    const workspaceCacheKey = React.useMemo(() => buildWorkspaceCacheKey({
        serverId: props.workspaceRef.serverId,
        machineId: props.workspaceRef.machineId,
        rootPath: props.activeRootPath,
    }), [props.activeRootPath, props.workspaceRef.machineId, props.workspaceRef.serverId]);

    const navigateToBrowse = React.useCallback(() => {
        navigateToSurface('browse');
    }, [navigateToSurface]);

    const switchToBrowserSurface = React.useCallback(() => {
        navigateToSurface('browser');
    }, [navigateToSurface]);
    // The mobile browser is a separate full-screen surface with its own pane scope; open a service
    // into that browser workspace, then switch the cockpit to it (only after a mappable target).
    const openServiceInBrowser = useServicesOpenInBrowser({
        scopeId: `${props.scopeId}:browser`,
        scope: 'sessionMobile',
        machineId: props.workspaceRef.machineId,
        serverId: props.workspaceRef.serverId,
        onAfterOpen: switchToBrowserSurface,
    });

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
                <React.Suspense fallback={<ProjectCockpitLoadingFallback color={theme.colors.text.secondary} />}>
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
                <React.Suspense fallback={<ProjectCockpitLoadingFallback color={theme.colors.text.secondary} />}>
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
                <React.Suspense fallback={<ProjectCockpitLoadingFallback color={theme.colors.text.secondary} />}>
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

    if (props.surface === 'browser') {
        return (
            <View testID="project-browser-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                <React.Suspense fallback={<ProjectCockpitLoadingFallback color={theme.colors.text.secondary} />}>
                    <ProjectRightPanelBrowserView workspaceRefId={props.workspaceRef.id} scopeId={`${props.scopeId}:browser`} />
                </React.Suspense>
            </View>
        );
    }

    if (props.surface === 'services') {
        return (
            <View testID="project-services-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                <React.Suspense fallback={<ProjectCockpitLoadingFallback color={theme.colors.text.secondary} />}>
                    <ProjectRightPanelServicesView
                        machineId={props.workspaceRef.machineId}
                        serverId={props.workspaceRef.serverId}
                        workspaceRoot={props.activeRootPath}
                        onOpenServiceInBrowser={openServiceInBrowser}
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
