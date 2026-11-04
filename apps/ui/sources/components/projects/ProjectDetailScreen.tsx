import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { PopoverScope } from '@/components/ui/popover';

import { t } from '@/text';
import { useLocalSetting, useWorkspaceRefs } from '@/sync/domains/state/storage';
import { getStorage } from '@/sync/domains/state/storageStore';
import { readProjectSelectionPreference, resolveProjectSelectionPreferenceKeys, writeProjectSelectionPreference } from '@/sync/domains/settings/projectSelectionPersistence';
import { useDeviceType } from '@/utils/platform/responsive';
import { SurfaceStateSizeProvider, useSurfaceStateCardSize } from '@/components/ui/surfaces/surfaceStateSize';
import { AppPaneScopeHost } from '@/components/appShell/panes/AppPaneScopeHost';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { PluginSurfaceOpenHandler } from '@/components/plugins/surfaces/openPluginSurface';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { useResolvedRepoWorktreeSelection } from '@/components/workspaces/scm/worktrees/useResolvedRepoWorktreeSelection';
import { findVisibleRepoWorktreeByPath } from '@/components/workspaces/scm/worktrees/repoWorktreeIdentity';
import { buildProjectPaneScopeId } from './detail/projectPaneScope';
import { resolveProjectRightTabId } from './detail/resolveProjectRightTabId';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { PROJECT_ROUTE_ROOT_SENTINEL, type ProjectPageV1, type ProjectMobileSurface, type ProjectAttachedDashboardSelection } from './detail/projectRouteState';
import { ProjectCockpitShell } from '@/components/workspaceCockpit/project/ProjectCockpitShell';
import { WorkspaceDetailsPanel } from '@/components/projects/panes/WorkspaceDetailsPanel';
import { useWorkspaceRefById } from './detail/useWorkspaceRefById';
import { ProjectRightPanel, ProjectRightSidebarProvider, ProjectRightSidebarRail } from './detail/ProjectRightPanel';
import { ProjectWorktreeRecoveryToast } from './detail/ProjectWorktreeRecoveryToast';
import { ProjectOpenResolutionPage } from './ProjectOpenResolution';
import { ProjectPhoneCheckoutRow, ProjectShellHeaderHost } from './shell/ProjectShellHeaderHost';
import { ListPresentationProvider, PageColumnProvider } from '@/components/ui/lists/listPresentation';
import { useProjectRouteActions } from './detail/useProjectRouteActions';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { RIGHT_SIDEBAR_BUILTIN_TABS } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import { ProjectTerminalSurface } from './detail/surfaces/ProjectTerminalSurface';
import { resolveProjectCheckoutWorkspaceRef } from '@/sync/domains/workspaces/workspaceRefs';
import type { WorkspaceRefResolutionV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { WorkspaceRefUnconfirmed } from './detail/useWorkspaceRefById';
import { ProjectAtmosphereFrame, ProjectAtmosphereLookChip } from '@/components/atmosphere/ProjectAtmosphereFrame';
import { useAtmosphereBandBoundary } from '@/components/atmosphere/atmosphereBandBoundary';
import { resolveWorkspaceRefDisplayName } from './resolveWorkspaceRefDisplayName';
import { Text } from '@/components/ui/text/Text';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';

const PROJECT_BUILTIN_DESTINATION_IDS = RIGHT_SIDEBAR_BUILTIN_TABS
    .filter((tab) => tab.scopes.includes('project'))
    .map((tab) => tab.id);

export const ProjectDetailScreen = React.memo((props: Readonly<{
    workspaceRefId: string;
    paneScopeId?: string;
    selectedPaneTabKey?: string;
    serverId?: string | null;
    /** Qualified candidate/recovery state from the route owner; U2 owns its presentation. */
    workspaceResolution?: WorkspaceRefResolutionV1 | WorkspaceRefUnconfirmed;
    layoutId?: string;
    attachedDashboard?: ProjectAttachedDashboardSelection;
    recoveryToastKey?: string | null;
    page?: ProjectPageV1;
    surface?: ProjectMobileSurface;
    activeWorktreeId?: string | null;
    activeRootPath?: string | null;
    isFocused?: boolean;
    showWorktrees?: boolean;
    onSelectRootPath?: (path: string) => void;
    onSetShowWorktrees?: (nextValue: boolean) => void;
    onPluginSurfaceOpenChange?: (handler: PluginSurfaceOpenHandler | undefined) => void;
}>) => {
    const { theme } = useUnistyles();
    const deviceType = useDeviceType();
    const enclosingStateSize = useSurfaceStateCardSize();
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;
    const lastActiveRootPathByWorkspaceRefId = useLocalSetting('projectLastActiveRootPathByWorkspaceRefId');
    const lastActiveWorktreeIdByWorkspaceRefId = useLocalSetting('projectLastActiveWorktreeIdByWorkspaceRefId');
    const workspaceRef = useWorkspaceRefById(props.workspaceRefId, props.serverId);
    const destinationScopeId = useDestinationPaneScopeId(buildProjectPaneScopeId(props.workspaceRefId, workspaceRef?.serverId ?? props.serverId));
    const scopeId = props.paneScopeId ?? destinationScopeId;
    const pane = useAppPaneScope(scopeId, () => null);
    // The page's menus and Add surfaces float inside its own column (header and body), never over the sidebar.
    const pageColumnRef = React.useRef<View>(null);
    const workspaceRefs = useWorkspaceRefs();
    const preferenceKeys = React.useMemo(() => workspaceRef
        ? resolveProjectSelectionPreferenceKeys(workspaceRefs, workspaceRef) : null, [workspaceRef, workspaceRefs]);
    // This direct Project adapter is the one public target/currentness source
    // consumed by AppPane. Keep the projection lookup here rather than giving
    // AppPane a fallback lookup keyed by an opaque scope id.
    const pluginProjection = useScopedPluginUiProjection({
        machineId: workspaceRef?.machineId ?? null,
        serverId: workspaceRef?.serverId ?? null,
    });
    const [localSelection, setLocalSelection] = React.useState<Readonly<{ storageKey: string; rootPath: string }> | null>(null);
    const localActiveRootPath = localSelection?.storageKey === preferenceKeys?.storageKey ? localSelection?.rootPath ?? null : null;
    const controlledActiveRootPath = props.activeRootPath ?? null;
    const workspaceRootPath = workspaceRef?.rootPath ?? '';
    const persistedActiveRootPath = readProjectSelectionPreference(lastActiveRootPathByWorkspaceRefId, preferenceKeys);
    const persistedWorktreeId = readProjectSelectionPreference(lastActiveWorktreeIdByWorkspaceRefId, preferenceKeys);
    React.useEffect(() => {
        if (!workspaceRef || !preferenceKeys) return;
        if (controlledActiveRootPath != null) return;
        setLocalSelection((currentSelection) => {
            const currentPath = currentSelection?.storageKey === preferenceKeys.storageKey ? currentSelection.rootPath : null;
            if (currentPath == null) {
                return { storageKey: preferenceKeys.storageKey, rootPath: persistedActiveRootPath ?? workspaceRef.rootPath };
            }
            if (
                persistedActiveRootPath
                && currentPath === workspaceRef.rootPath
                && persistedActiveRootPath !== workspaceRef.rootPath
            ) {
                return { storageKey: preferenceKeys.storageKey, rootPath: persistedActiveRootPath };
            }
            return currentSelection;
        });
    }, [controlledActiveRootPath, persistedActiveRootPath, preferenceKeys, workspaceRef]);

    const requestedActiveRootPath = controlledActiveRootPath ?? localActiveRootPath ?? persistedActiveRootPath ?? workspaceRootPath;
    const {
        requestedRootPath,
        resolvedRootPath: resolvedActiveRootPath,
        resolvedWorktreeId: resolvedActiveWorktreeId,
        didRecoverMissingWorktree,
        availableWorktrees,
    } = useResolvedRepoWorktreeSelection({
        serverId: workspaceRef?.serverId ?? '',
        machineId: workspaceRef?.machineId ?? '',
        defaultRootPath: workspaceRootPath,
        requestedRootPath: requestedActiveRootPath,
        requestedWorktreeId: props.activeWorktreeId ?? (workspaceRef != null
            && controlledActiveRootPath == null
            && localActiveRootPath == null
            && persistedWorktreeId !== PROJECT_ROUTE_ROOT_SENTINEL
                ? persistedWorktreeId
                : null),
    });
    const recoveryToastKey = props.recoveryToastKey ?? (didRecoverMissingWorktree
        ? `${workspaceRef?.id ?? props.workspaceRefId}:${requestedRootPath}`
        : null);
    const { navigateToSegment } = useProjectRouteActions({
        workspaceRef,
        activeRootPath: resolvedActiveRootPath,
        activeWorktreeId: resolvedActiveWorktreeId,
        pane,
    });
    const handleSelectPage = React.useCallback((page: ProjectPageV1) => {
        navigateToSegment({ segment: page });
    }, [navigateToSegment]);
    const handleSelectWorkspace = React.useCallback((workspaceRef: WorkspaceRefV1) => {
        navigateToSegment({ workspaceRef });
    }, [navigateToSegment]);
    const handleSelectRootPath = React.useCallback((path: string) => {
        const trimmedPath = path.trim();
        if (!trimmedPath || !workspaceRef || !preferenceKeys) return;
        const nextWorktreeId = trimmedPath === workspaceRef.rootPath
            ? null
            : (findVisibleRepoWorktreeByPath(availableWorktrees, trimmedPath)?.id ?? null);
        if (controlledActiveRootPath == null) {
            setLocalSelection({ storageKey: preferenceKeys.storageKey, rootPath: trimmedPath });
        }
        getStorage().getState().applyLocalSettings({
            projectLastActiveRootPathByWorkspaceRefId: writeProjectSelectionPreference(lastActiveRootPathByWorkspaceRefId, preferenceKeys, trimmedPath),
            projectLastActiveWorktreeIdByWorkspaceRefId: writeProjectSelectionPreference(lastActiveWorktreeIdByWorkspaceRefId, preferenceKeys, nextWorktreeId ?? PROJECT_ROUTE_ROOT_SENTINEL),
        }, { source: 'ui' });
        props.onSelectRootPath?.(trimmedPath);
    }, [
        availableWorktrees,
        controlledActiveRootPath,
        lastActiveRootPathByWorkspaceRefId,
        lastActiveWorktreeIdByWorkspaceRefId,
        props.onSelectRootPath,
        props.workspaceRefId,
        preferenceKeys,
        workspaceRef,
    ]);

    React.useEffect(() => {
        if (props.isFocused === false) return;
        if (!workspaceRef || !preferenceKeys) return;
        if (requestedRootPath === resolvedActiveRootPath) return;

        getStorage().getState().applyLocalSettings({
            projectLastActiveRootPathByWorkspaceRefId: writeProjectSelectionPreference(lastActiveRootPathByWorkspaceRefId, preferenceKeys, resolvedActiveRootPath),
            projectLastActiveWorktreeIdByWorkspaceRefId: writeProjectSelectionPreference(lastActiveWorktreeIdByWorkspaceRefId, preferenceKeys, resolvedActiveWorktreeId ?? PROJECT_ROUTE_ROOT_SENTINEL),
        }, { source: 'ui' });

        if (controlledActiveRootPath == null) {
            setLocalSelection({ storageKey: preferenceKeys.storageKey, rootPath: resolvedActiveRootPath });
        }

        if (controlledActiveRootPath != null) {
            props.onSelectRootPath?.(resolvedActiveRootPath);
        }
    }, [
        controlledActiveRootPath,
        lastActiveRootPathByWorkspaceRefId,
        lastActiveWorktreeIdByWorkspaceRefId,
        props.isFocused,
        props.onSelectRootPath,
        props.workspaceRefId,
        preferenceKeys,
        requestedRootPath,
        resolvedActiveRootPath,
        resolvedActiveWorktreeId,
        workspaceRef,
    ]);

    const projectSurfaceScope = React.useMemo(() => (
        workspaceRef
            ? {
                targetKind: 'project' as const,
                projectId: workspaceRef.id,
                machineId: workspaceRef.machineId,
                serverId: workspaceRef.serverId,
                pluginUiProjection: pluginProjection.pluginUiProjection,
                accountLifetime: pluginProjection.accountLifetime,
                projectionPhase: pluginProjection.phase,
                interactionEnabled: pluginProjection.interactionEnabled,
                platform: pluginProjection.platform,
            }
            : null
    ), [
        pluginProjection.interactionEnabled,
        pluginProjection.phase,
        pluginProjection.platform,
        pluginProjection.pluginUiProjection,
        pluginProjection.accountLifetime,
        workspaceRef,
    ]);
    const renderProjectRightSidebar = React.useCallback(() => (
        workspaceRef
            ? <ProjectRightPanel
                activePage={props.page ?? 'overview'}
                scopeId={scopeId}
                workspaceRef={workspaceRef}
                activeRootPath={resolvedActiveRootPath}
                activeWorktreeId={resolvedActiveWorktreeId}
                onSelectRootPath={handleSelectRootPath}
            />
            : null
    ), [handleSelectRootPath, props.page, resolvedActiveRootPath, resolvedActiveWorktreeId, scopeId, workspaceRef]);
    const projectRightPaneBuiltinAdapter = React.useMemo(() => ({
        // Every built-in tab this pane can draw; availability (e.g. Problems while a File page offers them) is the panel's.
        destinationIds: PROJECT_BUILTIN_DESTINATION_IDS,
        defaultDestinationId: 'files',
        render: renderProjectRightSidebar,
    }), [renderProjectRightSidebar]);
    const projectRightSidebarAdapter = React.useMemo(() => ({
        render: renderProjectRightSidebar,
        renderActionRail: () => <ProjectRightSidebarRail />,
    }), [renderProjectRightSidebar]);
    const projectDetailsPaneAdapter = React.useMemo(() => ({
        destinationIds: ['details'],
        defaultDestinationId: 'details',
        render: () => workspaceRef ? <WorkspaceDetailsPanel
            workspaceRef={workspaceRef}
            scopeId={scopeId}
            activeRootPath={resolvedActiveRootPath}
            activeWorktreeId={resolvedActiveWorktreeId}
        /> : null,
    }), [resolvedActiveRootPath, resolvedActiveWorktreeId, scopeId, workspaceRef]);
    const terminalCheckout = React.useMemo(() => workspaceRef
        ? resolveProjectCheckoutWorkspaceRef(workspaceRefs, workspaceRef, resolvedActiveRootPath) : null,
    [resolvedActiveRootPath, workspaceRef, workspaceRefs]);
    const terminalWorkspace = React.useMemo(() => terminalCheckout ? {
        serverId: terminalCheckout.serverId, machineId: terminalCheckout.machineId,
        workspaceId: terminalCheckout.id, rootPath: terminalCheckout.rootPath,
    } : null, [terminalCheckout]);
    const projectBottomPaneAdapter = React.useMemo(() => ({
        destinationIds: ['terminal'],
        defaultDestinationId: 'terminal',
        render: () => workspaceRef ? <ProjectTerminalSurface scopeId={scopeId} workspaceRefId={workspaceRef.id}
            serverId={workspaceRef.serverId} machineId={workspaceRef.machineId} rootPath={resolvedActiveRootPath}
            workspace={terminalWorkspace} /> : null,
    }), [resolvedActiveRootPath, scopeId, terminalWorkspace, workspaceRef]);
    const wrapProjectScopeContent = React.useCallback((content: React.ReactNode) => (
        workspaceRef ? (
            <ProjectRightSidebarProvider
                activePage={props.page ?? 'overview'}
                scopeId={scopeId}
                workspaceRef={workspaceRef}
                activeRootPath={resolvedActiveRootPath}
                activeWorktreeId={resolvedActiveWorktreeId}
                onSelectRootPath={handleSelectRootPath}
            >
                {content}
            </ProjectRightSidebarProvider>
        ) : content
    ), [handleSelectRootPath, props.page, resolvedActiveRootPath, resolvedActiveWorktreeId, scopeId, workspaceRef]);

    if (!workspaceRef) {
        return <ProjectOpenResolutionPage resolution={props.workspaceResolution} />;
    }

    const mainSurface = deviceType === 'phone' ? props.surface ?? props.page ?? 'overview' : props.page ?? 'overview';
    const widePage = mainSurface === 'overview' || mainSurface === 'code';

    return (
        <ProjectAtmosphereFrame project={{ serverId: workspaceRef.serverId, projectKey: workspaceRef.projectKey ?? workspaceRef.id }} focused={props.isFocused} column={pageColumnRef}>
        <View style={{ flex: 1 }} {...pane.overlayFocusReturnCaptureProps}>
            <AppPaneScopeHost
                scopeId={scopeId}
                selectedPaneTabKey={props.selectedPaneTabKey}
                arrangement="honour"
                mainColumn={{
                    hideLabel: t('panes.mainColumn.hideProject'),
                    showLabel: t('panes.mainColumn.showProject'),
                    identity: {
                        mark: <Icon name="folder" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />,
                        name: resolveWorkspaceRefDisplayName(workspaceRef),
                    },
                }}
                initialRight={multiPaneEnabled && deviceType === 'tablet'
                    ? { isOpen: true, activeTabId: resolveProjectRightTabId(null) }
                    : undefined}
                onPluginSurfaceOpenChange={props.onPluginSurfaceOpenChange}
                detailsPaneEnabled
                detailsPaneBuiltinAdapter={projectDetailsPaneAdapter}
                surfaceScope={projectSurfaceScope!}
                rightPaneBuiltinAdapter={projectRightPaneBuiltinAdapter}
                bottomPaneBuiltinAdapter={projectBottomPaneAdapter}
                rightSidebarAdapter={projectRightSidebarAdapter}
                wrapScopeContent={wrapProjectScopeContent}
                main={(
                    <ListPresentationProvider value="page">
                        <PageColumnProvider value={widePage ? 'wide' : 'reading'}>
                            <View ref={pageColumnRef} style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                                <PopoverScope boundaryRef={pageColumnRef}>
                                {/* The six-page header (12s1) always spans the wide page column so it never shifts between
                                    pages; each body keeps its own column above. Phones keep the navigation bar and the page cockpit. */}
                                {deviceType !== 'phone' ? (
                                    <PageColumnProvider value="wide">
                                    <ProjectShellHeaderHost
                                        workspaceRef={workspaceRef}
                                        page={props.page ?? 'overview'}
                                        activeRootPath={resolvedActiveRootPath}
                                        activeWorktreeId={resolvedActiveWorktreeId}
                                        onSelectRootPath={handleSelectRootPath}
                                        onSelectPage={handleSelectPage}
                                        onSelectWorkspace={handleSelectWorkspace}
                                        menuActions={[{ id: 'terminal', title: t('settings.terminal'),
                                            onSelect: () => pane.openBottom({ tabId: 'terminal' }) }]}
                                    />
                                    </PageColumnProvider>
                                ) : props.surface === undefined || props.surface === props.page ? (
                                    <ProjectPhoneAtmosphereHeader>
                                        <ProjectPhoneCheckoutRow
                                            workspaceRef={workspaceRef}
                                            activeRootPath={resolvedActiveRootPath}
                                            activeWorktreeId={resolvedActiveWorktreeId}
                                            onSelectRootPath={handleSelectRootPath}
                                            onSelectWorkspace={handleSelectWorkspace}
                                        />
                                    </ProjectPhoneAtmosphereHeader>
                                ) : null}
                                {/* A phone's page cockpit is a phone host: its pages (the File page's key row and toolbar,
                                    state cards) take the phone composition, as the Session cockpit does. */}
                                <SurfaceStateSizeProvider size={deviceType === 'phone' ? 'phone' : enclosingStateSize}>
                                <ProjectCockpitShell
                                    scopeId={scopeId}
                                    workspaceRef={workspaceRef}
                                    activeRootPath={resolvedActiveRootPath}
                                    activeWorktreeId={resolvedActiveWorktreeId}
                                    surface={mainSurface}
                                    layoutId={props.layoutId}
                                    attachedDashboard={props.attachedDashboard}
                                    isFocused={props.isFocused !== false}
                                    onSelectRootPath={handleSelectRootPath}
                                />
                                </SurfaceStateSizeProvider>
                                </PopoverScope>
                            </View>
                        </PageColumnProvider>
                    </ListPresentationProvider>
                )}
            />
            <ProjectWorktreeRecoveryToast recoveryToastKey={recoveryToastKey} />
        </View>
        </ProjectAtmosphereFrame>
    );
});

function ProjectPhoneAtmosphereHeader(props: Readonly<{ children: React.ReactNode }>) {
    const boundary = useAtmosphereBandBoundary();
    // The Look sits on the checkout field's line (its trailing control), never on a row of its own.
    return <View ref={boundary?.ref} onLayout={boundary?.onLayout}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}>
        <View style={{ flex: 1, minWidth: 0 }}>{props.children}</View>
        <ProjectAtmosphereLookChip />
    </View>;
}
