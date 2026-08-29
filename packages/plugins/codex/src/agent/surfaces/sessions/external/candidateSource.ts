import {
  deriveExternalSessionActivity,
} from '@happier-dev/plugin-sdk/sessions/external';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import { raceWithTimeout } from '@happier-dev/plugin-sdk/async';

import {
  createCodexNativeAppServerClient,
  type CodexAppServerClient,
  type DisposableCodexAppServerClient,
} from '../../../runtime/appServer/client.js';
import { buildCodexAgentRuntimeDescriptorV1 } from '../../../../protocol/runtimeDescriptorV1.js';
import {
  type CodexRolloutCandidateEntry,
  type CodexRolloutCandidateGroup,
  compareCodexRolloutCandidateCodeUnits,
  filterCodexRolloutCandidatesBySearchTerm,
  resolveCodexRolloutSearchBuildConcurrency,
  scanCodexRolloutCandidateChunk,
  selectCodexRolloutCandidateEntries,
} from '../../../rollout/discovery/candidates.js';
import { homeEntries as resolveHomeEntries } from '../../../rollout/discovery/homeEntries.js';
import { readCodexSessionMetaFromRollout } from '../../../rollout/discovery/indexData.js';
import {
  CODEX_ROLLOUT_TITLE_HEAD_BUDGET,
  readCodexSessionTitleFromRollout,
} from '../../../rollout/discovery/rolloutTitle.js';
import {
  createInitialCodexExternalSessionIndexCursor,
  decodeCodexExternalSessionIndexCursor,
  decodeCodexExternalSessionCandidateCursor,
  encodeCodexExternalSessionCandidateCursor,
  encodeCodexExternalSessionIndexCursor,
  resolveCodexExternalSessionAppServerListBudgetMs,
  type CodexExternalSessionIndexCursor,
  type CodexExternalSessionNativeCandidateCursorState,
} from './candidates.js';
import type {
  CodexExternalSessionCandidate,
  CodexExternalSessionSource,
} from './models.js';
import {
  mapCodexExternalSessionWorkWithConcurrency,
  throwIfCodexExternalSessionInvocationStopped,
  type CodexExternalSessionInvocationBounds,
} from './invocationBounds.js';

export class CodexExternalSessionCandidateSourceChangedError extends Error {
  readonly code = 'codex_candidate_source_changed';

  constructor() {
    super('Codex rollout candidate source changed; refresh the candidate list.');
    this.name = 'CodexExternalSessionCandidateSourceChangedError';
  }
}

type CodexAppServerThread = Readonly<{
  id: string;
  preview?: string;
  name?: string | null;
  createdAt?: number;
  updatedAt?: number;
  cwd?: string;
}>;

type ThreadListResult = Readonly<{
  data?: unknown;
  nextCursor?: string | null;
}>;

const CODEX_APP_SERVER_DISPOSE_BUDGET_MS = 1_000;

async function disposeCodexAppServerClientBestEffort(
  client: DisposableCodexAppServerClient | null,
): Promise<void> {
  if (!client) return;
  try {
    const result = await raceWithTimeout(client.dispose(), CODEX_APP_SERVER_DISPOSE_BUDGET_MS);
    if (result.type === 'rejected') throw result.error;
  } catch {
    // Candidate/status probes must fail closed instead of blocking on provider teardown.
  }
}

function readThreadListPageSize(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.HAPPIER_CODEX_APP_SERVER_THREAD_LIST_PAGE_SIZE ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 200;
  return Math.max(1, Math.min(1000, configured));
}

function asThreadArray(value: unknown): CodexAppServerThread[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is CodexAppServerThread => {
    return Boolean(entry) && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string';
  });
}

type CodexAppServerCandidatePage = Readonly<{
  candidates: readonly CodexExternalSessionCandidate[];
  nextCursor: string | null;
  requestCursor: string | null;
  /**
   * `thread/list` is requested in descending `updated_at` order. When a
   * continuation exists, its last raw row is the highest timestamp any later
   * page may carry; null means the provider gave no usable frontier.
   */
  continuationFrontierUpdatedAtMs: number | null;
}>;

type CodexAppServerCandidatePages = Readonly<{
  active: CodexAppServerCandidatePage | null;
  archived: CodexAppServerCandidatePage | null;
  incomplete: boolean;
}>;

function readNextCursor(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
}

