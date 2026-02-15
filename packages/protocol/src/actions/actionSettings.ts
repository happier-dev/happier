import { z } from 'zod';

import { ActionIdSchema, type ActionId } from './actionIds.js';

export const ActionsSettingsV1Schema = z
  .object({
    v: z.literal(1),
    disabledActionIds: z.array(ActionIdSchema).default([]),
  })
  .strict();

export type ActionsSettingsV1 = z.infer<typeof ActionsSettingsV1Schema>;

export function isActionEnabledByActionsSettings(actionId: ActionId, settings: ActionsSettingsV1): boolean {
  const disabled = new Set(settings.disabledActionIds);
  return !disabled.has(actionId);
}

