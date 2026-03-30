type CodexForwardCursorV1 = Readonly<{
  v: 1;
  kind: 'codexForward';
  fileRelPath: string;
  offsetBytes: number;
}>;

type CodexAppServerForwardCursorV2 = Readonly<{
  v: 2;
  kind: 'codexForwardAppServer';
  updatedAtMs: number;
  previewText: string | null;
}>;

type CodexMergedForwardCursorV3 = Readonly<{
  v: 3;
  kind: 'codexForwardMerged';
  lastCreatedAtMs: number;
  lastId: string | null;
}>;

export type CodexDirectForwardCursor = CodexForwardCursorV1 | CodexAppServerForwardCursorV2 | CodexMergedForwardCursorV3;

export function encodeCodexDirectForwardCursor(value: CodexDirectForwardCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCodexDirectForwardCursor(raw: string): CodexDirectForwardCursor | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (record.v === 1 && record.kind === 'codexForward') {
      const fileRelPath = typeof record.fileRelPath === 'string' ? record.fileRelPath : '';
      const offsetBytes = typeof record.offsetBytes === 'number' && Number.isFinite(record.offsetBytes) ? Math.trunc(record.offsetBytes) : NaN;
      if (!fileRelPath.trim()) return null;
      if (!Number.isFinite(offsetBytes) || offsetBytes < 0) return null;
      return { v: 1, kind: 'codexForward', fileRelPath, offsetBytes };
    }
    if (record.v === 2 && record.kind === 'codexForwardAppServer') {
      const updatedAtMs = typeof record.updatedAtMs === 'number' && Number.isFinite(record.updatedAtMs)
        ? Math.trunc(record.updatedAtMs)
        : NaN;
      const previewText = typeof record.previewText === 'string' && record.previewText.trim().length > 0
        ? record.previewText.trim()
        : null;
      if (!Number.isFinite(updatedAtMs) || updatedAtMs < 0) return null;
      return { v: 2, kind: 'codexForwardAppServer', updatedAtMs, previewText };
    }
    if (record.v === 3 && record.kind === 'codexForwardMerged') {
      const lastCreatedAtMs = typeof record.lastCreatedAtMs === 'number' && Number.isFinite(record.lastCreatedAtMs)
        ? Math.trunc(record.lastCreatedAtMs)
        : NaN;
      const lastId = typeof record.lastId === 'string' && record.lastId.trim().length > 0
        ? record.lastId
        : null;
      if (!Number.isFinite(lastCreatedAtMs) || lastCreatedAtMs < 0) return null;
      return { v: 3, kind: 'codexForwardMerged', lastCreatedAtMs, lastId };
    }
    return null;
  } catch {
    return null;
  }
}
