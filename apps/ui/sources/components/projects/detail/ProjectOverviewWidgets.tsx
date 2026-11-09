import * as React from 'react';

import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import { ProjectOverviewLayout, PROJECT_OVERVIEW_AREA_GAP_PX, type ProjectOverviewArrangement } from '@/components/projects/overview/ProjectOverviewLayout';
import { ProjectDashboardIdentityLine } from '@/components/projects/overview/ProjectDashboardIdentityLine';
import { useProjectDashboardOwner } from '@/components/projects/overview/useProjectDashboardOwner';
import { ProjectDashboardHeader } from '@/components/projects/overview/ProjectDashboardHeader';
import { WidgetArea } from '@/components/widgets/area/WidgetArea';
import { ProjectAsideWidgets, useProjectWidgetAreaBinding } from '@/components/widgets/area/ProjectWidgetArea';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { useWidgetAreaLayout, type WidgetAreaPort } from '@/components/widgets/area/useWidgetAreaLayout';
import { WidgetAreaPresetLine } from '@/components/widgets/area/WidgetAreaPresetLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { useDeviceType } from '@/utils/platform/responsive';
import { useActiveServerAccountScope, useWorkspaceRefs } from '@/sync/domains/state/storage';
import { resolveProjectCheckoutWorkspaceRef } from '@/sync/domains/workspaces/workspaceRefs';
import { t } from '@/text';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

import { projectOverviewAreaDashboard, useProjectOverviewAreaLayouts } from './useProjectOverviewAreaLayouts';
import type { ProjectAttachedDashboardSelection } from './projectRouteState';

/** Non-visual binding: the selected dashboard reads once; all frames use the canonical WidgetArea. */
export function ProjectOverviewWidgets(props: Readonly<{
    workspaceRef: WorkspaceRefV1;
    activeRootPath: string;
    activeWorktreeId?: string | null;
    projectName?: string;
    layoutId?: string;
    artifactId?: string;
    ownerAccountId?: string;
    attachedDashboard?: ProjectAttachedDashboardSelection;
    onSelectDashboard: (layoutId: string | null) => void;
    /** A9 supplies the selected-document controller; U1 owns its visual dashboard bar. */
    bar?: React.ReactNode;
}>): React.ReactElement {
    const projectName = props.projectName ?? resolveWorkspaceRefDisplayName(props.workspaceRef);
    const refs = useWorkspaceRefs();
    const activeCheckout = React.useMemo(() => resolveProjectCheckoutWorkspaceRef(refs, props.workspaceRef, props.activeRootPath) ?? undefined,
        [props.activeRootPath, props.workspaceRef, refs]);
    const binding = useProjectWidgetAreaBinding({ serverId: props.workspaceRef.serverId, projectName, projectRef: props.workspaceRef, activeCheckout,
        layoutId: props.layoutId, artifactId: props.artifactId, ownerAccountId: props.ownerAccountId, attachedDashboard: props.attachedDashboard,
        onSelectLayout: props.onSelectDashboard });
    // The bar is the Overview's own dashboard header unless a host supplies another (a Team Source view).
    const bar = props.bar ?? <ProjectDashboardHeader workspaceRef={props.workspaceRef}
        activeRootPath={props.activeRootPath} activeWorktreeId={props.activeWorktreeId} projectName={projectName} layoutId={props.layoutId ?? null}
        attachedDashboard={props.attachedDashboard} sharedDashboard={binding.sharedDashboard} />;
    if (!binding.port) return <ProjectOverviewLayout bar={bar} identity={null}
        blocking={binding.unavailableReasonCode === 'widget_area_loading'
            ? <SurfaceStateCard kind="loading" title={t('common.loading')} testID="project-overview.loading" />
            : <WidgetArea port={null} context={binding.context} geometry="column" title={projectName}
            surfaceName={projectName} unavailable={{ title: t('projects.widgets.layoutUnavailable'), reasonCode: binding.unavailableReasonCode ?? 'widget_area_unavailable' }}
            testID="project-overview-state" />} main={null} aside={null} />;
    return <ProjectOverviewDocument port={binding.port} context={binding.context} projectName={projectName} bar={bar} />;
}

