import type { ActionId } from './actionIds.js';
import type { ActionExecutorContext } from './actionExecutor.js';
import type { ActionsSettingsV1, ActionSettingsOverride } from './actionSettings.js';

/**
 * Generic approvals policy resolution rooted in persisted ActionsSettings.
 *
 * Notes:
 * - This answers “should this action be routed through approvals on this surface?”
 * - It does not decide enablement (use `isActionEnabledByActionsSettings` separately).
 * - Missing/unknown surfaces fail closed (no approval requirement).
 */
export function isApprovalRequiredByActionsSettings(
  actionId: ActionId,
  settings: ActionsSettingsV1,
  ctx?: Pick<ActionExecutorContext, 'surface'> | null,
): boolean {
  const surface = ctx?.surface ?? null;
  if (!surface) return false;

  const override = (settings as any)?.actions?.[actionId] as ActionSettingsOverride | undefined;
  const required = override?.approvalRequiredSurfaces ?? [];
  return Array.isArray(required) && required.includes(surface as any);
}
