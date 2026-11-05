import { RIGHT_SIDEBAR_BUILTIN_TABS, type RightSidebarAvailabilityInput, type RightSidebarBuiltinTabDefinition, type RightSidebarTabDefinition, type RightSidebarPresentation } from './rightSidebarBuiltinTabs';
import { resolveRightSidebarPluginTabs } from './rightSidebarPluginTabs';
import type { ResolveRightSidebarTabsInput } from './rightSidebarTabRegistry';
import type { ProjectPageDescriptor } from '@/components/projects/detail/projectPageCatalog';
import { t } from '@/text';
import { getRightSidebarTabLabel } from './rightSidebarTabRegistry';
import type { NavigationDefaultPlacement, NavigationPlacement, NavigationPlacementPolicy } from '@/sync/domains/settings/mobileSurfacePinning';
import type { DetailNavigationDestination } from './rightSidebarBuiltinTabs';
import { DEPLOYMENT_ENVIRONMENT_TABS_V1, type DeploymentEnvironmentTabV1 } from '@happier-dev/deployments';
import type { PluginUiPageNavigationItemV1 } from '@happier-dev/protocol/plugins/ui/pageNavigation';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';

export type DetailNavigationItem = RightSidebarTabDefinition & Readonly<{
    navigation: DetailNavigationDestination;
    phonePlacement: 'bar' | 'more' | 'none';
    phoneOrder: number;
}>;

const PHONE_UNAVAILABLE_PLACEMENTS = ['hidden'] as const;
/** Phone admission/defaults are independent of the same item's desktop placement. */
export function resolveDetailPhoneNavigationItem<T extends Pick<NavigationPlacementPolicy, 'defaultPlacement' | 'allowedPlacements'> & Readonly<{ phonePlacement?: 'bar' | 'more' | 'none' }>>(
    item: T,
): T {
    if (!item.phonePlacement) return item;
    const defaultPlacement = item.phonePlacement === 'bar' ? 'pinned' : item.phonePlacement === 'more' ? 'overflow' : 'hidden';
    const allowedPlacements = item.phonePlacement === 'none' ? PHONE_UNAVAILABLE_PLACEMENTS : item.allowedPlacements;
    return item.defaultPlacement === defaultPlacement && allowedPlacements === item.allowedPlacements ? item
        : { ...item, defaultPlacement, ...(allowedPlacements ? { allowedPlacements } : {}) };
}

function resolveItem(tab: RightSidebarTabDefinition, input: ResolveRightSidebarTabsInput): DetailNavigationItem {
    const editorPage = input.scope === 'session' && input.arrangement === 'editor' && input.presentation !== 'mobile'
        && tab.owner === 'builtin' && tab.railGroup === 'session' && !tab.navigation;
    const navigation: DetailNavigationDestination = tab.navigation ?? (editorPage
        ? { kind: 'both', page: tab.id, companion: tab.id, desktop: 'tabs' }
        : { kind: 'companion', companion: tab.id });
    const surface = tab.mobileSurfaces?.[input.scope];
    const phonePlacement = tab.phonePlacement ?? (!surface ? 'none'
        : input.scope === 'session' && (surface === 'browse' || surface === 'git' || surface === 'terminal') ? 'bar' : 'more');
    const phoneOrder = tab.phoneOrder ?? (input.scope === 'session'
        ? surface === 'browse' ? 1 : surface === 'git' ? 2 : surface === 'terminal' ? Number.MAX_SAFE_INTEGER : tab.owner === 'plugin' ? Number.MAX_SAFE_INTEGER - 1 : tab.order + 10
        : tab.order);
    return Object.freeze({ ...tab, navigation, phonePlacement, phoneOrder,
        ...(tab.id === 'computer' && input.computerDisabledReason ? { disabledReason: input.computerDisabledReason } : {}) });
}

