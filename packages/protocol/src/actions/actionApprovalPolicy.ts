import type { ActionId } from './actionIds.js';
import type { ActionExecutorContext } from './actionExecutor.js';
import type { ActionsSettingsV1, ActionSettingsOverride } from './actionSettings.js';

const ALWAYS_AUTO_APPROVED_ACTION_IDS = new Set<ActionId>([
  'session.title.set',
]);

export function isActionAlwaysAutoApproved(actionId: ActionId): boolean {
  return ALWAYS_AUTO_APPROVED_ACTION_IDS.has(actionId);
}

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
  if (isActionAlwaysAutoApproved(actionId)) return false;
  const surface = ctx?.surface ?? null;
  if (!surface) return false;

  const override = (settings as any)?.actions?.[actionId] as ActionSettingsOverride | undefined;
  const required = override?.approvalRequiredSurfaces ?? [];
  return Array.isArray(required) && required.includes(surface as any);
}
