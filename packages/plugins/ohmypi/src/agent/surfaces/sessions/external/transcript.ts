import { stat } from 'node:fs/promises';

import type {
  ExternalSessionFollowLeaseV1,
  ExternalSessionRuntimeContextV1,
  ExternalSessionTranscriptPageV1,
  ExternalSessionTranscriptRawMessageV1,
  ExternalSessionsSource,
} from '@happier-dev/plugin-sdk/sessions';
import {
  decodeJsonlByteCursor,
  encodeJsonlByteCursor,
  readJsonlAfterCursor,
} from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';

import {
  buildOhMyPiSessionSnapshot,
  decodeOhMyPiTranscriptCursor,
  encodeOhMyPiTranscriptCursor,
  parseOhMyPiJsonlLine,
  projectOhMyPiSessionSnapshotToDirectMessages,
  readOhMyPiSessionSnapshot,
} from '../../../transcripts/snapshot.js';
import { resolveOhMyPiSessionFile } from './files.js';

type PagingParams = Readonly<{
  cursor?: string;
  maxBytes?: number;
  maxItems?: number;
}>;

function measureItemBytes(item: ExternalSessionTranscriptRawMessageV1): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8');
}

export function pageOhMyPiTranscriptItems(
  items: readonly ExternalSessionTranscriptRawMessageV1[],
  params?: PagingParams,
): ExternalSessionTranscriptPageV1 {
  const endExclusive = decodeOhMyPiTranscriptCursor(params?.cursor ?? null, items.length);
  const maxItems = Math.max(1, Math.trunc(params?.maxItems ?? 100));
  const maxBytes = Math.max(1024, Math.trunc(params?.maxBytes ?? 1024 * 1024));

  const selected: ExternalSessionTranscriptRawMessageV1[] = [];
  let usedBytes = 0;
  let nextIndex = endExclusive;
  for (let index = Math.min(endExclusive, items.length) - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    const itemBytes = measureItemBytes(item);
    if (selected.length > 0 && (selected.length >= maxItems || usedBytes + itemBytes > maxBytes)) break;
    selected.unshift(item);
    usedBytes += itemBytes;
    nextIndex = index;
    if (selected.length >= maxItems) break;
  }

  return {
    items: selected,
    nextCursor: nextIndex > 0 ? encodeOhMyPiTranscriptCursor(nextIndex) : null,
    hasMore: nextIndex > 0,
    tailCursor: encodeOhMyPiTranscriptCursor(items.length),
    truncated: false,
  };
}

export function readAfterOhMyPiTranscriptItems(
  items: readonly ExternalSessionTranscriptRawMessageV1[],
  params?: PagingParams,
): ExternalSessionTranscriptPageV1 {
  const startIndex = decodeOhMyPiTranscriptCursor(params?.cursor ?? null, items.length);
  const maxItems = Math.max(1, Math.trunc(params?.maxItems ?? 100));
  const maxBytes = Math.max(1024, Math.trunc(params?.maxBytes ?? 1024 * 1024));

  const selected: ExternalSessionTranscriptRawMessageV1[] = [];
  let usedBytes = 0;
  let nextIndex = Math.min(startIndex, items.length);
  for (let index = Math.min(startIndex, items.length); index < items.length; index += 1) {
    const item = items[index]!;
    const itemBytes = measureItemBytes(item);
    if (selected.length > 0 && (selected.length >= maxItems || usedBytes + itemBytes > maxBytes)) break;
    selected.push(item);
    usedBytes += itemBytes;
    nextIndex = index + 1;
    if (selected.length >= maxItems) break;
  }

  return {
    items: selected,
    nextCursor: encodeOhMyPiTranscriptCursor(nextIndex),
    truncated: nextIndex < items.length,
  };
}

