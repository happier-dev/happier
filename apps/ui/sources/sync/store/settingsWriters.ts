import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { LocalSettings } from '../domains/settings/localSettings';
import type {
  Settings,
  SettingsWriteDelta,
} from '../domains/settings/settings';
import { settingsDefaults, settingsParse } from '../domains/settings/settings';
import type { VoiceSettings } from '../domains/settings/voiceSettings';
import { normalizeVoiceSettingsLocalDelta } from '../domains/settings/voiceSettingsPersistence';
import { rebaseVoiceSettingsEdit, voiceSettingsEditRegistry } from '@/voice/settings/voiceSettingsEdit';
import { captureConversationLanguagePreferenceOwner } from '@/voice/settings/language/conversationLanguage';
import type { AiLaunchProfile } from '@happier-dev/protocol/profiles/read';
import type { ProfileLegacyCloneSourceV1, ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import type { ProfileBuiltinEnabledResultV1, ProfileOperationResult, ProfileRemovalResult } from '@happier-dev/protocol/profiles/profileOperations';
import type {
  CurrentSessionAuthoringSelectionsRuntimeProjection,
} from '../domains/settings/sessionAuthoringSelectionPersistence';
import {
  replayFavoriteModelSelectionReplacementIntent,
} from '../domains/settings/sessionAuthoringSelectionPersistence';
import type { AuthoringMemory } from './domains/authoringMemory';
import type { AuthoringMemoryDelta } from '@/sync/engine/authoringMemory/authoringMemorySync';
import { createUiProfileOperations } from '@/sync/ops/profiles/createUiProfileOperations';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
  applySessionReminderPresetIntentToAccountSettings,
  type SessionReminderPresetIntent,
} from '../domains/session/organization/sessionReminderPreset';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import type { SettingsAnalyticsSource } from '@/track/settingsAnalytics/types';
import { getStorage } from '@/sync/domains/state/storageStore';
import { requireOneShotAccountSettingsMutationApplied } from '@/sync/engine/settings/syncSettings';
import { areAccountSettingsScopesEqual, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';

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

export type SettingsWrite = SettingsWriteDelta | ((current: Settings) => SettingsWriteDelta | null);

export function useApplySettings(): (change: SettingsWrite) => void {
  const expectedSettingsScope = useAccountSettingsScope();
  return React.useCallback((change: SettingsWrite) => {
    let delta: SettingsWriteDelta;
    if (typeof change === 'function') {
      const current = getStorage().getState();
      if (!(current.settingsScope === null && expectedSettingsScope === null)
        && !areAccountSettingsScopesEqual(expectedSettingsScope, current.settingsScope)) return;
      const next = change(current.settings);
      if (!next) return;
      delta = next;
    } else {
      delta = change;
    }
    getSyncSingleton().applySettings(delta, {
      expectedSettingsScope,
      source: 'ui' satisfies SettingsAnalyticsSource,
    });
  }, [expectedSettingsScope]);
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
  profile: AiLaunchProfile;
  secretBindings?: Readonly<ProfileRecordV1['secretBindings']>;
  expectedRevision?: number | 'absent';
  legacyCloneSource?: ProfileLegacyCloneSourceV1;
  builtinNames?: readonly string[];
}>) => Promise<ProfileOperationResult> {
  const options = useProfileOperationOptions();
  return React.useCallback(async input => options
    ? createUiProfileOperations({ ...options, builtinNames: input.builtinNames }).save(input)
    : { status: 'unavailable', reason: 'profile_account_unavailable' }, [options]);
}

export function useDeleteAiLaunchProfile(): (profileId: string, expectedRevision?: number) => Promise<ProfileRemovalResult> {
  const options = useProfileOperationOptions();
  return React.useCallback(async (profileId: string, expectedRevision?: number) => {
    if (!options) throw new Error('Profile Account is unavailable');
    const result = await createUiProfileOperations(options).remove({ id: profileId, expectedRevision });
    requireUpdatedProfileOperation(result);
    return result;
  }, [options]);
}

function useProfileOperationOptions() {
  const scope = useAccountSettingsScope();
  const lifetime = React.useMemo(() => captureActiveServerAccountScopeLifetime(), [scope]);
  return React.useMemo(() => scope ? { scope, isCurrent: () => Boolean(lifetime?.isCurrent()
    && areAccountSettingsScopesEqual(lifetime.scope, scope)
    && areAccountSettingsScopesEqual(getStorage().getState().settingsScope, scope)) } : null, [scope, lifetime]);
}

export function useProfileOperations() {
  const options = useProfileOperationOptions();
  return React.useMemo(() => options ? createUiProfileOperations(options) : null, [options]);
}

export function requireUpdatedProfileOperation(result: ProfileOperationResult | ProfileBuiltinEnabledResultV1): void {
  if (result.status !== 'updated' && result.status !== 'preference-updated') {
    throw new Error(result.status === 'conflict' ? 'profile_revision_conflict' : result.reason);
  }
}

/** Current bindings belong to one private Profile row, never an Account Settings map. */
export function useApplyProfileSecretBindings(): (input: Readonly<{
  profileId: string;
  secretBindings: Readonly<Record<string, string>>;
  expectedRevision?: number;
}>) => Promise<void> {
  const operations = useProfileOperations();
  return React.useCallback(async input => {
    if (!operations) throw new Error('Profile Account is unavailable');
    requireUpdatedProfileOperation(await operations.setSecretBindings({ id: input.profileId,
      secretBindings: input.secretBindings, expectedRevision: input.expectedRevision }));
  }, [operations]);
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
