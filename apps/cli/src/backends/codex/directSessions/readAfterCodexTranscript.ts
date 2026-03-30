import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { resolveCodexHomesForDirectSessionsSource } from './resolveCodexHomesForDirectSessionsSource';
import { decodeCodexDirectForwardCursor, encodeCodexDirectForwardCursor } from './codexDirectForwardCursor';
import { collectCodexSessionRolloutFiles } from './collectCodexSessionRolloutFiles';
import { materializeCodexDirectTranscriptItems } from './materializeCodexDirectTranscriptItems';
import {
  mapCodexDirectSessionAppServerPreviewToMessage,
  resolveCodexDirectSessionAppServerMetadata,
} from './resolveCodexDirectSessionAppServerMetadata';

function selectBestCodexHomeWithFiles(homes: readonly string[], perHomeFiles: readonly (readonly unknown[])[]): string | null {
  let bestHome: string | null = null;
  let bestLatestMtimeMs = -1;
  for (let index = 0; index < homes.length; index += 1) {
    const home = homes[index]!;
    const files = perHomeFiles[index] ?? [];
    if (files.length === 0) continue;
    const latestMtimeMs = Math.max(...(files as { mtimeMs: number }[]).map((file) => file.mtimeMs));
    if (latestMtimeMs > bestLatestMtimeMs) {
      bestLatestMtimeMs = latestMtimeMs;
      bestHome = home;
    }
  }
  return bestHome;
}

function buildMergedTailCursor(items: readonly DirectTranscriptRawMessageV1[]): string {
  const last = items.at(-1);
  return encodeCodexDirectForwardCursor({
    v: 3,
    kind: 'codexForwardMerged',
    lastCreatedAtMs: last?.createdAtMs ?? 0,
    lastId: last?.id ?? null,
  });
}

function measureDirectTranscriptItemBytes(item: DirectTranscriptRawMessageV1): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8');
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
  const bestHome = selectBestCodexHomeWithFiles(homes, perHomeFiles);
  const appServerMetadata = bestHome === null || params.cursor === 'tail'
    ? await resolveCodexDirectSessionAppServerMetadata({
      source: params.source,
      activeServerDir: params.activeServerDir,
      remoteSessionId: params.remoteSessionId,
      env,
    })
    : null;

  if (bestHome === null) {
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

  const allItems = await materializeCodexDirectTranscriptItems({
    codexHome: bestHome,
    remoteSessionId: params.remoteSessionId,
  });

  if (params.cursor === 'tail') {
    return {
      items: [],
      nextCursor: buildMergedTailCursor(allItems),
      truncated: false,
    };
  }

  const decoded = decodeCodexDirectForwardCursor(params.cursor);
  if (!decoded) {
    return { items: [], nextCursor: buildMergedTailCursor(allItems), truncated: true };
  }

  if (decoded.kind !== 'codexForwardMerged') {
    return { items: [], nextCursor: buildMergedTailCursor(allItems), truncated: true };
  }

  let startIndex = 0;
  if (decoded.lastId) {
    const foundIndex = allItems.findIndex((item) => item.id === decoded.lastId && item.createdAtMs === decoded.lastCreatedAtMs);
    if (foundIndex === -1) {
      return { items: [], nextCursor: buildMergedTailCursor(allItems), truncated: true };
    }
    startIndex = foundIndex + 1;
  }

  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
  const maxItems = Math.max(1, Math.trunc(params.maxItems));
  const items: DirectTranscriptRawMessageV1[] = [];
  let usedBytes = 0;

  for (let index = startIndex; index < allItems.length; index += 1) {
    const item = allItems[index]!;
    const itemBytes = measureDirectTranscriptItemBytes(item);
    if (items.length > 0 && (items.length >= maxItems || usedBytes + itemBytes > maxBytes)) {
      break;
    }
    items.push(item);
    usedBytes += itemBytes;
    if (items.length >= maxItems || usedBytes >= maxBytes) {
      break;
    }
  }

  const nextCursor = items.length > 0 ? buildMergedTailCursor([...allItems.slice(0, startIndex), ...items]) : buildMergedTailCursor(allItems);
  return { items, nextCursor, truncated: false };
}
