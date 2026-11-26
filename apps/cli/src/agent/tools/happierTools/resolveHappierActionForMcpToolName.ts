import { extractShellCommand } from '@happier-dev/protocol/activity/shellCommand';
import { findActionSpec, getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import type { ActionId } from '@happier-dev/protocol';

import type { PermissionMode } from '@/api/types';
import { resolveHappierActionPermission, type HappierActionPermissionResult } from '@/agent/permissions/happierActionPermission';

import { normalizeActionExecuteInput } from './actionToolContext';
import { getEquivalentActionIdForBuiltInTool } from './actionToolCatalog';
import { parseTrustedHappierToolsShellBridgeCommand } from './runtime/buildHappierToolsShellBridgeCommand';

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

type HappierToolCall = Readonly<{ toolName: string; input: unknown }>;

function resolveHappierActionInvocation(params: HappierToolCall): Readonly<{ actionId: ActionId; input: unknown }> | null {
  const firstPartyToolName = normalizeFirstPartyHappierToolName(params.toolName);
  if (!firstPartyToolName) {
    const providerToolName = normalizeToolName(params.toolName).toLowerCase();
    if (providerToolName !== 'bash' && providerToolName !== 'execute' && providerToolName !== 'shell') {
      return null;
    }
    const command = extractShellCommand(params.input);
    const bridge = command ? parseTrustedHappierToolsShellBridgeCommand(command) : null;
    if (!bridge || bridge.kind !== 'call' || bridge.source !== 'happier') return null;
    return resolveHappierActionInvocation({
      toolName: `happier_${bridge.tool}`,
      input: bridge.args,
    });
  }
  if (firstPartyToolName === 'action_execute') {
    const args = readRecord(params.input);
    const spec = findActionSpec(normalizeToolName(args.actionId));
    return spec ? { actionId: spec.id, input: args.input } : null;
  }
  const actionId = getEquivalentActionIdForBuiltInTool(firstPartyToolName);
  const spec = actionId ? findActionSpec(actionId) : null;
  return spec ? { actionId: spec.id, input: params.input } : null;
}

export function resolveHappierActionForMcpToolName(params: HappierToolCall): ActionId | null {
  return resolveHappierActionInvocation(params)?.actionId ?? null;
}

export type HappierActionPermissionDecision =
  | (HappierActionPermissionResult & Readonly<{ actionId: ActionId }>)
  | Readonly<{ decision: null; actionId: null }>;

export function resolveProviderPermissionForHappierAction(params: HappierToolCall & Readonly<{
  permissionMode: PermissionMode;
  callerSession?: ActionSessionAddressV1;
}>): HappierActionPermissionDecision {
  const invocation = resolveHappierActionInvocation(params);
  if (!invocation) return { decision: null, actionId: null };

  return {
    ...resolveHappierActionPermission({
      spec: getActionSpec(invocation.actionId), permissionMode: params.permissionMode,
      input: params.permissionMode === 'plan' ? normalizeActionExecuteInput(invocation.input) : invocation.input,
      callerSession: params.callerSession, defaultSessionId: params.callerSession?.sessionId,
    }),
    actionId: invocation.actionId,
  };
}
