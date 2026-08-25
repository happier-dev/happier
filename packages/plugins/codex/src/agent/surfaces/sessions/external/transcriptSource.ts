import { createHash } from 'node:crypto';
import { open, stat, type FileHandle } from 'node:fs/promises';

import type { AgentExternalSessionTranscriptItem } from '@happier-dev/plugin-sdk/sessions/external';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import {
  readJsonlFileBackwardPage,
  readJsonlFileForwardLines,
} from '@happier-dev/plugin-sdk/sessions/file-stores';

import { createCodexRolloutSemanticTracker } from '../../../rollout/semanticTracker.js';
import { projectCodexRolloutRecord } from '../../../rollout/projection/actions.js';
import { mapCodexRolloutLineToExternalMessages } from '../../../rollout/projection/transcript.js';
import {
  describeCodexRolloutFileSetResourceIdentity,
  inventoryCodexRootSessionRolloutFiles,
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
import type {
  CodexExternalSessionSource,
  CodexExternalSessionTranscriptSourcePage,
} from './models.js';
import { isCodexExternalSessionLinkDataValue } from './models.js';
import {
  createCodexExternalSessionJsonlScannerFileSystem,
  throwIfCodexExternalSessionInvocationStopped,
  type CodexExternalSessionInvocationBounds,
} from './invocationBounds.js';

type CodexBackwardCursor = Readonly<{
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

type CodexExternalTranscriptRolloutStream = CodexRolloutFile & Readonly<{
  sidechainId: string | null;
}>;

type CodexProjectedTranscriptRecord = Readonly<{
  item: AgentExternalSessionTranscriptItem;
  streamId: string;
  lineStartOffsetBytes: number;
  lineEndOffsetBytes: number;
  subIndex: number;
  lineRecordCount: number;
}>;

type BestCodexHomeWithFiles = Readonly<{
  codexHome: string;
  source: CodexExternalSessionSource;
  files: readonly CodexRolloutFile[];
}>;

export class CodexExternalSessionUnsupportedRolloutRecordError extends Error {
  readonly code = 'codex_unsupported_rollout_record';

  constructor() {
    super('Codex external session contains an unsupported rollout record.');
    this.name = 'CodexExternalSessionUnsupportedRolloutRecordError';
  }
}

function encodeBackwardCursor(value: CodexBackwardCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCodexExternalBackwardCursor(raw: string | undefined): CodexBackwardCursor | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
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
    return null;
  } catch {
    return null;
  }
}

function measureTranscriptItemBytes(item: AgentExternalSessionTranscriptItem): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8');
}

