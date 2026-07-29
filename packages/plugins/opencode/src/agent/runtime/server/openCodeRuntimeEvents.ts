import type {
  OpenCodeRuntimeEvent,
  OpenCodeRuntimeIssue,
} from './runtimeEvents.js';

export function buildOpenCodeRuntimeIssue(params: Readonly<{
  code: string;
  source: string;
  message?: string | null;
  occurredAt: number;
  usageLimit?: OpenCodeRuntimeIssue['usageLimit'];
}>): OpenCodeRuntimeIssue {
  return {
    v: 1,
    code: params.code,
    source: params.source,
    occurredAt: params.occurredAt,
    agentId: 'opencode',
    sanitizedPreview: params.message ?? null,
    ...(params.usageLimit ? { usageLimit: params.usageLimit } : {}),
  };
}

export async function publishOpenCodeRuntimeEvent(
  publishRuntimeEvent: (event: OpenCodeRuntimeEvent) => void,
  event: OpenCodeRuntimeEvent,
): Promise<void> {
  publishRuntimeEvent(event);
}

export async function publishOpenCodeTurnFailed(params: Readonly<{
  publishRuntimeEvent: (event: OpenCodeRuntimeEvent) => void;
  sessionId: string;
  turnId: string;
  issue: OpenCodeRuntimeIssue;
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
    agentId: 'opencode',
    localId: `${params.turnId}:turn_failed`,
    body: {
      type: 'turn_failed',
      id: params.turnId,
    },
  });
}

export async function publishOpenCodeTurnCancelled(params: Readonly<{
  publishRuntimeEvent: (event: OpenCodeRuntimeEvent) => void;
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
    agentId: 'opencode',
    localId: `${params.turnId}:turn_cancelled`,
    body: {
      type: 'turn_cancelled',
      id: params.turnId,
    },
  });
}
