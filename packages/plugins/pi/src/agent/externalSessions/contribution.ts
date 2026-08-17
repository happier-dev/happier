import { createHash, randomUUID } from 'node:crypto';
import type { Dir } from 'node:fs';
import { lstat, opendir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  AgentExternalSessionLinkData,
  AgentExternalSessionLinkDataValue,
  AgentExternalSessionTranscriptItem,
  AgentExternalSessionTranscriptRawRecord,
  AgentExternalSessionsContribution,
  AgentExternalSessionsFailureCode,
  AgentExternalSessionsInvocation,
  AgentExternalSessionsResult,
} from '@happier-dev/plugin-sdk/sessions/external';
import { AgentExternalSessionTranscriptRawRecordSchema } from '@happier-dev/plugin-sdk/sessions/external';
import type {
  AgentExternalSessionCandidate,
  AgentExternalSessionSource,
  AgentExternalSessionsListCandidatesResult,
  AgentExternalSessionsReadAfterTranscriptResult,
  AgentExternalSessionsTranscriptPage,
} from '@happier-dev/plugin-sdk/sessions/external';
import {
  compareExternalSessionCandidatePrecedence,
  HAPPIER_BASE_SYSTEM_PROMPT_ATTACHMENTS_V1,
  HAPPIER_BASE_SYSTEM_PROMPT_LINKED_WORKSPACE_FILES_V1,
  HAPPIER_BASE_SYSTEM_PROMPT_OPTIONS_V1,
  HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1,
} from '@happier-dev/plugin-sdk/sessions/external';
import {
  canonicalizePath,
  canonicalizePathSync } from '@happier-dev/plugin-sdk/fs';
import {
  isRecord,
  parseTimestampMs } from '@happier-dev/plugin-sdk';
import {
  readJsonlFileBackwardPage,
  readJsonlFileForward,
  scanJsonlSessionFile,
} from '@happier-dev/plugin-sdk/sessions/file-stores';

import { buildPiAgentRuntimeDescriptorV1 } from '../../protocol/runtimeDescriptorV1.js';
import {
  formatPiExternalSessionFileGeneration,
  isPiSessionFileInside,
} from './files.js';
import {
  resolvePiExternalSessionSource,
  type ResolvedPiExternalSessionSource,
} from './source.js';
import {
  foldPiV3SessionTree,
  isPiV3SessionFileRecord,
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

type PiTranscriptOlderProjectionCursor = Readonly<{
  kind: 'older';
  nativeMaxItems: number;
  nativeMaxSerializedBytes: number;
  itemEnd: number;
  resumeEndOffsetBytes: number;
  resumeActiveLeafId: string | null;
}>;

type PiTranscriptAfterProjectionCursor = Readonly<{
  kind: 'after';
  nativeMaxItems: number;
  nativeMaxSerializedBytes: number;
  nextItemIndex: number;
  resumeEndOffsetBytes: number;
  resumeActiveLeafId: string | null;
  resumeActiveLeafFingerprint: string | null;
}>;

type PiTranscriptProjectionCursor =
  | PiTranscriptOlderProjectionCursor
  | PiTranscriptAfterProjectionCursor;

type PiTranscriptCursorV2 = Readonly<{
  v: 2;
  kind: 'piTranscript';
  sessionFile: string;
  sourceGeneration: string;
  endOffsetBytes: number;
  activeLeafId: string | null;
  activeLeafFingerprint: string | null;
  projection?: PiTranscriptProjectionCursor;
}>;

type ResolvedPiSource = ResolvedPiExternalSessionSource;

type ResolvedPiSessionFile = Readonly<{
  filePath: string;
  fileSize: number;
  sourceGeneration: string;
}>;

/**
 * Resolved link-identity link data.
 *
 * The host projects this record minus `source` straight into TOP-LEVEL session
 * owner metadata, whose strict allow-list rejects unknown keys. Only
 * `runtimeDescriptorV1` is an owner-metadata key, so the resolved session file
 * travels on `source.sessionFile` — the carrier every Pi read path already uses.
 */
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
  return { runtimeDescriptorV1 };
}

const PI_CANDIDATE_TITLE_MAX_CHARS = 120;
// Candidate precedence must not vary with the smaller link-result envelope.
// Keep the private inspection ceiling aligned with the established Browse
// maximum, while each public operation still enforces its own output bound.
const PI_CANDIDATE_INSPECTION_MAX_BYTES = 1_048_576;

