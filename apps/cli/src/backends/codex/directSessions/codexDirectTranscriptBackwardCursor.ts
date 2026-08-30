type CodexBackwardStreamCursorV3 = Readonly<{
  v: 3;
  kind: 'codexBackwardStreamVector';
  streams: readonly Readonly<{
    fileRelPath: string;
    endOffsetBytes: number;
  }>[];
}>;

type CodexBackwardStreamCursorV4 = Readonly<{
  v: 4;
  kind: 'codexBackwardStreamVector';
  streams: readonly Readonly<{
    fileRelPath: string;
    endOffsetBytes: number;
    threadId: string;
    discoveredFrom?: Readonly<{
      fileRelPath: string;
      lineStartOffsetBytes: number;
    }>;
  }>[];
}>;

export type CodexDirectBackwardCursor = CodexBackwardStreamCursorV3 | CodexBackwardStreamCursorV4;

export function encodeCodexDirectBackwardCursor(value: CodexDirectBackwardCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCodexDirectBackwardCursor(raw: string | undefined): CodexDirectBackwardCursor | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if ((record.v !== 3 && record.v !== 4) || record.kind !== 'codexBackwardStreamVector') return null;
    const rawStreams = Array.isArray(record.streams) ? record.streams : [];
    const streams = rawStreams
      .map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
        const streamRecord = entry as Record<string, unknown>;
        const fileRelPath = typeof streamRecord.fileRelPath === 'string' ? streamRecord.fileRelPath.trim() : '';
        const endOffsetBytes = typeof streamRecord.endOffsetBytes === 'number' && Number.isFinite(streamRecord.endOffsetBytes)
          ? Math.trunc(streamRecord.endOffsetBytes)
          : NaN;
        if (!fileRelPath || !Number.isFinite(endOffsetBytes) || endOffsetBytes < 0) return null;
        if (record.v === 3) return { fileRelPath, endOffsetBytes };
        const threadId = typeof streamRecord.threadId === 'string' ? streamRecord.threadId.trim() : '';
        if (!threadId) return null;
        const discoveredFrom = (() => {
          if (!streamRecord.discoveredFrom || typeof streamRecord.discoveredFrom !== 'object'
              || Array.isArray(streamRecord.discoveredFrom)) return undefined;
          const discovery = streamRecord.discoveredFrom as Record<string, unknown>;
          const parentFileRelPath = typeof discovery.fileRelPath === 'string' ? discovery.fileRelPath.trim() : '';
          const lineStartOffsetBytes = typeof discovery.lineStartOffsetBytes === 'number'
            && Number.isFinite(discovery.lineStartOffsetBytes)
            ? Math.trunc(discovery.lineStartOffsetBytes)
            : NaN;
          if (!parentFileRelPath || !Number.isSafeInteger(lineStartOffsetBytes) || lineStartOffsetBytes < 0) return null;
          return { fileRelPath: parentFileRelPath, lineStartOffsetBytes };
        })();
        if (streamRecord.discoveredFrom !== undefined && !discoveredFrom) return null;
        return { fileRelPath, endOffsetBytes, threadId, ...(discoveredFrom ? { discoveredFrom } : {}) };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    if (streams.length !== rawStreams.length) return null;
    if (new Set(streams.map((entry) => entry.fileRelPath)).size !== streams.length) return null;
    if (record.v === 3) {
      const legacyStreams = streams.map((entry) => ({
        fileRelPath: entry.fileRelPath,
        endOffsetBytes: entry.endOffsetBytes,
      }));
      return { v: 3, kind: 'codexBackwardStreamVector', streams: legacyStreams };
    }
    const durableStreams = streams.filter((entry): entry is Extract<typeof entry, { threadId: string }> => (
      'threadId' in entry && typeof entry.threadId === 'string'
    ));
    if (durableStreams.length !== streams.length) return null;
    return { v: 4, kind: 'codexBackwardStreamVector', streams: durableStreams };
  } catch {
    return null;
  }
}
