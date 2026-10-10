import * as React from 'react';
import { View } from 'react-native';

import { t } from '@/text';
import { useLocalSetting, useLocalSettingMutable, useWorkspaceRefs } from '@/sync/domains/state/storage';
import { readProjectSelectionPreference, resolveProjectSelectionPreferenceKeys, writeProjectSelectionPreference } from '@/sync/domains/settings/projectSelectionPersistence';
import { useDeviceType } from '@/utils/platform/responsive';
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
import { resolveProjectRightSidebarTabs } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import { ProjectTerminalSurface } from './detail/surfaces/ProjectTerminalSurface';
import { resolveProjectCheckoutWorkspaceRef } from '@/sync/domains/workspaces/workspaceRefs';
import type { WorkspaceRefResolutionV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

export const ProjectDetailScreen = React.memo((props: Readonly<{
    workspaceRefId: string;
    serverId?: string | null;
    /** Qualified candidate/recovery state from the route owner; U2 owns its presentation. */
    workspaceResolution?: WorkspaceRefResolutionV1;
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
    const deviceType = useDeviceType();
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;
    const lastActiveRootPathByWorkspaceRefId = useLocalSetting('projectLastActiveRootPathByWorkspaceRefId');
    const lastActiveWorktreeIdByWorkspaceRefId = useLocalSetting('projectLastActiveWorktreeIdByWorkspaceRefId');
    const [, setLastActiveRootPathByWorkspaceRefId] = useLocalSettingMutable('projectLastActiveRootPathByWorkspaceRefId');
    const [, setLastActiveWorktreeIdByWorkspaceRefId] = useLocalSettingMutable('projectLastActiveWorktreeIdByWorkspaceRefId');
    const workspaceRef = useWorkspaceRefById(props.workspaceRefId, props.serverId);
    const scopeId = useDestinationPaneScopeId(buildProjectPaneScopeId(props.workspaceRefId, workspaceRef?.serverId ?? props.serverId));
    const pane = useAppPaneScope(scopeId);
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
        setLastActiveRootPathByWorkspaceRefId(writeProjectSelectionPreference(lastActiveRootPathByWorkspaceRefId, preferenceKeys, trimmedPath));
        setLastActiveWorktreeIdByWorkspaceRefId(writeProjectSelectionPreference(lastActiveWorktreeIdByWorkspaceRefId, preferenceKeys, nextWorktreeId ?? PROJECT_ROUTE_ROOT_SENTINEL));
        props.onSelectRootPath?.(trimmedPath);
    }, [
        availableWorktrees,
        controlledActiveRootPath,
        lastActiveRootPathByWorkspaceRefId,
        lastActiveWorktreeIdByWorkspaceRefId,
        props.onSelectRootPath,
        props.workspaceRefId,
        preferenceKeys,
        setLastActiveRootPathByWorkspaceRefId,
        setLastActiveWorktreeIdByWorkspaceRefId,
        workspaceRef,
    ]);

    React.useEffect(() => {
        if (props.isFocused === false) return;
        if (!workspaceRef || !preferenceKeys) return;
        if (requestedRootPath === resolvedActiveRootPath) return;

        setLastActiveRootPathByWorkspaceRefId(writeProjectSelectionPreference(lastActiveRootPathByWorkspaceRefId, preferenceKeys, resolvedActiveRootPath));
        setLastActiveWorktreeIdByWorkspaceRefId(writeProjectSelectionPreference(lastActiveWorktreeIdByWorkspaceRefId, preferenceKeys, resolvedActiveWorktreeId ?? PROJECT_ROUTE_ROOT_SENTINEL));

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
        setLastActiveRootPathByWorkspaceRefId,
        setLastActiveWorktreeIdByWorkspaceRefId,
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
        destinationIds: resolveProjectRightSidebarTabs({ presentation: deviceType === 'phone' ? 'mobile' : 'desktop' })
            .filter(tab => tab.owner === 'builtin').map(tab => tab.id),
        defaultDestinationId: 'files',
        render: renderProjectRightSidebar,
    }), [deviceType, renderProjectRightSidebar]);
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
        <View style={{ flex: 1 }} {...pane.overlayFocusReturnCaptureProps}>
            <AppPaneScopeHost
                scopeId={scopeId}
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
                        <PageColumnProvider value={widePage ? 'wide' : 'reading'} preferencePolicy={widePage ? 'ignore' : 'respect'}>
                            <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                                {/* The six-page header (12s1); phones keep the navigation bar and the page cockpit. */}
                                {deviceType !== 'phone' ? (
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
                                ) : props.surface === undefined || props.surface === props.page ? (
                                    <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}>
                                        <ProjectPhoneCheckoutRow
                                            workspaceRef={workspaceRef}
                                            activeRootPath={resolvedActiveRootPath}
                                            activeWorktreeId={resolvedActiveWorktreeId}
                                            onSelectRootPath={handleSelectRootPath}
                                            onSelectWorkspace={handleSelectWorkspace}
                                        />
                                    </View>
                                ) : null}
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
                            </View>
                        </PageColumnProvider>
                    </ListPresentationProvider>
                )}
            />
            <ProjectWorktreeRecoveryToast recoveryToastKey={recoveryToastKey} />
        </View>
    );
});
