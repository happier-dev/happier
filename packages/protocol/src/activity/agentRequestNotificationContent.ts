import { projectNotificationQuestion } from '../push/notificationQuestionActions.js';
import {
  buildAgentRequestSemanticSummary,
  requiresFullFormForRemoteUserAction,
  summarizeToolInputForNotification,
  type AgentRequestKind,
} from './agentRequestSummary.js';

export function buildAgentRequestNotificationContent(params: Readonly<{
  kind: AgentRequestKind;
  sessionId: string;
  sessionTitle?: string | null;
  agentDisplayName?: string | null;
  requestId: string;
  turnId?: string;
  toolName: string;
  toolInput?: unknown;
  /** The host's display name for the tool (see `AgentRequestSemanticSummary.toolLabel`). */
  toolLabel?: string | null;
  toolDetails?: string | null;
  includeMessageText?: boolean;
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
    toolLabel: params.toolLabel,
  });
  const fullFormRequired = params.kind === 'user_action' && requiresFullFormForRemoteUserAction(summary.questions);
  const question = params.includeMessageText !== false && params.turnId ? projectNotificationQuestion(summary) : null;
  const toolDetails = params.includeMessageText === false ? null : !fullFormRequired && typeof params.toolDetails === 'string' && params.toolDetails.trim()
    ? params.toolDetails.trim()
    : summarizeToolInputForNotification(params.toolName, params.toolInput);
  const body = question?.body ?? (params.kind === 'user_action'
    ? toolDetails
      ? `${agentDisplayName} needs your input for ${summary.toolLabel}\n${toolDetails}`
      : `${agentDisplayName} needs your input for ${summary.toolLabel}`
    : toolDetails
      ? `${agentDisplayName} asks permission to use ${summary.toolLabel}\n${toolDetails}`
      : `${agentDisplayName} asks permission to use ${summary.toolLabel}`);

  return {
    title,
    body,
    data: {
      sessionId: params.sessionId,
      requestId: params.requestId,
      ...(params.turnId ? { turnId: params.turnId } : {}),
      ...(question ? { questionAnswerV1: question.descriptor } : {}),
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
