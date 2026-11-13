import { expandHomePath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';
import { createCodexNativeAppServerClient } from '../../../runtime/appServer/client.js';
import { resolveCodexRuntimeHomeEnvironment } from '../../../auth/services/state/sharing/files.js';
import { readCodexSessionMetaFromRollout } from '../../../rollout/discovery/indexData.js';
import { decodeCodexNativeTranscriptCursor, pageCodexNativeTranscript } from './nativeTranscript.js';
import { createHash } from 'node:crypto';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod/mini';

import type { AgentExternalSessionTranscriptItem, AgentExternalSessionsInvocation } from '@happier-dev/plugin-sdk/sessions/external';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import {
  readJsonlFileBackwardPage,
  readJsonlFileForward,
  readJsonlFileForwardLines,
  createExternalSessionContentSearchControl,
  searchExternalSessionContent,
  ExternalSessionContentSearchYield,
} from '@happier-dev/plugin-sdk/sessions/file-stores';

import { createCodexRolloutSemanticTracker, type CodexRolloutSemanticState } from '../../../rollout/semanticTracker.js';
import { createCodexRolloutCompactionFilter, projectCodexRolloutRecord } from '../../../rollout/projection/actions.js';
import { mapCodexRolloutLineToExternalMessages, readCodexRolloutLineTimestampMs } from '../../../rollout/projection/transcript.js';
import {
  describeCodexRolloutFileSetResourceIdentity,
  inventoryCodexRootSessionRolloutFiles,
  codexRolloutObservationInventories,
  type CodexRolloutFile,
  type CodexSessionRolloutResourceIdentity,
} from '../../../rollout/discovery/sessionsForHome.js';
import { homeEntries as resolveHomeEntries } from '../../../rollout/discovery/homeEntries.js';
import {
  decodeCodexExternalForwardCursor,
  encodeCodexExternalForwardCursor,
  CodexTranscriptRowLocationSchema,
  CodexTranscriptSemanticLocationsSchema,
  type CodexTranscriptSemanticCursor,
  type CodexTranscriptSemanticLocations,
} from './transcript.js';
import { CodexExternalSessionCandidateSourceChangedError } from './candidates.js';
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
    rollbackTurns: number;
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

type CodexProjectionRow<T> = Readonly<{ startOffsetBytes: number; records: readonly T[]; hasUser: boolean; rollbackCount: number | null | undefined }>;

const ContentRowLocationSchema = CodexTranscriptRowLocationSchema;
const CodexContentSearchProgressSchema = z.strictObject({
  remoteSessionId: z.string(), partial: z.boolean(), phase: z.enum(['selection', 'matching', 'ordinal', 'done']), messageIndex: z.number().check(z.int(), z.nonnegative()),
  hit: z.optional(z.strictObject({ streamIndex: z.number().check(z.int(), z.nonnegative()), row: ContentRowLocationSchema, id: z.string(), createdAtMs: z.number() })),
  streams: z.array(z.strictObject({
    fileRelPath: z.string(), sourceIdentity: z.string(), contentFingerprint: z.string().check(z.regex(/^[a-f0-9]{64}$/u)), sizeBytes: z.number().check(z.int(), z.nonnegative()), offsetBytes: z.number().check(z.int(), z.nonnegative()),
    selectionEndOffsetBytes: z.number().check(z.int(), z.nonnegative()), pendingTurns: z.number().check(z.int(), z.nonnegative()), previousExcluded: z.boolean(), excluded: z.array(ContentRowLocationSchema),
    precedingTimestampMs: z.number().check(z.nonnegative()),
    semantic: CodexTranscriptSemanticLocationsSchema,
  })),
});
export type CodexContentSearchProgress = z.infer<typeof CodexContentSearchProgressSchema>;
export function parseCodexContentSearchProgress(value: unknown): CodexContentSearchProgress | null {
  const parsed = CodexContentSearchProgressSchema.safeParse(value);
  return parsed.success && parsed.data.streams.every((stream) => stream.offsetBytes <= stream.sizeBytes && stream.selectionEndOffsetBytes <= stream.sizeBytes
    && stream.excluded.every((row) => row.startOffsetBytes < row.endOffsetBytes && row.endOffsetBytes <= stream.sizeBytes)
    && (!stream.semantic.assistant || stream.semantic.assistant.endOffsetBytes <= stream.offsetBytes)
    && stream.semantic.pending.every((pending) => pending.row.endOffsetBytes <= stream.offsetBytes)) ? parsed.data : null;
}
export class CodexContentSearchYield extends ExternalSessionContentSearchYield {
  constructor(readonly progress: CodexContentSearchProgress) { super(); }
}
function isCodexContentScanComplete(progress: CodexContentSearchProgress) { return progress.phase === 'done'; }

export class CodexExternalTranscriptSourceUnavailableError extends Error {
  constructor() { super('Codex transcript source no longer exists.'); }
}

/** Private reader context; no source text or absolute path crosses this error. */
export class CodexExternalTranscriptReadError extends Error {
  readonly fileBasename: string;
  constructor(readonly phase: 'page_scan' | 'timestamp_scan', filePath: string, readonly byteOffset: number) {
    super('Codex transcript source contains malformed UTF-8.');
    this.fileBasename = basename(filePath);
  }
  readonly code = 'CODEX_TRANSCRIPT_MALFORMED_UTF8';
}

/** Native rollback replay, shared by content, import and bounded older pages. */
function selectCodexExternalTranscriptRows<T>(rows: readonly CodexProjectionRow<T>[], pendingTurns = 0) {
  const records: T[] = [];
  const rollbackTurnsByOffset = new Map<number, number>();
  let partial = false;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (typeof row.rollbackCount === 'number') {
      pendingTurns += row.rollbackCount;
    } else if (pendingTurns > 0) {
      if (row.hasUser) pendingTurns -= 1;
    } else records.push(...row.records);
    if (row.rollbackCount === null) partial = true;
    rollbackTurnsByOffset.set(row.startOffsetBytes, pendingTurns);
  }
  return { records, pendingTurns, rollbackTurnsByOffset, partial };
}

type BestCodexHomeWithFiles = Readonly<{
  codexHome: string;
  source: CodexExternalSessionSource;
  files: readonly CodexRolloutFile[];
}>;

async function readCodexCompactionFilterAtBoundary(params: Readonly<{
  filePath: string;
  offsetBytes: number;
  sourceSizeBytes: number;
}> & CodexExternalSessionInvocationBounds) {
  const filter = createCodexRolloutCompactionFilter();
  if (params.offsetBytes >= params.sourceSizeBytes) return filter;
  const foundBoundary = {};
  try {
    await readJsonlFileForwardLines({ filePath: params.filePath, offsetBytes: params.offsetBytes,
      maxBytes: params.sourceSizeBytes - params.offsetBytes, maxItems: params.sourceSizeBytes,
      signal: params.signal, fileSystem: createCodexExternalSessionJsonlScannerFileSystem(params),
      onLine(line) {
        throwIfCodexExternalSessionInvocationStopped(params);
        if (filter.observeFollowingRecord(line.value)) throw foundBoundary;
      } });
  } catch (error) {
    if (error !== foundBoundary) throw error;
  }
  return filter;
}

