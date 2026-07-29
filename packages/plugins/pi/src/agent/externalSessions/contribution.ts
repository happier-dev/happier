import { createHash, randomUUID } from 'node:crypto';
import type { Dir } from 'node:fs';
import { lstat, opendir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  AgentExternalSessionCandidate,
  AgentExternalSessionLinkData,
  AgentExternalSessionLinkDataValue,
  AgentExternalSessionSource,
  AgentExternalSessionTranscriptItem,
  AgentExternalSessionsContribution,
  AgentExternalSessionsFailureCode,
  AgentExternalSessionsInvocation,
  AgentExternalSessionsListCandidatesResult,
  AgentExternalSessionsReadAfterTranscriptResult,
  AgentExternalSessionsResult,
  AgentExternalSessionsTranscriptPage,
} from '@happier-dev/plugin-sdk/experimental/sessions';
import {
  canonicalizePath,
  canonicalizePathSync,
  isRecord,
  parseTimestampMs,
  readJsonlFileBackwardPage,
  readJsonlFileForward,
  resolveSessionFileStoreDirsSync,
  scanJsonlSessionFile,
} from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';

import { buildPiAgentRuntimeDescriptorV1 } from '../../protocol/runtimeDescriptorV1.js';
import { PI_SESSION_FILE_STORE_DESCRIPTOR_V1 } from '../sessionFileStoreDescriptor.js';
import {
  formatPiExternalSessionFileGeneration,
  isPiSessionFileInside,
} from './files.js';
import {
  foldPiV3SessionTree,
  type PiV3SessionTreeEntry,
} from '../transcripts/sessionFormat.js';

type PiCandidateCursorV2 = Readonly<{
  v: 2;
  kind: 'piCandidateIndexScan';
  sourceKey: string;
  sourceGeneration: string;
  scanId: string;
  scanned: number;
}>;

type PiTranscriptCursorV2 = Readonly<{
  v: 2;
  kind: 'piTranscript';
  sessionFile: string;
  sourceGeneration: string;
  endOffsetBytes: number;
  activeLeafId: string | null;
  activeLeafFingerprint: string | null;
}>;

type ResolvedPiSource = Readonly<{
  agentDir: string;
  sessionsRoot: string;
  source: AgentExternalSessionSource;
}>;

type ResolvedPiSessionFile = Readonly<{
  filePath: string;
  fileSize: number;
  sourceGeneration: string;
}>;

function buildPiExternalSessionLinkData(params: Readonly<{
  remoteSessionId: string;
  sessionFile: string;
}>): AgentExternalSessionLinkData {
  const runtimeDescriptorV1 = buildPiAgentRuntimeDescriptorV1({
    resumeStrategy: 'sessionFileAbsolutePreferred',
    providerSessionId: params.remoteSessionId,
    sessionFile: params.sessionFile,
  });
  if (!isLinkDataValue(runtimeDescriptorV1, new Set())) {
    throw new Error('Pi runtime descriptor is not valid external-session link data.');
  }
  return {
    sessionFile: params.sessionFile,
    runtimeDescriptorV1,
  };
}

function ok<T>(value: T): AgentExternalSessionsResult<T> {
  return { ok: true, value };
}

function failed(
  code: AgentExternalSessionsFailureCode,
  message: string,
  retryable?: boolean,
): AgentExternalSessionsResult<never> {
  return {
    ok: false,
    code,
    message,
    ...(retryable === undefined ? {} : { retryable }),
  };
}

