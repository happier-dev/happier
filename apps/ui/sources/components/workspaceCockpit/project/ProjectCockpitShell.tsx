import * as React from 'react';
import { View } from 'react-native';
import { HAPPIER_COLLECTION_LIST_METRICS, HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
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
import { ProjectMemoryBody } from '@/components/projects/memory/ProjectMemoryBody';
import { ProjectSessionDefaultsBody } from '@/components/projects/sessionDefaults/ProjectSessionDefaultsBody';
import { ProjectDeploymentsBody } from '@/components/projects/deployments/ProjectDeploymentsBody';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { useDeviceType } from '@/utils/platform/responsive';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { usePresentedValue } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useServicesOpenInBrowser } from '@/components/sessions/localServices/useServicesOpenInBrowser';
import { ServerCredentialAccountScopeBindingProvider, useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useProjectSurfaceActions } from '@/components/projects/detail/useProjectSurfaceActions';
import { useProjectSurfaceController } from '@/components/projects/detail/useProjectSurfaceController';
import { useProjectRouteSurfaceSync } from '@/components/projects/detail/useProjectRouteSurfaceSync';
import { CheckoutReachabilityLine, CheckoutReachabilityScope } from '@/components/workspaces/reachability/checkoutReachability';
import type { ProjectMobileSurface, ProjectAttachedDashboardSelection, ProjectPageSelection } from './projectCockpitState';
import { PluginProjectPageBody } from '@/components/projects/detail/PluginProjectPageBody';
import { projectPageActionsKey } from '@/components/projects/shell/ProjectShellHeader';
import { PageActionsLendScope } from '@/components/navigation/stackHeaderActions';
import { normalizeProjectPage } from './projectCockpitState';
import { usePublishProjectUiContext } from '@/components/projects/navigation/useProjectPageCatalog';

type ProjectCockpitShellProps = Readonly<{
    workspaceRef: WorkspaceRefV1;
    scopeId: string;
    activeRootPath: string;
    activeWorktreeId?: string | null;
    layoutId?: string;
    attachedDashboard?: ProjectAttachedDashboardSelection;
    surface: ProjectMobileSurface;
    selection?: ProjectPageSelection;
    isFocused: boolean;
    onSelectRootPath: (path: string) => void;
}>;

/**
 * The Project's page under its header. When the checkout's machine isn't answering, the page says so
 * once here, above every page; the surfaces below inherit it (see `checkoutReachability`). The page also
 * resolves its Home's credential once and lends it to every reader below, as a Session's destination
 * scope does: a page that returns from hiding (Code) keeps that resolution instead of reading it again.
 */
export const ProjectCockpitShell = React.memo((props: ProjectCockpitShellProps) => props.selection?.kind === 'plugin' && normalizeProjectPage(props.surface)
    ? <PageActionsLendScope scopeKey={projectPageActionsKey(props.scopeId)}><PluginProjectPageBody selection={props.selection} /></PageActionsLendScope> : (
    <ProjectCredentialScope serverId={props.workspaceRef.serverId}>
    <CheckoutReachabilityScope scope={props.workspaceRef}>
        <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            {/* Context, Memory, Deployments and Session defaults read the Project source, not the checkout. */}
            {props.surface === 'context' || props.surface === 'memory' || props.surface === 'deployments' || props.surface === 'defaults' ? null
                : <View style={REACHABILITY_LINE_EDGES}><CheckoutReachabilityLine scope={props.workspaceRef} testID="project-checkout-reachability" /></View>}
            <ProjectCockpitSurface {...props} />
        </View>
    </CheckoutReachabilityScope>
    </ProjectCredentialScope>
));

// Above the page, the line stands on the page's content edges (its sheet inset), not on a list's box edge: the line
// keeps its own list-box margin, so the slot adds the rest.
const REACHABILITY_LINE_EDGES = { paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx - HAPPIER_COLLECTION_LIST_METRICS.toolsInset } as const;

