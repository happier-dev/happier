import { stat } from 'node:fs/promises';

import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { readJsonlFileBackwardPage } from '@/api/directSessions/filePaging/jsonlBackwardPager';
import { readJsonlFileForward } from '@/api/directSessions/filePaging/jsonlForwardReader';

import { createCodexRolloutSemanticTracker } from '../rollout/createCodexRolloutSemanticTracker';
import { collectCodexSessionRolloutFiles, type CodexRolloutFile } from './collectCodexSessionRolloutFiles';
import { collectCodexDirectTranscriptRolloutStreams } from './collectCodexDirectTranscriptRolloutStreams';
import {
  decodeCodexDirectBackwardCursor,
  encodeCodexDirectBackwardCursor,
} from './codexDirectTranscriptBackwardCursor';
import {
  decodeCodexDirectForwardCursor,
  encodeCodexDirectForwardCursor,
  type CodexDurableStreamForwardProgress,
  type CodexDirectForwardCursor,
} from './codexDirectForwardCursor';
import {
  captureCodexRolloutFileBoundary,
  captureCodexRolloutTailProgress,
  codexRolloutFileBoundaryMatches,
  type CodexRolloutFileBoundary,
} from './codexDirectRolloutFileBoundary';
import {
  compareCodexProjectedRecordsOldestFirst,
  measureDirectTranscriptItemBytes,
  projectCodexRolloutLineToTranscriptRecords,
  type CodexDirectTranscriptRolloutStream,
  type CodexProjectedTranscriptRecord,
  type CodexStreamProgress,
} from './codexDirectTranscriptProjection';

async function statFileSize(filePath: string): Promise<number> {
  return stat(filePath).then((s) => Math.max(0, Math.trunc(s.size))).catch(() => 0);
}

type CodexStreamDiscovery = Readonly<{
  fileRelPath: string;
  lineStartOffsetBytes: number;
}>;

async function validatesDiscoveredChildStream(params: Readonly<{
  streams: readonly CodexDirectTranscriptRolloutStream[];
  childThreadId: string;
  discovery: CodexStreamDiscovery;
}>): Promise<boolean> {
  const parent = params.streams.find((stream) => stream.fileRelPath === params.discovery.fileRelPath);
  if (!parent) return false;
  const page = await readJsonlFileForward({
    filePath: parent.filePath,
    offsetBytes: params.discovery.lineStartOffsetBytes,
    maxBytes: 1024,
    maxItems: 1,
  });
  const line = page.items.find((candidate) => candidate.startOffsetBytes === params.discovery.lineStartOffsetBytes);
  if (!line) return false;
  const projected = projectCodexRolloutLineToTranscriptRecords({
    stream: parent,
    lineStartOffsetBytes: line.startOffsetBytes,
    lineNextOffsetBytes: line.endOffsetBytes + 1,
    lineValue: line.value,
    semanticTracker: createCodexRolloutSemanticTracker(),
  });
  return projected.discoveredChildThreadIds.includes(params.childThreadId);
}