function invocationFailure(
  invocation: AgentExternalSessionsInvocation,
): AgentExternalSessionsResult<never> | null {
  if (invocation.signal.aborted) {
    return failed('cancelled', 'Pi external-session operation was cancelled.');
  }
  if (Date.now() >= invocation.deadlineAtMs) {
    return failed('timeout', 'Pi external-session operation exceeded its deadline.', true);
  }
  if (!Number.isFinite(invocation.maxSerializedBytes) || invocation.maxSerializedBytes < 1) {
    return failed('invalid_request', 'Pi external-session result byte bound must be positive.');
  }
  return null;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function encodeCursor(value: PiCandidateCursorV2 | PiTranscriptCursorV2): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursorRecord(raw: string | null | undefined): Record<string, unknown> | null {
  if (!readOptionalString(raw)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw as string, 'base64url').toString('utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function decodeCandidateCursor(raw: string | undefined): PiCandidateCursorV2 | null {
  const record = decodeCursorRecord(raw);
  if (
    !record
    || record.v !== 2
    || record.kind !== 'piCandidateIndexScan'
    || !readOptionalString(record.sourceKey)
    || !readOptionalString(record.sourceGeneration)
    || !readOptionalString(record.scanId)
    || !Number.isSafeInteger(record.scanned)
    || (record.scanned as number) < 0
  ) {
    return null;
  }
  return {
    v: 2,
    kind: 'piCandidateIndexScan',
    sourceKey: String(record.sourceKey),
    sourceGeneration: String(record.sourceGeneration),
    scanId: String(record.scanId),
    scanned: record.scanned as number,
  };
}

function decodeTranscriptCursor(raw: string | undefined): PiTranscriptCursorV2 | null {
  const record = decodeCursorRecord(raw);
  const sessionFile = readOptionalString(record?.sessionFile);
  const sourceGeneration = readOptionalString(record?.sourceGeneration);
  const endOffsetBytes = record?.endOffsetBytes;
  const activeLeafId = record?.activeLeafId;
  const activeLeafFingerprint = record?.activeLeafFingerprint;
  if (
    !record
    || record.v !== 2
    || record.kind !== 'piTranscript'
    || !sessionFile
    || !sourceGeneration
    || typeof endOffsetBytes !== 'number'
    || !Number.isFinite(endOffsetBytes)
    || endOffsetBytes < 0
    || (activeLeafId !== null && typeof activeLeafId !== 'string')
    || (
      activeLeafFingerprint !== null
      && typeof activeLeafFingerprint !== 'string'
    )
  ) {
    return null;
  }
  return {
    v: 2,
    kind: 'piTranscript',
    sessionFile,
    sourceGeneration,
    endOffsetBytes: Math.trunc(endOffsetBytes),
    activeLeafId,
    activeLeafFingerprint,
  };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function resultFits(value: unknown, maxSerializedBytes: number): boolean {
  return serializedBytes(value) <= maxSerializedBytes;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isLinkDataValue(
  value: unknown,
  ancestors: ReadonlySet<object>,
): value is AgentExternalSessionLinkDataValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isLinkDataValue(entry, nextAncestors));
  }
  if (!isPlainObject(value) || Reflect.ownKeys(value).some((key) => typeof key !== 'string')) return false;
  return Object.values(value).every((entry) => isLinkDataValue(entry, nextAncestors));
}

function isLinkData(value: unknown): value is AgentExternalSessionLinkData {
  return isPlainObject(value)
    && Reflect.ownKeys(value).every((key) => typeof key === 'string')
    && Object.values(value).every((entry) => isLinkDataValue(entry, new Set([value])));
}

function sourceKey(source: Pick<ResolvedPiSource, 'agentDir'>): string {
  return source.agentDir;
}

function resolvePiSource(params: Readonly<{
  source: AgentExternalSessionSource;
  env: NodeJS.ProcessEnv;
}>): AgentExternalSessionsResult<ResolvedPiSource> {
  if (params.source.kind !== 'piAgentDir') {
    return failed('source_invalid', 'agent/source mismatch');
  }
  const configured = resolveSessionFileStoreDirsSync({
    product: PI_SESSION_FILE_STORE_DESCRIPTOR_V1,
    env: params.env,
  });
  const requestedAgentDir = readOptionalString(params.source.agentDir);
  const canonicalRequestedAgentDir = requestedAgentDir
    ? canonicalizePathSync(requestedAgentDir)
    : configured.agentDir;
  if (canonicalRequestedAgentDir !== configured.agentDir) {
    return failed('source_invalid', 'source agentDir override is not allowed');
  }
  const sessionFile = readOptionalString(params.source.sessionFile);
  const canonicalSessionFile = sessionFile ? canonicalizePathSync(sessionFile) : null;
  return ok({
    agentDir: configured.agentDir,
    sessionsRoot: configured.sessionsRoot,
    source: {
      kind: 'piAgentDir',
      agentDir: configured.agentDir,
      ...(canonicalSessionFile ? { sessionFile: canonicalSessionFile } : {}),
    },
  });
}

async function readPiV3Header(params: Readonly<{
  filePath: string;
  maxBytes: number;
}>): Promise<Readonly<{ sessionId: string; createdAtMs: number | null }> | null> {
  const page = await readJsonlFileForward({
    filePath: params.filePath,
    offsetBytes: 0,
    maxBytes: params.maxBytes,
    maxItems: 1,
    maxOversizeLineBytes: params.maxBytes,
  });
  const header = page.items[0]?.value;
  if (!isRecord(header) || header.type !== 'session' || header.version !== 3) return null;
  const sessionId = readOptionalString(header.id);
  if (!sessionId) return null;
  return {
    sessionId,
    createdAtMs: parseTimestampMs(header.timestamp),
  };
}

async function canonicalizePiSessionFile(params: Readonly<{
  source: ResolvedPiSource;
  filePath: string;
  remoteSessionId: string;
  maxBytes: number;
}>): Promise<ResolvedPiSessionFile | null> {
  const canonicalSessionsRoot = await canonicalizePath(params.source.sessionsRoot);
  const canonicalFilePath = await canonicalizePath(params.filePath);
  if (!isPiSessionFileInside(canonicalSessionsRoot, canonicalFilePath)) return null;

  const fileMetadata = await lstat(canonicalFilePath).catch(() => null);
  if (!fileMetadata?.isFile() || fileMetadata.isSymbolicLink()) return null;
  const header = await readPiV3Header({
    filePath: canonicalFilePath,
    maxBytes: params.maxBytes,
  });
  if (!header || header.sessionId !== params.remoteSessionId) return null;
  const fileStat = await stat(canonicalFilePath).catch(() => null);
  if (!fileStat?.isFile()) return null;
  const sourceGeneration = formatPiExternalSessionFileGeneration(header.sessionId, fileStat);
  return {
    filePath: canonicalFilePath,
    fileSize: Math.max(0, Math.trunc(fileStat.size)),
    sourceGeneration,
  };
}

type PiCandidateDirectory = Readonly<{
  path: string;
  generation: string;
  handle: Dir;
}>;

type PiCandidateScanState = {
  readonly scanId: string;
  readonly sourceKey: string;
  readonly sourceGeneration: string;
  readonly sessionsRoot: string;
  readonly searchTerm: string;
  readonly rootDirectory: Dir | null;
  readonly rootGenerations: Map<string, string>;
  currentDirectory: PiCandidateDirectory | null;
  pendingCandidate: AgentExternalSessionCandidate | null;
  pendingFilePath: string | null;
  scanned: number;
  complete: boolean;
  inFlight: boolean;
  retired: boolean;
  closeStarted: boolean;
};

const MAX_ACTIVE_CANDIDATE_SCANS = 16;

class PiCandidateSourceChangedError extends Error {
  readonly name = 'PiCandidateSourceChangedError';
}

async function readDirectoryGeneration(path: string): Promise<string | null> {
  const metadata = await stat(path, { bigint: true }).catch(() => null);
  if (!metadata?.isDirectory()) return null;
  return [
    metadata.dev,
    metadata.ino,
    metadata.birthtimeNs,
    metadata.mtimeNs,
    metadata.ctimeNs,
  ].join(':');
}

async function closeDirectory(directory: Dir | null): Promise<void> {
  await directory?.close().catch(() => undefined);
}

async function closeCandidateScan(state: PiCandidateScanState | null): Promise<void> {
  if (!state) return;
  await Promise.all([
    closeDirectory(state.rootDirectory),
    closeDirectory(state.currentDirectory?.handle ?? null),
  ]);
  state.currentDirectory = null;
}

async function createCandidateScan(
  source: ResolvedPiSource,
  searchTerm: string,
): Promise<PiCandidateScanState> {
  const sourceGeneration = await readDirectoryGeneration(source.sessionsRoot) ?? `missing:${source.sessionsRoot}`;
  return {
    scanId: randomUUID(),
    sourceKey: sourceKey(source),
    sourceGeneration,
    sessionsRoot: source.sessionsRoot,
    searchTerm,
    rootDirectory: await opendir(source.sessionsRoot).catch(() => null),
    rootGenerations: new Map(),
    currentDirectory: null,
    pendingCandidate: null,
    pendingFilePath: null,
    scanned: 0,
    complete: false,
    inFlight: false,
    retired: false,
    closeStarted: false,
  };
}

async function validateCandidateScan(state: PiCandidateScanState): Promise<void> {
  const sourceGeneration = await readDirectoryGeneration(state.sessionsRoot) ?? `missing:${state.sessionsRoot}`;
  if (sourceGeneration !== state.sourceGeneration) {
    throw new PiCandidateSourceChangedError(
      'Pi candidate source changed during its bounded scan.',
    );
  }
  for (const [path, expectedGeneration] of state.rootGenerations) {
    const generation = await readDirectoryGeneration(path);
    if (generation !== expectedGeneration) {
      throw new PiCandidateSourceChangedError(
        'Pi candidate session root changed while scanning or paging.',
      );
    }
  }
}

type PiCandidateChunkBudget = {
  rootEntries: number;
  fileEntries: number;
  readonly limit: number;
};

async function nextCandidateFile(
  state: PiCandidateScanState,
  budget: PiCandidateChunkBudget,
  signal: AbortSignal,
): Promise<string | null> {
  while (!state.complete && budget.fileEntries < budget.limit) {
    signal.throwIfAborted();
    if (state.currentDirectory) {
      const entry = await state.currentDirectory.handle.read();
      signal.throwIfAborted();
      if (!entry) {
        const finished = state.currentDirectory;
        const finalGeneration = await readDirectoryGeneration(finished.path);
        if (finalGeneration !== finished.generation) {
          throw new PiCandidateSourceChangedError(
            'Pi candidate session root changed during its bounded scan chunk.',
          );
        }
        await closeDirectory(finished.handle);
        state.currentDirectory = null;
        continue;
      }
      budget.fileEntries += 1;
      state.scanned += 1;
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.jsonl')) continue;
      return join(state.currentDirectory.path, entry.name);
    }

    if (!state.rootDirectory) {
      state.complete = true;
      break;
    }
    if (budget.rootEntries >= budget.limit) break;
    const entry = await state.rootDirectory.read();
    signal.throwIfAborted();
    if (!entry) {
      await closeDirectory(state.rootDirectory);
      state.complete = true;
      break;
    }
    budget.rootEntries += 1;
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(state.sessionsRoot, entry.name);
    const metadata = await lstat(path).catch(() => null);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) continue;
    const generation = await readDirectoryGeneration(path);
    if (!generation) continue;
    const handle = await opendir(path).catch(() => null);
    if (!handle) continue;
    state.rootGenerations.set(path, generation);
    state.currentDirectory = { path, generation, handle };
  }
  return null;
}

