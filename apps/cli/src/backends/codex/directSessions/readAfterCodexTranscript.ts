import { stat } from 'node:fs/promises';

import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { readJsonlFileForward } from '@/backends/directSessions/filePaging/jsonlForwardReader';

import { collectCodexSessionRolloutFiles, type CodexRolloutFile } from './collectCodexSessionRolloutFiles';
import { mapCodexRolloutLineToDirectMessages } from './mapCodexRolloutLineToDirectMessages';
import { resolveCodexHomesForDirectSessionsSource } from './resolveCodexHomesForDirectSessionsSource';

type CodexForwardCursorV1 = Readonly<{
  v: 1;
  kind: 'codexForward';
  fileRelPath: string;
  offsetBytes: number;
}>;

function encodeForwardCursor(value: CodexForwardCursorV1): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeForwardCursor(raw: string): CodexForwardCursorV1 | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as any;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.v !== 1 || parsed.kind !== 'codexForward') return null;
    const fileRelPath = typeof parsed.fileRelPath === 'string' ? parsed.fileRelPath : '';
    const offsetBytes = typeof parsed.offsetBytes === 'number' && Number.isFinite(parsed.offsetBytes) ? Math.trunc(parsed.offsetBytes) : NaN;
    if (!fileRelPath.trim()) return null;
    if (!Number.isFinite(offsetBytes) || offsetBytes < 0) return null;
    return { v: 1, kind: 'codexForward', fileRelPath, offsetBytes };
  } catch {
    return null;
  }
}

function selectBestCodexHomeWithFiles(homes: readonly string[], perHomeFiles: readonly CodexRolloutFile[][]): { codexHome: string; files: CodexRolloutFile[] } | null {
  let best: { codexHome: string; files: CodexRolloutFile[]; latestMtimeMs: number } | null = null;
  for (let i = 0; i < homes.length; i++) {
    const home = homes[i]!;
    const files = perHomeFiles[i] ?? [];
    if (files.length === 0) continue;
    const latestMtimeMs = Math.max(...files.map((f) => f.mtimeMs));
    if (!best || latestMtimeMs > best.latestMtimeMs) {
      best = { codexHome: home, files, latestMtimeMs };
    }
  }
  return best ? { codexHome: best.codexHome, files: best.files } : null;
}

export async function readAfterCodexTranscript(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  env?: NodeJS.ProcessEnv;
  remoteSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<Readonly<{ items: DirectTranscriptRawMessageV1[]; nextCursor: string | null; truncated: boolean }>> {
  const env = params.env ?? process.env;
  const homes = await resolveCodexHomesForDirectSessionsSource({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env,
  });

  const perHomeFiles = await Promise.all(homes.map((home) => collectCodexSessionRolloutFiles({ codexHome: home, remoteSessionId: params.remoteSessionId })));
  const best = selectBestCodexHomeWithFiles(homes, perHomeFiles);
  const files = best?.files ?? [];
  if (files.length === 0) {
    return { items: [], nextCursor: null, truncated: false };
  }

  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
  const maxItems = Math.max(1, Math.trunc(params.maxItems));

  const lastFile = files[files.length - 1]!;

  if (params.cursor === 'tail') {
    const fileSize = await stat(lastFile.filePath).then((s) => s.size).catch(() => 0);
    return {
      items: [],
      nextCursor: encodeForwardCursor({ v: 1, kind: 'codexForward', fileRelPath: lastFile.fileRelPath, offsetBytes: fileSize }),
      truncated: false,
    };
  }

  const decoded = decodeForwardCursor(params.cursor);
  if (!decoded) {
    return { items: [], nextCursor: null, truncated: true };
  }

  const startIndex = files.findIndex((f) => f.fileRelPath === decoded.fileRelPath);
  if (startIndex === -1) {
    const fileSize = await stat(lastFile.filePath).then((s) => s.size).catch(() => 0);
    return {
      items: [],
      nextCursor: encodeForwardCursor({ v: 1, kind: 'codexForward', fileRelPath: lastFile.fileRelPath, offsetBytes: fileSize }),
      truncated: true,
    };
  }

  const items: DirectTranscriptRawMessageV1[] = [];
  let truncated = false;
  let remainingBytes = maxBytes;
  let remainingItems = maxItems;
  let fileIndex = startIndex;
  let offsetBytes = Math.max(0, decoded.offsetBytes);

  while (fileIndex < files.length && remainingBytes > 0 && remainingItems > 0) {
    const file = files[fileIndex]!;
    const read = await readJsonlFileForward({
      filePath: file.filePath,
      offsetBytes,
      maxBytes: remainingBytes,
      maxItems: remainingItems,
    });

    if (read.truncated) {
      truncated = true;
      break;
    }

    for (const line of read.items) {
      if (items.length >= maxItems) break;
      const mapped = mapCodexRolloutLineToDirectMessages({
        fileRelPath: file.fileRelPath,
        lineStartOffsetBytes: line.startOffsetBytes,
        lineValue: line.value,
      });
      for (const msg of mapped) {
        if (items.length >= maxItems) break;
        items.push(msg);
      }
    }

    remainingItems = maxItems - items.length;
    remainingBytes -= Math.max(0, read.nextOffsetBytes - offsetBytes);
    offsetBytes = read.nextOffsetBytes;

    if (read.reachedEnd) {
      fileIndex += 1;
      offsetBytes = 0;
      continue;
    }

    break;
  }

  const nextCursor = (() => {
    if (fileIndex >= files.length) {
      return encodeForwardCursor({ v: 1, kind: 'codexForward', fileRelPath: lastFile.fileRelPath, offsetBytes: offsetBytes });
    }
    const file = files[Math.max(0, Math.min(files.length - 1, fileIndex))]!;
    return encodeForwardCursor({ v: 1, kind: 'codexForward', fileRelPath: file.fileRelPath, offsetBytes });
  })();

  return { items, nextCursor, truncated };
}

