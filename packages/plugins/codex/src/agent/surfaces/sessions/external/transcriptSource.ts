import { createHash } from 'node:crypto';
import { open, stat, type FileHandle } from 'node:fs/promises';

import type {
  ExternalSessionsSource,
  ExternalSessionTranscriptPageV1,
  ExternalSessionTranscriptRawMessageV1,
} from '@happier-dev/plugin-sdk/experimental/sessions';
import type { PluginExecService } from '@happier-dev/plugin-sdk/runtime';
import {
  readJsonlFileBackwardPage,
  readJsonlFileForwardLines,
} from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';

import { createCodexRolloutSemanticTracker } from '../../../rollout/semanticTracker.js';
import { mapCodexRolloutEventToActions } from '../../../rollout/projection/actions.js';
import { mapCodexRolloutLineToExternalMessages } from '../../../rollout/projection/transcript.js';
import {
  collectCodexSessionRolloutFiles,
  describeCodexRolloutFileSetResourceIdentity,
  type CodexRolloutFile,
  type CodexSessionRolloutResourceIdentity,
} from '../../../rollout/discovery/sessionsForHome.js';
import { homeEntries as resolveHomeEntries } from '../../../rollout/discovery/homeEntries.js';
import {
  decodeCodexExternalForwardCursor,
  encodeCodexExternalForwardCursor,
  mapCodexExternalSessionAppServerCandidateToMetadata,
  mapCodexExternalSessionAppServerPreviewToMessage,
  type CodexExternalSessionAppServerMetadata,
} from './transcript.js';
import { listCodexSessionCandidates } from './candidateSource.js';

type CodexBackwardStreamVectorCursorV1 = Readonly<{
  v: 1;
  kind: 'codexBackwardStreamVector';
  streams: readonly Readonly<{
    fileRelPath: string;
    endOffsetBytes: number;
  }>[];
}>;

type PredecessorCodexBackwardStreamVectorCursorV3 = Readonly<{
  v: 3;
  kind: 'codexBackwardStreamVector';
  streams: CodexBackwardStreamVectorCursorV1['streams'];
}>;

type CodexBackwardGenerationStreamVectorCursorV4 = Readonly<{
  v: 4;
  kind: 'codexBackwardStreamVector';
  sourceGeneration: readonly string[];
  streams: readonly Readonly<{
    fileRelPath: string;
    physicalGeneration: string;
    endOffsetBytes: number;
  }>[];
}>;

type CodexBackwardAnchoredGenerationStreamVectorCursorV5 = Readonly<{
  v: 5;
  kind: 'codexBackwardStreamVector';
  sourceGeneration: readonly string[];
  streams: readonly Readonly<{
    fileRelPath: string;
    physicalGeneration: string;
    endOffsetBytes: number;
    fingerprintOffsetBytes: number;
    contentFingerprint: string;
  }>[];
}>;

type ReleasedCodexBackwardMergedCursorV2 = Readonly<{
  v: 2;
  kind: 'codexBackwardMerged';
  endIndex: number;
}>;

type CodexBackwardCursor =
  | CodexBackwardStreamVectorCursorV1
  | ReleasedCodexBackwardMergedCursorV2
  | PredecessorCodexBackwardStreamVectorCursorV3
  | CodexBackwardGenerationStreamVectorCursorV4
  | CodexBackwardAnchoredGenerationStreamVectorCursorV5;

type CodexExternalTranscriptRolloutStream = CodexRolloutFile & Readonly<{
  threadId: string;
  sidechainId: string | null;
}>;

type CodexProjectedTranscriptRecord = Readonly<{
  item: ExternalSessionTranscriptRawMessageV1;
  streamId: string;
  lineStartOffsetBytes: number;
  lineEndOffsetBytes: number;
  subIndex: number;
  lineRecordCount: number;
}>;

type BestCodexHomeWithFiles = Readonly<{
  codexHome: string;
  source: ExternalSessionsSource;
  files: readonly CodexRolloutFile[];
}>;

