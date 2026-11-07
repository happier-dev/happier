import * as React from 'react';
import { useNavigationSurfacePlacement } from '@/components/ui/navigation/useNavigationSurfacePlacement';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { normalizeProjectMobileSurface, normalizeProjectPage, type ProjectMobileSurface, type ProjectPageV1 } from '@/components/workspaceCockpit/project/projectCockpitState';
import { resolveDetailNavigationItems, resolveDetailPhoneNavigationItem, type ProjectDetailNavigationItem } from '@/components/appShell/rightSidebar/detailNavigationItems';
import type { ProjectPageDescriptor } from '@/components/projects/detail/projectPageCatalog';
import { ProjectPageChromeCounts, type ProjectPageChromeDescriptor } from '@/components/projects/navigation/ProjectPageChromeCounts';
import { useOptionalProjectPageCatalog, type ProjectPageCatalogModel } from '@/components/projects/navigation/useProjectPageCatalog';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { PROJECT_PHONE_NAVIGATION_ADDRESS, resolveProjectNavigationCustomizer } from '@/components/projects/navigation/projectNavigationCustomizer';
import { CockpitTabBar, type CockpitTabBarTabDefinition } from './CockpitTabBar';
import { sfSymbolForCockpitTabIcon } from './cockpitTabSymbols';
import { PhonePageStripView } from './PhonePageStrip';
import { selectProjectCockpitItem } from '../cockpitSelection';
import { useDetailPhoneBarPresentation, useDetailPhonePlacement } from './detailPhoneNavigation';
import { useMountedScopeActionCommand } from '@/components/approvals/useMountedScopeActionCommand';
import { usePresentedDetailNavigationChrome } from '@/components/appShell/rightSidebar/usePresentedDetailNavigation';

export { PROJECT_PHONE_NAVIGATION_ADDRESS } from '@/components/projects/navigation/projectNavigationCustomizer';
export type ProjectNavigationPage = ProjectPageChromeDescriptor;
export type ProjectCockpitTabBarProps = Readonly<{
    workspaceRefId: string;
    pages: readonly ProjectPageDescriptor[];
    /** The mounted Project's single list; standalone specimens resolve through the same owner. */
    items?: readonly ProjectDetailNavigationItem[];
    countScope?: Pick<ProjectPageCatalogModel, 'context' | 'projection' | 'authority'>;
    activeSurface: ProjectMobileSurface;
    activePage?: ProjectPageV1;
    activePageId?: string;
    terminalTabAvailable?: boolean;
    terminalsOpen?: boolean;
    onPagePress?: (id: string) => void;
    onSurfacePress: (surface: ProjectMobileSurface) => void;
}>;
export type ProjectCockpitTabDefinition = CockpitTabBarTabDefinition<string> & Readonly<{ sfSymbol: string }>;
type PresentationProps = Omit<ProjectCockpitTabBarProps, 'pages'> & Readonly<{ pages: readonly ProjectNavigationPage[] }>;

/** Descriptor adaptation only. No page/tool join, platform admission or selection decision lives here. */
export function useProjectCockpitTabDefinitions(props: PresentationProps) {
    const fallback = React.useMemo(() => props.items ? undefined : resolveDetailNavigationItems({ scope: 'project', presentation: 'mobile',
        terminalTabAvailable: props.terminalTabAvailable, projectPages: props.pages }),
    [props.items, props.pages, props.terminalTabAvailable]);
    const items = props.items ?? fallback!;
    const pagesById = React.useMemo(() => new Map(props.pages.map(page => [page.id, page])), [props.pages]);
    const phone = React.useMemo(() => items.filter(item => item.phonePlacement !== 'none').map(item => ({ ...item,
        ...pagesById.get(item.id), phonePlacement: item.id === 'terminal' && props.terminalsOpen ? 'bar' as const
            : item.phonePlacement })).map(resolveDetailPhoneNavigationItem), [items, pagesById, props.terminalsOpen]);
    const activeId = normalizeProjectPage(props.activeSurface) ? props.activePageId ?? props.activeSurface
        : items.find(item => item.companion?.mobileSurfaces?.project === props.activeSurface)?.id ?? props.activeSurface;
    // A phone cell names its page; the counts' words travel in the announcement (a long label wraps out of the cell).
    const tabForPage = (page: Pick<ProjectNavigationPage, 'id' | 'title' | 'icon' | 'disabledReason' | 'disabledReasonCode' | 'count'>): ProjectCockpitTabDefinition => ({ id: page.id,
        label: page.title, icon: page.icon, sfSymbol: sfSymbolForCockpitTabIcon(page.icon),
        accessibilityLabel: page.count ? `${page.title}, ${page.count}` : page.title, disabled: Boolean(page.disabledReason),
        unavailableReason: page.disabledReason ? page.disabledReasonCode ? page.disabledReason
            : resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: page.disabledReason }).body : undefined });
    const select = (id: string) => {
        const item = items.find(item => item.id === id);
        if (!item || item.disabledReason) return;
        if (item.navigation.kind !== 'companion') {
            if (item.page && props.onPagePress) props.onPagePress(item.navigation.page);
            else { const surface = normalizeProjectMobileSurface(item.navigation.page); if (surface) props.onSurfacePress(surface); }
        } else {
            const surface = item.companion?.mobileSurfaces?.project;
            const normalized = normalizeProjectMobileSurface(surface);
            if (normalized) props.onSurfacePress(normalized);
        }
    };
    return { items, phone, activeId, pagesById, tabForPage, select };
}