function toCodexAppServerCandidate(
  thread: CodexAppServerThread,
  archived: boolean,
  processEnv: NodeJS.ProcessEnv,
): CodexExternalSessionCandidate {
  const createdAtMs = Number.isFinite(thread.createdAt)
    ? Math.trunc((thread.createdAt as number) * 1000)
    : Number.isFinite(thread.updatedAt)
      ? Math.trunc((thread.updatedAt as number) * 1000)
      : 0;
  const updatedAtMs = Number.isFinite(thread.updatedAt)
    ? Math.trunc((thread.updatedAt as number) * 1000)
    : createdAtMs;
  const title = typeof thread.name === 'string' && thread.name.trim()
    ? thread.name.trim()
    : typeof thread.preview === 'string' && thread.preview.trim()
      ? thread.preview.trim()
      : undefined;
  const runtimeDescriptorV1 = buildCodexAgentRuntimeDescriptorV1({
    backendMode: 'appServer',
    providerSessionId: thread.id,
  });
  return {
    remoteSessionId: thread.id,
    ...(title ? { title } : {}),
    createdAtMs,
    updatedAtMs,
    activity: deriveExternalSessionActivity({ updatedAtMs, env: processEnv }),
    archived,
    details: {
      ...(typeof thread.cwd === 'string' && thread.cwd.trim() ? { cwd: thread.cwd.trim() } : {}),
      runtimeDescriptorV1,
      codexBackendMode: 'appServer',
    },
  };
}

function compareCodexAppServerCandidates(
  left: CodexExternalSessionCandidate,
  right: CodexExternalSessionCandidate,
): number {
  return right.updatedAtMs - left.updatedAtMs
    || compareCodexRolloutCandidateCodeUnits(left.remoteSessionId, right.remoteSessionId);
}

async function listThreadsForArchiveStateWithClient(params: Readonly<{
  client: CodexAppServerClient;
  processEnv: NodeJS.ProcessEnv;
  archived: boolean;
  cursor: string | null;
}> & CodexExternalSessionInvocationBounds): Promise<CodexAppServerCandidatePage> {
  const pageSize = readThreadListPageSize(params.processEnv);
  throwIfCodexExternalSessionInvocationStopped(params);
  const result = await params.client.request('thread/list', {
    limit: pageSize,
    sortKey: 'updated_at',
    archived: params.archived,
    ...(params.cursor ? { cursor: params.cursor } : {}),
  }) as ThreadListResult;
  throwIfCodexExternalSessionInvocationStopped(params);
  const nextCursor = readNextCursor(result?.nextCursor);
  const candidates = asThreadArray(result?.data)
    .map((thread) => toCodexAppServerCandidate(thread, params.archived, params.processEnv))
    .sort(compareCodexAppServerCandidates);
  return Object.freeze({
    candidates,
    nextCursor,
    requestCursor: params.cursor,
    continuationFrontierUpdatedAtMs: nextCursor
      ? candidates.at(-1)?.updatedAtMs ?? null
      : null,
  });
}

async function listCodexExternalSessionCandidatePagesWithClient(params: Readonly<{
  client: CodexAppServerClient;
  processEnv: NodeJS.ProcessEnv;
  active: CodexExternalSessionNativeCandidateCursorState;
  archived: CodexExternalSessionNativeCandidateCursorState;
}> & CodexExternalSessionInvocationBounds): Promise<CodexAppServerCandidatePages> {
  throwIfCodexExternalSessionInvocationStopped(params);
  const [active, archived] = await Promise.all([
    params.active.done
      ? Promise.resolve(null)
      : listThreadsForArchiveStateWithClient({
        ...params,
        archived: false,
        cursor: params.active.cursor,
      }),
    params.archived.done
      ? Promise.resolve(null)
      : listThreadsForArchiveStateWithClient({
        ...params,
        archived: true,
        cursor: params.archived.cursor,
      }),
  ]);
  throwIfCodexExternalSessionInvocationStopped(params);
  return Object.freeze({ active, archived, incomplete: false });
}

/**
 * Retained as the small client-boundary probe used by cancellation coverage.
 * It intentionally reads exactly one native page per archive state; paging is
 * owned by the v5 candidate cursor below, never by a leaf-local drain loop.
 */