function encodeBackwardCursor(value: CodexBackwardCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCodexExternalBackwardCursor(raw: string | undefined): CodexBackwardCursor | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.v === 2 && record.kind === 'codexBackwardMerged') {
      const endIndex = typeof record.endIndex === 'number' && Number.isFinite(record.endIndex)
        ? Math.trunc(record.endIndex)
        : NaN;
      return Number.isFinite(endIndex) && endIndex >= 0
        ? { v: 2, kind: 'codexBackwardMerged', endIndex }
        : null;
    }
    if (record.v === 4 && record.kind === 'codexBackwardStreamVector') {
      const sourceGeneration = Array.isArray(record.sourceGeneration)
        ? record.sourceGeneration.filter(
          (entry): entry is string => typeof entry === 'string' && entry.length > 0,
        )
        : [];
      if (
        !Array.isArray(record.sourceGeneration)
        || sourceGeneration.length !== record.sourceGeneration.length
      ) {
        return null;
      }
      const rawStreams = Array.isArray(record.streams) ? record.streams : [];
      const streams = rawStreams.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const streamRecord = entry as Record<string, unknown>;
        const fileRelPath = typeof streamRecord.fileRelPath === 'string'
          ? streamRecord.fileRelPath.trim()
          : '';
        const physicalGeneration =
          typeof streamRecord.physicalGeneration === 'string'
            ? streamRecord.physicalGeneration.trim()
            : '';
        const endOffsetBytes =
          typeof streamRecord.endOffsetBytes === 'number'
            && Number.isFinite(streamRecord.endOffsetBytes)
            ? Math.max(0, Math.trunc(streamRecord.endOffsetBytes))
            : NaN;
        return fileRelPath && physicalGeneration && Number.isFinite(endOffsetBytes)
          ? [{ fileRelPath, physicalGeneration, endOffsetBytes }]
          : [];
      });
      if (streams.length !== rawStreams.length) return null;
      return {
        v: 4,
        kind: 'codexBackwardStreamVector',
        sourceGeneration,
        streams,
      };
    }
    if (record.v === 5 && record.kind === 'codexBackwardStreamVector') {
      const sourceGeneration = Array.isArray(record.sourceGeneration)
        ? record.sourceGeneration.filter(
          (entry): entry is string => typeof entry === 'string' && entry.length > 0,
        )
        : [];
      if (
        !Array.isArray(record.sourceGeneration)
        || sourceGeneration.length !== record.sourceGeneration.length
      ) {
        return null;
      }
      const rawStreams = Array.isArray(record.streams) ? record.streams : [];
      const streams = rawStreams.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const streamRecord = entry as Record<string, unknown>;
        const fileRelPath = typeof streamRecord.fileRelPath === 'string'
          ? streamRecord.fileRelPath.trim()
          : '';
        const physicalGeneration =
          typeof streamRecord.physicalGeneration === 'string'
            ? streamRecord.physicalGeneration.trim()
            : '';
        const endOffsetBytes =
          typeof streamRecord.endOffsetBytes === 'number'
            && Number.isSafeInteger(streamRecord.endOffsetBytes)
            ? streamRecord.endOffsetBytes
            : NaN;
        const fingerprintOffsetBytes =
          typeof streamRecord.fingerprintOffsetBytes === 'number'
            && Number.isSafeInteger(streamRecord.fingerprintOffsetBytes)
            ? streamRecord.fingerprintOffsetBytes
            : NaN;
        const contentFingerprint =
          typeof streamRecord.contentFingerprint === 'string'
            ? streamRecord.contentFingerprint.trim()
            : '';
        return (
          fileRelPath
          && physicalGeneration
          && Number.isSafeInteger(endOffsetBytes)
          && endOffsetBytes >= 0
          && Number.isSafeInteger(fingerprintOffsetBytes)
          && fingerprintOffsetBytes === endOffsetBytes
          && /^[a-f0-9]{64}$/u.test(contentFingerprint)
        )
          ? [{
              fileRelPath,
              physicalGeneration,
              endOffsetBytes,
              fingerprintOffsetBytes,
              contentFingerprint,
            }]
          : [];
      });
      if (
        streams.length === 0
        || streams.length !== rawStreams.length
        || new Set(streams.map((entry) => entry.fileRelPath)).size !== streams.length
      ) {
        return null;
      }
      return {
        v: 5,
        kind: 'codexBackwardStreamVector',
        sourceGeneration,
        streams,
      };
    }
    if ((record.v !== 1 && record.v !== 3) || record.kind !== 'codexBackwardStreamVector') return null;
    const streams = Array.isArray(record.streams) ? record.streams.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const streamRecord = entry as Record<string, unknown>;
      const fileRelPath = typeof streamRecord.fileRelPath === 'string' ? streamRecord.fileRelPath.trim() : '';
      const endOffsetBytes = typeof streamRecord.endOffsetBytes === 'number' && Number.isFinite(streamRecord.endOffsetBytes)
        ? Math.max(0, Math.trunc(streamRecord.endOffsetBytes))
        : NaN;
      return fileRelPath && Number.isFinite(endOffsetBytes) ? [{ fileRelPath, endOffsetBytes }] : [];
    }) : [];
    return record.v === 3
      ? { v: 3, kind: 'codexBackwardStreamVector', streams }
      : { v: 1, kind: 'codexBackwardStreamVector', streams };
  } catch {
    return null;
  }
}

function measureTranscriptItemBytes(item: ExternalSessionTranscriptRawMessageV1): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8');
}

function compareTranscriptItemsOldestFirst(
  left: ExternalSessionTranscriptRawMessageV1,
  right: ExternalSessionTranscriptRawMessageV1,
): number {
  if (left.createdAtMs !== right.createdAtMs) return left.createdAtMs - right.createdAtMs;
  return left.id.localeCompare(right.id);
}

function compareRecordsOldestFirst(
  left: CodexProjectedTranscriptRecord,
  right: CodexProjectedTranscriptRecord,
): number {
  return compareTranscriptItemsOldestFirst(left.item, right.item);
}

// Codex 0.146 records rollouts append-first. These samples are bounded continuity
// evidence for bytes already acknowledged at a cursor watermark, not a whole-file
// integrity commitment or a linearizable snapshot. Re-characterize the recorder
// before relying on this scheme for a non-append-oriented Codex release.
const CURSOR_FINGERPRINT_SAMPLE_BYTES = 4 * 1024;

