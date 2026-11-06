import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { LocalSettings } from '../domains/settings/localSettings';
import type {
  Settings,
  SettingsWriteDelta,
} from '../domains/settings/settings';
import { settingsDefaults, settingsParse } from '../domains/settings/settings';
import type { VoiceSettings } from '../domains/settings/voiceSettings';
import { voiceSettingsEditRegistry } from '@/voice/settings/voiceSettingsEdit';
import { captureConversationLanguagePreferenceOwner } from '@/voice/settings/language/conversationLanguage';
import type { AiLaunchProfile } from '@happier-dev/protocol/profiles/read';
import type { ProfileLegacyCloneSourceV1, ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import type { ProfileBuiltinEnabledResultV1, ProfileOperationResult, ProfileRemovalResult } from '@happier-dev/protocol/profiles/profileOperations';
import type {
  CurrentSessionAuthoringSelectionsRuntimeProjection,
} from '../domains/settings/sessionAuthoringSelectionPersistence';
import { ModelFavoriteMutationV1Schema } from '@happier-dev/protocol/providers/modelFavoritesV1';
import type { AuthoringMemory } from './domains/authoringMemory';
import type { AuthoringMemoryDelta } from '@/sync/engine/authoringMemory/authoringMemorySync';
import { PROFILE_ACTION_OUTPUT_SCHEMAS_V1, type ProfileActionRequestV1 } from '@happier-dev/protocol/profiles/profileActionsV1';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import {
  applySessionReminderPresetIntentToAccountSettings,
  type SessionReminderPresetIntent,
} from '../domains/session/organization/sessionReminderPreset';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import type { SettingsAnalyticsSource } from '@/track/settingsAnalytics/types';
import { getStorage } from '@/sync/domains/state/storageStore';
import { requireOneShotAccountSettingsMutationApplied } from '@/sync/engine/settings/syncSettings';
import { areAccountSettingsScopesEqual, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { BUILT_IN_SETTINGS_DECLARATIONS_V1 } from '@happier-dev/protocol/actions/settings/settingsDeclarations';
import { SettingsDeclarationValueV1Schema } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { useSettingActionWriter } from '@/components/settings/catalog/useSettingActionWriter';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

async function persistAccountSettingsOnce(
  expectedSettingsScope: AccountSettingsScope | null,
  expectedSettingsVersion: number | null,
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

// Only a whole-value binding names the public intent from its storage key. Compound,
// secret and operational owners retain their own ingress rather than guessing an intent.
const directAccountSettingDeclarations = BUILT_IN_SETTINGS_DECLARATIONS_V1.filter(declaration => {
  const binding = declaration.storage;
  return binding?.scope === 'account' && binding.key && !binding.kind && !binding.path && !binding.owner
    && binding.access === 'read_write' && !declaration.sensitive;
});
const directLocalSettingDeclarations = BUILT_IN_SETTINGS_DECLARATIONS_V1.filter(declaration => {
  const binding = declaration.storage;
  return binding?.scope === 'local' && binding.key && !binding.kind && !binding.path && !binding.owner
    && binding.access === 'read_write' && !declaration.sensitive;
});

export function useApplySettings(): (change: SettingsWrite) => void {
  const expectedSettingsScope = useAccountSettingsScope();
  const writeSetting = useSettingActionWriter();
  const apply = React.useCallback(async (change: SettingsWrite) => {
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
    const declaredWrites = (Object.keys(delta) as Array<keyof SettingsWriteDelta>).flatMap(key => {
      // Equivalent declaration aliases share this same whole-value intent.
      const declaration = directAccountSettingDeclarations.find(candidate => candidate.storage?.key === key);
      if (!declaration) return [];
      const stored = delta[key];
      const value = declaration.storage?.invertBoolean && typeof stored === 'boolean' ? !stored : stored;
      const parsed = SettingsDeclarationValueV1Schema.safeParse(value);
      return parsed.success ? [{ declaration, value: parsed.data }] : [];
    });
    for (const { declaration, value } of declaredWrites) await writeSetting(declaration, value);
  }, [expectedSettingsScope, writeSetting]);
  return React.useCallback((change: SettingsWrite) => {
    const operation = apply(change);
    fireAndForget(operation, { tag: 'settings.apply' });
    return operation;
  }, [apply]);
}

/** Voice editors submit their change, not a stale replacement of the Account-owned profile. */
export function useApplyVoiceSettingsEdit(): (before: VoiceSettings, next: VoiceSettings) => Promise<void> {
  const expectedScope = useAccountSettingsScope();
  const { execute } = useMountedActionExecution(expectedScope);
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
    requireActionSuccess(await execute('settings.set', { anchor: 'voiceConversations.edit', value: null }, {
      retainInvocation: true,
      executorOptions: { voiceSettingsEdit: { before, next, isLanguageOwnerCurrent: languageOwnerIsCurrent } },
    }));
  }, [execute, expectedScope, languageOwnerIsCurrent]);
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
    await persistAccountSettingsOnce(expectedScope, current.settingsVersion, (raw) => (
      applySessionReminderPresetIntentToAccountSettings(raw, intent)
    ));
  }, [expectedScope]);
}

