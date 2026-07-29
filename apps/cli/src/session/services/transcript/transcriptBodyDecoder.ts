import {
  resolveTranscriptBodySessionMessageRole,
  type TranscriptBodySessionMessageProtocol,
} from '@happier-dev/protocol';

import type { SemanticTranscriptRole } from './semanticTranscriptItem';

export type DecodedTranscriptBody = Readonly<{
  semanticRole: SemanticTranscriptRole;
  kind: string;
  text?: string;
  summary?: string;
  provider?: string;
  sidechainId?: string;
  toolName?: string;
  callId?: string;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readFirstNonEmptyString(record: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const text = readNonEmptyString(record[key]);
    if (text) return text;
  }
  return null;
}

function extractTextParts(value: unknown): string | null {
  if (typeof value === 'string') return readNonEmptyString(value);
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === 'string') {
      const text = readNonEmptyString(part);
      if (text) parts.push(text);
      continue;
    }
    const record = asRecord(part);
    if (record?.type === 'text') {
      const text = readNonEmptyString(record.text);
      if (text) parts.push(text);
    }
  }
  const joined = parts.join('\n').trim();
  return joined.length > 0 ? joined : null;
}

function stringifyInline(value: unknown, maxChars: number): string | null {
  try {
    const text = JSON.stringify(value);
    if (!text) return null;
    return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
  } catch {
    return null;
  }
}

function normalizeInlineText(value: unknown): string | null {
  const text = readNonEmptyString(value);
  if (!text) return null;
  return text.replace(/\s+/g, ' ').trim();
}

function summarizeToolInput(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return stringifyInline(value, 200);
  const command = normalizeInlineText(record.command) ?? normalizeInlineText(record.cmd);
  const description = normalizeInlineText(record.description);
  if (description && command) return `${description} - ${command}`;
  return description ?? command ?? stringifyInline(value, 200);
}

function summarizeToolOutput(value: unknown): string | null {
  return extractTextParts(value) ?? stringifyInline(value, 400);
}

function decodeAcpLikeData(params: Readonly<{
  data: Record<string, unknown>;
  provider?: string;
  protocol: TranscriptBodySessionMessageProtocol;
}>): DecodedTranscriptBody | null {
  const type = typeof params.data.type === 'string' ? params.data.type : 'unknown_event';
  const sidechainId = readNonEmptyString(params.data.sidechainId);
  const commonFields = {
    ...(params.provider ? { provider: params.provider } : {}),
    ...(sidechainId ? { sidechainId } : {}),
  };

  if (type === 'text') {
    const text = readNonEmptyString(params.data.text);
    if (!text) return null;

    const role = readNonEmptyString(params.data.role);
    if (role === 'system') return null;
    if (role === 'user') {
      return { semanticRole: 'user', kind: 'user_message', text, ...commonFields };
    }
    if (role === 'reasoning') {
      return { semanticRole: 'reasoning', kind: 'reasoning', text, ...commonFields };
    }
    if (role !== null && role !== 'assistant' && role !== 'agent') return null;
    return { semanticRole: 'assistant', kind: 'assistant_message', text, ...commonFields };
  }

  if (type === 'message' || type === 'agent_message') {
    const text = readFirstNonEmptyString(params.data, ['message', 'text']);
    const messageRole = resolveTranscriptBodySessionMessageRole({
      protocol: params.protocol,
      body: params.data,
    });
    const semanticRole = messageRole === 'user' ? 'user' : 'assistant';
    return text
      ? {
          semanticRole,
          kind: semanticRole === 'user' ? 'user_message' : 'assistant_message',
          text,
          ...commonFields,
        }
      : null;
  }
  if (type === 'thinking' || type === 'reasoning' || type === 'agent_reasoning') {
    const text = readFirstNonEmptyString(params.data, ['text', 'message']);
    return { semanticRole: 'reasoning', kind: 'reasoning', ...(text ? { text } : {}), ...commonFields };
  }
  if (type === 'tool-call') {
    const toolName = readNonEmptyString(params.data.name) ?? undefined;
    const callId = readFirstNonEmptyString(params.data, ['callId', 'call_id', 'id']) ?? undefined;
    const detail = summarizeToolInput(params.data.input);
    return {
      semanticRole: 'tool',
      kind: 'tool_call',
      ...(toolName ? { toolName } : {}),
      ...(callId ? { callId } : {}),
      ...(detail ? { summary: toolName ? `Tool use (${toolName}): ${detail}` : `Tool use: ${detail}` } : {}),
      ...commonFields,
    };
  }
  if (type === 'tool-result' || type === 'tool-call-result') {
    const callId = readFirstNonEmptyString(params.data, ['callId', 'call_id', 'id']) ?? undefined;
    const output = summarizeToolOutput(params.data.output);
    const isError = params.data.isError === true;
    return {
      semanticRole: 'tool',
      kind: 'tool_result',
      ...(callId ? { callId } : {}),
      ...(output ? { summary: isError ? `Tool result (error): ${output}` : `Tool result: ${output}` } : {}),
      ...commonFields,
    };
  }
  if (type === 'file-edit') {
    const description = readNonEmptyString(params.data.description);
    const filePath = readNonEmptyString(params.data.filePath);
    const summary =
      description && filePath
        ? `File edit: ${description} - ${filePath}`
        : description || filePath
          ? `File edit: ${description ?? filePath}`
          : undefined;
    return { semanticRole: 'tool', kind: 'file_edit', ...(summary ? { summary } : {}), ...commonFields };
  }
  if (type === 'terminal-output') {
    const data = normalizeInlineText(params.data.data);
    return {
      semanticRole: 'tool',
      kind: 'terminal_output',
      ...(data ? { summary: `Terminal output: ${data}` } : {}),
      ...commonFields,
    };
  }
  if (type === 'token_count') return { semanticRole: 'event', kind: 'usage', summary: 'Token count', ...commonFields };
  return { semanticRole: 'event', kind: type || 'unknown_event', ...commonFields };
}