async function readFileRange(
  file: FileHandle,
  startOffsetBytes: number,
  lengthBytes: number,
): Promise<Buffer> {
  if (lengthBytes <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(lengthBytes);
  const { bytesRead } = await file.read(
    buffer,
    0,
    lengthBytes,
    startOffsetBytes,
  );
  return bytesRead === lengthBytes ? buffer : buffer.subarray(0, bytesRead);
}

async function captureContentAnchor(
  filePath: string,
  fingerprintOffsetBytes: number,
): Promise<string | null> {
  if (!Number.isSafeInteger(fingerprintOffsetBytes) || fingerprintOffsetBytes < 0) {
    return null;
  }
  let file: FileHandle | null = null;
  try {
    file = await open(filePath, 'r');
    const sizeBytes = Number((await file.stat({ bigint: true })).size);
    if (
      !Number.isSafeInteger(sizeBytes)
      || sizeBytes < fingerprintOffsetBytes
    ) {
      return null;
    }
    const prefixLength = Math.min(
      CURSOR_FINGERPRINT_SAMPLE_BYTES,
      fingerprintOffsetBytes,
    );
    const boundaryLength = Math.min(
      CURSOR_FINGERPRINT_SAMPLE_BYTES,
      fingerprintOffsetBytes,
    );
    const [prefix, boundary] = await Promise.all([
      readFileRange(file, 0, prefixLength),
      readFileRange(
        file,
        fingerprintOffsetBytes - boundaryLength,
        boundaryLength,
      ),
    ]);
    if (prefix.length !== prefixLength || boundary.length !== boundaryLength) {
      return null;
    }
    return createHash('sha256')
      .update('codex-rollout-content-boundary-v1\0', 'utf8')
      .update(String(fingerprintOffsetBytes), 'utf8')
      .update(Buffer.from([0]))
      .update(prefix)
      .update(Buffer.from([0]))
      .update(boundary)
      .digest('hex');
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function contentAnchorsMatch(
  entries: readonly Readonly<{
    fileRelPath: string;
    fingerprintOffsetBytes: number;
    contentFingerprint: string;
  }>[],
  streams: readonly CodexExternalTranscriptRolloutStream[],
): Promise<boolean> {
  const streamByPath = new Map(
    streams.map((stream) => [stream.fileRelPath, stream] as const),
  );
  return (
    await Promise.all(entries.map(async (entry) => {
      const stream = streamByPath.get(entry.fileRelPath);
      return stream !== undefined
        && await captureContentAnchor(
          stream.filePath,
          entry.fingerprintOffsetBytes,
        ) === entry.contentFingerprint;
    }))
  ).every(Boolean);
}

async function buildStreamVectorCursorFromEntries(
  entries: readonly Readonly<{
    fileRelPath: string;
    nextOffsetBytes: number;
    subIndex?: number;
    fingerprintOffsetBytes?: number;
  }>[],
  identity: CodexSessionRolloutResourceIdentity,
  streams: readonly CodexExternalTranscriptRolloutStream[],
  allowEmpty: boolean,
): Promise<string | null> {
  if (!allowEmpty && entries.length === 0) return null;
  const physicalGenerationByPath = new Map(
    identity.streams.map((stream) => [
      stream.fileRelPath,
      stream.physicalGeneration,
    ] as const),
  );
  const streamByPath = new Map(
    streams.map((stream) => [stream.fileRelPath, stream] as const),
  );
  const anchoredEntries = await Promise.all(entries.map(async (entry) => {
    const stream = streamByPath.get(entry.fileRelPath);
    const nextOffsetBytes = Math.max(0, Math.trunc(entry.nextOffsetBytes));
    const fingerprintOffsetBytes = Math.max(
      nextOffsetBytes,
      Math.trunc(entry.fingerprintOffsetBytes ?? nextOffsetBytes),
    );
    const contentFingerprint = stream
      ? await captureContentAnchor(stream.filePath, fingerprintOffsetBytes)
      : null;
    return contentFingerprint
      ? {
          fileRelPath: entry.fileRelPath,
          physicalGeneration: physicalGenerationByPath.get(entry.fileRelPath) ?? 'missing',
          nextOffsetBytes,
          subIndex: Math.max(0, Math.trunc(entry.subIndex ?? 0)),
          fingerprintOffsetBytes,
          contentFingerprint,
        }
      : null;
  }));
  if (anchoredEntries.some((entry) => entry === null)) return null;
  return encodeCodexExternalForwardCursor({
    v: 7,
    kind: 'codexForwardStreamVector',
    sourceGeneration: identity.sourceGeneration,
    streams: anchoredEntries
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => left.fileRelPath.localeCompare(right.fileRelPath)),
  });
}

async function buildBackwardCursorFromEntries(
  entries: readonly Readonly<{
    fileRelPath: string;
    endOffsetBytes: number;
  }>[],
  identity: CodexSessionRolloutResourceIdentity,
  streams: readonly CodexExternalTranscriptRolloutStream[],
): Promise<string | null> {
  const physicalGenerationByPath = new Map(
    identity.streams.map((stream) => [
      stream.fileRelPath,
      stream.physicalGeneration,
    ] as const),
  );
  const streamByPath = new Map(
    streams.map((stream) => [stream.fileRelPath, stream] as const),
  );
  const anchoredEntries = await Promise.all(entries.map(async (entry) => {
    const stream = streamByPath.get(entry.fileRelPath);
    const endOffsetBytes = Math.max(0, Math.trunc(entry.endOffsetBytes));
    const contentFingerprint = stream
      ? await captureContentAnchor(stream.filePath, endOffsetBytes)
      : null;
    return contentFingerprint
      ? {
          fileRelPath: entry.fileRelPath,
          physicalGeneration: physicalGenerationByPath.get(entry.fileRelPath) ?? 'missing',
          endOffsetBytes,
          fingerprintOffsetBytes: endOffsetBytes,
          contentFingerprint,
        }
      : null;
  }));
  if (anchoredEntries.some((entry) => entry === null)) return null;
  return encodeBackwardCursor({
    v: 5,
    kind: 'codexBackwardStreamVector',
    sourceGeneration: identity.sourceGeneration,
    streams: anchoredEntries
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => left.fileRelPath.localeCompare(right.fileRelPath)),
  });
}

async function statFileSize(filePath: string): Promise<number | null> {
  try {
    return Math.max(0, Math.trunc((await stat(filePath)).size));
  } catch {
    return null;
  }
}

async function buildTailCursorFromStreams(
  streams: readonly CodexExternalTranscriptRolloutStream[],
  identity: CodexSessionRolloutResourceIdentity,
): Promise<string | null> {
  const entries = await Promise.all(streams.map(async (stream) => ({
    fileRelPath: stream.fileRelPath,
    nextOffsetBytes: await statFileSize(stream.filePath) ?? 0,
    subIndex: 0,
  })));
  return await buildStreamVectorCursorFromEntries(
    entries,
    identity,
    streams,
    false,
  );
}

async function resourceIdentityCanContinue(
  cursor: Readonly<{
    sourceGeneration: readonly string[];
    streams: readonly Readonly<{
      fileRelPath: string;
      physicalGeneration: string;
      nextOffsetBytes: number;
    }>[];
  }>,
  current: CodexSessionRolloutResourceIdentity,
  streams: readonly CodexExternalTranscriptRolloutStream[],
): Promise<boolean> {
  if (
    cursor.sourceGeneration.length !== current.sourceGeneration.length
    || cursor.sourceGeneration.some(
      (generation, index) => (
        generation !== current.sourceGeneration[index]
        && generation !== 'missing'
      ),
    )
    || cursor.streams.length !== current.streams.length
  ) {
    return false;
  }
  const currentByPath = new Map(
    current.streams.map((stream) => [stream.fileRelPath, stream] as const),
  );
  const liveStreamsByPath = new Map(
    streams.map((stream) => [stream.fileRelPath, stream] as const),
  );
  return (await Promise.all(cursor.streams.map(async (cursorStream) => {
    const currentStream = currentByPath.get(cursorStream.fileRelPath);
    const liveStream = liveStreamsByPath.get(cursorStream.fileRelPath);
    if (
      !currentStream
      || !liveStream
      || currentStream.physicalGeneration !== cursorStream.physicalGeneration
    ) {
      return false;
    }
    const size = await statFileSize(liveStream.filePath);
    return size !== null && size >= cursorStream.nextOffsetBytes;
  }))).every(Boolean);
}

function resourceIdentityMatches(
  cursor: Readonly<{
    sourceGeneration: readonly string[];
    streams: readonly Readonly<{
      fileRelPath: string;
      physicalGeneration: string;
    }>[];
  }>,
  current: CodexSessionRolloutResourceIdentity,
): boolean {
  if (
    cursor.sourceGeneration.length !== current.sourceGeneration.length
    || cursor.sourceGeneration.some(
      (generation, index) => generation !== current.sourceGeneration[index],
    )
    || cursor.streams.length !== current.streams.length
  ) {
    return false;
  }
  const cursorStreams = [...cursor.streams].sort((left, right) =>
    left.fileRelPath.localeCompare(right.fileRelPath),
  );
  return current.streams.every((stream, index) => {
    const cursorStream = cursorStreams[index];
    return cursorStream?.fileRelPath === stream.fileRelPath
      && cursorStream.physicalGeneration === stream.physicalGeneration;
  });
}

function selectRecordsWithinAggregateBudget(
  records: readonly CodexProjectedTranscriptRecord[],
  params: Readonly<{
    maxBytes: number;
    maxItems: number;
    direction: 'oldest' | 'newest';
  }>,
): CodexProjectedTranscriptRecord[] {
  const ordered = params.direction === 'oldest' ? records : [...records].reverse();
  const selected: CodexProjectedTranscriptRecord[] = [];
  let usedBytes = 0;
  for (const record of ordered) {
    const itemBytes = measureTranscriptItemBytes(record.item);
    if (
      selected.length > 0
      && (
        selected.length >= params.maxItems
        || usedBytes + itemBytes > params.maxBytes
      )
    ) {
      break;
    }
    selected.push(record);
    usedBytes += itemBytes;
    if (selected.length >= params.maxItems || usedBytes >= params.maxBytes) break;
  }
  return params.direction === 'oldest' ? selected : selected.reverse();
}

function parseSessionMeta(value: unknown): Readonly<{ cwd: string | null; timestampMs: number | null }> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (envelope.type !== 'session_meta') return null;
  const payload =
    envelope.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload)
      ? envelope.payload as Record<string, unknown>
      : null;
  if (!payload) return null;
  const cwd = typeof payload.cwd === 'string' && payload.cwd.trim().length > 0 ? payload.cwd.trim() : null;
  const timestampMs = typeof payload.timestamp === 'string'
    ? (() => {
      const parsed = Date.parse(payload.timestamp);
      return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
    })()
    : null;
  return { cwd, timestampMs };
}

