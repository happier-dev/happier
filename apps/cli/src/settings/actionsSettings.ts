import { normalizeActionsSettingsV1, isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionId, ActionSettingsActionId, ActionSurfaces, ActionUiPlacement, ActionsSettingsV1 } from '@happier-dev/protocol';
import { createActionSettingsProvider, type RuntimeActionSettingsProvider } from './actionsSettingsProvider';
import { readActionsSettingsOverrideFromEnv } from './actionsSettingsOverride';
export { readActionsSettingsOverrideFromEnv } from './actionsSettingsOverride';

export function resolveActionsSettingsWithEnvironmentOverride(
  accountSettings: Readonly<Record<string, unknown>>,
): ActionsSettingsV1 {
  const environmentOverride = readActionsSettingsOverrideFromEnv();
  if (environmentOverride) return environmentOverride;
  return normalizeActionsSettingsV1(accountSettings.actionsSettingsV1);
}

export function isActionEnabled(
  actionId: ActionSettingsActionId,
  ctx?: Readonly<{ surface?: keyof ActionSurfaces | null; placement?: ActionUiPlacement | null }>,
): boolean {
  return isActionEnabledByActionsSettings(actionId, createActionSettingsProvider().getActionsSettings(), {
    surface: ctx?.surface ?? null,
    placement: ctx?.placement ?? null,
  });
}

export function listDisabledActionIdsForSurface(surface: keyof ActionSurfaces,
  provider: RuntimeActionSettingsProvider = createActionSettingsProvider()): readonly ActionId[] {
  const settings = provider.getActionsSettings();
  const disabled: ActionId[] = [];
  for (const spec of listActionSpecs()) {
    if (!isActionEnabledByActionsSettings(spec.id, settings, { surface, placement: null })) {
      disabled.push(spec.id);
    }
  }
  disabled.sort((a, b) => String(a).localeCompare(String(b)));
  return disabled;
}
