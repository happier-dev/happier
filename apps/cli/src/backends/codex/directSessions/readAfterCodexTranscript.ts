import { stat } from 'node:fs/promises';

import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { readJsonlFileForward } from '@/api/directSessions/filePaging/jsonlForwardReader';

import { decodeCodexDirectForwardCursor, encodeCodexDirectForwardCursor } from './codexDirectForwardCursor';
import { collectCodexSessionRolloutFiles, type CodexRolloutFile } from './collectCodexSessionRolloutFiles';
import { mapCodexRolloutLineToDirectMessages } from './mapCodexRolloutLineToDirectMessages';
import { resolveCodexHomesForDirectSessionsSource } from './resolveCodexHomesForDirectSessionsSource';
import {
  mapCodexDirectSessionAppServerPreviewToMessage,
  resolveCodexDirectSessionAppServerMetadata,
} from './resolveCodexDirectSessionAppServerMetadata';

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
  const appServerMetadata = files.length === 0 || params.cursor === 'tail'
    ? await resolveCodexDirectSessionAppServerMetadata({
      source: params.source,
      activeServerDir: params.activeServerDir,
      remoteSessionId: params.remoteSessionId,
      env,
    })
    : null;
  if (files.length === 0) {
    if (params.cursor === 'tail' && appServerMetadata) {
      return {
        items: [],
        nextCursor: encodeCodexDirectForwardCursor({
          v: 2,
          kind: 'codexForwardAppServer',
          updatedAtMs: appServerMetadata.updatedAtMs,
          previewText: appServerMetadata.previewText,
        }),
        truncated: false,
      };
    }

    const decodedEmpty = params.cursor === 'tail' ? null : decodeCodexDirectForwardCursor(params.cursor);
    if (decodedEmpty?.kind === 'codexForwardAppServer') {
      const nextMetadata = appServerMetadata;
      const changed = nextMetadata
        ? nextMetadata.updatedAtMs !== decodedEmpty.updatedAtMs || nextMetadata.previewText !== decodedEmpty.previewText
        : false;
      const previewItem = changed && nextMetadata
        ? mapCodexDirectSessionAppServerPreviewToMessage({ remoteSessionId: params.remoteSessionId, metadata: nextMetadata })
        : null;
      const nextCursor = encodeCodexDirectForwardCursor({
        v: 2,
        kind: 'codexForwardAppServer',
        updatedAtMs: appServerMetadata?.updatedAtMs ?? decodedEmpty.updatedAtMs,
        previewText: appServerMetadata?.previewText ?? decodedEmpty.previewText,
      });
      return { items: previewItem ? [previewItem] : [], nextCursor, truncated: false };
    }

    return { items: [], nextCursor: null, truncated: false };
  }

  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
  const maxItems = Math.max(1, Math.trunc(params.maxItems));

  const lastFile = files[files.length - 1]!;
  const lastFileSize = await stat(lastFile.filePath).then((s) => s.size).catch(() => 0);

  if (params.cursor === 'tail') {
    return {
      items: [],
      nextCursor: encodeCodexDirectForwardCursor({ v: 1, kind: 'codexForward', fileRelPath: lastFile.fileRelPath, offsetBytes: lastFileSize }),
      truncated: false,
    };
  }

  const decoded = decodeCodexDirectForwardCursor(params.cursor);
  if (!decoded) {
    return { items: [], nextCursor: null, truncated: true };
  }

  if (decoded.kind !== 'codexForward') {
    return {
      items: [],
      nextCursor: encodeCodexDirectForwardCursor({
        v: 1,
        kind: 'codexForward',
        fileRelPath: lastFile.fileRelPath,
        offsetBytes: lastFileSize,
      }),
      truncated: true,
    };
  }

  const startIndex = files.findIndex((f) => f.fileRelPath === decoded.fileRelPath);
  if (startIndex === -1) {
    const fileSize = await stat(lastFile.filePath).then((s) => s.size).catch(() => 0);
    return {
      items: [],
      nextCursor: encodeCodexDirectForwardCursor({ v: 1, kind: 'codexForward', fileRelPath: lastFile.fileRelPath, offsetBytes: fileSize }),
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
      return encodeCodexDirectForwardCursor({
        v: 1,
        kind: 'codexForward',
        fileRelPath: lastFile.fileRelPath,
        offsetBytes: lastFileSize,
      });
    }
    const file = files[Math.max(0, Math.min(files.length - 1, fileIndex))]!;
    return encodeCodexDirectForwardCursor({ v: 1, kind: 'codexForward', fileRelPath: file.fileRelPath, offsetBytes });
  })();

  return { items, nextCursor, truncated };
}
