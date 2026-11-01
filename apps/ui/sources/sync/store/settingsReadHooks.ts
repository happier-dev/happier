import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { shallow } from 'zustand/shallow';

import type { LocalSettings } from '../domains/settings/localSettings';
import { settingsDefaults, type Settings } from '../domains/settings/settings';
import { getStorage } from '../domains/state/storageStore';
import type { StorageState } from './types';

// Shared presentation reads the existing store without importing command hooks.
export function useSettings(): Settings {
  return getStorage()(useShallow((state) => state.settings ?? settingsDefaults));
}

/** The store owner routes Settings demand before running the consumer projection. */
export function useSettingsSelector<T>(selector: (settings: Settings) => T, keys?: readonly string[]): T {
  const stableKeys = useShallow((value: readonly string[] | undefined) => value)(keys);
  const scope = React.useMemo(() => stableKeys ? { settings: stableKeys } : undefined, [stableKeys]);
  const select = React.useCallback((state: StorageState) => {
    // Account replacement is an input even when its selected preference is equal.
    void state.settingsScope;
    return selector(state.settings ?? settingsDefaults);
  }, [selector]);
  return getStorage()(select, scope, shallow);
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

export function useSetting<K extends keyof Settings>(name: K): Settings[K] {
  return getStorage()(useShallow((state) => state.settings?.[name] ?? settingsDefaults[name]));
}

export function useLocalSettings(): LocalSettings {
  return getStorage()(useShallow((state) => state.localSettings));
}

export function useLocalSetting<K extends keyof LocalSettings>(name: K): LocalSettings[K] {
  return getStorage()(useShallow((state) => state.localSettings[name]));
}