/**
 * Happier prepends its own base system prompt to the first Pi user turn and Pi
 * persists that whole block as the first user message, so a title derived from it
 * would render a wall of instructions. Which block opens the preamble depends on
 * the session's prompt settings, so every opening the canonical producer can emit
 * disqualifies the message. Anchoring on the producer's own block headings — rather
 * than a hand-copied phrase list — keeps this honest as the prompt body evolves.
 */
const HAPPIER_BASE_SYSTEM_PROMPT_HEADINGS = [
  HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1,
  HAPPIER_BASE_SYSTEM_PROMPT_OPTIONS_V1,
  HAPPIER_BASE_SYSTEM_PROMPT_ATTACHMENTS_V1,
  HAPPIER_BASE_SYSTEM_PROMPT_LINKED_WORKSPACE_FILES_V1,
]
  .map((block) => (block.split('\n', 1)[0] ?? '').trim().toLowerCase())
  .filter((heading) => heading.length > 0);

/**
 * Pi never persists an agent-authored title, so a candidate's only title evidence
 * is the first user message the bounded session scan already returned.
 */
function formatPiCandidateTitle(value: string | null): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  const lowerNormalized = normalized.toLowerCase();
  if (HAPPIER_BASE_SYSTEM_PROMPT_HEADINGS.some((heading) => lowerNormalized.startsWith(heading))) {
    return null;
  }
  return normalized.length <= PI_CANDIDATE_TITLE_MAX_CHARS
    ? normalized
    : `${normalized.slice(0, PI_CANDIDATE_TITLE_MAX_CHARS - 3).trimEnd()}...`;
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

function encodeCursor(
  value: PiCandidateCursorV2 | PiTranscriptCursorV2,
): string {
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

function decodeTranscriptProjectionCursor(value: unknown): PiTranscriptProjectionCursor | null {
  if (!isRecord(value)) return null;
  const nativeMaxItems = value.nativeMaxItems;
  const nativeMaxSerializedBytes = value.nativeMaxSerializedBytes;
  const resumeEndOffsetBytes = value.resumeEndOffsetBytes;
  const resumeActiveLeafId = value.resumeActiveLeafId;
  if (
    typeof nativeMaxItems !== 'number'
    || !Number.isSafeInteger(nativeMaxItems)
    || nativeMaxItems < 1
    || typeof nativeMaxSerializedBytes !== 'number'
    || !Number.isSafeInteger(nativeMaxSerializedBytes)
    || nativeMaxSerializedBytes < 1
    || typeof resumeEndOffsetBytes !== 'number'
    || !Number.isSafeInteger(resumeEndOffsetBytes)
    || resumeEndOffsetBytes < 0
    || (resumeActiveLeafId !== null && typeof resumeActiveLeafId !== 'string')
  ) return null;
  if (value.kind === 'older') {
    const itemEnd = value.itemEnd;
    if (typeof itemEnd !== 'number' || !Number.isSafeInteger(itemEnd) || itemEnd < 1) return null;
    return {
      kind: 'older',
      nativeMaxItems,
      nativeMaxSerializedBytes,
      itemEnd,
      resumeEndOffsetBytes,
      resumeActiveLeafId,
    };
  }
  if (value.kind === 'after') {
    const nextItemIndex = value.nextItemIndex;
    const resumeActiveLeafFingerprint = value.resumeActiveLeafFingerprint;
    if (
      typeof nextItemIndex !== 'number'
      || !Number.isSafeInteger(nextItemIndex)
      || nextItemIndex < 1
      || (resumeActiveLeafFingerprint !== null && typeof resumeActiveLeafFingerprint !== 'string')
    ) return null;
    return {
      kind: 'after',
      nativeMaxItems,
      nativeMaxSerializedBytes,
      nextItemIndex,
      resumeEndOffsetBytes,
      resumeActiveLeafId,
      resumeActiveLeafFingerprint,
    };
  }
  return null;
}

function decodeTranscriptCursor(raw: string | undefined): PiTranscriptCursorV2 | null {
  const record = decodeCursorRecord(raw);
  const sessionFile = readOptionalString(record?.sessionFile);
  const sourceGeneration = readOptionalString(record?.sourceGeneration);
  const endOffsetBytes = record?.endOffsetBytes;
  const activeLeafId = record?.activeLeafId;
  const activeLeafFingerprint = record?.activeLeafFingerprint;
  const projection = record?.projection === undefined
    ? undefined
    : decodeTranscriptProjectionCursor(record.projection);
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
    || (record.projection !== undefined && !projection)
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
    ...(projection ? { projection } : {}),
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
  const resolved = resolvePiExternalSessionSource(params);
  return resolved
    ? ok(resolved)
    : failed('source_invalid', 'agent/source mismatch');
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
  hasEntries: boolean;
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

function candidateScanPreparation(
  scan: PiCandidateScanState,
  searchTerm: string,
): Readonly<{
  preparation?: Readonly<{
    kind: 'building_candidate_index';
    scanned: number;
  }>;
}> {
  if (searchTerm) return {};
  // A candidate that did not fit the prior response is re-emitted on the next
  // call. Do not report its file entry as indexed until that response carries
  // the candidate, otherwise the host's one index owner correctly sees a
  // non-advancing continuation.
  const scanned = Math.max(0, scan.scanned - (scan.pendingCandidate ? 1 : 0));
  return {
    preparation: { kind: 'building_candidate_index', scanned },
  };
}

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
        if (!finished.hasEntries) state.scanned += 1;
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
      state.currentDirectory = { ...state.currentDirectory, hasEntries: true };
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
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      state.scanned += 1;
      continue;
    }
    const path = join(state.sessionsRoot, entry.name);
    const metadata = await lstat(path).catch(() => null);
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
      state.scanned += 1;
      continue;
    }
    const generation = await readDirectoryGeneration(path);
    if (!generation) {
      state.scanned += 1;
      continue;
    }
    const handle = await opendir(path).catch(() => null);
    if (!handle) {
      state.scanned += 1;
      continue;
    }
    state.rootGenerations.set(path, generation);
    state.currentDirectory = { path, generation, handle, hasEntries: false };
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

