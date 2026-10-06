import type { RightSidebarMobileProjectionEntry } from '@/components/appShell/rightSidebar/rightSidebarMobileProjection';
import { resolveRightSidebarMobileProjection } from '@/components/appShell/rightSidebar/rightSidebarMobileProjection';
import { resolveSessionRightSidebarTabs } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import type { RightSidebarTabDefinition } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import type { RightSidebarPluginTabRuntimeAdmission } from '@/components/appShell/rightSidebar/rightSidebarPluginTabs';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import { SESSION_COCKPIT_DEFAULT_BAR_SURFACE_IDS, resolveNavigationPlacements, type NavigationPlacement, type NavigationPlacementPreferences } from '@/sync/domains/settings/mobileSurfacePinning';

export { SESSION_COCKPIT_DEFAULT_BAR_SURFACE_IDS } from '@/sync/domains/settings/mobileSurfacePinning';

import {
    isSessionPluginMobileSurface,
    normalizeSessionMobileSurface,
    type SessionMobileSurface,
} from './sessionCockpitState';

/**
 * The `rightSidebar` registry remains the source of plugin admission, labels,
 * icons, and availability. This host adapter only adds the two Session-owned
 * cockpit entries and applies host/user ordering before the mobile bar renders.
 */
export type SessionCockpitMobileCatalogEntry = Readonly<{ defaultPlacement: NavigationPlacement }> & (
    | Readonly<{
        id: 'chat' | 'tabs' | 'companion';
        owner: 'host';
    }>
    | Readonly<{
        id: SessionMobileSurface;
        owner: 'rightSidebar';
        tab: RightSidebarTabDefinition;
    }>);

/**
 * `fit`: every pinned tool is on the bar. `scroll`: they do not fit, so the bar scrolls its tools
 * sideways (and owns the horizontal axis). `more`: they do not fit and "Always swipe between
 * sessions" keeps the bar a swipe, so the ones that do not fit wait in More.
 */
export type SessionCockpitBarMode = 'fit' | 'scroll' | 'more';

/** Chat and More each take one slot; everything else is a tool. */
const RESERVED_BAR_SLOTS = 2;

function entryForProjection(
    entry: RightSidebarMobileProjectionEntry,
): SessionCockpitMobileCatalogEntry | null {
    if (entry.owner === 'plugin') {
        return isSessionPluginMobileSurface(entry.tabId)
            ? Object.freeze({
                id: entry.tabId,
                owner: 'rightSidebar' as const,
                tab: entry.tab,
                defaultPlacement: 'overflow' as const,
            })
            : null;
    }

    const surface = normalizeSessionMobileSurface(entry.surface);
    return surface
        ? Object.freeze({
            id: surface,
            owner: 'rightSidebar' as const,
            tab: entry.tab,
            defaultPlacement: SESSION_COCKPIT_DEFAULT_BAR_SURFACE_IDS.some((id) => id === surface) ? 'pinned' as const : 'overflow' as const,
        })
        : null;
}

function compareCatalogEntries(
    first: SessionCockpitMobileCatalogEntry,
    second: SessionCockpitMobileCatalogEntry,
): number {
    const firstOrder = first.owner === 'rightSidebar' ? first.tab.order : Number.MIN_SAFE_INTEGER;
    const secondOrder = second.owner === 'rightSidebar' ? second.tab.order : Number.MIN_SAFE_INTEGER;
    return firstOrder - secondOrder || first.id.localeCompare(second.id);
}

function addCatalogEntry(
    result: SessionCockpitMobileCatalogEntry[],
    entry: SessionCockpitMobileCatalogEntry | null | undefined,
): void {
    if (!entry || result.some((candidate) => candidate.id === entry.id)) return;
    result.push(entry);
}

