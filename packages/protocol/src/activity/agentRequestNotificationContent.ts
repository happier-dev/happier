import {
  summarizeToolInputForNotification,
  type AgentRequestKind,
} from './agentRequestSummary.js';

export function buildAgentRequestNotificationContent(params: Readonly<{
  kind: AgentRequestKind;
  sessionId: string;
  requestId: string;
  toolName: string;
  toolInput?: unknown;
  toolDetails?: string | null;
}>): Readonly<{
  title: string;
  body: string;
  data: Record<string, unknown>;
  toolDetails: string | null;
}> {
  const type = params.kind === 'user_action' ? 'user_action_request' : 'permission_request';
  const title = params.kind === 'user_action' ? 'Action Required' : 'Permission Request';
  const toolDetails = typeof params.toolDetails === 'string' && params.toolDetails.trim()
    ? params.toolDetails.trim()
    : summarizeToolInputForNotification(params.toolName, params.toolInput);
  const body = params.kind === 'user_action'
    ? toolDetails
      ? `Input needed for: ${params.toolName}\n${toolDetails}`
      : `Input needed for: ${params.toolName}`
    : toolDetails
      ? `Approval needed for: ${params.toolName}\n${toolDetails}`
      : `Approval needed for: ${params.toolName}`;

  return {
    title,
    body,
    data: {
      sessionId: params.sessionId,
      requestId: params.requestId,
      tool: params.toolName,
      type,
      kind: params.kind,
    },
    toolDetails: toolDetails ?? null,
  };
}