function projectLine(params: Readonly<{
  stream: CodexExternalTranscriptRolloutStream;
  lineStartOffsetBytes: number;
  lineEndOffsetBytes: number;
  lineValue: unknown;
  semanticTracker: ReturnType<typeof createCodexRolloutSemanticTracker>;
}>): Readonly<{
  records: readonly CodexProjectedTranscriptRecord[];
  discoveredChildThreadIds: readonly string[];
  knownNonTranscriptRecord: boolean;
}> {
  const rolloutActions = mapCodexRolloutEventToActions(params.lineValue, { debug: true });
  const normalizedActions = rolloutActions
    .flatMap((action) => params.semanticTracker.consume(action));
  const discoveredChildThreadIds = normalizedActions
    .filter((action) => action.type === 'subagent-spawn')
    .map((action) => action.threadId);
  const mappedItems = mapCodexRolloutLineToExternalMessages({
    fileRelPath: params.stream.fileRelPath,
    lineStartOffsetBytes: params.lineStartOffsetBytes,
    lineValue: params.lineValue,
    actions: normalizedActions,
    sidechainId: params.stream.sidechainId,
  });
  return {
    records: mappedItems.map((item, subIndex) => ({
      item,
      streamId: params.stream.fileRelPath,
      lineStartOffsetBytes: params.lineStartOffsetBytes,
      lineEndOffsetBytes: params.lineEndOffsetBytes,
      subIndex,
      lineRecordCount: mappedItems.length,
    })),
    discoveredChildThreadIds,
    knownNonTranscriptRecord: rolloutActions.some((action) => action.type === 'codex-session-id'),
  };
}

