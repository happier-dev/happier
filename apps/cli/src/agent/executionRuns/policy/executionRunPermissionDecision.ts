import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { isDefaultWriteLikeToolName } from '@/agent/permissions/writeLikeToolNameHeuristics';
import { isTrustedAlwaysAutoApproveToolName } from '@/agent/permissions/alwaysAutoApproveToolName';
import { extractShellCommand } from '@/agent/permissions/permissionToolIdentifier';

import { permissionModeForExecutionRunPolicy } from '@/agent/executionRuns/policy/permissionModeForExecutionRunPolicy';

const EXECUTION_RUN_EXTRA_WRITE_LIKE_TOOL_NAMES = new Set([
  'external_directory',
  'doom_loop',
]);
const EXECUTION_RUN_EXACT_READ_ONLY_SHELL_COMMANDS = new Set([
  'git status',
  'git diff',
  'git log',
  'git branch --show-current',
  'git rev-parse --show-toplevel',
]);

export function isExecutionRunWriteLikeToolName(toolName: string): boolean {
  const lower = String(toolName ?? '').trim().toLowerCase();
  if (!lower) return true;
  if (EXECUTION_RUN_EXTRA_WRITE_LIKE_TOOL_NAMES.has(lower)) return true;
  return isDefaultWriteLikeToolName(lower);
}

export function shouldAlwaysApproveExecutionRunTool(toolName: string): boolean {
  return isTrustedAlwaysAutoApproveToolName(toolName);
}

function isExactReadOnlyShellInspection(toolName: string, input: unknown): boolean {
  const normalizedToolName = String(toolName ?? '').trim().toLowerCase();
  if (normalizedToolName !== 'bash' && normalizedToolName !== 'shell' && normalizedToolName !== 'execute') {
    return false;
  }
  const command = extractShellCommand(input);
  return command != null && EXECUTION_RUN_EXACT_READ_ONLY_SHELL_COMMANDS.has(command.trim());
}

export function resolveExecutionRunPermissionDecision(args: Readonly<{
  permissionMode: string;
  backendId: string;
  toolName: string;
  input?: unknown;
}>): 'approved_for_session' | 'denied' {
  const rawMode = String(args.permissionMode ?? '').trim().toLowerCase();
  const normalizedMode = permissionModeForExecutionRunPolicy(args.permissionMode);

  if (shouldAlwaysApproveExecutionRunTool(args.toolName)) return 'approved_for_session';

  if (rawMode === 'no_tools') {
    return 'denied';
  }

  if (normalizedMode === 'read-only' || normalizedMode === 'plan') {
    if (isExactReadOnlyShellInspection(args.toolName, args.input)) return 'approved_for_session';
    return isExecutionRunWriteLikeToolName(args.toolName) ? 'denied' : 'approved_for_session';
  }

  if (normalizedMode === 'default') {
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
    async handleToolCall(_toolCallId, toolName, input) {
      return {
        decision: resolveExecutionRunPermissionDecision({
          permissionMode: args.permissionMode,
          backendId: args.backendId,
          toolName,
          input,
        }),
      };
    },
  };
}
