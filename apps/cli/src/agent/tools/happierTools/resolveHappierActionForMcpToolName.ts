import {
  getActionSpec,
  isApprovalRequiredByActionsSettings,
  listActionSpecs,
  resolveActionApprovalRouting,
  type AccountSettings,
  type ActionId,
  type ActionSurfaces,
} from '@happier-dev/protocol';

import { isActionApprovalRequiredByEnv } from '@/settings/actionsSettings';

import { getEquivalentActionIdForBuiltInTool } from './actionToolCatalog';

const ACTION_IDS = new Set<ActionId>(listActionSpecs().map((spec) => spec.id as ActionId));

function normalizeToolName(raw: unknown): string {
  return String(raw ?? '').trim();
}

function normalizeFirstPartyHappierToolName(toolName: string): string | null {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return null;
  if (normalized.startsWith('mcp__happier__')) return normalized.slice('mcp__happier__'.length);
  if (normalized.startsWith('happier__')) return normalized.slice('happier__'.length);
  if (normalized.startsWith('happier_')) return normalized.slice('happier_'.length);
  if (getEquivalentActionIdForBuiltInTool(normalized)) return normalized;
  return null;
}

function readActionExecuteActionId(input: unknown): ActionId | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = normalizeToolName((input as Record<string, unknown>).actionId);
  if (!ACTION_IDS.has(raw as ActionId)) return null;
  return raw as ActionId;
}

export function resolveHappierActionForMcpToolName(params: Readonly<{
  toolName: string;
  input: unknown;
}>): ActionId | null {
  const firstPartyToolName = normalizeFirstPartyHappierToolName(params.toolName);
  if (!firstPartyToolName) return null;
  if (firstPartyToolName === 'action_execute') return readActionExecuteActionId(params.input);
  const actionId = getEquivalentActionIdForBuiltInTool(firstPartyToolName);
  return ACTION_IDS.has(actionId as ActionId) ? actionId as ActionId : null;
}

export function shouldSuppressProviderPermissionForHappierApproval(params: Readonly<{
  toolName: string;
  input: unknown;
  accountSettings?: Pick<AccountSettings, 'actionsSettingsV1'> | null;
  surface: keyof ActionSurfaces;
}>): Readonly<{ suppress: boolean; actionId: ActionId | null }> {
  const actionId = resolveHappierActionForMcpToolName({
    toolName: params.toolName,
    input: params.input,
  });
  if (!actionId) return { suppress: false, actionId: null };

  const settings = params.accountSettings?.actionsSettingsV1 ?? null;
  const required = settings
    ? isApprovalRequiredByActionsSettings(actionId, settings, { surface: params.surface })
    : isActionApprovalRequiredByEnv(actionId, { surface: params.surface });
  const routing = resolveActionApprovalRouting({
    actionId,
    spec: getActionSpec(actionId),
    context: { surface: params.surface },
    requiredByPolicy: required,
  });

  return { suppress: routing.required, actionId };
}