async function readCodexExternalTranscriptProjection(params: Readonly<{
  stream: CodexExternalTranscriptRolloutStream;
  requestedOffsets: ReadonlySet<number>;
  pageStartOffsetBytes: number;
  pageEndOffsetBytes: number;
  semanticState?: CodexTranscriptSemanticCursor;
  maxBytes: number;
}> & CodexExternalSessionInvocationBounds) {
  const records: CodexProjectedTranscriptRecord[] = [];
  const sourceSizeBytes = await statFileSize(params.stream.filePath, params) ?? 0;
  const retainedOffsets = new Set<number>();
  let endOffsetBytes = sourceSizeBytes;
  let pendingTurns = 0;
  const compactionFilter = createCodexRolloutCompactionFilter();
  // Older pages and direct search own the same native reverse rollback rule.
  // Apply it to the unread suffix, retaining only this page's visible offsets.
  while (endOffsetBytes > params.pageStartOffsetBytes) {
    const page = await readJsonlFileBackwardPage({ filePath: params.stream.filePath, endOffsetBytes,
      // One preceding newline establishes the first unread row's boundary;
      // avoid decoding a whole page of already-consumed prefix for a tiny append.
      maxBytes: Math.min(params.maxBytes, endOffsetBytes - Math.max(0, params.pageStartOffsetBytes - 1)),
      maxItems: Math.max(1, sourceSizeBytes), includeMalformedRecords: true, signal: params.signal,
      fileSystem: createCodexExternalSessionJsonlScannerFileSystem(params),
      onLine(line) {
        throwIfCodexExternalSessionInvocationStopped(params);
        if (line.startOffsetBytes < params.pageStartOffsetBytes) return;
        const projected = projectLine({ stream: params.stream, lineStartOffsetBytes: line.startOffsetBytes,
          lineEndOffsetBytes: line.endOffsetBytes, lineValue: line.value, semanticTracker: createCodexRolloutSemanticTracker() });
        const selected = selectCodexExternalTranscriptRows([{ startOffsetBytes: line.startOffsetBytes,
          records: params.requestedOffsets.has(line.startOffsetBytes) ? [line.startOffsetBytes] : [],
          hasUser: projected.records.some(record => record.item.raw.role === 'user'),
          rollbackCount: readCodexExternalRollbackCount(line.value) }], pendingTurns);
        pendingTurns = selected.pendingTurns;
        const internal = compactionFilter.isInternalInReverse(line.value);
        if (!internal) for (const offset of selected.records) retainedOffsets.add(offset);
      } });
    if (page.reachedStart || page.nextEndOffsetBytes <= params.pageStartOffsetBytes) break;
    if (page.nextEndOffsetBytes >= endOffsetBytes) throw new Error('Codex transcript rollback selection cannot advance past an oversized native record.');
    endOffsetBytes = page.nextEndOffsetBytes;
  }
  const context = await restoreCodexTranscriptSemanticContext(params.stream, params.semanticState, params);
  let pageStartState = params.semanticState ? snapshotCodexTranscriptSemanticContext(context) : null;
  let offsetBytes = params.semanticState ? params.pageStartOffsetBytes : 0;
  // Old v7 watermarks bootstrap once from the prefix. A semantic cursor starts
  // here directly; neither path retains bodies outside the requested page.
  while (offsetBytes < params.pageEndOffsetBytes) {
      throwIfCodexExternalSessionInvocationStopped(params);
      const page = await readJsonlFileForwardLines({ filePath: params.stream.filePath, offsetBytes,
        maxBytes: Math.min(params.maxBytes, params.pageEndOffsetBytes - offsetBytes),
        maxItems: Math.max(1, sourceSizeBytes), signal: params.signal,
        fileSystem: createCodexExternalSessionJsonlScannerFileSystem(params),
        onLine(line) {
          throwIfCodexExternalSessionInvocationStopped(params);
          if (line.startOffsetBytes >= params.pageStartOffsetBytes && pageStartState === null) {
            pageStartState = snapshotCodexTranscriptSemanticContext(context);
          }
          if (line.value === null && line.rawLine !== 'null' && line.endOffsetBytes === sourceSizeBytes) {
            return;
          }
          const projected = projectCodexTranscriptSemanticLine(params.stream, line, context);
          if (retainedOffsets.has(line.startOffsetBytes)) records.push(...projected.records);
        } });
      if (page.reachedEnd) break;
      if (page.nextOffsetBytes <= offsetBytes) throw new Error('Codex transcript semantic replay cannot advance past an oversized native record.');
      offsetBytes = page.nextOffsetBytes;
  }
  return { records, pageStartState };
}

function emptyCodexTranscriptSemanticLocations(): CodexTranscriptSemanticLocations {
  return { assistant: null, pending: [], startedThreadIds: [], completedThreadIds: [] };
}

type CodexTranscriptSemanticContext = {
  tracker: ReturnType<typeof createCodexRolloutSemanticTracker>;
  state: CodexTranscriptSemanticCursor;
};

function snapshotCodexTranscriptSemanticContext(context: CodexTranscriptSemanticContext): CodexTranscriptSemanticCursor {
  const locations = context.state.locations;
  return { precedingTimestampMs: context.state.precedingTimestampMs, locations: {
    assistant: locations.assistant, pending: [...locations.pending],
    startedThreadIds: [...locations.startedThreadIds], completedThreadIds: [...locations.completedThreadIds],
  } };
}