export async function listCodexExternalSessionCandidatesViaExistingAppServerClient(params: Readonly<{
  client: CodexAppServerClient;
  processEnv: NodeJS.ProcessEnv;
}> & CodexExternalSessionInvocationBounds): Promise<CodexExternalSessionCandidate[]> {
  const cursor = createInitialCodexExternalSessionIndexCursor();
  const pages = await listCodexExternalSessionCandidatePagesWithClient({
    ...params,
    active: cursor.active,
    archived: cursor.archived,
  });
  return [...(pages.active?.candidates ?? []), ...(pages.archived?.candidates ?? [])];
}

async function listCodexSessionCandidatesViaAppServerWithBudget(params: Readonly<{
  source: CodexExternalSessionSource;
  activeServerDir?: string;
  env: NodeJS.ProcessEnv;
  exec: ExecService;
  searchTerm?: string;
  active: CodexExternalSessionNativeCandidateCursorState;
  archived: CodexExternalSessionNativeCandidateCursorState;
}> & CodexExternalSessionInvocationBounds): Promise<CodexAppServerCandidatePages> {
  throwIfCodexExternalSessionInvocationStopped(params);
  const budgetMs = resolveCodexExternalSessionAppServerListBudgetMs(params.env);
  const homeEntries = await resolveHomeEntries({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
    signal: params.signal,
    deadlineAtMs: params.deadlineAtMs,
  });
  throwIfCodexExternalSessionInvocationStopped(params);

  const [homeEntry] = homeEntries;
  if (!homeEntry) {
    return Object.freeze({ active: null, archived: null, incomplete: false });
  }
  let incomplete = homeEntries.length > 1;
  const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim().toLowerCase() : '';
  const processEnv = {
    ...process.env,
    ...params.env,
    CODEX_HOME: homeEntry.codexHome,
  } as NodeJS.ProcessEnv;
  const abortController = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, abortController.signal])
    : abortController.signal;
  let client: Awaited<ReturnType<typeof createCodexNativeAppServerClient>> | null = null;

  const listPromise = (async (): Promise<CodexAppServerCandidatePages | null> => {
    try {
      client = await createCodexNativeAppServerClient({
        exec: params.exec,
        processEnv,
        signal,
      });
      return await listCodexExternalSessionCandidatePagesWithClient({
        client,
        processEnv,
        active: params.active,
        archived: params.archived,
        signal,
        deadlineAtMs: params.deadlineAtMs,
      });
    } catch (error) {
      throwIfCodexExternalSessionInvocationStopped(params);
      return null;
    } finally {
      await disposeCodexAppServerClientBestEffort(client);
    }
  })();

  const budgetedResult = await raceWithTimeout(listPromise, budgetMs);
  throwIfCodexExternalSessionInvocationStopped(params);
  const result = budgetedResult.type === 'resolved' ? budgetedResult.value : null;
  if (budgetedResult.type === 'timeout') {
    abortController.abort();
    void disposeCodexAppServerClientBestEffort(client);
    void listPromise.catch(() => null);
  }
  if (!result) {
    return Object.freeze({ active: null, archived: null, incomplete: true });
  }

  const applySourceAndSearch = (
    page: CodexAppServerCandidatePage | null,
  ): CodexAppServerCandidatePage | null => page && Object.freeze({
    ...page,
    candidates: page.candidates.map((candidate) => ({
      ...candidate,
      details: { ...(candidate.details ?? {}), source: homeEntry.source },
    })).filter((candidate) => {
      if (!searchTerm) return true;
      const details = candidate.details as Record<string, unknown> | undefined;
      const cwd = typeof details?.cwd === 'string' ? details.cwd : undefined;
      const title = candidate.title;
      const haystack = `${candidate.remoteSessionId}${title ? ` ${title}` : ''}${cwd ? ` ${cwd}` : ''}`.toLowerCase();
      return haystack.includes(searchTerm);
    }),
  });
  return Object.freeze({
    active: applySourceAndSearch(result.active),
    archived: applySourceAndSearch(result.archived),
    incomplete,
  });
}

