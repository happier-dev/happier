import type {
  AgentId,
  TerminalLifecycleObservation,
} from '@/agent/runtime/terminal/_types';

export type ClaudeTerminalHookEvent = Readonly<{
  agentId: AgentId;
  eventName: string;
  turnId?: string | null;
  detail?: string;
}>;

export type ClaudeTerminalTranscriptEvent =
  | Readonly<{
      agentId: AgentId;
      kind: 'assistant_stop';
      stopReason?: string | null;
      turnId?: string | null;
    }>
  | Readonly<{
      agentId: AgentId;
      kind: 'stop_hook_feedback';
      turnId?: string | null;
    }>
  | Readonly<{
      agentId: AgentId;
      kind: 'text';
      text: string;
      turnId?: string | null;
    }>;

function readTurnId(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function mapClaudeHookEventToTerminalLifecycleObservation(
  event: ClaudeTerminalHookEvent,
): TerminalLifecycleObservation | null {
  const turnId = readTurnId(event.turnId);

  if (event.eventName === 'UserPromptSubmit') {
    return {
      type: 'prompt_submitted',
      agentId: event.agentId,
      turnId,
      source: 'hook',
    };
  }

  if (event.eventName === 'Stop') {
    return {
      type: 'completion_candidate',
      agentId: event.agentId,
      turnId,
      source: 'hook',
    };
  }

  if (event.eventName === 'StopFailure') {
    return {
      type: 'turn_failed',
      agentId: event.agentId,
      turnId,
      reason: 'stop_failure_hook',
      ...(event.detail ? { detail: event.detail } : {}),
      source: 'hook',
    };
  }

  if (event.eventName === 'SessionEnd') {
    return {
      type: 'process_exited',
      agentId: event.agentId,
      exitCode: null,
      signal: null,
    };
  }

  return null;
}

export function mapClaudeTranscriptEventToTerminalLifecycleObservation(
  event: ClaudeTerminalTranscriptEvent,
): TerminalLifecycleObservation | null {
  const turnId = readTurnId(event.turnId);

  if (event.kind === 'assistant_stop') {
    return event.stopReason === 'end_turn'
      ? {
          type: 'completion_candidate',
          agentId: event.agentId,
          turnId,
          source: 'transcript',
        }
      : null;
  }

  if (event.kind === 'stop_hook_feedback') {
    return {
      type: 'completion_candidate_invalidated',
      agentId: event.agentId,
      turnId,
      reason: 'stop_hook_feedback',
    };
  }

  if (event.text.includes('[Request interrupted by user]')) {
    return {
      type: 'turn_aborted',
      agentId: event.agentId,
      turnId,
      reason: 'user_interrupt',
      detail: '[Request interrupted by user]',
      source: 'transcript',
    };
  }

  return null;
}
