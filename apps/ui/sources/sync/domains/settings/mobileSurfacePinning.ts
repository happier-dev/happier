import { z } from 'zod';
import { resolveAnchoredListMoveV1, type AnchoredListPositionV1 } from '@happier-dev/protocol';

/** Device-local placement policy shared by the app and workspace rails and the Session bar. */
export type NavigationPlacement = 'pinned' | 'overflow' | 'hidden';
export type NavigationPlacementPreferences = Readonly<{
    orderedIds: readonly string[];
    placements: Readonly<Record<string, NavigationPlacement>>;
}>;
export const NAVIGATION_SURFACE_IDS = ['appRail', 'sessionRail', 'workspaceRail', 'sessionTabBar'] as const;
export type NavigationSurfaceId = typeof NAVIGATION_SURFACE_IDS[number];
export type NavigationSurfacePlacementsV1 = Readonly<Partial<Record<NavigationSurfaceId, NavigationPlacementPreferences>>>;

const navigationItemIdSchema = z.string().trim().min(1);
export const NavigationPlacementPreferencesSchema = z.object({
    orderedIds: z.array(navigationItemIdSchema),
    placements: z.record(navigationItemIdSchema, z.enum(['pinned', 'overflow', 'hidden'])),
}).strict();
export const NavigationSurfacePlacementsV1Schema = z.object({
    appRail: NavigationPlacementPreferencesSchema.optional(),
    sessionRail: NavigationPlacementPreferencesSchema.optional(),
    workspaceRail: NavigationPlacementPreferencesSchema.optional(),
    sessionTabBar: NavigationPlacementPreferencesSchema.optional(),
}).strict();
const storedNavigationPlacementPreferencesSchema = NavigationPlacementPreferencesSchema.strip();
export const StoredNavigationSurfacePlacementsV1Schema = NavigationSurfacePlacementsV1Schema.extend({
    appRail: storedNavigationPlacementPreferencesSchema.optional(),
    sessionRail: storedNavigationPlacementPreferencesSchema.optional(),
    workspaceRail: storedNavigationPlacementPreferencesSchema.optional(),
    sessionTabBar: storedNavigationPlacementPreferencesSchema.optional(),
}).strip();
export const EMPTY_NAVIGATION_PLACEMENT_PREFERENCES: NavigationPlacementPreferences = Object.freeze({ orderedIds: Object.freeze([]), placements: Object.freeze({}) });
export const SESSION_COCKPIT_DEFAULT_BAR_SURFACE_IDS = Object.freeze(['browse', 'git', 'companion', 'terminal'] as const);

function uniqueIds(ids: readonly string[]): string[] {
    return [...new Set(ids.flatMap(id => {
        const normalized = normalizeSurfaceId(id);
        return normalized ? [normalized] : [];
    }))];
}

export function resolveNavigationPlacements<T extends Readonly<{ id: string; defaultPlacement?: NavigationPlacement }>>(
    items: readonly T[], preferences: NavigationPlacementPreferences = EMPTY_NAVIGATION_PLACEMENT_PREFERENCES,
): Readonly<{ ordered: readonly T[]; pinned: readonly T[]; overflow: readonly T[]; hidden: readonly T[] }> {
    const byId = new Map(items.map(item => [item.id, item]));
    const orderedIds = uniqueIds([...preferences.orderedIds, ...items.map(item => item.id)]);
    const ordered: T[] = [], pinned: T[] = [], overflow: T[] = [], hidden: T[] = [];
    for (const id of orderedIds) {
        const item = byId.get(id);
        if (!item) continue;
        ordered.push(item);
        const placement = preferences.placements[id] ?? item.defaultPlacement ?? 'pinned';
        (placement === 'pinned' ? pinned : placement === 'overflow' ? overflow : hidden).push(item);
    }
    return { ordered, pinned, overflow, hidden };
}

export function updateNavigationPlacement(
    preferences: NavigationPlacementPreferences, id: string, placement: NavigationPlacement,
): NavigationPlacementPreferences {
    const normalized = normalizeSurfaceId(id);
    if (!normalized || preferences.placements[normalized] === placement) return preferences;
    return { orderedIds: preferences.orderedIds, placements: { ...preferences.placements, [normalized]: placement } };
}