async function buildRolloutCandidate(params: Readonly<{
  remoteSessionId: string;
  group: CodexRolloutCandidateGroup;
  env: NodeJS.ProcessEnv;
  source: CodexRolloutCandidateEntry['source'];
  includeTitle: boolean;
}> & CodexExternalSessionInvocationBounds): Promise<CodexExternalSessionCandidate> {
  throwIfCodexExternalSessionInvocationStopped(params);
  const [latestMeta, earliestMeta, title] = await Promise.all([
    readCodexSessionMetaFromRollout(params.group.latestFilePath, params),
    readCodexSessionMetaFromRollout(params.group.earliestFilePath, params),
    params.includeTitle
      ? readCodexSessionTitleFromRollout(
        params.group.earliestFilePath,
        params,
        CODEX_ROLLOUT_TITLE_HEAD_BUDGET,
      )
      : Promise.resolve(null),
  ]);
  throwIfCodexExternalSessionInvocationStopped(params);
  const canonicalRemoteSessionId = [
    latestMeta?.id,
    earliestMeta?.id,
    params.remoteSessionId,
  ].find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? params.remoteSessionId;
  const cwd = latestMeta && typeof latestMeta.cwd === 'string' && latestMeta.cwd.trim()
    ? latestMeta.cwd.trim()
    : undefined;
  const createdAtMs = (() => {
    const ts = earliestMeta && typeof earliestMeta.timestamp === 'string' ? Date.parse(earliestMeta.timestamp) : NaN;
    if (Number.isFinite(ts) && ts >= 0) return Math.trunc(ts);
    return Math.trunc(params.group.earliestMtimeMs);
  })();
  const updatedAtMs = Math.trunc(params.group.updatedAtMs);
  return {
    remoteSessionId: canonicalRemoteSessionId,
    ...(title ? { title } : {}),
    createdAtMs,
    updatedAtMs,
    archived: params.group.archived,
    activity: deriveExternalSessionActivity({ updatedAtMs, env: params.env }),
    details: {
      ...(cwd ? { cwd } : {}),
      source: params.source,
    },
  };
}

/**
 * One row of the canonical merged candidate ordering. A rollout row carries the
 * ordering key the corpus scan already produced and is built only if the page
 * actually selects it; an app-server row arrives already built.
 */
type CodexMergedOrderingRow = Readonly<
  | {
    kind: 'rolloutEntry';
    remoteSessionId: string;
    updatedAtMs: number;
    entry: CodexRolloutCandidateEntry;
  }
  | {
    kind: 'candidate';
    remoteSessionId: string;
    updatedAtMs: number;
    candidate: CodexExternalSessionCandidate;
  }
>;

function compareCodexMergedOrderingRows(
  left: CodexMergedOrderingRow,
  right: CodexMergedOrderingRow,
): number {
  return right.updatedAtMs - left.updatedAtMs
    || compareCodexRolloutCandidateCodeUnits(left.remoteSessionId, right.remoteSessionId);
}

function toCodexMergedOrderingCandidateRow(
  candidate: CodexExternalSessionCandidate,
): CodexMergedOrderingRow {
  return {
    kind: 'candidate',
    remoteSessionId: candidate.remoteSessionId,
    updatedAtMs: Math.trunc(candidate.updatedAtMs),
    candidate,
  };
}

/**
 * The whole rollout ordering, not a page of it.
 *
 * The rollout corpus is enumerated and ordered in full before anything is
 * paged — the per-row cost is the rollout read that turns an ordered row into a
 * candidate, which is why only the selected page is built. Returning a prefix
 * instead made the merged ordering a function of the requested depth: an
 * app-server row that displaces its rollout twin toward the tail shortens the
 * ordering as the prefix deepens, which serves the displaced identity again on
 * the next page and drops the neighbour it shifted past.
 */
async function listRolloutCandidateOrdering(params: Readonly<{
  source: CodexExternalSessionSource;
  activeServerDir?: string;
  env: NodeJS.ProcessEnv;
  searchTerm?: string;
  searchMode?: 'fast' | 'full';
}> & CodexExternalSessionInvocationBounds): Promise<Readonly<{
  rows: CodexMergedOrderingRow[];
  searchIncomplete?: boolean;
}>> {
  const selection = await selectCodexRolloutCandidateEntries({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
    offset: 0,
    limit: Number.MAX_SAFE_INTEGER,
    searchTerm: params.searchTerm,
    searchMode: params.searchMode,
    signal: params.signal,
    deadlineAtMs: params.deadlineAtMs,
  });

  if (selection.kind === 'direct') {
    return {
      rows: selection.entries.map((entry) => ({
        kind: 'rolloutEntry' as const,
        remoteSessionId: entry.remoteSessionId,
        updatedAtMs: Math.trunc(entry.group.updatedAtMs),
        entry,
      })),
      ...(selection.searchIncomplete ? { searchIncomplete: true } : {}),
    };
  }

  // Candidate search matches on the title and cwd that only a built candidate
  // carries, so this branch has to build every searched row before it can
  // filter. The bounded searched window is what keeps that affordable, and
  // `searchIncomplete` is how the host learns the window was not the corpus.
  const built = await mapCodexExternalSessionWorkWithConcurrency(
    selection.entries,
    resolveCodexRolloutSearchBuildConcurrency(params.env),
    ({ remoteSessionId, group, source }) => buildRolloutCandidate({
      remoteSessionId,
      group,
      env: params.env,
      source,
      includeTitle: true,
      signal: params.signal,
      deadlineAtMs: params.deadlineAtMs,
    }),
    params,
  );
  const filtered = filterCodexRolloutCandidatesBySearchTerm({
    candidates: built,
    searchTerm: params.searchTerm ?? '',
  });
  return {
    rows: filtered.map(toCodexMergedOrderingCandidateRow),
    ...(selection.searchIncomplete ? { searchIncomplete: true } : {}),
  };
}

