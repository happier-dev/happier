import { z } from 'zod';

import { ActionIdSchema, type ActionId } from './actionIds.js';
import { ActionSurfaceSchema, type ActionSurfaces } from './actionSpecs.js';
import { ActionUiPlacementSchema, type ActionUiPlacement } from './actionUiPlacements.js';

const ActionSurfaceKeySchema = ActionSurfaceSchema.keyof();
export type ActionSurfaceKey = z.infer<typeof ActionSurfaceKeySchema>;

const ActionSettingsOverrideSchema = z
  .object({
    enabled: z.boolean().optional(),
    enabledPlacements: z.array(ActionUiPlacementSchema).default([]),
    disabledSurfaces: z.array(ActionSurfaceKeySchema).default([]),
    disabledPlacements: z.array(ActionUiPlacementSchema).default([]),
  })
  .strict();
export type ActionSettingsOverride = z.infer<typeof ActionSettingsOverrideSchema>;

export const ActionsSettingsV1Schema = z
  .object({
    v: z.literal(1),
    // Accept unknown keys but filter them down to known ActionIds during transform so settings
    // survive action id additions without failing strict parsing.
    actions: z.record(z.string(), ActionSettingsOverrideSchema).default({}),
  })
  .passthrough()
  .transform((value) => {
    const next: Record<ActionId, ActionSettingsOverride> = {} as any;
    const actions = value.actions ?? {};
    for (const [rawId, override] of Object.entries(actions)) {
      const parsedId = ActionIdSchema.safeParse(rawId);
      if (!parsedId.success) continue;
      next[parsedId.data] = override;
    }
    return { v: 1 as const, actions: next };
  });

export type ActionsSettingsV1 = z.infer<typeof ActionsSettingsV1Schema>;

export type ActionEnablementContext = Readonly<{
  surface?: keyof ActionSurfaces | null;
  placement?: ActionUiPlacement | null;
}>;

export function isActionEnabledByActionsSettings(
  actionId: ActionId,
  settings: ActionsSettingsV1,
  ctx?: ActionEnablementContext,
): boolean {
  const optInPlacements = new Set<ActionUiPlacement>(['agent_input_chips']);
  const override = (settings as any)?.actions?.[actionId] as ActionSettingsOverride | undefined;
  if (override?.enabled === false) return false;
  const surface = ctx?.surface ?? null;
  if (surface && override?.disabledSurfaces?.includes(surface as any)) return false;
  const placement = ctx?.placement ?? null;
  if (placement && optInPlacements.has(placement as any)) {
    if (override?.disabledPlacements?.includes(placement as any)) return false;
    if (override?.enabledPlacements?.includes(placement as any)) return true;
    return false;
  }
  if (placement && override?.disabledPlacements?.includes(placement as any)) return false;
  return true;
}