async function discoverSpawnedThreadIdsFromFilesBounded(files: readonly CodexRolloutFile[]): Promise<readonly string[]> {
  const discovered = new Set<string>();
  const semanticTracker = createCodexRolloutSemanticTracker();
  for (const file of files) {
    let offsetBytes = 0;
    let scannedBytes = 0;
    let scannedItems = 0;
    while (scannedBytes < 1024 * 1024 && scannedItems < 512) {
      const page = await readJsonlFileForwardLines({
        filePath: file.filePath,
        offsetBytes,
        maxBytes: Math.min(128 * 1024, 1024 * 1024 - scannedBytes),
        maxItems: Math.min(64, 512 - scannedItems),
      });
      for (const line of page.items) {
        if (line.value === null) continue;
        const projected = projectLine({
          stream: { ...file, threadId: '', sidechainId: null },
          lineStartOffsetBytes: line.startOffsetBytes,
          lineEndOffsetBytes: line.endOffsetBytes,
          lineValue: line.value,
          semanticTracker,
        });
        for (const threadId of projected.discoveredChildThreadIds) discovered.add(threadId);
      }
      if (page.reachedEnd || page.nextOffsetBytes <= offsetBytes) break;
      scannedBytes += Math.max(0, page.nextOffsetBytes - offsetBytes);
      scannedItems += page.items.length;
      offsetBytes = page.nextOffsetBytes;
    }
  }
  return [...discovered];
}

async function collectTranscriptStreams(params: Readonly<{
  codexHome: string;
  remoteSessionId: string;
  initialRolloutFiles?: readonly CodexRolloutFile[];
}>): Promise<readonly CodexExternalTranscriptRolloutStream[]> {
  const queue = [{ threadId: params.remoteSessionId, sidechainId: null as string | null }];
  const seenThreadIds = new Set<string>();
  const streams: CodexExternalTranscriptRolloutStream[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seenThreadIds.has(current.threadId)) continue;
    seenThreadIds.add(current.threadId);
    const files = current.threadId === params.remoteSessionId && current.sidechainId === null && params.initialRolloutFiles
      ? [...params.initialRolloutFiles]
      : await collectCodexSessionRolloutFiles({
        codexHome: params.codexHome,
        remoteSessionId: current.threadId,
      });
    if (files.length === 0) continue;
    streams.push(...files.map((file) => ({
      ...file,
      threadId: current.threadId,
      sidechainId: current.sidechainId,
    })));
    const discoveredChildThreadIds = await discoverSpawnedThreadIdsFromFilesBounded(files);
    for (const threadId of discoveredChildThreadIds) {
      if (!seenThreadIds.has(threadId)) queue.push({ threadId, sidechainId: threadId });
    }
  }

  return streams.sort((left, right) =>
    left.sortMs - right.sortMs
    || left.mtimeMs - right.mtimeMs
    || left.fileRelPath.localeCompare(right.fileRelPath),
  );
}

async function resolveBestHomeWithFiles(params: Readonly<{
  source: ExternalSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  remoteSessionId: string;
}>): Promise<BestCodexHomeWithFiles | null> {
  const entries = await resolveHomeEntries({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
  });
  let best: BestCodexHomeWithFiles | null = null;
  let bestLatestMtimeMs = -1;
  for (const entry of entries) {
    const files = await collectCodexSessionRolloutFiles({
      codexHome: entry.codexHome,
      remoteSessionId: params.remoteSessionId,
    });
    if (files.length === 0) continue;
    const latestMtimeMs = Math.max(...files.map((file) => file.mtimeMs));
    if (latestMtimeMs > bestLatestMtimeMs) {
      bestLatestMtimeMs = latestMtimeMs;
      best = { codexHome: entry.codexHome, source: entry.source, files };
    }
  }
  return best;
}

async function resolveCodexExternalSessionAppServerMetadata(params: Readonly<{
  source: ExternalSessionsSource;
  activeServerDir: string;
  remoteSessionId: string;
  env: NodeJS.ProcessEnv;
  exec: PluginExecService;
}>): Promise<CodexExternalSessionAppServerMetadata | null> {
  const page = await listCodexSessionCandidates({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
    exec: params.exec,
    searchTerm: params.remoteSessionId,
    searchMode: 'full',
    limit: 50,
  });
  let best: CodexExternalSessionAppServerMetadata | null = null;
  for (const candidate of page.candidates) {
    if (candidate.remoteSessionId !== params.remoteSessionId) continue;
    const metadata = mapCodexExternalSessionAppServerCandidateToMetadata({ candidate });
    if (!metadata) continue;
    if (!best || metadata.updatedAtMs > best.updatedAtMs) best = metadata;
  }
  return best;
}

async function resolveTranscriptStreams(params: Readonly<{
  source: ExternalSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  remoteSessionId: string;
}>): Promise<Readonly<{
  bestHome: BestCodexHomeWithFiles | null;
  streams: readonly CodexExternalTranscriptRolloutStream[];
  resourceIdentity: CodexSessionRolloutResourceIdentity | null;
}>> {
  const bestHome = await resolveBestHomeWithFiles(params);
  if (!bestHome) {
    return { bestHome: null, streams: [], resourceIdentity: null };
  }
  const streams = await collectTranscriptStreams({
    codexHome: bestHome.codexHome,
    remoteSessionId: params.remoteSessionId,
    initialRolloutFiles: bestHome.files,
  });
  return {
    bestHome,
    streams,
    resourceIdentity: await describeCodexRolloutFileSetResourceIdentity({
      codexHome: bestHome.codexHome,
      files: streams,
    }),
  };
}

