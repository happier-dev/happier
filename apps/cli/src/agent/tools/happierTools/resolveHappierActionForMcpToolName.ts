import { extractShellCommand } from '@happier-dev/protocol/activity/shellCommand';
import { getActionSpec, listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionId } from '@happier-dev/protocol';

import type { PermissionMode } from '@/api/types';

import { getEquivalentActionIdForBuiltInTool } from './actionToolCatalog';
import { parseTrustedHappierToolsShellBridgeCommand } from './runtime/buildHappierToolsShellBridgeCommand';

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
  if (!firstPartyToolName) {
    const providerToolName = normalizeToolName(params.toolName).toLowerCase();
    if (providerToolName !== 'bash' && providerToolName !== 'execute' && providerToolName !== 'shell') {
      return null;
    }
    const command = extractShellCommand(params.input);
    const bridge = command ? parseTrustedHappierToolsShellBridgeCommand(command) : null;
    if (!bridge || bridge.kind !== 'call' || bridge.source !== 'happier') return null;
    return resolveHappierActionForMcpToolName({
      toolName: `happier_${bridge.tool}`,
      input: bridge.args,
    });
  }
  if (firstPartyToolName === 'action_execute') return readActionExecuteActionId(params.input);
  const actionId = getEquivalentActionIdForBuiltInTool(firstPartyToolName);
  return ACTION_IDS.has(actionId as ActionId) ? actionId as ActionId : null;
}

export function resolveProviderPermissionForHappierAction(params: Readonly<{
  toolName: string;
  input: unknown;
  permissionMode: PermissionMode;
}>): Readonly<{
  decision: 'approved' | 'denied' | null;
  actionId: ActionId | null;
}> {
  const actionId = resolveHappierActionForMcpToolName({
    toolName: params.toolName,
    input: params.input,
  });
  if (!actionId) return { decision: null, actionId: null };

  const spec = getActionSpec(actionId);
  const permissionCeilingDeniesAction =
    (params.permissionMode === 'read-only' || params.permissionMode === 'plan')
    && spec.sideEffectClass !== 'none'
    && spec.sideEffectClass !== 'read';

  return {
    decision: permissionCeilingDeniesAction ? 'denied' : 'approved',
    actionId,
  };
}
