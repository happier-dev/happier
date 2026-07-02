import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol';
import type { FileBackedTranscriptSessionStore, FileBackedTranscriptSessionStoreKey } from '@/api/session/fileBackedTranscripts/store';
import { createProjectedJsonlSessionStore } from '@/api/session/fileBackedTranscripts/jsonl/createProjectedJsonlSessionStore';
import { DEFAULT_JSONL_FOLLOW_POLICY } from '@/api/session/fileBackedTranscripts/jsonl/followPolicy';

import {
  decodeOhMyPiTranscriptCursor,
  encodeOhMyPiTranscriptCursor,
  readOhMyPiSessionSnapshot,
} from '@happier-dev/plugins-ohmypi/agent/transcripts/snapshot';
import { resolveOhMyPiSessionFile } from './resolveOhMyPiSessionFile';

type OhMyPiSessionStoreActivity = Readonly<{
  lastActivityAtMs: number | null;
  isRunning: boolean;
}>;

type PagingParams = Readonly<{
  cursor?: string;
  maxBytes?: number;
  maxItems?: number;
}>;

function measureItemBytes(item: ExternalSessionTranscriptRawMessageV1): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8');
}

function pageOlderItems(items: readonly ExternalSessionTranscriptRawMessageV1[], params?: PagingParams) {
  const endExclusive = decodeOhMyPiTranscriptCursor(params?.cursor ?? null, items.length);
  const maxItems = Math.max(1, Math.trunc(params?.maxItems ?? 100));
  const maxBytes = Math.max(1024, Math.trunc(params?.maxBytes ?? 1024 * 1024));

  const selected: ExternalSessionTranscriptRawMessageV1[] = [];
  let usedBytes = 0;
  let nextIndex = endExclusive;
  for (let index = Math.min(endExclusive, items.length) - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    const itemBytes = measureItemBytes(item);
    if (selected.length > 0 && (selected.length >= maxItems || usedBytes + itemBytes > maxBytes)) {
      break;
    }
    selected.unshift(item);
    usedBytes += itemBytes;
    nextIndex = index;
    if (selected.length >= maxItems) {
      break;
    }
  }

  return {
    items: selected,
    nextCursor: nextIndex > 0 ? encodeOhMyPiTranscriptCursor(nextIndex) : null,
    hasMore: nextIndex > 0,
    tailCursor: encodeOhMyPiTranscriptCursor(items.length),
    truncated: false,
  };
}

function readAfterItems(items: readonly ExternalSessionTranscriptRawMessageV1[], params?: PagingParams) {
  const startIndex = decodeOhMyPiTranscriptCursor(params?.cursor ?? null, items.length);
  const maxItems = Math.max(1, Math.trunc(params?.maxItems ?? 100));
  const maxBytes = Math.max(1024, Math.trunc(params?.maxBytes ?? 1024 * 1024));

  const selected: ExternalSessionTranscriptRawMessageV1[] = [];
  let usedBytes = 0;
  let nextIndex = Math.min(startIndex, items.length);
  for (let index = Math.min(startIndex, items.length); index < items.length; index += 1) {
    const item = items[index]!;
    const itemBytes = measureItemBytes(item);
    if (selected.length > 0 && (selected.length >= maxItems || usedBytes + itemBytes > maxBytes)) {
      break;
    }
    selected.push(item);
    usedBytes += itemBytes;
    nextIndex = index + 1;
    if (selected.length >= maxItems) {
      break;
    }
  }

  return {
    items: selected,
    nextCursor: encodeOhMyPiTranscriptCursor(nextIndex),
    truncated: nextIndex < items.length,
  };
}

export function createOhMyPiJsonlSessionStore(key: FileBackedTranscriptSessionStoreKey): FileBackedTranscriptSessionStore<
  ExternalSessionTranscriptRawMessageV1,
  OhMyPiSessionStoreActivity,
  string | null
> {
  return createProjectedJsonlSessionStore({
    key,
    operations: {
      resolveFile: async (storeKey) => resolveOhMyPiSessionFile({
        source: storeKey.source,
        remoteSessionId: storeKey.remoteSessionId,
      }),
      pageOlder: async (storeKey, params?: PagingParams) => {
        const resolved = await resolveOhMyPiSessionFile({
          source: storeKey.source,
          remoteSessionId: storeKey.remoteSessionId,
        });
        if (!resolved) {
          return {
            items: [],
            nextCursor: null,
            hasMore: false,
            tailCursor: null,
            truncated: false,
          };
        }
        const snapshot = await readOhMyPiSessionSnapshot({
          sessionFilePath: resolved.filePath,
          sessionId: storeKey.remoteSessionId,
        });
        return pageOlderItems(snapshot.items, params);
      },
      readAfter: async (storeKey, params?: PagingParams, currentTailCursor?: string | null) => {
        const resolved = await resolveOhMyPiSessionFile({
          source: storeKey.source,
          remoteSessionId: storeKey.remoteSessionId,
        });
        if (!resolved) {
          return {
            items: [],
            nextCursor: currentTailCursor ?? encodeOhMyPiTranscriptCursor(0),
            truncated: false,
          };
        }
        const snapshot = await readOhMyPiSessionSnapshot({
          sessionFilePath: resolved.filePath,
          sessionId: storeKey.remoteSessionId,
        });
        return readAfterItems(snapshot.items, {
          ...params,
          cursor: params?.cursor ?? currentTailCursor ?? snapshot.tailCursor,
        });
      },
      getTitle: async (storeKey) => {
        const resolved = await resolveOhMyPiSessionFile({
          source: storeKey.source,
          remoteSessionId: storeKey.remoteSessionId,
        });
        if (!resolved) return null;
        const snapshot = await readOhMyPiSessionSnapshot({
          sessionFilePath: resolved.filePath,
          sessionId: storeKey.remoteSessionId,
        });
        return snapshot.title;
      },
      getWorkingDirectory: async (storeKey) => {
        const resolved = await resolveOhMyPiSessionFile({
          source: storeKey.source,
          remoteSessionId: storeKey.remoteSessionId,
        });
        if (!resolved) return null;
        const snapshot = await readOhMyPiSessionSnapshot({
          sessionFilePath: resolved.filePath,
          sessionId: storeKey.remoteSessionId,
        });
        return snapshot.workingDirectory;
      },
      getActivity: async (storeKey) => {
        const resolved = await resolveOhMyPiSessionFile({
          source: storeKey.source,
          remoteSessionId: storeKey.remoteSessionId,
        });
        if (!resolved) {
          return {
            lastActivityAtMs: null,
            isRunning: false,
          };
        }
        const snapshot = await readOhMyPiSessionSnapshot({
          sessionFilePath: resolved.filePath,
          sessionId: storeKey.remoteSessionId,
        });
        return {
          lastActivityAtMs: snapshot.lastActivityAtMs,
          isRunning: false,
        };
      },
      followPollIntervalMs: DEFAULT_JSONL_FOLLOW_POLICY.activeBurstPollIntervalMs,
    },
  });
}
