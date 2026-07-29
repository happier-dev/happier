import type { ExecutionRunHostActionApprovalRequestV1 } from '@happier-dev/protocol';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function subject(request: ExecutionRunHostActionApprovalRequestV1): unknown {
  return {
    v: request.v,
    kind: request.kind,
    createdAtMs: request.createdAtMs,
    createdBy: request.createdBy,
    requestedSurface: request.requestedSurface,
    actionId: request.actionId,
    sessionId: request.sessionId,
    runId: request.runId,
    callId: request.callId,
    profileId: request.profileId,
    pluginId: request.pluginId,
    agentId: request.agentId,
    projectId: request.projectId,
    workspaceId: request.workspaceId,
    serverId: request.serverId,
    proposalCount: request.proposalCount,
    proposalPreview: request.proposalPreview,
    subjectFingerprint: request.subjectFingerprint,
    summary: request.summary,
  };
}

export function executionRunHostActionApprovalSubjectsEqual(
  left: ExecutionRunHostActionApprovalRequestV1,
  right: ExecutionRunHostActionApprovalRequestV1,
): boolean {
  return stable(subject(left)) === stable(subject(right));
}

export function executionRunHostActionApprovalRequestsEqual(
  left: ExecutionRunHostActionApprovalRequestV1,
  right: ExecutionRunHostActionApprovalRequestV1,
): boolean {
  return stable(left) === stable(right);
}
