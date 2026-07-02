import {
  isMemoryArtifactDecryptedRow,
  tryResolveDecryptedTranscriptPayload,
} from './transcriptHistoryRows';
import type {
  SemanticTranscriptItem,
  SemanticTranscriptRole,
  StoredTranscriptRole,
  TranscriptMode,
  TranscriptRawRow,
} from './semanticTranscriptItem';

type ExtractionOptions = Readonly<{
  mode: TranscriptMode;
  transcriptRoles?: readonly ('user' | 'assistant')[];
  includeTools?: boolean;
  includeReasoning?: boolean;
  includeEvents?: boolean;
  includeRaw?: boolean;
  includeStructuredPayload?: boolean;
  maxTextChars?: number | null;
  maxPayloadChars?: number;
}>;

export type SemanticTranscriptExtraction = Readonly<{
  item: SemanticTranscriptItem | null;
  payloadBytes: number;
  payloadTruncated: boolean;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateText(text: string, maxChars: number | null | undefined): Readonly<{ text: string; truncated: boolean }> {
  if (maxChars === null || maxChars === undefined) return { text, truncated: false };
  const max = Math.max(0, Math.floor(maxChars));
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
}

function normalizeStoredRole(value: unknown): StoredTranscriptRole | undefined {
  return value === 'user' || value === 'agent' || value === 'event' || value === 'unknown' ? value : undefined;
}

function normalizeSeq(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function extractTextParts(value: unknown): string | null {
  if (typeof value === 'string') return normalizeText(value);
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === 'string') {
      const text = normalizeText(part);
      if (text) parts.push(text);
      continue;
    }
    const record = asRecord(part);
    if (record?.type === 'text') {
      const text = normalizeText(record.text);
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

function summarizeToolInput(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return stringifyInline(value, 200);
  const command = normalizeText(record.command) ?? normalizeText(record.cmd);
  const description = normalizeText(record.description);
  if (description && command) return `${description} - ${command}`;
  return description ?? command ?? stringifyInline(value, 200);
}

function summarizeToolOutput(value: unknown): string | null {
  return extractTextParts(value) ?? stringifyInline(value, 400);
}

type ClassifiedPayload = Readonly<{
  semanticRole: SemanticTranscriptRole;
  kind: string;
  text?: string;
  summary?: string;
  provider?: string;
  toolName?: string;
  callId?: string;
}>;

function classifyAcpOrCodexContent(kind: 'acp' | 'codex', content: Record<string, unknown>): ClassifiedPayload | null {
  const data = asRecord(content.data);
  if (!data) return null;
  const type = typeof data.type === 'string' ? data.type : 'unknown_event';
  const provider = typeof content.provider === 'string' ? content.provider : undefined;

  if (type === 'message') {
    const text = normalizeText(data.message);
    return text ? { semanticRole: 'assistant', kind: 'assistant_message', text, ...(provider ? { provider } : {}) } : null;
  }
  if (type === 'thinking' || type === 'reasoning') {
    const text = normalizeText(data.text) ?? normalizeText(data.message);
    return { semanticRole: 'reasoning', kind: 'reasoning', ...(text ? { text } : {}), ...(provider ? { provider } : {}) };
  }
  if (type === 'tool-call') {
    const toolName = normalizeText(data.name) ?? undefined;
    const callId = normalizeText(data.callId) ?? normalizeText(data.id) ?? undefined;
    const detail = summarizeToolInput(data.input);
    return {
      semanticRole: 'tool',
      kind: 'tool_call',
      ...(toolName ? { toolName } : {}),
      ...(callId ? { callId } : {}),
      ...(detail ? { summary: toolName ? `Tool use (${toolName}): ${detail}` : `Tool use: ${detail}` } : {}),
      ...(provider ? { provider } : {}),
    };
  }
  if (type === 'tool-result' || type === 'tool-call-result') {
    const callId = normalizeText(data.callId) ?? normalizeText(data.id) ?? undefined;
    const output = summarizeToolOutput(data.output);
    return {
      semanticRole: 'tool',
      kind: 'tool_result',
      ...(callId ? { callId } : {}),
      ...(output ? { summary: `Tool result: ${output}` } : {}),
      ...(provider ? { provider } : {}),
    };
  }
  if (type === 'token_count') return { semanticRole: 'event', kind: 'usage', summary: 'Token count', ...(provider ? { provider } : {}) };
  return { semanticRole: 'event', kind: type || `${kind}_event`, ...(provider ? { provider } : {}) };
}

function classifyOutputContent(content: Record<string, unknown>): ClassifiedPayload | null {
  const data = asRecord(content.data);
  const message = asRecord(data?.message);
  if (!message) return null;
  const text = extractTextParts(message.content);
  if (text) return { semanticRole: 'assistant', kind: 'assistant_message', text };

  const messageRole = typeof message.role === 'string' ? message.role : 'unknown';
  const parts = Array.isArray(message.content) ? message.content : [];
  const summaries: string[] = [];
  for (const part of parts) {
    const record = asRecord(part);
    if (messageRole === 'assistant' && record?.type === 'tool_use') {
      const toolName = normalizeText(record.name) ?? 'Unknown';
      const detail = summarizeToolInput(record.input);
      summaries.push(detail ? `Tool use (${toolName}): ${detail}` : `Tool use (${toolName})`);
    }
    if (messageRole === 'user' && record?.type === 'tool_result') {
      const output = summarizeToolOutput(record.content);
      if (output) summaries.push(`Tool result: ${output}`);
    }
  }
  const summary = summaries.join('\n').trim();
  if (summary.length === 0) return null;
  return { semanticRole: 'tool', kind: messageRole === 'assistant' ? 'tool_call' : 'tool_result', summary };
}

function classifyDecryptedPayload(decrypted: unknown): ClassifiedPayload | null {
  const row = asRecord(decrypted);
  if (!row) return null;
  const role = typeof row.role === 'string' ? row.role : 'unknown';
  const content = asRecord(row.content);
  if (!content) return null;
  const contentType = typeof content.type === 'string' ? content.type : 'unknown';

  if (role === 'user' && contentType === 'text') {
    const text = normalizeText(content.text);
    return text ? { semanticRole: 'user', kind: 'user_message', text } : null;
  }
  if ((role === 'agent' || role === 'assistant') && contentType === 'text') {
    const text = normalizeText(content.text);
    return text ? { semanticRole: 'assistant', kind: 'assistant_message', text } : null;
  }
  if (contentType === 'output') return classifyOutputContent(content);
  if (contentType === 'acp' || contentType === 'codex') return classifyAcpOrCodexContent(contentType, content);
  return { semanticRole: 'event', kind: contentType };
}

function shouldIncludeClassifiedPayload(classified: ClassifiedPayload, options: ExtractionOptions): boolean {
  if (options.mode === 'events') return classified.semanticRole !== 'user' && classified.semanticRole !== 'assistant';
  if (classified.semanticRole === 'user' || classified.semanticRole === 'assistant') {
    return (options.transcriptRoles ?? ['user', 'assistant']).includes(classified.semanticRole);
  }
  if (classified.semanticRole === 'tool') return options.includeTools === true;
  if (classified.semanticRole === 'reasoning') return options.includeReasoning === true;
  if (classified.semanticRole === 'event') return options.includeEvents === true;
  return false;
}

function shapeRawPayload(value: unknown, maxPayloadChars: number | undefined): Readonly<{ raw?: unknown; bytes: number; truncated: boolean }> {
  const max = Math.max(1, Math.floor(maxPayloadChars ?? 8192));
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { raw: '[unserializable]', bytes: 16, truncated: true };
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= max) return { raw: value, bytes, truncated: false };
  return { raw: serialized.slice(0, max), bytes: max, truncated: true };
}

export function extractSemanticTranscriptItem(params: Readonly<{
  row: TranscriptRawRow;
  index: number;
  ctx: Readonly<{ encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' }>;
  options: ExtractionOptions;
}>): SemanticTranscriptExtraction {
  const decrypted = tryResolveDecryptedTranscriptPayload({ content: params.row.content, ctx: params.ctx });
  return extractSemanticTranscriptItemFromDecryptedPayload({
    decrypted,
    row: params.row,
    index: params.index,
    options: params.options,
  });
}

export function extractSemanticTranscriptItemFromDecryptedPayload(params: Readonly<{
  decrypted: unknown;
  row: Omit<TranscriptRawRow, 'content'>;
  index: number;
  options: ExtractionOptions;
}>): SemanticTranscriptExtraction {
  if (!params.decrypted || isMemoryArtifactDecryptedRow(params.decrypted)) {
    return { item: null, payloadBytes: 0, payloadTruncated: false };
  }

  const classified = classifyDecryptedPayload(params.decrypted);
  if (!classified || !shouldIncludeClassifiedPayload(classified, params.options)) {
    return { item: null, payloadBytes: 0, payloadTruncated: false };
  }

  const seq = normalizeSeq(params.row.seq);
  const createdAt = typeof params.row.createdAt === 'number' && Number.isFinite(params.row.createdAt) ? params.row.createdAt : 0;
  const id = typeof params.row.id === 'string' ? params.row.id : seq !== undefined ? String(seq) : String(params.index);
  const storedMessageRole = normalizeStoredRole(params.row.messageRole);
  const text = classified.text ? truncateText(classified.text, params.options.maxTextChars) : null;
  const summary = classified.summary ? truncateText(classified.summary, params.options.maxTextChars) : null;
  const includeRaw = params.options.includeRaw === true || params.options.includeStructuredPayload === true;
  const rawPayload = includeRaw ? shapeRawPayload(params.decrypted, params.options.maxPayloadChars) : null;

  return {
    item: {
      id,
      ...(seq !== undefined ? { seq } : {}),
      createdAt,
      ...(storedMessageRole ? { storedMessageRole } : {}),
      semanticRole: classified.semanticRole,
      role: classified.semanticRole,
      kind: classified.kind,
      ...(classified.provider ? { provider: classified.provider } : {}),
      ...(text ? { text: text.text, ...(text.truncated ? { truncated: true } : {}) } : {}),
      ...(summary ? { summary: summary.text, ...(summary.truncated ? { truncated: true } : {}) } : {}),
      ...(classified.toolName ? { toolName: classified.toolName } : {}),
      ...(classified.callId ? { callId: classified.callId } : {}),
      ...(rawPayload?.raw !== undefined ? { raw: rawPayload.raw } : {}),
      ...(rawPayload?.truncated ? { rawTruncated: true } : {}),
    },
    payloadBytes: rawPayload?.bytes ?? 0,
    payloadTruncated: rawPayload?.truncated === true,
  };
}