async function restoreCodexTranscriptSemanticContext(stream: CodexExternalTranscriptRolloutStream,
  state: CodexTranscriptSemanticCursor | undefined, bounds: CodexExternalSessionInvocationBounds): Promise<CodexTranscriptSemanticContext> {
  const locations = state?.locations ?? emptyCodexTranscriptSemanticLocations();
  const readRow = async (row: z.infer<typeof ContentRowLocationSchema>) => {
    const page = await readJsonlFileForwardLines({ filePath: stream.filePath, offsetBytes: row.startOffsetBytes,
      maxBytes: Math.max(1, row.endOffsetBytes - row.startOffsetBytes), maxItems: 1,
      signal: bounds.signal, fileSystem: createCodexExternalSessionJsonlScannerFileSystem(bounds) });
    return page.items.find(line => line.startOffsetBytes === row.startOffsetBytes && line.endOffsetBytes === row.endOffsetBytes);
  };
  const assistantLine = locations.assistant ? await readRow(locations.assistant) : null;
  const assistantAction = assistantLine && projectCodexRolloutRecord(assistantLine.value, { debug: true }).actions.find(action => action.type === 'assistant-text');
  if (locations.assistant && (!assistantAction || assistantAction.type !== 'assistant-text')) throw new CodexExternalSessionCandidateSourceChangedError();
  const pendingSpawnByCallId: Array<CodexRolloutSemanticState['pendingSpawnByCallId'][number]> = [];
  for (const pending of locations.pending) {
    const line = await readRow(pending.row);
    const action = line && projectCodexRolloutRecord(line.value, { debug: true }).actions.find(action => action.type === 'collaboration-tool-call' && action.callId === pending.callId);
    if (!action || action.type !== 'collaboration-tool-call' || action.name !== 'spawn_agent') throw new CodexExternalSessionCandidateSourceChangedError();
    pendingSpawnByCallId.push([pending.callId, { prompt: action.prompt, nickname: action.nickname, role: action.role }]);
  }
  return { tracker: createCodexRolloutSemanticTracker({ pendingSpawnByCallId,
    lastEmittedAssistantText: assistantAction && assistantAction.type === 'assistant-text' ? assistantAction.text : null,
    startedThreadIds: locations.startedThreadIds, completedThreadIds: locations.completedThreadIds }),
    state: { precedingTimestampMs: state?.precedingTimestampMs ?? 0, locations: {
      assistant: locations.assistant, pending: [...locations.pending],
      startedThreadIds: [...locations.startedThreadIds], completedThreadIds: [...locations.completedThreadIds],
    } } };
}

function projectCodexTranscriptSemanticLine(stream: CodexExternalTranscriptRolloutStream,
  line: Readonly<{ value: unknown; startOffsetBytes: number; endOffsetBytes: number }>, context: CodexTranscriptSemanticContext) {
  context.state.precedingTimestampMs = readCodexRolloutLineTimestampMs(line.value) ?? context.state.precedingTimestampMs;
  const count = readCodexExternalRollbackCount(line.value);
  if (typeof count === 'number' && count > 0) {
    context.tracker = createCodexRolloutSemanticTracker();
    context.state.locations = emptyCodexTranscriptSemanticLocations();
  }
  const locations = context.state.locations;
  const row = { startOffsetBytes: line.startOffsetBytes, endOffsetBytes: line.endOffsetBytes };
  let emittedAssistant = false;
  const projected = projectLine({ stream, lineStartOffsetBytes: line.startOffsetBytes, lineEndOffsetBytes: line.endOffsetBytes,
    lineValue: line.value, semanticTracker: context.tracker, precedingTimestampMs: context.state.precedingTimestampMs,
    onSemanticAction(action, emittedActions) {
      const emitted = emittedActions.length > 0;
      if (action.type === 'assistant-text') {
        if (emitted) { locations.assistant = row; emittedAssistant = true; }
      } else if (action.type !== 'debug') locations.assistant = null;
      if (action.type === 'collaboration-tool-call' && action.name === 'spawn_agent') {
        locations.pending = locations.pending.filter(pending => pending.callId !== action.callId);
        locations.pending.push({ callId: action.callId, row });
      }
      if (action.type === 'collaboration-tool-result') locations.pending = locations.pending.filter(pending => pending.callId !== action.callId);
      // Only the canonical tracker decides which lifecycle transitions emit.
      // Persist those facts without copying its lifetime sets on every row.
      for (const normalized of emittedActions) {
        if (normalized.type === 'subagent-spawn') locations.startedThreadIds.push(normalized.threadId);
        if (normalized.type === 'subagent-complete') locations.completedThreadIds.push(normalized.threadId);
      }
    } });
  if (projected.unsupportedRecord && !emittedAssistant) locations.assistant = null;
  return projected;
}