/** The pane's own column: its widgets stand on the pane title's edge, the sheets' inset. */
const PANE_COLUMN = { paddingHorizontal: PAGE_LIST_METRICS.sheetInsetPx } as const;

/**
 * The Project's Widgets pane beside Code and the other pages (widgets plan WGT-14, lab `dashboards` P1):
 * Overview's side area for this Project, its repo inputs following This project and its local ones the
 * selected checkout, exactly as Overview binds them.
 */
export function ProjectWidgetsPane(props: Readonly<{
    workspaceRef: WorkspaceRefV1;
    activeRootPath: string;
    testID: string;
}>): React.ReactElement {
    const refs = useWorkspaceRefs();
    const activeCheckout = React.useMemo(() => resolveProjectCheckoutWorkspaceRef(refs, props.workspaceRef, props.activeRootPath) ?? undefined,
        [props.activeRootPath, props.workspaceRef, refs]);
    return (
        <ItemList testID={props.testID} containerStyle={PANE_COLUMN}>
            <ProjectAsideWidgets serverId={props.workspaceRef.serverId} projectName={resolveWorkspaceRefDisplayName(props.workspaceRef)}
                projectRef={props.workspaceRef} activeCheckout={activeCheckout} testID={`${props.testID}.area`} />
        </ItemList>
    );
}