async function buildCodexMergedOrderingPage(
  rows: readonly CodexMergedOrderingRow[],
  params: Readonly<{ env: NodeJS.ProcessEnv }> & CodexExternalSessionInvocationBounds,
): Promise<CodexExternalSessionCandidate[]> {
  return await mapCodexExternalSessionWorkWithConcurrency(
    rows,
    resolveCodexRolloutSearchBuildConcurrency(params.env),
    async (row) => row.kind === 'candidate'
      ? row.candidate
      : await buildRolloutCandidate({
        remoteSessionId: row.entry.remoteSessionId,
        group: row.entry.group,
        env: params.env,
        source: row.entry.source,
        // Exact-id lookups are the host candidate index's hydration route, so a
        // selected row must carry the title the indexed row deliberately does
        // not persist. It is one bounded rollout read per served row.
        includeTitle: true,
        signal: params.signal,
        deadlineAtMs: params.deadlineAtMs,
      }),
    params,
  );
}

/**
 * Chunk rows carry identity, timestamps, archive state and the title the scan
 * already read for this exact row. Reading `session_meta` for every scanned
 * rollout would put a whole-corpus file-open cost back into a build the index
 * deliberately splits into bounded chunks; the title is different because the
 * scan reads it only for the rows it returns, and the host index serves those
 * rows without hydration while the build is still in progress.
 */
function buildRolloutScanCandidate(params: Readonly<{
  entry: CodexRolloutCandidateEntry;
  env: NodeJS.ProcessEnv;
}>): CodexExternalSessionCandidate {
  const { group, title } = params.entry;
  const updatedAtMs = Math.trunc(group.updatedAtMs);
  const createdAtMs = Math.trunc(
    Number.isFinite(group.earliestSortMs) ? group.earliestSortMs : group.earliestMtimeMs,
  );
  return {
    remoteSessionId: params.entry.remoteSessionId,
    ...(title ? { title } : {}),
    createdAtMs,
    updatedAtMs,
    archived: group.archived,
    activity: deriveExternalSessionActivity({ updatedAtMs, env: params.env }),
    details: { source: params.entry.source },
  };
}

/**
 * The Codex rollout fallback's opt-in to the host candidate-index owner: each
 * call returns one bounded exact chunk plus its preparation state, and the host
 * accumulates, orders and serves the page. See
 * `scanCodexRolloutCandidateChunk` for why the ordered page cannot be produced
 * here within the per-source head-acquisition budget.
 */
async function scanBoundedRolloutCandidateChunk(params: Readonly<{
  source: CodexExternalSessionSource;
  activeServerDir?: string;
  env: NodeJS.ProcessEnv;
  cursor?: string;
  limit: number;
}> & CodexExternalSessionInvocationBounds): Promise<Readonly<{
  candidates: CodexExternalSessionCandidate[];
  nextCursor: string | null;
  preparation: Readonly<{ kind: 'building_candidate_index'; scanned: number }>;
}>> {
  const after = params.cursor
    ? decodeCodexExternalSessionCandidateCursor(params.cursor)
    : null;
  if (params.cursor && !after) {
    throw new CodexExternalSessionCandidateSourceChangedError();
  }
  const chunk = await scanCodexRolloutCandidateChunk({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
    limit: params.limit,
    after,
    signal: params.signal,
    deadlineAtMs: params.deadlineAtMs,
  });
  if (chunk.sourceChanged) {
    throw new CodexExternalSessionCandidateSourceChangedError();
  }
  return {
    candidates: chunk.entries.map((entry) => buildRolloutScanCandidate({ entry, env: params.env })),
    nextCursor: chunk.nextBoundary
      ? encodeCodexExternalSessionCandidateCursor(chunk.nextBoundary)
      : null,
    preparation: { kind: 'building_candidate_index', scanned: chunk.scanned },
  };
}