function ProjectCredentialScope(props: React.PropsWithChildren<Readonly<{ serverId: string }>>) {
    const credentialScope = useServerCredentialAccountScopeBinding(props.serverId);
    return <ServerCredentialAccountScopeBindingProvider serverId={props.serverId} state={credentialScope}>
        {props.children}
    </ServerCredentialAccountScopeBindingProvider>;
}

const ProjectCockpitSurface = React.memo((props: ProjectCockpitShellProps) => {
    usePublishProjectUiContext(props.workspaceRef, props.activeWorktreeId);
    const { navigateToSurface, navigateToPage, selectDashboard, checkoutWorkspace, codeLocation, navigateCodeLocation, openCodeHistory } = useProjectSurfaceController({
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

    const actions = useProjectSurfaceActions({
        scopeId: props.scopeId,
        workspaceRef: props.workspaceRef,
        activeRootPath: props.activeRootPath,
        onRevealInFilesTreeNavigate: navigateToBrowse,
    });

    // Code, once opened, stays built while another page shows (as the Machine page's tabs do): hidden, it
    // withdraws its effects and keeps the props it last presented, so a return draws the same tree.
    return <>
        <RetainedPanelSurface isActive={props.surface === 'code'} hiddenMode="activity">
            <PresentedProjectFilesScreen
                workspaceRef={props.workspaceRef}
                activeWorktreeId={props.activeWorktreeId}
                scopeId={props.scopeId}
                scope={workspaceScope}
                onOpenFile={actions.openFileInDetails}
                onOpenFilePinned={actions.openFileInDetailsPinned}
                location={codeLocation}
                onNavigate={navigateCodeLocation}
                onOpenHistory={openCodeHistory}
            />
        </RetainedPanelSurface>
        {/* Changes, once opened, stays built too, as the side pane's Git tab does: hidden, its Review keeps its rows
            (and the large-repository model behind them) without reading, so a return draws the same list. */}
        <RetainedPanelSurface isActive={isChangesSurface(props.surface)}>
            <ProjectChangesScreen scopeId={props.scopeId} workspaceRef={props.workspaceRef}
                activeRootPath={props.activeRootPath} onSelectRootPath={props.onSelectRootPath} actions={actions} />
        </RetainedPanelSurface>
        {props.surface === 'code' || isChangesSurface(props.surface) ? null : <ProjectCockpitPage {...props} workspaceScope={workspaceScope}
            checkoutWorkspace={checkoutWorkspace} navigateToSurface={navigateToSurface} navigateToPage={navigateToPage}
            selectDashboard={selectDashboard} actions={actions} />}
    </>;
});

type ProjectFilesScreenProps = React.ComponentProps<typeof ProjectBrowseFilesSurface>;

function ProjectFilesScreen(props: ProjectFilesScreenProps) {
    return (
        <View testID="project-files-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <React.Suspense fallback={<PaneLoadingFallback />}>
                <ProjectBrowseFilesSurface {...props} />
            </React.Suspense>
        </View>
    );
}

/** The retained Code body keeps the props it was last presented with until it shows again. */
function PresentedProjectFilesScreen(props: ProjectFilesScreenProps) {
    return <ProjectFilesScreen {...usePresentedValue(props)} />;
}

const isChangesSurface = (surface: ProjectMobileSurface) => surface === 'changes' || surface === 'git';

function ProjectChangesScreen(props: Readonly<{
    scopeId: string;
    workspaceRef: WorkspaceRefV1;
    activeRootPath: string;
    onSelectRootPath: (path: string) => void;
    actions: ReturnType<typeof useProjectSurfaceActions>;
}>) {
    const { openFileInDetails, openFileInDetailsPinned, openReviewAllChanges, openStashDetails, openCreateWorktreeFlow,
        openCommitInDetails, revealInFilesTree } = props.actions;
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

type ProjectSurfaceController = ReturnType<typeof useProjectSurfaceController>;

/** Every page other than Code and Changes, drawn for the current page only. */
function ProjectCockpitPage(props: ProjectCockpitShellProps & Pick<ProjectSurfaceController,
    'checkoutWorkspace' | 'navigateToSurface' | 'navigateToPage' | 'selectDashboard'> & Readonly<{
    workspaceScope: WorkspaceScopeBase;
    actions: ReturnType<typeof useProjectSurfaceActions>;
}>) {
    const { workspaceScope, checkoutWorkspace, navigateToSurface, navigateToPage, selectDashboard } = props;
    const { openFileInDetails, openFileInDetailsPinned } = props.actions;
    if (props.surface === 'browse') {
        return <ProjectFilesScreen workspaceRef={props.workspaceRef} activeWorktreeId={props.activeWorktreeId}
            scopeId={props.scopeId} scope={workspaceScope} onOpenFile={openFileInDetails} onOpenFilePinned={openFileInDetailsPinned} />;
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
                        presentation="page"
                        onHideWorkspace={() => navigateToPage('overview')}
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
        return <ProjectServicesSurface {...props} navigateToSurface={navigateToSurface} />;
    }

    if (props.surface === 'overview') {
        return <ProjectOverviewWidgets workspaceRef={props.workspaceRef} activeRootPath={props.activeRootPath} activeWorktreeId={props.activeWorktreeId} layoutId={props.layoutId}
            attachedDashboard={props.attachedDashboard}
            onSelectDashboard={selectDashboard} />;
    }

    const openServices = () => navigateToSurface('services');
    if (props.surface === 'scripts') {
        return checkoutWorkspace ? <ProjectScriptsBody workspace={checkoutWorkspace} testID="project-scripts-screen" onOpenServices={openServices} outputScopeId={props.scopeId} />
            : <SurfaceStateCard testID="project-scripts-unavailable" kind="unavailable" title={t('common.unavailable')} />;
    }

    if (props.surface === 'context') {
        return <ProjectContextBody workspaceRef={props.workspaceRef} testID="project-context-screen" />;
    }

    if (props.surface === 'deployments') {
        return <ProjectDeploymentsBody workspaceRef={props.workspaceRef} isFocused={props.isFocused} />;
    }

    if (props.surface === 'memory') {
        return <ProjectMemoryBody workspaceRef={props.workspaceRef} testID="project-memory-screen" />;
    }

    if (props.surface === 'defaults') {
        return <ProjectSessionDefaultsBody workspaceRef={props.workspaceRef} testID="project-session-defaults-screen" />;
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
}

const ProjectServicesSurface = React.memo((props: ProjectCockpitShellProps & Readonly<{
    navigateToSurface: (surface: ProjectMobileSurface) => void;
}>) => {
    const isPhone = useDeviceType() === 'phone';
    const switchToBrowserSurface = React.useCallback(() => {
        props.navigateToSurface('browser');
    }, [props.navigateToSurface]);
    const addService = React.useCallback(() => {
        props.navigateToSurface('scripts');
    }, [props.navigateToSurface]);
    const { binding: accountLifetime } = useServerCredentialAccountScopeBinding(props.workspaceRef.serverId);
    // Desktop opens into this Project's details pane. Phones own a separate full-screen
    // Browser workspace and switch to it only after the shared opener commits its tab.
    const openServiceInBrowser = useServicesOpenInBrowser({
        scopeId: isPhone ? `${props.scopeId}:browser` : props.scopeId,
        scope: isPhone ? 'sessionMobile' : 'workspaceDetails',
        accountLifetime,
        machineId: props.workspaceRef.machineId,
        serverId: props.workspaceRef.serverId,
        onAfterOpen: isPhone ? switchToBrowserSurface : undefined,
    });

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
                    onAddService={addService}
                    testID="project-services-page"
                />
            </React.Suspense>
        </View>
    );
});
