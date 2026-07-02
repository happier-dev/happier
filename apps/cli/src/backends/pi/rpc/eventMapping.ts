import type { AgentMessage } from '@/agent/core';
import { extractAcpMediaContentBlocks } from '@/agent/acp/media/extractAcpMediaContentBlocks';
import { buildPiContextCompactionPayload } from '@happier-dev/plugins-pi/agent/runtime/rpc/events';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isBoolean(value: unknown): value is boolean {
  return value === true || value === false;
}

function extractAssistantText(message: unknown): string | null {
  const record = asRecord(message);
  if (!record) return null;
  if (record.role !== 'assistant') return null;
  const content = record.content;
  if (!Array.isArray(content)) return null;

  let text = '';
  for (const item of content) {
    const entry = asRecord(item);
    if (!entry) continue;
    if (entry.type !== 'text') continue;
    const chunk = asString(entry.text);
    if (chunk === null) continue;
    text += chunk;
  }

  return text;
}

function buildPiAssistantMessages(message: unknown): AgentMessage[] {
  const messages: AgentMessage[] = [];
  const fullText = extractAssistantText(message);
  if (fullText !== null && fullText.length > 0) {
    messages.push({ type: 'model-output', fullText });
  }
  return messages;
}

function buildPiToolResultMessages(params: Readonly<{
  callId: string;
  toolName: string;
  result: unknown;
  isError?: boolean;
}>): AgentMessage[] {
  const messages: AgentMessage[] = [{
    type: 'tool-result',
    callId: params.callId,
    toolName: params.toolName,
    result: params.result,
    ...(params.isError ? { isError: true } : {}),
  }];
  const mediaResult = extractAcpMediaContentBlocks(params.result, {
    originSource: 'tool-output',
    toolCallId: params.callId,
  });
  if (mediaResult.media.length > 0) {
    messages.push({
      type: 'event',
      name: 'session_media',
      payload: {
        localId: `pi-media-${params.callId}`,
        role: 'output',
        category: 'tool-artifact',
        media: mediaResult.media,
      },
    });
  }
  return messages;
}

function extractTextFromToolResult(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const content = record.content;
  if (!Array.isArray(content)) return null;
  let text = '';
  for (const item of content) {
    const entry = asRecord(item);
    if (!entry) continue;
    if (entry.type !== 'text') continue;
    const chunk = asString(entry.text);
    if (chunk === null) continue;
    text += chunk;
  }
  return text;
}

export function mapPiRpcEventToAgentMessages(event: unknown): AgentMessage[] {
  const record = asRecord(event);
  if (!record) return [];

  const type = asNonEmptyString(record.type);
  if (!type) return [];

  if (type === 'agent_start') {
    return [{ type: 'status', status: 'running' }];
  }
  if (type === 'agent_end') {
    return [];
  }

  if (type === 'compaction_start') {
    const payload = buildPiContextCompactionPayload(record);
    if (!payload) return [];
    return [{
      type: 'event',
      name: 'context_compaction',
      payload,
    }];
  }

  if (type === 'compaction_end') {
    const payload = buildPiContextCompactionPayload(record);
    if (!payload) return [];
    return [{
      type: 'event',
      name: 'context_compaction',
      payload,
    }];
  }

  if (type === 'message_update') {
    const assistantMessageEvent = asRecord(record.assistantMessageEvent);
    if (!assistantMessageEvent) return [];
    const assistantType = asNonEmptyString(assistantMessageEvent.type);
    if (!assistantType) return [];
    if (assistantType === 'text_start' || assistantType === 'text_delta' || assistantType === 'text_end') {
      return buildPiAssistantMessages(record.message);
    }
    return [];
  }

  if (type === 'message_end') {
    return buildPiAssistantMessages(record.message);
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
    const isError = isBoolean(record.isError) ? record.isError : undefined;
    return buildPiToolResultMessages({ callId, toolName, result: record.result, isError });
  }

  if (type === 'tool_execution_update') {
    const callId = asNonEmptyString(record.toolCallId);
    const toolName = asNonEmptyString(record.toolName);
    if (!callId || !toolName) return [];
    const chunk = extractTextFromToolResult(record.partialResult);
    if (chunk === null || chunk.length === 0) return [];
    return [{ type: 'tool-result', callId, toolName, result: { _stream: true, stdoutChunk: chunk } }];
  }

  return [];
}
