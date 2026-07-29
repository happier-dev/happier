import type { RuntimeEventV1 } from '@happier-dev/protocol/runtime';

import type { AntigravityStep } from './types.js';

function createTranscriptErrorEvent(params: Readonly<{
  sessionId: string;
  turnId: string;
  emittedAtMs: number;
  message: string;
}>): RuntimeEventV1 {
  return {
    kind: 'turn-failed',
    sessionId: params.sessionId,
    emittedAtMs: params.emittedAtMs,
    turnId: params.turnId,
    issue: {
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'antigravity_cliprint_transcript_error',
      source: 'agent_status_error',
      occurredAt: params.emittedAtMs,
      sanitizedPreview: params.message,
    },
  };
}

function createProviderProgressEvent(params: Readonly<{
  sessionId: string;
  turnId: string;
  emittedAtMs: number;
  detail: Readonly<Record<string, unknown>>;
}>): RuntimeEventV1 {
  return {
    kind: 'turn-progress',
    sessionId: params.sessionId,
    turnId: params.turnId,
    emittedAtMs: params.emittedAtMs,
    agentId: 'antigravity',
    source: 'cliprint_transcript',
    detail: params.detail,
  };
}

export function hasAntigravityStepOutputEvidence(steps: readonly AntigravityStep[]): boolean {
  return steps.some((step) => (
    step.kind === 'user_message'
    || step.kind === 'assistant_message'
    || step.kind === 'tool_call'
    || step.kind === 'tool_result'
    || step.kind === 'error'
  ));
}

export function mapAntigravityStepsToRuntimeEvents(params: Readonly<{
  sessionId: string;
  turnId: string;
  emittedAtMs: number;
  steps: readonly AntigravityStep[];
}>): RuntimeEventV1[] {
  const events: RuntimeEventV1[] = [];
  let syntheticId = 0;
  const nextId = (prefix: string) => `${params.turnId}:${prefix}-${syntheticId += 1}`;
  for (const step of params.steps) {
    if (step.kind === 'user_message') {
      // Host sessions already own committed user rows; transcript echoes are correlation evidence only.
      continue;
    } else if (step.kind === 'assistant_message') {
      events.push({
        kind: 'transcript-agent-message-committed',
        sessionId: params.sessionId,
        emittedAtMs: params.emittedAtMs,
        agentId: 'antigravity',
        localId: step.id ?? nextId('assistant'),
        body: { type: 'message', message: step.text },
      });
    } else if (step.kind === 'tool_call') {
      events.push({
        kind: 'tool-call',
        sessionId: params.sessionId,
        emittedAtMs: params.emittedAtMs,
        turnId: params.turnId,
        toolCallId: step.id ?? nextId('tool'),
        toolName: step.toolName,
        toolInput: step.input,
      });
    } else if (step.kind === 'tool_result') {
      events.push({
        kind: 'tool-result',
        sessionId: params.sessionId,
        emittedAtMs: params.emittedAtMs,
        turnId: params.turnId,
        toolCallId: step.toolCallId,
        output: step.output,
        ...(step.isError !== undefined ? { isError: step.isError } : {}),
      });
    } else if (step.kind === 'error') {
      events.push(createTranscriptErrorEvent({
        sessionId: params.sessionId,
        turnId: params.turnId,
        emittedAtMs: params.emittedAtMs,
        message: step.message,
      }));
    } else if (step.kind === 'checkpoint') {
      events.push(createProviderProgressEvent({
        sessionId: params.sessionId,
        turnId: params.turnId,
        emittedAtMs: params.emittedAtMs,
        detail: {
          type: 'checkpoint',
          ...(step.checkpointId ? { checkpointId: step.checkpointId } : {}),
          ...(step.id ? { localId: step.id } : {}),
        },
      }));
    } else if (step.kind === 'system_message') {
      events.push(createProviderProgressEvent({
        sessionId: params.sessionId,
        turnId: params.turnId,
        emittedAtMs: params.emittedAtMs,
        detail: {
          type: 'system_message',
          text: step.text,
          ...(step.id ? { localId: step.id } : {}),
        },
      }));
    }
  }
  return events;
}
