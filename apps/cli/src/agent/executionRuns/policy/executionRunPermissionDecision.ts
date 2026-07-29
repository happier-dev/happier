import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import {
  isPermissionGuardToolName,
  isSharedPermissionSafeToolName,
  isSharedPermissionWriteLikeToolName,
} from '@/agent/permissions/permissionTaxonomy';

import { permissionMode } from '@/agent/executionRuns/policy/permissionMode';

export type ExecutionRunPermissionHandler = AcpPermissionHandler & Readonly<{
  getImmediateDecision: NonNullable<AcpPermissionHandler['getImmediateDecision']>;
  respondToPermissionRequest: (toolCallId: string, approved: boolean) => void;
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
  backendId: string;
  toolName: string;
}>): { decision: 'approved' | 'approved_for_session' | 'denied' } | null {
  const rawLower = String(args.permissionMode ?? '').trim().toLowerCase();
  const normalizedMode = permissionMode(args.permissionMode);

  if (shouldAlwaysApproveExecutionRunTool(args.toolName)) return { decision: 'approved' };

  // Execution runs still support legacy "no_tools" semantics: deny everything except the shared-safe tools
  // (e.g. title changes) regardless of how it normalizes onto the canonical PermissionMode surface.
  if (rawLower === 'no_tools') return { decision: 'denied' };

  if (normalizedMode === 'read-only' || normalizedMode === 'plan') {
    return isExecutionRunWriteLikeToolName(args.toolName) ? { decision: 'denied' } : { decision: 'approved' };
  }

  if (normalizedMode === 'yolo') {
    return { decision: 'approved_for_session' };
  }

  if (normalizedMode === 'safe-yolo') {
    // Safe-yolo: auto-approve read-like tools, prompt for write-like tools.
    return isExecutionRunWriteLikeToolName(args.toolName) ? null : { decision: 'approved' };
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
  backendId: string;
  toolName: string;
}>): 'approved_for_session' | 'denied' {
  const immediate = resolveExecutionRunImmediateDecision(args);
  if (!immediate) return 'denied';
  return immediate.decision === 'denied' ? 'denied' : 'approved_for_session';
}

export function createExecutionRunPermissionHandler(args: Readonly<{
  permissionMode: string;
  backendId: string;
}>): ExecutionRunPermissionHandler {
  const pending = new Map<string, { resolve: (value: { decision: 'approved' | 'denied' }) => void }>();
  const buffered = new Map<string, { approved: boolean }>();

  function respondToPermissionRequest(toolCallId: string, approved: boolean): void {
    const request = pending.get(toolCallId) ?? null;
    if (!request) {
      buffered.set(toolCallId, { approved });
      return;
    }
    pending.delete(toolCallId);
    request.resolve({ decision: approved ? 'approved' : 'denied' });
  }

  function readImmediate(toolCallId: string, toolName: string, input: unknown) {
    // Execution runs treat the ACP permission id as the toolCallId for correlation.
    const bufferedResponse = buffered.get(toolCallId) ?? null;
    if (bufferedResponse) {
      buffered.delete(toolCallId);
      return { decision: bufferedResponse.approved ? 'approved' : 'denied' } as const;
    }

    return resolveExecutionRunImmediateDecision({
      permissionMode: args.permissionMode,
      backendId: args.backendId,
      toolName,
    });
  }

  return {
    respondToPermissionRequest,
    getImmediateDecision(toolCallId, toolName, input) {
      return readImmediate(toolCallId, toolName, input);
    },
    async handleToolCall(toolCallId, toolName, input) {
      const immediate = readImmediate(toolCallId, toolName, input);
      if (immediate) return immediate;

      return await new Promise<{ decision: 'approved' | 'denied' }>((resolve) => {
        pending.set(toolCallId, { resolve });
      });
    },
  };
}