function decodeOutputContent(content: Record<string, unknown>): DecodedTranscriptBody | null {
  const data = asRecord(content.data);
  if (!data) return null;
  if (readNonEmptyString(data.parent_tool_use_id)) return null;
  const directText = readNonEmptyString(data.text);
  const sidechainId = readNonEmptyString(data.sidechainId);
  const provider = readNonEmptyString(content.agentId) ?? 'claude';
  const commonFields = {
    provider,
    ...(sidechainId ? { sidechainId } : {}),
  };
  if (data.type !== 'assistant') {
    return directText ? { semanticRole: 'assistant', kind: 'assistant_message', text: directText, ...commonFields } : null;
  }
  const message = asRecord(data.message);
  if (!message) {
    return directText ? { semanticRole: 'assistant', kind: 'assistant_message', text: directText, ...commonFields } : null;
  }
  const text = extractTextParts(message.content);
  if (text) return { semanticRole: 'assistant', kind: 'assistant_message', text, ...commonFields };

  const messageRole = typeof message.role === 'string' ? message.role : 'unknown';
  const parts = Array.isArray(message.content) ? message.content : [];
  const summaries: string[] = [];
  for (const part of parts) {
    const record = asRecord(part);
    if (messageRole === 'assistant' && record?.type === 'tool_use') {
      const toolName = readNonEmptyString(record.name) ?? 'Unknown';
      const detail = summarizeToolInput(record.input);
      summaries.push(detail ? `Tool use (${toolName}): ${detail}` : `Tool use (${toolName})`);
    }
    if (messageRole === 'user' && record?.type === 'tool_result') {
      const output = summarizeToolOutput(record.content);
      if (output) summaries.push(`Tool result: ${normalizeInlineText(output) ?? output}`);
    }
  }
  const summary = summaries.join('\n').trim();
  if (summary.length === 0) return null;
  return { semanticRole: 'tool', kind: messageRole === 'assistant' ? 'tool_call' : 'tool_result', summary, ...commonFields };
}

export function decodeTranscriptBody(value: unknown): DecodedTranscriptBody | null {
  const row = asRecord(value);
  if (!row) return null;
  const role = typeof row.role === 'string' ? row.role : 'unknown';
  const content = asRecord(row.content) ?? row;
  const contentType = typeof content.type === 'string' ? content.type : 'unknown';

  if (contentType === 'text') {
    const text = readNonEmptyString(content.text);
    if (!text) return null;
    const sidechainId = readNonEmptyString(row.sidechainId) ?? readNonEmptyString(content.sidechainId);
    const sidechainFields = sidechainId ? { sidechainId } : {};
    if (role === 'user') return { semanticRole: 'user', kind: 'user_message', text, ...sidechainFields };
    if (role === 'agent' || role === 'assistant') return { semanticRole: 'assistant', kind: 'assistant_message', text, ...sidechainFields };
    return null;
  }

  if (contentType === 'output') return decodeOutputContent(content);

  if (contentType === 'acp' || contentType === 'codex') {
    const data = asRecord(content.data);
    if (!data) return null;
    const provider =
      readNonEmptyString(content.agentId)
      ?? readNonEmptyString(content.provider)
      ?? (contentType === 'codex' ? 'codex' : undefined);
    return decodeAcpLikeData({
      data,
      protocol: contentType,
      ...(provider ? { provider } : {}),
    });
  }

  if (contentType === 'message' || contentType === 'agent_message') {
    const text = readFirstNonEmptyString(content, ['message', 'text']);
    if (!text) return null;
    const semanticRole = readNonEmptyString(content.role) === 'user' ? 'user' : 'assistant';
    const sidechainId = readNonEmptyString(content.sidechainId);
    return {
      semanticRole,
      kind: semanticRole === 'user' ? 'user_message' : 'assistant_message',
      text,
      ...(sidechainId ? { sidechainId } : {}),
    };
  }

  return { semanticRole: 'event', kind: contentType };
}
