import {
  isAgentThreadTextConversationTurnMeta,
  redactBugReportSensitiveText,
} from '@happier-dev/protocol';

import type { DecryptedTranscriptRow } from '@/session/replay/decryptTranscriptRows';
import {
  extractSemanticTranscriptItem,
  extractSemanticTranscriptItemFromDecryptedPayload,
} from '@/session/services/transcript/extractSemanticTranscriptItem';
import type {
  SemanticTranscriptItem,
  TranscriptRawRow,
} from '@/session/services/transcript/semanticTranscriptItem';

import {
  normalizeMemoryContentPolicy,
  type MemoryContentPolicy,
} from './contentPolicy';
import type {
  MemoryIndexableTranscriptItem,
  MemoryIndexableTranscriptKind,
} from './indexableItem';

const MAX_MEMORY_TOOL_SUMMARY_CHARS = 500;

type MemorySemanticExtractionContext = Readonly<{
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
}> | null;

function normalizeSeq(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = redactBugReportSensitiveText(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeMemoryText(params: Readonly<{ value: unknown; kind: MemoryIndexableTranscriptKind }>): string | null {
  const text = normalizeText(params.value);
  if (!text) return null;
  if (params.kind !== 'tool_summary') return text;
  return text.length <= MAX_MEMORY_TOOL_SUMMARY_CHARS ? text : text.slice(0, MAX_MEMORY_TOOL_SUMMARY_CHARS);
}

function summarizeToolUseForMemory(item: SemanticTranscriptItem): string | null {
  const toolName = normalizeText(item.toolName);
  const label = toolName ? `Tool use (${toolName})` : 'Tool use';
  return normalizeMemoryText({ value: label, kind: 'tool_summary' });
}

function mapSemanticItemToMemoryIndexable(params: Readonly<{
  sessionId: string;
  item: SemanticTranscriptItem;
  contentPolicy?: MemoryContentPolicy | null;
}>): MemoryIndexableTranscriptItem | null {
  const sessionId = String(params.sessionId ?? '').trim();
  if (!sessionId) return null;
  if (!isAgentThreadTextConversationTurnMeta({
    happier: {
      conversationTurnOriginV1: params.item.origin,
    },
  })) return null;

  const policy = normalizeMemoryContentPolicy(params.contentPolicy);
  const seq = normalizeSeq(params.item.seq);
  if (seq === null) return null;
  if (params.item.storedMessageRole === 'event') return null;

  let role: 'user' | 'assistant' | null = null;
  let kind: MemoryIndexableTranscriptKind | null = null;

  if (params.item.semanticRole === 'user') {
    if (!policy.includeUserMessages) return null;
    role = 'user';
    kind = 'user_message';
  } else if (params.item.semanticRole === 'assistant') {
    if (!policy.includeAssistantMessages) return null;
    role = 'assistant';
    kind = 'assistant_message';
  } else if (params.item.semanticRole === 'reasoning') {
    if (!policy.includeReasoning) return null;
    role = 'assistant';
    kind = 'reasoning';
  } else if (params.item.semanticRole === 'tool') {
    if (!policy.includeToolSummaries) return null;
    if (params.item.kind === 'tool_result') return null;
    role = 'assistant';
    kind = 'tool_summary';
  }

  if (!role || !kind) return null;
  const text = kind === 'tool_summary'
    ? summarizeToolUseForMemory(params.item)
    : normalizeMemoryText({ value: params.item.text ?? params.item.summary, kind });
  if (!text) return null;

  return {
    sessionId,
    id: params.item.id,
    seq,
    createdAtMs: Math.max(0, Math.trunc(params.item.createdAt)),
    role,
    kind,
    ...(params.item.provider ? { provider: params.item.provider } : {}),
    text,
    textChars: text.length,
    ...(params.item.storedMessageRole ? { sourceStoredMessageRole: params.item.storedMessageRole } : {}),
  };
}

function transcriptRolesForPolicy(policy: Required<MemoryContentPolicy>): Array<'user' | 'assistant'> {
  const transcriptRoles: Array<'user' | 'assistant'> = [];
  if (policy.includeUserMessages) transcriptRoles.push('user');
  if (policy.includeAssistantMessages) transcriptRoles.push('assistant');
  return transcriptRoles;
}

export function extractMemoryIndexableTranscriptItem(params: Readonly<{
  sessionId: string;
  row: TranscriptRawRow;
  index: number;
  ctx: MemorySemanticExtractionContext;
  contentPolicy?: MemoryContentPolicy | null;
}>): MemoryIndexableTranscriptItem | null {
  const policy = normalizeMemoryContentPolicy(params.contentPolicy);
  const extracted = extractSemanticTranscriptItem({
    row: params.row,
    index: params.index,
    ctx: params.ctx,
    options: {
      mode: 'transcript',
      transcriptRoles: transcriptRolesForPolicy(policy),
      includeReasoning: policy.includeReasoning,
      includeTools: policy.includeToolSummaries,
    },
  });

  if (!extracted.item) return null;
  return mapSemanticItemToMemoryIndexable({
    sessionId: params.sessionId,
    item: extracted.item,
    contentPolicy: policy,
  });
}

export function extractMemoryIndexableTranscriptItemFromDecryptedRow(params: Readonly<{
  sessionId: string;
  row: DecryptedTranscriptRow;
  index: number;
  contentPolicy?: MemoryContentPolicy | null;
}>): MemoryIndexableTranscriptItem | null {
  return extractMemoryIndexableTranscriptItemFromDecryptedPayload({
    sessionId: params.sessionId,
    decrypted: {
      role: params.row.role,
      content: params.row.content,
      ...(params.row.meta !== undefined ? { meta: params.row.meta } : {}),
    },
    row: {
      id: String(params.row.seq),
      seq: params.row.seq,
      createdAt: params.row.createdAtMs,
      messageRole: params.row.role,
    },
    index: params.index,
    contentPolicy: params.contentPolicy,
  });
}

export function extractMemoryIndexableTranscriptItemFromDecryptedPayload(params: Readonly<{
  sessionId: string;
  decrypted: unknown;
  row: Omit<TranscriptRawRow, 'content'>;
  index: number;
  contentPolicy?: MemoryContentPolicy | null;
}>): MemoryIndexableTranscriptItem | null {
  const policy = normalizeMemoryContentPolicy(params.contentPolicy);
  const extracted = extractSemanticTranscriptItemFromDecryptedPayload({
    decrypted: params.decrypted,
    row: params.row,
    index: params.index,
    options: {
      mode: 'transcript',
      transcriptRoles: transcriptRolesForPolicy(policy),
      includeReasoning: policy.includeReasoning,
      includeTools: policy.includeToolSummaries,
    },
  });

  if (!extracted.item) return null;
  return mapSemanticItemToMemoryIndexable({
    sessionId: params.sessionId,
    item: extracted.item,
    contentPolicy: policy,
  });
}

export function mapSemanticTranscriptItemToMemoryIndexable(params: Readonly<{
  sessionId: string;
  item: SemanticTranscriptItem;
  contentPolicy?: MemoryContentPolicy | null;
}>): MemoryIndexableTranscriptItem | null {
  return mapSemanticItemToMemoryIndexable(params);
}
