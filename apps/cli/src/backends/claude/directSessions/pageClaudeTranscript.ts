import { stat } from 'node:fs/promises';

import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { readJsonlFileBackwardPage } from '@/api/directSessions/filePaging/jsonlBackwardPager';

import { encodeClaudeDirectForwardCursor } from './claudeDirectForwardCursor';
import { mapClaudeJsonlLineToDirectMessages } from './mapClaudeJsonlLineToDirectMessages';
import { resolveClaudeDirectSessionFile } from './resolveClaudeDirectSessionFile';

type ClaudeBackwardCursorV1 = Readonly<{
  v: 1;
  kind: 'claudeBackward';
  fileRelPath: string;
  endOffsetBytes: number;
}>;

function encodeBackwardCursor(value: ClaudeBackwardCursorV1): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeBackwardCursor(raw: string | undefined): ClaudeBackwardCursorV1 | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as any;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.v !== 1 || parsed.kind !== 'claudeBackward') return null;
    const fileRelPath = typeof parsed.fileRelPath === 'string' ? parsed.fileRelPath : '';
    const endOffsetBytes = typeof parsed.endOffsetBytes === 'number' && Number.isFinite(parsed.endOffsetBytes) ? Math.trunc(parsed.endOffsetBytes) : NaN;
    if (!fileRelPath.trim()) return null;
    if (!Number.isFinite(endOffsetBytes) || endOffsetBytes < 0) return null;
    return { v: 1, kind: 'claudeBackward', fileRelPath, endOffsetBytes };
  } catch {
    return null;
  }
}

export async function pageClaudeTranscript(params: Readonly<{
  source: DirectSessionsSource;
  env?: NodeJS.ProcessEnv;
  remoteSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<Readonly<{ items: DirectTranscriptRawMessageV1[]; nextCursor: string | null; tailCursor: string | null; hasMore: boolean; truncated?: boolean }>> {
  const env = params.env ?? process.env;
  const resolved = await resolveClaudeDirectSessionFile({
    source: params.source,
    env,
    remoteSessionId: params.remoteSessionId,
  });
  if (!resolved) {
    return { items: [], nextCursor: null, tailCursor: null, hasMore: false };
  }

  if (params.direction !== 'older') {
    // Forward paging is not required for v1 UI flows (tail uses readAfter).
    return { items: [], nextCursor: null, tailCursor: null, hasMore: false };
  }

  const cursor = decodeBackwardCursor(params.cursor);
  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
  const maxItems = Math.max(1, Math.trunc(params.maxItems));

  const fileStat = await stat(resolved.filePath).catch(() => null);
  const fileSize = fileStat ? fileStat.size : 0;
  const tailCursor = encodeClaudeDirectForwardCursor({
    v: 1,
    kind: 'claudeForward',
    fileRelPath: resolved.fileRelPath,
    offsetBytes: fileSize,
  });

  let truncated = false;
  let endOffsetBytes: number | null = null;
  if (cursor) {
    if (cursor.fileRelPath !== resolved.fileRelPath) {
      truncated = true;
      endOffsetBytes = null;
    } else {
      endOffsetBytes = cursor.endOffsetBytes;
    }
  }

  const resolvedEnd = endOffsetBytes === null ? fileSize : Math.min(fileSize, Math.max(0, Math.trunc(endOffsetBytes)));
  if (resolvedEnd <= 0) {
    return { items: [], nextCursor: null, tailCursor, hasMore: false, ...(truncated ? { truncated } : {}) };
  }

  const page = await readJsonlFileBackwardPage({
    filePath: resolved.filePath,
    endOffsetBytes: resolvedEnd,
    maxBytes,
    maxItems,
  });

  const items: DirectTranscriptRawMessageV1[] = [];
  for (const line of page.items) {
    if (items.length >= maxItems) break;
    const mapped = mapClaudeJsonlLineToDirectMessages({
      fileRelPath: resolved.fileRelPath,
      lineStartOffsetBytes: line.startOffsetBytes,
      lineValue: line.value,
    });
    for (const msg of mapped) {
      if (items.length >= maxItems) break;
      items.push(msg);
    }
  }

  const hasMore = !page.reachedStart;
  const nextCursorCandidate: ClaudeBackwardCursorV1 = {
    v: 1,
    kind: 'claudeBackward',
    fileRelPath: resolved.fileRelPath,
    endOffsetBytes: page.nextEndOffsetBytes,
  };
  const nextCursor = hasMore ? encodeBackwardCursor(nextCursorCandidate) : null;

  return { items, nextCursor, tailCursor, hasMore, ...(truncated ? { truncated } : {}) };
}
