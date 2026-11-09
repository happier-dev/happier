import type { AcpPermissionCallContext } from '@/agent/acp/permissions/acpPermissionHandler';
import { NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE } from '@happier-dev/protocol/sessions/permissions/v1';
import { resolveAgentRequestKind as resolveProtocolAgentRequestKind, type AgentRequestKind } from '@happier-dev/protocol/activity/agentRequestSummary';

export type { AgentRequestKind };

/** Host Action confirmation shares request delivery, never native tool policy. */
export const HAPPIER_ACTION_REQUEST_SOURCE = 'happier_action';
export const SESSION_NEEDS_YOU_REQUEST_SOURCE = 'session.needs_you.raise';

export function isAgentStructuredQuestionToolName(toolName: string): boolean {
  return toolName === 'AskUserQuestion' || toolName === 'ask_user_question';
}

/** Approval presentation cannot turn a permission grant into an ordinary question. */
export function isAgentStructuredQuestionRequest(request: Readonly<{
  toolName: string;
  kind?: string;
  source?: string;
}>): boolean {
  return isAgentStructuredQuestionToolName(request.toolName)
    && request.kind !== 'permission'
    && request.source !== NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE
    && request.source !== HAPPIER_ACTION_REQUEST_SOURCE;
}

/** Durable questions outlive a detached waiter; occurrence questions end with their native owner. */
export function isDurableAgentStructuredQuestionRequest(request: Parameters<typeof isAgentStructuredQuestionRequest>[0] & Readonly<{
  lifetime?: unknown;
}>): boolean {
  return isAgentStructuredQuestionRequest(request) && request.lifetime !== 'occurrence';
}

/** A host-bound occurrence question requests an answer without granting tool authority. */
export function isHostOccurrenceQuestion(toolName: string, context: AcpPermissionCallContext | undefined): boolean {
  return context?.origin === 'host_occurrence_question'
    && context.lifetime === 'occurrence'
    && isAgentStructuredQuestionToolName(toolName);
}

export function resolveAgentRequestKind(toolName: string, requestKind?: unknown): AgentRequestKind {
  const normalized = typeof toolName === 'string' ? toolName.trim() : '';
  return resolveProtocolAgentRequestKind({ toolName: normalized, requestKind });
}