export type ProfileActionExecutionOptions = Readonly<{
  onApprovalPending?: (registration: ActionApprovalContinuation) => void;
}>;

export function useApplyProfileSave(options?: ProfileActionExecutionOptions): (input: Readonly<{
  profile: AiLaunchProfile;
  secretBindings?: Readonly<ProfileRecordV1['secretBindings']>;
  expectedRevision?: number | 'absent';
  legacyCloneSource?: ProfileLegacyCloneSourceV1;
  builtinNames?: readonly string[];
  /** Library skills added to sessions with this Profile; sent only when the caller changed them. */
  skillSeeds?: readonly string[];
}>) => Promise<ProfileOperationResult> {
  const execute = useProfileActionExecute(options);
  return React.useCallback(async input => PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.save'].parse(
    await execute({ actionId: 'launch_profiles.save', input: { id: input.profile.id, profile: input.profile,
      expectedRevision: input.expectedRevision ?? input.profile.profileRecordRevision ?? 'absent',
      ...(input.secretBindings ? { secretBindings: { ...input.secretBindings } } : {}),
      ...(input.skillSeeds ? { skillSeeds: [...input.skillSeeds] } : {}),
      ...(input.legacyCloneSource ? { legacyCloneSource: input.legacyCloneSource } : {}),
      ...(input.profile.revision ? { expectedArtifactRevision: input.profile.revision } : {}),
    } })), [execute]);
}

/** One thin mounted ingress; Profile decisions remain in the admitted domain owner. */
export function useProfileActionExecute(options?: ProfileActionExecutionOptions) {
  const scope = useAccountSettingsScope();
  const { execute } = useMountedActionExecution(scope, options);
  return React.useCallback(async (request: ProfileActionRequestV1): Promise<unknown> => {
    const result = await execute(request.actionId, request.input);
    if (!result.ok) throw Object.assign(new Error(result.errorCode), { code: result.errorCode, result });
    return result.result;
  }, [execute]);
}

