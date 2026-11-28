import type { ActionId } from './actionIds.js';
import type { ActionExecutorContext } from './actionExecutor.js';
import type { ActionsSettingsV1, ActionSettingsOverride } from './actionSettings.js';
import { resolveActionApprovalFlow, type ActionApprovalFlow, type ActionApprovalResult } from './actionApprovalMetadata.js';
import type { ActionSpec } from './actionSpecs.js';

export type ActionApprovalRoutingDecision = Readonly<{
  required: boolean;
  flow: ActionApprovalFlow;
  result: ActionApprovalResult;
}>;

export type ResolveActionApprovalRoutingArgs = Readonly<{
  actionId: ActionId;
  spec: ActionSpec;
  settings?: ActionsSettingsV1 | null;
  context?: Pick<ActionExecutorContext, 'surface'> | null;
  requiredByPolicy?: boolean;
}>;

function isApprovalAction(actionId: ActionId): boolean {
  return actionId === 'approval.request.create' || actionId === 'approval.request.decide';
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
  defaultRequired = false,
): boolean {
  const surface = ctx?.surface ?? null;
  if (!surface) return false;

  const override = (settings as any)?.actions?.[actionId] as ActionSettingsOverride | undefined;
  if (!override) return defaultRequired;
  const required = override.approvalRequiredSurfaces;
  return Array.isArray(required) && required.includes(surface as any);
}

export function resolveActionApprovalRouting(args: ResolveActionApprovalRoutingArgs): ActionApprovalRoutingDecision {
  const approval = args.spec.approval;
  const requiredByPolicy = typeof args.requiredByPolicy === 'boolean'
    ? args.requiredByPolicy
    : args.settings
      ? isApprovalRequiredByActionsSettings(args.actionId, args.settings, args.context)
      : false;

  return {
    required: isApprovalAction(args.actionId) ? false : requiredByPolicy,
    flow: resolveActionApprovalFlow(approval),
    result: approval.result,
  };
}
