import {
  isVoiceSdkSafeActionSpec,
  listVoiceActionBlockSpecs,
  listVoiceToolActionSpecs,
  type ActionId,
  type ActionSpec,
} from '@happier-dev/protocol';

import { isActionEnabledInState } from '@/sync/domains/settings/actionsSettings';
import { isInventoryPrivacyAction } from '@/sync/domains/settings/actionSettingsPolicy';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { resolveLocalFeaturePolicyEnabled } from '@/sync/domains/features/featureLocalPolicy';

const CURRENT_UI_CONTEXT_ACTION_IDS: ReadonlySet<ActionId> = new Set<ActionId>([
  'ui.current_context.read',
  'ui.current_context.command.invoke',
]);

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
): boolean {
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

export function resolveEnabledVoiceToolActionSpecsFromState(state: Readonly<{ settings?: unknown }>): readonly ActionSpec[] {
  return listVoiceToolActionSpecs().filter((spec) => isVoiceActionAvailableInState(state, spec.id as ActionId));
}

export function resolveEnabledVoiceSdkSafeToolActionSpecsFromState(
  state: Readonly<{ settings?: unknown }>,
): readonly ActionSpec[] {
  return resolveEnabledVoiceToolActionSpecsFromState(state).filter(isVoiceSdkSafeActionSpec);
}

export function resolveDisabledVoiceActionIdsFromState(state: Readonly<{ settings?: unknown }>): readonly ActionId[] {
  const disabled = listVoiceActionBlockSpecs()
    .filter((spec) => !isVoiceActionAvailableInState(state, spec.id as ActionId))
    .map((spec) => spec.id as ActionId)
    .sort((a, b) => String(a).localeCompare(String(b)));
  return disabled;
}