async function readCodexExternalContentSearchProjection(params: Readonly<{
  streams: readonly CodexExternalTranscriptRolloutStream[];
  progress: CodexContentSearchProgress;
  matchText: (text: string) => string | null;
}> & CodexExternalSessionInvocationBounds) {
  const progress = params.progress;
  const control = params.contentSearchControl!;
  // A native row is indivisible. Commit its semantic facts and location before
  // yielding; native reads and final row verification still observe hard expiry.
  const nativeBounds = { signal: params.signal, deadlineAtMs: params.deadlineAtMs };
  const readRow = async (stream: CodexExternalTranscriptRolloutStream, row: z.infer<typeof ContentRowLocationSchema>) => {
    const page = await readJsonlFileForwardLines({ filePath: stream.filePath, offsetBytes: row.startOffsetBytes,
      maxBytes: Math.max(1, row.endOffsetBytes - row.startOffsetBytes), maxItems: 1, signal: params.signal,
      fileSystem: createCodexExternalSessionJsonlScannerFileSystem(nativeBounds) });
    return page.items.find((line) => line.startOffsetBytes === row.startOffsetBytes && line.endOffsetBytes === row.endOffsetBytes);
  };
  const emptySemantic = emptyCodexTranscriptSemanticLocations;
  const commit = () => progress.phase === 'done' ? control.assertNotYielded() : control.checkWork();
  // Rollback selection comes first, in native reverse order. Its excluded
  // ranges coalesce whole abandoned turns rather than retaining message rows.
  if (progress.phase === 'selection') {
    for (let streamIndex = 0; streamIndex < params.streams.length; streamIndex += 1) {
      const stream = params.streams[streamIndex]!;
      const state = progress.streams[streamIndex]!;
      const compactionFilter = await readCodexCompactionFilterAtBoundary({ ...nativeBounds,
        filePath: stream.filePath, offsetBytes: state.selectionEndOffsetBytes, sourceSizeBytes: state.sizeBytes });
      while (state.selectionEndOffsetBytes > 0) {
        const initialEnd = state.selectionEndOffsetBytes;
        const page = await readJsonlFileBackwardPage({ filePath: stream.filePath, endOffsetBytes: initialEnd,
          maxBytes: Math.max(1, state.sizeBytes), maxItems: Math.max(1, state.sizeBytes), signal: params.signal,
          fileSystem: createCodexExternalSessionJsonlScannerFileSystem(nativeBounds),
          includeMalformedRecords: true,
          onDiagnostic: () => { progress.partial = true; },
          onLine(line, tailOffsetBytes) {
            throwIfCodexExternalSessionInvocationStopped(nativeBounds);
            progress.partial ||= tailOffsetBytes !== null && tailOffsetBytes < initialEnd;
            const projected = projectLine({ stream, lineStartOffsetBytes: line.startOffsetBytes, lineEndOffsetBytes: line.endOffsetBytes,
              lineValue: line.value, semanticTracker: createCodexRolloutSemanticTracker() });
            const count = readCodexExternalRollbackCount(line.value);
            const selected = selectCodexExternalTranscriptRows([{ startOffsetBytes: line.startOffsetBytes, records: [line],
              hasUser: projected.records.some((record) => record.item.raw.role === 'user'), rollbackCount: count }], state.pendingTurns);
            const internal = compactionFilter.isInternalInReverse(line.value);
            const excluded = internal || (typeof count !== 'number' && selected.records.length === 0);
            if (excluded) {
              const previous = state.excluded.at(-1);
              if (previous && state.previousExcluded) previous.startOffsetBytes = line.startOffsetBytes;
              else state.excluded.push({ startOffsetBytes: line.startOffsetBytes, endOffsetBytes: line.endOffsetBytes });
            }
            state.previousExcluded = excluded;
            state.pendingTurns = selected.pendingTurns;
            progress.partial ||= selected.partial || projected.unsupportedRecord;
            state.selectionEndOffsetBytes = line.startOffsetBytes;
            if (progress.streams.every((entry) => entry.selectionEndOffsetBytes === 0)) progress.phase = 'matching';
            commit();
          },
        });
        state.selectionEndOffsetBytes = page.nextEndOffsetBytes;
        progress.partial ||= Boolean(page.diagnostics?.length);
        if (page.reachedStart) break;
        if (page.nextEndOffsetBytes >= initialEnd) { progress.partial = true; state.selectionEndOffsetBytes = 0; break; }
      }
    }
    progress.phase = 'matching';
  }
  while (progress.phase === 'matching' || progress.phase === 'ordinal') {
  for (let streamIndex = 0; streamIndex < params.streams.length; streamIndex += 1) {
    const stream = params.streams[streamIndex]!;
    const state = progress.streams[streamIndex]!;
    if (state.offsetBytes >= state.sizeBytes) continue;
    const context = await restoreCodexTranscriptSemanticContext(stream,
      { precedingTimestampMs: state.precedingTimestampMs, locations: state.semantic }, nativeBounds);
    while (state.offsetBytes < state.sizeBytes) {
      throwIfCodexExternalSessionInvocationStopped(nativeBounds);
      const initialOffsetBytes = state.offsetBytes;
      const page = await readJsonlFileForwardLines({
        filePath: stream.filePath, offsetBytes: state.offsetBytes, maxBytes: Math.max(1, state.sizeBytes), maxItems: Math.max(1, state.sizeBytes), signal: params.signal,
        fileSystem: createCodexExternalSessionJsonlScannerFileSystem(nativeBounds),
        onDiagnostic: () => { progress.partial = true; },
        onLine(line) {
          throwIfCodexExternalSessionInvocationStopped(nativeBounds);
          if (line.value === null && line.rawLine !== 'null' && line.endOffsetBytes === state.sizeBytes) {
            progress.partial = true;
            return;
          }
          state.precedingTimestampMs = readCodexRolloutLineTimestampMs(line.value) ?? state.precedingTimestampMs;
          context.state.precedingTimestampMs = state.precedingTimestampMs;
          const location = { startOffsetBytes: line.startOffsetBytes, endOffsetBytes: line.endOffsetBytes };
          const count = readCodexExternalRollbackCount(line.value);
          if (typeof count === 'number') {
            projectCodexTranscriptSemanticLine(stream, line, context);
          } else if (!state.excluded.some((range) => line.startOffsetBytes >= range.startOffsetBytes && line.startOffsetBytes < range.endOffsetBytes)) {
            const projected = projectCodexTranscriptSemanticLine(stream, line, context);
            progress.partial ||= projected.unsupportedRecord;
            for (const { item } of projected.records) {
              if (progress.phase === 'matching') {
                if (params.matchText(transcriptSearchText(item) ?? '') !== null
                  && (!progress.hit || compareTranscriptItemsOldestFirst(item, progress.hit) < 0)) {
                  progress.hit = { streamIndex, row: location, id: item.id, createdAtMs: item.createdAtMs };
                }
              } else if (progress.hit && compareTranscriptItemsOldestFirst(item, progress.hit) < 0) progress.messageIndex += 1;
            }
          }
          state.semantic = context.state.locations;
          state.offsetBytes = line.endOffsetBytes;
          if (progress.streams.every((entry) => entry.offsetBytes >= entry.sizeBytes)) {
            if (progress.phase === 'ordinal' || !progress.hit) progress.phase = 'done';
          }
          commit();
        },
      });
      progress.partial ||= page.truncated || Boolean(page.diagnostics?.length);
      state.offsetBytes = page.nextOffsetBytes;
      if (page.reachedEnd) break;
      if (page.nextOffsetBytes <= initialOffsetBytes) { progress.partial = true; state.offsetBytes = state.sizeBytes; break; }
    }
  }
  if (!isCodexContentScanComplete(progress)) {
    if (progress.phase === 'ordinal' || !progress.hit) progress.phase = 'done';
    else { progress.phase = 'ordinal'; for (const entry of progress.streams) { entry.offsetBytes = 0; entry.precedingTimestampMs = 0; entry.semantic = emptySemantic(); } }
  }
  }
  const match = progress.hit;
  if (!match) return { records: [], partial: progress.partial };
  // Retained locations/semantic facts do not authorize returned text. Re-decode
  // and re-match the native visible record before constructing its snippet.
  const stream = params.streams[match.streamIndex]!;
  const line = await readRow(stream, match.row);
  const projected = line ? projectLine({ stream, lineStartOffsetBytes: line.startOffsetBytes, lineEndOffsetBytes: line.endOffsetBytes,
    lineValue: line.value, semanticTracker: createCodexRolloutSemanticTracker() }) : null;
  const item = projected?.records.find((record) => record.item.id === match.id)?.item;
  const snippet = item ? params.matchText(transcriptSearchText(item) ?? '') : null;
  if (!item || snippet === null) throw new CodexExternalSessionCandidateSourceChangedError();
  return { records: [{ id: item.id, snippet, messageIndex: progress.messageIndex }], partial: progress.partial };
}

function transcriptSearchText(item: AgentExternalSessionTranscriptItem): string | null {
  const content = item.raw.content;
  return isTranscriptObject(content)
    ? content.type === 'text' && typeof content.text === 'string' ? content.text
      : content.type === 'codex' && 'data' in content && isTranscriptObject(content.data) && content.data.type === 'message' && typeof content.data.message === 'string' ? content.data.message : null
    : null;
}

function isTranscriptObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function searchCodexExternalTranscript(params: Readonly<{
  source: CodexExternalSessionSource;
  activeServerDir?: string;
  env: NodeJS.ProcessEnv;
  remoteSessionId: string;
  query: string;
  ripgrep: AgentExternalSessionsInvocation['ripgrep'];
  files?: readonly CodexRolloutFile[];
  progress?: CodexContentSearchProgress;
}> & CodexExternalSessionInvocationBounds): Promise<Readonly<{
  match?: { snippet: string; sourceItemId: string; messageIndex: number };
  partial: boolean;
  unsearchable: boolean;
}>> {
  const files = params.files ?? (await resolveBestHomeWithFiles(params))?.files ?? [];
  const streams = collectTranscriptStreams({ rootSessionId: params.remoteSessionId, rootFamilyFiles: files });
  if (streams.length === 0) return { partial: true, unsearchable: true };
  const nativeBounds = { signal: params.signal, deadlineAtMs: params.deadlineAtMs };
  const readSources = (capturedSizes?: readonly number[]) => Promise.all(streams.map(async (stream, index) => {
    throwIfCodexExternalSessionInvocationStopped(nativeBounds);
    const file = await stat(stream.filePath, { bigint: true });
    const contentFingerprint = await captureContentAnchor(stream.filePath, capturedSizes?.[index] ?? Number(file.size), nativeBounds);
    throwIfCodexExternalSessionInvocationStopped(nativeBounds);
    return { fileRelPath: stream.fileRelPath, sourceIdentity: `${file.dev}:${file.ino}:${file.birthtimeNs}:${file.mtimeNs}:${file.ctimeNs}`, sizeBytes: Number(file.size), contentFingerprint };
  }));
  const sources = await readSources(params.progress?.streams.map(stream => stream.sizeBytes));
  // Reuse older-page content anchors and keep the captured end across native
  // appends. New tail bytes make coverage partial; replacement and edits to the
  // captured boundary still invalidate the scan.
  const preservesCapturedSource = (source: typeof sources[number], captured: Readonly<{
    fileRelPath: string; sourceIdentity: string; sizeBytes: number; contentFingerprint: string;
  }>) => source.fileRelPath === captured.fileRelPath
    && source.sizeBytes >= captured.sizeBytes
    && source.contentFingerprint === captured.contentFingerprint
    && source.sourceIdentity.split(':').slice(0, 3).join(':') === captured.sourceIdentity.split(':').slice(0, 3).join(':')
    && (source.sizeBytes > captured.sizeBytes || source.sourceIdentity === captured.sourceIdentity);
  if (params.progress && (params.progress.remoteSessionId !== params.remoteSessionId || params.progress.streams.length !== sources.length
    || sources.some((source, index) => !preservesCapturedSource(source, params.progress!.streams[index]!)))) {
    throw new CodexExternalSessionCandidateSourceChangedError();
  }
  const progress: CodexContentSearchProgress = params.progress ?? { remoteSessionId: params.remoteSessionId, partial: false, phase: 'selection', messageIndex: 0,
    streams: sources.map((source) => {
      if (!source.contentFingerprint) throw new CodexExternalSessionCandidateSourceChangedError();
      return { ...source, contentFingerprint: source.contentFingerprint, offsetBytes: 0, precedingTimestampMs: 0, selectionEndOffsetBytes: source.sizeBytes, pendingTurns: 0, previousExcluded: false, excluded: [],
        semantic: { assistant: null, pending: [], startedThreadIds: [], completedThreadIds: [] } };
    }) };
  progress.partial ||= sources.some((source, index) => source.sizeBytes > progress.streams[index]!.sizeBytes);
  const control = params.contentSearchControl ?? createExternalSessionContentSearchControl(params);
  // A multi-stream transcript has one semantic order; decode all its streams
  // once any stream matches so source ordinals and normalization stay correct.
  try {
    const result = await searchExternalSessionContent({
      query: params.query, ...(params.progress ? {} : { paths: streams.map((stream) => stream.filePath) }), ripgrep: params.ripgrep,
      control, isScanComplete: () => progress.phase === 'done',
      decode: async (matchText) => {
        let projection!: Awaited<ReturnType<typeof readCodexExternalContentSearchProjection>>;
        await control.prepare(async () => {
          projection = await readCodexExternalContentSearchProjection({ ...params, contentSearchControl: control, streams, progress, matchText });
          return true;
        });
        return projection;
      },
    });
    const current = await readSources(progress.streams.map(stream => stream.sizeBytes));
    throwIfCodexExternalSessionInvocationStopped(nativeBounds);
    if (current.some((source, index) => !preservesCapturedSource(source, progress.streams[index]!))) throw new CodexExternalSessionCandidateSourceChangedError();
    return { ...result, partial: result.partial || current.some((source, index) => source.sizeBytes > progress.streams[index]!.sizeBytes), unsearchable: false };
  } catch (error) {
    if (error instanceof ExternalSessionContentSearchYield) throw new CodexContentSearchYield(progress);
    throw error;
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
        const rollbackTurns = streamRecord.rollbackTurns;
        if (typeof rollbackTurns !== 'number' || !Number.isSafeInteger(rollbackTurns) || rollbackTurns < 0) return [];
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
              rollbackTurns,
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
  left: Readonly<{ createdAtMs: number; id: string }>,
  right: Readonly<{ createdAtMs: number; id: string }>,
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
    semanticState?: CodexTranscriptSemanticCursor;
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
          ...(entry.semanticState ? { semanticState: entry.semanticState } : {}),
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
    rollbackTurns?: number;
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
          rollbackTurns: entry.rollbackTurns ?? 0,
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
  precedingTimestampMs?: number;
  onSemanticAction?: (action: ReturnType<typeof projectCodexRolloutRecord>['actions'][number], emitted: ReturnType<ReturnType<typeof createCodexRolloutSemanticTracker>['consume']>) => void;
}>): Readonly<{
  records: readonly CodexProjectedTranscriptRecord[];
  knownNonTranscriptRecord: boolean;
  unsupportedRecord: boolean;
}> {
  const rollbackCount = readCodexExternalRollbackCount(params.lineValue);
  if (typeof rollbackCount === 'number') return { records: [], knownNonTranscriptRecord: true, unsupportedRecord: false };
  const rolloutRecord = projectCodexRolloutRecord(params.lineValue, { debug: true });
  const unsupportedRecord = rollbackCount === null || rolloutRecord.disposition === 'unsupported';
  if (unsupportedRecord) params.semanticTracker.breakAssistantEcho();
  const normalizedActions = rolloutRecord.actions.flatMap((action) => {
    const emitted = params.semanticTracker.consume(action);
    params.onSemanticAction?.(action, emitted);
    return emitted;
  });
  const mappedItems = mapCodexRolloutLineToExternalMessages({
    fileRelPath: params.stream.fileRelPath,
    lineStartOffsetBytes: params.lineStartOffsetBytes,
    lineValue: params.lineValue,
    actions: normalizedActions,
    unsupportedRecord,
    precedingTimestampMs: params.precedingTimestampMs,
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
    knownNonTranscriptRecord: !unsupportedRecord && rolloutRecord.disposition === 'known',
    unsupportedRecord,
  };
}

function readCodexExternalRollbackCount(value: unknown): number | null | undefined {
  const envelope = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const payload = envelope?.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload) ? envelope.payload as Record<string, unknown> : null;
  if (envelope?.type !== 'event_msg' || payload?.type !== 'thread_rolled_back') return undefined;
  const count = payload.num_turns;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
}