export async function pageOhMyPiSessionTranscript(params: Readonly<{
  source: ExternalSessionsSource;
  env?: NodeJS.ProcessEnv;
  providerSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<ExternalSessionTranscriptPageV1> {
  if (params.direction !== 'older') {
    return { items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false };
  }
  const resolved = await resolveOhMyPiSessionFile({
    source: params.source,
    env: params.env,
    remoteSessionId: params.providerSessionId,
  });
  if (!resolved) {
    return { items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false };
  }
  const snapshot = await readOhMyPiSessionSnapshot({
    sessionFilePath: resolved.filePath,
    sessionId: params.providerSessionId,
  });
  const page = pageOhMyPiTranscriptItems(snapshot.items, params);
  try {
    const file = await stat(resolved.filePath);
    return {
      ...page,
      tailCursor: encodeJsonlByteCursor({
        v: 1,
        kind: 'byteOffset',
        offset: Math.max(0, Math.trunc(file.size)),
      }),
    };
  } catch {
    return page;
  }
}

export async function readAfterOhMyPiSessionTranscript(params: Readonly<{
  source: ExternalSessionsSource;
  env?: NodeJS.ProcessEnv;
  providerSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<ExternalSessionTranscriptPageV1> {
  const resolved = await resolveOhMyPiSessionFile({
    source: params.source,
    env: params.env,
    remoteSessionId: params.providerSessionId,
  });
  if (!resolved) {
    return {
      items: [],
      nextCursor: encodeJsonlByteCursor({ v: 1, kind: 'byteOffset', offset: 0 }),
      truncated: false,
    };
  }
  const cursor = decodeJsonlByteCursor(params.cursor);
  if (!cursor) {
    try {
      const file = await stat(resolved.filePath);
      return {
        items: [],
        nextCursor: encodeJsonlByteCursor({
          v: 1,
          kind: 'byteOffset',
          offset: Math.max(0, Math.trunc(file.size)),
        }),
        truncated: false,
      };
    } catch {
      return {
        items: [],
        nextCursor: encodeJsonlByteCursor({ v: 1, kind: 'byteOffset', offset: 0 }),
        truncated: false,
      };
    }
  }
  const read = await readJsonlAfterCursor({
    filePath: resolved.filePath,
    cursor,
    maxBytes: params.maxBytes,
    maxItems: params.maxItems,
  });
  const lines = read.lines
    .map(parseOhMyPiJsonlLine)
    .filter((line): line is unknown => line !== null);
  const projected = projectOhMyPiSessionSnapshotToDirectMessages({
    sessionFilePath: resolved.filePath,
    sessionId: params.providerSessionId,
    lines: [
      { type: 'session', id: params.providerSessionId },
      ...lines,
    ],
  });
  return {
    items: projected.items,
    nextCursor: encodeJsonlByteCursor(read.nextCursor),
    truncated: read.truncated,
  };
}

function findCommonPrefixLength(
  previous: readonly ExternalSessionTranscriptRawMessageV1[],
  next: readonly ExternalSessionTranscriptRawMessageV1[],
): number {
  const max = Math.min(previous.length, next.length);
  let index = 0;
  while (index < max && previous[index]?.id === next[index]?.id) {
    index += 1;
  }
  return index;
}

export async function acquireOhMyPiSessionFollowLease(params: Readonly<{
  source: ExternalSessionsSource;
  env?: NodeJS.ProcessEnv;
  providerSessionId: string;
  runtime?: ExternalSessionRuntimeContextV1;
}>): Promise<ExternalSessionFollowLeaseV1 | null> {
  const fileFollow = params.runtime?.transcripts?.fileFollow;
  if (!fileFollow) return null;
  const resolved = await resolveOhMyPiSessionFile({
    source: params.source,
    env: params.env,
    remoteSessionId: params.providerSessionId,
  });
  if (!resolved) return null;

  let lines: unknown[] = [];
  let projected = buildOhMyPiSessionSnapshot({
    sessionFilePath: resolved.filePath,
    sessionId: params.providerSessionId,
    lines,
  });
  let tailCursor = projected.tailCursor;
  let initialDrainComplete = false;
  const listeners = new Set<(update: Readonly<{
    items: ExternalSessionTranscriptRawMessageV1[];
    nextCursor: string | null;
    truncated: boolean;
  }>) => void | Promise<void>>();

  const followHandle = await fileFollow.follow({
    path: resolved.filePath,
    startAt: 'beginning',
    strategy: 'poll',
    ...(params.runtime?.signal ? { signal: params.runtime.signal } : {}),
    onLine: async ({ line }) => {
      const parsed = parseOhMyPiJsonlLine(line);
      if (parsed === null) return;
      lines = [...lines, parsed];
      const nextProjected = projectOhMyPiSessionSnapshotToDirectMessages({
        sessionFilePath: resolved.filePath,
        sessionId: params.providerSessionId,
        lines,
      });
      const fromCursor = tailCursor;
      const changedFrom = findCommonPrefixLength(projected.items, nextProjected.items);
      const changedItems = nextProjected.items.slice(changedFrom);
      projected = {
        ...nextProjected,
        tailCursor: encodeOhMyPiTranscriptCursor(nextProjected.items.length),
      };
      tailCursor = projected.tailCursor;
      if (!initialDrainComplete || changedItems.length === 0) return;
      const update = { items: changedItems, fromCursor, nextCursor: tailCursor, truncated: false };
      await Promise.all([...listeners].map((listener) => listener(update)));
    },
    onError: async (error) => {
      await params.runtime?.diagnostics.issue({
        code: 'ohmypi.external_session.file_follow_error',
        severity: 'warning',
        retryable: true,
        safeMessage: error instanceof Error ? error.message : 'OhMyPi transcript file-follow failed',
      });
    },
  });
  try {
    await followHandle.drainNow();
    initialDrainComplete = true;
  } catch (error) {
    await followHandle.close().catch(() => undefined);
    throw error;
  }

  return {
    release: async () => {
      listeners.clear();
      await followHandle.close({ finalDrain: true });
    },
    getTailCursor: () => tailCursor,
    subscribeToTranscriptUpdates: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
