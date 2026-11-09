import { useMemo, useSyncExternalStore } from 'react';
import { z } from 'zod/mini';
import { createPersistentUiState, usePersistentUiStateValue } from './persistentUiState';
import { completeLegacyDisclosureImportBeforeRemoval } from './settingsPersistence';

// Preserve the existing device-wide Setup choices and qualified group ids exactly.
// Each interaction writes one record and never publishes a Settings snapshot.
export const collapsedGroupsState = createPersistentUiState('collapsed-groups-v1', value => z.boolean().parse(value));
export const sessionInfoDisclosuresState = createPersistentUiState('session-info-disclosures-v1', value => z.boolean().parse(value));
const DisclosureRecordSchema = z.record(z.string(), z.boolean());

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
    if (!Object.hasOwn(record, 'collapsedGroupKeysV1')) return settings;
    const parsed = DisclosureRecordSchema.safeParse(record.collapsedGroupKeysV1);
    if (!parsed.success) return settings;
    for (const [key, value] of Object.entries(parsed.data)) {
        if (collapsedGroupsState.readStrict(key) === undefined) collapsedGroupsState.set(key, value);
    }
    const { collapsedGroupKeysV1: _legacy, ...retained } = record;
    return retained;
}
