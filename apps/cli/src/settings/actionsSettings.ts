import {
  ActionsSettingsV1Schema,
  isActionEnabledByActionsSettings,
  isApprovalRequiredByActionsSettings,
  listActionSpecs,
  type ActionId,
  type ActionsSettingsV1,
  type ActionSurfaces,
  type ActionUiPlacement,
} from '@happier-dev/protocol';

const ENV_KEY = 'HAPPIER_ACTIONS_SETTINGS_V1';
const EMPTY_ACTIONS_SETTINGS = ActionsSettingsV1Schema.parse({ v: 1, actions: {} });

export function readActionsSettingsOverrideFromEnv(): ActionsSettingsV1 | null {
  const raw = typeof process.env[ENV_KEY] === 'string' ? String(process.env[ENV_KEY]).trim() : '';
  if (!raw) return null;

  let parsedJson: unknown = null;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return null;
  }

  const parsed = ActionsSettingsV1Schema.safeParse(parsedJson);
  return parsed.success ? parsed.data : null;
}

export function readActionsSettingsFromEnv(): ActionsSettingsV1 {
  return readActionsSettingsOverrideFromEnv()
    ?? EMPTY_ACTIONS_SETTINGS;
}

export function isActionEnabledByEnv(
  actionId: ActionId,
  ctx?: Readonly<{ surface?: keyof ActionSurfaces | null; placement?: ActionUiPlacement | null }>,
): boolean {
  return isActionEnabledByActionsSettings(actionId, readActionsSettingsFromEnv(), {
    surface: ctx?.surface ?? null,
    placement: ctx?.placement ?? null,
  });
}

export function isActionApprovalRequiredByEnv(
  actionId: ActionId,
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