function terminalNativeCandidateCursorState(): CodexExternalSessionNativeCandidateCursorState {
  return Object.freeze({ cursor: null, previousCursor: null, offset: 0, done: true });
}

function advanceNativeCandidateCursorState(params: Readonly<{
  state: CodexExternalSessionNativeCandidateCursorState;
  page: CodexAppServerCandidatePage | null;
  offset: number;
}>): CodexExternalSessionNativeCandidateCursorState {
  if (!params.page) return params.state;
  if (params.offset < 0 || params.offset > params.page.candidates.length) {
    throw new CodexExternalSessionCandidateSourceChangedError();
  }
  if (params.offset < params.page.candidates.length) {
    return Object.freeze({ ...params.state, offset: params.offset });
  }
  const nextCursor = params.page.nextCursor;
  if (!nextCursor) return terminalNativeCandidateCursorState();
  if (
    nextCursor === params.page.requestCursor
    || nextCursor === params.state.previousCursor
  ) {
    throw new CodexExternalSessionCandidateSourceChangedError();
  }
  return Object.freeze({
    cursor: nextCursor,
    previousCursor: params.page.requestCursor,
    offset: 0,
    done: false,
  });
}

function chooseNextMergedCandidateRow(params: Readonly<{
  rollout: CodexMergedOrderingRow | null;
  active: CodexMergedOrderingRow | null;
  archived: CodexMergedOrderingRow | null;
}>): Readonly<{ stream: 'rollout' | 'active' | 'archived'; row: CodexMergedOrderingRow }> | null {
  const choices = (['rollout', 'active', 'archived'] as const).flatMap((stream) => {
    const row = params[stream];
    return row ? [{ stream, row }] : [];
  });
  choices.sort((left, right) =>
    compareCodexMergedOrderingRows(left.row, right.row)
    || left.stream.localeCompare(right.stream),
  );
  return choices[0] ?? null;
}

