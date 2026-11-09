import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { deriveExternalSessionActivity } from '@happier-dev/plugin-sdk/sessions/external';
import {
  createExternalSessionContentSearchControl,
  prefilterExternalSessionContentPaths,
  ExternalSessionContentSearchYield,
  type JsonlScannerFileSystem,
} from '@happier-dev/plugin-sdk/sessions/file-stores';
import {
  ClaudeCandidateSourceChangedError,
  findClaudeJsonlSessionsById,
  pageClaudeJsonlSessionFiles,
  type ClaudeJsonlSessionScanPosition,
  type DiscoveredClaudeJsonlSession,
  resolveClaudeJsonlSessionFile,
  isSafeClaudeJsonlPathSegment,
} from './files.js';
import {
  readClaudeJsonlSessionTitleWithIndex,
  type ClaudeTitleIndexState,
} from './metadata.js';
import type { ClaudeExternalSessionSource } from './source.js';
import type { AgentExternalSessionsInvocation } from '@happier-dev/plugin-sdk/sessions/external';
import { ClaudeContentSearchYield, parseClaudeContentSearchProgress, searchClaudeExternalTranscript, type ClaudeContentSearchProgress, type ClaudeContentSearchFileMetadata } from './transcript.js';
import { claudeContentSearchLinePatterns } from '../../../transcripts/projection.js';
import { readClaudeJsonlFileSize } from './files.js';
import { findExternalSessionContentMatchRange } from '@happier-dev/plugin-sdk/sessions/external';

export type ClaudeExternalSessionCandidate = Readonly<{
  remoteSessionId: string;
  title?: string;
  cwd?: string;
  messageCount?: number;
  updatedAtMs: number;
  createdAtMs?: number;
  activity?: ReturnType<typeof deriveExternalSessionActivity>;
  archived?: boolean;
  details: Readonly<{ projectId: string }>;
  candidateIndexState?: ClaudeTitleIndexState;
  match?: { snippet: string; sourceItemId: string; messageIndex: number };
}>;

type ClaudeCandidateSearchContext = Readonly<{
  searchTerm: string;
  searchMode: 'fast' | 'full';
  searchTarget: 'metadata' | 'content';
}>;

type ClaudeCandidateCursorV5 =
  | Readonly<{
      v: 5;
      kind: 'claudeCandidateIndexScan';
      sourceGeneration: string;
      scanPosition: ClaudeJsonlSessionScanPosition;
      scanned: number;
      search: ClaudeCandidateSearchContext;
    }>
  | Readonly<{
      v: 5;
      kind: 'claudeCandidateExactId';
      sourceGeneration: string;
      remoteSessionId: string;
      offset: number;
      search: ClaudeCandidateSearchContext;
    }>;

type ClaudeCandidateContentCursor = Readonly<{
  v: 7;
  kind: 'claudeCandidateContentScan';
  search: ClaudeCandidateSearchContext;
  startedAtMs: number;
  changedBeforeMs?: number;
  scanPosition: ClaudeJsonlSessionScanPosition | null;
  unfinished?: ClaudeJsonlSessionScanPosition;
  contentProgress?: ClaudeContentSearchProgress;
}>;

function encodeRecentPosition(position: ClaudeJsonlSessionScanPosition | null): unknown {
  return position?.recent ? [position.recent.updatedAtMs, position.projectId, position.recent.remoteSessionId] : null;
}

function decodeRecentPosition(value: unknown): ClaudeJsonlSessionScanPosition | null {
  if (!Array.isArray(value) || value.length !== 3 || !Number.isSafeInteger(value[0]) || value[0] < 0
    || typeof value[1] !== 'string' || !isSafeClaudeJsonlPathSegment(value[1])
    || typeof value[2] !== 'string' || !isSafeClaudeJsonlPathSegment(value[2])) return null;
  return { projectId: value[1], sessionEntryOffset: 0, recent: { updatedAtMs: value[0], remoteSessionId: value[2] } };
}

export type ClaudeCandidatePreparation = Readonly<{
  kind: 'building_candidate_index';
  scanned: number;
  total?: number;
}>;

export type ClaudeCandidateResultBudget = Readonly<{
  fits(
    candidates: readonly ClaudeExternalSessionCandidate[],
    nextCursor: string | null,
    searchIncomplete: boolean | undefined,
    preparation: ClaudeCandidatePreparation | undefined,
  ): boolean;
}>;

export class ClaudeCandidateResultBudgetTooSmallError extends Error {
  readonly name = 'ClaudeCandidateResultBudgetTooSmallError';
}

export { ClaudeCandidateSourceChangedError } from './files.js';

export class ClaudeCandidateInvalidCursorError extends Error {
  readonly name = 'ClaudeCandidateInvalidCursorError';
}

