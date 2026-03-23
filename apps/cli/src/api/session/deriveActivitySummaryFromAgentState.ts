import type { AgentState } from '../types';
import { resolveAgentRequestKind } from '@/agent/permissions/requestKind';

type ActivitySummary = Readonly<{
  pendingPermissionRequestCount: number;
  pendingUserActionRequestCount: number;
}>;

function getCompletedAt(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const completedAt = typeof (value as { completedAt?: unknown }).completedAt === 'number'
    ? (value as { completedAt: number }).completedAt
    : 0;
  const createdAt = typeof (value as { createdAt?: unknown }).createdAt === 'number'
    ? (value as { createdAt: number }).createdAt
    : 0;
  return Math.max(completedAt, createdAt);
}

function isCoveredByCompletedRequest(
  completedRequests: NonNullable<AgentState['completedRequests']> | null | undefined,
  requestId: string,
  createdAt: number,
): boolean {
  if (!completedRequests || typeof completedRequests !== 'object') return false;
  const completed = completedRequests[requestId];
  if (!completed) return false;
  return createdAt <= getCompletedAt(completed);
}

export function deriveActivitySummaryFromAgentState(agentState: AgentState | null | undefined): ActivitySummary {
  const requests = agentState?.requests;
  const completedRequests = agentState?.completedRequests ?? null;
  if (!requests || typeof requests !== 'object') {
    return {
      pendingPermissionRequestCount: 0,
      pendingUserActionRequestCount: 0,
    };
  }

  let pendingPermissionRequestCount = 0;
  let pendingUserActionRequestCount = 0;

  for (const [requestId, request] of Object.entries(requests)) {
    if (!request || typeof request !== 'object') continue;
    const toolName = typeof request.tool === 'string' ? request.tool : '';
    if (!toolName) continue;
    const createdAt = typeof request.createdAt === 'number' ? request.createdAt : 0;
    if (isCoveredByCompletedRequest(completedRequests, requestId, createdAt)) continue;

    const kind = request.kind === 'user_action' || request.kind === 'permission'
      ? request.kind
      : resolveAgentRequestKind(toolName);

    if (kind === 'user_action') {
      pendingUserActionRequestCount += 1;
    } else {
      pendingPermissionRequestCount += 1;
    }
  }

  return {
    pendingPermissionRequestCount,
    pendingUserActionRequestCount,
  };
}
