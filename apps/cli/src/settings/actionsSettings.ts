import {
  ActionsSettingsV1Schema,
  isActionEnabledByActionsSettings,
  listActionSpecs,
  type ActionId,
  type ActionSurfaces,
  type ActionUiPlacement,
} from '@happier-dev/protocol';

const ENV_KEY = 'HAPPIER_ACTIONS_SETTINGS_V1';

export function readActionsSettingsFromEnv(): { v: 1; actions: Record<ActionId, any> } {
  const raw = typeof process.env[ENV_KEY] === 'string' ? String(process.env[ENV_KEY]).trim() : '';
  if (!raw) return { v: 1 as const, actions: {} as Record<ActionId, any> };

  let parsedJson: unknown = null;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { v: 1 as const, actions: {} as Record<ActionId, any> };
  }

  const parsed = ActionsSettingsV1Schema.safeParse(parsedJson);
  return parsed.success ? (parsed.data as any) : ({ v: 1 as const, actions: {} as Record<ActionId, any> } as any);
}

export function isActionEnabledByEnv(
  actionId: ActionId,
  ctx?: Readonly<{ surface?: keyof ActionSurfaces | null; placement?: ActionUiPlacement | null }>,
): boolean {
  return isActionEnabledByActionsSettings(actionId, readActionsSettingsFromEnv() as any, {
    surface: ctx?.surface ?? null,
    placement: ctx?.placement ?? null,
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

