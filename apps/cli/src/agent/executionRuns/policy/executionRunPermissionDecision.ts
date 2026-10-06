import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type {
  AcpPermissionCallContext,
  AcpPermissionCausalAuthority,
} from '@/agent/acp/permissions/acpPermissionHandler';
import {
  isPermissionGuardToolName,
  isSharedPermissionSafeToolName,
  isSharedPermissionWriteLikeToolName,
} from '@/agent/permissions/permissionTaxonomy';
import { resolveCausalPermissionMode } from '@/agent/permissions/causalPermissionMode';
import { extractShellCommand } from '@happier-dev/protocol/activity/shellCommand';
import { isWorkspaceWriteDeniedByRole } from '@/agent/permissions/workspaceWritePolicy';

import { permissionMode } from '@/agent/executionRuns/policy/permissionMode';

const EXECUTION_RUN_EXACT_READ_ONLY_SHELL_COMMANDS = new Set([
  'git status',
  'git diff',
  'git log',
  'git branch --show-current',
  'git rev-parse --show-toplevel',
]);

export type ExecutionRunPermissionHandler = AcpPermissionHandler & Readonly<{
  getImmediateDecision: NonNullable<AcpPermissionHandler['getImmediateDecision']>;
  respondToPermissionRequest: (toolCallId: string, approved: boolean) => boolean;
}>;

export function isExecutionRunWriteLikeToolName(toolName: string): boolean {
  const lower = String(toolName ?? '').trim().toLowerCase();
  if (!lower) return true;
  if (isPermissionGuardToolName(lower)) return true;
  return isSharedPermissionWriteLikeToolName(lower);
}

export function shouldAlwaysApproveExecutionRunTool(toolName: string): boolean {
  return isSharedPermissionSafeToolName(toolName);
}

function resolveExecutionRunImmediateDecision(args: Readonly<{
  permissionMode: string;
  workspaceWrites?: 'allow' | 'deny';
  backendId: string;
  toolName: string;
  input?: unknown;
  causalPermissionAuthority?: AcpPermissionCausalAuthority;
  context?: AcpPermissionCallContext;
}>): { decision: 'approved' | 'approved_for_session' | 'denied' } | null {
  if (isWorkspaceWriteDeniedByRole({ workspaceWrites: args.workspaceWrites, toolName: args.toolName, toolInput: args.input })) return { decision: 'denied' };
  const rawLower = String(args.permissionMode ?? '').trim().toLowerCase();
  const normalizedMode = permissionMode(args.permissionMode);
  const hasContextCausalAuthority = Boolean(
    args.context
    && Object.prototype.hasOwnProperty.call(args.context, 'causalPermissionAuthority'),
  );
  const hasRunCausalAuthority = Object.prototype.hasOwnProperty.call(args, 'causalPermissionAuthority');
  const effective = resolveCausalPermissionMode({
    currentPermissionMode: normalizedMode,
    context: hasContextCausalAuthority
      ? args.context
      : hasRunCausalAuthority
        ? { causalPermissionAuthority: args.causalPermissionAuthority }
        : undefined,
  });

  // A supplied causal authority that cannot be proved valid is itself a typed
  // non-authorizing fact. Returning a pending prompt here would let a buffered
  // or later response bypass the malformed admitted ceiling.
  if (!effective.ok) return { decision: 'denied' };
  const effectiveMode = effective.effectiveMode;

  if (shouldAlwaysApproveExecutionRunTool(args.toolName)) return { decision: 'approved' };

  // Execution runs still support legacy "no_tools" semantics: deny everything except the shared-safe tools
  // (e.g. title changes) regardless of how it normalizes onto the canonical PermissionMode surface.
  if (rawLower === 'no_tools') return { decision: 'denied' };

  if (effectiveMode === 'read-only' || effectiveMode === 'plan') {
    const normalizedToolName = String(args.toolName ?? '').trim().toLowerCase();
    if (
      normalizedToolName === 'bash'
      || normalizedToolName === 'shell'
      || normalizedToolName === 'execute'
    ) {
      const command = extractShellCommand(args.input);
      if (command && EXECUTION_RUN_EXACT_READ_ONLY_SHELL_COMMANDS.has(command.trim())) {
        return { decision: 'approved' };
      }
    }
    return isExecutionRunWriteLikeToolName(args.toolName) ? { decision: 'denied' } : { decision: 'approved' };
  }

  if (effectiveMode === 'yolo') {
    return { decision: 'approved_for_session' };
  }

  if (effectiveMode === 'safe-yolo') {
    return { decision: 'approved_for_session' };
  }

  // Default (and other interactive-ish modes): require an explicit response.
  return null;
}