/** Current anchors decide membership; removed plugin ids retain their relative saved slots. */
export function reorderNavigationPlacement(
    preferences: NavigationPlacementPreferences, orderedCatalogIds: readonly string[], sourceId: string, position: AnchoredListPositionV1,
): NavigationPlacementPreferences | null {
    const moved = resolveAnchoredListMoveV1(orderedCatalogIds, sourceId, position);
    if (!moved) return null;
    const currentIds = new Set(orderedCatalogIds);
    let index = 0;
    const orderedIds = uniqueIds([...preferences.orderedIds, ...orderedCatalogIds])
        .map(id => currentIds.has(id) ? moved[index++]! : id);
    return { orderedIds, placements: preferences.placements };
}

export function navigationPreferencesFromLegacyAppDestinations(preferences: Readonly<{
    orderedDestinationIds: readonly string[]; hiddenDestinationIds: readonly string[];
}>): NavigationPlacementPreferences {
    return { orderedIds: uniqueIds(preferences.orderedDestinationIds), placements: Object.fromEntries(uniqueIds(preferences.hiddenDestinationIds).map(id => [id, 'hidden' as const])) };
}

export function navigationPlacementsFromLegacyPins(
    pins: readonly string[] | null | undefined,
    defaults: readonly string[] = SESSION_COCKPIT_DEFAULT_BAR_SURFACE_IDS,
): NavigationPlacementPreferences {
    const phoneIds = uniqueIds(pins ?? defaults);
    return {
        orderedIds: phoneIds,
        placements: Object.fromEntries([...new Set([...defaults, ...phoneIds])].map(id => [id, phoneIds.includes(id) ? 'pinned' as const : 'overflow' as const])),
    };
}

/** Legacy settings are read-only seeds. An explicit surface, even empty, always wins. */
export function readNavigationSurfacePlacements(local: Readonly<{
    navigationSurfacePlacementsV1?: unknown;
    sessionCockpitBarSurfaceIds?: readonly string[] | null;
    compactAppDestinationPreferencesV1?: Readonly<{ orderedDestinationIds: readonly string[]; hiddenDestinationIds: readonly string[] }>;
}>): NavigationSurfacePlacementsV1 {
    const parsed = StoredNavigationSurfacePlacementsV1Schema.safeParse(local.navigationSurfacePlacementsV1 ?? {});
    const stored = parsed.success ? parsed.data : {};
    return {
        ...stored,
        appRail: stored.appRail ?? navigationPreferencesFromLegacyAppDestinations(local.compactAppDestinationPreferencesV1 ?? { orderedDestinationIds: [], hiddenDestinationIds: [] }),
        sessionTabBar: stored.sessionTabBar ?? navigationPlacementsFromLegacyPins(local.sessionCockpitBarSurfaceIds),
    };
}

/** Fit the measured prefix, accounting for separators and a single overflow trigger. */
export function resolveNavigationOverflow<T extends Readonly<{ id: string; group?: string }>>(
    pinned: readonly T[], explicitOverflow: readonly T[],
    options: Readonly<{ availableSize: number | null; itemSize: number; separatorSize?: number }>,
): Readonly<{ shown: readonly T[]; overflow: readonly T[] }> {
    const separatorSize = options.separatorSize ?? 0;
    const prefixSizes = [0];
    pinned.forEach((item, index) => prefixSizes.push(prefixSizes[index]! + options.itemSize + (index > 0 && item.group !== undefined && pinned[index - 1]!.group !== item.group ? separatorSize : 0)));
    if (options.availableSize === null || (explicitOverflow.length === 0 && prefixSizes[pinned.length]! <= options.availableSize)) {
        return { shown: pinned, overflow: explicitOverflow };
    }
    let shownCount = pinned.length;
    while (shownCount > 0 && prefixSizes[shownCount]! + options.itemSize > options.availableSize) shownCount--;
    return { shown: pinned.slice(0, shownCount), overflow: [...pinned.slice(shownCount), ...explicitOverflow] };
}

function normalizeSurfaceId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}
