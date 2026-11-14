import { isAgentStateRequestCoveredByCompletedRequests, type AgentStateRequestCoverageOptions } from '@happier-dev/agents';
import { readRunScopedExecutionPermissionRequestIdentity } from '@happier-dev/protocol/execution/runs/runPrimitives';
import { SessionQuestionContextV1Schema, SessionQuestionHandlerV1Schema } from '@happier-dev/protocol/sessions/permissions/v1';
import { resolveRequestFollowEventV1, type FollowEventV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { resolvePendingRequestAttentionReasonV1 } from '@happier-dev/protocol/sessions/personal/attention';
import { resolveAgentRequestKind } from './requestKind';

/** The request owner's canonical semantic event, shared by publication and current reads. */
export function readForegroundAgentRequestFollowEvent(request: Readonly<{
  tool: string; source?: string; questionV1?: unknown; currentHandler?: unknown;
}>): FollowEventV1 | null {
  const question = SessionQuestionContextV1Schema.safeParse(request.questionV1);
  const handler = SessionQuestionHandlerV1Schema.safeParse(request.currentHandler);
  if (request.questionV1 !== undefined && !question.success
    || request.currentHandler !== undefined && !handler.success) return null;
  return resolveRequestFollowEventV1({ requestKind: resolvePendingRequestAttentionReasonV1({
    kind: resolveAgentRequestKind(request.tool), source: request.source,
  }) === 'permission_required' ? 'permission' : 'user_action', questionV1: question.data, currentHandler: handler.data });
}

/** The foreground request owner's exact active originals; state version is not request identity. */
export function readActiveForegroundAgentRequests<Request extends object>(state: Readonly<{
  requests?: Readonly<Record<string, Request>> | null; completedRequests?: Record<string, unknown> | null;
}>, requestCoverage?: AgentStateRequestCoverageOptions): readonly (
  readonly [requestId: string, request: Request & Readonly<{ createdAt: number }>]
)[] {
  return Object.entries(state.requests ?? {}).filter((entry): entry is [string, Request & Readonly<{ createdAt: number }>] => {
    const [requestId, request] = entry;
    return 'createdAt' in request && typeof request.createdAt === 'number' && Number.isFinite(request.createdAt)
    && !('sidechainId' in request && request.sidechainId)
    && !readRunScopedExecutionPermissionRequestIdentity(requestId)
    && !isAgentStateRequestCoveredByCompletedRequests({ requestId, request, completedRequests: state.completedRequests,
      options: requestCoverage });
  })
    .sort(([left], [right]) => left.localeCompare(right));
}
