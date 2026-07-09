import type { SessionFileStoreHeaderDescriptorV1 } from './productDescriptor.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function readTrimmedString(value: unknown): string | null {
  const raw = readString(value);
  return raw ? raw.trim() : null;
}

export function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) && ms >= 0 ? Math.trunc(ms) : null;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    const truncated = Math.trunc(value);
    return truncated < 1_000_000_000_000 ? truncated * 1000 : truncated;
  }
  return null;
}

export function parseJsonLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

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