async function readLastRecordTimestampMs(params: Readonly<{
  filePath: string;
  maxBytes: number;
}>): Promise<number | null> {
  const tail = await readJsonlFileBackwardPage({
    filePath: params.filePath,
    endOffsetBytes: null,
    maxBytes: params.maxBytes,
    maxItems: 1,
    maxOversizeLineBytes: params.maxBytes,
  });
  const record = tail.items.at(-1)?.value;
  return isRecord(record) ? parseTimestampMs(record.timestamp) : null;
}

type PiTranscriptEntryProjection =
  | Readonly<{
      kind: 'item';
      item: AgentExternalSessionTranscriptItem;
    }>
  | Readonly<{ kind: 'known_non_transcript' }>
  | Readonly<{ kind: 'unsupported' }>;

function projectEntry(
  remoteSessionId: string,
  entry: PiV3SessionTreeEntry,
): PiTranscriptEntryProjection {
  if (entry.type === 'session_info') return { kind: 'known_non_transcript' };
  if (!isLinkData(entry.record)) return { kind: 'unsupported' };
  const message = isRecord(entry.record.message) ? entry.record.message : null;
  const messageRole = message?.role === 'user'
    ? 'user'
    : message?.role === 'assistant' || message?.role === 'toolResult'
      ? 'agent'
      : null;
  return {
    kind: 'item',
    item: {
      id: `pi:${remoteSessionId}:${entry.id}`,
      localId: `pi:${remoteSessionId}:${entry.id}`,
      createdAtMs: entry.timestampMs ?? 0,
      ...(messageRole ? { messageRole } : {}),
      raw: {
        format: 'pi-session-v3',
        record: entry.record,
      },
    },
  };
}