export function resolveDetailNavigationProjection<T extends Pick<ProjectDetailNavigationItem,
    'id' | 'navigation' | 'phonePlacement' | 'phoneOrder' | 'defaultPlacement' | 'allowedPlacements'> & Readonly<{ hiddenInLauncher?: boolean }>>(
    items: readonly T[], presentation: RightSidebarPresentation, activePageId?: string,
) {
    return {
        pages: items.filter(item => item.navigation.kind !== 'companion' && item.navigation.desktop !== 'none'),
        companions: items.filter(item => item.navigation.kind !== 'page' && !item.hiddenInLauncher
            && !(item.navigation.kind === 'both' && item.navigation.page === activePageId)),
        phone: presentation === 'mobile' ? items.filter(item => item.phonePlacement !== 'none').sort((a, b) => a.phoneOrder - b.phoneOrder || a.id.localeCompare(b.id)).map(resolveDetailPhoneNavigationItem) : [],
    };
}

function isTabAvailable(
    tab: RightSidebarBuiltinTabDefinition,
    input: RightSidebarAvailabilityInput,
): boolean {
    if (!tab.scopes.includes(input.scope)) {
        return false;
    }
    return tab.available ? tab.available(input) : true;
}

export type ProjectDetailNavigationItem = Readonly<{
    id: string;
    title: string;
    icon: ProjectPageDescriptor['icon'];
    disabledReason: string | null;
    disabledReasonCode?: string;
    navigation: DetailNavigationDestination;
    phonePlacement: 'bar' | 'more' | 'none';
    phoneOrder: number;
    defaultPlacement?: NavigationDefaultPlacement;
    allowedPlacements?: readonly NavigationPlacement[];
    page?: ProjectPageDescriptor;
    companion?: DetailNavigationItem;
}>;

/** Page-only domains supply descriptors from their existing body/route adapter. */
export type DetailPageNavigationDescriptor = Pick<ProjectDetailNavigationItem, 'id' | 'title' | 'icon' | 'disabledReason'>;
export type DetailPageNavigationItem = Omit<ProjectDetailNavigationItem, 'page' | 'companion'> & Readonly<{ count?: string }>;
type MachineNavigationInput = Readonly<{ scope: 'machine'; pages: readonly DetailPageNavigationDescriptor[] }>;
type WorkflowNavigationInput = Readonly<({ scope: 'workflowEditor' } | { scope: 'workflowRun' }) & { settingsAvailable?: boolean }>;
type EnvironmentNavigationInput = Readonly<{ scope: 'environment' }>;
type PluginNavigationInput = Readonly<{ scope: 'plugin'; items: readonly PluginUiPageNavigationItemV1[] }>;
const environmentPageMetadata = {
    overview: { label: 'projects.deployments.overview', icon: 'squares-four' },
    history: { label: 'projects.deployments.history', icon: 'clock-counter-clockwise' },
    variables: { label: 'projects.deployments.tabVariables', icon: 'key' },
    domains: { label: 'projects.deployments.tabDomains', icon: 'globe' },
    permissions: { label: 'projects.deployments.tabPermissions', icon: 'shield-check' },
    settings: { label: 'projects.deployments.tabSettings', icon: 'sliders-horizontal' },
} as const satisfies Record<DeploymentEnvironmentTabV1, { label: string; icon: DetailPageNavigationItem['icon'] }>;

