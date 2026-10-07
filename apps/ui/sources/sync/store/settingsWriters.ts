import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { LocalSettings } from '../domains/settings/localSettings';
import type {
  AccountSettingsWriteDelta,
  Settings,
  SettingsWriteDelta,
} from '../domains/settings/settings';
import { settingsDefaults, settingsParse } from '../domains/settings/settings';
import type { VoiceSettings } from '../domains/settings/voiceSettings';
import { normalizeVoiceSettingsLocalDelta } from '../domains/settings/voiceSettingsPersistence';
import { rebaseVoiceSettingsEdit, voiceSettingsEditRegistry } from '@/voice/settings/voiceSettingsEdit';
import { captureConversationLanguagePreferenceOwner } from '@/voice/settings/language/conversationLanguage';
import {
  mergeCurrentSecretBindingsIntoRawBindings,
  readRetainedSecretBindingsByProfileId,
  type RetainedSecretBindingsByProfileId,
} from '../domains/settings/secretBindings';
import type {
  CurrentSessionAuthoringSelectionsRuntimeProjection,
} from '../domains/settings/sessionAuthoringSelectionPersistence';
import {
  replayFavoriteModelSelectionReplacementIntent,
} from '../domains/settings/sessionAuthoringSelectionPersistence';
import type { AuthoringMemory } from './domains/authoringMemory';
import type { AuthoringMemoryDelta } from '@/sync/engine/authoringMemory/authoringMemorySync';
import { removeAiLaunchProfileFromAccountSettings } from '../domains/profiles/aiLaunchProfileCollection';
import {
  applySessionReminderPresetIntentToAccountSettings,
  type SessionReminderPresetIntent,
} from '../domains/session/organization/sessionReminderPreset';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import type { SettingsAnalyticsSource } from '@/track/settingsAnalytics/types';
import { getStorage } from '@/sync/domains/state/storageStore';
import { requireOneShotAccountSettingsMutationApplied } from '@/sync/engine/settings/syncSettings';
import { areAccountSettingsScopesEqual, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { writeConnectedAccountPurposeDefault } from '@happier-dev/protocol/account/settings/connected-services';
import type { QualifiedConnectedAccountPurposeV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeIdentity';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';

function requireSettingsVersion(settingsVersion: number | null): number {
  if (settingsVersion === null) throw new Error('Account settings version is unavailable');
  return settingsVersion;
}

async function persistAccountSettingsOnce(
  expectedSettingsScope: AccountSettingsScope | null,
  expectedSettingsVersion: number,
  mutate: (raw: Readonly<Record<string, unknown>>) => Record<string, unknown>,
): Promise<void> {
  requireOneShotAccountSettingsMutationApplied(
    await getSyncSingleton().mutateAccountSettingsOnce({
      expectedSettingsScope,
      expectedSettingsVersion,
      rebaseOnConflict: true,
      mutate: (raw) => ({ settings: mutate(raw), value: undefined }),
    }),
  );
}

function applyLocalSettingsFromStore(delta: Partial<LocalSettings>, source: SettingsAnalyticsSource): void {
  getStorage().getState().applyLocalSettings(delta, { source });
}

export function applyLocalSettingsFromDesktopMcpBridge(delta: Partial<LocalSettings>): void {
  applyLocalSettingsFromStore(delta, 'ui');
}

export function useAccountSettingsScope(): AccountSettingsScope | null {
  return getStorage()((state) => state.settingsScope);
}

function useAccountSettingsMutationSnapshot(): Readonly<{
  scope: AccountSettingsScope | null;
  version: number | null;
}> {
  return getStorage()(useShallow((state) => ({
    scope: state.settingsScope,
    version: state.settingsVersion,
  })));
}

export function useApplySettings(): (delta: SettingsWriteDelta) => void {
  const expectedSettingsScope = useAccountSettingsScope();
  return React.useCallback((delta: SettingsWriteDelta) => {
    getSyncSingleton().applySettings(delta, {
      expectedSettingsScope,
      source: 'ui' satisfies SettingsAnalyticsSource,
    });
  }, [expectedSettingsScope]);
}

/** Personal-purpose edits rebase on current Account settings, never replace a modal's stale collection. */
export function useApplyConnectedAccountPurposeTarget(): (input: Readonly<{
  purpose: QualifiedConnectedAccountPurposeV1;
  target: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
  isCurrent(): boolean;
}>) => Promise<void> {
  const expectedScope = useAccountSettingsScope();
  return React.useCallback(async (input) => {
    const current = getStorage().getState();
    const assertCurrent = () => {
      if (!expectedScope || !areAccountSettingsScopesEqual(expectedScope, getStorage().getState().settingsScope)
        || !input.isCurrent()) throw new Error('Connected Account purpose is no longer current');
    };
    assertCurrent();
    await persistAccountSettingsOnce(expectedScope, requireSettingsVersion(current.settingsVersion), (raw) => {
      assertCurrent();
      return { ...raw, ...writeConnectedAccountPurposeDefault({ settings: settingsParse(raw),
        purpose: input.purpose, target: input.target }) };
    });
  }, [expectedScope]);
}

/** Voice editors submit their change, not a stale replacement of the Account-owned profile. */
export function useApplyVoiceSettingsEdit(): (before: VoiceSettings, next: VoiceSettings) => Promise<void> {
  const expectedScope = useAccountSettingsScope();
  const providerId = getStorage()((state) => state.settings.voice.providerId);
  const registryRevision = React.useSyncExternalStore(
    voiceSettingsEditRegistry.subscribe ?? (() => () => {}),
    voiceSettingsEditRegistry.getRevision ?? (() => 0),
    voiceSettingsEditRegistry.getRevision ?? (() => 0),
  );
  const languageOwnerIsCurrent = React.useMemo(
    () => captureConversationLanguagePreferenceOwner(providerId, voiceSettingsEditRegistry),
    [providerId, registryRevision],
  );
  return React.useCallback(async (before: VoiceSettings, next: VoiceSettings) => {
    const current = getStorage().getState();
    if (!expectedScope || !areAccountSettingsScopesEqual(expectedScope, current.settingsScope)) {
      throw new Error('Account settings scope changed');
    }
    await persistAccountSettingsOnce(expectedScope, requireSettingsVersion(current.settingsVersion), (raw) => {
      const settings = settingsParse(raw);
      if (before.assistantLanguage !== next.assistantLanguage && !languageOwnerIsCurrent(settings.voice)) {
        throw new Error('voice_settings_provider_changed');
      }
      const voice = rebaseVoiceSettingsEdit(settings.voice, before, next);
      return { ...raw, ...normalizeVoiceSettingsLocalDelta({ voice }, settings) };
    });
  }, [expectedScope, languageOwnerIsCurrent]);
}

export function useApplyAuthoringMemoryDelta(): (delta: AuthoringMemoryDelta) => Promise<void> {
  const expectedSettingsScope = useAccountSettingsScope();
  return React.useCallback(async (delta: AuthoringMemoryDelta) => {
    await getSyncSingleton().applyAuthoringMemoryDelta(delta, { expectedSettingsScope });
  }, [expectedSettingsScope]);
}

/**
 * Reminder-preset edits apply as an intent through the existing one-shot Account-settings write, so
 * the list the user ends up with is the current one plus their change — never a whole array
 * captured before a modal and a network round trip.
 */
export function useApplySessionReminderPresetIntent(): (intent: SessionReminderPresetIntent) => Promise<void> {
  const expectedScope = useAccountSettingsScope();
  return React.useCallback(async (intent: SessionReminderPresetIntent) => {
    // The modal retains its Account, not the revision from before it opened. The semantic intent
    // is applied to the canonical writer's current raw settings; replacement guards its own baseline.
    const current = getStorage().getState();
    if (!expectedScope || !areAccountSettingsScopesEqual(expectedScope, current.settingsScope)) {
      throw new Error('Account settings scope changed before saving reminder presets');
    }
    await persistAccountSettingsOnce(expectedScope, requireSettingsVersion(current.settingsVersion), (raw) => (
      applySessionReminderPresetIntentToAccountSettings(raw, intent)
    ));
  }, [expectedScope]);
}

export function useApplyProfileSave(): (input: Readonly<{
  profiles: Settings['profiles'];
  profileId: string;
  secretBindings?: Readonly<Record<string, string>>;
}>) => void {
  const applySettings = useApplySettings();
  return React.useCallback((input) => {
    const settings = getStorage().getState().settings ?? settingsDefaults;
    const delta: AccountSettingsWriteDelta = input.secretBindings === undefined
      ? { profiles: input.profiles }
      : {
        profiles: input.profiles,
        secretBindingsByProfileId: mergeProfileSecretBindings({
          settings,
          profileId: input.profileId,
          secretBindings: input.secretBindings,
        }),
      };
    applySettings(delta);
  }, [applySettings]);
}

export function useDeleteAiLaunchProfile(): (profileId: string) => Promise<void> {
  const settingsSnapshot = useAccountSettingsMutationSnapshot();
  return React.useCallback(async (profileId: string) => {
    await persistAccountSettingsOnce(settingsSnapshot.scope, requireSettingsVersion(settingsSnapshot.version), (raw) => (
      removeAiLaunchProfileFromAccountSettings(raw, profileId)
    ));
    const current = getStorage().getState();
    if (areAccountSettingsScopesEqual(current.settingsScope, settingsSnapshot.scope)
      && current.authoringMemory.lastUsedProfile === profileId) {
      await getSyncSingleton().applyAuthoringMemoryDelta({
        lastUsedProfileReplacement: { base: profileId, proposed: null },
      }, { expectedSettingsScope: settingsSnapshot.scope });
    }
  }, [settingsSnapshot]);
}

/**
 * Merge one profile's edited current bindings back into the retained Protocol
 * carrier. Clearing every entry removes the profile from the current map so
 * the merge drops it, while opaque entries this UI never rendered survive.
 */
function mergeProfileSecretBindings(input: Readonly<{
  settings: Settings;
  profileId: string;
  secretBindings: Readonly<Record<string, string>>;
}>): RetainedSecretBindingsByProfileId {
  const currentBindings = input.settings.currentSecretBindingsByProfileId;
  const nextBindings = { ...currentBindings };
  if (Object.keys(input.secretBindings).length === 0) {
    delete nextBindings[input.profileId];
  } else {
    nextBindings[input.profileId] = { ...input.secretBindings };
  }
  return mergeCurrentSecretBindingsIntoRawBindings({
    rawBindings: readRetainedSecretBindingsByProfileId(input.settings),
    currentBindings,
    nextBindings,
  });
}

/**
 * The public Settings facade deliberately omits the raw Protocol carrier.
 * This is the single persistence-facing writer that can submit it after the
 * current-map editor merged its update with retained opaque entries.
 */
export function useApplyRetainedSecretBindingsByProfileId(): (
  bindings: RetainedSecretBindingsByProfileId,
) => void {
  const applySettings = useApplySettings();
  return React.useCallback((secretBindingsByProfileId: RetainedSecretBindingsByProfileId) => {
    const delta: AccountSettingsWriteDelta = { secretBindingsByProfileId };
    applySettings(delta);
  }, [applySettings]);
}

/**
 * Apply a typed Favorite replacement against the explicitly observed Account
 * Settings version. The reducer preserves opaque entries in the observed
 * carrier, and the canonical writer rebases the deterministic intent if a
 * concurrent field-level write wins the CAS.
 */
export function useApplyFavoriteModelSelectionReplacementIntent(): (
  input: Readonly<{
    base: CurrentSessionAuthoringSelectionsRuntimeProjection['currentFavoriteModelSelectionsV1'];
    proposed: CurrentSessionAuthoringSelectionsRuntimeProjection['currentFavoriteModelSelectionsV1'];
  }>,
) => Promise<void> {
  const settingsSnapshot = useAccountSettingsMutationSnapshot();
  return React.useCallback(async (input) => {
    await persistAccountSettingsOnce(settingsSnapshot.scope, requireSettingsVersion(settingsSnapshot.version), (raw) => (
      replayFavoriteModelSelectionReplacementIntent({ raw, ...input })
    ));
  }, [settingsSnapshot]);
}

/**
 * Apply a typed remembered-selection intent through the per-scope row CAS owner.
 * Opaque scope carriers remain unowned by this UI.
 */
export function useApplyRememberedEngineSelectionReplacementIntent(): (
  input: Readonly<{
    base: AuthoringMemory['currentRememberedEngineSelectionsByScopeV1'];
    proposed: AuthoringMemory['currentRememberedEngineSelectionsByScopeV1'];
  }>,
) => Promise<void> {
  const applyAuthoringMemory = useApplyAuthoringMemoryDelta();
  return React.useCallback(async (input) => {
    await applyAuthoringMemory({ rememberedEngineSelectionReplacement: input });
  }, [applyAuthoringMemory]);
}

export function useApplyLocalSettings(): (delta: Partial<LocalSettings>) => void {
  return React.useCallback((delta: Partial<LocalSettings>) => {
    applyLocalSettingsFromStore(delta, 'ui');
  }, []);
}
