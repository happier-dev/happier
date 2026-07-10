import { stat } from 'node:fs/promises';

import type {
  ExternalSessionActivityResultV1,
  ExternalSessionFollowLeaseV1,
  ExternalSessionFollowTranscriptPathResolutionV1,
  ExternalSessionProviderStoreKeyV1,
  ExternalSessionRuntimeHostAdapterParamsV1,
  ExternalSessionsSource,
  ExternalSessionTranscriptPageV1,
  ExternalSessionTranscriptRawMessageV1,
  ExternalSessionTranscriptStoreAdapterV1,
  ExternalSessionTranscriptStoreFollowRequestV1,
} from '@happier-dev/plugin-sdk/sessions';
import {
  readJsonlFileBackwardPage,
  readJsonlFileForwardLines,
} from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';

import { createCodexRolloutSemanticTracker } from '../../../rollout/semanticTracker.js';
import { mapCodexRolloutEventToActions } from '../../../rollout/projection/actions.js';
import { mapCodexRolloutLineToExternalMessages } from '../../../rollout/projection/transcript.js';
import {
  collectCodexSessionRolloutFiles,
  type CodexRolloutFile,
} from '../../../rollout/discovery/sessionsForHome.js';
import { homeEntries as resolveHomeEntries } from '../../../rollout/discovery/homeEntries.js';
import { readCodexSessionMetaFromRollout } from '../../../rollout/discovery/indexData.js';
import {
  decodeCodexExternalForwardCursor,
  encodeCodexExternalForwardCursor,
  mapCodexExternalSessionAppServerCandidateToMetadata,
  mapCodexExternalSessionAppServerPreviewToMessage,
  type CodexExternalSessionAppServerMetadata,
} from './transcript.js';
import { resolveCodexExternalSessionFallbackHome } from './providerOps.js';
import { listCodexSessionCandidates } from './candidateHostAdapter.js';

type CodexBackwardStreamVectorCursorV1 = Readonly<{
  v: 1;
  kind: 'codexBackwardStreamVector';
  streams: readonly Readonly<{
    fileRelPath: string;
    endOffsetBytes: number;
  }>[];
}>;

type CodexExternalTranscriptRolloutStream = CodexRolloutFile & Readonly<{
  threadId: string;
  sidechainId: string | null;
}>;

type CodexProjectedTranscriptRecord = Readonly<{
  item: ExternalSessionTranscriptRawMessageV1;
  streamId: string;
  lineStartOffsetBytes: number;
  lineEndOffsetBytes: number;
}>;

type BestCodexHomeWithFiles = Readonly<{
  codexHome: string;
  source: ExternalSessionsSource;
  files: readonly CodexRolloutFile[];
}>;

function encodeBackwardCursor(value: CodexBackwardStreamVectorCursorV1): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeBackwardCursor(raw: string | undefined): CodexBackwardStreamVectorCursorV1 | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1 || record.kind !== 'codexBackwardStreamVector') return null;
    const streams = Array.isArray(record.streams) ? record.streams.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const streamRecord = entry as Record<string, unknown>;
      const fileRelPath = typeof streamRecord.fileRelPath === 'string' ? streamRecord.fileRelPath.trim() : '';
      const endOffsetBytes = typeof streamRecord.endOffsetBytes === 'number' && Number.isFinite(streamRecord.endOffsetBytes)
        ? Math.max(0, Math.trunc(streamRecord.endOffsetBytes))
        : NaN;
      return fileRelPath && Number.isFinite(endOffsetBytes) ? [{ fileRelPath, endOffsetBytes }] : [];
    }) : [];
    return { v: 1, kind: 'codexBackwardStreamVector', streams };
  } catch {
    return null;
  }
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

