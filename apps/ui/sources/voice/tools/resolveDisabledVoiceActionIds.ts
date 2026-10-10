import { isVoiceSdkSafeActionSpec, listVoiceActionBlockSpecs, listVoiceToolActionSpecs, type ActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { isActionEnabledWithSessionMemory } from '@happier-dev/protocol/actions/actionSurfaceAvailability';
import { readSessionMemoryEnabledV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';

import { isActionEnabledInState } from '@/sync/domains/settings/actionsSettings';
import { isInventoryPrivacyAction } from '@/sync/domains/settings/actionSettingsPolicy';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { resolveLocalFeaturePolicyEnabled } from '@/sync/domains/features/featureLocalPolicy';

const CURRENT_UI_CONTEXT_ACTION_IDS: ReadonlySet<ActionId> = new Set<ActionId>([
  'ui.current_context.read',
  'ui.current_context.command.invoke',
]);

export type VoiceActionSessionScope = Readonly<{ sessionMetadata: unknown }>;

export function isCurrentUiContextVoiceAction(actionId: ActionId): boolean {
  return CURRENT_UI_CONTEXT_ACTION_IDS.has(actionId);
}

/**
 * The single Voice Action availability policy. It feeds new provider catalogs
 * and remains usable by retained Local Voice handlers as settings change.
 */
export function isVoiceActionAvailableInState(
  state: Readonly<{ settings?: unknown }>,
  actionId: ActionId,
  scope?: VoiceActionSessionScope,
): boolean {
  if (scope && !isActionEnabledWithSessionMemory(actionId, readSessionMemoryEnabledV1(scope.sessionMetadata))) return false;
  if (state?.settings) {
    if (!resolveLocalFeaturePolicyEnabled('voice', state.settings as any)) {
      return false;
    }
    const privacy = readVoicePrivacySettings(state.settings);
    if (privacy.currentUiContextMode === 'off' && isCurrentUiContextVoiceAction(actionId)) {
      return false;
    }
    if (!privacy.shareDeviceInventory && isInventoryPrivacyAction(actionId)) {
      return false;
    }
  }
  return isActionEnabledInState(state, actionId, { surface: 'voice' });
}

export function resolveEnabledVoiceToolActionSpecsFromState(state: Readonly<{ settings?: unknown }>, scope?: VoiceActionSessionScope): readonly ActionSpec[] {
  return listVoiceToolActionSpecs().filter((spec) => isVoiceActionAvailableInState(state, spec.id as ActionId, scope));
}

export function resolveEnabledVoiceSdkSafeToolActionSpecsFromState(
  state: Readonly<{ settings?: unknown }>,
  scope?: VoiceActionSessionScope,
): readonly ActionSpec[] {
  return resolveEnabledVoiceToolActionSpecsFromState(state, scope).filter(isVoiceSdkSafeActionSpec);
}

export function resolveDisabledVoiceActionIdsFromState(state: Readonly<{ settings?: unknown }>, scope?: VoiceActionSessionScope): readonly ActionId[] {
  const disabled = listVoiceActionBlockSpecs()
    .filter((spec) => !isVoiceActionAvailableInState(state, spec.id as ActionId, scope))
    .map((spec) => spec.id as ActionId)
    .sort((a, b) => String(a).localeCompare(String(b)));
  return disabled;
}
