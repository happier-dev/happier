import { randomUUID } from 'node:crypto';

import type { PluginContextV1 } from '@happier-dev/plugin-sdk';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';

import {
  buildClaudeProcessExitRuntimeIssue,
  buildClaudeRuntimeIssue,
} from '../../issues/runtimeIssues.js';
import {
  CLAUDE_UNIFIED_RUNTIME_ISSUE_TURN_STARTED_BY,
  publishClaudeUnifiedTurnFailed,
  publishClaudeUnifiedTurnStart,
  type ClaudeUnifiedRuntimeEventHandler,
} from './runtimeEvents.js';

/**
 * Classified terminal-injection failure (failed_terminal exit contract, incident pid-82626):
 * the error a turn rejects with when prompt injection/provider acceptance terminally failed.
 * The stable `code` + `failureState` let host loops park-and-await-the-next-message instead of
 * treating the rejection as an opaque process-killing fatal.
 */
export class ClaudeUnifiedTerminalInjectionFailureError extends Error {
  readonly code = 'claude_unified_terminal_injection_failed';
  readonly failureState: 'failed_terminal' | 'failed_ambiguous';

  constructor(message: string, failureState: 'failed_terminal' | 'failed_ambiguous') {
    super(message);
    this.name = 'ClaudeUnifiedTerminalInjectionFailureError';
    this.failureState = failureState;
  }
}

type ClaudeUnifiedFailurePublicationParams = Readonly<{
  handlers: ReadonlySet<ClaudeUnifiedRuntimeEventHandler>;
  logger: PluginContextV1['logger'];
  publishedFailureTurnIds: Set<string>;
  sessionId: string;
  turnId: string | null;
  /**
   * Opt-in for SESSION-SCOPED failures (idle host death, readiness timeout): when no turn is
   * active, allocate one so the failure surfaces as a structured failed turn instead of a
   * silent no-op, and publish begin+fail (`turn-start` then `turn-failed`) so the session-turn
   * lifecycle — which only commits failures for turns it has seen begin — records it. Without
   * the opt-in a null/unknown turnId stays a no-op, so late or duplicate failure reports
   * cannot fabricate turns.
   */
  allocateTurnWhenIdle?: boolean;
}>;

function publishRecordedFailure(
  params: ClaudeUnifiedFailurePublicationParams,
  issue: SessionRuntimeIssueV1,
  fallbackMessage: string,
): Error {
  const error = new Error(issue.sanitizedPreview ?? fallbackMessage);
  const allocate = params.allocateTurnWhenIdle === true;
  const turnId = params.turnId
    ?? (allocate ? `${params.sessionId}:claude-unified-idle-failure-${randomUUID()}` : null);
  if (turnId && !params.publishedFailureTurnIds.has(turnId)) {
    params.publishedFailureTurnIds.add(turnId);
    if (allocate) {
      publishClaudeUnifiedTurnStart({
        handlers: params.handlers,
        logger: params.logger,
        sessionId: params.sessionId,
        turnId,
        emittedAtMs: issue.occurredAt,
        startedBy: CLAUDE_UNIFIED_RUNTIME_ISSUE_TURN_STARTED_BY,
      });
    }
    publishClaudeUnifiedTurnFailed({
      handlers: params.handlers,
      logger: params.logger,
      sessionId: params.sessionId,
      turnId,
      issue,
    });
  }
  return error;
}

export function recordClaudeUnifiedTurnFailure(params: ClaudeUnifiedFailurePublicationParams & Readonly<{
  evidence: unknown;
  fallbackMessage: string;
}>): Error {
  return publishRecordedFailure(params, buildClaudeRuntimeIssue({
    evidence: params.evidence,
    occurredAt: Date.now(),
    fallbackMessage: params.fallbackMessage,
  }), params.fallbackMessage);
}

export function recordClaudeUnifiedProcessExitFailure(params: ClaudeUnifiedFailurePublicationParams & Readonly<{
  exitCode: number | null;
  signal: string | null;
}>): Error {
  const issue = buildClaudeProcessExitRuntimeIssue({
    occurredAt: Date.now(),
    exitCode: params.exitCode,
    signal: params.signal,
  });
  return publishRecordedFailure(
    params,
    issue,
    issue.sanitizedPreview ?? 'Claude unified terminal process exited while a turn was in flight',
  );
}
