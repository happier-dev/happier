import { randomUUID } from 'node:crypto';

import type { AgentMessage } from '@/agent/core/AgentBackend';
import { isReadOnlyClaudeSdkToolAllowed } from './isReadOnlyClaudeSdkToolAllowed';
import type { ClaudePermissionDecision, ClaudeSdkPermissionPolicy, PendingClaudePermissionRequest } from './types';

type ClaudeSdkCanCallTool = (toolName: string, input: unknown) => Promise<ClaudePermissionDecision>;

export function createClaudeSdkCanCallTool(params: Readonly<{
  emit: (message: AgentMessage) => void;
  pendingPermissionRequests: Map<string, PendingClaudePermissionRequest>;
  permissionPolicy: ClaudeSdkPermissionPolicy;
}>): ClaudeSdkCanCallTool {
  if (params.permissionPolicy === 'no_tools') {
    return async () => ({ behavior: 'deny', message: 'Tools are disabled for voice agent.', interrupt: true });
  }

  if (params.permissionPolicy === 'workspace_write') {
    return async (_toolName: string, input: unknown) => ({
      behavior: 'allow',
      updatedInput: normalizeToolInput(input),
    });
  }

  if (params.permissionPolicy === 'parent_session_prompt') {
    return async (toolName: string, input: unknown) => {
      const updatedInput = normalizeToolInput(input);
      const requestId = randomUUID();
      return await new Promise<ClaudePermissionDecision>((resolve) => {
        params.pendingPermissionRequests.set(requestId, {
          toolName,
          input: updatedInput,
          resolve,
        });
        params.emit({
          type: 'permission-request',
          id: requestId,
          reason: toolName,
          payload: {
            toolName,
            input: updatedInput,
          },
        });
      });
    };
  }

  return async (toolName: string, input: unknown) => {
    if (!isReadOnlyClaudeSdkToolAllowed(toolName, input)) {
      return { behavior: 'deny', message: `Tool denied by voice agent policy: ${toolName}`, interrupt: true };
    }
    return {
      behavior: 'allow',
      updatedInput: normalizeToolInput(input),
    };
  };
}

export function respondToClaudeSdkPermissionRequest(params: Readonly<{
  approved: boolean;
  emit: (message: AgentMessage) => void;
  pendingPermissionRequests: Map<string, PendingClaudePermissionRequest>;
  requestId: string;
}>): void {
  const request = params.pendingPermissionRequests.get(params.requestId);
  if (!request) return;
  params.pendingPermissionRequests.delete(params.requestId);
  request.resolve(
    params.approved
      ? { behavior: 'allow', updatedInput: request.input }
      : { behavior: 'deny', message: `Tool denied by parent session policy: ${request.toolName}`, interrupt: true },
  );
  params.emit({ type: 'permission-response', id: params.requestId, approved: params.approved });
}

export function resolveClaudeSdkPendingPermissionRequests(params: Readonly<{
  approved: boolean;
  emit: (message: AgentMessage) => void;
  emitResponses: boolean;
  pendingPermissionRequests: Map<string, PendingClaudePermissionRequest>;
  reason: string;
}>): void {
  if (params.pendingPermissionRequests.size === 0) return;
  for (const [requestId, request] of params.pendingPermissionRequests.entries()) {
    request.resolve(
      params.approved
        ? { behavior: 'allow', updatedInput: request.input }
        : { behavior: 'deny', message: params.reason, interrupt: true },
    );
    if (params.emitResponses) {
      params.emit({ type: 'permission-response', id: requestId, approved: params.approved });
    }
  }
  params.pendingPermissionRequests.clear();
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}
