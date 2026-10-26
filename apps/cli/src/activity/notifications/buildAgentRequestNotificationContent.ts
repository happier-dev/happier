import { projectNotificationQuestion } from '@happier-dev/protocol';
import type { AgentRequestKind } from '../../agent/permissions/requestKind';

function firstString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function buildAgentRequestNotificationContent(params: Readonly<{
  kind: AgentRequestKind;
  sessionId: string;
  sessionTitle?: string | null;
  agentDisplayName?: string | null;
  requestId: string;
  occurrenceId?: string;
  toolName: string;
  toolDetails?: string | null;
  toolInput?: unknown;
}>): Readonly<{ title: string; body: string; data: Record<string, unknown> }> {
  const type = params.kind === 'user_action' ? 'user_action_request' : 'permission_request';
  const title = firstString(params.sessionTitle) ?? firstString(params.sessionId) ?? 'Session';
  const agentDisplayName = firstString(params.agentDisplayName) ?? 'Agent';
  const toolName = firstString(params.toolName) ?? 'tool';
  const details = typeof params.toolDetails === 'string' && params.toolDetails.trim() ? params.toolDetails.trim() : null;
  const question = params.kind === 'user_action' && params.occurrenceId
    ? projectNotificationQuestion(params.toolName, params.toolInput) : null;
  const body = question?.body ?? (params.kind === 'user_action'
    ? details
      ? `${agentDisplayName} needs your input for ${toolName}\n${details}`
      : `${agentDisplayName} needs your input for ${toolName}`
    : details
      ? `${agentDisplayName} asks permission to use ${toolName}\n${details}`
      : `${agentDisplayName} asks permission to use ${toolName}`);

  return {
    title,
    body,
    data: {
      sessionId: params.sessionId,
      requestId: params.requestId,
      ...(question ? { questionAnswerV1: question.descriptor } : {}),
      ...(params.occurrenceId ? { occurrenceId: params.occurrenceId } : {}),
      tool: params.toolName,
      type,
      kind: params.kind,
    },
  };
}
