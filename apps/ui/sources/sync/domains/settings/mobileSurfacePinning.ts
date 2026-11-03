import { z } from 'zod/mini';
import { resolveAnchoredListMoveV1, type AnchoredListPositionV1 } from '@happier-dev/protocol/actions/anchoredListOrderV1';

/** Device-local placement policy shared by the app and workspace rails and the Session bar. */
export type NavigationPlacement = 'pinned' | 'overflow' | 'hidden';
/** Automatic is catalog policy only; preferences continue to store explicit choices. */
export type NavigationDefaultPlacement = NavigationPlacement | 'auto';
export type NavigationPlacementPolicy = Readonly<{
    defaultPlacement?: NavigationDefaultPlacement;
    hasContent?: boolean | null;
    allowedPlacements?: readonly NavigationPlacement[];
    pending?: boolean;
}>;
export type NavigationPlacementPreferences = Readonly<{
    orderedIds: readonly string[];
    placements: Readonly<Record<string, NavigationPlacement>>;
}>;
export const NAVIGATION_SURFACE_IDS = ['appRail', 'sessionRail', 'workspaceRail', 'sessionTabBar', 'projectTabBar', 'phoneLauncher', 'composer'] as const;
export type NavigationSurfaceId = typeof NAVIGATION_SURFACE_IDS[number];
export type DetailNavigationPlacement = Readonly<{
    desktop?: Readonly<{ pages?: NavigationPlacementPreferences; companions?: NavigationPlacementPreferences }>;
    phone?: Readonly<{ items?: NavigationPlacementPreferences }>;
}>;
export type NavigationSurfacePlacementsV1 = Readonly<Partial<Record<NavigationSurfaceId, NavigationPlacementPreferences>> & {
    detailPages?: Readonly<Record<string, DetailNavigationPlacement>>;
    pageTabs?: Readonly<Record<string, 'bottom' | 'top'>>;
}>;
export type DetailNavigationAddress = Readonly<{ pageKind: string }> & (
    | Readonly<{ device: 'desktop'; section: 'pages' | 'companions' }>
    | Readonly<{ device: 'phone'; section: 'items' }>);
export type NavigationPlacementAddress = NavigationSurfaceId | DetailNavigationAddress;

const navigationItemIdSchema = z.string().check(z.trim(), z.minLength(1));
const completeNavigationPlacementPreferencesSchema = z.strictObject({
    orderedIds: z.array(navigationItemIdSchema),
    placements: z.record(navigationItemIdSchema, z.enum(['pinned', 'overflow', 'hidden'])),
});
export const NavigationPlacementPreferencesSchema = z.union([
    completeNavigationPlacementPreferencesSchema,
    z.pipe(z.strictObject({}), z.transform(() => ({ orderedIds: [] as string[], placements: {} as Record<string, NavigationPlacement> }))),
]);
const detailNavigationPlacementSchema = z.strictObject({
    desktop: z.optional(z.strictObject({ pages: z.optional(NavigationPlacementPreferencesSchema), companions: z.optional(NavigationPlacementPreferencesSchema) })),
    phone: z.optional(z.strictObject({ items: z.optional(NavigationPlacementPreferencesSchema) })),
});
export const NavigationSurfacePlacementsV1Schema = z.strictObject({
    detailPages: z.optional(z.record(navigationItemIdSchema, detailNavigationPlacementSchema)),
    pageTabs: z.optional(z.record(navigationItemIdSchema, z.enum(['bottom', 'top']))),
    appRail: z.optional(NavigationPlacementPreferencesSchema),
    sessionRail: z.optional(NavigationPlacementPreferencesSchema),
    workspaceRail: z.optional(NavigationPlacementPreferencesSchema),
    sessionTabBar: z.optional(NavigationPlacementPreferencesSchema),
    projectTabBar: z.optional(NavigationPlacementPreferencesSchema),
    phoneLauncher: z.optional(NavigationPlacementPreferencesSchema),
    composer: z.optional(NavigationPlacementPreferencesSchema),
});
const storedNavigationPlacementPreferencesSchema = z.union([
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: undefined }) as z.ZodMiniObject<T['shape'], z.core.$strip>)(completeNavigationPlacementPreferencesSchema),
    z.pipe(z.strictObject({}), z.transform(() => ({ orderedIds: [] as string[], placements: {} as Record<string, NavigationPlacement> }))),
]);
export const StoredNavigationSurfacePlacementsV1Schema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: undefined }) as z.ZodMiniObject<T['shape'], z.core.$strip>)(z.extend(NavigationSurfacePlacementsV1Schema, {
    detailPages: z.optional(z.record(navigationItemIdSchema, z.object({
        desktop: z.optional(z.object({ pages: z.optional(storedNavigationPlacementPreferencesSchema), companions: z.optional(storedNavigationPlacementPreferencesSchema) })),
        phone: z.optional(z.object({ items: z.optional(storedNavigationPlacementPreferencesSchema) })),
    }))),
    appRail: z.optional(storedNavigationPlacementPreferencesSchema),
    sessionRail: z.optional(storedNavigationPlacementPreferencesSchema),
    workspaceRail: z.optional(storedNavigationPlacementPreferencesSchema),
    sessionTabBar: z.optional(storedNavigationPlacementPreferencesSchema),
    projectTabBar: z.optional(storedNavigationPlacementPreferencesSchema),
    phoneLauncher: z.optional(storedNavigationPlacementPreferencesSchema),
    composer: z.optional(storedNavigationPlacementPreferencesSchema),
}));
export const EMPTY_NAVIGATION_PLACEMENT_PREFERENCES: NavigationPlacementPreferences = Object.freeze({ orderedIds: Object.freeze([]), placements: Object.freeze({}) });
export const SESSION_COCKPIT_DEFAULT_BAR_SURFACE_IDS = Object.freeze(['browse', 'git', 'companion', 'terminal'] as const);

