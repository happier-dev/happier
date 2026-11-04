import { useMemo, useSyncExternalStore } from 'react';
import { z } from 'zod/mini';
import { createPersistentUiState, UiStatePersistenceError, usePersistentUiStateValue } from './persistentUiState';
import { getPersistenceStorage, subscribePersistenceStorageCleared } from './persistenceStorage';
import { migrateSessionListCollapseKey } from '@/sync/domains/session/listing/sessionListCollapseState';
import { completeLegacyDisclosureImportBeforeRemoval } from './settingsPersistence';

// Preserve the existing device-wide Setup choices and qualified group ids exactly.
// Each interaction writes one record and never publishes a Settings snapshot.
export const collapsedGroupsState = createPersistentUiState('collapsed-groups-v1', value => z.boolean().parse(value));
export const sessionInfoDisclosuresState = createPersistentUiState('session-info-disclosures-v1', value => z.boolean().parse(value));
const DisclosureRecordSchema = z.record(z.string(), z.boolean());

let retainedListKeysMigrated = false;
subscribePersistenceStorageCleared(() => { retainedListKeysMigrated = false; });

/** Native MMKV could retain pre-fix list keys that web refused. Copy before removing their source. */
export function migrateRetainedSessionListCollapseKeys(): void {
    if (retainedListKeysMigrated) return;
    const prefix = 'ui-state:collapsed-groups-v1:';
    let keys: string[];
    try { keys = getPersistenceStorage().getAllKeys(); }
    catch (error) { throw new UiStatePersistenceError(error); }
    for (const storedKey of keys) {
        if (!storedKey.startsWith(prefix)) continue;
        const key = storedKey.slice(prefix.length);
        const destination = migrateSessionListCollapseKey(key);
        if (destination === key) continue;
        const value = collapsedGroupsState.readStrict(key);
        if (value === undefined) continue;
        if (collapsedGroupsState.readStrict(destination) === undefined) collapsedGroupsState.set(destination, value);
        collapsedGroupsState.remove(key);
    }
    retainedListKeysMigrated = true;
}

export function useCollapsedGroupKeys(selection: string | readonly string[]): Readonly<Record<string, boolean>> {
    const selectionIdentity = JSON.stringify(selection);
    const observation = useMemo(() => collapsedGroupsState.observe(selection), [selectionIdentity]);
    return useSyncExternalStore(observation.subscribe, observation.read, observation.read);
}

export function useSessionInfoSectionExpanded(key: string): boolean | undefined {
    return usePersistentUiStateValue(sessionInfoDisclosuresState, key);
}

/** The existing Settings Action replaces the complete map; mounted folds change a single key. */
export function replaceCollapsedGroupKeys(keys: Readonly<Record<string, boolean>>): void {
    completeLegacyDisclosureImportBeforeRemoval();
    keys = Object.fromEntries(Object.entries(keys).map(([key, value]) => [migrateSessionListCollapseKey(key), value]));
    for (const key of Object.keys(collapsedGroupsState.readAll())) {
        if (!Object.hasOwn(keys, key)) collapsedGroupsState.remove(key);
    }
    for (const [key, collapsed] of Object.entries(keys)) collapsedGroupsState.set(key, collapsed);
}

export function removeCollapsedGroupKey(key: string): void {
    completeLegacyDisclosureImportBeforeRemoval();
    collapsedGroupsState.remove(key);
}

/** Called only by the canonical LocalSettings load/save owner, before its legacy schemas parse. */
export function migrateDisclosureUiStateFromSettings(settings: unknown): unknown {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return settings;
    const record = settings as Record<string, unknown>;
    const retained = { ...record };
    for (const [legacyKey, state] of [
        ['collapsedGroupKeysV1', collapsedGroupsState],
        ['sessionInfoExpandedSectionsV1', sessionInfoDisclosuresState],
    ] as const) {
        if (!Object.hasOwn(record, legacyKey)) continue;
        const parsed = DisclosureRecordSchema.safeParse(record[legacyKey]);
        if (!parsed.success) return settings;
        for (const [key, value] of Object.entries(parsed.data)) {
            const destination = legacyKey === 'collapsedGroupKeysV1' ? migrateSessionListCollapseKey(key) : key;
            if (state.readStrict(destination) === undefined) state.set(destination, value);
        }
        delete retained[legacyKey];
    }
    return Object.hasOwn(record, 'collapsedGroupKeysV1') || Object.hasOwn(record, 'sessionInfoExpandedSectionsV1') ? retained : settings;
}
