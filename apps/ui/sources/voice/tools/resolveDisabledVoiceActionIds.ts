import { listVoiceActionBlockSpecs, listVoiceToolActionSpecs, type ActionId, type ActionSpec } from '@happier-dev/protocol';

import { isActionEnabledInState } from '@/sync/domains/settings/actionsSettings';
import { isInventoryPrivacyAction } from '@/sync/domains/settings/actionSettingsPolicy';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';

function isVoiceActionAvailableInState(state: Readonly<{ settings?: unknown }>, spec: ActionSpec): boolean {
  if (state?.settings && !readVoicePrivacySettings(state.settings).shareDeviceInventory && isInventoryPrivacyAction(spec.id as ActionId)) {
    return false;
  }
  return isActionEnabledInState(state, spec.id as ActionId, { surface: 'voice_tool' });
}

export function resolveEnabledVoiceToolActionSpecsFromState(state: Readonly<{ settings?: unknown }>): readonly ActionSpec[] {
  return listVoiceToolActionSpecs().filter((spec) => isVoiceActionAvailableInState(state, spec));
}

export function resolveDisabledVoiceActionIdsFromState(state: Readonly<{ settings?: unknown }>): readonly ActionId[] {
  const disabled = listVoiceActionBlockSpecs()
    .filter((spec) => !isVoiceActionAvailableInState(state, spec))
    .map((spec) => spec.id as ActionId)
    .sort((a, b) => String(a).localeCompare(String(b)));
  return disabled;
}
