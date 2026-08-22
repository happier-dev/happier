import {
  AgentSessionRuntimeEventSchema,
  type AgentSessionRuntimeEvent,
} from '@happier-dev/protocol';

import type {
  AgentId,
  TerminalLifecycleObservation,
  TerminalTurnAbortReason,
} from './_types';

type RuntimeTurnCancelledEvent = Extract<AgentSessionRuntimeEvent, { kind: 'turn-cancelled' }>;

function mapAbortReason(event: RuntimeTurnCancelledEvent): TerminalTurnAbortReason {
  return event.cause === 'user' ? 'user_interrupt' : 'other';
}

function readCancellationDetail(event: RuntimeTurnCancelledEvent): string | undefined {
  const message = event.diagnostic?.message?.trim();
  return message && message.length > 0 ? message : undefined;
}

export function mapRuntimeMessageToTerminalLifecycleObservation(params: Readonly<{
  agentId: AgentId;
  message: unknown;
}>): TerminalLifecycleObservation | null {
  const parsed = AgentSessionRuntimeEventSchema.safeParse(params.message);
  if (!parsed.success) return null;
  const event = parsed.data;

  if (event.kind === 'turn-start') {
    return {
      type: 'prompt_submitted',
      agentId: params.agentId,
      turnId: event.turnId,
      source: 'lifecycle_event',
    };
  }

  if (event.kind === 'turn-complete') {
    return {
      type: 'turn_completed',
      agentId: params.agentId,
      turnId: event.turnId,
      source: 'lifecycle_event',
    };
  }

  if (event.kind === 'turn-cancelled') {
    const detail = readCancellationDetail(event);
    return {
      type: 'turn_aborted',
      agentId: params.agentId,
      turnId: event.turnId,
      reason: mapAbortReason(event),
      ...(detail ? { detail } : {}),
      source: 'lifecycle_event',
    };
  }

  return null;
}