/** Existing addresses retain their storage; only missing addresses use detailPages. */
export function resolveNavigationPlacementAddress(address: NavigationPlacementAddress): NavigationPlacementAddress {
    if (typeof address === 'string') return address;
    if (address.pageKind === 'session') {
        if (address.device === 'phone') return 'sessionTabBar';
        if (address.section === 'companions') return 'sessionRail';
    }
    if (address.pageKind === 'project' && address.device === 'desktop') {
        return address.section === 'pages' ? 'projectTabBar' : 'workspaceRail';
    }
    return address;
}

export function readNavigationPlacementPreferences(stored: NavigationSurfacePlacementsV1, address: NavigationPlacementAddress): NavigationPlacementPreferences | undefined {
    const resolved = resolveNavigationPlacementAddress(address);
    if (typeof resolved === 'string') return stored[resolved];
    const kind = stored.detailPages?.[resolved.pageKind];
    return resolved.device === 'phone' ? kind?.phone?.items : kind?.desktop?.[resolved.section];
}

export function navigationPlacementPatch(address: NavigationPlacementAddress, preferences: NavigationPlacementPreferences): NavigationSurfacePlacementsV1 {
    const resolved = resolveNavigationPlacementAddress(address);
    return typeof resolved === 'string' ? { [resolved]: preferences }
        : { detailPages: { [resolved.pageKind]: { [resolved.device]: { [resolved.section]: preferences } } } };
}

function samePreferences(a: NavigationPlacementPreferences | undefined, b: NavigationPlacementPreferences): boolean {
    return a !== undefined && a.orderedIds.length === b.orderedIds.length
        && a.orderedIds.every((id, index) => id === b.orderedIds[index])
        && Object.keys(a.placements).length === Object.keys(b.placements).length
        && Object.entries(a.placements).every(([id, placement]) => b.placements[id] === placement);
}

/** An admitted sparse settings patch changes only its addressed branches. */
export function mergeNavigationSurfacePlacements(current: NavigationSurfacePlacementsV1, patch: NavigationSurfacePlacementsV1): NavigationSurfacePlacementsV1 {
    let next = current;
    const merge = (address: NavigationPlacementAddress, preferences: NavigationPlacementPreferences | undefined) => {
        if (!preferences || samePreferences(readNavigationPlacementPreferences(next, address), preferences)) return;
        const resolved = resolveNavigationPlacementAddress(address);
        if (typeof resolved === 'string') { next = { ...next, [resolved]: preferences }; return; }
        const kind = next.detailPages?.[resolved.pageKind];
        next = { ...next, detailPages: { ...next.detailPages, [resolved.pageKind]: {
            ...kind, [resolved.device]: { ...kind?.[resolved.device], [resolved.section]: preferences },
        } } };
    };
    for (const id of NAVIGATION_SURFACE_IDS) merge(id, patch[id]);
    for (const [kind, value] of Object.entries(patch.detailPages ?? {})) {
        merge({ pageKind: kind, device: 'desktop', section: 'pages' }, value.desktop?.pages);
        merge({ pageKind: kind, device: 'desktop', section: 'companions' }, value.desktop?.companions);
        merge({ pageKind: kind, device: 'phone', section: 'items' }, value.phone?.items);
    }
    for (const [kind, position] of Object.entries(patch.pageTabs ?? {})) {
        if (current.pageTabs?.[kind] !== position) next = { ...next, pageTabs: { ...next.pageTabs, [kind]: position } };
    }
    return next;
}