async function inspectPiCandidateFile(params: Readonly<{
  filePath: string;
  fullScanLineLimit: number;
  searchTerm: string;
}>): Promise<AgentExternalSessionCandidate | null> {
  const header = await readPiV3Header({
    filePath: params.filePath,
    maxBytes: PI_CANDIDATE_INSPECTION_MAX_BYTES,
  });
  if (header?.createdAtMs == null) return null;
  const scanned = await scanJsonlSessionFile(params.filePath, {
    headBytes: PI_CANDIDATE_INSPECTION_MAX_BYTES,
    tailBytes: PI_CANDIDATE_INSPECTION_MAX_BYTES,
    fullScanLineLimit: params.fullScanLineLimit,
  });
  if (!scanned || scanned.sessionId !== header.sessionId) return null;
  const title = scanned.title ?? formatPiCandidateTitle(scanned.firstUserMessage);
  const haystack = `${scanned.sessionId} ${title ?? ''} ${scanned.cwd ?? ''}`.toLowerCase();
  if (params.searchTerm && !haystack.includes(params.searchTerm)) return null;
  const lastRecordTimestampMs = await readLastRecordTimestampMs({
    filePath: params.filePath,
    maxBytes: PI_CANDIDATE_INSPECTION_MAX_BYTES,
  });
  return {
    remoteSessionId: scanned.sessionId,
    ...(title ? { title } : {}),
    updatedAtMs: Math.max(header.createdAtMs, lastRecordTimestampMs ?? header.createdAtMs),
    createdAtMs: header.createdAtMs,
    linkData: { sessionFile: params.filePath },
  };
}

type PiTranscriptEntryProjection =
  | Readonly<{
      kind: 'item';
      items: readonly AgentExternalSessionTranscriptItem[];
    }>
  | Readonly<{ kind: 'known_non_transcript' }>
  | Readonly<{ kind: 'unsupported' }>;

const PI_ACP_AGENT_ID = 'pi';

type PiTranscriptRow = Readonly<{ id: string; raw: AgentExternalSessionTranscriptRawRecord }>;

/**
 * Admits one projected row into the canonical transcript raw-record contract.
 * The record is built here from Pi's own session file, so a value this rejects
 * is one no reader could parse; it is classified `unsupported` rather than
 * published as a row that renders as the unparsed-agent-message placeholder.
 */