function encodeCandidateCursor(cursor: ClaudeCandidateCursorV5 | ClaudeCandidateContentCursor): string {
  const searchMode = cursor.search.searchMode === 'fast' ? 'f' : 'l';
  if (cursor.kind === 'claudeCandidateContentScan') {
    return Buffer.from(JSON.stringify([7, cursor.search.searchTerm, searchMode, cursor.startedAtMs,
      cursor.changedBeforeMs ?? null, encodeRecentPosition(cursor.scanPosition),
      ...(cursor.unfinished && cursor.contentProgress ? [encodeRecentPosition(cursor.unfinished), cursor.contentProgress] : []),
    ]), 'utf8').toString('base64url');
  }
  const value =
    cursor.kind === 'claudeCandidateIndexScan'
      ? [
          5,
          cursor.sourceGeneration,
          cursor.scanPosition.projectId,
          cursor.scanPosition.sessionEntryOffset,
          cursor.scanned,
          cursor.search.searchTerm,
          searchMode,
          cursor.search.searchTarget,
        ]
      : [
          5,
          'e',
          cursor.sourceGeneration,
          cursor.remoteSessionId,
          cursor.offset,
          cursor.search.searchTerm,
          searchMode,
          cursor.search.searchTarget,
        ];
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCandidateCursor(
  raw: string | undefined,
): ClaudeCandidateCursorV5 | ClaudeCandidateContentCursor | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as unknown;
    if (Array.isArray(parsed) && parsed[0] === 7 && (parsed.length === 6 || parsed.length === 8)) {
      const searchMode = parsed[2] === 'f' ? 'fast' : parsed[2] === 'l' ? 'full' : null;
      const scanPosition = decodeRecentPosition(parsed[5]);
      const unfinished = parsed.length === 8 ? decodeRecentPosition(parsed[6]) : undefined;
      const contentProgress = parsed.length === 8 ? parseClaudeContentSearchProgress(parsed[7]) : undefined;
      if (typeof parsed[1] !== 'string' || !searchMode || !Number.isSafeInteger(parsed[3]) || parsed[3] < 0
        || (parsed[4] !== null && (!Number.isSafeInteger(parsed[4]) || parsed[4] < parsed[3]))
        || (parsed[5] !== null && !scanPosition) || (parsed.length === 8 && (!unfinished || !contentProgress))) return null;
      return { v: 7, kind: 'claudeCandidateContentScan', startedAtMs: parsed[3],
        ...(parsed[4] === null ? {} : { changedBeforeMs: parsed[4] }), scanPosition,
        search: { searchTerm: parsed[1], searchMode, searchTarget: 'content' },
        ...(unfinished && contentProgress ? { unfinished, contentProgress } : {}),
      };
    }
    // Intermediate development content cursors have no compatibility obligation.
    if (!Array.isArray(parsed) || parsed.length !== 8 || parsed[0] !== 5 || parsed[7] !== 'metadata') return null;
    const searchMode =
      parsed[6] === 'f' ? 'fast' : parsed[6] === 'l' ? 'full' : null;
    if (
      typeof parsed[5] !== 'string' ||
      !searchMode
    )
      return null;
    const search: ClaudeCandidateSearchContext = {
      searchTerm: parsed[5],
      searchMode,
      searchTarget: parsed[7],
    };
    if (
      parsed.length === 8 && parsed[1] === 'e' &&
      typeof parsed[2] === 'string' &&
      parsed[2].length > 0 &&
      typeof parsed[3] === 'string' &&
      parsed[3].length > 0 &&
      Number.isSafeInteger(parsed[4]) &&
      (parsed[4] as number) >= 0
    ) {
      return {
        v: 5,
        kind: 'claudeCandidateExactId',
        sourceGeneration: parsed[2],
        remoteSessionId: parsed[3],
        offset: parsed[4] as number,
        search,
      };
    }
    const position = [parsed[3]];
    return typeof parsed[1] === 'string' &&
      parsed[1].length > 0 &&
      typeof parsed[2] === 'string' &&
      parsed[2].length > 0 &&
      Number.isSafeInteger(position[0]) &&
      (position[0] as number) >= 0 &&
      Number.isSafeInteger(parsed[4]) &&
      (parsed[4] as number) >= 0
      ? {
          v: 5,
          kind: 'claudeCandidateIndexScan',
          sourceGeneration: parsed[1],
          scanPosition: {
            projectId: parsed[2],
            sessionEntryOffset: position[0] as number,
          },
          scanned: parsed[4] as number,
          search,
        }
      : null;
  } catch {
    return null;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function canSearchClaudeFilename(searchTerm: string): boolean {
  return (
    searchTerm.length > 0 &&
    !searchTerm.includes('/') &&
    !searchTerm.includes('\\') &&
    !searchTerm.endsWith('.jsonl')
  );
}

function normalizeCandidateSearchContext(
  params: Readonly<{
    searchTerm?: string;
    searchMode?: 'fast' | 'full';
    searchTarget?: 'metadata' | 'content';
  }>,
): ClaudeCandidateSearchContext {
  return {
    searchTerm:
      typeof params.searchTerm === 'string'
        ? (params.searchTarget === 'content'
            ? params.searchTerm
            : params.searchTerm.trim()
          ).toLowerCase()
        : '',
    searchMode: params.searchMode === 'fast' ? 'fast' : 'full',
    searchTarget: params.searchTarget === 'content' ? 'content' : 'metadata',
  };
}

async function buildCandidate(
  params: Readonly<{
    session: DiscoveredClaudeJsonlSession;
    env: NodeJS.ProcessEnv;
    includeTitle: boolean;
    readCandidateIndexState?: (
      candidate: Readonly<{
        remoteSessionId: string;
        projectId: string;
      }>,
    ) => unknown;
    signal?: AbortSignal;
    fileSystem?: JsonlScannerFileSystem;
  }>,
): Promise<ClaudeExternalSessionCandidate> {
  throwIfAborted(params.signal);
  const indexedTitle = params.includeTitle
    ? await readClaudeJsonlSessionTitleWithIndex({
        filePath: params.session.filePath,
        remoteSessionId: params.session.remoteSessionId,
        previousState: params.readCandidateIndexState?.({
          remoteSessionId: params.session.remoteSessionId,
          projectId: params.session.projectId,
        }),
        fileSystem: params.fileSystem,
      }).catch(() => null)
    : null;
  throwIfAborted(params.signal);

  return {
    remoteSessionId: params.session.remoteSessionId,
    ...(indexedTitle?.title ? { title: indexedTitle.title } : {}),
    ...(indexedTitle?.cwd ? { cwd: indexedTitle.cwd } : {}),
    updatedAtMs: params.session.updatedAtMs,
    activity: deriveExternalSessionActivity({
      updatedAtMs: params.session.updatedAtMs,
      env: params.env,
    }),
    details: { projectId: params.session.projectId },
    ...(indexedTitle && params.readCandidateIndexState
      ? { candidateIndexState: indexedTitle.indexState }
      : {}),
  };
}

function buildMetadataCandidate(
  params: Readonly<{
    session: DiscoveredClaudeJsonlSession;
    env: NodeJS.ProcessEnv;
  }>,
): ClaudeExternalSessionCandidate {
  return {
    remoteSessionId: params.session.remoteSessionId,
    updatedAtMs: params.session.updatedAtMs,
    activity: deriveExternalSessionActivity({
      updatedAtMs: params.session.updatedAtMs,
      env: params.env,
    }),
    details: { projectId: params.session.projectId },
  };
}

/**
 * A title is optional enrichment of a row the current source chunk already
 * selected. Admit the identifier-only row against the real response budget
 * before opening its transcript; if its title will not fit, preserve that
 * admitted row without inventing a substitute.
 */
async function buildCandidateForSelectedRow(
  params: Readonly<{
    session: DiscoveredClaudeJsonlSession;
    env: NodeJS.ProcessEnv;
    page: readonly ClaudeExternalSessionCandidate[];
    nextCursor: string | null;
    searchIncomplete?: boolean;
    preparation?: ClaudeCandidatePreparation;
    resultBudget?: ClaudeCandidateResultBudget;
    readCandidateIndexState?: (
      candidate: Readonly<{
        remoteSessionId: string;
        projectId: string;
      }>,
    ) => unknown;
    signal?: AbortSignal;
  }>,
): Promise<
  Readonly<{
    candidate: ClaudeExternalSessionCandidate;
    fits: boolean;
  }>
> {
  const identifierOnly = buildMetadataCandidate({
    session: params.session,
    env: params.env,
  });
  if (
    params.resultBudget &&
    !params.resultBudget.fits(
      [...params.page, identifierOnly],
      params.nextCursor,
      params.searchIncomplete,
      params.preparation,
    )
  ) {
    return { candidate: identifierOnly, fits: false };
  }
  const enriched = await buildCandidate({
    session: params.session,
    env: params.env,
    includeTitle: true,
    ...(params.readCandidateIndexState
      ? { readCandidateIndexState: params.readCandidateIndexState }
      : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (
    !params.resultBudget ||
    params.resultBudget.fits(
      [...params.page, enriched],
      params.nextCursor,
      params.searchIncomplete,
      params.preparation,
    )
  ) {
    return { candidate: enriched, fits: true };
  }
  return { candidate: identifierOnly, fits: true };
}

export async function listClaudeExternalSessionCandidates(
  params: Readonly<{
    source: ClaudeExternalSessionSource;
    env: NodeJS.ProcessEnv;
    cursor?: string;
    limit: number;
    searchTerm?: string;
    searchMode?: 'fast' | 'full';
    searchTarget?: 'metadata' | 'content';
    updatedAfterMs?: number;
    includeTitles?: boolean;
    ripgrep?: AgentExternalSessionsInvocation['ripgrep'];
    logger?: AgentExternalSessionsInvocation['logger'];
    signal?: AbortSignal;
    deadlineAtMs?: number;
    resultBudget?: ClaudeCandidateResultBudget;
    readCandidateIndexState?: (
      candidate: Readonly<{
        remoteSessionId: string;
        projectId: string;
      }>,
    ) => unknown;
  }>,
): Promise<
  Readonly<{
    candidates: ClaudeExternalSessionCandidate[];
    nextCursor: string | null;
    searchIncomplete?: boolean;
    preparation?: ClaudeCandidatePreparation;
    contentCoverage?: 'complete' | 'partial' | 'unsupported';
  }>
> {
  throwIfAborted(params.signal);
  const limit = Math.max(1, Math.trunc(params.limit));
  const rawSearchTerm =
    typeof params.searchTerm === 'string' ? params.searchTerm.trim() : '';
  const search = normalizeCandidateSearchContext(params);
  const searchTerm = search.searchTerm;
  const contentFileSystem =
    search.searchTarget === 'content'
      ? createExternalSessionContentSearchControl(params)
      : undefined;
  const suppliedCursor = params.cursor
    ? decodeCandidateCursor(params.cursor)
    : null;
  if (params.cursor && !suppliedCursor) {
    if (search.searchTarget === 'content') {
      throw new ClaudeCandidateSourceChangedError('external_sessions_content_cursor_invalid');
    }
    throw new ClaudeCandidateInvalidCursorError('Claude candidate cursor is invalid.');
  }
  if (
    suppliedCursor &&
    (suppliedCursor.search.searchTerm !== search.searchTerm ||
      suppliedCursor.search.searchMode !== search.searchMode ||
      suppliedCursor.search.searchTarget !== search.searchTarget)
  ) {
    throw new ClaudeCandidateInvalidCursorError(
      'Claude candidate cursor does not match the current search.',
    );
  }
  const contentCursor = suppliedCursor?.kind === 'claudeCandidateContentScan' ? suppliedCursor : null;
  const decodedCursor = suppliedCursor?.kind === 'claudeCandidateContentScan' ? null : suppliedCursor;
  const startedAtMs = contentCursor?.startedAtMs ?? Date.now();

  if (
    search.searchTarget === 'metadata' &&
    searchTerm &&
    canSearchClaudeFilename(rawSearchTerm)
  ) {
    const exactFilenameSnapshot = await findClaudeJsonlSessionsById({
      source: params.source,
      env: params.env,
      remoteSessionId: rawSearchTerm,
      signal: params.signal,
    });
    const exactFilenameMatches = exactFilenameSnapshot.matches;
    if (exactFilenameMatches.length > 0) {
      if (
        decodedCursor &&
        (decodedCursor.kind !== 'claudeCandidateExactId' ||
          decodedCursor.remoteSessionId !== rawSearchTerm)
      ) {
        throw new ClaudeCandidateInvalidCursorError(
          'Claude exact-id candidate cursor does not match the current search.',
        );
      }
      if (
        decodedCursor?.kind === 'claudeCandidateExactId' &&
        decodedCursor.sourceGeneration !==
          exactFilenameSnapshot.sourceGeneration
      ) {
        throw new ClaudeCandidateSourceChangedError(
          'external_sessions_exact_id_source_changed',
        );
      }
      const offset =
        decodedCursor?.kind === 'claudeCandidateExactId'
          ? decodedCursor.offset
          : 0;
      if (offset >= exactFilenameMatches.length) {
        throw new ClaudeCandidateInvalidCursorError(
          'Claude exact-id candidate cursor is outside the current result set.',
        );
      }
      const pageSessions = exactFilenameMatches.slice(offset, offset + limit);
      const page: ClaudeExternalSessionCandidate[] = [];
      for (let index = 0; index < pageSessions.length; index += 1) {
        const session = pageSessions[index];
        if (!session) continue;
        const nextOffset = offset + index + 1;
        const candidateCursor =
          nextOffset < exactFilenameMatches.length
            ? encodeCandidateCursor({
                v: 5,
                kind: 'claudeCandidateExactId',
                sourceGeneration: exactFilenameSnapshot.sourceGeneration,
                remoteSessionId: rawSearchTerm,
                offset: nextOffset,
                search,
              })
            : null;
        const selected = await buildCandidateForSelectedRow({
          session,
          env: params.env,
          page,
          nextCursor: candidateCursor,
          ...(params.resultBudget ? { resultBudget: params.resultBudget } : {}),
          ...(params.readCandidateIndexState
            ? { readCandidateIndexState: params.readCandidateIndexState }
            : {}),
          ...(params.signal ? { signal: params.signal } : {}),
        });
        if (selected.fits) {
          page.push(selected.candidate);
          continue;
        }
        const continuation = encodeCandidateCursor({
          v: 5,
          kind: 'claudeCandidateExactId',
          sourceGeneration: exactFilenameSnapshot.sourceGeneration,
          remoteSessionId: rawSearchTerm,
          offset: offset + index,
          search,
        });
        if (
          page.length === 0 &&
          !params.resultBudget?.fits([], continuation, undefined, undefined)
        ) {
          throw new ClaudeCandidateResultBudgetTooSmallError(
            'Claude candidate result byte budget cannot fit the continuation envelope.',
          );
        }
        return { candidates: page, nextCursor: continuation };
      }
      const nextOffset = offset + pageSessions.length;
      return {
        candidates: page,
        nextCursor:
          nextOffset < exactFilenameMatches.length
            ? encodeCandidateCursor({
                v: 5,
                kind: 'claudeCandidateExactId',
                sourceGeneration: exactFilenameSnapshot.sourceGeneration,
                remoteSessionId: rawSearchTerm,
                offset: nextOffset,
                search,
              })
            : null,
      };
    }
  }

  if (decodedCursor?.kind === 'claudeCandidateExactId') {
    throw new ClaudeCandidateSourceChangedError(
      'external_sessions_exact_id_source_changed',
    );
  }
  if (search.searchTarget === 'content' && !params.ripgrep) {
    return { candidates: [], nextCursor: null, contentCoverage: 'unsupported' };
  }
  const scanPosition =
    decodedCursor?.kind === 'claudeCandidateIndexScan'
      ? decodedCursor.scanPosition
      : contentCursor?.scanPosition ?? null;
  // Recency needs the native file metadata set, never its transcript bodies.
  // Reuse that one listing for this content page instead of restatting it
  // for each hit-sized chunk. Returned hits keep the existing page budget.
  const scanLimit = search.searchTarget === 'content'
    ? Number.POSITIVE_INFINITY : limit;
  const traversed = await pageClaudeJsonlSessionFiles({
    source: params.source, env: params.env, scanPosition, skip: 0, limit: scanLimit,
    ...(params.updatedAfterMs === undefined ? {} : { updatedAfterMs: params.updatedAfterMs }),
    ...(search.searchTarget === 'content' ? { order: 'recent' as const,
      recentWindow: { startedAtMs, changedBeforeMs: contentCursor?.changedBeforeMs },
      unfinished: contentCursor?.unfinished,
    } : {}),
    signal: params.signal,
  });
  const encodeScanCursor = (resume: Extract<ClaudeCandidateCursorV5, { kind: 'claudeCandidateIndexScan' }>
    & { contentProgress?: ClaudeContentSearchProgress; unfinished?: ClaudeJsonlSessionScanPosition }) =>
    encodeCandidateCursor(search.searchTarget === 'content'
      ? { v: 7, kind: 'claudeCandidateContentScan', search, startedAtMs,
          changedBeforeMs: contentCursor?.changedBeforeMs,
          scanPosition: resume.scanPosition.recent ? resume.scanPosition : null,
          ...(resume.contentProgress && resume.unfinished ? { contentProgress: resume.contentProgress, unfinished: resume.unfinished } : {}),
        }
      : resume);
  // Capture T1 only after finishing the main pass. No later write can move a
  // file back into this final pass; the next fresh search covers writes after T1.
  let endContentCursor: Promise<string | null> | undefined;
  const finishContentPass = (): Promise<string | null> => endContentCursor ??= (async () => {
    if (search.searchTarget !== 'content' || contentCursor?.changedBeforeMs !== undefined) return null;
    const changedBeforeMs = Date.now();
    const changed = await pageClaudeJsonlSessionFiles({ source: params.source, env: params.env, limit: 1,
      order: 'recent', recentWindow: { startedAtMs, changedBeforeMs }, signal: params.signal });
    return changed.entries.length ? encodeCandidateCursor({ v: 7, kind: 'claudeCandidateContentScan',
      search, startedAtMs, changedBeforeMs, scanPosition: null }) : null;
  })();
  let contentPartial = false;
  if (
    decodedCursor?.kind === 'claudeCandidateIndexScan' &&
    decodedCursor.sourceGeneration !== traversed.sourceGeneration
  ) {
    throw new ClaudeCandidateSourceChangedError(
      'external_sessions_frontier_anchor',
    );
  }
  const scannedBefore =
    decodedCursor?.kind === 'claudeCandidateIndexScan'
      ? decodedCursor.scanned
      : 0;
  const scanned = scannedBefore + traversed.scanned;
  const preparation: ClaudeCandidatePreparation | undefined = searchTerm
    ? undefined
    : {
        kind: 'building_candidate_index',
        scanned,
      };
  const searchIncomplete = searchTerm
    ? (search.searchTarget === 'metadata' && search.searchMode === 'fast') ||
      traversed.hasMore
      ? true
      : undefined
    : undefined;
  const page: ClaudeExternalSessionCandidate[] = [];
  let prefilteredPaths: ReadonlySet<string> | ReadonlyMap<string, readonly number[]> | null = null;
  let prefilteredLineOffsets: ReadonlyMap<string, readonly number[]> | null = null;
  let prefilterMetadata = new Map<string, ClaudeContentSearchFileMetadata>();
  const linePatterns = search.searchTarget === 'content'
    ? claudeContentSearchLinePatterns(searchTerm, text => findExternalSessionContentMatchRange(text, searchTerm) ? text : null) : null;
  const prefilterBatch = async (startIndex: number) => {
    throwIfAborted(params.signal);
    const entries = traversed.entries.slice(startIndex, startIndex + limit);
    const metadata = new Map(await Promise.all(entries.map(async entry =>
      [entry.filePath, await stat(entry.filePath, { bigint: true })] as const)));
    throwIfAborted(params.signal);
    const offsets = linePatterns === null ? null : await prefilterExternalSessionContentPaths({
      query: searchTerm, paths: entries.map(entry => entry.filePath),
      ripgrep: params.ripgrep!, signal: params.signal, logger: params.logger,
      lineOffsets: true, additionalLinePatterns: linePatterns,
    });
    return { metadata, offsets };
  };
  // Observe a speculative failure immediately, even if the current batch fills
  // the page. The host cancels invocation-owned native work on settlement.
  const admitPrefilter = (startIndex: number) => prefilterBatch(startIndex).then(
    value => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
  let lookahead: { startIndex: number; result: ReturnType<typeof admitPrefilter> } | undefined;
  let prefilteredThroughIndex = 0;
  let previousScanPosition = scanPosition;
  let previousSourceGeneration = traversed.sourceGeneration;
  let fileStartedAtMs: number | undefined;
  let longestFileDurationMs = 0;

  for (let traversalIndex = 0; traversalIndex < traversed.entries.length; traversalIndex += 1) {
    const session = traversed.entries[traversalIndex];
    if (!session) continue;
    throwIfAborted(params.signal);
    const cursorBefore = previousScanPosition
      ? encodeScanCursor({
          v: 5,
          kind: 'claudeCandidateIndexScan',
          sourceGeneration: previousSourceGeneration,
          scanPosition: previousScanPosition,
          scanned: scannedBefore + traversalIndex,
          search,
          ...(traversalIndex === 0 && contentCursor?.contentProgress ? {
            contentProgress: contentCursor.contentProgress, unfinished: contentCursor.unfinished,
          } : {}),
        })
      : encodeScanCursor({
          v: 5,
          kind: 'claudeCandidateIndexScan',
          sourceGeneration: traversed.sourceGeneration,
          scanPosition: { projectId: session.projectId, sessionEntryOffset: 0 },
          scanned: scannedBefore + traversalIndex,
          search,
          ...(traversalIndex === 0 && contentCursor?.contentProgress ? {
            contentProgress: contentCursor.contentProgress, unfinished: contentCursor.unfinished,
          } : {}),
        });
    if (
      search.searchTarget === 'content' &&
      params.deadlineAtMs !== undefined
    ) {
      const nowMs = Date.now();
      if (fileStartedAtMs !== undefined) {
        longestFileDurationMs = Math.max(
          longestFileDurationMs,
          nowMs - fileStartedAtMs,
        );
      }
      // Reuse the host deadline. The completed file's measured cost tells
      // us whether another unit fits; there is no subordinate timeout.
      if (
        cursorBefore &&
        fileStartedAtMs !== undefined &&
        params.deadlineAtMs - nowMs <= longestFileDurationMs
      ) {
        if (
          params.resultBudget &&
          !params.resultBudget.fits(
            page,
            cursorBefore,
            searchIncomplete,
            preparation,
          )
        ) {
          throw new ClaudeCandidateResultBudgetTooSmallError(
            'Claude candidate result byte budget cannot fit the continuation envelope.',
          );
        }
        return {
          candidates: page,
          nextCursor: cursorBefore,
          contentCoverage: 'partial',
          ...(searchIncomplete !== undefined ? { searchIncomplete } : {}),
        };
      }
      fileStartedAtMs = nowMs;
    }
    previousScanPosition = session.scanPosition;
    previousSourceGeneration = session.sourceGeneration;
    if (search.searchTarget === 'content' && !(traversalIndex === 0 && contentCursor?.contentProgress)) {
      if (traversalIndex >= prefilteredThroughIndex) {
        const current = lookahead?.startIndex === traversalIndex
          ? lookahead.result : admitPrefilter(traversalIndex);
        lookahead = undefined;
        const nextIndex = traversalIndex + limit;
        // Keep the first batch serial for an immediately full page. Once it
        // needs more results, pipeline the current batch with just its successor;
        // ordered decoding alone advances the frontier. Reuse the containing
        // deadline and measured file cost for this admission too.
        if (traversalIndex > 0 && nextIndex < traversed.entries.length &&
          (params.deadlineAtMs === undefined || params.deadlineAtMs - Date.now() > longestFileDurationMs)) {
          lookahead = { startIndex: nextIndex, result: admitPrefilter(nextIndex) };
        }
        const outcome = await current;
        if (outcome.status === 'rejected') throw outcome.reason;
        const prefilter = outcome.value;
        prefilteredThroughIndex = traversalIndex + limit;
        prefilterMetadata = prefilter.metadata;
        prefilteredLineOffsets = prefilter.offsets;
        // Generated display markers are absent from native bytes. A query
        // requiring exact decoding cannot be excluded by a raw-file prefilter.
        prefilteredPaths = prefilteredLineOffsets;
      }
      if (prefilteredPaths !== null && !prefilteredPaths.has(session.filePath)) {
        params.logger?.debug('claude.content_search.file', {
          file: basename(session.filePath), sourceBytes: Number(prefilterMetadata.get(session.filePath)?.size ?? 0),
          admissionMode: 'file_excluded', fallbackReason: 'none', rowsDecoded: 0, rowsSkipped: 0,
          bytesScanned: 0, diagnostics: 0, unsupportedRows: 0, partial: false, elapsedMs: 0,
        });
        continue;
      }
    }
    let candidate: ClaudeExternalSessionCandidate;
    let needsSelectedRowTitle = false;
    if (search.searchTarget === 'content') {
      try {
        if (!searchTerm) continue;
        // Cursor metadata names native refs; it never grants a file path.
        const authorizedSession = await resolveClaudeJsonlSessionFile({
          source: { ...params.source, projectId: session.projectId }, env: params.env,
          remoteSessionId: session.remoteSessionId, signal: params.signal,
        });
        if (!authorizedSession) throw new ClaudeCandidateSourceChangedError('external_sessions_path_authority');
        const projection = await searchClaudeExternalTranscript({
          prefiltered: true,
          filePath: authorizedSession.filePath,
          fileRelPath: `${session.projectId}/${session.remoteSessionId}.jsonl`,
          query: searchTerm,
          // Source record span and serialized result size are different
          // resources: decode one real row, then pack its hit context.
          maxBytes: Math.max(
            1,
            await readClaudeJsonlFileSize(authorizedSession.filePath, params.signal),
          ),
          signal: params.signal,
          ripgrep: params.ripgrep!,
          control: contentFileSystem!,
          logger: params.logger,
          ...(prefilterMetadata.has(session.filePath) ? { prefilterMetadata: prefilterMetadata.get(session.filePath) } : {}),
          ...(prefilteredLineOffsets ? { candidateByteOffsets: prefilteredLineOffsets.get(session.filePath) ?? [] } : {}),
          ...(traversalIndex === 0 && contentCursor?.contentProgress
            ? { progress: contentCursor.contentProgress } : {}),
        });
        contentFileSystem?.assertNotYielded();
        contentPartial ||= projection.partial;
        if (!projection.match) continue;
        candidate = {
          ...buildMetadataCandidate({
            session,
            env: params.env,
          }),
          ...(projection.title ? { title: projection.title } : {}),
          ...(projection.cwd ? { cwd: projection.cwd } : {}),
          ...(projection.messageCount !== undefined ? { messageCount: projection.messageCount } : {}),
          match: projection.match,
        };
      } catch (error) {
        if (!(error instanceof ExternalSessionContentSearchYield)) throw error;
        const before = decodeCandidateCursor(cursorBefore);
        const continuation = error instanceof ClaudeContentSearchYield && before?.kind === 'claudeCandidateContentScan'
          ? encodeCandidateCursor({ ...before, unfinished: session.scanPosition, contentProgress: error.progress }) : cursorBefore;
        if (
          params.resultBudget &&
          !params.resultBudget.fits(page, continuation, true, undefined)
        ) {
          throw new ClaudeCandidateResultBudgetTooSmallError(
            'Claude candidate result byte budget cannot fit the continuation envelope.',
          );
        }
        return {
          candidates: page,
          nextCursor: continuation,
          contentCoverage: 'partial',
          searchIncomplete: true,
        };
      }
    } else if (!searchTerm) {
      candidate = buildMetadataCandidate({ session, env: params.env });
      needsSelectedRowTitle = params.includeTitles !== false;
    } else if (search.searchMode === 'fast') {
      const haystack =
        `${session.remoteSessionId} ${session.projectId}`.toLowerCase();
      if (!haystack.includes(searchTerm)) continue;
      candidate = buildMetadataCandidate({ session, env: params.env });
      needsSelectedRowTitle = true;
    } else {
      candidate = await buildCandidate({
        session,
        env: params.env,
        includeTitle: true,
        ...(params.readCandidateIndexState
          ? { readCandidateIndexState: params.readCandidateIndexState }
          : {}),
        signal: params.signal,
      });
      if (searchTerm) {
        const details = candidate.details as
          | Record<string, unknown>
          | undefined;
        const projectId =
          typeof details?.projectId === 'string' ? details.projectId : '';
        const title =
          typeof candidate.title === 'string' ? candidate.title : '';
        const haystack =
          `${candidate.remoteSessionId} ${projectId} ${title}`.toLowerCase();
        if (!haystack.includes(searchTerm)) continue;
      }
    }

    const cursorAfter =
      traversalIndex < traversed.entries.length - 1 || traversed.hasMore
        ? encodeScanCursor({
            v: 5,
            kind: 'claudeCandidateIndexScan',
            sourceGeneration: session.sourceGeneration,
            scanPosition: session.scanPosition,
            scanned: scannedBefore + traversalIndex + 1,
            search,
          })
        : await finishContentPass();
    if (candidate.match && params.resultBudget) {
      const original = candidate;
      const match = candidate.match;
      const hit = findExternalSessionContentMatchRange(
        match.snippet,
        searchTerm,
      );
      const fits = (snippet: string) => {
        const withSnippet = { ...original, match: { ...match, snippet } };
        const { title: _title, ...withoutTitle } = withSnippet;
        return (
          params.resultBudget!.fits(
            [...page, withSnippet],
            cursorAfter,
            searchIncomplete,
            preparation,
          ) ||
          params.resultBudget!.fits(
            [...page, withoutTitle],
            cursorAfter,
            searchIncomplete,
            preparation,
          )
        );
      };
      if (hit && !fits(match.snippet)) {
        const contextSnippet = (context: number) => {
          let start = Math.max(0, hit.start - context);
          let end = Math.min(match.snippet.length, hit.end + context);
          if (start > 0 && /[\uDC00-\uDFFF]/.test(match.snippet[start]!))
            start -= 1;
          if (
            end < match.snippet.length &&
            /[\uD800-\uDBFF]/.test(match.snippet[end - 1]!)
          )
            end += 1;
          return match.snippet.slice(start, end);
        };
        let lower = 0;
        let upper = match.snippet.length;
        while (lower < upper) {
          const middle = Math.ceil((lower + upper) / 2);
          if (fits(contextSnippet(middle))) lower = middle;
          else upper = middle - 1;
        }
        candidate = {
          ...original,
          match: { ...match, snippet: contextSnippet(lower) },
        };
      }
    }

    if (needsSelectedRowTitle) {
      const selected = await buildCandidateForSelectedRow({
        session,
        env: params.env,
        page,
        nextCursor: cursorAfter,
        ...(searchIncomplete !== undefined ? { searchIncomplete } : {}),
        ...(preparation !== undefined ? { preparation } : {}),
        ...(params.resultBudget ? { resultBudget: params.resultBudget } : {}),
        ...(params.readCandidateIndexState
          ? { readCandidateIndexState: params.readCandidateIndexState }
          : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      if (selected.fits) {
        page.push(selected.candidate);
      } else {
        const continuation = cursorBefore;
        if (page.length === 0) {
          throw new ClaudeCandidateResultBudgetTooSmallError(
            'Claude candidate result byte budget cannot fit one candidate.',
          );
        }
        if (!continuation) {
          throw new ClaudeCandidateResultBudgetTooSmallError(
            'Claude candidate result byte budget cannot preserve the continuation cursor.',
          );
        }
        return {
          candidates: page,
          nextCursor: continuation,
          ...(search.searchTarget === 'content'
            ? { contentCoverage: 'partial' as const }
            : {}),
          ...(searchIncomplete !== undefined ? { searchIncomplete } : {}),
          ...(preparation !== undefined ? { preparation } : {}),
        };
      }
    } else {
      const withTitle = [...page, candidate];
      if (
        !params.resultBudget ||
        params.resultBudget.fits(
          withTitle,
          cursorAfter,
          searchIncomplete,
          preparation,
        )
      ) {
        page.push(candidate);
      } else {
        const { title: _discardedTitle, ...candidateWithoutTitle } = candidate;
        const withoutTitle = [...page, candidateWithoutTitle];
        if (
          params.resultBudget.fits(
            withoutTitle,
            cursorAfter,
            searchIncomplete,
            preparation,
          )
        ) {
          page.push(candidateWithoutTitle);
        } else {
          const continuation = cursorBefore;
          if (page.length === 0) {
            throw new ClaudeCandidateResultBudgetTooSmallError(
              'Claude candidate result byte budget cannot fit one candidate.',
            );
          }
          if (!continuation) {
            throw new ClaudeCandidateResultBudgetTooSmallError(
              'Claude candidate result byte budget cannot preserve the continuation cursor.',
            );
          }
          return {
            candidates: page,
            nextCursor: continuation,
            ...(search.searchTarget === 'content'
              ? { contentCoverage: 'partial' as const }
              : {}),
            ...(searchIncomplete !== undefined ? { searchIncomplete } : {}),
            ...(preparation !== undefined ? { preparation } : {}),
          };
        }
      }
    }

    if (page.length >= limit) {
      return {
        candidates: page,
        nextCursor: cursorAfter,
        ...(search.searchTarget === 'content'
          ? {
              contentCoverage:
                contentPartial || cursorAfter
                  ? ('partial' as const)
                  : ('complete' as const),
            }
          : {}),
        ...(searchIncomplete !== undefined ? { searchIncomplete } : {}),
        ...(preparation !== undefined ? { preparation } : {}),
      };
    }
  }

  const nextCursor =
    traversed.hasMore && traversed.nextScanPoint
      ? encodeScanCursor({
          v: 5,
          kind: 'claudeCandidateIndexScan',
          sourceGeneration: traversed.nextScanPoint.sourceGeneration,
          scanPosition: traversed.nextScanPoint.scanPosition,
          scanned,
          search,
        })
      : await finishContentPass();
  if (
    params.resultBudget &&
    !params.resultBudget.fits(page, nextCursor, searchIncomplete, preparation)
  ) {
    throw new ClaudeCandidateResultBudgetTooSmallError(
      'Claude candidate result byte budget cannot fit the requested page envelope.',
    );
  }
  return {
    candidates: page,
    nextCursor,
    ...(search.searchTarget === 'content'
      ? {
          contentCoverage:
            contentPartial || nextCursor
              ? ('partial' as const)
              : ('complete' as const),
        }
      : {}),
    ...(searchIncomplete !== undefined ? { searchIncomplete } : {}),
    ...(preparation !== undefined ? { preparation } : {}),
  };
}
