import { stat } from 'node:fs/promises';

import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { readJsonlFileBackwardPage } from '@/backends/directSessions/filePaging/jsonlBackwardPager';

import { resolveCodexHomesForDirectSessionsSource } from './resolveCodexHomesForDirectSessionsSource';
import { collectCodexSessionRolloutFiles, type CodexRolloutFile } from './collectCodexSessionRolloutFiles';
import { mapCodexRolloutLineToDirectMessages } from './mapCodexRolloutLineToDirectMessages';

type CodexBackwardCursorV1 = Readonly<{
  v: 1;
  kind: 'codexBackward';
  fileRelPath: string;
  endOffsetBytes: number;
}>;

function encodeBackwardCursor(value: CodexBackwardCursorV1): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeBackwardCursor(raw: string | undefined): CodexBackwardCursorV1 | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as any;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.v !== 1 || parsed.kind !== 'codexBackward') return null;
    const fileRelPath = typeof parsed.fileRelPath === 'string' ? parsed.fileRelPath : '';
    const endOffsetBytes = typeof parsed.endOffsetBytes === 'number' && Number.isFinite(parsed.endOffsetBytes) ? Math.trunc(parsed.endOffsetBytes) : NaN;
    if (!fileRelPath.trim()) return null;
    if (!Number.isFinite(endOffsetBytes) || endOffsetBytes < 0) return null;
    return { v: 1, kind: 'codexBackward', fileRelPath, endOffsetBytes };
  } catch {
    return null;
  }
}

type RolloutFile = CodexRolloutFile;

export async function pageCodexTranscript(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  env?: NodeJS.ProcessEnv;
  remoteSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<Readonly<{ items: DirectTranscriptRawMessageV1[]; nextCursor: string | null; hasMore: boolean; truncated?: boolean }>> {
  const env = params.env ?? process.env;
  const homes = await resolveCodexHomesForDirectSessionsSource({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env,
  });

  let best: { codexHome: string; files: RolloutFile[] } | null = null;
  for (const home of homes) {
    const files = await collectCodexSessionRolloutFiles({ codexHome: home, remoteSessionId: params.remoteSessionId });
    if (files.length === 0) continue;
    const latestMtime = Math.max(...files.map((f) => f.mtimeMs));
    if (!best) {
      best = { codexHome: home, files };
      continue;
    }
    const bestLatest = Math.max(...best.files.map((f) => f.mtimeMs));
    if (latestMtime > bestLatest) {
      best = { codexHome: home, files };
    }
  }

  const files = best?.files ?? [];
  if (files.length === 0) {
    return { items: [], nextCursor: null, hasMore: false };
  }

  if (params.direction !== 'older') {
    // Forward paging is not required for v1 UI flows (tail uses readAfter).
    // Return empty to avoid surprising ordering bugs until the UI needs it.
    return { items: [], nextCursor: null, hasMore: false };
  }

  const cursor = decodeBackwardCursor(params.cursor);
  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
  const maxItems = Math.max(1, Math.trunc(params.maxItems));

  let fileIndex = files.length - 1;
  let endOffsetBytes: number | null = null;
  let truncated = false;

  if (cursor) {
    const idx = files.findIndex((f) => f.fileRelPath === cursor.fileRelPath);
    if (idx === -1) {
      truncated = true;
    } else {
      fileIndex = idx;
      endOffsetBytes = cursor.endOffsetBytes;
    }
  }

  const chunks: DirectTranscriptRawMessageV1[][] = [];
  let remainingBytes = maxBytes;
  let remainingItems = maxItems;
  let nextCursorCandidate: CodexBackwardCursorV1 | null = null;

  while (fileIndex >= 0 && remainingBytes > 0 && remainingItems > 0) {
    const file = files[fileIndex]!;
    const fileStat = await stat(file.filePath).catch(() => null);
    const fileSize = fileStat ? fileStat.size : 0;
    const resolvedEnd = endOffsetBytes === null ? fileSize : Math.min(fileSize, Math.max(0, Math.trunc(endOffsetBytes)));

    if (resolvedEnd <= 0) {
      endOffsetBytes = null;
      fileIndex -= 1;
      continue;
    }

    const page = await readJsonlFileBackwardPage({
      filePath: file.filePath,
      endOffsetBytes: resolvedEnd,
      maxBytes: remainingBytes,
      maxItems: remainingItems,
    });

    const mapped: DirectTranscriptRawMessageV1[] = [];
    for (const line of page.items) {
      if (mapped.length >= remainingItems) break;
      const messages = mapCodexRolloutLineToDirectMessages({
        fileRelPath: file.fileRelPath,
        lineStartOffsetBytes: line.startOffsetBytes,
        lineValue: line.value,
      });
      for (const msg of messages) {
        if (mapped.length >= remainingItems) break;
        mapped.push(msg);
      }
    }

    if (mapped.length > 0) {
      chunks.unshift(mapped);
      nextCursorCandidate = {
        v: 1,
        kind: 'codexBackward',
        fileRelPath: file.fileRelPath,
        endOffsetBytes: page.nextEndOffsetBytes,
      };
      remainingItems -= mapped.length;
      remainingBytes -= Math.max(0, resolvedEnd - page.nextEndOffsetBytes);
    }

    if (page.reachedStart) {
      endOffsetBytes = null;
      fileIndex -= 1;
      continue;
    }

    endOffsetBytes = page.nextEndOffsetBytes;
    if (remainingBytes <= 0 || remainingItems <= 0) break;
    // Continue on the same file to page further back.
  }

  const items = chunks.flat();
  if (!nextCursorCandidate || items.length === 0) {
    return { items, nextCursor: null, hasMore: false, ...(truncated ? { truncated } : {}) };
  }

  const hasMore = nextCursorCandidate.endOffsetBytes > 0 || files.findIndex((f) => f.fileRelPath === nextCursorCandidate.fileRelPath) > 0;
  const nextCursor = hasMore ? encodeBackwardCursor(nextCursorCandidate) : null;
  return { items, nextCursor, hasMore, ...(truncated ? { truncated } : {}) };
}
