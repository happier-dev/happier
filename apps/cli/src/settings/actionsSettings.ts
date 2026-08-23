import {
  ActionsSettingsV1Schema,
  isActionEnabledByActionsSettings,
  isApprovalRequiredByActionsSettings,
  listActionSpecs,
  type ActionId,
  type ActionSettingsActionId,
  type ActionSurfaces,
  type ActionUiPlacement,
  type ActionsSettingsV1,
} from '@happier-dev/protocol';

const ENV_KEY = 'HAPPIER_ACTIONS_SETTINGS_V1';
const EMPTY_ACTIONS_SETTINGS = Object.freeze({
  v: 1 as const,
  actions: {},
}) as ActionsSettingsV1;

export function readActionsSettingsFromEnv(): ActionsSettingsV1 {
  const raw = typeof process.env[ENV_KEY] === 'string' ? String(process.env[ENV_KEY]).trim() : '';
  if (!raw) return EMPTY_ACTIONS_SETTINGS;

  let parsedJson: unknown = null;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return EMPTY_ACTIONS_SETTINGS;
  }

  const parsed = ActionsSettingsV1Schema.safeParse(parsedJson);
  return parsed.success ? parsed.data : EMPTY_ACTIONS_SETTINGS;
}

export function isActionEnabledByEnv(
  actionId: ActionSettingsActionId,
  ctx?: Readonly<{ surface?: keyof ActionSurfaces | null; placement?: ActionUiPlacement | null }>,
): boolean {
  return isActionEnabledByActionsSettings(actionId, readActionsSettingsFromEnv(), {
    surface: ctx?.surface ?? null,
    placement: ctx?.placement ?? null,
  });
}

export function isActionApprovalRequiredByEnv(
  actionId: ActionSettingsActionId,
  ctx?: Readonly<{ surface?: keyof ActionSurfaces | null }>,
): boolean {
  return isApprovalRequiredByActionsSettings(actionId, readActionsSettingsFromEnv(), {
    surface: ctx?.surface ?? null,
  });
}

export function listDisabledActionIdsForSurfaceFromEnv(surface: keyof ActionSurfaces): readonly ActionId[] {
  const settings = readActionsSettingsFromEnv();
  const disabled: ActionId[] = [];
  for (const spec of listActionSpecs()) {
    if (!isActionEnabledByActionsSettings(spec.id as any, settings as any, { surface, placement: null })) {
      disabled.push(spec.id as any);
    }
  }
  disabled.sort((a, b) => String(a).localeCompare(String(b)));
  return disabled;
}
