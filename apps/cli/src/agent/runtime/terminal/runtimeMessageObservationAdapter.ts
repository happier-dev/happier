import type {
  AgentId,
  TerminalLifecycleObservation,
  TerminalTurnAbortReason,
} from './_types';

type RuntimeLifecycleMessage = Readonly<{
  type?: unknown;
  id?: unknown;
  reason?: unknown;
  detail?: unknown;
}>;

function readMessageRecord(message: unknown): RuntimeLifecycleMessage | null {
  return message && typeof message === 'object' ? message as RuntimeLifecycleMessage : null;
}

function readTurnId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readDetail(message: RuntimeLifecycleMessage): string | undefined {
  const detail = typeof message.detail === 'string'
    ? message.detail
    : typeof message.reason === 'string'
      ? message.reason
      : '';
  return detail.trim().length > 0 ? detail : undefined;
}

function mapAbortReason(message: RuntimeLifecycleMessage): TerminalTurnAbortReason {
  const raw = `${typeof message.reason === 'string' ? message.reason : ''} ${typeof message.detail === 'string' ? message.detail : ''}`;
  return /\b(interrupted|interrupt|user)\b/i.test(raw) ? 'user_interrupt' : 'other';
}

export function mapRuntimeMessageToTerminalLifecycleObservation(params: Readonly<{
  agentId: AgentId;
  message: unknown;
}>): TerminalLifecycleObservation | null {
  const message = readMessageRecord(params.message);
  if (!message || typeof message.type !== 'string') return null;
  const turnId = readTurnId(message.id);

  if (message.type === 'task_started') {
    return {
      type: 'prompt_submitted',
      agentId: params.agentId,
      turnId,
      source: 'lifecycle_event',
    };
  }

  if (message.type === 'task_complete') {
    return {
      type: 'turn_completed',
      agentId: params.agentId,
      turnId,
      source: 'lifecycle_event',
    };
  }

  if (message.type === 'turn_aborted') {
    return {
      type: 'turn_aborted',
      agentId: params.agentId,
      turnId,
      reason: mapAbortReason(message),
      ...(readDetail(message) ? { detail: readDetail(message) } : {}),
      source: 'lifecycle_event',
    };
  }

  return null;
}