function uniqueIds(ids: readonly string[]): string[] {
    return [...new Set(ids.flatMap(id => {
        const normalized = normalizeSurfaceId(id);
        return normalized ? [normalized] : [];
    }))];
}

export function resolveNavigationPlacements<T extends Readonly<{ id: string }> & NavigationPlacementPolicy>(
    items: readonly T[], preferences: NavigationPlacementPreferences = EMPTY_NAVIGATION_PLACEMENT_PREFERENCES,
): Readonly<{ ordered: readonly T[]; pinned: readonly T[]; overflow: readonly T[]; hidden: readonly T[]; effectivePlacements: Readonly<Record<string, NavigationPlacement>> }> {
    const byId = new Map(items.map(item => [item.id, item]));
    const orderedIds = uniqueIds([...preferences.orderedIds, ...items.map(item => item.id)]);
    const ordered: T[] = [], pinned: T[] = [], overflow: T[] = [], hidden: T[] = [];
    const effectivePlacements: Record<string, NavigationPlacement> = {};
    for (const id of orderedIds) {
        const item = byId.get(id);
        if (!item) continue;
        ordered.push(item);
        const defaultPlacement = item.defaultPlacement === 'auto' ? item.hasContent === true ? 'pinned' : 'overflow' : item.defaultPlacement ?? 'pinned';
        let placement = preferences.placements[id] ?? defaultPlacement;
        if (item.allowedPlacements && !item.allowedPlacements.includes(placement)) {
            placement = item.allowedPlacements.includes(defaultPlacement) ? defaultPlacement : item.allowedPlacements[0] ?? defaultPlacement;
        }
        if (item.pending) placement = 'pinned';
        effectivePlacements[id] = placement;
        (placement === 'pinned' ? pinned : placement === 'overflow' ? overflow : hidden).push(item);
    }
    return { ordered, pinned, overflow, hidden, effectivePlacements };
}

export function updateNavigationPlacement(
    preferences: NavigationPlacementPreferences, id: string, placement: NavigationDefaultPlacement,
): NavigationPlacementPreferences {
    const normalized = normalizeSurfaceId(id);
    if (!normalized || preferences.placements[normalized] === placement) return preferences;
    if (placement === 'auto') {
        if (!(normalized in preferences.placements)) return preferences;
        const { [normalized]: _removed, ...placements } = preferences.placements;
        return { orderedIds: preferences.orderedIds, placements };
    }
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


/** Historical Project companion aliases enter the unified item vocabulary at this input adapter. */
export function normalizeProjectNavigationItemId(id: string): string {
    return id === 'git' ? 'changes' : id === 'browse' || id === 'files' ? 'code' : id;
}

/** Settings initialization only. Presence, including an explicit empty value, completes the seed. */
export function seedProjectPhoneNavigationPlacements(input: unknown): unknown {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    const source = input as Record<string, unknown>;
    const parsed = StoredNavigationSurfacePlacementsV1Schema.safeParse(source.navigationSurfacePlacementsV1 ?? {});
    if (!parsed.success || parsed.data.detailPages?.project?.phone?.items !== undefined) return input;
    const desktop = parsed.data.projectTabBar;
    const items: NavigationPlacementPreferences = desktop ? {
        orderedIds: [...new Set(desktop.orderedIds.map(normalizeProjectNavigationItemId))],
        placements: Object.fromEntries(Object.entries(desktop.placements).map(([id, placement]) => [normalizeProjectNavigationItemId(id), placement])),
    } : EMPTY_NAVIGATION_PLACEMENT_PREFERENCES;
    const stored = (source.navigationSurfacePlacementsV1 ?? {}) as NavigationSurfacePlacementsV1;
    return { ...source, navigationSurfacePlacementsV1: mergeNavigationSurfacePlacements(stored, navigationPlacementPatch(
        { pageKind: 'project', device: 'phone', section: 'items' }, items)) };
}
