import type { RightSidebarMobileProjectionEntry } from '@/components/appShell/rightSidebar/rightSidebarMobileProjection';
import { resolveRightSidebarMobileProjection } from '@/components/appShell/rightSidebar/rightSidebarMobileProjection';
import { resolveSessionRightSidebarTabs } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import type { RightSidebarTabDefinition } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import type { RightSidebarPluginTabRuntimeAdmission } from '@/components/appShell/rightSidebar/rightSidebarPluginTabs';
import type { ResolveRightSidebarTabsInput } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import { type NavigationPlacement, type NavigationPlacementPreferences } from '@/sync/domains/settings/mobileSurfacePinning';
import { resolveDetailPhoneBarFit, resolveDetailPhonePlacement } from '@/components/navigation/mobile/chrome/bars/detailPhoneNavigationProjection';

export { SESSION_COCKPIT_DEFAULT_BAR_SURFACE_IDS } from '@/sync/domains/settings/mobileSurfacePinning';

import {
    isSessionPluginMobileSurface,
    normalizeSessionMobileSurface,
    type SessionMobileSurface,
} from './sessionCockpitState';

/**
 * The `rightSidebar` registry remains the source of plugin admission, labels,
 * icons, and availability. This adapter projects resolved Session destinations without adding items, defaults or order.
 */
export type SessionCockpitMobileCatalogEntry = Readonly<{ defaultPlacement: NavigationPlacement; tab: RightSidebarTabDefinition }> & (
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

function entryForProjection(
    entry: RightSidebarMobileProjectionEntry,
): SessionCockpitMobileCatalogEntry | null {
    if (entry.tab.owner === 'builtin' && (entry.tab.id === 'chat' || entry.tab.id === 'tabs' || entry.tab.id === 'companion')) {
        return Object.freeze({ id: entry.tab.id, owner: 'host' as const, tab: entry.tab, defaultPlacement: entry.tab.phonePlacement === 'bar' ? 'pinned' as const : 'overflow' as const });
    }
    if (entry.owner === 'plugin') {
        return isSessionPluginMobileSurface(entry.tabId)
            ? Object.freeze({
                id: entry.tabId,
                owner: 'rightSidebar' as const,
                tab: entry.tab,
                defaultPlacement: entry.tab.phonePlacement === 'bar' ? 'pinned' as const : 'overflow' as const,
            })
            : null;
    }

    const surface = normalizeSessionMobileSurface(entry.surface);
    return surface
        ? Object.freeze({
            id: surface,
            owner: 'rightSidebar' as const,
            tab: entry.tab,
            defaultPlacement: entry.tab.phonePlacement === 'bar' ? 'pinned' as const : 'overflow' as const,
        })
        : null;
}

export function resolveSessionCockpitMobileCatalog(input: Readonly<Pick<ResolveRightSidebarTabsInput,
    'appPluginPlacements' | 'appLocalize'> & {
    terminalTabAvailable: boolean;
    tabs?: readonly RightSidebarTabDefinition[];
    /**
     * The exact Home's `sessions.board` decision; omitted means disabled. It
     * admits the Board surface itself. The host-owned Companion destination is
     * not a Board placement gate and is published on every Home.
     */
    boardFeatureEnabled?: boolean;
    browserFeatureEnabled?: boolean;
    sessionSharingAvailable?: boolean;
    pluginPlacements?: readonly PluginUiSurfacePlacementProjection[];
    runtimeAdmission?: RightSidebarPluginTabRuntimeAdmission;
}>): readonly SessionCockpitMobileCatalogEntry[] {
    const projectedEntries = resolveRightSidebarMobileProjection({
        scope: 'session',
        tabs: input.tabs ?? resolveSessionRightSidebarTabs({
            appPluginPlacements: input.appPluginPlacements,
            appLocalize: input.appLocalize,
            presentation: 'mobile',
            terminalTabAvailable: input.terminalTabAvailable,
            boardFeatureEnabled: input.boardFeatureEnabled === true,
            browserFeatureEnabled: input.browserFeatureEnabled === true,
            sessionSharingAvailable: input.sessionSharingAvailable === true,
            pluginPlacements: input.pluginPlacements,
            ...(input.runtimeAdmission === undefined ? {} : { runtimeAdmission: input.runtimeAdmission }),
        }),
    }).flatMap((entry) => {
        const catalogEntry = entryForProjection(entry);
        return catalogEntry ? [catalogEntry] : [];
    });
    return Object.freeze(projectedEntries);

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

/** Adapt the Session catalog to the phone owner; admission still belongs to the sidebar registry. */
export function resolveSessionCockpitPhoneItems(catalog: readonly SessionCockpitMobileCatalogEntry[]) {
    return catalog.map(entry => ({ ...entry,
        navigation: entry.tab.navigation ?? { kind: 'companion' as const },
        phonePlacement: entry.tab.phonePlacement ?? (entry.defaultPlacement === 'pinned' ? 'bar' as const : 'more' as const),
        ...(entry.tab.allowedPlacements ? { allowedPlacements: entry.tab.allowedPlacements } : {}),
        // Chat is the host's fixed primary destination, not a configurable tool.
        ...(entry.id === 'chat' ? { allowedPlacements: ['pinned'] as const } : {}),
    }));
}

/** Captured previews use exactly the same placement and fit owner as the live bar. */
export function resolveSessionCockpitMobileTabVisibility(input: Readonly<{
    catalog: readonly SessionCockpitMobileCatalogEntry[];
    preferences: NavigationPlacementPreferences | null | undefined;
    /** How many 1-slot tabs the floating bar holds at this width (`resolveFloatingTabBarSlotCount`). */
    slotCount: number;
    /** "Always swipe between sessions" is on (and the sideways swipe with it). */
    alwaysSwipe: boolean;
    pageTabs?: 'bottom' | 'top';
}>): Readonly<{
    mode: SessionCockpitBarMode;
    top: readonly SessionCockpitMobileCatalogEntry[];
    /** Chat, then the bar's tools as rendered. */
    visible: readonly SessionCockpitMobileCatalogEntry[];
    /** Pinned tools that wait in More only because "Always swipe" keeps the bar to what fits. */
    held: readonly SessionCockpitMobileCatalogEntry[];
    /** Every admitted tool that is not pinned to the bar. */
    overflow: readonly SessionCockpitMobileCatalogEntry[];
}> {
    const placement = resolveDetailPhonePlacement(resolveSessionCockpitPhoneItems(input.catalog), input.preferences ?? undefined, input.pageTabs ?? 'bottom');
    const fit = resolveDetailPhoneBarFit(placement, input.slotCount, input.alwaysSwipe ? 'more' : 'scroll');
    return { mode: fit.mode, top: placement.topPages, visible: fit.shown, held: fit.held, overflow: placement.placements.overflow };
}