async function readPrecedingCodexRolloutTimestamp(params: Readonly<{
  stream: CodexExternalTranscriptRolloutStream;
  beforeOffsetBytes: number;
  maxBytes: number;
}> & CodexExternalSessionInvocationBounds): Promise<number> {
  let endOffsetBytes = params.beforeOffsetBytes;
  while (endOffsetBytes > 0) {
    throwIfCodexExternalSessionInvocationStopped(params);
    const page = await readJsonlFileBackwardPage({ filePath: params.stream.filePath, endOffsetBytes,
      maxBytes: params.maxBytes, maxItems: params.maxBytes, signal: params.signal,
      fileSystem: createCodexExternalSessionJsonlScannerFileSystem(params) });
    if (page.diagnostics?.length) throw new CodexExternalTranscriptReadError('timestamp_scan', params.stream.filePath,
      page.diagnostics[0]!.positions[0] ?? page.nextEndOffsetBytes);
    for (let index = page.items.length - 1; index >= 0; index -= 1) {
      const timestampMs = readCodexRolloutLineTimestampMs(page.items[index]!.value);
      if (timestampMs !== null) return timestampMs;
    }
    if (page.reachedStart || page.nextEndOffsetBytes >= endOffsetBytes) return 0;
    endOffsetBytes = page.nextEndOffsetBytes;
  }
  return 0;
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

async function resolveBestHomesWithFiles(params: Readonly<{
  source: CodexExternalSessionSource;
  activeServerDir?: string;
  env: NodeJS.ProcessEnv;
  remoteSessionIds: readonly string[];
}> & CodexExternalSessionInvocationBounds): Promise<ReadonlyMap<string, BestCodexHomeWithFiles>> {
  throwIfCodexExternalSessionInvocationStopped(params);
  const bestById = new Map<string, BestCodexHomeWithFiles>();
  if (params.remoteSessionIds.length === 0) return bestById;
  const entries = await resolveHomeEntries({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
    signal: params.signal,
    deadlineAtMs: params.deadlineAtMs,
    onProgress: params.onProgress,
    preparation: params.preparation,
  });
  throwIfCodexExternalSessionInvocationStopped(params);
  const bestLatestMtimeById = new Map<string, number>();
  for (const entry of entries) {
    throwIfCodexExternalSessionInvocationStopped(params);
    const inventory = await inventoryCodexRootSessionRolloutFiles({
      codexHome: entry.codexHome,
      observationInventory: params.observation
        ? codexRolloutObservationInventories.observe(entry.codexHome, params.observation.lifetime)
        : codexRolloutObservationInventories.read(entry.codexHome),
      remoteSessionIds: params.remoteSessionIds,
      changedFiles: params.observation?.changedFiles,
      signal: params.signal ?? new AbortController().signal,
      deadlineAtMs: params.deadlineAtMs,
      onProgress: params.onProgress,
      preparation: params.preparation,
    });
    throwIfCodexExternalSessionInvocationStopped(params);
    for (const { remoteSessionId, files } of inventory.requested) {
      if (files.length === 0) continue;
      const latestMtimeMs = Math.max(...files.map((file) => file.mtimeMs));
      if (latestMtimeMs > (bestLatestMtimeById.get(remoteSessionId) ?? -1)) {
        bestLatestMtimeById.set(remoteSessionId, latestMtimeMs);
        bestById.set(remoteSessionId, { codexHome: entry.codexHome, source: entry.source, files });
      }
    }
  }
  return bestById;
}

async function resolveBestHomeWithFiles(params: Readonly<{
  source: CodexExternalSessionSource;
  activeServerDir?: string;
  env: NodeJS.ProcessEnv;
  remoteSessionId: string;
}> & CodexExternalSessionInvocationBounds): Promise<BestCodexHomeWithFiles | null> {
  return (await resolveBestHomesWithFiles({ ...params, remoteSessionIds: [params.remoteSessionId] })).get(params.remoteSessionId) ?? null;
}

/** One canonical root-family inventory shared by the selected content page. */
export async function resolveCodexExternalTranscriptFiles(params: Readonly<{
  source: CodexExternalSessionSource;
  activeServerDir?: string;
  env: NodeJS.ProcessEnv;
  remoteSessionIds: readonly string[];
}> & CodexExternalSessionInvocationBounds): Promise<ReadonlyMap<string, readonly CodexRolloutFile[]>> {
  const homes = await resolveBestHomesWithFiles(params);
  return new Map([...homes].map(([remoteSessionId, home]) => [remoteSessionId, home.files]));
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
      onProgress: params.onProgress,
      preparation: params.preparation,
    }),
  };
}

async function readCodexNativeTranscriptIfNeeded(
  params: Parameters<typeof pageCodexExternalSessionTranscript>[0],
  selection: Awaited<ReturnType<typeof resolveTranscriptStreams>>,
  follow: boolean,
): Promise<CodexExternalSessionTranscriptSourcePage | null> {
  const nativeCursor = decodeCodexNativeTranscriptCursor(params.cursor);
  // A rollout cursor identifies an existing file-backed conversation. Absence
  // after a complete inventory is removal, not a switch to native API history.
  if (!selection.streams.length && params.cursor &&
    (decodeCodexExternalBackwardCursor(params.cursor) || decodeCodexExternalForwardCursor(params.cursor)?.v === 7)) {
    if (!follow) throw new CodexExternalTranscriptSourceUnavailableError();
    return { items: [], nextCursor: null, tailCursor: null, truncated: false, readAfterOutcome: 'source_unavailable' };
  }
  const metadata = await Promise.all(selection.streams
    .map(stream => readCodexSessionMetaFromRollout(stream.filePath, params)));
  const hasPaginatedRollout = metadata.some(value => value?.history_mode === 'paginated');
  if (!nativeCursor && selection.streams.length && !hasPaginatedRollout) return null;
  const releasedForward = params.cursor ? decodeCodexExternalForwardCursor(params.cursor) : null;
  if (!nativeCursor && params.cursor && params.cursor !== 'tail'
    && (!follow || releasedForward?.kind === 'codexForwardStreamVector')) {
    return { items: [], nextCursor: null, tailCursor: null, truncated: true,
      ...(follow ? { readAfterOutcome: 'source_replaced' as const } : { hasMore: false }) };
  }
  const homes = await resolveHomeEntries(params);
  const selected = nativeCursor ? homes.filter(home => home.codexHome === nativeCursor.home)
    : selection.bestHome ? homes.filter(home => home.codexHome === selection.bestHome!.codexHome) : homes;
  if (!params.exec || !selected.length) throw new Error('Codex native history is unavailable');
  let failure: unknown = new Error('Codex native history is unavailable');
  for (const home of selected) {
    let client: Awaited<ReturnType<typeof createCodexNativeAppServerClient>> | undefined;
    try {
      throwIfCodexExternalSessionInvocationStopped(params);
      const requestOptions = () => ({ signal: params.signal,
        ...(params.deadlineAtMs === undefined ? {} : { timeoutMs: Math.max(1, params.deadlineAtMs - Date.now()) }) });
      const env = { ...process.env, ...params.env };
      const processEnv = { ...env, ...await resolveCodexRuntimeHomeEnvironment({ env, codexHome: home.codexHome, home: home.source.home,
        cwd: process.cwd(), expandHomePath: value => expandHomePath(value, resolveHomeDirFromEnvironment(env)) }) };
      client = await createCodexNativeAppServerClient({ exec: params.exec, logger: params.logger, processEnv, signal: params.signal,
        // History belongs to the selected native store, not a live Agent's
        // control socket. The runtime owns binary resolution and this client.
        transport: { kind: 'stdio' }, initializeRequestOptions: requestOptions() });
      const activeClient = client;
      const page = await pageCodexNativeTranscript({ ...params, hasPaginatedRollout, home: home.codexHome,
        client: { request: (method, value) => {
          throwIfCodexExternalSessionInvocationStopped(params);
          return activeClient.request(method, value, requestOptions());
        } }, cursor: nativeCursor ? params.cursor : undefined,
        direction: follow ? 'newer' : params.direction, tailOnly: follow && !nativeCursor });
      throwIfCodexExternalSessionInvocationStopped(params);
      if (params.cursor && params.cursor !== 'tail' && !nativeCursor) return { ...page, items: [], truncated: true,
        ...(follow ? { readAfterOutcome: 'gap_or_cursor_expired' as const } : {}) };
      return page;
    } catch (error) { failure = error; }
    finally { await client?.dispose(); }
  }
  throw failure;
}

