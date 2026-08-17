import React from 'react';

import type { LocalSettings } from '../domains/settings/localSettings';
import type {
  AccountSettingsWriteDelta,
  SettingsWriteDelta,
} from '../domains/settings/settings';
import type { RetainedSecretBindingsByProfileId } from '../domains/settings/secretBindings';
import type {
  CurrentSessionAuthoringSelectionsRuntimeProjection,
} from '../domains/settings/sessionAuthoringSelectionPersistence';
import {
  replayFavoriteModelSelectionReplacementIntent,
  replayRememberedEngineSelectionReplacementIntent,
} from '../domains/settings/sessionAuthoringSelectionPersistence';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import type { SettingsAnalyticsSource } from '@/track/settingsAnalytics/types';
import { getStorage } from '@/sync/domains/state/storageStore';

function applyLocalSettingsFromStore(delta: Partial<LocalSettings>, source: SettingsAnalyticsSource): void {
  getStorage().getState().applyLocalSettings(delta, { source });
}

export function applyLocalSettingsFromDesktopMcpBridge(delta: Partial<LocalSettings>): void {
  applyLocalSettingsFromStore(delta, 'ui');
}

export function useApplySettings(): (delta: SettingsWriteDelta) => void {
  return React.useCallback((delta: SettingsWriteDelta) => {
    getSyncSingleton().applySettings(delta, { source: 'ui' satisfies SettingsAnalyticsSource });
  }, []);
}

/**
 * The public Settings facade deliberately omits the raw Protocol carrier.
 * This is the single persistence-facing writer that can submit it after the
 * current-map editor merged its update with retained opaque entries.
 */
export function useApplyRetainedSecretBindingsByProfileId(): (
  bindings: RetainedSecretBindingsByProfileId,
) => void {
  return React.useCallback((secretBindingsByProfileId: RetainedSecretBindingsByProfileId) => {
    const delta: AccountSettingsWriteDelta = { secretBindingsByProfileId };
    getSyncSingleton().applySettings(
      delta,
      { source: 'ui' satisfies SettingsAnalyticsSource },
    );
  }, []);
}

/**
 * Apply a typed Favorite replacement through the canonical functional Account
 * Settings mutation. The callback is replayed over every CAS winner, so a
 * rendered raw carrier can never overwrite concurrent opaque entries.
 */
export function useApplyFavoriteModelSelectionReplacementIntent(): (
  input: Readonly<{
    base: CurrentSessionAuthoringSelectionsRuntimeProjection['currentFavoriteModelSelectionsV1'];
    proposed: CurrentSessionAuthoringSelectionsRuntimeProjection['currentFavoriteModelSelectionsV1'];
  }>,
) => Promise<void> {
  return React.useCallback(async (input) => {
    await getSyncSingleton().mutateAccountSettings((raw) => (
      replayFavoriteModelSelectionReplacementIntent({ raw, ...input })
    ));
  }, []);
}

/**
 * Apply a typed remembered-selection replacement through the same functional
 * Account Settings owner. An opaque winner scope remains unowned by this UI.
 */
export function useApplyRememberedEngineSelectionReplacementIntent(): (
  input: Readonly<{
    base: CurrentSessionAuthoringSelectionsRuntimeProjection['currentRememberedEngineSelectionsByScopeV1'];
    proposed: CurrentSessionAuthoringSelectionsRuntimeProjection['currentRememberedEngineSelectionsByScopeV1'];
  }>,
) => Promise<void> {
  return React.useCallback(async (input) => {
    await getSyncSingleton().mutateAccountSettings((raw) => (
      replayRememberedEngineSelectionReplacementIntent({ raw, ...input })
    ));
  }, []);
}

export function useApplyLocalSettings(): (delta: Partial<LocalSettings>) => void {
  return React.useCallback((delta: Partial<LocalSettings>) => {
    applyLocalSettingsFromStore(delta, 'ui');
  }, []);
}
