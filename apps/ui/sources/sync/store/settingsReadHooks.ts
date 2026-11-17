import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { shallow } from 'zustand/shallow';
import { useStoreWithEqualityFn } from 'zustand/traditional';

import type { LocalSettings } from '../domains/settings/localSettings';
import { settingsDefaults, type Settings } from '../domains/settings/settings';
import { getStorage } from '../domains/state/storageStore';
import type { StorageSubscriptionScope } from '../domains/state/storageSubscriptions';
import type { StorageState } from './types';
import { settingsPreviewScopeMatches, useLocalSettingPreviewValue, useSettingsPreviewStore } from './settingsPreview';

// Shared presentation reads the existing store without importing command hooks.
export function useSettings(): Settings {
  return getStorage()(useShallow((state) => state.settings ?? settingsDefaults));
}

/** Explicit consumed keys route demand before projection; true opts dynamic callbacks into the whole snapshot. */
export function useSettingsSelector<T>(selector: (settings: Settings) => T, keys: readonly string[] | true): T {
  const stableKeys = useShallow((value: readonly string[] | true) => value)(keys);
  const source = React.useMemo(() => {
    const storage = getStorage();
    const read = () => {
      const state = storage.getState();
      return [state.settings ?? settingsDefaults, state.settingsScope, useSettingsPreviewStore.getState()] as const;
    };
    let snapshot = read();
    const getState = () => {
      const next = read();
      if (next[0] !== snapshot[0] || next[1] !== snapshot[1] || next[2] !== snapshot[2]) snapshot = next;
      return snapshot;
    };
    return {
      getState,
      getInitialState: getState,
      subscribe(listener: (state: typeof snapshot, previous: typeof snapshot) => void) {
        const notify = () => { const previous = snapshot; listener(getState(), previous); };
        const stopStorage = storage.subscribe(notify, { settings: stableKeys, settingsScope: true });
        const stopPreview = useSettingsPreviewStore.subscribe((state, previous) => {
          const scope = storage.getState().settingsScope;
          const account = settingsPreviewScopeMatches(scope, state.scope) ? state.account : undefined;
          const previousAccount = settingsPreviewScopeMatches(scope, previous.scope) ? previous.account : undefined;
          if (stableKeys !== true
            ? stableKeys.some(key => account?.[key as keyof Settings] !== previousAccount?.[key as keyof Settings])
            : !shallow(account ?? {}, previousAccount ?? {})) notify();
        });
        return () => { stopStorage(); stopPreview(); };
      },
    };
  }, [stableKeys]);
  const select = React.useCallback(([settings, scope, preview]: ReturnType<typeof source.getState>) => {
    const held = settingsPreviewScopeMatches(scope, preview.scope)
      ? Object.fromEntries(Object.entries(preview.account).map(([key, entry]) => [key, entry?.value])) : {};
    return selector(Object.keys(held).length ? { ...settings, ...held } : settings);
  }, [selector]);
  return useStoreWithEqualityFn(source, select, shallow);
}

/** A consumed-key view, including opaque released plugin-owned Account carriers. */
export function useSettingsValues<K extends string>(keys: readonly K[]): Readonly<Pick<Settings, Extract<K, keyof Settings>>> & Readonly<Record<string, unknown>> {
  const stableKeys = useShallow((value: readonly K[]) => value)(keys);
  const select = React.useCallback((settings: Settings) => Object.fromEntries(
    stableKeys.map(key => [key, (settings as Readonly<Record<string, unknown>>)[key]]),
  ) as Readonly<Pick<Settings, Extract<K, keyof Settings>>> & Readonly<Record<string, unknown>>, [stableKeys]);
  return useSettingsSelector(select, stableKeys);
}

export function useSettingsVersion(): number | null {
  return getStorage()((state) => state.settingsVersion);
}

/** Readiness consumers do not need every accepted Account settings revision. */
export function useSettingsReady(): boolean {
  return getStorage()((state) => state.settingsVersion !== null);
}

const selectSettingsScope = (state: StorageState) => state.settingsScope;

type SettingRead = Readonly<{
  select: (state: StorageState) => unknown;
  scope: StorageSubscriptionScope;
}>;

const settingReads = new Map<keyof Settings, SettingRead>();

/**
 * One selector and demand scope per Setting name, so a consumer's rerender over an unchanged store reuses its
 * selection instead of re-running the tracked store read (the selector and scope are store-read cache inputs).
 */
function settingRead(name: keyof Settings): SettingRead {
  let read = settingReads.get(name);
  if (!read) {
    read = Object.freeze({
      select: (state: StorageState) => state.settings?.[name] ?? settingsDefaults[name],
      scope: Object.freeze({ settings: Object.freeze([name]) }),
    });
    settingReads.set(name, read);
  }
  return read;
}

export function useSetting<K extends keyof Settings>(name: K): Settings[K] {
  const scope = getStorage()(selectSettingsScope);
  const preview = useSettingsPreviewStore(state => settingsPreviewScopeMatches(scope, state.scope) ? state.account[name] : undefined);
  const read = settingRead(name);
  const value = getStorage()(read.select, read.scope, shallow) as Settings[K];
  return preview ? preview.value : value;
}

export function useLocalSettings(): LocalSettings {
  return getStorage()(useShallow((state) => state.localSettings));
}

export function useLocalSetting<K extends keyof LocalSettings>(name: K, select?: undefined, enabled?: boolean): LocalSettings[K];
export function useLocalSetting<K extends keyof LocalSettings, T>(name: K, select: (value: LocalSettings[K]) => T, enabled?: boolean): T;
export function useLocalSetting<K extends keyof LocalSettings, T>(name: K, select?: (value: LocalSettings[K]) => T, enabled = true): LocalSettings[K] | T {
  const preview = useLocalSettingPreviewValue(name, enabled);
  // Identity-stable unless the name, held preview or caller's projection changes (see `settingRead`).
  const read = React.useCallback((state: StorageState) => {
    const value = preview === undefined ? state.localSettings[name] : preview;
    return select ? select(value) : value;
  }, [name, preview, select]);
  return getStorage()(read, enabled ? localSettingScope(name) : inactiveLocalSettingScope, shallow);
}

const inactiveLocalSettingScope = Object.freeze({ localSettings: Object.freeze([]) }) satisfies StorageSubscriptionScope;
const localSettingScopes = new Map<keyof LocalSettings, StorageSubscriptionScope>();

function localSettingScope(name: keyof LocalSettings): StorageSubscriptionScope {
  let scope = localSettingScopes.get(name);
  if (!scope) {
    scope = Object.freeze({ localSettings: Object.freeze([name]) });
    localSettingScopes.set(name, scope);
  }
  return scope;
}