export function resolveSessionCockpitMobileCatalog(input: Readonly<{
    terminalTabAvailable: boolean;
    /**
     * The exact Home's `sessions.board` decision; omitted means disabled. It
     * admits the Board surface itself. The host-owned Companion destination is
     * not a Board placement gate and is published on every Home.
     */
    boardFeatureEnabled?: boolean;
    sessionSharingAvailable?: boolean;
    pluginPlacements?: readonly PluginUiSurfacePlacementProjection[];
    projectionGeneration?: number | null;
    runtimeAdmission?: RightSidebarPluginTabRuntimeAdmission;
}>): readonly SessionCockpitMobileCatalogEntry[] {
    const projectedEntries = resolveRightSidebarMobileProjection({
        scope: 'session',
        tabs: resolveSessionRightSidebarTabs({
            presentation: 'mobile',
            terminalTabAvailable: input.terminalTabAvailable,
            boardFeatureEnabled: input.boardFeatureEnabled === true,
            sessionSharingAvailable: input.sessionSharingAvailable === true,
            pluginPlacements: input.pluginPlacements,
            projectionGeneration: input.projectionGeneration,
            ...(input.runtimeAdmission === undefined ? {} : { runtimeAdmission: input.runtimeAdmission }),
        }),
    }).flatMap((entry) => {
        const catalogEntry = entryForProjection(entry);
        return catalogEntry ? [catalogEntry] : [];
    });
    const entryForBuiltinTab = (tabId: string): SessionCockpitMobileCatalogEntry | null => (
        projectedEntries.find((entry) => (
            entry.owner === 'rightSidebar'
            && entry.tab.owner === 'builtin'
            && entry.tab.id === tabId
        )) ?? null
    );
    const remainingBuiltIns = projectedEntries
        .filter((entry) => (
            entry.owner === 'rightSidebar'
            && entry.tab.owner === 'builtin'
            && !['files', 'git', 'terminal'].includes(entry.tab.id)
        ))
        .sort(compareCatalogEntries);
    const pluginEntries = projectedEntries
        .filter((entry) => entry.owner === 'rightSidebar' && entry.tab.owner === 'plugin')
        .sort(compareCatalogEntries);

    const result: SessionCockpitMobileCatalogEntry[] = [];
    addCatalogEntry(result, Object.freeze({ id: 'chat', owner: 'host' as const, defaultPlacement: 'pinned' as const }));
    // These positions are host policy. A binding cannot displace built-in
    // cockpit affordances without an explicit user pin.
    addCatalogEntry(result, entryForBuiltinTab('files'));
    addCatalogEntry(result, entryForBuiltinTab('git'));
    addCatalogEntry(result, Object.freeze({ id: 'tabs', owner: 'host' as const, defaultPlacement: 'overflow' as const }));
    // Companion is host-owned like Chat and Details. Its first-party Session
    // Summary is composed from Session facts alone, so it is published on every
    // Home; only the Board content it can present follows `sessions.board`.
    addCatalogEntry(result, Object.freeze({ id: 'companion', owner: 'host' as const, defaultPlacement: 'pinned' as const }));
    for (const entry of remainingBuiltIns) addCatalogEntry(result, entry);
    for (const entry of pluginEntries) addCatalogEntry(result, entry);
    addCatalogEntry(result, entryForBuiltinTab('terminal'));

    return Object.freeze(result);
}

/**
 * The hidden navigator consumes the same normalized catalog as the visible
 * Session bar. A retained plugin identity is screen-only state: it is appended
 * solely so the host can render the typed unavailable tombstone after its
 * current catalog entry disappears, never as a second discovery/order policy.
 */
export function resolveSessionCockpitMobileNavigatorSurfaces(input: Readonly<{
    catalog: readonly SessionCockpitMobileCatalogEntry[];
    retainedPluginSurface?: SessionMobileSurface | null;
}>): readonly SessionMobileSurface[] {
    const result = input.catalog.map((entry) => entry.id);
    if (
        input.retainedPluginSurface
        && isSessionPluginMobileSurface(input.retainedPluginSurface)
        && !result.includes(input.retainedPluginSurface)
    ) {
        result.push(input.retainedPluginSurface);
    }
    return Object.freeze(result);
}

export function resolveSessionCockpitMobileTabVisibility(input: Readonly<{
    catalog: readonly SessionCockpitMobileCatalogEntry[];
    preferences: NavigationPlacementPreferences | null | undefined;
    /** How many 1-slot tabs the floating bar holds at this width (`resolveFloatingTabBarSlotCount`). */
    slotCount: number;
    /** "Always swipe between sessions" is on (and the sideways swipe with it). */
    alwaysSwipe: boolean;
}>): Readonly<{
    mode: SessionCockpitBarMode;
    /** Chat, then the bar's tools as rendered. */
    visible: readonly SessionCockpitMobileCatalogEntry[];
    /** Pinned tools that wait in More only because "Always swipe" keeps the bar to what fits. */
    held: readonly SessionCockpitMobileCatalogEntry[];
    /** Every admitted tool that is not pinned to the bar. */
    overflow: readonly SessionCockpitMobileCatalogEntry[];
}> {
    const catalogById = new Map<string, SessionCockpitMobileCatalogEntry>(
        input.catalog.map((entry) => [entry.id, entry]),
    );
    const placements = resolveNavigationPlacements(input.catalog.filter((entry) => entry.id !== 'chat'), input.preferences ?? undefined);
    const barTools = placements.pinned;
    const toolSlots = Math.max(1, Math.floor(input.slotCount) - RESERVED_BAR_SLOTS);
    const mode: SessionCockpitBarMode = barTools.length <= toolSlots
        ? 'fit'
        : input.alwaysSwipe ? 'more' : 'scroll';
    const shown = mode === 'more' ? barTools.slice(0, toolSlots) : barTools;
    const held = mode === 'more' ? barTools.slice(toolSlots) : [];

    const visible: SessionCockpitMobileCatalogEntry[] = [];
    addCatalogEntry(visible, catalogById.get('chat'));
    for (const entry of shown) addCatalogEntry(visible, entry);
    return Object.freeze({
        mode,
        visible: Object.freeze(visible),
        held: Object.freeze(held),
        overflow: Object.freeze(placements.overflow),
    });
}
