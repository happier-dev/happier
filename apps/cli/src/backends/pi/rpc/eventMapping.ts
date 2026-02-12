import type { AgentMessage } from '@/agent/core';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function mapPiRpcEventToAgentMessages(event: unknown): AgentMessage[] {
  const record = asRecord(event);
  if (!record) return [];

  const type = asNonEmptyString(record.type);
  if (!type) return [];

  if (type === 'agent_start' || type === 'turn_start') {
    return [{ type: 'status', status: 'running' }];
  }
  if (type === 'agent_end' || type === 'turn_end') {
    return [{ type: 'status', status: 'idle' }];
  }

  if (type === 'message_update') {
    const assistantMessageEvent = asRecord(record.assistantMessageEvent);
    if (!assistantMessageEvent) return [];
    const assistantType = asNonEmptyString(assistantMessageEvent.type);
    if (!assistantType) return [];
    if (assistantType === 'text_delta') {
      const delta = asNonEmptyString(assistantMessageEvent.delta);
      if (!delta) return [];
      return [{ type: 'model-output', textDelta: delta }];
    }
    return [];
  }

  if (type === 'tool_execution_start') {
    const callId = asNonEmptyString(record.toolCallId);
    const toolName = asNonEmptyString(record.toolName);
    const args = asRecord(record.args) ?? {};
    if (!callId || !toolName) return [];
    return [{ type: 'tool-call', callId, toolName, args }];
  }

  if (type === 'tool_execution_end') {
    const callId = asNonEmptyString(record.toolCallId);
    const toolName = asNonEmptyString(record.toolName);
    if (!callId || !toolName) return [];
    return [{ type: 'tool-result', callId, toolName, result: record.result }];
  }

  return [];
}