function compareTranscriptItemsOldestFirst(
  left: AgentExternalSessionTranscriptItem,
  right: AgentExternalSessionTranscriptItem,
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

// This cursor scheme targets a bounded append-oriented rollout recorder contract;
// exact release provenance must be validated separately. These samples are
// continuity evidence for bytes already acknowledged at a cursor watermark, not
// a whole-file integrity commitment or a linearizable snapshot. Re-characterize
// the recorder before relying on this scheme for a non-append-oriented release.
const CURSOR_FINGERPRINT_SAMPLE_BYTES = 4 * 1024;

async function readFileRange(
  file: FileHandle,
  startOffsetBytes: number,
  lengthBytes: number,
  bounds: CodexExternalSessionInvocationBounds,
): Promise<Buffer> {
  throwIfCodexExternalSessionInvocationStopped(bounds);
  if (lengthBytes <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(lengthBytes);
  const { bytesRead } = await file.read(
    buffer,
    0,
    lengthBytes,
    startOffsetBytes,
  );
  throwIfCodexExternalSessionInvocationStopped(bounds);
  return bytesRead === lengthBytes ? buffer : buffer.subarray(0, bytesRead);
}

async function captureContentAnchor(
  filePath: string,
  fingerprintOffsetBytes: number,
  bounds: CodexExternalSessionInvocationBounds,
): Promise<string | null> {
  throwIfCodexExternalSessionInvocationStopped(bounds);
  if (!Number.isSafeInteger(fingerprintOffsetBytes) || fingerprintOffsetBytes < 0) {
    return null;
  }
  let file: FileHandle | null = null;
  try {
    file = await open(filePath, 'r');
    throwIfCodexExternalSessionInvocationStopped(bounds);
    const sizeBytes = Number((await file.stat({ bigint: true })).size);
    throwIfCodexExternalSessionInvocationStopped(bounds);
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
      readFileRange(file, 0, prefixLength, bounds),
      readFileRange(
        file,
        fingerprintOffsetBytes - boundaryLength,
        boundaryLength,
        bounds,
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
    throwIfCodexExternalSessionInvocationStopped(bounds);
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
  bounds: CodexExternalSessionInvocationBounds,
): Promise<boolean> {
  throwIfCodexExternalSessionInvocationStopped(bounds);
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
          bounds,
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
  bounds: CodexExternalSessionInvocationBounds,
): Promise<string | null> {
  throwIfCodexExternalSessionInvocationStopped(bounds);
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
      ? await captureContentAnchor(stream.filePath, fingerprintOffsetBytes, bounds)
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
  bounds: CodexExternalSessionInvocationBounds,
): Promise<string | null> {
  throwIfCodexExternalSessionInvocationStopped(bounds);
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
      ? await captureContentAnchor(stream.filePath, endOffsetBytes, bounds)
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

async function statFileSize(
  filePath: string,
  bounds: CodexExternalSessionInvocationBounds,
): Promise<number | null> {
  throwIfCodexExternalSessionInvocationStopped(bounds);
  try {
    const size = Math.max(0, Math.trunc((await stat(filePath)).size));
    throwIfCodexExternalSessionInvocationStopped(bounds);
    return size;
  } catch {
    throwIfCodexExternalSessionInvocationStopped(bounds);
    return null;
  }
}

async function buildTailCursorFromStreams(
  streams: readonly CodexExternalTranscriptRolloutStream[],
  identity: CodexSessionRolloutResourceIdentity,
  bounds: CodexExternalSessionInvocationBounds,
): Promise<string | null> {
  const entries = await Promise.all(streams.map(async (stream) => ({
    fileRelPath: stream.fileRelPath,
    nextOffsetBytes: await statFileSize(stream.filePath, bounds) ?? 0,
    subIndex: 0,
  })));
  return await buildStreamVectorCursorFromEntries(
    entries,
    identity,
    streams,
    false,
    bounds,
  );
}

type CodexForwardContinuityCursor = Readonly<{
  sourceGeneration: readonly string[];
  streams: readonly Readonly<{
    fileRelPath: string;
    physicalGeneration: string;
    nextOffsetBytes: number;
  }>[];
}>;

function sourceGenerationMatches(
  cursor: CodexForwardContinuityCursor,
  current: CodexSessionRolloutResourceIdentity,
): boolean {
  return cursor.sourceGeneration.length === current.sourceGeneration.length
    && cursor.sourceGeneration.every(
      (generation, index) => generation === current.sourceGeneration[index],
    );
}

async function priorStreamsCanContinue(
  cursor: CodexForwardContinuityCursor,
  current: CodexSessionRolloutResourceIdentity,
  streams: readonly CodexExternalTranscriptRolloutStream[],
  bounds: CodexExternalSessionInvocationBounds,
): Promise<boolean> {
  throwIfCodexExternalSessionInvocationStopped(bounds);
  if (
    new Set(current.streams.map((stream) => stream.fileRelPath)).size
      !== current.streams.length
    || new Set(streams.map((stream) => stream.fileRelPath)).size
      !== streams.length
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
    const size = await statFileSize(liveStream.filePath, bounds);
    return size !== null && size >= cursorStream.nextOffsetBytes;
  }))).every(Boolean);
}

async function resourceIdentityCanContinue(
  cursor: CodexForwardContinuityCursor,
  current: CodexSessionRolloutResourceIdentity,
  streams: readonly CodexExternalTranscriptRolloutStream[],
  bounds: CodexExternalSessionInvocationBounds,
): Promise<boolean> {
  if (
    !sourceGenerationMatches(cursor, current)
    || cursor.streams.length !== current.streams.length
  ) {
    return false;
  }
  return await priorStreamsCanContinue(cursor, current, streams, bounds);
}

async function resourceIdentityHasContinuousMembershipGrowth(
  cursor: CodexForwardContinuityCursor,
  current: CodexSessionRolloutResourceIdentity,
  streams: readonly CodexExternalTranscriptRolloutStream[],
  bounds: CodexExternalSessionInvocationBounds,
): Promise<boolean> {
  if (
    !sourceGenerationMatches(cursor, current)
    || current.streams.length <= cursor.streams.length
  ) {
    return false;
  }
  return await priorStreamsCanContinue(cursor, current, streams, bounds);
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

function projectLine(params: Readonly<{
  stream: CodexExternalTranscriptRolloutStream;
  lineStartOffsetBytes: number;
  lineEndOffsetBytes: number;
  lineValue: unknown;
  semanticTracker: ReturnType<typeof createCodexRolloutSemanticTracker>;
}>): Readonly<{
  records: readonly CodexProjectedTranscriptRecord[];
  knownNonTranscriptRecord: boolean;
  unsupportedRecord: boolean;
}> {
  const rolloutRecord = projectCodexRolloutRecord(params.lineValue, { debug: true });
  const normalizedActions = rolloutRecord.actions
    .flatMap((action) => params.semanticTracker.consume(action));
  const mappedItems = mapCodexRolloutLineToExternalMessages({
    fileRelPath: params.stream.fileRelPath,
    lineStartOffsetBytes: params.lineStartOffsetBytes,
    lineValue: params.lineValue,
    actions: normalizedActions,
    sidechainId: params.stream.sidechainId,
  });
  const safeItems = mappedItems.flatMap((item) => (
    isCodexExternalSessionLinkDataValue(item.raw, new Set())
      ? [{
          id: item.id,
          createdAtMs: item.createdAtMs,
          ...(item.localId !== undefined ? { localId: item.localId } : {}),
          sidechainId: params.stream.sidechainId,
          ...(item.messageRole !== undefined ? { messageRole: item.messageRole } : {}),
          raw: item.raw,
        }]
      : []
  ));
  return {
    records: safeItems.map((item, subIndex) => ({
      item,
      streamId: params.stream.fileRelPath,
      lineStartOffsetBytes: params.lineStartOffsetBytes,
      lineEndOffsetBytes: params.lineEndOffsetBytes,
      subIndex,
      lineRecordCount: safeItems.length,
    })),
    knownNonTranscriptRecord: rolloutRecord.disposition === 'known',
    unsupportedRecord: rolloutRecord.disposition === 'unsupported',
  };
}

function collectTranscriptStreams(params: Readonly<{
  rootSessionId: string;
  rootFamilyFiles: readonly CodexRolloutFile[];
}>): readonly CodexExternalTranscriptRolloutStream[] {
  return params.rootFamilyFiles.map((file) => ({
      ...file,
      sidechainId: file.rootSessionId === params.rootSessionId
        && file.sessionId
        && file.sessionId !== params.rootSessionId
        ? file.sessionId
        : null,
    })).sort((left, right) =>
    left.sortMs - right.sortMs
    || left.mtimeMs - right.mtimeMs
    || left.fileRelPath.localeCompare(right.fileRelPath),
  );
}

async function resolveBestHomeWithFiles(params: Readonly<{
  source: CodexExternalSessionSource;
  activeServerDir?: string;
  env: NodeJS.ProcessEnv;
  remoteSessionId: string;
}> & CodexExternalSessionInvocationBounds): Promise<BestCodexHomeWithFiles | null> {
  throwIfCodexExternalSessionInvocationStopped(params);
  const entries = await resolveHomeEntries({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
    signal: params.signal,
    deadlineAtMs: params.deadlineAtMs,
  });
  throwIfCodexExternalSessionInvocationStopped(params);
  let best: BestCodexHomeWithFiles | null = null;
  let bestLatestMtimeMs = -1;
  for (const entry of entries) {
    throwIfCodexExternalSessionInvocationStopped(params);
    const inventory = await inventoryCodexRootSessionRolloutFiles({
      codexHome: entry.codexHome,
      remoteSessionIds: [params.remoteSessionId],
      signal: params.signal ?? new AbortController().signal,
      deadlineAtMs: params.deadlineAtMs,
    });
    throwIfCodexExternalSessionInvocationStopped(params);
    const files = inventory.requested[0]?.files ?? [];
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
  source: CodexExternalSessionSource;
  activeServerDir?: string;
  remoteSessionId: string;
  env: NodeJS.ProcessEnv;
  exec: ExecService;
}> & CodexExternalSessionInvocationBounds): Promise<CodexExternalSessionAppServerMetadata | null> {
  const page = await listCodexSessionCandidates({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
    exec: params.exec,
    searchTerm: params.remoteSessionId,
    searchMode: 'full',
    limit: 50,
    signal: params.signal,
    deadlineAtMs: params.deadlineAtMs,
  });
  throwIfCodexExternalSessionInvocationStopped(params);
  let best: CodexExternalSessionAppServerMetadata | null = null;
  for (const candidate of page.candidates) {
    throwIfCodexExternalSessionInvocationStopped(params);
    if (candidate.remoteSessionId !== params.remoteSessionId) continue;
    const metadata = mapCodexExternalSessionAppServerCandidateToMetadata({ candidate });
    if (!metadata) continue;
    if (!best || metadata.updatedAtMs > best.updatedAtMs) best = metadata;
  }
  return best;
}

async function resolveTranscriptStreams(params: Readonly<{
  source: CodexExternalSessionSource;
  activeServerDir?: string;
  env: NodeJS.ProcessEnv;
  remoteSessionId: string;
}> & CodexExternalSessionInvocationBounds): Promise<Readonly<{
  bestHome: BestCodexHomeWithFiles | null;
  streams: readonly CodexExternalTranscriptRolloutStream[];
  resourceIdentity: CodexSessionRolloutResourceIdentity | null;
}>> {
  throwIfCodexExternalSessionInvocationStopped(params);
  const bestHome = await resolveBestHomeWithFiles(params);
  throwIfCodexExternalSessionInvocationStopped(params);
  if (!bestHome) {
    return { bestHome: null, streams: [], resourceIdentity: null };
  }
  const streams = collectTranscriptStreams({
    rootSessionId: params.remoteSessionId,
    rootFamilyFiles: bestHome.files,
  });
  throwIfCodexExternalSessionInvocationStopped(params);
  return {
    bestHome,
    streams,
    resourceIdentity: await describeCodexRolloutFileSetResourceIdentity({
      codexHome: bestHome.codexHome,
      files: streams,
      signal: params.signal,
      deadlineAtMs: params.deadlineAtMs,
    }),
  };
}

export async function pageCodexExternalSessionTranscript(params: Readonly<{
  source: CodexExternalSessionSource;
  activeServerDir?: string;
  env: NodeJS.ProcessEnv;
  exec?: ExecService;
  remoteSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
}> & CodexExternalSessionInvocationBounds): Promise<CodexExternalSessionTranscriptSourcePage> {
  throwIfCodexExternalSessionInvocationStopped(params);
  const fileSystem = createCodexExternalSessionJsonlScannerFileSystem(params);
  const { streams, resourceIdentity } = await resolveTranscriptStreams(params);
  throwIfCodexExternalSessionInvocationStopped(params);
  const tailCursor = resourceIdentity
    ? await buildTailCursorFromStreams(streams, resourceIdentity, params)
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
    || !resourceIdentity
    || !resourceIdentityMatches(decoded, resourceIdentity)
    || !await contentAnchorsMatch(decoded.streams, streams, params)
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
    decoded
      ? decoded.streams.map((entry) => [entry.fileRelPath, entry.endOffsetBytes] as const)
      : [],
  );
  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
  const maxItems = Math.max(1, Math.trunc(params.maxItems));
  const candidateRecords: CodexProjectedTranscriptRecord[] = [];
  const nextEnds: Array<{ fileRelPath: string; endOffsetBytes: number }> = [];
  const originalEnds = new Map<string, number>();
  const scannedToStreamStart = new Set<string>();

  for (const stream of streams) {
    throwIfCodexExternalSessionInvocationStopped(params);
    const fileSize = await statFileSize(stream.filePath, params) ?? 0;
    const endOffsetBytes = Math.min(fileSize, Math.max(0, Math.trunc(endByStreamId.get(stream.fileRelPath) ?? fileSize)));
    originalEnds.set(stream.fileRelPath, endOffsetBytes);
    if (endOffsetBytes <= 0) continue;
    const page = await readJsonlFileBackwardPage({
      filePath: stream.filePath,
      endOffsetBytes,
      maxBytes,
      maxItems: maxItems * 2,
      fileSystem,
    });
    throwIfCodexExternalSessionInvocationStopped(params);
    if (page.diagnostics?.some((diagnostic) => diagnostic.code === 'malformed_source_utf8')) {
      throw new Error('Codex transcript source contains malformed UTF-8.');
    }
    nextEnds.push({ fileRelPath: stream.fileRelPath, endOffsetBytes: page.nextEndOffsetBytes });
    if (page.reachedStart) scannedToStreamStart.add(stream.fileRelPath);

    const semanticTracker = createCodexRolloutSemanticTracker();
    for (const line of page.items) {
      throwIfCodexExternalSessionInvocationStopped(params);
      const projected = projectLine({
        stream,
        lineStartOffsetBytes: line.startOffsetBytes,
        lineEndOffsetBytes: line.endOffsetBytes,
        lineValue: line.value,
        semanticTracker,
      });
      if (projected.unsupportedRecord) {
        throw new CodexExternalSessionUnsupportedRolloutRecordError();
      }
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
  const oldestCandidateStartByStream = new Map<string, number>();
  for (const record of candidateRecords) {
    const prior = oldestCandidateStartByStream.get(record.streamId);
    if (prior === undefined || record.lineStartOffsetBytes < prior) {
      oldestCandidateStartByStream.set(record.streamId, record.lineStartOffsetBytes);
    }
  }
  // A continuation offset is a byte position, not a content signal: every rollout opens with
  // session/harness records that project no transcript rows, so unread leading bytes routinely
  // hold nothing to page. Where this scan already reached a stream's start, every remaining byte
  // was inspected, so older content exists only when the aggregate budget dropped a projected
  // record older than the continuation offset. Streams the scan did not exhaust stay conservative.
  const hasMore = continuationEnds.some((entry) => {
    if (entry.endOffsetBytes <= 0) return false;
    if (!scannedToStreamStart.has(entry.fileRelPath)) return true;
    const oldestCandidateStartOffsetBytes = oldestCandidateStartByStream.get(entry.fileRelPath);
    return oldestCandidateStartOffsetBytes !== undefined
      && oldestCandidateStartOffsetBytes < entry.endOffsetBytes;
  });
  const nextCursor = hasMore && resourceIdentity
    ? await buildBackwardCursorFromEntries(
        continuationEnds,
        resourceIdentity,
        streams,
        params,
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
    // A bounded selected window with an anchored continuation is ordinary
    // pagination, not a source truncation. The earlier missing-continuation
    // branch remains the fail-closed `truncated: true` outcome.
    truncated: false,
  };
}

export async function readAfterCodexExternalSessionTranscript(params: Readonly<{
  source: CodexExternalSessionSource;
  activeServerDir?: string;
  env: NodeJS.ProcessEnv;
  exec?: ExecService;
  remoteSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
}> & CodexExternalSessionInvocationBounds): Promise<CodexExternalSessionTranscriptSourcePage> {
  throwIfCodexExternalSessionInvocationStopped(params);
  const fileSystem = createCodexExternalSessionJsonlScannerFileSystem(params);
  const { streams, resourceIdentity } = await resolveTranscriptStreams(params);
  throwIfCodexExternalSessionInvocationStopped(params);
  const tailCursor = resourceIdentity
    ? await buildTailCursorFromStreams(streams, resourceIdentity, params)
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
      readAfterOutcome:
        releasedCursor?.kind === 'codexForwardStreamVector'
          ? 'source_replaced'
          : 'gap_or_cursor_expired',
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
  const priorContentIsContinuous = decoded.v === 7
    && resourceIdentity !== null
    && await contentAnchorsMatch(decoded.streams, streams, params);
  const membershipGrowthIsContinuous = priorContentIsContinuous
    && await resourceIdentityHasContinuousMembershipGrowth(
      decoded,
      resourceIdentity,
      streams,
      params,
    );
  if (
    decoded.v !== 7
    || !resourceIdentity
    || !await resourceIdentityCanContinue(decoded, resourceIdentity, streams, params)
    || !priorContentIsContinuous
  ) {
    // A released v2 app-server cursor carries no rollout generation or content
    // anchor at all, and every unrecognized cursor already decoded to null
    // above. Reset explicitly rather than guessing offsets against rewritten
    // rollout bytes.
    return {
      items: [],
      nextCursor: tailCursor,
      tailCursor,
      truncated: true,
      // Exact membership growth still rejects this cursor and applies zero
      // items; the shared follow owner may then perform its bounded canonical
      // reread. Any prior-stream/source change remains terminal replacement.
      readAfterOutcome:
        membershipGrowthIsContinuous || decoded.v !== 7
          ? 'gap_or_cursor_expired'
          : 'source_replaced',
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
  const malformedSourceDiagnostics: Array<Readonly<{
    code: 'malformed_source_utf8';
    count: number;
    positions: readonly number[];
  }>> = [];
  let truncated = false;
  let cursorContinuationInvalid = false;

  for (const stream of streams) {
    throwIfCodexExternalSessionInvocationStopped(params);
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
      fileSystem,
    });
    throwIfCodexExternalSessionInvocationStopped(params);
    malformedSourceDiagnostics.push(...(page.diagnostics ?? []));
    if (!page.reachedEnd || page.truncated) truncated = true;
    let projectedCount = 0;
    const streamKnownNonTranscriptPositions: number[] = [];
    const semanticTracker = createCodexRolloutSemanticTracker();
    let cursorContinuationValidated = progress.subIndex === 0;
    for (const line of page.items) {
      throwIfCodexExternalSessionInvocationStopped(params);
      if (line.value === null) {
        throw new CodexExternalSessionUnsupportedRolloutRecordError();
      }
      const projected = projectLine({
        stream,
        lineStartOffsetBytes: line.startOffsetBytes,
        lineEndOffsetBytes: line.endOffsetBytes,
        lineValue: line.value,
        semanticTracker,
      });
      if (projected.unsupportedRecord) {
        throw new CodexExternalSessionUnsupportedRolloutRecordError();
      }
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
        if (projected.knownNonTranscriptRecord) {
          streamKnownNonTranscriptPositions.push(line.startOffsetBytes);
        }
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
  const nextCursor = await buildStreamVectorCursorFromEntries(
    nextEntries,
    resourceIdentity,
    streams,
    true,
    params,
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
      ? { readAfterOutcome: 'already_current' }
      : {}),
    ...(
      malformedSourceDiagnostics.length > 0
      || knownNonTranscriptPositions.length > 0
        ? {
          diagnostics: [
            ...malformedSourceDiagnostics,
            ...(knownNonTranscriptPositions.length > 0 ? [{
              code: 'non_transcript_record_skipped',
              count: knownNonTranscriptPositions.length,
              positions: knownNonTranscriptPositions.slice(0, 200),
            }] : []),
          ],
        }
        : {}
    ),
  };
}
