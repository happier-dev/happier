import {
  isAgentStateRequestCoveredByCompletedRequests,
  type AgentStateRequestCoverageOptions,
} from '@happier-dev/agents';
import type { AgentState } from '../types';
import { resolveAgentRequestKind } from '@/agent/permissions/requestKind';
import { SessionUserActionRequiredOccurrenceV1Schema } from '@happier-dev/protocol/sessions/userActionRequiredOccurrenceV1';
import { resolvePendingRequestAttentionReasonV1 } from '@happier-dev/protocol/sessions/personal/attention';
import type { SessionUserActionRequiredOccurrenceV1 } from '@happier-dev/protocol';
import { SessionQuestionContextV1Schema, SessionQuestionHandlerV1Schema } from '@happier-dev/protocol/sessions/permissions/questionV1';
import { resolveRequestFollowEventV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

type ActivitySummary = Readonly<{
  pendingPermissionRequestCount: number;
  pendingUserActionRequestCount: number;
  pendingRequestNewestCreatedAt: number | null;
  newUserActionRequiredOccurrences: readonly SessionUserActionRequiredOccurrenceV1[];
}>;

function isCoveredByCompletedRequest(
  completedRequests: NonNullable<AgentState['completedRequests']> | null | undefined,
  requestId: string,
  request: unknown,
  requestCoverage?: AgentStateRequestCoverageOptions,
): boolean {
  return isAgentStateRequestCoveredByCompletedRequests({
    requestId,
    request,
    completedRequests: completedRequests as Record<string, unknown> | null | undefined,
    options: requestCoverage,
  });
}

function readRequestCreatedAt(request: unknown): number | null {
  if (!request || typeof request !== 'object') return null;
  const createdAt = (request as { createdAt?: unknown }).createdAt;
  return typeof createdAt === 'number' && Number.isFinite(createdAt)
    ? Math.max(0, Math.floor(createdAt))
    : null;
}

export function deriveActivitySummaryFromAgentState(
  agentState: AgentState | null | undefined,
  previousAgentState?: AgentState | null,
  requestCoverage?: AgentStateRequestCoverageOptions,
): ActivitySummary {
  const requests = agentState?.requests;
  const completedRequests = agentState?.completedRequests ?? null;
  if (!requests || typeof requests !== 'object') {
    return {
      pendingPermissionRequestCount: 0,
      pendingUserActionRequestCount: 0,
      pendingRequestNewestCreatedAt: null,
      newUserActionRequiredOccurrences: [],
    };
  }

  let pendingPermissionRequestCount = 0;
  let pendingUserActionRequestCount = 0;
  let pendingRequestNewestCreatedAt: number | null = null;
  const newUserActionRequiredOccurrences: SessionUserActionRequiredOccurrenceV1[] = [];
  const previousRequests = previousAgentState?.requests;
  const previousCompletedRequests = previousAgentState?.completedRequests;

  for (const [requestId, request] of Object.entries(requests)) {
    if (!request || typeof request !== 'object') continue;
    const toolName = typeof request.tool === 'string' ? request.tool : '';
    if (!toolName) continue;
    if (isCoveredByCompletedRequest(completedRequests, requestId, request, requestCoverage)) continue;

    const kind = request.kind === 'user_action' || request.kind === 'permission'
      ? request.kind
      : resolveAgentRequestKind(toolName);

    const attentionReason = resolvePendingRequestAttentionReasonV1({ kind, source: request.source });
    if (attentionReason === 'user_action_required') {
      pendingUserActionRequestCount += 1;
    } else {
      pendingPermissionRequestCount += 1;
    }
    const createdAt = readRequestCreatedAt(request);
    if (createdAt !== null) {
      pendingRequestNewestCreatedAt =
        pendingRequestNewestCreatedAt === null
          ? createdAt
          : Math.max(pendingRequestNewestCreatedAt, createdAt);
    }

    const requestRecord = request as Record<string, unknown>;
    const existedBefore = Boolean(
      previousRequests?.[requestId] || previousCompletedRequests?.[requestId],
    );
    if (
      !existedBefore
      && typeof requestRecord.subagentRef === 'undefined'
      && typeof requestRecord.sidechainId !== 'string'
    ) {
      const question = SessionQuestionContextV1Schema.safeParse(request.questionV1);
      const handler = SessionQuestionHandlerV1Schema.safeParse(request.currentHandler);
      if (request.questionV1 !== undefined && !question.success
        || request.currentHandler !== undefined && !handler.success) continue;
      const occurrence = SessionUserActionRequiredOccurrenceV1Schema.safeParse({
        requestId,
        sourceTurnId: requestRecord.turnId,
        requestKind: kind,
        occurredAt: createdAt,
        followEvent: resolveRequestFollowEventV1({
          requestKind: attentionReason === 'permission_required' ? 'permission' : 'user_action',
          questionV1: question.data, currentHandler: handler.data,
        }),
      });
      if (occurrence.success) {
        newUserActionRequiredOccurrences.push(occurrence.data);
      }
    }
  }

  return {
    pendingPermissionRequestCount,
    pendingUserActionRequestCount,
    pendingRequestNewestCreatedAt,
    newUserActionRequiredOccurrences,
  };
}