function projectBranch(
  remoteSessionId: string,
  entries: readonly PiV3SessionTreeEntry[],
): AgentExternalSessionTranscriptItem[] {
  return entries.flatMap((entry) => {
    const projected = projectEntry(remoteSessionId, entry);
    return projected.kind === 'item' ? [projected.item] : [];
  });
}

function fingerprintTreeEntry(entry: PiV3SessionTreeEntry): string {
  return createHash('sha256')
    .update(JSON.stringify(entry.record), 'utf8')
    .digest('base64url');
}

function encodeTranscriptCursor(params: Readonly<{
  file: ResolvedPiSessionFile;
  endOffsetBytes: number;
  activeLeafId: string | null;
  activeLeafFingerprint: string | null;
}>): string {
  return encodeCursor({
    v: 2,
    kind: 'piTranscript',
    sessionFile: params.file.filePath,
    sourceGeneration: params.file.sourceGeneration,
    endOffsetBytes: params.endOffsetBytes,
    activeLeafId: params.activeLeafId,
    activeLeafFingerprint: params.activeLeafFingerprint,
  });
}

async function readTranscriptCursorAnchor(params: Readonly<{
  file: ResolvedPiSessionFile;
  cursor: PiTranscriptCursorV2;
  maxBytes: number;
}>): Promise<Readonly<{
  records: readonly unknown[];
  matches: boolean;
}>> {
  const page = await readJsonlFileBackwardPage({
    filePath: params.file.filePath,
    endOffsetBytes: params.cursor.endOffsetBytes,
    maxBytes: params.maxBytes,
    maxItems: 1,
    maxOversizeLineBytes: params.maxBytes,
  });
  const records = page.items.map((item) => item.value);
  const folded = foldPiV3SessionTree(records);
  const activeLeaf = folded.activeBranch.at(-1) ?? null;
  const matches = params.cursor.activeLeafId === null
    ? activeLeaf === null && params.cursor.activeLeafFingerprint === null
    : (
      activeLeaf?.id === params.cursor.activeLeafId
      && params.cursor.activeLeafFingerprint !== null
      && fingerprintTreeEntry(activeLeaf) === params.cursor.activeLeafFingerprint
    );
  return { records, matches };
}

async function readCurrentTail(params: Readonly<{
  file: ResolvedPiSessionFile;
  maxBytes: number;
}>): Promise<Readonly<{
  cursor: string;
  activeLeafId: string | null;
  activeLeafFingerprint: string | null;
}>> {
  const tail = await readJsonlFileBackwardPage({
    filePath: params.file.filePath,
    endOffsetBytes: params.file.fileSize,
    maxBytes: params.maxBytes,
    maxItems: 1,
    maxOversizeLineBytes: params.maxBytes,
  });
  const folded = foldPiV3SessionTree(tail.items.map((item) => item.value));
  const activeLeaf = folded.activeBranch.at(-1) ?? null;
  const activeLeafFingerprint = activeLeaf
    ? fingerprintTreeEntry(activeLeaf)
    : null;
  return {
    activeLeafId: folded.activeLeafId,
    activeLeafFingerprint,
    cursor: encodeTranscriptCursor({
      file: params.file,
      endOffsetBytes: params.file.fileSize,
      activeLeafId: folded.activeLeafId,
      activeLeafFingerprint,
    }),
  };
}

function readSessionFileFromIdentity(
  source: AgentExternalSessionSource,
  linkData?: AgentExternalSessionLinkData,
): string | null {
  const sourceFile = readOptionalString(source.sessionFile);
  const linkFile = readOptionalString(linkData?.sessionFile);
  if (sourceFile && linkFile && canonicalizePathSync(sourceFile) !== canonicalizePathSync(linkFile)) {
    return null;
  }
  return linkFile ?? sourceFile;
}