/** Favorite callers retain their Settings projection; each changed id is an admitted semantic intent. */
export function useProfileFavoriteIdsMutable(): [Settings['favoriteProfiles'],
  (value: Settings['favoriteProfiles'] | ((current: Settings['favoriteProfiles']) => Settings['favoriteProfiles'] | null)) => Promise<void>] {
  const favorites = getStorage()(state => state.settings.favoriteProfiles);
  const execute = useProfileActionExecute();
  const replace = React.useCallback(async (value: Settings['favoriteProfiles'] | ((current: Settings['favoriteProfiles']) => Settings['favoriteProfiles'] | null)) => {
    const next = typeof value === 'function' ? value(favorites) : value;
    if (next === null) return;
    const before = new Set(favorites);
    const after = new Set(next);
    for (const id of new Set([...before, ...after])) {
      if (before.has(id) === after.has(id)) continue;
      const result = PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.favorite.set'].parse(
        await execute({ actionId: 'launch_profiles.favorite.set', input: { id, favorite: after.has(id) } }));
      if (result.status !== 'updated') throw new Error(result.status === 'conflict' ? 'profile_revision_conflict' : result.reason);
    }
  }, [execute, favorites]);
  return [favorites, replace];
}

export function useDeleteAiLaunchProfile(options?: ProfileActionExecutionOptions): (profileId: string, expectedRevision?: number) => Promise<ProfileRemovalResult> {
  const execute = useProfileActionExecute(options);
  return React.useCallback(async (profileId: string, expectedRevision?: number) => {
    if (expectedRevision === undefined) throw new Error('profile_review_unavailable');
    const result = PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.delete'].parse(
      await execute({ actionId: 'launch_profiles.delete', input: { id: profileId, expectedRevision } }));
    requireUpdatedProfileOperation(result);
    return result;
  }, [execute]);
}

export function requireUpdatedProfileOperation(result: ProfileOperationResult | ProfileBuiltinEnabledResultV1): void {
  if (result.status !== 'updated' && result.status !== 'preference-updated') {
    throw new Error(result.status === 'conflict' ? 'profile_revision_conflict' : result.reason);
  }
}

/**
 * Apply a typed Favorite replacement against the explicitly observed Account
 * Settings scope. Each changed membership enters the canonical favorite
 * Action, whose Account CAS preserves opaque and unrelated favorites.
 */
export function useApplyFavoriteModelSelectionReplacementIntent(): (
  input: Readonly<{
    base: CurrentSessionAuthoringSelectionsRuntimeProjection['currentFavoriteModelSelectionsV1'];
    proposed: CurrentSessionAuthoringSelectionsRuntimeProjection['currentFavoriteModelSelectionsV1'];
  }>,
) => Promise<void> {
  const scope = useAccountSettingsScope();
  const { execute } = useMountedActionExecution(scope);
  return React.useCallback(async (input) => {
    const key = (value: typeof input.base[number]) => JSON.stringify(value.selection.ref);
    const before = new Set(input.base.map(key));
    const after = new Set(input.proposed.map(key));
    for (const selection of input.base.filter(value => !after.has(key(value)))) {
      const result = await execute('models.favorite.set', ModelFavoriteMutationV1Schema.parse({ selection, favorite: false }));
      if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
    }
    for (const selection of input.proposed.filter(value => !before.has(key(value)))) {
      const result = await execute('models.favorite.set', ModelFavoriteMutationV1Schema.parse({ selection, favorite: true }));
      if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
    }
  }, [execute]);
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
  const writeSetting = useSettingActionWriter();
  const apply = React.useCallback(async (delta: Partial<LocalSettings>) => {
    const declaredWrites = (Object.keys(delta) as Array<keyof LocalSettings>).flatMap(key => {
      const declaration = directLocalSettingDeclarations.find(candidate => candidate.storage?.key === key);
      if (!declaration) return [];
      const stored = delta[key];
      const value = declaration.storage?.invertBoolean && typeof stored === 'boolean' ? !stored : stored;
      const parsed = SettingsDeclarationValueV1Schema.safeParse(value);
      return parsed.success ? [{ declaration, value: parsed.data }] : [];
    });
    for (const { declaration, value } of declaredWrites) await writeSetting(declaration, value);
  }, [writeSetting]);
  return React.useCallback((delta: Partial<LocalSettings>) => {
    const operation = apply(delta);
    fireAndForget(operation, { tag: 'settings.local.apply' });
    return operation;
  }, [apply]);
}
