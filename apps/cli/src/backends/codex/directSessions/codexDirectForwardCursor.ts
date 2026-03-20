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

export type CodexDirectForwardCursor = CodexForwardCursorV1 | CodexAppServerForwardCursorV2;

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
    return null;
  } catch {
    return null;
  }
}