function selectBoundedCodexMergedCandidatePage(params: Readonly<{
  rolloutRows: readonly CodexMergedOrderingRow[];
  cursor: CodexExternalSessionIndexCursor;
  activePage: CodexAppServerCandidatePage | null;
  archivedPage: CodexAppServerCandidatePage | null;
  limit: number;
}>): Readonly<{
  rows: readonly CodexMergedOrderingRow[];
  cursor: CodexExternalSessionIndexCursor;
  hasMore: boolean;
  hasPendingNativeContinuation: boolean;
}> {
  if (params.cursor.rolloutOffset > params.rolloutRows.length) {
    throw new CodexExternalSessionCandidateSourceChangedError();
  }
  let rolloutOffset = params.cursor.rolloutOffset;
  let activeOffset = params.cursor.active.offset;
  let archivedOffset = params.cursor.archived.offset;
  const emittedIds = new Set<string>();
  const suppressedRolloutIds = new Set(params.cursor.suppressedRolloutIds);
  const rolloutRowsById = new Map(
    params.rolloutRows.map((row) => [row.remoteSessionId, row] as const),
  );
  const rolloutIndexesById = new Map(
    params.rolloutRows.map((row, index) => [row.remoteSessionId, index] as const),
  );
  /**
   * A native row owns an overlap only when it is at least as new as the
   * rollout row. The opposite direction is essential for bounded paging: a
   * rollout row released above the native continuation frontier can safely
   * remain canonical when its older native twin arrives later, with no
   * historical-id cache in the cursor.
   */
  const nativeOwnsIdentity = (candidate: CodexExternalSessionCandidate): boolean => {
    const rollout = rolloutRowsById.get(candidate.remoteSessionId);
    return !rollout || candidate.updatedAtMs >= rollout.updatedAtMs;
  };
  const nativeIds = new Set([
    ...(params.activePage?.candidates ?? []),
    ...(params.archivedPage?.candidates ?? []),
  ].filter(nativeOwnsIdentity).map((candidate) => candidate.remoteSessionId));

  let nativeContinuationFrontierUpdatedAtMs: number | null = null;
  let nativeContinuationUnknown = false;
  for (const [state, page] of [
    [params.cursor.active, params.activePage],
    [params.cursor.archived, params.archivedPage],
  ] as const) {
    if (state.done) continue;
    if (!page) {
      nativeContinuationUnknown = true;
      continue;
    }
    if (!page.nextCursor) continue;
    if (page.continuationFrontierUpdatedAtMs === null) {
      nativeContinuationUnknown = true;
      continue;
    }
    nativeContinuationFrontierUpdatedAtMs = Math.max(
      nativeContinuationFrontierUpdatedAtMs ?? page.continuationFrontierUpdatedAtMs,
      page.continuationFrontierUpdatedAtMs,
    );
  }
  const selected: CodexMergedOrderingRow[] = [];

  const nextRollout = (): CodexMergedOrderingRow | null => {
    while (rolloutOffset < params.rolloutRows.length) {
      const row = params.rolloutRows[rolloutOffset]!;
      if (
        nativeIds.has(row.remoteSessionId)
        || suppressedRolloutIds.has(row.remoteSessionId)
        || emittedIds.has(row.remoteSessionId)
      ) {
        suppressedRolloutIds.delete(row.remoteSessionId);
        rolloutOffset += 1;
        continue;
      }
      // A later native page can only carry rows at or below this frontier.
      // Equality stays withheld because an equal-timestamp native twin wins;
      // strict precedence lets a released rollout row remain canonical when a
      // later, older native twin arrives.
      if (
        nativeContinuationUnknown
        || (
          nativeContinuationFrontierUpdatedAtMs !== null
          && row.updatedAtMs <= nativeContinuationFrontierUpdatedAtMs
        )
      ) {
        return null;
      }
      return row;
    }
    return null;
  };
  const nextNative = (
    page: CodexAppServerCandidatePage | null,
    stream: 'active' | 'archived',
  ): CodexMergedOrderingRow | null => {
    if (!page) return null;
    let offset = stream === 'active' ? activeOffset : archivedOffset;
    while (offset < page.candidates.length) {
      const candidate = page.candidates[offset]!;
      if (!emittedIds.has(candidate.remoteSessionId) && nativeOwnsIdentity(candidate)) {
        break;
      }
      offset += 1;
    }
    if (stream === 'active') activeOffset = offset;
    else archivedOffset = offset;
    const candidate = page.candidates[offset];
    return candidate ? toCodexMergedOrderingCandidateRow(candidate) : null;
  };

  while (selected.length < params.limit) {
    const next = chooseNextMergedCandidateRow({
      rollout: nextRollout(),
      active: nextNative(params.activePage, 'active'),
      archived: nextNative(params.archivedPage, 'archived'),
    });
    if (!next) break;
    selected.push(next.row);
    emittedIds.add(next.row.remoteSessionId);
    if (next.stream !== 'rollout') {
      const rolloutIndex = rolloutIndexesById.get(next.row.remoteSessionId);
      if (rolloutIndex !== undefined && rolloutIndex >= rolloutOffset) {
        suppressedRolloutIds.add(next.row.remoteSessionId);
      }
    }
    if (next.stream === 'rollout') rolloutOffset += 1;
    if (next.stream === 'active') activeOffset += 1;
    if (next.stream === 'archived') archivedOffset += 1;
  }

  const active = advanceNativeCandidateCursorState({
    state: params.cursor.active,
    page: params.activePage,
    offset: activeOffset,
  });
  const archived = advanceNativeCandidateCursorState({
    state: params.cursor.archived,
    page: params.archivedPage,
    offset: archivedOffset,
  });
  const hasMore = rolloutOffset < params.rolloutRows.length || !active.done || !archived.done;
  return Object.freeze({
    rows: Object.freeze(selected),
    cursor: Object.freeze({
      v: 6,
      kind: 'codexMergedCandidatePage',
      rolloutOffset,
      suppressedRolloutIds: Object.freeze([...suppressedRolloutIds]),
      active,
      archived,
    }),
    hasMore,
    hasPendingNativeContinuation: !active.done || !archived.done,
  });
}

