import * as React from 'react';
import { useProjectNavigationCatalog } from './useProjectNavigationCatalog';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { selectPluginRightSidebarTabPlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { useAppRightSidebarTabInputs } from '@/components/appShell/rightSidebar/appRightSidebarTabs';
import { resolvePluginUiRuntimeFormFactor } from '@/components/appShell/panes/layout/resolveMultiPaneDeviceType';
import { useCodeIntelligencePaneProducer } from '@/components/workspaces/files/intelligence/codeIntelligencePaneStore';
import { resolveProjectTerminalScope } from '@/components/projects/detail/projectTerminalScope';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces';
import { buildProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useProjectRouteActions } from '@/components/projects/detail/useProjectRouteActions';
import { useProjectRouteRouterRef } from '@/components/projects/detail/useProjectRouteRouterRef';
import { buildProjectRouteHref } from '@/components/projects/detail/projectRouteState';
import { normalizeProjectMobileSurface, normalizeProjectPage, type ProjectMobileSurface } from '@/components/workspaceCockpit/project/projectCockpitState';
import { PresentedDetailNavigationBoundary, usePresentedDetailNavigation, type DetailPhoneChrome } from '@/components/appShell/rightSidebar/usePresentedDetailNavigation';
import { ProjectCockpitTabBar, type ProjectCockpitTabBarProps } from '@/components/navigation/mobile/chrome/bars/ProjectCockpitTabBar';
import { selectProjectCockpitItem } from '@/components/navigation/mobile/chrome/cockpitSelection';
import { useActiveDetailsPaneOpen, useActiveTerminalsOpen } from '@/components/appShell/panes/details/useFileTabFront';
import { resolveProjectNavigationCustomizer } from './projectNavigationCustomizer';
import type { ShellColumnActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import type { DetailPageNavigationItem, ProjectDetailNavigationItem } from '@/components/appShell/rightSidebar/detailNavigationItems';
import { useLocalSearchParams, usePathname } from '@/components/appShell/workspace/destinationRoute';
import { useAppShellPluginUiDeclarationSources, type AppShellPluginUiDeclarationSources } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { selectPluginPagePlacements, type PluginPageTarget } from '@/components/plugins/pages/pluginPages';
import { ProjectContextProvider, useProjectContext } from '@/components/projects/useProjectContext';
import { type ProjectPageDescriptor, type ProjectPageCatalogState } from '@/components/projects/detail/projectPageCatalog';
import { resolveProjectRouteSelectionQuery } from '@/components/projects/detail/projectRouteState';
import { resolveProjectCockpitRouteFromPathname, projectPageSelectionId, type ProjectPageSelection } from '@/components/workspaceCockpit/project/projectCockpitState';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { useWorkspaceRefs } from '@/sync/domains/state/storage';
import { resolveProjectCheckoutWorkspaceRef } from '@/sync/domains/workspaces/workspaceRefs';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { useDeviceType } from '@/utils/platform/responsive';
import { usePublishCurrentUiContext } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import { t } from '@/text';

type ProjectCatalogScope = Readonly<{
    scopeId?: string;
    surface?: ProjectMobileSurface;
    workspaceRef: WorkspaceRefV1;
    activeRootPath: string;
    activeWorktreeId?: string | null;
    selection?: ProjectPageSelection;
}>;
export type ProjectPageCatalogModel = Readonly<{
    items: readonly ProjectDetailNavigationItem[];
    activeSurface: ProjectMobileSurface;
    terminalTabAvailable: boolean;
    scopeId: string;
    readColumn: (column: 'main' | 'side') => ShellColumnActionOwner;
    pages: readonly ProjectPageDescriptor[];
    routePages: readonly ProjectPageDescriptor[];
    activePageId: string;
    target: Extract<PluginPageTarget, { kind: 'project' }>;
    context: ReturnType<typeof useProjectContext>;
    projection: AppShellPluginUiDeclarationSources['projection'];
    authority: AppShellPluginUiDeclarationSources['accountLifetime'];
}>;
const Context = React.createContext<ProjectPageCatalogModel | null>(null);
const companionActionId = (item: DetailPageNavigationItem) => item.navigation.kind === 'page' ? item.id : item.navigation.companion;

/** One addressed Project lifetime supplies the body and desktop chrome; phone mounts the same owner. */
export function ProjectPageCatalogProvider(props: ProjectCatalogScope & Readonly<{ children: React.ReactNode }>) {
    const declarations = useAppShellPluginUiDeclarationSources();
    const deviceType = useDeviceType();
    const phone = deviceType === 'phone';
    const destinationScope = useDestinationPaneScopeId(buildProjectPaneScopeId(props.workspaceRef.id, props.workspaceRef.serverId));
    const scopeId = props.scopeId ?? destinationScope;
    const refs = useWorkspaceRefs();
    const locale = usePreferredLanguage();
    const routeParams = useLocalSearchParams<Record<string, string | string[]>>();
    const pathname = usePathname();
    const checkout = React.useMemo(() => resolveProjectCheckoutWorkspaceRef(refs, props.workspaceRef, props.activeRootPath),
        [refs, props.workspaceRef, props.activeRootPath]);
    const serverId = props.workspaceRef.serverId;
    const workspaceRefId = props.workspaceRef.id;
    const defaultRootPath = props.workspaceRef.rootPath;
    const context = useProjectContext({ serverId, projectRef: props.workspaceRef,
        activeCheckout: checkout, authority: declarations.accountLifetime });
    const target = React.useMemo((): Extract<PluginPageTarget, { kind: 'project' }> => ({ kind: 'project',
        workspaceRefId, serverId,
        ...resolveProjectRouteSelectionQuery({ activeRootPath: props.activeRootPath,
            defaultRootPath, activeWorktreeId: props.activeWorktreeId }) }),
        [workspaceRefId, serverId, defaultRootPath, props.activeRootPath, props.activeWorktreeId]);
    const localize = usePluginLocalizedTextResolver({ locale, projection: declarations.projection });
    const placements = React.useMemo(() => declarations.accountLifetime?.isCurrent() !== false
        && (!declarations.accountLifetime || areServerProfileIdentifiersEquivalent(declarations.accountLifetime.scope.serverId, serverId))
        ? selectPluginPagePlacements(declarations.projection, { container: 'appPage', targetKind: 'project' }) : [],
        [declarations.accountLifetime, declarations.projection, serverId]);
    const scoped = useScopedPluginUiProjection({ machineId: props.workspaceRef.machineId, serverId });
    const sidebarPlacements = React.useMemo(() => scoped.pluginUiProjection
        ? selectPluginRightSidebarTabPlacements(scoped.pluginUiProjection, 'project') : [], [scoped.pluginUiProjection]);
    const sidebarLocalize = usePluginLocalizedTextResolver({ locale, projection: scoped.pluginUiProjection });
    const runtimeAdmission = React.useMemo(() => ({ platform: scoped.platform,
        formFactor: resolvePluginUiRuntimeFormFactor({ deviceType }) }), [scoped.platform, deviceType]);
    const appInputs = useAppRightSidebarTabInputs(serverId);
    const codeIntelligenceAvailable = useCodeIntelligencePaneProducer(scopeId) !== null;
    const terminalTabAvailable = checkout !== null && resolveProjectTerminalScope(scopeId, workspaceAddressFromRefV1(checkout)) !== null;
    const mobileSurface = Array.isArray(routeParams.mobileSurface) ? routeParams.mobileSurface[0] : routeParams.mobileSurface;
    const route = React.useMemo(() => resolveProjectCockpitRouteFromPathname(pathname, null, mobileSurface), [pathname, mobileSurface]);
    const selection = React.useMemo((): ProjectPageSelection => props.selection ?? route?.selection ?? { kind: 'builtin', page: route?.page ?? 'overview' }, [props.selection, route]);
    const activePageId = projectPageSelectionId(selection);
    const activePage = selection.kind === 'builtin' ? selection.page : undefined;
    const activeSurface = props.surface ?? route?.surface ?? activePage ?? 'overview';
    const sidebar = React.useMemo(() => ({ ...appInputs, codeIntelligenceAvailable, terminalTabAvailable,
        presentation: phone ? 'mobile' as const : 'desktop' as const, pluginPlacements: sidebarPlacements,
        policyContext: context.policyContext, runtimeAdmission, localize: sidebarLocalize }),
        [appInputs, codeIntelligenceAvailable, terminalTabAvailable, phone, sidebarPlacements, context.policyContext, runtimeAdmission, sidebarLocalize]);
    const previous = React.useRef<Readonly<{ authority: typeof declarations.accountLifetime; target: typeof target;
        locale: typeof locale; state: ProjectPageCatalogState }> | null>(null);
    const baseline = previous.current?.authority === declarations.accountLifetime && previous.current.target === target
        && previous.current.locale === locale ? previous.current.state : undefined;
    const state = useProjectNavigationCatalog({ target, placements, policyContext: context.policyContext, localize, sidebar, activePage, baseline });
    previous.current = { authority: declarations.accountLifetime, target, locale, state };
    const pane = useAppPaneScope(scopeId, scope => ({ isOpen: scope?.right.isOpen, activeTabId: scope?.right.activeTabId }));
    const { navigateToSegment } = useProjectRouteActions({ workspaceRef: props.workspaceRef,
        activeRootPath: props.activeRootPath, activeWorktreeId: props.activeWorktreeId });
    const routerRef = useProjectRouteRouterRef();
    const detailsOpen = useActiveDetailsPaneOpen(scopeId);
    const terminalsOpen = useActiveTerminalsOpen(scopeId);
    const selectItem = (item: ProjectDetailNavigationItem, column: 'main' | 'side') => {
        if (column === 'side' && item.companion) {
            const companion = item.companion;
            if (phone) {
                const surface = normalizeProjectMobileSurface(companion.mobileSurfaces?.project);
                if (surface) void routerRef.current.replace(buildProjectRouteHref({ workspaceRefId, serverId,
                    selection, surface, activeRootPath: props.activeRootPath, defaultRootPath, activeWorktreeId: props.activeWorktreeId }));
                return;
            }
            if (companion.owner === 'plugin') pane.selectRightDestination({ kind: 'plugin', destination: companion.placement.binding.destination });
            else pane.openRight({ tabId: companion.id });
        } else if (item.page) void navigateToSegment({ selection: item.page.selection.kind === 'plugin' && selection.kind === 'plugin'
            && item.id === activePageId ? selection : item.page.selection, method: phone ? 'replace' : 'push' });
        else {
            const surface = normalizeProjectMobileSurface(item.id);
            if (surface) void routerRef.current.replace(buildProjectRouteHref({ workspaceRefId, serverId,
                selection, surface, activeRootPath: props.activeRootPath, defaultRootPath, activeWorktreeId: props.activeWorktreeId }));
        }
    };
    const companions = React.useMemo(() => state.items.flatMap(item => item.companion ? [{ ...item,
        defaultPlacement: item.companion.defaultPlacement, allowedPlacements: item.companion.allowedPlacements }] : []), [state.items]);
    const countScope = React.useMemo(() => ({ context, projection: declarations.projection, authority: declarations.accountLifetime }),
        [context, declarations.projection, declarations.accountLifetime]);
    const chromeRevision = React.useMemo(() => ({ activeSurface, terminalTabAvailable, detailsOpen, terminalsOpen, countScope }),
        [activeSurface, terminalTabAvailable, detailsOpen, terminalsOpen, countScope]);
    const navigation = usePresentedDetailNavigation({ pageKind: 'project', identity: scopeId,
        title: t('navigationPlacement.contextProject'),
        scope: declarations.accountLifetime?.scope ?? null, items: state.items, activeId: activePageId,
        phone, presented: declarations.accountLifetime?.isCurrent() !== false,
        customizer: device => resolveProjectNavigationCustomizer({ items: state.items, device }),
        selectPage: id => { const item = state.items.find(item => item.id === id); if (item) selectItem(item, 'main'); },
        companion: { items: companions, idForItem: companionActionId,
            activeId: pane.scopeState.activeTabId ?? null,
            select: id => { const item = state.items.find(item => item.companion?.id === id); if (item) selectItem(item, 'side'); },
            close: pane.closeRight },
        columnState: column => ({ visible: column === 'main' || pane.scopeState.isOpen === true,
            activeTab: column === 'main' ? phone && !normalizeProjectPage(activeSurface) ? activeSurface : activePageId
                : pane.scopeState.activeTabId ?? undefined,
            setVisible: value => { if (column === 'side') { if (value) pane.openRight(); else pane.closeRight(); } } }),
        chromeRevision,
        phoneChrome: (execute): DetailPhoneChrome | null => {
            if (detailsOpen) return null;
            const catalog = { items: state.items, readColumn: navigation.readColumn };
            const barProps: ProjectCockpitTabBarProps = { workspaceRefId, pages: state.pages, items: state.items, countScope,
                activeSurface, activePageId, terminalTabAvailable, terminalsOpen,
                onPagePress: id => selectProjectCockpitItem(execute, catalog, id, 'main'),
                onSurfacePress: surface => selectProjectCockpitItem(execute, catalog, surface) };
            return { node: <ProjectCockpitTabBar {...barProps} />, systemModel: { kind: 'projectCockpit', props: barProps } };
        } });
    const { readColumn } = navigation;
    const value = React.useMemo(() => ({ pages: state.pages, routePages: state.routePages, items: state.items,
        activePageId, activeSurface, terminalTabAvailable, scopeId, readColumn, target, context,
        projection: declarations.projection, authority: declarations.accountLifetime }),
        [state, activePageId, activeSurface, terminalTabAvailable, scopeId, readColumn, target, context, declarations.projection, declarations.accountLifetime]);
    return <ProjectContextProvider value={context}><Context.Provider value={value}>
        <PresentedDetailNavigationBoundary>{props.children}</PresentedDetailNavigationBoundary>
    </Context.Provider></ProjectContextProvider>;
}

export function useProjectPageCatalog(): ProjectPageCatalogModel {
    const value = React.useContext(Context);
    if (!value) throw new Error('Project page catalog requires its addressed Project provider');
    return value;
}

export function useOptionalProjectPageCatalog(): ProjectPageCatalogModel | null {
    return React.useContext(Context);
}

/** The focused builtin page lends its admitted identities, never paths or Action input. */
export function usePublishProjectUiContext(projectRef: WorkspaceRefV1, activeWorktreeId?: string | null): void {
    const catalog = useOptionalProjectPageCatalog();
    const serverId = catalog?.context.projectIdentity?.serverId;
    const projectKey = catalog?.context.target?.projectKey;
    const workspaceId = catalog?.context.target?.checkout?.id;
    const machineId = catalog?.context.target?.checkout?.machineId;
    const label = resolveWorkspaceRefDisplayName(projectRef);
    const enrichment = React.useMemo(() => serverId && projectKey ? {
        entity: {
            kind: 'project', label,
            reference: { serverId, projectKey,
                ...(workspaceId && machineId ? { workspaceId, machineId, worktreeId: activeWorktreeId ?? null } : {}),
            },
        },
    } : null, [serverId, projectKey, workspaceId, machineId, activeWorktreeId, label]);
    usePublishCurrentUiContext(enrichment);
}