export async function pageCodexExternalSessionTranscript(params: Readonly<{
  source: CodexExternalSessionSource;
  activeServerDir?: string;
  env: NodeJS.ProcessEnv;
  exec?: ExecService;
  remoteSessionId: string;
  sourceItemId?: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
}> & CodexExternalSessionInvocationBounds): Promise<CodexExternalSessionTranscriptSourcePage> {
  throwIfCodexExternalSessionInvocationStopped(params);
  const selection = await resolveTranscriptStreams(params);
  const nativePage = await readCodexNativeTranscriptIfNeeded({ ...params, direction: 'older' }, selection, false);
  if (nativePage) return nativePage;
  const { streams, resourceIdentity } = selection;
  throwIfCodexExternalSessionInvocationStopped(params);
  const tailCursor = resourceIdentity
    ? await buildTailCursorFromStreams(streams, resourceIdentity, params)
    : null;
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
  const rollbackStates = new Map<string, Readonly<{ initial: number; final: number; byOffset: ReadonlyMap<number, number> }>>();
  const originalEnds = new Map<string, number>();
  const scannedToStreamStart = new Set<string>();
  const unsupportedItemIds = new Set<string>();

  for (const stream of streams) {
    throwIfCodexExternalSessionInvocationStopped(params);
    const fileSize = await statFileSize(stream.filePath, params) ?? 0;
    const endOffsetBytes = Math.min(fileSize, Math.max(0, Math.trunc(endByStreamId.get(stream.fileRelPath) ?? fileSize)));
    const cursorStream = decoded?.streams.find((entry) => entry.fileRelPath === stream.fileRelPath);
    const initial = cursorStream?.rollbackTurns ?? 0;
    originalEnds.set(stream.fileRelPath, endOffsetBytes);
    if (endOffsetBytes <= 0) continue;
    const page = await readJsonlFileBackwardPage({
      filePath: stream.filePath,
      endOffsetBytes,
      maxBytes,
      maxItems: maxItems * 2,
      includeMalformedRecords: true,
      signal: params.signal,
      fileSystem: createCodexExternalSessionJsonlScannerFileSystem(params),
    });
    throwIfCodexExternalSessionInvocationStopped(params);
    if (page.diagnostics?.some((diagnostic) => diagnostic.code === 'malformed_source_utf8')) {
      throw new CodexExternalTranscriptReadError('page_scan', stream.filePath,
        page.diagnostics.find(diagnostic => diagnostic.code === 'malformed_source_utf8')!.positions[0] ?? page.nextEndOffsetBytes);
    }
    if (!page.reachedStart && page.nextEndOffsetBytes >= endOffsetBytes) {
      return { items: [], nextCursor: null, tailCursor, hasMore: false, truncated: true };
    }
    nextEnds.push({ fileRelPath: stream.fileRelPath, endOffsetBytes: page.nextEndOffsetBytes });
    if (page.reachedStart) scannedToStreamStart.add(stream.fileRelPath);

    const semanticTracker = createCodexRolloutSemanticTracker();
    const compactionFilter = await readCodexCompactionFilterAtBoundary({ ...params,
      filePath: stream.filePath, offsetBytes: endOffsetBytes, sourceSizeBytes: fileSize });
    const internalOffsets = new Set<number>();
    for (let index = page.items.length - 1; index >= 0; index -= 1) {
      const line = page.items[index]!;
      if (compactionFilter.isInternalInReverse(line.value)) internalOffsets.add(line.startOffsetBytes);
    }
    const rows: CodexProjectionRow<CodexProjectedTranscriptRecord>[] = [];
    let precedingTimestampMs = page.items[0] && readCodexRolloutLineTimestampMs(page.items[0].value) === null && !page.reachedStart
      ? await readPrecedingCodexRolloutTimestamp({ ...params, stream, beforeOffsetBytes: page.items[0].startOffsetBytes, maxBytes })
      : 0;
    for (const line of page.items) {
      throwIfCodexExternalSessionInvocationStopped(params);
      precedingTimestampMs = readCodexRolloutLineTimestampMs(line.value) ?? precedingTimestampMs;
      if (internalOffsets.has(line.startOffsetBytes)) continue;
      const projected = projectLine({
        stream,
        lineStartOffsetBytes: line.startOffsetBytes,
        lineEndOffsetBytes: line.endOffsetBytes,
        lineValue: line.value,
        semanticTracker,
        precedingTimestampMs,
      });
      if (projected.unsupportedRecord) {
        for (const record of projected.records) unsupportedItemIds.add(record.item.id);
      }
      rows.push({ startOffsetBytes: line.startOffsetBytes, records: projected.records, hasUser: projected.records.some((record) => record.item.raw.role === 'user'), rollbackCount: readCodexExternalRollbackCount(line.value) });
    }
    const selected = selectCodexExternalTranscriptRows(rows, initial);
    rollbackStates.set(stream.fileRelPath, { initial, final: selected.pendingTurns, byOffset: selected.rollbackTurnsByOffset });
    candidateRecords.push(...selected.records);
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
  const continuationEnds = streams.map((stream) => {
    const endOffsetBytes =
      selectedCutoffByStream.get(stream.fileRelPath)
      ?? (
        candidateRecords.some((record) => record.streamId === stream.fileRelPath)
          ? originalEnds.get(stream.fileRelPath) ?? 0
          : scannedEndByStream.get(stream.fileRelPath) ?? 0
      );
    const state = rollbackStates.get(stream.fileRelPath);
    return { fileRelPath: stream.fileRelPath, endOffsetBytes, rollbackTurns: endOffsetBytes === originalEnds.get(stream.fileRelPath) ? state?.initial ?? 0 : state?.byOffset.get(endOffsetBytes) ?? state?.final ?? 0 };
  });
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
  const unsupportedPositions = selected.filter((record) => unsupportedItemIds.has(record.item.id))
    .map((record) => record.lineStartOffsetBytes);
  return {
    items: selected.map((record) => record.item),
    nextCursor,
    tailCursor,
    hasMore,
    // A bounded selected window with an anchored continuation is ordinary
    // pagination, not a source truncation. The earlier missing-continuation
    // branch remains the fail-closed `truncated: true` outcome.
    truncated: false,
    ...(unsupportedPositions.length > 0 ? { diagnostics: [{ code: 'external_sessions_transcript_unsupported_record', severity: 'benign' as const, count: unsupportedPositions.length, positions: unsupportedPositions.slice(0, 200) }] } : {}),
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
  const selection = await resolveTranscriptStreams(params);
  const nativePage = await readCodexNativeTranscriptIfNeeded({ ...params, direction: 'older' }, selection, true);
  if (nativePage) return nativePage;
  const { streams, resourceIdentity } = selection;
  throwIfCodexExternalSessionInvocationStopped(params);
  const tailCursor = resourceIdentity
    ? await buildTailCursorFromStreams(streams, resourceIdentity, params)
    : null;
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
  const capturedTail = tailCursor ? decodeCodexExternalForwardCursor(tailCursor) : null;
  if (capturedTail?.v === 7 && decoded.streams.every(entry => entry.subIndex === 0
    && entry.nextOffsetBytes === capturedTail.streams.find(tail => tail.fileRelPath === entry.fileRelPath)?.nextOffsetBytes)) {
    return { items: [], nextCursor: params.cursor, tailCursor, truncated: false, readAfterOutcome: 'already_current' };
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
          semanticState: entry.semanticState,
        },
      ] as const),
  );
  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
  const maxItems = Math.max(1, Math.trunc(params.maxItems));
  const candidateRecords: CodexProjectedTranscriptRecord[] = [];
  const emptyScanAdvances = new Map<string, number>();
  const semanticPages = new Map<string, Readonly<{
    lines: readonly Readonly<{ value: unknown; startOffsetBytes: number; endOffsetBytes: number }>[];
    startState: CodexTranscriptSemanticCursor;
  }>>();
  const knownNonTranscriptPositionsByStream = new Map<string, number[]>();
  const unsupportedPositionsByStream = new Map<string, number[]>();
  const malformedSourceDiagnostics: Array<Readonly<{
    code: 'malformed_source_utf8';
    severity: 'required';
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
      semanticState: undefined,
    };
    const offsetBytes = progress.nextOffsetBytes;
    const page = await readJsonlFileForward({
      filePath: stream.filePath,
      offsetBytes,
      maxBytes,
      maxItems: maxItems * 2,
      includeMalformedRecords: true,
      signal: params.signal,
      fileSystem: createCodexExternalSessionJsonlScannerFileSystem(params),
    });
    throwIfCodexExternalSessionInvocationStopped(params);
    malformedSourceDiagnostics.push(...(page.diagnostics ?? []).map((diagnostic) => ({
      ...diagnostic,
      severity: 'required' as const,
    })));
    if (!page.reachedEnd || page.truncated) truncated = true;
    const retainedProjection = page.items.length > 0 ? await readCodexExternalTranscriptProjection({ ...params,
      maxBytes, stream, requestedOffsets: new Set(page.items.map(line => line.startOffsetBytes)), pageStartOffsetBytes: offsetBytes,
      pageEndOffsetBytes: page.nextOffsetBytes,
      semanticState: progress.semanticState }) : null;
    const retainedById = new Map(retainedProjection?.records.map(record => [record.item.id, record]));
    if (retainedProjection?.pageStartState) semanticPages.set(stream.fileRelPath, {
      lines: page.items, startState: retainedProjection.pageStartState,
    });
    let projectedCount = 0;
    const streamKnownNonTranscriptPositions: number[] = [];
    const streamUnsupportedPositions: number[] = [];
    const semanticContext = await restoreCodexTranscriptSemanticContext(stream, retainedProjection?.pageStartState ?? undefined, params);
    let cursorContinuationValidated = progress.subIndex === 0;
    for (const line of page.items) {
      throwIfCodexExternalSessionInvocationStopped(params);
      const projected = projectCodexTranscriptSemanticLine(stream, line, semanticContext);
      if (projected.unsupportedRecord) streamUnsupportedPositions.push(line.startOffsetBytes);
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
      const retainedRecords = records.flatMap(record => retainedById.get(record.item.id) ?? []);
      projectedCount += retainedRecords.length;
      candidateRecords.push(...retainedRecords);
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
  const nextProgressByStream = new Map<string, {
    nextOffsetBytes: number;
    subIndex: number;
    fingerprintOffsetBytes: number;
    semanticState?: CodexTranscriptSemanticCursor;
  }>(
    decoded.streams.map((entry) => [
      entry.fileRelPath,
      {
        nextOffsetBytes: entry.nextOffsetBytes,
        subIndex: entry.subIndex,
        fingerprintOffsetBytes: entry.fingerprintOffsetBytes,
        semanticState: entry.semanticState,
      },
    ] as const),
  );
  for (const [fileRelPath, nextOffsetBytes] of emptyScanAdvances) {
    nextProgressByStream.set(fileRelPath, {
      nextOffsetBytes,
      subIndex: 0,
      fingerprintOffsetBytes: nextOffsetBytes,
      semanticState: progressByStreamId.get(fileRelPath)?.semanticState,
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
  for (const entry of nextEntries) {
    const semanticPage = semanticPages.get(entry.fileRelPath);
    const stream = streams.find(stream => stream.fileRelPath === entry.fileRelPath);
    if (!semanticPage || !stream) continue;
    const context = await restoreCodexTranscriptSemanticContext(stream, semanticPage.startState, params);
    for (const line of semanticPage.lines) {
      if (line.endOffsetBytes > entry.nextOffsetBytes) break;
      throwIfCodexExternalSessionInvocationStopped(params);
      projectCodexTranscriptSemanticLine(stream, line, context);
    }
    entry.semanticState = snapshotCodexTranscriptSemanticContext(context);
  }
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
      || unsupportedPositions.length > 0
        ? {
          diagnostics: [
            ...malformedSourceDiagnostics,
            ...(unsupportedPositions.length > 0 ? [{ code: 'external_sessions_transcript_unsupported_record', severity: 'benign' as const, count: unsupportedPositions.length, positions: unsupportedPositions.slice(0, 200) }] : []),
            ...(knownNonTranscriptPositions.length > 0 ? [{
              code: 'non_transcript_record_skipped',
              severity: 'benign' as const,
              count: knownNonTranscriptPositions.length,
              positions: knownNonTranscriptPositions.slice(0, 200),
            }] : []),
          ],
        }
        : {}
    ),
  };
}
