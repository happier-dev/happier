import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from './projection';

export const DECLARATION_MAP_KEYS = ['translationsByPluginId', 'sessionHeaderActionsById', 'searchProvidersById',
    'hostedWebById', 'reactNativeBundlesById', 'surfacePlacementsById', 'settingsGroupsById', 'settingsPagesById',
    'actionsById', 'voiceProvidersById', 'dragSourcesById', 'workItemsById', 'dropTargetsById',
    'atmospherePicturesById', 'registrySourcesById', 'storeKindsById', 'machineRecipesById', 'machineSetupPresetsById', 'skillsById', 'unknownEntriesById', 'inputTypesById',
    'composerControlsById', 'composerRegionsById', 'composerReferencesById'] as const;
export const UNION_MAP_KEYS = [...DECLARATION_MAP_KEYS, 'resourcesById', 'connectedAccountDescriptorsById', 'installedPackagesById'] as const;
export type UnionMapKey = typeof UNION_MAP_KEYS[number];
/** Typed fallback for the optional connected-account family; canonical frozen families win. */
const EMPTY_UNION_FAMILY: Readonly<Record<string, never>> = Object.freeze({});

type PublishedPluginSlice = Readonly<{ model: PluginUiProjectionModel; entries: readonly unknown[] }>;
export type PublishedProjectionPluginIndex = Readonly<{ slices: Readonly<Record<string, PublishedPluginSlice>> }>;
const publishedProjectionPluginIndex = Symbol('pluginUiPublishedPluginIndex');

export function readPublishedProjectionPluginIndex(model: PluginUiProjectionModel | null): PublishedProjectionPluginIndex | null {
    const proof: unknown = model ? Object.getOwnPropertyDescriptor(model, publishedProjectionPluginIndex)?.value : null;
    // Only this publication owner creates the private immutable index. Copying
    // its descriptor to another snapshot must not turn that snapshot into proof.
    return proof && typeof proof === 'object' && !Array.isArray(proof) && 'owner' in proof && proof.owner === model && 'index' in proof
        ? proof.index as PublishedProjectionPluginIndex : null;
}

export function publishProjectionPluginIndex(model: PluginUiProjectionModel, index: PublishedProjectionPluginIndex): PluginUiProjectionModel {
    if (readPublishedProjectionPluginIndex(model) === index) return model;
    const owned = { ...model };
    Object.defineProperty(owned, publishedProjectionPluginIndex, { value: Object.freeze({ owner: owned, index }) });
    return Object.freeze(owned);
}

function entryPluginId(key: UnionMapKey, entryId: string, entry: unknown): string | null {
    if (key === 'installedPackagesById') return entryId;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !('pluginId' in entry)) return null;
    return typeof entry.pluginId === 'string' && entry.pluginId.trim().length > 0 ? entry.pluginId : null;
}