type ProjectNavigationInput = ResolveRightSidebarTabsInput & Readonly<{ scope: 'project'; projectPages: readonly ProjectPageDescriptor[] }>;
export function resolveDetailNavigationItems(input: MachineNavigationInput): readonly DetailPageNavigationItem[];
export function resolveDetailNavigationItems(input: WorkflowNavigationInput): readonly DetailPageNavigationItem[];
export function resolveDetailNavigationItems(input: EnvironmentNavigationInput): readonly DetailPageNavigationItem[];
export function resolveDetailNavigationItems(input: PluginNavigationInput): readonly DetailPageNavigationItem[];
export function resolveDetailNavigationItems(input: ProjectNavigationInput): readonly ProjectDetailNavigationItem[];
export function resolveDetailNavigationItems(input: ResolveRightSidebarTabsInput): readonly DetailNavigationItem[];
export function resolveDetailNavigationItems(input: MachineNavigationInput | WorkflowNavigationInput | EnvironmentNavigationInput | PluginNavigationInput | (ResolveRightSidebarTabsInput & Readonly<{ projectPages?: readonly ProjectPageDescriptor[] }>)): readonly DetailNavigationItem[] | readonly ProjectDetailNavigationItem[] | readonly DetailPageNavigationItem[] {
    if (input.scope === 'plugin') {
        const primaryPageId = input.items.find(item => item.kind !== 'companion')?.value;
        return Object.freeze(input.items.map((item, phoneOrder) => Object.freeze({
            id: item.value, title: item.title, icon: resolvePluginUiIconName(item.glyph),
            disabledReason: item.disabled ? t('common.unavailable') : null,
            navigation: item.kind === 'page' ? { kind: 'page' as const, page: item.value, desktop: 'tabs' as const }
                : item.kind === 'companion' ? { kind: 'companion' as const, companion: buildQualifiedPluginContributionKey(item.companion) }
                    : { kind: 'both' as const, page: item.value, companion: buildQualifiedPluginContributionKey(item.companion), desktop: 'tabs' as const },
            phonePlacement: item.phonePlacement, phoneOrder,
            defaultPlacement: item.kind !== 'companion' ? 'pinned' as const
                : item.phonePlacement === 'bar' ? 'pinned' as const : item.phonePlacement === 'more' ? 'overflow' as const : 'hidden' as const,
            ...(item.value === primaryPageId ? { allowedPlacements: ['pinned'] as const } : {}),
            ...(item.badge === undefined ? {} : { count: item.badge }),
        })));
    }
    if (input.scope === 'environment') return Object.freeze(DEPLOYMENT_ENVIRONMENT_TABS_V1.map((id, phoneOrder) => Object.freeze({
        id, title: t(environmentPageMetadata[id].label), icon: environmentPageMetadata[id].icon, disabledReason: null,
        navigation: { kind: 'page' as const, page: id, desktop: 'tabs' as const }, phonePlacement: 'bar' as const,
        phoneOrder, defaultPlacement: 'pinned' as const, ...(phoneOrder === 0 ? { allowedPlacements: ['pinned'] as const } : {}),
    })));
    if (input.scope === 'workflowEditor' || input.scope === 'workflowRun') {
        const page = (id: string, title: string, icon: DetailPageNavigationItem['icon']): DetailPageNavigationItem => ({
            id, title, icon, disabledReason: null, navigation: { kind: 'page', page: id, desktop: 'tabs' },
            phonePlacement: 'bar', phoneOrder: 0, defaultPlacement: 'pinned',
        });
        const descriptors: DetailPageNavigationItem[] = input.scope === 'workflowEditor'
            ? [page('steps', t('workflows.tabs.steps'), 'list'),
                { ...page('flow', t('workflows.tabs.flow'), 'graph'), navigation: { kind: 'both', page: 'flow', companion: 'flow', desktop: 'tabs' } },
                ...(input.settingsAvailable ? [{ ...page('settings', t('workflows.page.settings'), 'sliders-horizontal'),
                    navigation: { kind: 'companion' as const, companion: 'settings' }, phonePlacement: 'more' as const, defaultPlacement: 'overflow' as const }] : [])]
            : [page('flow', t('workflows.tabs.map'), 'graph'), page('steps', t('workflows.tabs.steps'), 'list'),
                page('activity', t('workflows.tabs.activity'), 'pulse')];
        return Object.freeze(descriptors.map((item, phoneOrder) => Object.freeze({ ...item, phoneOrder,
            ...(phoneOrder === 0 ? { allowedPlacements: ['pinned'] as const } : {}),
        })));
    }
    if (input.scope === 'machine') return Object.freeze(input.pages.map((page, index) => Object.freeze({ ...page,
        navigation: { kind: 'page' as const, page: page.id, desktop: 'tabs' as const },
        phonePlacement: 'bar' as const, phoneOrder: index, defaultPlacement: 'pinned' as const,
        ...(index === 0 ? { allowedPlacements: ['pinned'] as const } : {}),
    })));
    const availabilityInput: RightSidebarAvailabilityInput = {
        scope: input.scope,
        terminalTabAvailable: input.terminalTabAvailable === true,
        presentation: input.presentation ?? 'desktop',
        boardFeatureEnabled: input.boardFeatureEnabled === true,
        browserFeatureEnabled: input.browserFeatureEnabled === true,
        sessionSharingAvailable: input.sessionSharingAvailable === true,
        sourceControlTabAvailable: input.sourceControlTabAvailable !== false,
        sessionProjectCheckoutAvailable: input.sessionProjectCheckoutAvailable === true,
        codeIntelligenceAvailable: input.codeIntelligenceAvailable === true,
    };
    const builtInTabs = RIGHT_SIDEBAR_BUILTIN_TABS
        .filter((tab) => isTabAvailable(tab, availabilityInput)
            && (tab.id !== 'computer' || input.computerAvailable === true)
            && (tab.id !== 'review' || availabilityInput.sourceControlTabAvailable))
        .map((tab) => input.scope === 'project' && (
            input.activePage !== undefined && tab.projectPage === input.activePage
            || tab.id === 'terminal' && !availabilityInput.terminalTabAvailable
        )
            ? Object.freeze({ ...tab, hiddenInLauncher: true })
            : tab);
    const pluginTabs = resolveRightSidebarPluginTabs({
        scope: input.scope,
        placements: input.pluginPlacements,
        policyContext: input.policyContext,
        ...(input.localize ? { localize: input.localize } : {}),
        ...(input.runtimeAdmission === undefined ? {} : { runtimeAdmission: input.runtimeAdmission }),
    });
    const appTabs = input.scope === 'app' || !input.appPluginPlacements
        ? []
        : resolveRightSidebarPluginTabs({
            scope: 'app',
            placements: input.appPluginPlacements,
            ...(input.appLocalize ? { localize: input.appLocalize } : {}),
            ...(input.runtimeAdmission === undefined ? {} : { runtimeAdmission: input.runtimeAdmission }),
        });
    const companions = Object.freeze([
        ...[...builtInTabs, ...pluginTabs].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
        ...appTabs,
    ].map(tab => resolveItem(tab, input)));
    if (!input.projectPages) return companions;
    const linked = new Set<string>();
    const items: ProjectDetailNavigationItem[] = input.projectPages.map((page, index) => {
        const companion = companions.find(tab => tab.owner === 'builtin' && tab.projectPage === page.id);
        if (companion) linked.add(companion.id);
        return Object.freeze({ id: page.id, title: page.title, icon: page.icon, disabledReason: page.disabledReason,
            ...(page.disabledReasonCode ? { disabledReasonCode: page.disabledReasonCode } : {}),
            navigation: companion ? { kind: 'both' as const, page: page.id, companion: companion.id, desktop: 'tabs' as const }
                : { kind: 'page' as const, page: page.id, desktop: 'tabs' as const },
            // A page the header keeps behind More starts in the phone's More too; the person can pin either.
            phonePlacement: page.defaultPlacement === 'overflow' ? 'more' as const : 'bar' as const, phoneOrder: index, page,
            ...(page.allowedPlacements ? { allowedPlacements: page.allowedPlacements } : {}),
            ...(companion ? { companion } : {}) });
    });
    for (const companion of companions) {
        if (linked.has(companion.id)) continue;
        const surface = companion.mobileSurfaces?.project;
        items.push(Object.freeze({ id: surface ?? companion.id, title: getRightSidebarTabLabel(companion), icon: companion.icon,
            disabledReason: companion.disabledReason ?? null, navigation: companion.navigation,
            phonePlacement: companion.id === 'terminal' && companion.hiddenInLauncher ? 'none' : companion.phonePlacement, phoneOrder: items.length, companion,
            defaultPlacement: 'overflow' as const }));
    }
    items.push(Object.freeze({ id: 'tabs', title: t('phoneNav.bar.openFiles'), icon: 'files',
        disabledReason: null, navigation: { kind: 'page' as const, page: 'tabs', desktop: 'none' as const },
        phonePlacement: 'more', phoneOrder: items.length, defaultPlacement: 'overflow' }));
    return Object.freeze(items);
}
