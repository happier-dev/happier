import React from 'react';

import type { LocalSettings } from '../domains/settings/localSettings';
import type { Settings } from '../domains/settings/settings';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import type { SettingsAnalyticsSource } from '@/track/settingsAnalytics/types';
import { getStorage } from '@/sync/domains/state/storageStore';

function applyLocalSettingsFromStore(delta: Partial<LocalSettings>, source: SettingsAnalyticsSource): void {
  getStorage().getState().applyLocalSettings(delta, { source });
}

export function useApplySettings(): (delta: Partial<Settings>) => void {
  return React.useCallback((delta: Partial<Settings>) => {
    getSyncSingleton().applySettings(delta, { source: 'ui' satisfies SettingsAnalyticsSource });
  }, []);
}

export function useApplyLocalSettings(): (delta: Partial<LocalSettings>) => void {
  return React.useCallback((delta: Partial<LocalSettings>) => {
    applyLocalSettingsFromStore(delta, 'ui');
  }, []);
}
