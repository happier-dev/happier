import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { isDefaultWriteLikeToolName } from '@/agent/permissions/writeLikeToolNameHeuristics';
import { isChangeTitleToolLikeName } from '@happier-dev/protocol/tools/v2';

import { permissionModeForExecutionRunPolicy } from '@/agent/executionRuns/policy/permissionModeForExecutionRunPolicy';

const EXECUTION_RUN_ALWAYS_APPROVE_TOOL_TOKENS = ['change_title', 'session_title_set', 'save_memory', 'think'] as const;
const EXECUTION_RUN_EXTRA_WRITE_LIKE_TOOL_NAMES = new Set([
  'external_directory',
  'doom_loop',
]);

export function isExecutionRunWriteLikeToolName(toolName: string): boolean {
  const lower = String(toolName ?? '').trim().toLowerCase();
  if (!lower) return true;
  if (EXECUTION_RUN_EXTRA_WRITE_LIKE_TOOL_NAMES.has(lower)) return true;
  return isDefaultWriteLikeToolName(lower);
}

export function shouldAlwaysApproveExecutionRunTool(toolName: string): boolean {
  const lower = String(toolName ?? '').trim().toLowerCase();
  if (!lower) return false;
  if (isChangeTitleToolLikeName(lower)) return true;
  return EXECUTION_RUN_ALWAYS_APPROVE_TOOL_TOKENS.some((token) => lower.includes(token));
}

export function resolveExecutionRunPermissionDecision(args: Readonly<{
  permissionMode: string;
  backendId: string;
  toolName: string;
}>): 'approved_for_session' | 'denied' {
  const rawMode = String(args.permissionMode ?? '').trim().toLowerCase();
  const normalizedMode = permissionModeForExecutionRunPolicy(args.permissionMode);

  if (shouldAlwaysApproveExecutionRunTool(args.toolName)) return 'approved_for_session';

  if (rawMode === 'no_tools') {
    return 'denied';
  }

  if (normalizedMode === 'read-only' || normalizedMode === 'plan') {
    return isExecutionRunWriteLikeToolName(args.toolName) ? 'denied' : 'approved_for_session';
  }

  // Execution runs are non-interactive. Once the user starts an autonomous run in any
  // non-read-only mode, residual ACP permission prompts must resolve deterministically
  // instead of cancelling the run.
  return 'approved_for_session';
}

export function createExecutionRunPermissionHandler(args: Readonly<{
  permissionMode: string;
  backendId: string;
}>): AcpPermissionHandler {
  return {
    async handleToolCall(_toolCallId, toolName) {
      return {
        decision: resolveExecutionRunPermissionDecision({
          permissionMode: args.permissionMode,
          backendId: args.backendId,
          toolName,
        }),
      };
    },
  };
}
