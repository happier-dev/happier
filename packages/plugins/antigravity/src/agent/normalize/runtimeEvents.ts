import {
  AgentRuntimeJsonValueSchema,
  type AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';

import type { AntigravityStep } from './types.js';

type NativeSessionEventInput = AgentSessionRuntimeEvent extends infer Event
  ? Event extends AgentSessionRuntimeEvent
    ? Omit<Event, 'sequence' | 'sessionId' | 'emittedAtMs'>
    : never
  : never;

function createTranscriptErrorEvent(params: Readonly<{
  turnId: string;
  message: string;
}>): NativeSessionEventInput {
  return {
    kind: 'turn-failed',
    turnId: params.turnId,
    diagnostic: {
      code: 'antigravity_cliprint_transcript_error',
      severity: 'error',
      message: params.message,
    },
  };
}

function toJsonValue(value: unknown) {
  const parsed = AgentRuntimeJsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : { unavailable: true };
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
}>): NativeSessionEventInput[] {
  const events: NativeSessionEventInput[] = [];
  let syntheticId = 0;
  const nextId = (prefix: string) => `${params.turnId}:${prefix}-${syntheticId += 1}`;
  for (const step of params.steps) {
    if (step.kind === 'user_message') {
      // Host sessions already own committed user rows; transcript echoes are correlation evidence only.
      continue;
    } else if (step.kind === 'assistant_message') {
      events.push({
        kind: 'transcript-message-committed',
        messageId: step.id ?? nextId('assistant'),
        role: 'assistant',
        text: step.text,
        turnId: params.turnId,
      });
    } else if (step.kind === 'tool_call') {
      events.push({
        kind: 'tool-call',
        turnId: params.turnId,
        toolCallId: step.id ?? nextId('tool'),
        toolName: step.toolName,
        input: toJsonValue(step.input),
      });
    } else if (step.kind === 'tool_result') {
      events.push({
        kind: 'tool-result',
        turnId: params.turnId,
        toolCallId: step.toolCallId,
        output: toJsonValue(step.output),
        ...(step.isError !== undefined ? { isError: step.isError } : {}),
      });
    } else if (step.kind === 'error') {
      events.push(createTranscriptErrorEvent({
        turnId: params.turnId,
        message: step.message,
      }));
    }
  }
  return events;
}
