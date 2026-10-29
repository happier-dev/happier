import type { ThemeProfilesLocalStateV1 } from '@/theme/profiles/themeProfileTypes';
import { areAccountSettingsJsonValuesEqual } from '../domains/settings/accountSettingsStructuralEquality';
import { canUseLegacyThemeProfiles, createThemeProfileMigrationEdits, encodeThemeProfileSelection, rebaseThemeProfileUiChange, resolveAccountThemeProfileView, type ThemeProfileView } from '../domains/settings/themeProfiles';
import { loadPendingAccountSettingsState } from '../domains/state/accountSettingsPersistence';
import React from 'react';

import type { LocalSettings } from '../domains/settings/localSettings';
import type { Settings } from '../domains/settings/settings';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import type { SettingsAnalyticsSource } from '@/track/settingsAnalytics/types';
import { getStorage } from '@/sync/domains/state/storageStore';

export function applyLocalSettingsFromUi(delta: Partial<LocalSettings>): void {
  getStorage().getState().applyLocalSettings(delta, { source: 'ui' satisfies SettingsAnalyticsSource });
}

export function useApplySettings(): (delta: Partial<Settings>) => void {
  return React.useCallback((delta: Partial<Settings>) => {
    getSyncSingleton().applySettings(delta, { source: 'ui' satisfies SettingsAnalyticsSource });
  }, []);
}

export function applySystemSettings(delta: Partial<Settings>): void {
  getSyncSingleton().applySettings(delta, { source: 'system' satisfies SettingsAnalyticsSource });
}

export function useApplyLocalSettings(): (delta: Partial<LocalSettings>) => void {
  return React.useCallback((delta: Partial<LocalSettings>) => {
    applyLocalSettingsFromUi(delta);
  }, []);
}
function captureThemeProfileView(): ThemeProfileView {
  const state = getStorage().getState();
  const pending = state.settingsScope ? loadPendingAccountSettingsState(state.settingsScope) : null;
  return resolveAccountThemeProfileView({ profiles: state.settings.themeProfiles,
    legacy: state.localSettings.themeProfiles, selection: state.localSettings.themeProfileSelection,
    legacyScope: state.localSettings.themeProfileLegacyAccountScope, scope: state.settingsScope,
    pendingProfiles: pending?.settings.themeProfiles, pendingIntent: pending?.themeProfileMigration });
}

export function applyThemeProfilesFromUi(value: ThemeProfilesLocalStateV1, before: ThemeProfileView): ThemeProfileView {
  const state = getStorage().getState();
  const hasLegacy = canUseLegacyThemeProfiles(state.localSettings.themeProfileLegacyAccountScope, state.settingsScope)
    && state.localSettings.themeProfiles.profiles.length > 0;
  const pending = state.settingsScope ? loadPendingAccountSettingsState(state.settingsScope) : null;
  const view = captureThemeProfileView();
  value = rebaseThemeProfileUiChange(before, value, view);
  if (!state.settingsScope && !state.localSettings.themeProfileLegacyAccountScope) {
    // Before an Account is active, retain the existing device library as migration input.
    applyLocalSettingsFromUi({ themeProfiles: value, themeProfileSelection: null });
    return captureThemeProfileView();
  }
  if (hasLegacy && !state.localSettings.themeProfileLegacyAccountScope && state.settingsScope) {
    applyLocalSettingsFromUi({ themeProfileLegacyAccountScope: state.settingsScope });
  }
  if (!areAccountSettingsJsonValuesEqual(view.state.profiles, value.profiles)) {
    if (!state.settingsScope) throw new Error('An active account is required to change this theme library');
    getSyncSingleton().applySettings({ themeProfiles: value.profiles }, { source: 'ui', durability: 'immediate',
      ...(state.settingsScope && (hasLegacy || pending?.themeProfileMigration)
        ? { themeProfileMigration: { edits: createThemeProfileMigrationEdits(view.state, value, view.legacyProfileIds),
            legacyProfileIds: Object.fromEntries(view.legacyProfileIds),
            representedLegacyProfileIds: Object.fromEntries(view.representedLegacyProfileIds) } } : {}),
    });
  }
  const selection = encodeThemeProfileSelection(value, view.legacyProfileIds);
  if (!areAccountSettingsJsonValuesEqual(state.localSettings.themeProfileSelection, selection)) {
    applyLocalSettingsFromUi({
      themeProfileSelection: selection,
    });
  }
  return captureThemeProfileView();
}
