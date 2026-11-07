import * as React from 'react';
import { usePublishRightSidebarActions } from '@/components/appShell/rightSidebar/rightSidebarActions';
import { AppPaneScopeHost, type AppPaneScopeHostProps } from '@/components/appShell/panes/AppPaneScopeHost';
import { useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import type { PaneDriver } from '@/components/appShell/panes/types';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { PluginPageContent } from '@/components/plugins/pages/PluginPageContent';
import { PluginPageLaunchInputScope, usePluginPageDestinationHandler } from '@/components/plugins/pages/pluginPageNavigation';
import { buildPluginProjectPageRoutePath } from '@/components/plugins/pages/pluginPageRoute';
import { useRegisterPluginSurfaceDestinationNavigationOwner } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { useProjectPageCatalog } from '@/components/projects/navigation/useProjectPageCatalog';
import type { ProjectPageSelection } from '@/components/workspaceCockpit/project/projectCockpitState';
import type { PluginPage } from '@/components/plugins/pages/pluginPages';

/** Registration belongs to the Project host, including before its first plugin page opens. */
function ProjectPageNavigationRegistration(props: Readonly<{ pages: readonly PluginPage[]; children: React.ReactNode }>) {
    const catalog = useProjectPageCatalog();
    const main = catalog.readColumn('main');
    const side = catalog.readColumn('side');
    usePublishRightSidebarActions({ tabs: side.tabs ?? [], items: side.items, activeTab: side.activeTab,
        selectTab: id => side.selectTab?.(id), main: { tabs: main.tabs ?? [], items: main.items,
            activeTab: main.activeTab, selectTab: id => main.selectTab?.(id) } });
    const handler = usePluginPageDestinationHandler({ pages: props.pages });
    const owner = React.useMemo(() => ({ container: 'appPage' as const, handler }), [handler]);
    useRegisterPluginSurfaceDestinationNavigationOwner(owner);
    return <>{props.children}</>;
}

/** Adapt pages into the existing Project pane binding; there is still one physical pane host. */
export function ProjectPagePaneScopeHost(props: AppPaneScopeHostProps) {
    const { surfaceScope: suppliedSurfaceScope, rightPaneBuiltinAdapter, rightSidebarAdapter,
        bottomPaneBuiltinAdapter, detailsPaneBuiltinAdapter, detailsPaneEnabled, ...hostProps } = props;
    const registerDriver = useAppPaneContext(value => value.registerDriver);
    const catalog = useProjectPageCatalog();
    const projection = useAppShellPluginUiProjection();
    const pages = React.useMemo(() => catalog.routePages.flatMap(page => page.pluginPage ? [page.pluginPage] : []), [catalog.routePages]);
    const placements = React.useMemo(() => pages.map(page => page.placement), [pages]);
    const surfaceScope = React.useMemo(() => suppliedSurfaceScope?.targetKind === 'project' ? {
        ...suppliedSurfaceScope,
        projectId: catalog.context.target?.checkout?.id,
        projectContext: catalog.context,
        policyContext: catalog.context.policyContext,
    } : suppliedSurfaceScope, [suppliedSurfaceScope, catalog.context]);
    // Both the retained pane and the phone Start sheet consume this registration.
    const driver = React.useMemo<PaneDriver>(() => ({ scopeId: props.scopeId, surfaceScope,
        rightPaneBuiltinAdapter, rightSidebarAdapter, bottomPaneBuiltinAdapter, detailsPaneBuiltinAdapter, detailsPaneEnabled,
    }), [props.scopeId, surfaceScope, rightPaneBuiltinAdapter, rightSidebarAdapter, bottomPaneBuiltinAdapter,
        detailsPaneBuiltinAdapter, detailsPaneEnabled]);
    React.useEffect(() => registerDriver(driver), [registerDriver, driver]);
    const wrapScopeContent = React.useCallback((content: React.ReactElement) => (
        <ProjectPageNavigationRegistration pages={pages}>
            {props.wrapScopeContent ? props.wrapScopeContent(content) : content}
        </ProjectPageNavigationRegistration>
    ), [pages, props.wrapScopeContent]);
    return <PluginPageLaunchInputScope pluginUiProjection={projection.pluginUiProjection} target={catalog.target} pages={pages}>
        <AppPaneScopeHost {...hostProps} pageDestinationPlacements={placements} destinationPolicyContext={catalog.context.policyContext}
            wrapScopeContent={wrapScopeContent} />
    </PluginPageLaunchInputScope>;
}

/** Project identity/chrome stay in their existing shell; the shared page owner supplies only content. */
export function PluginProjectPageBody(props: Readonly<{ selection: Extract<ProjectPageSelection, { kind: 'plugin' }> }>) {
    const catalog = useProjectPageCatalog();
    const projection = useAppShellPluginUiProjection();
    const { pluginId, localId } = props.selection.destination;
    const page = catalog.routePages.find(candidate => candidate.kind === 'plugin'
        && candidate.destination?.pluginId === pluginId && candidate.destination.localId === localId)?.pluginPage ?? null;
    const routePathFor = React.useCallback((subPath: string) => buildPluginProjectPageRoutePath({
        ...catalog.target, pluginId, localId, subPath,
    }), [catalog.target, pluginId, localId]);
    return <PluginPageContent pluginId={pluginId} localId={localId} subPath={props.selection.subPath}
        page={page} projection={projection} projectContext={catalog.context} policyContext={catalog.context.policyContext} routePathFor={routePathFor} />;
}