/** Kept at the real port boundary so the admitted document is shared across both responsive hosts. */
export function ProjectOverviewDocument(props: Readonly<{
    port: WidgetAreaPort;
    context: WidgetSurfaceContext;
    projectName: string;
    bar?: React.ReactNode;
}>): React.ReactElement {
    const layout = useWidgetAreaLayout(props.port, props.context);
    const preset = layout.state.status === 'ready' ? layout.state.preset ?? null : null;
    const presetSurface = layout.state.status === 'ready' ? layout.state.surface : null;
    const phone = useDeviceType() === 'phone';
    const [arrangement, setArrangement] = React.useState<ProjectOverviewArrangement>('columns');
    const [organizing, setOrganizing] = React.useState(false);
    const organize = React.useMemo(() => ({ active: organizing, onChange: setOrganizing }), [organizing]);
    const viewer = useActiveServerAccountScope();
    const disclosureScope = layout.state.status === 'ready'
        ? stableJsonStringify({ surface: layout.state.surface, viewer }) : '';
    const [disclosures, setDisclosures] = React.useState<Readonly<{
        scope: string; values: Readonly<Record<string, boolean>>;
    }>>({ scope: '', values: {} });
    const onCollapsedChange = React.useCallback((instanceId: string, collapsed: boolean) => {
        setDisclosures(previous => ({ scope: disclosureScope,
            values: { ...(previous.scope === disclosureScope ? previous.values : {}), [instanceId]: collapsed } }));
    }, [disclosureScope]);
    const disclosure = React.useMemo(() => ({
        collapsedByInstanceId: disclosures.scope === disclosureScope ? disclosures.values : {}, onCollapsedChange,
    }), [disclosureScope, disclosures, onCollapsedChange]);
    const projections = useProjectOverviewAreaLayouts(layout);
    const shared = { port: props.port, context: props.context, geometry: 'column' as const, title: props.projectName,
        surfaceName: props.projectName, disclosure, organize };
    const dashboard = (area: 'main' | 'aside') => projectOverviewAreaDashboard(layout, area);
    // An empty dashboard says so once, in the main area; the side area keeps only its Add line.
    const { emptyTitle: _saidInMain, ...asideDashboard } = dashboard('aside');
    // One quiet line, only on a shared dashboard: its admitted name and this viewer's access.
    const dashboardFacts = layout.state.status === 'ready' && layout.state.isShared ? layout.state.dashboard ?? null : null;
    const dashboardOwner = useProjectDashboardOwner(layout.state.status === 'ready' ? layout.state.surface.serverId : '',
        dashboardFacts?.ownerAccountId ?? null);
    // The owner's own shared dashboard is theirs: "You · Shared" (lab D_SHARED), never their own name with
    // another person's access level. Everyone else reads whose it is and the access they act under.
    const ownDashboard = dashboardFacts?.access === 'owner';
    const identity = dashboardFacts
        ? <ProjectDashboardIdentityLine title={dashboardFacts.name}
            owner={ownDashboard ? { accountId: dashboardFacts.ownerAccountId, displayName: t('projects.dashboard.you'), imageUrl: dashboardOwner?.imageUrl ?? null }
                : dashboardOwner ?? { accountId: dashboardFacts.ownerAccountId }}
            detail={ownDashboard ? t('projects.dashboard.sharedLine') : t(dashboardFacts.access === 'view' ? 'shareSheet.documents.levels.canRead'
                : dashboardFacts.access === 'admin' ? 'shareSheet.documents.levels.admin' : 'shareSheet.documents.levels.canEdit')} />
        // An edited preset says so once, with Reset to preset (lab wgsaved R).
        : preset?.isEdited && presetSurface ? <WidgetAreaPresetLine preset={preset} surface={presetSurface} testID="project-overview.preset" /> : null;
    // A viewer who cannot edit has nothing to add or drop into an empty side area, so it draws nothing
    // (stacked it would otherwise lead the page with an empty line above the widgets that exist).
    const quietAside = layout.state.status === 'ready' && !layout.state.canEdit
        && projections.aside.state.status === 'ready' && projections.aside.state.placements.length === 0;
    // Side by side, each area's quiet "Add widget" ends its own column. Stacked (and on a phone) the areas
    // read as one column, so it ends with one "Add widget" (lab HOMEp) whose gallery offers both areas
    // (plan 12 §§2,5: each area stays directly reachable), starting with the main area.
    const stacked = phone || arrangement !== 'columns';
    const areaChoice = (['main', 'aside'] as const).map((area) => ({ area, title: dashboard(area).addTitle,
        label: t(area === 'main' ? 'projects.widgets.mainAreaChoice' : 'projects.widgets.sideAreaChoice') }));
    const trailingAdd = <WidgetArea {...shared} layout={projections.main} area="main" display="add"
        dashboard={{ ...dashboard('main'), areaChoice }} testID="project-overview-main" />;
    return <ProjectOverviewLayout bar={props.bar ?? null} identity={identity} onArrangementChange={setArrangement}
        // While the document first reads, the body is reserved under the bar with nothing that leaves on
        // arrival (no area heading or disabled +): the dashboard words keep the area's own header away.
        blocking={!projections.ready ? <WidgetArea {...shared} layout={layout} dashboard={dashboard('main')} testID="project-overview-state" /> : undefined}
        main={projections.ready ? <>
            <WidgetArea {...shared} layout={projections.main} area="main" {...(stacked ? { display: 'widgets' as const } : {})}
                dashboard={dashboard('main')} testID="project-overview-main" />
            {stacked ? trailingAdd : null}
        </> : null}
        aside={projections.ready && !quietAside ? <WidgetArea {...shared} layout={projections.aside} area="aside" {...(stacked ? { display: 'widgets' as const } : {})}
            columnLayout={{ columns: arrangement === 'pairs' ? 2 : 1, gap: PROJECT_OVERVIEW_AREA_GAP_PX }}
            dashboard={asideDashboard} testID="project-overview-aside" /> : null}

        phone={phone && projections.ready ? <>
            <WidgetArea {...shared} layout={projections.phone} display="widgets" dashboard={dashboard('main')} testID="project-overview-merged" />
            {trailingAdd}
        </> : undefined} />;
}