function canonicalRaw(value: unknown): AgentExternalSessionTranscriptRawRecord | null {
  const parsed = AgentExternalSessionTranscriptRawRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Every Pi transcript row must leave this leaf inside the canonical
 * `TranscriptRawRecordV1` envelope (`{ role, content }`); anything else renders
 * as the unparsed-agent-message placeholder in every reader.
 */
function agentAcpRaw(data: AgentExternalSessionLinkData): AgentExternalSessionTranscriptRawRecord | null {
  return canonicalRaw({
    role: 'agent',
    content: {
      type: 'acp',
      agentId: PI_ACP_AGENT_ID,
      data,
    },
  });
}

function agentMessageRaw(message: string): AgentExternalSessionTranscriptRawRecord | null {
  return agentAcpRaw({ type: 'message', message });
}

function readPiBlockText(block: Record<string, unknown>, key: string): string | null {
  const value = block[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readPiTextContent(content: unknown): string | null {
  if (typeof content === 'string') return content.length > 0 ? content : null;
  if (!Array.isArray(content) || content.length === 0) return null;
  const text: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'text') return null;
    const value = readPiBlockText(block, 'text');
    if (!value) return null;
    text.push(value);
  }
  return text.join('');
}

/**
 * Projects one Pi message record into the canonical rows it actually carries.
 * A Pi assistant message routinely mixes thinking, text, and several tool calls
 * in a single record, so this is deliberately one-to-many. `null` means the
 * record carries a row the canonical contract cannot admit, so the whole entry
 * is reported unsupported instead of publishing a partial message.
 */
function projectPiMessageRows(
  message: Record<string, unknown>,
  buildRowId: (suffix: string | null) => string,
): readonly PiTranscriptRow[] | null {
  if (message.role === 'user') {
    const text = readPiTextContent(message.content);
    if (!text) return null;
    const raw = canonicalRaw({ role: 'user', content: { type: 'text', text } });
    return raw ? [{ id: buildRowId(null), raw }] : null;
  }

  if (message.role === 'toolResult') {
    const callId = readOptionalString(message.toolCallId);
    if (
      !callId
      || !isLinkDataValue(message.content, new Set())
      || (message.isError !== undefined && typeof message.isError !== 'boolean')
    ) return null;
    const id = buildRowId(null);
    const raw = agentAcpRaw({
      type: 'tool-result',
      callId,
      id,
      output: message.content,
      ...(typeof message.isError === 'boolean' ? { isError: message.isError } : {}),
    });
    return raw ? [{ id, raw }] : null;
  }

  if (message.role !== 'assistant') return null;

  const content = message.content;
  if (typeof content === 'string') {
    if (content.length === 0) return null;
    const raw = agentAcpRaw({ type: 'message', message: content });
    return raw ? [{ id: buildRowId('text:0'), raw }] : null;
  }
  if (!Array.isArray(content) || content.length === 0) return null;

  const rows: PiTranscriptRow[] = [];
  for (const [index, value] of content.entries()) {
    if (!isRecord(value)) return null;
    const blockType = readOptionalString(value.type);
    if (!blockType) return null;
    const id = buildRowId(`${blockType}:${index}`);

    if (blockType === 'text') {
      const text = readPiBlockText(value, 'text');
      if (!text) return null;
      const raw = agentAcpRaw({ type: 'message', message: text });
      if (!raw) return null;
      rows.push({ id, raw });
      continue;
    }
    if (blockType === 'thinking') {
      const thinking = readPiBlockText(value, 'thinking');
      if (!thinking) return null;
      const raw = agentAcpRaw({ type: 'thinking', text: thinking });
      if (!raw) return null;
      rows.push({ id, raw });
      continue;
    }
    if (blockType === 'toolCall') {
      const callId = readOptionalString(value.id);
      const name = readOptionalString(value.name);
      if (!callId || !name || !isLinkDataValue(value.arguments, new Set())) return null;
      const raw = agentAcpRaw({
        type: 'tool-call',
        callId,
        name,
        id,
        input: value.arguments,
      });
      if (!raw) return null;
      rows.push({ id, raw });
      continue;
    }
    return null;
  }
  return rows.length > 0 ? rows : null;
}

const PI_KNOWN_NON_TRANSCRIPT_ENTRY_TYPES = new Set([
  'session_info',
  'thinking_level_change',
  'model_change',
  'custom',
  'label',
]);

function isKnownNonTranscriptEntry(
  entry: PiV3SessionTreeEntry,
  record: Record<string, unknown>,
): boolean {
  if (!PI_KNOWN_NON_TRANSCRIPT_ENTRY_TYPES.has(entry.type)) return false;
  if (record.type !== entry.type) return false;
  switch (entry.type) {
    case 'session_info':
      return record.name === undefined || typeof record.name === 'string';
    case 'thinking_level_change':
      return typeof record.thinkingLevel === 'string';
    case 'model_change':
      return typeof record.provider === 'string' && typeof record.modelId === 'string';
    case 'custom':
      return typeof record.customType === 'string';
    case 'label':
      return typeof record.targetId === 'string'
        && (record.label === undefined || typeof record.label === 'string');
  }
  return false;
}

function projectEntry(
  remoteSessionId: string,
  entry: PiV3SessionTreeEntry,
): PiTranscriptEntryProjection {
  if (!isLinkData(entry.record)) return { kind: 'unsupported' };
  const record = entry.record;
  const baseId = `pi:${remoteSessionId}:${entry.id}`;
  const createdAtMs = entry.timestampMs ?? 0;
  const buildItem = (
    id: string,
    raw: AgentExternalSessionTranscriptRawRecord,
  ): AgentExternalSessionTranscriptItem => ({
    id,
    localId: id,
    createdAtMs,
    raw,
  });

  if (entry.type === 'message') {
    const message = isRecord(record.message) ? record.message : null;
    if (!message) return { kind: 'unsupported' };
    const rows = projectPiMessageRows(
      message,
      (suffix) => (suffix ? `${baseId}:${suffix}` : baseId),
    );
    if (rows === null) return { kind: 'unsupported' };
    return { kind: 'item', items: rows.map(({ id, raw }) => buildItem(id, raw)) };
  }

  if (entry.type === 'branch_summary') {
    const summary = readPiBlockText(record, 'summary');
    const fromId = readOptionalString(record.fromId);
    const raw = summary && fromId ? agentMessageRaw(summary) : null;
    return raw
      ? { kind: 'item', items: [buildItem(baseId, raw)] }
      : { kind: 'unsupported' };
  }
  if (entry.type === 'compaction') {
    const summary = readPiBlockText(record, 'summary');
    const firstKeptEntryId = readOptionalString(record.firstKeptEntryId);
    const tokensBefore = record.tokensBefore;
    if (
      !summary
      || !firstKeptEntryId
      || typeof tokensBefore !== 'number'
      || !Number.isFinite(tokensBefore)
      || tokensBefore < 0
    ) return { kind: 'unsupported' };
    const raw = agentAcpRaw({
      type: 'context-compaction',
      phase: 'completed',
      lifecycleId: `pi:${remoteSessionId}:${entry.id}`,
      trigger: 'unknown',
      source: 'runtime',
      tokenCountBefore: tokensBefore,
    });
    return raw
      ? { kind: 'item', items: [buildItem(baseId, raw)] }
      : { kind: 'unsupported' };
  }
  return isKnownNonTranscriptEntry(entry, record)
    ? { kind: 'known_non_transcript' }
    : { kind: 'unsupported' };
}

type PiTranscriptBranchProjection = Readonly<{
  items: readonly AgentExternalSessionTranscriptItem[];
  knownNonTranscriptPositions: readonly number[];
  unsupportedPositions: readonly number[];
}>;

function projectBranch(
  remoteSessionId: string,
  entries: readonly PiV3SessionTreeEntry[],
): PiTranscriptBranchProjection {
  const items: AgentExternalSessionTranscriptItem[] = [];
  const knownNonTranscriptPositions: number[] = [];
  const unsupportedPositions: number[] = [];
  for (const [index, entry] of entries.entries()) {
    const projected = projectEntry(remoteSessionId, entry);
    if (projected.kind === 'item') {
      items.push(...projected.items);
    } else if (projected.kind === 'known_non_transcript') {
      knownNonTranscriptPositions.push(index);
    } else {
      unsupportedPositions.push(index);
    }
  }
  return { items, knownNonTranscriptPositions, unsupportedPositions };
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
  projection?: PiTranscriptProjectionCursor;
}>): string {
  return encodeCursor({
    v: 2,
    kind: 'piTranscript',
    sessionFile: params.file.filePath,
    sourceGeneration: params.file.sourceGeneration,
    endOffsetBytes: params.endOffsetBytes,
    activeLeafId: params.activeLeafId,
    activeLeafFingerprint: params.activeLeafFingerprint,
    ...(params.projection ? { projection: params.projection } : {}),
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

/**
 * A public ref carries no private `sessionFile`, so the leaf must replay its
 * own candidate discovery and select the exact winner by the shared candidate
 * precedence contract. This scan is transient: unlike browse pagination, it
 * owns no cursor, cache, or cross-invocation candidate state.
 */
async function resolvePiUnqualifiedSessionFile(params: Readonly<{
  source: ResolvedPiSource;
  remoteSessionId: string;
  signal: AbortSignal;
}>): Promise<ResolvedPiSessionFile | null> {
  const scan = await createCandidateScan(params.source, '');
  try {
    const budget: PiCandidateChunkBudget = {
      rootEntries: 0,
      fileEntries: 0,
      limit: Number.MAX_SAFE_INTEGER,
    };
    let winner: AgentExternalSessionCandidate | null = null;
    while (!scan.complete) {
      params.signal.throwIfAborted();
      const filePath = await nextCandidateFile(scan, budget, params.signal);
      if (!filePath) break;
      const candidate = await inspectPiCandidateFile({
        filePath,
        fullScanLineLimit: 1,
        searchTerm: '',
      });
      if (
        candidate?.remoteSessionId === params.remoteSessionId
        && (!winner || compareExternalSessionCandidatePrecedence(candidate, winner) < 0)
      ) {
        winner = candidate;
      }
    }
    await validateCandidateScan(scan);
    const winnerPath = readOptionalString(winner?.linkData?.sessionFile);
    if (!winnerPath) return null;
    const resolved = await canonicalizePiSessionFile({
      source: params.source,
      filePath: winnerPath,
      remoteSessionId: params.remoteSessionId,
      maxBytes: PI_CANDIDATE_INSPECTION_MAX_BYTES,
    });
    await validateCandidateScan(scan);
    return resolved;
  } finally {
    await closeCandidateScan(scan);
  }
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
          const candidate = await inspectPiCandidateFile({
            filePath,
            fullScanLineLimit: request.maxItems,
            searchTerm,
          });
          if (!candidate) continue;
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
            ...candidateScanPreparation(scan, searchTerm),
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
          ...candidateScanPreparation(scan, searchTerm),
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
      let file: ResolvedPiSessionFile | null;
      try {
        file = requestedFile
          ? await canonicalizePiSessionFile({
              source: resolved.value,
              filePath: requestedFile,
              remoteSessionId: request.remoteSessionId,
              maxBytes: PI_CANDIDATE_INSPECTION_MAX_BYTES,
            })
          : await resolvePiUnqualifiedSessionFile({
              source: resolved.value,
              remoteSessionId: request.remoteSessionId,
              signal: request.signal,
            });
      } catch (error) {
        const after = invocationFailure(request);
        if (after) return after;
        if (error instanceof PiCandidateSourceChangedError) {
          return failed('source_invalid', error.message, true);
        }
        return failed(
          'agent_unavailable',
          error instanceof Error ? error.message : 'Pi external-session identity resolution failed.',
          true,
        );
      }
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
      const projection = sourceReplaced ? undefined : decodedCursor?.projection;
      if (projection?.kind === 'after') {
        return failed('invalid_request', 'Pi transcript cursor is not valid for older paging.');
      }
      const endOffsetBytes = sourceReplaced || !decodedCursor
        ? file.fileSize
        : Math.min(file.fileSize, decodedCursor.endOffsetBytes);
      const expectedLeafId = sourceReplaced ? undefined : decodedCursor?.activeLeafId;
      const page = await readJsonlFileBackwardPage({
        filePath: file.filePath,
        endOffsetBytes,
        maxBytes: projection?.nativeMaxSerializedBytes ?? request.maxSerializedBytes,
        maxItems: projection?.nativeMaxItems ?? Math.trunc(request.maxItems),
        maxOversizeLineBytes: projection?.nativeMaxSerializedBytes ?? request.maxSerializedBytes,
      });
      const afterPage = invocationFailure(request);
      if (afterPage) return afterPage;
      if (page.diagnostics?.some((diagnostic) => diagnostic.code === 'malformed_source_utf8')) {
        return failed('agent_error', 'Pi transcript source contains malformed UTF-8.');
      }
      const values = page.items.map((item) => item.value);
      if (values.some((value) => !isPiV3SessionFileRecord(value))) {
        return failed('agent_error', 'Pi transcript contains a structurally malformed provider record.');
      }
      const expectedLeafPresent = expectedLeafId === undefined
        || expectedLeafId === null
        || values.some((value) => isRecord(value) && value.id === expectedLeafId);
      if (projection && !expectedLeafPresent) {
        return failed('source_invalid', 'Pi transcript changed while replaying a partial record.', true);
      }
      const folded = foldPiV3SessionTree(values, {
        ...(expectedLeafId === undefined ? {} : { activeLeafId: expectedLeafId }),
      });
      const projectedBranch = expectedLeafPresent
        ? projectBranch(request.remoteSessionId, folded.activeBranch)
        : { items: [], knownNonTranscriptPositions: [], unsupportedPositions: [] };
      if (projectedBranch.unsupportedPositions.length > 0) {
        return failed('agent_error', 'Pi transcript contains an unsupported provider record.');
      }
      const items = projectedBranch.items;
      const earliest = expectedLeafPresent ? folded.activeBranch[0] ?? null : null;
      const nextActiveLeafId = expectedLeafPresent
        ? earliest?.parentId ?? null
        : expectedLeafId ?? null;
      if (projection && page.nextEndOffsetBytes !== projection.resumeEndOffsetBytes) {
        return failed('source_invalid', 'Pi transcript changed while replaying a partial record.', true);
      }
      const limit = Math.trunc(request.maxItems);
      let emittedItems: readonly AgentExternalSessionTranscriptItem[] = items;
      let hasMore = Boolean(nextActiveLeafId) && !page.reachedStart;
      let nextCursor: string | null = hasMore
        ? encodeTranscriptCursor({
          file,
          endOffsetBytes: page.nextEndOffsetBytes,
          activeLeafId: nextActiveLeafId,
          activeLeafFingerprint: null,
        })
        : null;
      if (projection) {
        if (projection.itemEnd > items.length) {
          return failed('source_invalid', 'Pi transcript changed while replaying a partial record.', true);
        }
        const itemStart = Math.max(0, projection.itemEnd - limit);
        emittedItems = items.slice(itemStart, projection.itemEnd);
        if (emittedItems.length === 0) {
          return failed('source_invalid', 'Pi transcript changed while replaying a partial record.', true);
        }
        if (itemStart > 0) {
          hasMore = true;
          nextCursor = encodeTranscriptCursor({
            file,
            endOffsetBytes,
            activeLeafId: decodedCursor?.activeLeafId ?? null,
            activeLeafFingerprint: null,
            projection: { ...projection, itemEnd: itemStart },
          });
        } else {
          hasMore = Boolean(projection.resumeActiveLeafId);
          nextCursor = hasMore
            ? encodeTranscriptCursor({
              file,
              endOffsetBytes: projection.resumeEndOffsetBytes,
              activeLeafId: projection.resumeActiveLeafId,
              activeLeafFingerprint: null,
            })
            : null;
        }
      } else if (items.length > limit) {
        const itemStart = items.length - limit;
        emittedItems = items.slice(itemStart);
        hasMore = true;
        nextCursor = encodeTranscriptCursor({
          file,
          endOffsetBytes,
          activeLeafId: folded.activeLeafId,
          activeLeafFingerprint: null,
          projection: {
            kind: 'older',
            nativeMaxItems: limit,
            nativeMaxSerializedBytes: request.maxSerializedBytes,
            itemEnd: itemStart,
            resumeEndOffsetBytes: page.nextEndOffsetBytes,
            resumeActiveLeafId: nextActiveLeafId,
          },
        });
      }
      const tail = request.cursor && !sourceReplaced
        ? null
        : await readCurrentTail({ file, maxBytes: request.maxSerializedBytes });
      const afterTail = invocationFailure(request);
      if (afterTail) return afterTail;
      const result: AgentExternalSessionsResult<AgentExternalSessionsTranscriptPage> = ok({
        items: emittedItems,
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
      const projection = cursor.projection;
      if (projection?.kind === 'older') {
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
      if (cursor.endOffsetBytes === file.fileSize && !projection) {
        return ok({ outcome: 'already_current' });
      }

      const page = await readJsonlFileForward({
        filePath: file.filePath,
        offsetBytes: cursor.endOffsetBytes,
        maxBytes: projection?.nativeMaxSerializedBytes ?? request.maxSerializedBytes,
        maxItems: projection?.nativeMaxItems ?? Math.trunc(request.maxItems),
        maxOversizeLineBytes: projection?.nativeMaxSerializedBytes ?? request.maxSerializedBytes,
      });
      const afterPage = invocationFailure(request);
      if (afterPage) return afterPage;
      const pageValues = page.items.map((item) => item.value);
      if (pageValues.some((value) => !isPiV3SessionFileRecord(value))) {
        return failed('agent_error', 'Pi transcript contains a structurally malformed provider record.');
      }
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
      if (anchor.records.some((value) => !isPiV3SessionFileRecord(value))) {
        return failed('agent_error', 'Pi transcript contains a structurally malformed provider record.');
      }

      const folded = foldPiV3SessionTree([
        ...anchor.records,
        ...pageValues,
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
      const projectedBranch = projectBranch(request.remoteSessionId, newBranch);
      if (projectedBranch.unsupportedPositions.length > 0) {
        return failed('agent_error', 'Pi transcript contains an unsupported provider record.');
      }
      const items = projectedBranch.items;
      const knownNonTranscriptPositions = projectedBranch.knownNonTranscriptPositions;
      const diagnostics = [
        ...(page.diagnostics ?? []),
        ...(knownNonTranscriptPositions.length > 0
          ? [{
              code: 'non_transcript_record_skipped',
              count: knownNonTranscriptPositions.length,
              positions: knownNonTranscriptPositions.slice(0, 200),
            }]
          : []),
      ];
      if (items.length === 0 && newBranch.length === 0) {
        return ok({ outcome: 'gap_or_cursor_expired' });
      }
      const nextActiveLeaf = folded.activeBranch.at(-1) ?? null;
      if (projection && page.nextOffsetBytes !== projection.resumeEndOffsetBytes) {
        return failed('source_invalid', 'Pi transcript changed while replaying a partial record.', true);
      }
      const limit = Math.trunc(request.maxItems);
      let emittedItems: readonly AgentExternalSessionTranscriptItem[] = items;
      let nextCursor = encodeTranscriptCursor({
        file,
        endOffsetBytes: page.nextOffsetBytes,
        activeLeafId: nextActiveLeaf?.id ?? null,
        activeLeafFingerprint: nextActiveLeaf
          ? fingerprintTreeEntry(nextActiveLeaf)
          : null,
      });
      let boundary = nextActiveLeaf?.id ?? `offset:${page.nextOffsetBytes}`;
      if (projection) {
        if (projection.nextItemIndex > items.length) {
          return failed('source_invalid', 'Pi transcript changed while replaying a partial record.', true);
        }
        emittedItems = items.slice(projection.nextItemIndex, projection.nextItemIndex + limit);
        if (emittedItems.length === 0) {
          return failed('source_invalid', 'Pi transcript changed while replaying a partial record.', true);
        }
        const nextItemIndex = projection.nextItemIndex + emittedItems.length;
        boundary = `${nextActiveLeaf?.id ?? `offset:${page.nextOffsetBytes}`}:item:${nextItemIndex}`;
        nextCursor = nextItemIndex < items.length
          ? encodeTranscriptCursor({
            file,
            endOffsetBytes: cursor.endOffsetBytes,
            activeLeafId: cursor.activeLeafId,
            activeLeafFingerprint: cursor.activeLeafFingerprint,
            projection: { ...projection, nextItemIndex },
          })
          : encodeTranscriptCursor({
            file,
            endOffsetBytes: projection.resumeEndOffsetBytes,
            activeLeafId: projection.resumeActiveLeafId,
            activeLeafFingerprint: projection.resumeActiveLeafFingerprint,
          });
      } else if (items.length > limit) {
        emittedItems = items.slice(0, limit);
        boundary = `${nextActiveLeaf?.id ?? `offset:${page.nextOffsetBytes}`}:item:${emittedItems.length}`;
        nextCursor = encodeTranscriptCursor({
          file,
          endOffsetBytes: cursor.endOffsetBytes,
          activeLeafId: cursor.activeLeafId,
          activeLeafFingerprint: cursor.activeLeafFingerprint,
          projection: {
            kind: 'after',
            nativeMaxItems: limit,
            nativeMaxSerializedBytes: request.maxSerializedBytes,
            nextItemIndex: emittedItems.length,
            resumeEndOffsetBytes: page.nextOffsetBytes,
            resumeActiveLeafId: nextActiveLeaf?.id ?? null,
            resumeActiveLeafFingerprint: nextActiveLeaf
              ? fingerprintTreeEntry(nextActiveLeaf)
              : null,
          },
        });
      }
      const result: AgentExternalSessionsResult<AgentExternalSessionsReadAfterTranscriptResult> = ok({
        outcome: 'advanced',
        items: emittedItems,
        nextCursor,
        boundary,
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
      });
      return resultFits(result, request.maxSerializedBytes)
        ? result
        : failed('invalid_request', 'Pi transcript result byte budget cannot fit the readAfter envelope.');
    },
  });
}

export const piExternalSessionsContribution: AgentExternalSessionsContribution = createPiExternalSessionsContribution();
