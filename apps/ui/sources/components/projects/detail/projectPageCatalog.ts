import type { PluginUiDestinationReferenceV1 } from '@happier-dev/protocol/plugins/ui';
import type { IconName } from '@/components/ui/icons/Icon';
import { resolvePluginPages, type PluginPage, type PluginPageTarget } from '@/components/plugins/pages/pluginPages';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import { PROJECT_PAGES, type ProjectPageSelection, resolveProjectRoutePathForSurface } from '@/components/workspaceCockpit/project/projectCockpitState';
import { projectPageGlyph, projectPageLabel } from '@/components/projects/navigation/projectPageDisplay';
import type { NavigationDefaultPlacement, NavigationPlacement } from '@/sync/domains/settings/mobileSurfacePinning';

import { resolveDetailNavigationItems, type ProjectDetailNavigationItem } from '@/components/appShell/rightSidebar/detailNavigationItems';
import type { ResolveRightSidebarTabsInput } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';

const OVERVIEW_PLACEMENTS: readonly NavigationPlacement[] = Object.freeze(['pinned']);
/**
 * The header's six page tabs (plan 12 D44): Overview · Code · Changes · Scripts · Services · Context. Pages
 * added after them start behind More until the person pins them through Customize.
 */
const HEADER_PAGES: ReadonlySet<string> = new Set(['overview', 'code', 'changes', 'scripts', 'services', 'context']);

/** The descriptive Project catalog; renderer activation and invocation admission stay with their owners. */
export type ProjectPageDescriptor = Readonly<{
    id: string;
    title: string;
    icon: IconName;
    href: string;
    kind: 'builtin' | 'plugin';
    disabledReason: string | null;
    /** Canonical diagnostic when the disabled reason is authored human wording. */
    disabledReasonCode?: string;
    visible: boolean;
    destination?: PluginUiDestinationReferenceV1;
    selection: ProjectPageSelection;
    /** The admitted shared descriptor, retained for the body and catalog baseline. */
    pluginPage?: PluginPage;
    allowedPlacements?: readonly NavigationPlacement[];
    defaultPlacement?: NavigationDefaultPlacement;
}>;

type ProjectPageCatalogInput = Readonly<{
    sidebar?: Omit<ResolveRightSidebarTabsInput, 'scope' | 'activePage'>;
    activePage?: import('@/components/workspaceCockpit/project/projectCockpitState').ProjectPageV1;
    target: Extract<PluginPageTarget, { kind: 'project' }>;
    placements?: readonly PluginUiSurfacePlacementProjection[];
    policyContext?: PluginUiPolicyEvaluationContext;
    localize?: PluginLocalizedTextResolver;
}>;
export type ProjectPageCatalogState = Readonly<{
    pages: readonly ProjectPageDescriptor[];
    routePages: readonly ProjectPageDescriptor[];
    items: readonly ProjectDetailNavigationItem[];
}>;

/** One policy/catalog pass supplies descriptive navigation and exact-route refusal. */
export function resolveProjectPageCatalogState(input: ProjectPageCatalogInput & Readonly<{
    baseline?: ProjectPageCatalogState;
}>): ProjectPageCatalogState {
    const previous = new Map(input.baseline?.routePages.map(page => [page.id, page]));
    const pluginPages = resolvePluginPages({ target: input.target, placements: input.placements,
        policyContext: input.policyContext, localize: input.localize,
        baseline: input.baseline?.routePages.flatMap(page => page.pluginPage ? [page.pluginPage] : []) });
    const pages: ProjectPageDescriptor[] = PROJECT_PAGES.map(page => {
        const title = projectPageLabel(page);
        const icon = projectPageGlyph(page);
        const href = resolveProjectRoutePathForSurface({ ...input.target, surface: page });
        const prior = previous.get(page);
        return prior?.kind === 'builtin' && prior.title === title && prior.icon === icon && prior.href === href ? prior
            : Object.freeze({ id: page, title, icon, href, kind: 'builtin' as const, disabledReason: null, visible: true,
                ...(page === 'overview' ? { allowedPlacements: OVERVIEW_PLACEMENTS } : {}),
                ...(HEADER_PAGES.has(page) ? {} : { defaultPlacement: 'overflow' as const }),
                selection: Object.freeze({ kind: 'builtin' as const, page }) });
    });
    for (const page of pluginPages) {
        const prior = previous.get(page.id);
        if (prior?.pluginPage === page) { pages.push(prior); continue; }
        const destination = Object.freeze({ pluginId: page.pluginId, localId: page.localId });
        pages.push(Object.freeze({ id: page.id, title: page.label, icon: page.icon, href: page.routePath,
            kind: 'plugin' as const, disabledReason: page.disabledReason,
            ...(page.disabledReasonCode ? { disabledReasonCode: page.disabledReasonCode } : {}),
            visible: page.visible, destination, pluginPage: page,
            selection: Object.freeze({ kind: 'plugin' as const, destination, subPath: '' }) }));
    }
    const routePages = input.baseline?.routePages.length === pages.length
        && pages.every((page, index) => page === input.baseline?.routePages[index]) ? input.baseline.routePages : Object.freeze(pages);
    const visible = routePages.filter(page => page.visible);
    const visiblePages = input.baseline?.pages.length === visible.length
        && visible.every((page, index) => page === input.baseline?.pages[index]) ? input.baseline.pages : Object.freeze(visible);
    const resolvedItems = resolveDetailNavigationItems({ ...input.sidebar, scope: 'project', activePage: input.activePage, projectPages: visiblePages });
    // Resolution owns descriptors; a refresh preserves every unchanged row for all presenters.
    const priorItems = new Map(input.baseline?.items?.map(item => [item.id, item]));
    const rows = resolvedItems.map(item => {
        const prior = priorItems.get(item.id);
        const companion = item.companion;
        const previousCompanion = prior?.companion;
        const sameCompanion = companion === previousCompanion || Boolean(companion && previousCompanion
            && Object.keys(companion).length === Object.keys(previousCompanion).length
            && Object.entries(companion).every(([key, value]) => key === 'navigation'
                ? Object.entries(companion.navigation).every(([name, field]) => Reflect.get(previousCompanion.navigation, name) === field)
                : Reflect.get(previousCompanion, key) === value));
        return prior && prior.page === item.page && prior.title === item.title && prior.icon === item.icon
            && prior.disabledReason === item.disabledReason && prior.phonePlacement === item.phonePlacement
            && sameCompanion ? prior : item;
    });
    const items = input.baseline?.items?.length === rows.length && rows.every((item, index) => item === input.baseline?.items[index])
        ? input.baseline.items : Object.freeze(rows);
    return input.baseline?.routePages === routePages && input.baseline.pages === visiblePages && input.baseline.items === items
        ? input.baseline : Object.freeze({ pages: visiblePages, routePages, items });
}

/** Public descriptive projection; the same state owner also supplies the exact-route body. */
export function resolveProjectPageCatalog(input: ProjectPageCatalogInput & Readonly<{
    baseline?: readonly ProjectPageDescriptor[];
}>): readonly ProjectPageDescriptor[] {
    return resolveProjectPageCatalogState({ ...input, baseline: input.baseline
        ? { pages: input.baseline, routePages: input.baseline, items: [] } : undefined }).pages;
}
