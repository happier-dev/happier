import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { resolveCodexHomesForDirectSessionsSource } from './resolveCodexHomesForDirectSessionsSource';
import { encodeCodexDirectForwardCursor } from './codexDirectForwardCursor';
import { collectCodexSessionRolloutFiles } from './collectCodexSessionRolloutFiles';
import { materializeCodexDirectTranscriptItems } from './materializeCodexDirectTranscriptItems';
import {
  mapCodexDirectSessionAppServerPreviewToMessage,
  resolveCodexDirectSessionAppServerMetadata,
} from './resolveCodexDirectSessionAppServerMetadata';

type CodexBackwardMergedCursorV2 = Readonly<{
  v: 2;
  kind: 'codexBackwardMerged';
  endIndex: number;
}>;

function encodeBackwardCursor(value: CodexBackwardMergedCursorV2): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeBackwardCursor(raw: string | undefined): CodexBackwardMergedCursorV2 | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (record.v !== 2 || record.kind !== 'codexBackwardMerged') return null;
    const endIndex = typeof record.endIndex === 'number' && Number.isFinite(record.endIndex) ? Math.trunc(record.endIndex) : NaN;
    if (!Number.isFinite(endIndex) || endIndex < 0) return null;
    return { v: 2, kind: 'codexBackwardMerged', endIndex };
  } catch {
    return null;
  }
}

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

function buildMergedTailCursor(items: readonly DirectTranscriptRawMessageV1[]): string | null {
  const last = items.at(-1);
  if (!last) return null;
  return encodeCodexDirectForwardCursor({
    v: 3,
    kind: 'codexForwardMerged',
    lastCreatedAtMs: last.createdAtMs,
    lastId: last.id,
  });
}

function measureDirectTranscriptItemBytes(item: DirectTranscriptRawMessageV1): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8');
}

export async function pageCodexTranscript(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  env?: NodeJS.ProcessEnv;
  remoteSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<Readonly<{ items: DirectTranscriptRawMessageV1[]; nextCursor: string | null; tailCursor: string | null; hasMore: boolean; truncated?: boolean }>> {
  const env = params.env ?? process.env;
  const homes = await resolveCodexHomesForDirectSessionsSource({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env,
  });

  const perHomeFiles = await Promise.all(homes.map((home) => collectCodexSessionRolloutFiles({ codexHome: home, remoteSessionId: params.remoteSessionId })));
  const bestHome = selectBestCodexHomeWithFiles(homes, perHomeFiles);

  const appServerMetadata = await resolveCodexDirectSessionAppServerMetadata({
    source: params.source,
    activeServerDir: params.activeServerDir,
    remoteSessionId: params.remoteSessionId,
    env,
  });

  if (bestHome === null) {
    const previewItem = appServerMetadata
      ? mapCodexDirectSessionAppServerPreviewToMessage({ remoteSessionId: params.remoteSessionId, metadata: appServerMetadata })
      : null;
    const tailCursor = appServerMetadata
      ? encodeCodexDirectForwardCursor({
        v: 2,
        kind: 'codexForwardAppServer',
        updatedAtMs: appServerMetadata.updatedAtMs,
        previewText: appServerMetadata.previewText,
      })
      : null;
    return { items: previewItem ? [previewItem] : [], nextCursor: null, tailCursor, hasMore: false };
  }

  const allItems = await materializeCodexDirectTranscriptItems({
    codexHome: bestHome,
    remoteSessionId: params.remoteSessionId,
  });
  const tailCursor = buildMergedTailCursor(allItems);

  if (params.direction !== 'older') {
    return { items: [], nextCursor: null, tailCursor, hasMore: false };
  }

  const decoded = decodeBackwardCursor(params.cursor);
  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
  const maxItems = Math.max(1, Math.trunc(params.maxItems));
  let endIndex = decoded ? Math.min(Math.max(0, decoded.endIndex), allItems.length) : allItems.length;
  const selectedReversed: DirectTranscriptRawMessageV1[] = [];
  let usedBytes = 0;

  for (let index = endIndex - 1; index >= 0; index -= 1) {
    const item = allItems[index]!;
    const itemBytes = measureDirectTranscriptItemBytes(item);
    if (selectedReversed.length > 0 && (selectedReversed.length >= maxItems || usedBytes + itemBytes > maxBytes)) {
      break;
    }
    selectedReversed.push(item);
    usedBytes += itemBytes;
    if (selectedReversed.length >= maxItems || usedBytes >= maxBytes) {
      break;
    }
  }

  const items = selectedReversed.reverse();
  const nextEndIndex = Math.max(0, endIndex - items.length);
  const hasMore = nextEndIndex > 0;
  const nextCursor = hasMore ? encodeBackwardCursor({ v: 2, kind: 'codexBackwardMerged', endIndex: nextEndIndex }) : null;
  return { items, nextCursor, tailCursor, hasMore };
}
