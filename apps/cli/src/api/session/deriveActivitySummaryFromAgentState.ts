import {
  isAgentStateRequestCoveredByCompletedRequests,
  resolveAgentStateRequestCoverageOptions,
} from '@happier-dev/agents';
import type { AgentState } from '../types';
import { resolveAgentRequestKind } from '@/agent/permissions/requestKind';

type ActivitySummary = Readonly<{
  pendingPermissionRequestCount: number;
  pendingUserActionRequestCount: number;
  pendingRequestNewestCreatedAt: number | null;
}>;

const PENDING_REQUEST_COVERAGE_OPTIONS = resolveAgentStateRequestCoverageOptions({
  kind: 'localPermissionBridge',
});

function isCoveredByCompletedRequest(
  completedRequests: NonNullable<AgentState['completedRequests']> | null | undefined,
  requestId: string,
  request: unknown,
): boolean {
  return isAgentStateRequestCoveredByCompletedRequests({
    requestId,
    request,
    completedRequests: completedRequests as Record<string, unknown> | null | undefined,
    options: PENDING_REQUEST_COVERAGE_OPTIONS,
  });
}

function readRequestCreatedAt(request: unknown): number | null {
  if (!request || typeof request !== 'object') return null;
  const createdAt = (request as { createdAt?: unknown }).createdAt;
  return typeof createdAt === 'number' && Number.isFinite(createdAt)
    ? Math.max(0, Math.floor(createdAt))
    : null;
}

export function deriveActivitySummaryFromAgentState(agentState: AgentState | null | undefined): ActivitySummary {
  const requests = agentState?.requests;
  const completedRequests = agentState?.completedRequests ?? null;
  if (!requests || typeof requests !== 'object') {
    return {
      pendingPermissionRequestCount: 0,
      pendingUserActionRequestCount: 0,
      pendingRequestNewestCreatedAt: null,
    };
  }

  let pendingPermissionRequestCount = 0;
  let pendingUserActionRequestCount = 0;
  let pendingRequestNewestCreatedAt: number | null = null;

  for (const [requestId, request] of Object.entries(requests)) {
    if (!request || typeof request !== 'object') continue;
    const toolName = typeof request.tool === 'string' ? request.tool : '';
    if (!toolName) continue;
    if (isCoveredByCompletedRequest(completedRequests, requestId, request)) continue;

    const kind = request.kind === 'user_action' || request.kind === 'permission'
      ? request.kind
      : resolveAgentRequestKind(toolName);

    if (kind === 'user_action') {
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
  }

  return {
    pendingPermissionRequestCount,
    pendingUserActionRequestCount,
    pendingRequestNewestCreatedAt,
  };
}
