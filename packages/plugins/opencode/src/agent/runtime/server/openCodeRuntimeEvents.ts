import type { RuntimeEventV1, SessionRuntimeIssueV1 } from '@happier-dev/protocol';

export function buildOpenCodeRuntimeIssue(params: Readonly<{
  code: string;
  source: SessionRuntimeIssueV1['source'];
  message?: string | null;
  occurredAt: number;
  usageLimit?: SessionRuntimeIssueV1['usageLimit'];
}>): SessionRuntimeIssueV1 {
  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: params.code,
    source: params.source,
    occurredAt: params.occurredAt,
    provider: 'opencode',
    ...(params.message ? { sanitizedPreview: params.message.slice(0, 2_000) } : {}),
    ...(params.usageLimit ? { usageLimit: params.usageLimit } : {}),
  };
}

export async function publishOpenCodeRuntimeEvent(
  publishRuntimeEvent: (event: RuntimeEventV1) => void,
  event: RuntimeEventV1,
): Promise<void> {
  publishRuntimeEvent(event);
}

export async function publishOpenCodeTurnFailed(params: Readonly<{
  publishRuntimeEvent: (event: RuntimeEventV1) => void;
  sessionId: string;
  turnId: string;
  issue: SessionRuntimeIssueV1;
  emittedAtMs: number;
}>): Promise<void> {
  await publishOpenCodeRuntimeEvent(params.publishRuntimeEvent, {
    kind: 'turn-failed',
    sessionId: params.sessionId,
    turnId: params.turnId,
    emittedAtMs: params.emittedAtMs,
    issue: params.issue,
  });
  await publishOpenCodeRuntimeEvent(params.publishRuntimeEvent, {
    kind: 'transcript-agent-message-committed',
    sessionId: params.sessionId,
    emittedAtMs: params.emittedAtMs,
    provider: 'opencode',
    localId: `${params.turnId}:turn_failed`,
    body: {
      type: 'turn_failed',
      id: params.turnId,
    },
  });
}

export async function publishOpenCodeTurnCancelled(params: Readonly<{
  publishRuntimeEvent: (event: RuntimeEventV1) => void;
  sessionId: string;
  turnId: string;
  reason?: string;
  emittedAtMs: number;
}>): Promise<void> {
  await publishOpenCodeRuntimeEvent(params.publishRuntimeEvent, {
    kind: 'turn-cancelled',
    sessionId: params.sessionId,
    turnId: params.turnId,
    emittedAtMs: params.emittedAtMs,
    ...(params.reason ? { reason: params.reason } : {}),
  });
  await publishOpenCodeRuntimeEvent(params.publishRuntimeEvent, {
    kind: 'transcript-agent-message-committed',
    sessionId: params.sessionId,
    emittedAtMs: params.emittedAtMs,
    provider: 'opencode',
    localId: `${params.turnId}:turn_cancelled`,
    body: {
      type: 'turn_cancelled',
      id: params.turnId,
    },
  });
}
