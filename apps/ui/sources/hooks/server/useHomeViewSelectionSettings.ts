import * as React from 'react';

import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import {
    loadEffectiveHomeViewState,
    subscribeEffectiveHomeViewState,
    updateEffectiveHomeViewState,
} from '@/sync/domains/server/selection/homeViewSelectionState';
import { normalizeServerSelectionGroupsForSettings } from '@/sync/domains/server/selection/serverSelectionSettingsAdapter';
import { settingsPreviewScopeMatches, useSettingsPreviewStore } from '@/sync/store/settingsPreview';
import { getStorage } from '@/sync/domains/state/storageStore';

export type HomeViewSelectionSettings = Pick<
    Settings,
    'serverSelectionGroups' | 'serverSelectionActiveTargetKind' | 'serverSelectionActiveTargetId'
>;

const LEGACY_HOME_VIEW_SELECTION_KEYS = ['serverSelectionGroups', 'serverSelectionActiveTargetKind', 'serverSelectionActiveTargetId'] as const;

function readLegacyHomeViewSelectionSetting<K extends typeof LEGACY_HOME_VIEW_SELECTION_KEYS[number]>(
    state: ReturnType<ReturnType<typeof getStorage>['getState']>,
    preview: ReturnType<typeof useSettingsPreviewStore.getState>,
    name: K,
): Settings[K] {
    const held = settingsPreviewScopeMatches(state.settingsScope, preview.scope) ? preview.account[name] : undefined;
    return held ? held.value as Settings[K] : state.settings?.[name] ?? settingsDefaults[name];
}

let lastHomeViewSelection: Readonly<{ inputs: readonly unknown[]; value: HomeViewSelectionSettings }> | null = null;

/**
 * The one projection of the Home-view selection every reader shares. Until the one-time migration
 * writes the device-global Home-view state, the three legacy Account-scoped keys (with any held
 * Settings preview) remain the fallback. The value keeps its identity until one of those inputs moves,
 * so the many mounted readers (feature decisions, header/sidebar connection control, session lists,
 * new-session targeting) share one object instead of each deriving and subscribing on its own.
 */
export function readHomeViewSelectionSettings(): HomeViewSelectionSettings {
    const state = loadEffectiveHomeViewState();
    const storageState = getStorage().getState();
    const preview = useSettingsPreviewStore.getState();
    const inputs = state ? [state] : LEGACY_HOME_VIEW_SELECTION_KEYS.map(name => readLegacyHomeViewSelectionSetting(storageState, preview, name));
    const last = lastHomeViewSelection;
    if (last && last.inputs.length === inputs.length && last.inputs.every((input, index) => input === inputs[index])) return last.value;
    const value: HomeViewSelectionSettings = state
        ? {
            serverSelectionGroups: normalizeServerSelectionGroupsForSettings(state.groups),
            serverSelectionActiveTargetKind: state.activeTargetKind,
            serverSelectionActiveTargetId: state.activeTargetId,
        }
        : {
            serverSelectionGroups: inputs[0] as Settings['serverSelectionGroups'],
            serverSelectionActiveTargetKind: inputs[1] as Settings['serverSelectionActiveTargetKind'],
            serverSelectionActiveTargetId: inputs[2] as Settings['serverSelectionActiveTargetId'],
        };
    lastHomeViewSelection = { inputs, value };
    return value;
}

/** Wakes on every input of `readHomeViewSelectionSettings`: the device view, the legacy keys and their preview. */
export function subscribeHomeViewSelectionSettings(listener: () => void): () => void {
    const storage = getStorage();
    const stopView = subscribeEffectiveHomeViewState(listener);
    const stopStorage = storage.subscribe(listener, { settings: [...LEGACY_HOME_VIEW_SELECTION_KEYS], settingsScope: true });
    const stopPreview = useSettingsPreviewStore.subscribe((next, previous) => {
        if (next.scope !== previous.scope || LEGACY_HOME_VIEW_SELECTION_KEYS.some(name => next.account[name] !== previous.account[name])) listener();
    });
    return () => { stopView(); stopStorage(); stopPreview(); };
}

export function useHomeViewSelectionSettings(): HomeViewSelectionSettings {
    return React.useSyncExternalStore(subscribeHomeViewSelectionSettings, readHomeViewSelectionSettings, readHomeViewSelectionSettings);
}

export function useHomeViewSelectionSettingsMutable(): HomeViewSelectionSettings & Readonly<{
    setHomeViewSelectionSettings: (
        update: HomeViewSelectionSettings | ((current: HomeViewSelectionSettings) => HomeViewSelectionSettings),
        options?: Readonly<{ targetScope?: 'tab' | 'device' }>,
    ) => Promise<void>;
}> {
    const settings = useHomeViewSelectionSettings();
    const setHomeViewSelectionSettings = React.useCallback(async (
        update: HomeViewSelectionSettings | ((current: HomeViewSelectionSettings) => HomeViewSelectionSettings),
        options?: Readonly<{ targetScope?: 'tab' | 'device' }>,
    ) => {
        const saved = await updateEffectiveHomeViewState((current) => {
            const currentSettings: HomeViewSelectionSettings = {
                serverSelectionGroups: normalizeServerSelectionGroupsForSettings(current.groups),
                serverSelectionActiveTargetKind: current.activeTargetKind,
                serverSelectionActiveTargetId: current.activeTargetId,
            };
            const requested = typeof update === 'function' ? update(currentSettings) : update;
            return {
                version: 1,
                groups: requested.serverSelectionGroups,
                activeTargetKind: requested.serverSelectionActiveTargetKind,
                activeTargetId: requested.serverSelectionActiveTargetId,
            };
        }, { scope: options?.targetScope ?? 'device' });
        const projected: HomeViewSelectionSettings = {
            serverSelectionGroups: normalizeServerSelectionGroupsForSettings(saved.groups),
            serverSelectionActiveTargetKind: saved.activeTargetKind,
            serverSelectionActiveTargetId: saved.activeTargetId,
        };
        // Compatibility projection for existing Settings readers only. The Account-scoped
        // settings transport must never become a writer for device-global Home selection.
        getStorage().getState().applySettingsLocal(projected);
    }, []);
    return React.useMemo(() => ({
        ...settings,
        setHomeViewSelectionSettings,
    }), [settings, setHomeViewSelectionSettings]);
}