export async function pageCodexExternalSessionTranscript(params: Readonly<{
  source: ExternalSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  exec?: PluginExecService;
  remoteSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<ExternalSessionTranscriptPageV1> {
  const { streams, resourceIdentity } = await resolveTranscriptStreams(params);
  const tailCursor = resourceIdentity
    ? await buildTailCursorFromStreams(streams, resourceIdentity)
    : null;
  if (streams.length === 0) {
    if (params.cursor) {
      return {
        items: [],
        nextCursor: null,
        tailCursor: null,
        hasMore: false,
        truncated: true,
      };
    }
    const appServerMetadata = params.exec
      ? await resolveCodexExternalSessionAppServerMetadata({ ...params, exec: params.exec })
      : null;
    const previewItem = appServerMetadata
      ? mapCodexExternalSessionAppServerPreviewToMessage({
        remoteSessionId: params.remoteSessionId,
        metadata: appServerMetadata,
      })
      : null;
    return {
      items: previewItem ? [previewItem] : [],
      nextCursor: null,
      tailCursor: appServerMetadata
        ? encodeCodexExternalForwardCursor({
          v: 2,
          kind: 'codexForwardAppServer',
          updatedAtMs: appServerMetadata.updatedAtMs,
          previewText: appServerMetadata.previewText,
        })
        : null,
      hasMore: false,
      truncated: false,
    };
  }

  if (params.direction !== 'older') {
    return { items: [], nextCursor: null, tailCursor, hasMore: false, truncated: false };
  }

  const decoded = decodeCodexExternalBackwardCursor(params.cursor);
  if (params.cursor && (
    !decoded
    || decoded.v !== 5
    || !resourceIdentity
    || !resourceIdentityMatches(decoded, resourceIdentity)
    || !await contentAnchorsMatch(decoded.streams, streams)
  )) {
    return {
      items: [],
      nextCursor: null,
      tailCursor,
      hasMore: false,
      truncated: true,
    };
  }
  const endByStreamId = new Map(
    decoded?.v === 5
      ? decoded.streams.map((entry) => [entry.fileRelPath, entry.endOffsetBytes] as const)
      : [],
  );
  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
  const maxItems = Math.max(1, Math.trunc(params.maxItems));
  const candidateRecords: CodexProjectedTranscriptRecord[] = [];
  const nextEnds: Array<{ fileRelPath: string; endOffsetBytes: number }> = [];
  const originalEnds = new Map<string, number>();

  for (const stream of streams) {
    const fileSize = await statFileSize(stream.filePath) ?? 0;
    const endOffsetBytes = Math.min(fileSize, Math.max(0, Math.trunc(endByStreamId.get(stream.fileRelPath) ?? fileSize)));
    originalEnds.set(stream.fileRelPath, endOffsetBytes);
    if (endOffsetBytes <= 0) continue;
    const page = await readJsonlFileBackwardPage({
      filePath: stream.filePath,
      endOffsetBytes,
      maxBytes,
      maxItems: maxItems * 2,
    });
    if (page.diagnostics?.some((diagnostic) => diagnostic.code === 'malformed_source_utf8')) {
      throw new Error('Codex transcript source contains malformed UTF-8.');
    }
    nextEnds.push({ fileRelPath: stream.fileRelPath, endOffsetBytes: page.nextEndOffsetBytes });

    const semanticTracker = createCodexRolloutSemanticTracker();
    for (const line of page.items) {
      const projected = projectLine({
        stream,
        lineStartOffsetBytes: line.startOffsetBytes,
        lineEndOffsetBytes: line.endOffsetBytes,
        lineValue: line.value,
        semanticTracker,
      });
      candidateRecords.push(...projected.records);
    }
  }

  candidateRecords.sort(compareRecordsOldestFirst);
  const selected = selectRecordsWithinAggregateBudget(candidateRecords, {
    maxBytes,
    maxItems,
    direction: 'newest',
  });
  const selectedCutoffByStream = new Map<string, number>();
  for (const record of selected) {
    const prior = selectedCutoffByStream.get(record.streamId);
    selectedCutoffByStream.set(
      record.streamId,
      prior === undefined
        ? record.lineStartOffsetBytes
        : Math.min(prior, record.lineStartOffsetBytes),
    );
  }
  const scannedEndByStream = new Map(
    nextEnds.map((entry) => [entry.fileRelPath, entry.endOffsetBytes] as const),
  );
  const continuationEnds = streams.map((stream) => ({
    fileRelPath: stream.fileRelPath,
    endOffsetBytes:
      selectedCutoffByStream.get(stream.fileRelPath)
      ?? (
        candidateRecords.some((record) => record.streamId === stream.fileRelPath)
          ? originalEnds.get(stream.fileRelPath) ?? 0
          : scannedEndByStream.get(stream.fileRelPath) ?? 0
      ),
  }));
  const hasMore = continuationEnds.some((entry) => entry.endOffsetBytes > 0);
  const nextCursor = hasMore && resourceIdentity
    ? await buildBackwardCursorFromEntries(
        continuationEnds,
        resourceIdentity,
        streams,
      )
    : null;
  if (hasMore && !nextCursor) {
    return {
      items: [],
      nextCursor: null,
      tailCursor,
      hasMore: false,
      truncated: true,
    };
  }
  return {
    items: selected.map((record) => record.item),
    nextCursor,
    tailCursor,
    hasMore,
    truncated: candidateRecords.length > selected.length,
  };
}

export async function readAfterCodexExternalSessionTranscript(params: Readonly<{
  source: ExternalSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  exec?: PluginExecService;
  remoteSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<ExternalSessionTranscriptPageV1 & Readonly<{
  readAfterOutcome?: 'already_current' | 'gap_or_cursor_expired' | 'source_replaced' | 'source_unavailable';
  diagnostics?: readonly Readonly<{ code: string; count: number; positions: readonly number[] }>[];
}>> {
  const { streams, resourceIdentity } = await resolveTranscriptStreams(params);
  const tailCursor = resourceIdentity
    ? await buildTailCursorFromStreams(streams, resourceIdentity)
    : null;
  if (streams.length === 0) {
    const appServerMetadata = params.exec
      ? await resolveCodexExternalSessionAppServerMetadata({ ...params, exec: params.exec })
      : null;
    if (params.cursor === 'tail') {
      if (!appServerMetadata) {
        return {
          items: [],
          nextCursor: null,
          tailCursor: null,
          truncated: false,
          readAfterOutcome: 'source_unavailable',
        };
      }
      return {
        items: [],
        nextCursor: encodeCodexExternalForwardCursor({
          v: 2,
          kind: 'codexForwardAppServer',
          updatedAtMs: appServerMetadata.updatedAtMs,
          previewText: appServerMetadata.previewText,
        }),
        tailCursor: null,
        truncated: false,
        readAfterOutcome: 'already_current',
      };
    }
    const releasedCursor = decodeCodexExternalForwardCursor(params.cursor);
    if (releasedCursor?.kind === 'codexForwardAppServer') {
      if (!appServerMetadata) {
        return {
          items: [],
          nextCursor: null,
          tailCursor: null,
          truncated: false,
          readAfterOutcome: 'source_unavailable',
        };
      }
      const changed = appServerMetadata.updatedAtMs !== releasedCursor.updatedAtMs
        || appServerMetadata.previewText !== releasedCursor.previewText;
      const previewItem = changed
        ? mapCodexExternalSessionAppServerPreviewToMessage({
          remoteSessionId: params.remoteSessionId,
          metadata: appServerMetadata,
        })
        : null;
      const nextCursor = encodeCodexExternalForwardCursor({
        v: 2,
        kind: 'codexForwardAppServer',
        updatedAtMs: appServerMetadata.updatedAtMs,
        previewText: appServerMetadata.previewText,
      });
      return {
        items: previewItem ? [previewItem] : [],
        nextCursor,
        tailCursor: null,
        truncated: false,
        ...(previewItem ? {} : { readAfterOutcome: 'already_current' }),
      };
    }
    return {
      items: [],
      nextCursor: null,
      tailCursor: null,
      truncated: true,
      readAfterOutcome: 'gap_or_cursor_expired',
    };
  }
  if (params.cursor === 'tail') {
    return {
      items: [],
      nextCursor: tailCursor,
      tailCursor,
      truncated: false,
      readAfterOutcome: 'already_current',
    };
  }

  const decoded = decodeCodexExternalForwardCursor(params.cursor);
  if (!decoded) {
    return {
      items: [],
      nextCursor: tailCursor,
      tailCursor,
      truncated: true,
      readAfterOutcome: 'gap_or_cursor_expired',
    };
  }
  if (
    decoded.v !== 7
    || !resourceIdentity
    || !await resourceIdentityCanContinue(decoded, resourceIdentity, streams)
    || !await contentAnchorsMatch(decoded.streams, streams)
  ) {
    // Released v1-v3, predecessor v5, and current-worktree v4/v6 cursors do not
    // carry this leaf's complete generation plus content anchor. Reset
    // explicitly rather than guessing offsets against rewritten rollout bytes.
    return {
      items: [],
      nextCursor: tailCursor,
      tailCursor,
      truncated: true,
      readAfterOutcome:
        decoded.v === 6 || decoded.v === 7
          ? 'source_replaced'
          : 'gap_or_cursor_expired',
    };
  }
  const progressByStreamId = new Map(
    decoded.streams.map((entry) => [
        entry.fileRelPath,
        {
          nextOffsetBytes: Math.max(0, Math.trunc(entry.nextOffsetBytes)),
          subIndex: Math.max(0, Math.trunc(entry.subIndex)),
          fingerprintOffsetBytes: Math.max(
            Math.max(0, Math.trunc(entry.nextOffsetBytes)),
            Math.trunc(entry.fingerprintOffsetBytes),
          ),
        },
      ] as const),
  );
  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
  const maxItems = Math.max(1, Math.trunc(params.maxItems));
  const candidateRecords: CodexProjectedTranscriptRecord[] = [];
  const emptyScanAdvances = new Map<string, number>();
  const knownNonTranscriptPositionsByStream = new Map<string, number[]>();
  const unsupportedPositionsByStream = new Map<string, number[]>();
  const malformedSourceDiagnostics: Array<Readonly<{
    code: 'malformed_source_utf8';
    count: number;
    positions: readonly number[];
  }>> = [];
  let truncated = false;
  let cursorContinuationInvalid = false;

  for (const stream of streams) {
    const progress = progressByStreamId.get(stream.fileRelPath) ?? {
      nextOffsetBytes: 0,
      subIndex: 0,
      fingerprintOffsetBytes: 0,
    };
    const offsetBytes = progress.nextOffsetBytes;
    const page = await readJsonlFileForwardLines({
      filePath: stream.filePath,
      offsetBytes,
      maxBytes,
      maxItems: maxItems * 2,
    });
    malformedSourceDiagnostics.push(...(page.diagnostics ?? []));
    if (!page.reachedEnd || page.truncated) truncated = true;
    let projectedCount = 0;
    const streamKnownNonTranscriptPositions: number[] = [];
    const streamUnsupportedPositions: number[] = [];
    const semanticTracker = createCodexRolloutSemanticTracker();
    let cursorContinuationValidated = progress.subIndex === 0;
    for (const line of page.items) {
      if (line.value === null) {
        if (!cursorContinuationValidated) {
          cursorContinuationInvalid = true;
          cursorContinuationValidated = true;
        }
        streamUnsupportedPositions.push(line.startOffsetBytes);
        continue;
      }
      const projected = projectLine({
        stream,
        lineStartOffsetBytes: line.startOffsetBytes,
        lineEndOffsetBytes: line.endOffsetBytes,
        lineValue: line.value,
        semanticTracker,
      });
      if (!cursorContinuationValidated) {
        if (
          line.startOffsetBytes !== offsetBytes
          || line.endOffsetBytes !== progress.fingerprintOffsetBytes
          || progress.subIndex <= 0
          || progress.subIndex >= projected.records.length
        ) {
          cursorContinuationInvalid = true;
        }
        cursorContinuationValidated = true;
      }
      if (projected.records.length === 0) {
        (projected.knownNonTranscriptRecord
          ? streamKnownNonTranscriptPositions
          : streamUnsupportedPositions
        ).push(line.startOffsetBytes);
      }
      const records = line.startOffsetBytes === offsetBytes && progress.subIndex > 0
        ? projected.records.filter((record) => record.subIndex >= progress.subIndex)
        : projected.records;
      projectedCount += records.length;
      candidateRecords.push(...records);
    }
    if (!cursorContinuationValidated) {
      cursorContinuationInvalid = true;
    }
    if (projectedCount === 0) {
      emptyScanAdvances.set(stream.fileRelPath, page.nextOffsetBytes);
    }
    knownNonTranscriptPositionsByStream.set(
      stream.fileRelPath,
      streamKnownNonTranscriptPositions,
    );
    unsupportedPositionsByStream.set(stream.fileRelPath, streamUnsupportedPositions);
  }

  if (cursorContinuationInvalid) {
    return {
      items: [],
      nextCursor: tailCursor,
      tailCursor,
      truncated: true,
      readAfterOutcome: 'source_replaced',
    };
  }

  candidateRecords.sort(compareRecordsOldestFirst);
  const selected = selectRecordsWithinAggregateBudget(candidateRecords, {
    maxBytes,
    maxItems,
    direction: 'oldest',
  });
  const nextProgressByStream = new Map(
    decoded.streams.map((entry) => [
      entry.fileRelPath,
      {
        nextOffsetBytes: entry.nextOffsetBytes,
        subIndex: entry.subIndex,
        fingerprintOffsetBytes: entry.fingerprintOffsetBytes,
      },
    ] as const),
  );
  for (const [fileRelPath, nextOffsetBytes] of emptyScanAdvances) {
    nextProgressByStream.set(fileRelPath, {
      nextOffsetBytes,
      subIndex: 0,
      fingerprintOffsetBytes: nextOffsetBytes,
    });
  }
  for (const record of selected) {
    nextProgressByStream.set(
      record.streamId,
      record.subIndex + 1 < record.lineRecordCount
        ? {
          nextOffsetBytes: record.lineStartOffsetBytes,
          subIndex: record.subIndex + 1,
          fingerprintOffsetBytes: record.lineEndOffsetBytes,
        }
        : {
          nextOffsetBytes: record.lineEndOffsetBytes,
          subIndex: 0,
          fingerprintOffsetBytes: record.lineEndOffsetBytes,
        },
    );
  }
  const nextEntries = resourceIdentity.streams.map((stream) => ({
    fileRelPath: stream.fileRelPath,
    ...(nextProgressByStream.get(stream.fileRelPath) ?? {
      nextOffsetBytes: 0,
      subIndex: 0,
      fingerprintOffsetBytes: 0,
    }),
  }));
  const items = selected.map((record) => record.item);
  const selectedSkippedPositions = (
    positionsByStream: ReadonlyMap<string, readonly number[]>,
  ): number[] => nextEntries.flatMap((entry) => {
    const initialOffset = progressByStreamId.get(entry.fileRelPath)?.nextOffsetBytes ?? 0;
    return (positionsByStream.get(entry.fileRelPath) ?? [])
      .filter((position) => position >= initialOffset && position < entry.nextOffsetBytes);
  });
  const knownNonTranscriptPositions = selectedSkippedPositions(
    knownNonTranscriptPositionsByStream,
  );
  const unsupportedPositions = selectedSkippedPositions(unsupportedPositionsByStream);
  const nextCursor = await buildStreamVectorCursorFromEntries(
    nextEntries,
    resourceIdentity,
    streams,
    true,
  );
  if (!nextCursor) {
    return {
      items: [],
      nextCursor: tailCursor,
      tailCursor,
      truncated: true,
      readAfterOutcome: 'source_replaced',
    };
  }
  return {
    items,
    nextCursor,
    tailCursor,
    truncated: truncated || candidateRecords.length > selected.length,
    ...(
      items.length === 0
      && malformedSourceDiagnostics.length === 0
      && knownNonTranscriptPositions.length === 0
      && unsupportedPositions.length === 0
      ? { readAfterOutcome: 'already_current' }
      : {}),
    ...(
      malformedSourceDiagnostics.length > 0
      || knownNonTranscriptPositions.length > 0
      || unsupportedPositions.length > 0
        ? {
          diagnostics: [
            ...malformedSourceDiagnostics,
            ...(knownNonTranscriptPositions.length > 0 ? [{
              code: 'non_transcript_record_skipped',
              count: knownNonTranscriptPositions.length,
              positions: knownNonTranscriptPositions.slice(0, 200),
            }] : []),
            ...(unsupportedPositions.length > 0 ? [{
              code: 'unsupported_record_skipped',
              count: unsupportedPositions.length,
              positions: unsupportedPositions.slice(0, 200),
            }] : []),
          ],
        }
        : {}
    ),
  };
}