function normalizeOffsetBytes(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

type CodexBoundaryProgress = CodexStreamProgress & Readonly<{
  fingerprintOffsetBytes: number;
}>;

type CodexExpectedBoundary = CodexRolloutFileBoundary;

function toBoundaryProgress(entry: CodexDurableStreamForwardProgress): CodexBoundaryProgress {
  return {
    nextOffsetBytes: entry.nextOffsetBytes,
    subIndex: entry.subIndex,
    fingerprintOffsetBytes: entry.fingerprintOffsetBytes,
  };
}

async function captureDurableStreamProgress(
  stream: CodexDirectTranscriptRolloutStream,
  progress: CodexBoundaryProgress,
): Promise<CodexDurableStreamForwardProgress | null> {
  const captured = await captureCodexRolloutFileBoundary(stream.filePath, progress.fingerprintOffsetBytes);
  if (!captured) return null;
  return {
    fileRelPath: stream.fileRelPath,
    nextOffsetBytes: progress.nextOffsetBytes,
    subIndex: progress.subIndex,
    fingerprintOffsetBytes: progress.fingerprintOffsetBytes,
    fileIdentity: captured.boundary.fileIdentity,
    contentFingerprint: captured.boundary.contentFingerprint,
  };
}

async function buildStreamVectorCursorFromProgress(
  streams: readonly CodexDirectTranscriptRolloutStream[],
  progressByStreamId: ReadonlyMap<string, CodexBoundaryProgress>,
): Promise<Readonly<{ cursor: string; resetStreamIds: ReadonlySet<string> }>> {
  const resetStreamIds = new Set<string>();
  const entries = await Promise.all(streams.map(async (stream) => {
    const progress = progressByStreamId.get(stream.fileRelPath);
    const durable = progress ? await captureDurableStreamProgress(stream, progress) : null;
    if (durable) return durable;

    resetStreamIds.add(stream.fileRelPath);
    const tail = await captureCodexRolloutTailProgress(stream.filePath);
    if (!tail) return null;
    return {
      fileRelPath: stream.fileRelPath,
      ...tail.progress,
      ...tail.boundary,
    } satisfies CodexDurableStreamForwardProgress;
  }));
  return {
    cursor: encodeCodexDirectForwardCursor({
      v: 5,
      kind: 'codexForwardStreamVector',
      streams: entries
        .filter((entry): entry is CodexDurableStreamForwardProgress => entry !== null)
        .sort((left, right) => left.fileRelPath.localeCompare(right.fileRelPath)),
    }),
    resetStreamIds,
  };
}

async function buildCodexStreamVectorTailCursor(
  streams: readonly CodexDirectTranscriptRolloutStream[],
): Promise<string> {
  const entries = await Promise.all(streams.map(async (stream) => {
    const tail = await captureCodexRolloutTailProgress(stream.filePath);
    return tail
      ? {
        fileRelPath: stream.fileRelPath,
        ...tail.progress,
        ...tail.boundary,
      } satisfies CodexDurableStreamForwardProgress
      : null;
  }));
  return encodeCodexDirectForwardCursor({
    v: 5,
    kind: 'codexForwardStreamVector',
    streams: entries
      .filter((entry): entry is CodexDurableStreamForwardProgress => entry !== null)
      .sort((left, right) => left.fileRelPath.localeCompare(right.fileRelPath)),
  });
}

function decodeDurableStreamVectorCursor(
  cursor: CodexDirectForwardCursor | null,
): ReadonlyMap<string, CodexDurableStreamForwardProgress> | null {
  if (!cursor || cursor.kind !== 'codexForwardStreamVector' || cursor.v !== 5) return null;
  return new Map(cursor.streams.map((entry) => [entry.fileRelPath, entry]));
}

async function collectReadAfterRecords(params: Readonly<{
  codexHome: string;
  initialStreams: readonly CodexDirectTranscriptRolloutStream[];
  initialProgressByStreamId: ReadonlyMap<string, CodexBoundaryProgress>;
  expectedBoundaryByStreamId: ReadonlyMap<string, CodexExpectedBoundary>;
  readableStreamIds: ReadonlySet<string>;
  historicalUnknownStreamIds: ReadonlySet<string>;
  maxBytes: number;
  maxItems: number;
}>): Promise<Readonly<{
  streams: readonly CodexDirectTranscriptRolloutStream[];
  records: readonly CodexProjectedTranscriptRecord[];
  baseProgressByStreamId: ReadonlyMap<string, CodexBoundaryProgress>;
  boundaryChanged: boolean;
  remainingHistoricalUnknownStreamIds: ReadonlySet<string>;
}>> {
  const streamsById = new Map(params.initialStreams.map((stream) => [stream.fileRelPath, stream] as const));
  const streamsByThreadId = new Map<string, CodexDirectTranscriptRolloutStream[]>();
  for (const stream of params.initialStreams) {
    const threadStreams = streamsByThreadId.get(stream.threadId) ?? [];
    threadStreams.push(stream);
    streamsByThreadId.set(stream.threadId, threadStreams);
  }
  const streamQueue = params.initialStreams.filter((stream) => params.readableStreamIds.has(stream.fileRelPath));
  const queuedStreamIds = new Set(streamQueue.map((stream) => stream.fileRelPath));
  const records: CodexProjectedTranscriptRecord[] = [];
  const baseProgressByStreamId = new Map(params.initialProgressByStreamId);
  const expectedBoundaryByStreamId = new Map(params.expectedBoundaryByStreamId);
  const remainingHistoricalUnknownStreamIds = new Set(params.historicalUnknownStreamIds);
  const semanticTrackerByStreamId = new Map<string, ReturnType<typeof createCodexRolloutSemanticTracker>>();
  let boundaryChanged = false;

  for (let queueIndex = 0; queueIndex < streamQueue.length; queueIndex += 1) {
    const stream = streamQueue[queueIndex]!;
    const progress = baseProgressByStreamId.get(stream.fileRelPath);
    const expectedBoundary = expectedBoundaryByStreamId.get(stream.fileRelPath);
    if (!progress || !expectedBoundary) {
      boundaryChanged = true;
      continue;
    }
    const fileSize = await statFileSize(stream.filePath);
    const offsetBytes = normalizeOffsetBytes(progress.nextOffsetBytes);
    if (offsetBytes >= fileSize) continue;

    const semanticTracker = semanticTrackerByStreamId.get(stream.fileRelPath) ?? createCodexRolloutSemanticTracker();
    semanticTrackerByStreamId.set(stream.fileRelPath, semanticTracker);
    const page = await readJsonlFileForward({
      filePath: stream.filePath,
      offsetBytes,
      maxBytes: Math.max(params.maxBytes, 1),
      maxItems: Math.max(params.maxItems * 2, 1),
    });
    if (page.truncated || !(await codexRolloutFileBoundaryMatches(stream.filePath, expectedBoundary))) {
      const tail = await captureCodexRolloutTailProgress(stream.filePath);
      if (tail) {
        baseProgressByStreamId.set(stream.fileRelPath, tail.progress);
        expectedBoundaryByStreamId.set(stream.fileRelPath, tail.boundary);
      }
      boundaryChanged = true;
      continue;
    }

    for (const line of page.items) {
      // A valid JSON prefix is still not a committed JSONL record until its newline arrives.
      // Keeping the cursor before it avoids both early projection and loss when the writer appends.
      if (line.endOffsetBytes >= fileSize) continue;
      const projected = projectCodexRolloutLineToTranscriptRecords({
        stream,
        lineStartOffsetBytes: line.startOffsetBytes,
        lineNextOffsetBytes: Math.min(fileSize, line.endOffsetBytes + 1),
        lineValue: line.value,
        semanticTracker,
      });
      if (projected.records.length === 0) {
        baseProgressByStreamId.set(stream.fileRelPath, {
          nextOffsetBytes: Math.min(fileSize, line.endOffsetBytes + 1),
          subIndex: 0,
          fingerprintOffsetBytes: Math.min(fileSize, line.endOffsetBytes + 1),
        });
      }
      for (const record of projected.records) {
        if (record.lineStartOffsetBytes === offsetBytes && record.subIndex < progress.subIndex) continue;
        records.push(record);
      }
      for (const threadId of projected.discoveredChildThreadIds) {
        if (line.startOffsetBytes === offsetBytes && progress.subIndex > 0) continue;
        let childStreams = streamsByThreadId.get(threadId) ?? [];
        if (childStreams.length === 0) {
          const childFiles = await collectCodexSessionRolloutFiles({ codexHome: params.codexHome, remoteSessionId: threadId });
          childStreams = childFiles.map((file) => ({ ...file, threadId, sidechainId: threadId }));
          streamsByThreadId.set(threadId, childStreams);
          for (const childStream of childStreams) {
            streamsById.set(childStream.fileRelPath, childStream);
          }
        }
        for (const childStream of childStreams) {
          if (queuedStreamIds.has(childStream.fileRelPath)) continue;
          const liveBoundary = await captureCodexRolloutFileBoundary(childStream.filePath, 0);
          if (!liveBoundary) continue;
          const liveProgress: CodexBoundaryProgress = {
            nextOffsetBytes: 0,
            subIndex: 0,
            fingerprintOffsetBytes: 0,
          };
          baseProgressByStreamId.set(childStream.fileRelPath, liveProgress);
          expectedBoundaryByStreamId.set(childStream.fileRelPath, liveBoundary.boundary);
          remainingHistoricalUnknownStreamIds.delete(childStream.fileRelPath);
          queuedStreamIds.add(childStream.fileRelPath);
          streamQueue.push(childStream);
        }
      }
    }
  }

  records.sort(compareCodexProjectedRecordsOldestFirst);
  const streams = [...streamsById.values()].sort((left, right) =>
    left.sortMs - right.sortMs
    || left.mtimeMs - right.mtimeMs
    || left.fileRelPath.localeCompare(right.fileRelPath),
  );
  return {
    streams,
    records,
    baseProgressByStreamId,
    boundaryChanged,
    remainingHistoricalUnknownStreamIds,
  };
}

export async function readAfterCodexRolloutStreams(params: Readonly<{
  codexHome: string;
  remoteSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
  initialRolloutFiles?: readonly CodexRolloutFile[];
}>): Promise<Readonly<{ items: DirectTranscriptRawMessageV1[]; nextCursor: string | null; truncated: boolean }>> {
  const streams = await collectCodexDirectTranscriptRolloutStreams({
    codexHome: params.codexHome,
    remoteSessionId: params.remoteSessionId,
    initialRolloutFiles: params.initialRolloutFiles,
  });

  if (params.cursor === 'tail') {
    return {
      items: [],
      nextCursor: await buildCodexStreamVectorTailCursor(streams),
      truncated: false,
    };
  }

  const decoded = decodeCodexDirectForwardCursor(params.cursor);
  const cursorProgressByStreamId = decodeDurableStreamVectorCursor(decoded);
  if (!cursorProgressByStreamId) {
    return {
      items: [],
      nextCursor: await buildCodexStreamVectorTailCursor(streams),
      truncated: true,
    };
  }

  const streamsById = new Map(streams.map((stream) => [stream.fileRelPath, stream] as const));
  const initialProgressByStreamId = new Map<string, CodexBoundaryProgress>();
  const expectedBoundaryByStreamId = new Map<string, CodexExpectedBoundary>();
  const readableStreamIds = new Set<string>();
  const historicalUnknownStreamIds = new Set<string>();
  let boundaryChanged = [...cursorProgressByStreamId.keys()].some((streamId) => !streamsById.has(streamId));

  for (const stream of streams) {
    const persisted = cursorProgressByStreamId.get(stream.fileRelPath);
    if (persisted && await codexRolloutFileBoundaryMatches(stream.filePath, persisted)) {
      initialProgressByStreamId.set(stream.fileRelPath, toBoundaryProgress(persisted));
      expectedBoundaryByStreamId.set(stream.fileRelPath, persisted);
      readableStreamIds.add(stream.fileRelPath);
      continue;
    }

    const tail = await captureCodexRolloutTailProgress(stream.filePath);
    if (tail) {
      initialProgressByStreamId.set(stream.fileRelPath, tail.progress);
      expectedBoundaryByStreamId.set(stream.fileRelPath, tail.boundary);
    }
    if (persisted) {
      boundaryChanged = true;
    } else {
      historicalUnknownStreamIds.add(stream.fileRelPath);
    }
  }

  const collected = await collectReadAfterRecords({
    codexHome: params.codexHome,
    initialStreams: streams,
    initialProgressByStreamId,
    expectedBoundaryByStreamId,
    readableStreamIds,
    historicalUnknownStreamIds,
    maxBytes: params.maxBytes,
    maxItems: params.maxItems,
  });

  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
  const maxItems = Math.max(1, Math.trunc(params.maxItems));
  const items: DirectTranscriptRawMessageV1[] = [];
  let usedBytes = 0;
  let truncated = boundaryChanged
    || collected.boundaryChanged
    || collected.remainingHistoricalUnknownStreamIds.size > 0;
  const progressByStreamId = new Map(collected.baseProgressByStreamId);

  for (let index = 0; index < collected.records.length; index += 1) {
    const record = collected.records[index]!;
    const itemBytes = measureDirectTranscriptItemBytes(record.item);
    if (items.length > 0 && (items.length >= maxItems || usedBytes + itemBytes > maxBytes)) {
      truncated = true;
      break;
    }
    items.push(record.item);
    usedBytes += itemBytes;
    progressByStreamId.set(record.streamId, record.subIndex + 1 >= record.lineRecordCount
      ? {
        nextOffsetBytes: record.lineNextOffsetBytes,
        subIndex: 0,
        fingerprintOffsetBytes: record.lineNextOffsetBytes,
      }
      : {
        nextOffsetBytes: record.lineStartOffsetBytes,
        subIndex: record.subIndex + 1,
        fingerprintOffsetBytes: record.lineNextOffsetBytes,
      });
    if (items.length >= maxItems || usedBytes >= maxBytes) {
      truncated = truncated || index + 1 < collected.records.length;
      break;
    }
  }

  const builtCursor = await buildStreamVectorCursorFromProgress(collected.streams, progressByStreamId);
  return {
    items,
    nextCursor: builtCursor.cursor,
    truncated: truncated || builtCursor.resetStreamIds.size > 0,
  };
}

export async function pageCodexRolloutStreams(params: Readonly<{
  codexHome: string;
  remoteSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
  initialRolloutFiles?: readonly CodexRolloutFile[];
}>): Promise<Readonly<{
  items: DirectTranscriptRawMessageV1[];
  nextCursor: string | null;
  tailCursor: string | null;
  hasMore: boolean;
  truncated?: boolean;
}>> {
  const streams = [...await collectCodexDirectTranscriptRolloutStreams({
    codexHome: params.codexHome,
    remoteSessionId: params.remoteSessionId,
    initialRolloutFiles: params.initialRolloutFiles,
  })];

  if (params.direction !== 'older') {
    const tailCursor = await buildCodexStreamVectorTailCursor(streams);
    return { items: [], nextCursor: null, tailCursor, hasMore: false };
  }

  const decoded = decodeCodexDirectBackwardCursor(params.cursor);
  const knownStreamIds = new Set(streams.map((stream) => stream.fileRelPath));
  const discoveredThreadIds = new Set(streams.map((stream) => stream.threadId));
  const discoveryByStreamId = new Map<string, CodexStreamDiscovery>();
  if (decoded?.v === 4) {
    let pending = decoded.streams.filter((persisted) => !knownStreamIds.has(persisted.fileRelPath));
    while (pending.length > 0) {
      const deferred: typeof pending = [];
      let restored = 0;
      for (const persisted of pending) {
        if (!persisted.discoveredFrom) continue;
        if (!knownStreamIds.has(persisted.discoveredFrom.fileRelPath)) {
          deferred.push(persisted);
          continue;
        }
        if (!(await validatesDiscoveredChildStream({
          streams,
          childThreadId: persisted.threadId,
          discovery: persisted.discoveredFrom,
        }))) continue;
        const files = await collectCodexSessionRolloutFiles({
          codexHome: params.codexHome,
          remoteSessionId: persisted.threadId,
        });
        const file = files.find((candidate) => candidate.fileRelPath === persisted.fileRelPath);
        if (!file) continue;
        knownStreamIds.add(file.fileRelPath);
        discoveredThreadIds.add(persisted.threadId);
        discoveryByStreamId.set(file.fileRelPath, persisted.discoveredFrom);
        streams.push({
          ...file,
          threadId: persisted.threadId,
          sidechainId: persisted.threadId,
        });
        restored += 1;
      }
      if (restored === 0) break;
      pending = deferred;
    }
  }
  const endByStreamId = new Map(decoded?.streams.map((entry) => [entry.fileRelPath, entry.endOffsetBytes] as const) ?? []);
  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
  const maxItems = Math.max(1, Math.trunc(params.maxItems));
  const candidateRecords: CodexProjectedTranscriptRecord[] = [];
  const reachedStartByStreamId = new Map<string, boolean>();
  const initialEndByStreamId = new Map<string, number>();
  const pageNextEndByStreamId = new Map<string, number>();
  const hasLoadedCandidateByStreamId = new Map<string, boolean>();

  for (let streamIndex = 0; streamIndex < streams.length; streamIndex += 1) {
    const stream = streams[streamIndex]!;
    const fileSize = await statFileSize(stream.filePath);
    const endOffsetBytes = Math.min(fileSize, Math.max(0, Math.trunc(endByStreamId.get(stream.fileRelPath) ?? fileSize)));
    initialEndByStreamId.set(stream.fileRelPath, endOffsetBytes);
    if (endOffsetBytes <= 0) continue;
    const page = await readJsonlFileBackwardPage({
      filePath: stream.filePath,
      endOffsetBytes,
      maxBytes,
      maxItems: maxItems * 2,
    });
    reachedStartByStreamId.set(stream.fileRelPath, page.reachedStart);
    pageNextEndByStreamId.set(stream.fileRelPath, page.nextEndOffsetBytes);
    const semanticTracker = createCodexRolloutSemanticTracker();
    for (const line of page.items) {
      const projected = projectCodexRolloutLineToTranscriptRecords({
        stream,
        lineStartOffsetBytes: line.startOffsetBytes,
        lineNextOffsetBytes: Math.min(fileSize, line.endOffsetBytes + 1),
        lineValue: line.value,
        semanticTracker,
      });
      if (projected.records.length > 0) {
        hasLoadedCandidateByStreamId.set(stream.fileRelPath, true);
      }
      candidateRecords.push(...projected.records);
      for (const childThreadId of projected.discoveredChildThreadIds) {
        if (discoveredThreadIds.has(childThreadId)) continue;
        discoveredThreadIds.add(childThreadId);
        const childFiles = await collectCodexSessionRolloutFiles({
          codexHome: params.codexHome,
          remoteSessionId: childThreadId,
        });
        for (const childFile of childFiles) {
          if (knownStreamIds.has(childFile.fileRelPath)) continue;
          knownStreamIds.add(childFile.fileRelPath);
          discoveryByStreamId.set(childFile.fileRelPath, {
            fileRelPath: stream.fileRelPath,
            lineStartOffsetBytes: line.startOffsetBytes,
          });
          streams.push({
            ...childFile,
            threadId: childThreadId,
            sidechainId: childThreadId,
          });
        }
      }
    }
  }

  streams.sort((left, right) =>
    left.sortMs - right.sortMs
    || left.mtimeMs - right.mtimeMs
    || left.fileRelPath.localeCompare(right.fileRelPath),
  );
  const tailCursor = await buildCodexStreamVectorTailCursor(streams);

  candidateRecords.sort(compareCodexProjectedRecordsOldestFirst);
  const selectedReversed: CodexProjectedTranscriptRecord[] = [];
  let usedBytes = 0;
  for (let index = candidateRecords.length - 1; index >= 0; index -= 1) {
    const record = candidateRecords[index]!;
    const itemBytes = measureDirectTranscriptItemBytes(record.item);
    if (selectedReversed.length > 0 && (selectedReversed.length >= maxItems || usedBytes + itemBytes > maxBytes)) {
      break;
    }
    selectedReversed.push(record);
    usedBytes += itemBytes;
    if (selectedReversed.length >= maxItems || usedBytes >= maxBytes) {
      break;
    }
  }

  const selected = selectedReversed.reverse();
  const nextEndByStreamId = new Map<string, number>();
  for (const stream of streams) {
    const initialEndOffsetBytes = initialEndByStreamId.get(stream.fileRelPath) ?? 0;
    const pageNextEndOffsetBytes = pageNextEndByStreamId.get(stream.fileRelPath) ?? initialEndOffsetBytes;
    nextEndByStreamId.set(
      stream.fileRelPath,
      hasLoadedCandidateByStreamId.get(stream.fileRelPath) === true
        ? initialEndOffsetBytes
        : pageNextEndOffsetBytes,
    );
  }
  for (const record of selected) {
    const current = nextEndByStreamId.get(record.streamId);
    if (current == null || record.lineStartOffsetBytes < current) {
      nextEndByStreamId.set(record.streamId, record.lineStartOffsetBytes);
    }
  }

  const selectedIds = new Set(selected.map((record) => record.item.id));
  const hasUndeliveredLoadedRecord = candidateRecords.some((record) => !selectedIds.has(record.item.id));
  const mayHaveUndeliveredRecordBeforeLoadedWindow = streams.some((stream) => {
    const endOffsetBytes = nextEndByStreamId.get(stream.fileRelPath) ?? 0;
    return endOffsetBytes > 0 && reachedStartByStreamId.get(stream.fileRelPath) === false;
  });
  const hasMore = hasUndeliveredLoadedRecord || mayHaveUndeliveredRecordBeforeLoadedWindow;
  const nextCursor = hasMore
    ? encodeCodexDirectBackwardCursor({
      v: 4,
      kind: 'codexBackwardStreamVector',
      streams: streams
        .map((stream) => ({
          fileRelPath: stream.fileRelPath,
          endOffsetBytes: nextEndByStreamId.get(stream.fileRelPath) ?? 0,
          threadId: stream.threadId,
          ...(discoveryByStreamId.get(stream.fileRelPath)
            ? { discoveredFrom: discoveryByStreamId.get(stream.fileRelPath)! }
            : {}),
        }))
        .sort((left, right) => left.fileRelPath.localeCompare(right.fileRelPath)),
    })
    : null;

  return {
    items: selected.map((record) => record.item),
    nextCursor,
    tailCursor,
    hasMore,
    ...(decoded === null && typeof params.cursor === 'string' && params.cursor.trim().length > 0 ? { truncated: true } : {}),
  };
}
