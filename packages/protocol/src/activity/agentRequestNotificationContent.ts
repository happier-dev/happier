import {
  buildAgentRequestSemanticSummary,
  summarizeToolInputForNotification,
  type AgentRequestKind,
} from './agentRequestSummary.js';

export function buildAgentRequestNotificationContent(params: Readonly<{
  kind: AgentRequestKind;
  sessionId: string;
  sessionTitle?: string | null;
  agentDisplayName?: string | null;
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
  const title = resolveSessionNotificationTitle({
    sessionId: params.sessionId,
    sessionTitle: params.sessionTitle,
  });
  const agentDisplayName = normalizeDisplayText(params.agentDisplayName) ?? 'Agent';
  const summary = buildAgentRequestSemanticSummary({
    kind: params.kind,
    toolName: params.toolName,
    toolInput: params.toolInput,
  });
  const toolDetails = typeof params.toolDetails === 'string' && params.toolDetails.trim()
    ? params.toolDetails.trim()
    : summarizeToolInputForNotification(params.toolName, params.toolInput);
  const body = params.kind === 'user_action'
    ? toolDetails
      ? `${agentDisplayName} needs your input for ${summary.normalizedToolLabel}\n${toolDetails}`
      : `${agentDisplayName} needs your input for ${summary.normalizedToolLabel}`
    : toolDetails
      ? `${agentDisplayName} asks permission to use ${summary.normalizedToolLabel}\n${toolDetails}`
      : `${agentDisplayName} asks permission to use ${summary.normalizedToolLabel}`;

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

function normalizeDisplayText(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function resolveSessionNotificationTitle(params: Readonly<{
  sessionId: string;
  sessionTitle?: string | null;
}>): string {
  const explicitTitle = normalizeDisplayText(params.sessionTitle);
  if (explicitTitle) return explicitTitle;
  const normalizedSessionId = normalizeDisplayText(params.sessionId);
  return normalizedSessionId ? `Session ${normalizedSessionId.slice(0, 8)}` : 'Session';
}
