import type { RightSidebarMobileProjectionEntry } from '@/components/appShell/rightSidebar/rightSidebarMobileProjection';
import { resolveRightSidebarMobileProjection } from '@/components/appShell/rightSidebar/rightSidebarMobileProjection';
import { resolveSessionRightSidebarTabs } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import type { RightSidebarTabDefinition } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import type { RightSidebarPluginTabRuntimeAdmission } from '@/components/appShell/rightSidebar/rightSidebarPluginTabs';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import { SESSION_COCKPIT_MAX_PINNED_SURFACE_COUNT } from '@/sync/domains/settings/mobileSurfacePinning';

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
export type SessionCockpitMobileCatalogEntry =
    | Readonly<{
        id: 'chat' | 'tabs';
        owner: 'host';
    }>
    | Readonly<{
        id: SessionMobileSurface;
        owner: 'rightSidebar';
        tab: RightSidebarTabDefinition;
    }>;

export const SESSION_COCKPIT_MAX_INLINE_SURFACE_COUNT = 4;

function entryForProjection(
    entry: RightSidebarMobileProjectionEntry,
): SessionCockpitMobileCatalogEntry | null {
    if (entry.owner === 'plugin') {
        return isSessionPluginMobileSurface(entry.tabId)
            ? Object.freeze({
                id: entry.tabId,
                owner: 'rightSidebar' as const,
                tab: entry.tab,
            })
            : null;
    }

    const surface = normalizeSessionMobileSurface(entry.surface);
    return surface
        ? Object.freeze({
            id: surface,
            owner: 'rightSidebar' as const,
            tab: entry.tab,
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
    pluginPlacements?: readonly PluginUiSurfacePlacementProjection[];
    projectionGeneration?: number | null;
    runtimeAdmission?: RightSidebarPluginTabRuntimeAdmission;
}>): readonly SessionCockpitMobileCatalogEntry[] {
    const projectedEntries = resolveRightSidebarMobileProjection({
        scope: 'session',
        tabs: resolveSessionRightSidebarTabs({
            presentation: 'mobile',
            terminalTabAvailable: input.terminalTabAvailable,
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
    addCatalogEntry(result, Object.freeze({ id: 'chat', owner: 'host' as const }));
    // These positions are host policy. A binding cannot displace built-in
    // cockpit affordances without an explicit user pin.
    addCatalogEntry(result, entryForBuiltinTab('files'));
    addCatalogEntry(result, entryForBuiltinTab('git'));
    addCatalogEntry(result, Object.freeze({ id: 'tabs', owner: 'host' as const }));
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
    pinnedSurfaceIds: readonly string[] | null | undefined;
}>): Readonly<{
    visible: readonly SessionCockpitMobileCatalogEntry[];
    overflow: readonly SessionCockpitMobileCatalogEntry[];
}> {
    const catalogById = new Map<string, SessionCockpitMobileCatalogEntry>(
        input.catalog.map((entry) => [entry.id, entry]),
    );
    const pinnedEntries: SessionCockpitMobileCatalogEntry[] = [];
    const seenPinnedIds = new Set<string>();
    for (const surfaceId of input.pinnedSurfaceIds ?? []) {
        if (surfaceId === 'chat' || seenPinnedIds.has(surfaceId)) continue;
        seenPinnedIds.add(surfaceId);
        const entry = catalogById.get(surfaceId);
        if (entry) pinnedEntries.push(entry);
    }

    const visible: SessionCockpitMobileCatalogEntry[] = [];
    addCatalogEntry(visible, catalogById.get('chat'));
    for (const entry of pinnedEntries.slice(-SESSION_COCKPIT_MAX_PINNED_SURFACE_COUNT)) {
        addCatalogEntry(visible, entry);
    }
    for (const entry of input.catalog) {
        if (visible.length >= SESSION_COCKPIT_MAX_INLINE_SURFACE_COUNT) break;
        addCatalogEntry(visible, entry);
    }

    const visibleIds = new Set(visible.map((entry) => entry.id));
    return Object.freeze({
        visible: Object.freeze(visible),
        overflow: Object.freeze(input.catalog.filter((entry) => !visibleIds.has(entry.id))),
    });
}
