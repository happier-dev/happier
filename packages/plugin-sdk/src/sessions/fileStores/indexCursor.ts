import { isRecord } from './records.js';

export type IndexCursorV1 = Readonly<{ v: 1; kind: 'index'; offset: number }>;

export function encodeIndexCursor(offset: number): string {
  const cursor: IndexCursorV1 = {
    v: 1,
    kind: 'index',
    offset: Math.max(0, Math.trunc(offset)),
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeIndexCursor(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      isRecord(parsed)
      && parsed.v === 1
      && parsed.kind === 'index'
      && typeof parsed.offset === 'number'
      && Number.isFinite(parsed.offset)
      && parsed.offset >= 0
    ) {
      return Math.max(0, Math.trunc(parsed.offset));
    }
  } catch {
    return null;
  }
  return null;
}