/** Index raw dictionary replacements once; stable families and plugin slices pass through. */
export function prepareProjectionPluginIndex(model: PluginUiProjectionModel, previous?: PublishedProjectionPluginIndex | null,
    previousModel?: PluginUiProjectionModel | null): PublishedProjectionPluginIndex {
    const changedFamilies = UNION_MAP_KEYS.filter(key => !previousModel || model[key] !== previousModel[key]);
    const changedPluginIds = previous && previousModel ? new Set<string>() : null;
    if (changedPluginIds && previousModel) {
        for (const key of changedFamilies) {
            const before = previousModel[key] ?? EMPTY_UNION_FAMILY;
            const after = model[key] ?? EMPTY_UNION_FAMILY;
            for (const [id, entry] of Object.entries(after)) {
                // Picture insertion order is part of this family's public value.
                // Its per-plugin order is reconciled below, even for equal rows.
                if (key !== 'atmospherePicturesById' && Object.hasOwn(before, id) && before[id] === entry) continue;
                const pluginId = entryPluginId(key, id, entry);
                if (pluginId) changedPluginIds.add(pluginId);
                const oldPluginId = entryPluginId(key, id, before[id]);
                if (oldPluginId) changedPluginIds.add(oldPluginId);
            }
            for (const [id, entry] of Object.entries(before)) if (!Object.hasOwn(after, id)) {
                const pluginId = entryPluginId(key, id, entry);
                if (pluginId) changedPluginIds.add(pluginId);
            }
        }
        if (changedPluginIds.size === 0) return previous!;
    }
    const groups = new Map<string, Partial<Record<UnionMapKey, Record<string, unknown>>>>();
    for (const id of changedPluginIds ?? []) groups.set(id, {});
    for (const key of changedFamilies) for (const [entryId, entry] of Object.entries(model[key] ?? EMPTY_UNION_FAMILY)) {
        const id = entryPluginId(key, entryId, entry);
        if (!id || changedPluginIds && !changedPluginIds.has(id)) continue;
        const group = groups.get(id) ?? {};
        const map = group[key] ??= {};
        // Ordinary assignment has the same descriptor on a fresh dictionary;
        // __proto__ alone needs an own data property instead of its legacy setter.
        if (entryId === '__proto__') Object.defineProperty(map, entryId, { value: entry, enumerable: true, configurable: true, writable: true });
        else map[entryId] = entry;
        groups.set(id, group);
    }
    const slices: Record<string, PublishedPluginSlice> = changedPluginIds && previous ? { ...previous.slices } : {};
    Object.setPrototypeOf(slices, null);
    for (const [id, group] of groups) {
        const old = previous?.slices[id];
        const maps: Partial<Record<UnionMapKey, Readonly<Record<string, unknown>>>> = {};
        let changed = !old;
        // A first slice inherits every absent family from the canonical empty
        // model. Only supplied families need comparison or a fresh dictionary.
        const families = old ? changedFamilies : Object.keys(group) as UnionMapKey[];
        for (const key of families) {
            const map = group[key] ?? EMPTY_PLUGIN_UI_PROJECTION[key] ?? EMPTY_UNION_FAMILY;
            const previousMap = old?.model[key];
            if (map === previousMap) continue;
            const keys = group[key] ? Object.keys(map) : [];
            const oldKeys = previousMap ? Object.keys(previousMap) : [];
            const same = previousMap && keys.length === oldKeys.length
                && keys.every((entryId, index) => Object.hasOwn(previousMap, entryId) && previousMap[entryId] === map[entryId]
                    && (key !== 'atmospherePicturesById' || oldKeys[index] === entryId));
            if (!same) { maps[key] = Object.freeze(map); changed = true; }
        }
        if (old && !changed) {
            slices[id] = old;
            continue;
        }
        if (old && !UNION_MAP_KEYS.some(key => (maps[key] ?? old.model[key]) !== (EMPTY_PLUGIN_UI_PROJECTION[key] ?? EMPTY_UNION_FAMILY))) {
            delete slices[id];
            continue;
        }
        // Slices contain only plugin dictionaries. Global readiness/diagnostics
        // always come from the actual next root at the publication owner.
        const sliceModel = Object.freeze({ ...(old?.model ?? EMPTY_PLUGIN_UI_PROJECTION),
            connectedAccountDescriptorsById: old?.model.connectedAccountDescriptorsById
                ?? EMPTY_PLUGIN_UI_PROJECTION.connectedAccountDescriptorsById ?? EMPTY_UNION_FAMILY, ...maps }) as PluginUiProjectionModel;
        const entries = (old ? DECLARATION_MAP_KEYS : DECLARATION_MAP_KEYS.filter(key => group[key]))
            .flatMap(key => Object.values(sliceModel[key]));
        const retainedEntries = old && old.entries.length === entries.length && entries.every((entry, index) => entry === old.entries[index])
            ? old.entries : Object.freeze(entries);
        slices[id] = Object.freeze({ model: sliceModel, entries: retainedEntries });
    }
    const ids = Object.keys(slices);
    if (previous && ids.length === Object.keys(previous.slices).length && ids.every(id => slices[id] === previous.slices[id])) return previous;
    return Object.freeze({ slices: Object.freeze(slices) });
}

export function pluginSliceKeys(models: readonly (PluginUiProjectionModel | undefined | null)[]): ReadonlyMap<UnionMapKey, ReadonlySet<string>> {
    const keys = new Map<UnionMapKey, ReadonlySet<string>>();
    for (const key of UNION_MAP_KEYS) {
        const ids = models.flatMap(model => {
            const map = model?.[key];
            return !map || map === EMPTY_PLUGIN_UI_PROJECTION[key] || map === EMPTY_UNION_FAMILY ? [] : Object.keys(map);
        });
        if (ids.length > 0) keys.set(key, new Set(ids));
    }
    return keys;
}