/**
 * Deterministic execution-run permission decision used by non-interactive call sites that cannot
 * block on a prompt loop.
 *
 * If the permission mode would normally require an interactive response, this fails closed by
 * denying rather than auto-approving.
 */
export function resolveExecutionRunPermissionDecision(args: Readonly<{
  permissionMode: string;
  workspaceWrites?: 'allow' | 'deny';
  backendId: string;
  toolName: string;
  input?: unknown;
  causalPermissionAuthority?: AcpPermissionCausalAuthority;
}>): 'approved_for_session' | 'denied' {
  const immediate = resolveExecutionRunImmediateDecision(args);
  if (!immediate) return 'denied';
  return immediate.decision === 'denied' ? 'denied' : 'approved_for_session';
}

export function createExecutionRunPermissionHandler(args: Readonly<{
  permissionMode: string;
  workspaceWrites?: 'allow' | 'deny';
  backendId: string;
  causalPermissionAuthority?: AcpPermissionCausalAuthority;
  publishPendingRequest?: (request: Readonly<{
    requestId: string;
    toolName: string;
    toolInput: unknown;
    turnId?: string;
  }>) => Promise<void> | void;
  }>): ExecutionRunPermissionHandler {
  const pending = new Map<string, { resolve: (value: { decision: 'approved' | 'denied' }) => void }>();

  function respondToPermissionRequest(toolCallId: string, approved: boolean): boolean {
    const request = pending.get(toolCallId) ?? null;
    if (!request) return false;
    pending.delete(toolCallId);
    request.resolve({ decision: approved ? 'approved' : 'denied' });
    return true;
  }

  function readImmediate(
    toolCallId: string,
    toolName: string,
    input: unknown,
    context?: AcpPermissionCallContext,
  ) {
    const immediate = resolveExecutionRunImmediateDecision({
      permissionMode: args.permissionMode,
      workspaceWrites: args.workspaceWrites,
      backendId: args.backendId,
      toolName,
      input,
      ...(Object.prototype.hasOwnProperty.call(args, 'causalPermissionAuthority')
        ? { causalPermissionAuthority: args.causalPermissionAuthority }
        : {}),
      ...(context ? { context } : {}),
    });
    return immediate;
  }

  return {
    respondToPermissionRequest,
    getImmediateDecision(toolCallId, toolName, input, context) {
      return readImmediate(toolCallId, toolName, input, context);
    },
    async handleToolCall(toolCallId, toolName, input, context) {
      const immediate = readImmediate(toolCallId, toolName, input, context);
      if (immediate) return immediate;

      if (!args.publishPendingRequest) {
        const error = Object.assign(
          new Error('Execution-run permission interaction target is unavailable'),
          { code: 'execution_run_interaction_unavailable' },
        );
        throw error;
      }
      const pendingDecision = new Promise<{ decision: 'approved' | 'denied' }>((resolve) => {
        pending.set(toolCallId, { resolve });
      });
      try {
        await args.publishPendingRequest({
          requestId: toolCallId,
          toolName,
          toolInput: input,
          ...(context?.turnId ? { turnId: context.turnId } : {}),
        });
      } catch (error) {
        pending.delete(toolCallId);
        throw error;
      }
      return await pendingDecision;
    },
    async abortPendingRequestAndFlush(toolCallId) {
      const request = pending.get(toolCallId);
      if (!request) return;
      pending.delete(toolCallId);
      request.resolve({ decision: 'denied' });
    },
    async abortPendingRequestsAndFlush() {
      const requests = [...pending.values()];
      pending.clear();
      for (const request of requests) request.resolve({ decision: 'denied' });
    },
  };
}