export function createPiExternalSessionsContribution(params: Readonly<{
  env?: NodeJS.ProcessEnv;
}> = {}): AgentExternalSessionsContribution {
  const readEnv = () => params.env ?? process.env;
  const candidateScansById = new Map<string, PiCandidateScanState>();

  function isLiveCandidateScan(scan: PiCandidateScanState): boolean {
    return !scan.retired && candidateScansById.get(scan.scanId) === scan;
  }

  async function closeCandidateScanOnce(scan: PiCandidateScanState): Promise<void> {
    if (scan.closeStarted) return;
    scan.closeStarted = true;
    await closeCandidateScan(scan);
  }

  async function retireCandidateScan(scan: PiCandidateScanState | null): Promise<void> {
    if (!scan) return;
    if (!scan.retired) {
      if (candidateScansById.get(scan.scanId) === scan) {
        candidateScansById.delete(scan.scanId);
      }
      scan.retired = true;
    }
    if (!scan.inFlight) await closeCandidateScanOnce(scan);
  }

  async function releaseCandidateScan(scan: PiCandidateScanState): Promise<void> {
    scan.inFlight = false;
    if (scan.retired) await closeCandidateScanOnce(scan);
  }

  async function startCandidateScan(
    source: ResolvedPiSource,
    searchTerm: string,
  ): Promise<PiCandidateScanState> {
    const scan = await createCandidateScan(source, searchTerm);
    while (candidateScansById.size >= MAX_ACTIVE_CANDIDATE_SCANS) {
      const oldest = candidateScansById.values().next().value ?? null;
      await retireCandidateScan(oldest);
    }
    candidateScansById.set(scan.scanId, scan);
    return scan;
  }

  return Object.freeze({
    resolveSource(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      const resolved = resolvePiSource({ source: request.source, env: readEnv() });
      return resolved.ok ? ok({ source: resolved.value.source }) : resolved;
    },

    async listCandidates(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      if (!Number.isFinite(request.maxItems) || request.maxItems < 1) {
        return failed('invalid_request', 'Pi external-session candidate limit must be positive.');
      }
      const resolved = resolvePiSource({ source: request.source, env: readEnv() });
      if (!resolved.ok) return resolved;
      const searchTerm = readOptionalString(request.searchTerm)?.toLowerCase() ?? '';
      const decodedCursor = request.cursor ? decodeCandidateCursor(request.cursor) : null;
      if (request.cursor && (!decodedCursor || decodedCursor.sourceKey !== sourceKey(resolved.value))) {
        return failed('invalid_request', 'Pi candidate cursor does not match the resolved source.');
      }

      let scan: PiCandidateScanState | null = null;
      let admitted = false;
      try {
        if (!decodedCursor) {
          scan = await startCandidateScan(resolved.value, searchTerm);
        } else {
          scan = candidateScansById.get(decodedCursor.scanId) ?? null;
        }
        if (
          !scan
          || scan.inFlight
          || !isLiveCandidateScan(scan)
        ) {
          return failed(
            'source_invalid',
            'Pi candidate cursor source generation is stale or unavailable.',
            true,
          );
        }
        scan.inFlight = true;
        admitted = true;
        if (
          decodedCursor
          && (
            decodedCursor.sourceGeneration !== scan.sourceGeneration
            || decodedCursor.scanned !== scan.scanned
            || scan.sourceKey !== sourceKey(resolved.value)
            || scan.searchTerm !== searchTerm
          )
        ) {
          return failed(
            'source_invalid',
            'Pi candidate cursor source generation is stale or unavailable.',
            true,
          );
        }

        await validateCandidateScan(scan);
        if (!isLiveCandidateScan(scan)) {
          return failed(
            'source_invalid',
            'Pi candidate cursor source generation is stale or unavailable.',
            true,
          );
        }
        const limit = Math.trunc(request.maxItems);
        const hasPendingEntry = scan.pendingCandidate !== null || scan.pendingFilePath !== null;
        const budget: PiCandidateChunkBudget = {
          rootEntries: 0,
          fileEntries: hasPendingEntry ? 1 : 0,
          limit,
        };
        const candidates: AgentExternalSessionCandidate[] = [];
        if (scan.pendingCandidate) {
          candidates.push(scan.pendingCandidate);
          scan.pendingCandidate = null;
        }
        let pendingFilePath = scan.pendingFilePath;
        if (pendingFilePath) {
          scan.pendingFilePath = null;
          scan.scanned += 1;
        }

        while (pendingFilePath || budget.fileEntries < limit) {
          request.signal.throwIfAborted();
          const filePath = pendingFilePath ?? await nextCandidateFile(scan, budget, request.signal);
          pendingFilePath = null;
          if (!filePath) break;
          const header = await readPiV3Header({
            filePath,
            maxBytes: request.maxSerializedBytes,
          });
          if (header?.createdAtMs == null) continue;
          const scanned = await scanJsonlSessionFile(filePath, {
            headBytes: request.maxSerializedBytes,
            tailBytes: request.maxSerializedBytes,
            fullScanLineLimit: request.maxItems,
          });
          if (!scanned || scanned.sessionId !== header.sessionId) continue;
          const haystack = `${scanned.sessionId} ${scanned.title ?? ''} ${scanned.cwd ?? ''}`.toLowerCase();
          if (searchTerm && !haystack.includes(searchTerm)) continue;
          const lastRecordTimestampMs = await readLastRecordTimestampMs({
            filePath,
            maxBytes: request.maxSerializedBytes,
          });
          const candidate: AgentExternalSessionCandidate = {
            remoteSessionId: scanned.sessionId,
            ...(scanned.title ? { title: scanned.title } : {}),
            updatedAtMs: Math.max(header.createdAtMs, lastRecordTimestampMs ?? header.createdAtMs),
            createdAtMs: header.createdAtMs,
            linkData: { sessionFile: filePath },
          };
          if (!isLiveCandidateScan(scan)) {
            return failed(
              'source_invalid',
              'Pi candidate cursor source generation is stale or unavailable.',
              true,
            );
          }
          const nextCursor = encodeCursor({
            v: 2,
            kind: 'piCandidateIndexScan',
            sourceKey: scan.sourceKey,
            sourceGeneration: scan.sourceGeneration,
            scanId: scan.scanId,
            scanned: scan.scanned,
          });
          const proposed = ok({
            candidates: [...candidates, candidate],
            nextCursor,
            ...(searchTerm ? { searchIncomplete: true } : {}),
          });
          if (!resultFits(proposed, request.maxSerializedBytes)) {
            if (candidates.length === 0) {
              await retireCandidateScan(scan);
              return failed('invalid_request', 'Pi candidate result byte budget cannot fit one candidate.');
            }
            scan.pendingCandidate = candidate;
            break;
          }
          candidates.push(candidate);
        }

        if (!scan.complete && !scan.pendingCandidate && !scan.pendingFilePath) {
          const peekBudget: PiCandidateChunkBudget = {
            rootEntries: budget.rootEntries,
            fileEntries: budget.fileEntries,
            limit: limit + 1,
          };
          const nextFilePath = await nextCandidateFile(scan, peekBudget, request.signal);
          if (nextFilePath) {
            scan.pendingFilePath = nextFilePath;
            scan.scanned -= 1;
          }
        }
        await validateCandidateScan(scan);
        if (!isLiveCandidateScan(scan)) {
          return failed(
            'source_invalid',
            'Pi candidate cursor source generation is stale or unavailable.',
            true,
          );
        }
        const after = invocationFailure(request);
        if (after) {
          await retireCandidateScan(scan);
          return after;
        }
        const hasMore = !scan.complete || scan.pendingCandidate !== null || scan.pendingFilePath !== null;
        const nextCursor = hasMore
          ? encodeCursor({
            v: 2,
            kind: 'piCandidateIndexScan',
            sourceKey: scan.sourceKey,
            sourceGeneration: scan.sourceGeneration,
            scanId: scan.scanId,
            scanned: scan.scanned,
          })
          : null;
        const value: AgentExternalSessionsListCandidatesResult = {
          candidates,
          nextCursor,
          ...(searchTerm && hasMore ? { searchIncomplete: true } : {}),
        };
        const result = ok(value);
        if (!resultFits(result, request.maxSerializedBytes)) {
          await retireCandidateScan(scan);
          return failed('invalid_request', 'Pi candidate result byte budget cannot fit the page envelope.');
        }
        if (!hasMore) await retireCandidateScan(scan);
        return result;
      } catch (error) {
        if (scan?.retired || (scan && !isLiveCandidateScan(scan))) {
          return failed(
            'source_invalid',
            'Pi candidate cursor source generation is stale or unavailable.',
            true,
          );
        }
        const after = invocationFailure(request);
        if (after) {
          await retireCandidateScan(scan);
          return after;
        }
        if (error instanceof PiCandidateSourceChangedError) {
          await retireCandidateScan(scan);
          return failed('source_invalid', error.message, true);
        }
        await retireCandidateScan(scan);
        return failed(
          'agent_unavailable',
          error instanceof Error ? error.message : 'Pi external-session listing failed.',
          true,
        );
      } finally {
        if (admitted && scan) await releaseCandidateScan(scan);
      }
    },

    async resolveLinkIdentity(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      const resolved = resolvePiSource({ source: request.source, env: readEnv() });
      if (!resolved.ok) return resolved;
      const requestedFile = readSessionFileFromIdentity(request.source, request.linkData);
      if (!requestedFile) {
        return failed('candidate_not_found', 'Pi external-session link requires a source-qualified session file.');
      }
      const file = await canonicalizePiSessionFile({
        source: resolved.value,
        filePath: requestedFile,
        remoteSessionId: request.remoteSessionId,
        maxBytes: request.maxSerializedBytes,
      }).catch(() => null);
      const after = invocationFailure(request);
      if (after) return after;
      if (!file) return failed('candidate_not_found', 'Pi external-session candidate was not found.');
      return ok({
        source: {
          ...resolved.value.source,
          sessionFile: file.filePath,
        },
        remoteSessionId: request.remoteSessionId,
        linkData: buildPiExternalSessionLinkData({
          remoteSessionId: request.remoteSessionId,
          sessionFile: file.filePath,
        }),
      });
    },

    async resolveLinkedIdentity(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      const resolved = resolvePiSource({ source: request.source, env: readEnv() });
      if (!resolved.ok) return resolved;
      const requestedFile = readSessionFileFromIdentity(request.source, request.linkData);
      if (!requestedFile) {
        return failed('invalid_request', 'Pi linked identity requires a source-qualified session file.');
      }
      const file = await canonicalizePiSessionFile({
        source: resolved.value,
        filePath: requestedFile,
        remoteSessionId: request.remoteSessionId,
        maxBytes: request.maxSerializedBytes,
      }).catch(() => null);
      const after = invocationFailure(request);
      if (after) return after;
      if (!file) return failed('unavailable', 'Pi linked session file is unavailable.', true);
      return ok({
        source: {
          ...resolved.value.source,
          sessionFile: file.filePath,
        },
        remoteSessionId: request.remoteSessionId,
        linkData: buildPiExternalSessionLinkData({
          remoteSessionId: request.remoteSessionId,
          sessionFile: file.filePath,
        }),
      });
    },

    async pageTranscript(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      if (request.direction !== 'older') {
        return failed('unsupported', 'Pi transcript paging supports only older pages.');
      }
      if (!Number.isFinite(request.maxItems) || request.maxItems < 1) {
        return failed('invalid_request', 'Pi external-session transcript limit must be positive.');
      }
      const resolved = resolvePiSource({ source: request.source, env: readEnv() });
      if (!resolved.ok) return resolved;
      const requestedFile = readSessionFileFromIdentity(request.source);
      if (!requestedFile) return failed('invalid_request', 'Pi transcript source requires a session file.');
      const file = await canonicalizePiSessionFile({
        source: resolved.value,
        filePath: requestedFile,
        remoteSessionId: request.remoteSessionId,
        maxBytes: request.maxSerializedBytes,
      }).catch(() => null);
      if (!file) return failed('unavailable', 'Pi linked session file is unavailable.', true);

      const decodedCursor = request.cursor ? decodeTranscriptCursor(request.cursor) : null;
      if (request.cursor && (!decodedCursor || decodedCursor.sessionFile !== file.filePath)) {
        return failed('invalid_request', 'Pi transcript cursor does not match the resolved source.');
      }
      const sourceReplaced = Boolean(decodedCursor && decodedCursor.sourceGeneration !== file.sourceGeneration);
      const endOffsetBytes = sourceReplaced || !decodedCursor
        ? file.fileSize
        : Math.min(file.fileSize, decodedCursor.endOffsetBytes);
      const expectedLeafId = sourceReplaced ? undefined : decodedCursor?.activeLeafId;
      const page = await readJsonlFileBackwardPage({
        filePath: file.filePath,
        endOffsetBytes,
        maxBytes: request.maxSerializedBytes,
        maxItems: Math.trunc(request.maxItems),
        maxOversizeLineBytes: request.maxSerializedBytes,
      });
      const afterPage = invocationFailure(request);
      if (afterPage) return afterPage;
      if (page.diagnostics?.some((diagnostic) => diagnostic.code === 'malformed_source_utf8')) {
        return failed('agent_error', 'Pi transcript source contains malformed UTF-8.');
      }
      const values = page.items.map((item) => item.value);
      const expectedLeafPresent = expectedLeafId === undefined
        || expectedLeafId === null
        || values.some((value) => isRecord(value) && value.id === expectedLeafId);
      const folded = foldPiV3SessionTree(values, {
        ...(expectedLeafId === undefined ? {} : { activeLeafId: expectedLeafId }),
      });
      const items = expectedLeafPresent
        ? projectBranch(request.remoteSessionId, folded.activeBranch)
        : [];
      const earliest = expectedLeafPresent ? folded.activeBranch[0] ?? null : null;
      const nextActiveLeafId = expectedLeafPresent
        ? earliest?.parentId ?? null
        : expectedLeafId ?? null;
      const hasMore = Boolean(nextActiveLeafId) && !page.reachedStart;
      const nextCursor = hasMore
        ? encodeTranscriptCursor({
          file,
          endOffsetBytes: page.nextEndOffsetBytes,
          activeLeafId: nextActiveLeafId,
          activeLeafFingerprint: null,
        })
        : null;
      const tail = request.cursor && !sourceReplaced
        ? null
        : await readCurrentTail({ file, maxBytes: request.maxSerializedBytes });
      const afterTail = invocationFailure(request);
      if (afterTail) return afterTail;
      const result: AgentExternalSessionsResult<AgentExternalSessionsTranscriptPage> = ok({
        items,
        nextCursor,
        ...(tail ? { tailCursor: tail.cursor } : {}),
        hasMore,
        ...(sourceReplaced || (!expectedLeafPresent && page.reachedStart) ? { truncated: true } : {}),
      });
      return resultFits(result, request.maxSerializedBytes)
        ? result
        : failed('invalid_request', 'Pi transcript result byte budget cannot fit the page envelope.');
    },

    async readAfterTranscript(request) {
      const stopped = invocationFailure(request);
      if (stopped) return stopped;
      if (!Number.isFinite(request.maxItems) || request.maxItems < 1) {
        return failed('invalid_request', 'Pi external-session transcript limit must be positive.');
      }
      const resolved = resolvePiSource({ source: request.source, env: readEnv() });
      if (!resolved.ok) return resolved;
      const requestedFile = readSessionFileFromIdentity(request.source);
      if (!requestedFile) return failed('invalid_request', 'Pi transcript source requires a session file.');
      const file = await canonicalizePiSessionFile({
        source: resolved.value,
        filePath: requestedFile,
        remoteSessionId: request.remoteSessionId,
        maxBytes: request.maxSerializedBytes,
      }).catch(() => null);
      if (!file) return ok({ outcome: 'source_unavailable' });
      const cursor = decodeTranscriptCursor(request.cursor);
      if (!cursor || cursor.sessionFile !== file.filePath) {
        return ok({ outcome: 'source_replaced' });
      }
      if (
        cursor.sourceGeneration !== file.sourceGeneration
        || cursor.endOffsetBytes > file.fileSize
      ) {
        return ok({ outcome: 'source_replaced' });
      }
      const anchor = await readTranscriptCursorAnchor({
        file,
        cursor,
        maxBytes: request.maxSerializedBytes,
      });
      const afterAnchor = invocationFailure(request);
      if (afterAnchor) return afterAnchor;
      if (!anchor.matches) {
        return ok({ outcome: 'source_replaced' });
      }
      if (cursor.endOffsetBytes === file.fileSize) {
        return ok({ outcome: 'already_current' });
      }

      const page = await readJsonlFileForward({
        filePath: file.filePath,
        offsetBytes: cursor.endOffsetBytes,
        maxBytes: request.maxSerializedBytes,
        maxItems: Math.trunc(request.maxItems),
        maxOversizeLineBytes: request.maxSerializedBytes,
      });
      const afterPage = invocationFailure(request);
      if (afterPage) return afterPage;
      const anchorAfterPage = await readTranscriptCursorAnchor({
        file,
        cursor,
        maxBytes: request.maxSerializedBytes,
      });
      const afterAnchorRecheck = invocationFailure(request);
      if (afterAnchorRecheck) return afterAnchorRecheck;
      if (!anchorAfterPage.matches) {
        return ok({ outcome: 'source_replaced' });
      }

      const folded = foldPiV3SessionTree([
        ...anchor.records,
        ...page.items.map((item) => item.value),
      ]);
      const previousLeafIndex = cursor.activeLeafId === null
        ? null
        : folded.activeBranch.findIndex((entry) => entry.id === cursor.activeLeafId);
      const previousLeaf = previousLeafIndex === null || previousLeafIndex < 0
        ? null
        : folded.activeBranch[previousLeafIndex] ?? null;
      if (
        (previousLeafIndex === null && folded.activeBranch[0]?.parentId !== null)
        || (previousLeafIndex !== null && previousLeafIndex < 0)
        || (
          previousLeaf !== null
          && (
            cursor.activeLeafFingerprint === null
            || fingerprintTreeEntry(previousLeaf) !== cursor.activeLeafFingerprint
          )
        )
      ) {
        return ok({ outcome: 'gap_or_cursor_expired' });
      }
      const newBranch = previousLeafIndex === null
        ? folded.activeBranch
        : folded.activeBranch.slice(previousLeafIndex + 1);
      const projectedBranch = newBranch.map((entry, index) => ({
        index,
        projected: projectEntry(request.remoteSessionId, entry),
      }));
      const items = projectedBranch.flatMap(({ projected }) => (
        projected.kind === 'item' ? [projected.item] : []
      ));
      const knownNonTranscriptPositions = projectedBranch
        .filter(({ projected }) => projected.kind === 'known_non_transcript')
        .map(({ index }) => index);
      const unsupportedPositions = projectedBranch
        .filter(({ projected }) => projected.kind === 'unsupported')
        .map(({ index }) => index);
      const diagnostics = [
        ...(page.diagnostics ?? []),
        ...(knownNonTranscriptPositions.length > 0
          ? [{
              code: 'non_transcript_record_skipped',
              count: knownNonTranscriptPositions.length,
              positions: knownNonTranscriptPositions.slice(0, 200),
            }]
          : []),
        ...(unsupportedPositions.length > 0
          ? [{
              code: 'unsupported_record_skipped',
              count: unsupportedPositions.length,
              positions: unsupportedPositions.slice(0, 200),
            }]
          : []),
      ];
      if (items.length === 0 && newBranch.length === 0) {
        return ok({ outcome: 'gap_or_cursor_expired' });
      }
      const nextActiveLeaf = folded.activeBranch.at(-1) ?? null;
      const nextCursor = encodeTranscriptCursor({
        file,
        endOffsetBytes: page.nextOffsetBytes,
        activeLeafId: nextActiveLeaf?.id ?? null,
        activeLeafFingerprint: nextActiveLeaf
          ? fingerprintTreeEntry(nextActiveLeaf)
          : null,
      });
      const result: AgentExternalSessionsResult<AgentExternalSessionsReadAfterTranscriptResult> = ok({
        outcome: 'advanced',
        items,
        nextCursor,
        boundary: nextActiveLeaf?.id ?? `offset:${page.nextOffsetBytes}`,
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
      });
      return resultFits(result, request.maxSerializedBytes)
        ? result
        : failed('invalid_request', 'Pi transcript result byte budget cannot fit the readAfter envelope.');
    },
  });
}

export const piExternalSessionsContribution = createPiExternalSessionsContribution();