function buildStreamVectorCursorFromEntries(
  entries: readonly Readonly<{ fileRelPath: string; nextOffsetBytes: number; subIndex?: number }>[],
  allowEmpty: boolean,
): string | null {
  if (!allowEmpty && entries.length === 0) return null;
  return encodeCodexExternalForwardCursor({
    v: 4,
    kind: 'codexForwardStreamVector',
    streams: entries
      .map((entry) => ({
        fileRelPath: entry.fileRelPath,
        nextOffsetBytes: Math.max(0, Math.trunc(entry.nextOffsetBytes)),
        subIndex: Math.max(0, Math.trunc(entry.subIndex ?? 0)),
      }))
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
): Promise<string | null> {
  const entries = await Promise.all(streams.map(async (stream) => ({
    fileRelPath: stream.fileRelPath,
    nextOffsetBytes: await statFileSize(stream.filePath) ?? 0,
    subIndex: 0,
  })));
  return buildStreamVectorCursorFromEntries(entries, false);
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
}> {
  const normalizedActions = mapCodexRolloutEventToActions(params.lineValue, { debug: true })
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
    records: mappedItems.map((item) => ({
      item,
      streamId: params.stream.fileRelPath,
      lineStartOffsetBytes: params.lineStartOffsetBytes,
      lineEndOffsetBytes: params.lineEndOffsetBytes,
    })),
    discoveredChildThreadIds,
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
  exec: ExternalSessionRuntimeHostAdapterParamsV1['exec'];
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
}>> {
  const bestHome = await resolveBestHomeWithFiles(params);
  if (!bestHome) return { bestHome: null, streams: [] };
  return {
    bestHome,
    streams: await collectTranscriptStreams({
      codexHome: bestHome.codexHome,
      remoteSessionId: params.remoteSessionId,
      initialRolloutFiles: bestHome.files,
    }),
  };
}

function normalizeProviderSessionId(input: ExternalSessionProviderStoreKeyV1): string {
  return input.providerSessionId.trim();
}

async function pageCodexTranscript(params: Readonly<{
  source: ExternalSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  exec: ExternalSessionRuntimeHostAdapterParamsV1['exec'];
  remoteSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<ExternalSessionTranscriptPageV1> {
  const { streams } = await resolveTranscriptStreams(params);
  const tailCursor = await buildTailCursorFromStreams(streams);
  if (streams.length === 0) {
    const appServerMetadata = await resolveCodexExternalSessionAppServerMetadata(params);
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

  const decoded = decodeBackwardCursor(params.cursor);
  const endByStreamId = new Map(
    decoded?.streams.map((entry) => [entry.fileRelPath, entry.endOffsetBytes] as const) ?? [],
  );
  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
  const maxItems = Math.max(1, Math.trunc(params.maxItems));
  const candidateRecords: CodexProjectedTranscriptRecord[] = [];
  const nextEnds: Array<{ fileRelPath: string; endOffsetBytes: number }> = [];
  let hasMore = false;

  for (const stream of streams) {
    const fileSize = await statFileSize(stream.filePath) ?? 0;
    const endOffsetBytes = Math.min(fileSize, Math.max(0, Math.trunc(endByStreamId.get(stream.fileRelPath) ?? fileSize)));
    if (endOffsetBytes <= 0) continue;
    const page = await readJsonlFileBackwardPage({
      filePath: stream.filePath,
      endOffsetBytes,
      maxBytes,
      maxItems: maxItems * 2,
    });
    nextEnds.push({ fileRelPath: stream.fileRelPath, endOffsetBytes: page.nextEndOffsetBytes });
    if (!page.reachedStart) hasMore = true;

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

  const selected = candidateRecords
    .sort(compareRecordsOldestFirst)
    .slice(-maxItems);
  return {
    items: selected.map((record) => record.item),
    nextCursor: hasMore
      ? encodeBackwardCursor({ v: 1, kind: 'codexBackwardStreamVector', streams: nextEnds })
      : null,
    tailCursor,
    hasMore,
    truncated: candidateRecords.length > selected.length,
  };
}

async function readAfterCodexTranscript(params: Readonly<{
  source: ExternalSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  remoteSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<ExternalSessionTranscriptPageV1> {
  const { streams } = await resolveTranscriptStreams(params);
  const tailCursor = await buildTailCursorFromStreams(streams);
  if (params.cursor === 'tail') {
    return { items: [], nextCursor: tailCursor, tailCursor, truncated: false };
  }

  const decoded = decodeCodexExternalForwardCursor(params.cursor);
  const progressByStreamId = new Map(
    decoded?.kind === 'codexForwardStreamVector'
      ? decoded.streams.map((entry) => [
        entry.fileRelPath,
        Math.max(0, Math.trunc(entry.nextOffsetBytes)),
      ] as const)
      : [],
  );
  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
  const maxItems = Math.max(1, Math.trunc(params.maxItems));
  const candidateRecords: CodexProjectedTranscriptRecord[] = [];
  const nextEntries: Array<{ fileRelPath: string; nextOffsetBytes: number }> = [];
  let truncated = false;

  for (const stream of streams) {
    const offsetBytes = progressByStreamId.get(stream.fileRelPath) ?? 0;
    const page = await readJsonlFileForwardLines({
      filePath: stream.filePath,
      offsetBytes,
      maxBytes,
      maxItems: maxItems * 2,
    });
    nextEntries.push({ fileRelPath: stream.fileRelPath, nextOffsetBytes: page.nextOffsetBytes });
    if (!page.reachedEnd || page.truncated) truncated = true;
    const semanticTracker = createCodexRolloutSemanticTracker();
    for (const line of page.items) {
      if (line.value === null) continue;
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

  const selected = candidateRecords
    .sort(compareRecordsOldestFirst)
    .slice(0, maxItems);
  return {
    items: selected.map((record) => record.item),
    nextCursor: buildStreamVectorCursorFromEntries(nextEntries, true),
    tailCursor,
    truncated: truncated || candidateRecords.length > selected.length,
  };
}

async function resolveCodexTranscriptMetadata(params: Readonly<{
  source: ExternalSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  exec: ExternalSessionRuntimeHostAdapterParamsV1['exec'];
  remoteSessionId: string;
}>): Promise<Readonly<{
  workingDirectory: string | null;
  activity: ExternalSessionActivityResultV1;
  primaryRolloutFilePath: string | null;
  rolloutHome: string | null;
  appServerMetadata: CodexExternalSessionAppServerMetadata | null;
}>> {
  const { bestHome, streams } = await resolveTranscriptStreams(params);
  const rootStreams = streams.filter((stream) => stream.sidechainId === null);
  const preferredStreams = (rootStreams.length > 0 ? rootStreams : streams)
    .slice()
    .sort((left, right) =>
      right.sortMs - left.sortMs
      || right.mtimeMs - left.mtimeMs
      || right.fileRelPath.localeCompare(left.fileRelPath),
    );
  let workingDirectory: string | null = null;
  for (const stream of preferredStreams) {
    const meta = await readCodexSessionMetaFromRollout(stream.filePath);
    if (typeof meta?.cwd === 'string' && meta.cwd.trim().length > 0) {
      workingDirectory = meta.cwd.trim();
      break;
    }
  }
  const appServerMetadata = workingDirectory
    ? null
    : await resolveCodexExternalSessionAppServerMetadata(params);
  const lastActivityAtMs = streams.length > 0
    ? Math.max(...streams.map((stream) => Math.max(0, Math.trunc(stream.mtimeMs))))
    : appServerMetadata?.updatedAtMs ?? null;
  return {
    workingDirectory: workingDirectory ?? appServerMetadata?.workingDirectory ?? null,
    activity: {
      lastActivityAtMs,
      isRunning: false,
    },
    primaryRolloutFilePath: preferredStreams[0]?.filePath ?? null,
    rolloutHome: bestHome?.codexHome ?? null,
    appServerMetadata,
  };
}

function hasExactConnectedServiceHome(source: ExternalSessionsSource): boolean {
  return source.kind === 'codexHome'
    && source.home === 'connectedService'
    && (
      (typeof source.connectedServiceProfileId === 'string' && source.connectedServiceProfileId.trim().length > 0)
      || (typeof source.connectedServiceGroupId === 'string' && source.connectedServiceGroupId.trim().length > 0)
      || (typeof source.homePath === 'string' && source.homePath.trim().length > 0)
    );
}

async function resolveProviderHome(params: Readonly<{
  source: ExternalSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  remoteSessionId: string;
}>): Promise<string | null> {
  const entries = await resolveHomeEntries({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
  });
  const fallbackHome = resolveCodexExternalSessionFallbackHome(entries);
  if (params.source.kind === 'codexHome' && params.source.home === 'user') return fallbackHome;
  if (hasExactConnectedServiceHome(params.source)) return fallbackHome;
  const best = await resolveBestHomeWithFiles(params);
  return best?.codexHome ?? null;
}

function createNoopFollowLease(tailCursor: string | null): ExternalSessionFollowLeaseV1 {
  return Object.freeze({
    release: async () => undefined,
    getTailCursor: () => tailCursor,
    subscribeToTranscriptUpdates: () => () => undefined,
  });
}

async function acquireFollowLease(params: Readonly<{
  request: ExternalSessionTranscriptStoreFollowRequestV1;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  exec: ExternalSessionRuntimeHostAdapterParamsV1['exec'];
  fileFollow: ExternalSessionRuntimeHostAdapterParamsV1['fileFollow'];
}>): Promise<ExternalSessionFollowLeaseV1> {
  const metadata = await resolveCodexTranscriptMetadata({
    source: params.request.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
    exec: params.exec,
    remoteSessionId: params.request.providerSessionId,
  });
  if (!params.fileFollow || !metadata.primaryRolloutFilePath) {
    return createNoopFollowLease(null);
  }

  let tailCursor = (await readAfterCodexTranscript({
    source: params.request.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
    remoteSessionId: params.request.providerSessionId,
    cursor: 'tail',
    maxBytes: 1024,
    maxItems: 1,
  })).nextCursor ?? null;
  const listeners = new Set<Parameters<
    NonNullable<ExternalSessionFollowLeaseV1['subscribeToTranscriptUpdates']>
  >[0]>();
  const semanticTracker = createCodexRolloutSemanticTracker();
  const stream: CodexExternalTranscriptRolloutStream = {
    filePath: metadata.primaryRolloutFilePath,
    fileRelPath: metadata.primaryRolloutFilePath,
    sortMs: Date.now(),
    mtimeMs: Date.now(),
    threadId: params.request.providerSessionId,
    sidechainId: null,
  };
  const handle = await params.fileFollow.follow({
    path: metadata.primaryRolloutFilePath,
    startAt: 'end',
    strategy: 'poll',
    onLine: async (line) => {
      const parsed = (() => {
        try {
          return JSON.parse(line.line) as unknown;
        } catch {
          return null;
        }
      })();
      if (parsed === null) return;
      const projected = projectLine({
        stream,
        lineStartOffsetBytes: line.sequence,
        lineEndOffsetBytes: line.sequence,
        lineValue: parsed,
        semanticTracker,
      });
      if (projected.records.length === 0) return;
      const fromCursor = tailCursor;
      tailCursor = (await readAfterCodexTranscript({
        source: params.request.source,
        activeServerDir: params.activeServerDir,
        env: params.env,
        remoteSessionId: params.request.providerSessionId,
        cursor: 'tail',
        maxBytes: 1024,
        maxItems: 1,
      })).nextCursor ?? tailCursor;
      await Promise.all([...listeners].map((listener) => listener({
        items: projected.records.map((record) => record.item),
        fromCursor,
        nextCursor: tailCursor,
        truncated: false,
      })));
    },
  });

  return Object.freeze({
    release: async () => {
      listeners.clear();
      await handle.close({ finalDrain: true }).catch(() => undefined);
    },
    getTailCursor: () => tailCursor,
    subscribeToTranscriptUpdates: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
}

export function createCodexExternalSessionTranscriptStoreAdapter(
  params: ExternalSessionRuntimeHostAdapterParamsV1,
): ExternalSessionTranscriptStoreAdapterV1 {
  return Object.freeze({
    agentId: 'codex',
    getActivity: async (input) => (await resolveCodexTranscriptMetadata({
      source: input.source,
      activeServerDir: params.activeServerDir,
      env: params.env,
      exec: params.exec,
      remoteSessionId: normalizeProviderSessionId(input),
    })).activity,
    page: async (input) => await pageCodexTranscript({
      source: input.source,
      activeServerDir: params.activeServerDir,
      env: params.env,
      exec: params.exec,
      remoteSessionId: normalizeProviderSessionId(input),
      direction: input.direction,
      cursor: input.cursor,
      maxBytes: input.maxBytes,
      maxItems: input.maxItems,
    }),
    readAfter: async (input) => await readAfterCodexTranscript({
      source: input.source,
      activeServerDir: params.activeServerDir,
      env: params.env,
      remoteSessionId: normalizeProviderSessionId(input),
      cursor: input.cursor,
      maxBytes: input.maxBytes,
      maxItems: input.maxItems,
    }),
    acquireFollowLease: async (input) => await acquireFollowLease({
      request: input,
      activeServerDir: params.activeServerDir,
      env: params.env,
      exec: params.exec,
      fileFollow: params.fileFollow,
    }),
    resolveFollowTranscriptPath: async (input): Promise<ExternalSessionFollowTranscriptPathResolutionV1> => {
      const metadata = await resolveCodexTranscriptMetadata({
        source: input.source,
        activeServerDir: params.activeServerDir,
        env: params.env,
        exec: params.exec,
        remoteSessionId: input.providerSessionId,
      });
      if (!metadata.primaryRolloutFilePath) {
        throw new Error(`Codex external-session transcript file not found for ${input.providerSessionId}`);
      }
      return { path: metadata.primaryRolloutFilePath, sourceId: input.providerSessionId };
    },
    getWorkingDirectory: async (input) => (await resolveCodexTranscriptMetadata({
      source: input.source,
      activeServerDir: params.activeServerDir,
      env: params.env,
      exec: params.exec,
      remoteSessionId: normalizeProviderSessionId(input),
    })).workingDirectory,
    getProviderHome: async (input) => await resolveProviderHome({
      source: input.source,
      activeServerDir: params.activeServerDir,
      env: params.env,
      remoteSessionId: normalizeProviderSessionId(input),
    }),
  });
}
