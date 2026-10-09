import * as React from 'react';
import { View } from 'react-native';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { ProjectDetailsMainPanel } from '@/components/projects/detail/ProjectDetailsMainPanel';
import { ProjectOverviewWidgets } from '@/components/projects/detail/ProjectOverviewWidgets';
import { ProjectBrowseFilesSurface } from '@/components/projects/detail/surfaces/ProjectBrowseFilesSurface';
import { ProjectGitSurface } from '@/components/projects/detail/surfaces/ProjectGitSurface';
import { ProjectTerminalSurface } from '@/components/projects/detail/surfaces/ProjectTerminalSurface';
import { ProjectRightPanelBrowserView } from '@/components/projects/detail/browser/ProjectRightPanelBrowserView';
import { ProjectRightPanelServicesView } from '@/components/projects/detail/services/ProjectRightPanelServicesView';
import { ProjectScriptsBody } from '@/components/projects/projectSetup/ProjectScriptsBody';
import { ProjectContextBody } from '@/components/projects/context/ProjectContextBody';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { useServicesOpenInBrowser } from '@/components/sessions/localServices/useServicesOpenInBrowser';
import { useProjectSurfaceActions } from '@/components/projects/detail/useProjectSurfaceActions';
import { useProjectSurfaceController } from '@/components/projects/detail/useProjectSurfaceController';
import { useProjectRouteSurfaceSync } from '@/components/projects/detail/useProjectRouteSurfaceSync';
import { ProjectAsideWidgets } from '@/components/widgets/area/ProjectWidgetArea';
import { useWorkspaceRefs } from '@/sync/domains/state/storage';
import { resolveProjectCheckoutWorkspaceRef } from '@/sync/domains/workspaces/workspaceRefs';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import type { ProjectMobileSurface } from './projectCockpitState';

type ProjectCockpitShellProps = Readonly<{
    workspaceRef: WorkspaceRefV1;
    scopeId: string;
    activeRootPath: string;
    activeWorktreeId?: string | null;
    dashboardId?: string;
    surface: ProjectMobileSurface;
    isFocused: boolean;
    onSelectRootPath: (path: string) => void;
}>;

export const ProjectCockpitShell = React.memo((props: ProjectCockpitShellProps) => {
    const refs = useWorkspaceRefs();
    const activeCheckout = React.useMemo(() => resolveProjectCheckoutWorkspaceRef(refs, props.workspaceRef, props.activeRootPath) ?? undefined,
        [props.activeRootPath, props.workspaceRef, refs]);
    const { navigateToSurface, selectDashboard, checkoutWorkspace } = useProjectSurfaceController({
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

    const workspaceScope = React.useMemo((): WorkspaceScopeBase => ({
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

    if (props.surface === 'code' || props.surface === 'browse') {
        // A Files companion remains a focused browser. Only the canonical Code page hosts its widgets.
        const aside = props.surface === 'code' ? <ProjectAsideWidgets serverId={props.workspaceRef.serverId}
            projectName={resolveWorkspaceRefDisplayName(props.workspaceRef)} projectRef={props.workspaceRef}
            activeCheckout={activeCheckout} dashboardId={props.dashboardId} testID="project-code-aside" /> : null;
        const browser = <React.Suspense fallback={<PaneLoadingFallback />}>
            <ProjectBrowseFilesSurface
                workspaceRef={props.workspaceRef}
                activeWorktreeId={props.activeWorktreeId}
                scopeId={props.scopeId}
                scope={workspaceScope}
                onOpenFile={openFileInDetails}
                onOpenFilePinned={openFileInDetailsPinned}
                aside={aside}
            />
        </React.Suspense>;
        return (
            <View testID="project-files-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                {browser}
            </View>
        );
    }

    if (props.surface === 'changes' || props.surface === 'git') {
        return (
            <View testID="project-git-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                <React.Suspense fallback={<PaneLoadingFallback />}>
                    <ProjectGitSurface
                        scopeId={props.scopeId}
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
                <React.Suspense fallback={<PaneLoadingFallback />}>
                    <ProjectTerminalSurface
                        scopeId={props.scopeId}
                        workspaceRefId={props.workspaceRef.id}
                        machineId={props.workspaceRef.machineId}
                        rootPath={props.activeRootPath}
                        serverId={props.workspaceRef.serverId}
                        workspace={checkoutWorkspace}
                    />
                </React.Suspense>
            </View>
        );
    }

    if (props.surface === 'browser') {
        return (
            <View testID="project-browser-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                <React.Suspense fallback={<PaneLoadingFallback />}>
                    <ProjectRightPanelBrowserView workspaceRefId={props.workspaceRef.id} scopeId={`${props.scopeId}:browser`} workspaceScope={workspaceScope} />
                </React.Suspense>
            </View>
        );
    }

    if (props.surface === 'services') {
        return (
            <View testID="project-services-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                <React.Suspense fallback={<PaneLoadingFallback />}>
                    <ProjectRightPanelServicesView
                        machineId={props.workspaceRef.machineId}
                        workspaceRefId={props.workspaceRef.id}
                        serverId={props.workspaceRef.serverId}
                        workspaceRoot={props.activeRootPath}
                        onOpenServiceInBrowser={openServiceInBrowser}
                        presentation="page"
                        testID="project-services-page"
                    />
                </React.Suspense>
            </View>
        );
    }

    if (props.surface === 'overview') {
        return <ProjectOverviewWidgets workspaceRef={props.workspaceRef} activeRootPath={props.activeRootPath} dashboardId={props.dashboardId}
            onSelectDashboard={selectDashboard} />;
    }

    const openServices = () => navigateToSurface('services');
    if (props.surface === 'scripts') {
        return checkoutWorkspace ? <ProjectScriptsBody workspace={checkoutWorkspace} testID="project-scripts-screen" onOpenServices={openServices} />
            : <SurfaceStateCard testID="project-scripts-unavailable" kind="unavailable" title={t('common.unavailable')} />;
    }

    if (props.surface === 'context') {
        return <ProjectContextBody workspaceRef={props.workspaceRef} testID="project-context-screen" />;
    }

    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <ProjectDetailsMainPanel
                workspaceRef={props.workspaceRef}
                scopeId={props.scopeId}
                activeRootPath={props.activeRootPath}
                activeWorktreeId={props.activeWorktreeId}
                onSelectRootPath={props.onSelectRootPath}
            />
        </View>
    );
});