export async function listCodexSessionCandidates(params: Readonly<{
  source: CodexExternalSessionSource;
  activeServerDir?: string;
  env: NodeJS.ProcessEnv;
  exec: ExecService;
  cursor?: string;
  limit: number;
  searchTerm?: string;
  searchMode?: 'fast' | 'full';
}> & CodexExternalSessionInvocationBounds): Promise<Readonly<{
  candidates: CodexExternalSessionCandidate[];
  nextCursor: string | null;
  searchIncomplete?: boolean;
  preparation?: Readonly<{ kind: 'building_candidate_index'; scanned: number }>;
}>> {
  throwIfCodexExternalSessionInvocationStopped(params);
  const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim().toLowerCase() : '';
  const limit = Math.max(1, Math.trunc(params.limit));
  // Every unsearched browse — the ordinary mounted machine Browse included —
  // builds the host candidate index from bounded scan chunks. An empty query
  // has nothing to search, so the merged whole-corpus ordering (and its
  // MAX_SAFE_INTEGER enumeration) is reserved for real searches. Every
  // invocation has execution authority; capability absence is not a second
  // candidate-source decision path.
  // Search — including the index owner's own per-row hydration — keeps the exact
  // filename/metadata search path, which prunes by filename before it stats or
  // opens anything and so answers an id lookup in one call.
  if (!searchTerm) {
    return await scanBoundedRolloutCandidateChunk({
      source: params.source,
      activeServerDir: params.activeServerDir,
      env: params.env,
      cursor: params.cursor,
      limit,
      signal: params.signal,
      deadlineAtMs: params.deadlineAtMs,
    });
  }
  const cursor = params.cursor
    ? decodeCodexExternalSessionIndexCursor(params.cursor)
    : createInitialCodexExternalSessionIndexCursor();
  if (!cursor) throw new CodexExternalSessionCandidateSourceChangedError();
  const rolloutOrdering = await listRolloutCandidateOrdering({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
    searchTerm,
    searchMode: params.searchMode,
    signal: params.signal,
    deadlineAtMs: params.deadlineAtMs,
  });
  const serveRolloutOnlyPage = async (ordering: readonly CodexMergedOrderingRow[]) => {
    if (cursor.rolloutOffset > ordering.length) {
      throw new CodexExternalSessionCandidateSourceChangedError();
    }
    const pageRows = ordering.slice(cursor.rolloutOffset, cursor.rolloutOffset + limit);
    const nextOffset = cursor.rolloutOffset + pageRows.length;
    const hasMore = nextOffset < ordering.length;
    return {
      candidates: await buildCodexMergedOrderingPage(pageRows, params),
      nextCursor: hasMore
        ? encodeCodexExternalSessionIndexCursor(Object.freeze({
          v: 6 as const,
          kind: 'codexMergedCandidatePage' as const,
          rolloutOffset: nextOffset,
          suppressedRolloutIds: Object.freeze([]),
          active: terminalNativeCandidateCursorState(),
          archived: terminalNativeCandidateCursorState(),
        }))
        : null,
    };
  };
  const exactRolloutIdMatch = Boolean(searchTerm)
    && rolloutOrdering.rows.some((row) => row.remoteSessionId.toLowerCase() === searchTerm)
    && rolloutOrdering.searchIncomplete !== true;
  if (exactRolloutIdMatch) {
    return await serveRolloutOnlyPage([...rolloutOrdering.rows].sort(compareCodexMergedOrderingRows));
  }

  const appServerListing = params.searchMode === 'fast'
    ? {
      active: null,
      archived: null,
      incomplete: false,
    }
    : await listCodexSessionCandidatesViaAppServerWithBudget({
      source: params.source,
      activeServerDir: params.activeServerDir,
      env: params.env,
      exec: params.exec,
      searchTerm,
      active: cursor.active,
      archived: cursor.archived,
      signal: params.signal,
      deadlineAtMs: params.deadlineAtMs,
    });
  throwIfCodexExternalSessionInvocationStopped(params);
  const nativeCursor = params.searchMode === 'fast'
    ? Object.freeze({
      ...cursor,
      active: terminalNativeCandidateCursorState(),
      archived: terminalNativeCandidateCursorState(),
    })
    : cursor;
  const page = selectBoundedCodexMergedCandidatePage({
    rolloutRows: [...rolloutOrdering.rows].sort(compareCodexMergedOrderingRows),
    cursor: nativeCursor,
    activePage: appServerListing.active,
    archivedPage: appServerListing.archived,
    limit,
  });
  const searchIncomplete = rolloutOrdering.searchIncomplete === true
    || appServerListing.incomplete === true
    || (Boolean(searchTerm) && page.hasPendingNativeContinuation);

  return {
    candidates: await buildCodexMergedOrderingPage(page.rows, params),
    nextCursor: page.hasMore
      ? encodeCodexExternalSessionIndexCursor(page.cursor)
      : null,
    ...(searchIncomplete ? { searchIncomplete: true } : {}),
  };
}
