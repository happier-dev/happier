import type { SessionFileStoreHeaderDescriptorV1 } from './productDescriptor.js';
import type { AgentExternalSessionTranscriptItem } from '../../externalSessions.js';
import { isRecord, parseTimestampMs, readString } from './recordValues.js';
export { isRecord, parseJsonLine, parseTimestampMs, readString, readTrimmedString } from './recordValues.js';

/** Fixed presentation for native content this reader cannot interpret. */
export const AGENT_UNSUPPORTED_CONTENT_TEXT = 'Agent emitted an unsupported content block.';

/**
 * A native record this reader cannot interpret is still a readable transcript
 * item. Keep its source identity for paging, but never disclose its native body
 * or mistake a codec mismatch for source discontinuity.
 */
export function createExternalSessionUnsupportedTranscriptItem(params: Readonly<{
  agentId: string;
  id: string;
  localId?: string | null;
  createdAtMs: number;
}>): AgentExternalSessionTranscriptItem & Readonly<{ createdAtMs: number }> {
  return {
    id: params.id,
    localId: params.localId ?? null,
    createdAtMs: params.createdAtMs,
    messageRole: 'agent',
    raw: { role: 'agent', content: { type: 'acp', agentId: params.agentId,
      data: { type: 'message', message: AGENT_UNSUPPORTED_CONTENT_TEXT } } },
  };
}

/** @realm daemon */
export function parseDefaultSessionHeader(record: unknown): SessionFileStoreHeaderDescriptorV1 | null {
  if (!isRecord(record) || record.type !== 'session') return null;
  const sessionId = readString(record.id);
  if (!sessionId) return null;
  return {
    sessionId,
    cwd: readString(record.cwd),
    createdAtMs: parseTimestampMs(record.timestamp),
    title: readString(record.title),
  };
}

/** @realm daemon */
export function extractUserMessageText(record: unknown): string | null {
  if (!isRecord(record)) return null;
  const message = isRecord(record.message) ? record.message : null;
  if (!message || message.role !== 'user') return null;
  const content = message.content;
  if (typeof content === 'string') return content.trim().length > 0 ? content : null;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((item) => {
      if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') return '';
      return item.text;
    })
    .join('')
    .trim();
  return text.length > 0 ? text : null;
}
