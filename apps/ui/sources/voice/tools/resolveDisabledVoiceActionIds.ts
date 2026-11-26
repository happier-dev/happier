import { listVoiceActionBlockSpecs, listVoiceToolActionSpecs, type ActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';

import type { Settings } from '@/sync/domains/settings/settings';
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
 * Voice runtime, feature and privacy availability for catalogs and retained handlers.
 * Actions-settings enablement belongs to the executor’s effective bound-Session
 * policy, including Account policy when the conversation has no owned overlay.
 */
export function isVoiceActionAvailableInState(
  state: Readonly<{ settings?: Readonly<Partial<Settings>> | null }>,
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
  return true;
}

export function resolveEnabledVoiceToolActionSpecsFromState(state: Readonly<{ settings?: Readonly<Partial<Settings>> | null }>): readonly ActionSpec[] {
  return listVoiceToolActionSpecs().filter((spec) => isVoiceActionAvailableInState(state, spec.id as ActionId));
}

export function resolveDisabledVoiceActionIdsFromState(state: Readonly<{ settings?: Readonly<Partial<Settings>> | null }>): readonly ActionId[] {
  const disabled = listVoiceActionBlockSpecs()
    .filter((spec) => !isVoiceActionAvailableInState(state, spec.id as ActionId))
    .map((spec) => spec.id as ActionId)
    .sort((a, b) => String(a).localeCompare(String(b)));
  return disabled;
}
