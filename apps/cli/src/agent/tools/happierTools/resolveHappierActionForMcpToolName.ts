import { extractShellCommand } from '@happier-dev/protocol/activity/shellCommand';
import { getActionSpec, listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { memoizeActionSpecValue } from '@happier-dev/protocol/actions/lazyActionSpecValue';
import type { ActionId } from '@happier-dev/protocol';

import type { PermissionMode } from '@/api/types';
import { resolveHappierActionPermission } from '@/agent/permissions/happierActionPermission';

import { getEquivalentActionIdForBuiltInTool } from './actionToolCatalog';
import { parseTrustedHappierToolsShellBridgeCommand } from './runtime/buildHappierToolsShellBridgeCommand';

// Built on first lookup: building it at module evaluation built the whole Action
// catalog in every process that imports this module (daemon, session host).
const readActionIds = memoizeActionSpecValue(() => new Set<ActionId>(listActionSpecs().map((spec) => spec.id as ActionId)));

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
  if (!readActionIds().has(raw as ActionId)) return null;
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
  return readActionIds().has(actionId as ActionId) ? actionId as ActionId : null;
}

export type HappierActionPermissionDecision =
  | Readonly<{ decision: 'approved' | 'denied'; actionId: ActionId }>
  | Readonly<{ decision: null; actionId: null }>;

export function resolveProviderPermissionForHappierAction(params: Readonly<{
  toolName: string;
  input: unknown;
  permissionMode: PermissionMode;
}>): HappierActionPermissionDecision {
  const actionId = resolveHappierActionForMcpToolName({
    toolName: params.toolName,
    input: params.input,
  });
  if (!actionId) return { decision: null, actionId: null };

  return {
    decision: resolveHappierActionPermission({ spec: getActionSpec(actionId), permissionMode: params.permissionMode }),
    actionId,
  };
}
