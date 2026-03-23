type OpenCodeAfterCursorV1 = Readonly<{
  v: 1;
  kind: 'opencodeAfter';
  nextIndex: number;
}>;

export function encodeOpenCodeDirectAfterCursor(value: OpenCodeAfterCursorV1): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeOpenCodeDirectAfterCursor(raw: string): OpenCodeAfterCursorV1 | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1 || record.kind !== 'opencodeAfter') return null;
    const nextIndex = typeof record.nextIndex === 'number' && Number.isFinite(record.nextIndex) ? Math.trunc(record.nextIndex) : NaN;
    if (!Number.isFinite(nextIndex) || nextIndex < 0) return null;
    return { v: 1, kind: 'opencodeAfter', nextIndex };
  } catch {
    return null;
  }
}
