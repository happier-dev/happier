import type { PluginContextV1, RuntimeEventV1 } from '@happier-dev/plugin-sdk';
import type { SessionRuntimeIssueV1 } from '@happier-dev/plugin-sdk/experimental/runtime/session';

export type ClaudeUnifiedRuntimeEventHandler = (event: RuntimeEventV1) => void;

export function publishClaudeUnifiedRuntimeEvent(params: Readonly<{
  handlers: ReadonlySet<ClaudeUnifiedRuntimeEventHandler>;
  logger: PluginContextV1['logger'];
  event: RuntimeEventV1;
}>): void {
  for (const handler of Array.from(params.handlers)) {
    try {
      handler(params.event);
    } catch (error) {
      params.logger.warn('[ClaudeUnifiedTerminal] runtime event handler failed', {
        eventKind: params.event.kind,
        error,
      });
    }
  }
}

/**
 * Marks turns allocated solely to surface a session-scoped runtime issue (idle host death,
 * readiness timeout). The session-turn lifecycle only commits failures for turns it has seen
 * begin, so these failures publish begin+fail as a pair; `startedBy` keeps the allocation
 * distinguishable from real prompt/steer turns.
 */
export const CLAUDE_UNIFIED_RUNTIME_ISSUE_TURN_STARTED_BY = 'session_runtime_issue';

export function publishClaudeUnifiedTurnStart(params: Readonly<{
  handlers: ReadonlySet<ClaudeUnifiedRuntimeEventHandler>;
  logger: PluginContextV1['logger'];
  sessionId: string;
  turnId: string;
  emittedAtMs: number;
  startedBy?: string;
}>): void {
  publishClaudeUnifiedRuntimeEvent({
    handlers: params.handlers,
    logger: params.logger,
    event: {
      kind: 'turn-start',
      sessionId: params.sessionId,
      turnId: params.turnId,
      emittedAtMs: params.emittedAtMs,
      ...(params.startedBy ? { startedBy: params.startedBy } : {}),
    },
  });
}

export function publishClaudeUnifiedTurnFailed(params: Readonly<{
  handlers: ReadonlySet<ClaudeUnifiedRuntimeEventHandler>;
  logger: PluginContextV1['logger'];
  sessionId: string;
  turnId: string;
  issue: SessionRuntimeIssueV1;
}>): void {
  publishClaudeUnifiedRuntimeEvent({
    handlers: params.handlers,
    logger: params.logger,
    event: {
      kind: 'turn-failed',
      sessionId: params.sessionId,
      turnId: params.turnId,
      emittedAtMs: params.issue.occurredAt,
      issue: params.issue,
    },
  });
}

export function publishClaudeUnifiedTurnComplete(params: Readonly<{
  handlers: ReadonlySet<ClaudeUnifiedRuntimeEventHandler>;
  logger: PluginContextV1['logger'];
  sessionId: string;
  turnId: string;
  emittedAtMs: number;
}>): void {
  publishClaudeUnifiedRuntimeEvent({
    handlers: params.handlers,
    logger: params.logger,
    event: {
      kind: 'turn-complete',
      sessionId: params.sessionId,
      turnId: params.turnId,
      emittedAtMs: params.emittedAtMs,
    },
  });
}

export function publishClaudeUnifiedTurnCancelled(params: Readonly<{
  handlers: ReadonlySet<ClaudeUnifiedRuntimeEventHandler>;
  logger: PluginContextV1['logger'];
  sessionId: string;
  turnId: string;
  emittedAtMs: number;
  reason?: string;
}>): void {
  publishClaudeUnifiedRuntimeEvent({
    handlers: params.handlers,
    logger: params.logger,
    event: {
      kind: 'turn-cancelled',
      sessionId: params.sessionId,
      turnId: params.turnId,
      emittedAtMs: params.emittedAtMs,
      ...(params.reason ? { reason: params.reason } : {}),
    },
  });
}