/** The shared top strip and bottom presenters consume this one phone placement projection. */
export function useProjectPhoneNavigation(props: PresentationProps) {
    const definitions = useProjectCockpitTabDefinitions(props);
    const placement = useDetailPhonePlacement(definitions.phone, PROJECT_PHONE_NAVIGATION_ADDRESS, 'project');
    return { ...definitions, ...placement };
}

/** Floating and native chrome share placement, top mode and their single More menu. */
export function useProjectCockpitBarPresentation(props: PresentationProps, native = false) {
    const definitions = useProjectPhoneNavigation(props);
    const customizer = React.useMemo(() => resolveProjectNavigationCustomizer({ items: definitions.items,
        phoneItems: definitions.phone, device: 'phone' }), [definitions.items, definitions.phone]);
    const presentation = useDetailPhoneBarPresentation({ items: definitions.items, placement: definitions,
        address: PROJECT_PHONE_NAVIGATION_ADDRESS, pageKind: 'project', activeId: definitions.activeId,
        select: definitions.select, customizer, native });
    return { ...definitions, ...presentation, customizer };
}

/**
 * Cockpit phones with Project page tabs at the top: the pinned pages scroll in one strip under the Project
 * header, from the same phone projection the bar uses; the bar keeps companions and the single More.
 */
export const ProjectPhonePageStrip = React.memo(function ProjectPhonePageStrip(props: Readonly<{ workspaceRefId: string }>) {
    const environmentNavigation = usePresentedDetailNavigationChrome()?.pageKind === 'environment';
    const catalog = useOptionalProjectPageCatalog();
    const { cockpitEnabled } = useMobileWorkspaceExperienceState();
    const { preferences } = useNavigationSurfacePlacement(PROJECT_PHONE_NAVIGATION_ADDRESS);
    const execute = useMountedScopeActionCommand(catalog?.authority?.scope ?? null);
    if (environmentNavigation || !catalog || !cockpitEnabled) return null;
    return <ProjectPageChromeCounts context={catalog.context} projection={catalog.projection}
        authority={catalog.authority} pages={catalog.pages} preferences={preferences}>
        {pages => <ProjectPhonePageStripContent workspaceRefId={props.workspaceRefId} pages={pages} items={catalog.items}
            activeSurface={catalog.activeSurface} activePageId={catalog.activePageId}
            terminalTabAvailable={catalog.terminalTabAvailable}
            onPagePress={id => selectProjectCockpitItem(execute, catalog, id, 'main')}
            onSurfacePress={surface => selectProjectCockpitItem(execute, catalog, surface)} />}
    </ProjectPageChromeCounts>;
});
function ProjectPhonePageStripContent(props: PresentationProps) {
    const navigation = useProjectPhoneNavigation(props);
    if (navigation.topPages.length === 0) return null;
    return <PhonePageStripView tabs={navigation.topPages.map(navigation.tabForPage)} activeId={navigation.activeId}
        onSelect={navigation.select} testID="project-phone-page-strip" />;
}

export const ProjectCockpitTabBar = React.memo((props: ProjectCockpitTabBarProps) => {
    const { preferences } = useNavigationSurfacePlacement(PROJECT_PHONE_NAVIGATION_ADDRESS);
    return props.countScope ? <ProjectPageChromeCounts {...props.countScope} pages={props.pages} preferences={preferences}>
        {pages => <ProjectCockpitTabBarContent {...props} pages={pages} />}
    </ProjectPageChromeCounts> : <ProjectCockpitTabBarContent {...props} />;
});
function ProjectCockpitTabBarContent(props: PresentationProps) {
    const presentation = useProjectCockpitBarPresentation(props);
    return <CockpitTabBar activeSurface={presentation.activeId} barTestId={`project-cockpit-tabbar-${props.workspaceRefId}`}
        tabs={presentation.shown.map(presentation.tabForPage)} tabTestIdPrefix="project-cockpit-tab-" layout={presentation.layout}
        onSurfacePress={presentation.select} trailing={presentation.menu} />;
}
