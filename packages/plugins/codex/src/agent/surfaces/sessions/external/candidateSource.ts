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
  decodeCodexExternalSessionIndexCursor,
  decodeCodexExternalSessionCandidateCursor,
  encodeCodexExternalSessionCandidateCursor,
  encodeCodexExternalSessionIndexCursor,
  resolveCodexExternalSessionAppServerListBudgetMs,
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

async function listThreadsForArchiveStateWithClient(params: Readonly<{
  client: CodexAppServerClient;
  processEnv: NodeJS.ProcessEnv;
  archived: boolean;
}> & CodexExternalSessionInvocationBounds): Promise<CodexAppServerThread[]> {
  const pageSize = readThreadListPageSize(params.processEnv);
  const out: CodexAppServerThread[] = [];
  let cursor: string | null | undefined = undefined;
  while (true) {
    throwIfCodexExternalSessionInvocationStopped(params);
    const result = await params.client.request('thread/list', {
      limit: pageSize,
      sortKey: 'updated_at',
      archived: params.archived,
      ...(cursor ? { cursor } : {}),
    }) as ThreadListResult;
    throwIfCodexExternalSessionInvocationStopped(params);
    out.push(...asThreadArray(result?.data));
    cursor = typeof result?.nextCursor === 'string' && result.nextCursor.trim()
      ? result.nextCursor
      : null;
    if (!cursor) break;
  }
  return out;
}

export async function listCodexExternalSessionCandidatesViaExistingAppServerClient(params: Readonly<{
  client: CodexAppServerClient;
  processEnv: NodeJS.ProcessEnv;
}> & CodexExternalSessionInvocationBounds): Promise<CodexExternalSessionCandidate[]> {
  throwIfCodexExternalSessionInvocationStopped(params);
  const [nonArchivedThreads, archivedThreads] = await Promise.all([
    listThreadsForArchiveStateWithClient({ ...params, archived: false }),
    listThreadsForArchiveStateWithClient({ ...params, archived: true }),
  ]);
  throwIfCodexExternalSessionInvocationStopped(params);

  const toCandidate = (thread: CodexAppServerThread, archived: boolean): CodexExternalSessionCandidate => {
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
      activity: deriveExternalSessionActivity({ updatedAtMs, env: params.processEnv }),
      archived,
      details: {
        ...(typeof thread.cwd === 'string' && thread.cwd.trim() ? { cwd: thread.cwd.trim() } : {}),
        runtimeDescriptorV1,
        codexBackendMode: 'appServer',
      },
    };
  };

  return [
    ...nonArchivedThreads.map((thread) => toCandidate(thread, false)),
    ...archivedThreads.map((thread) => toCandidate(thread, true)),
  ];
}

async function listCodexSessionCandidatesViaAppServerWithBudget(params: Readonly<{
  source: CodexExternalSessionSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  exec: ExecService;
  searchTerm?: string;
}> & CodexExternalSessionInvocationBounds): Promise<Readonly<{ candidates: CodexExternalSessionCandidate[]; incomplete: boolean }>> {
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

  const listed: CodexExternalSessionCandidate[] = [];
  let incomplete = false;
  const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim().toLowerCase() : '';
  for (const homeEntry of homeEntries) {
    throwIfCodexExternalSessionInvocationStopped(params);
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

    const listPromise = (async (): Promise<CodexExternalSessionCandidate[] | null> => {
      try {
        client = await createCodexNativeAppServerClient({
          exec: params.exec,
          processEnv,
          signal,
        });
        return await listCodexExternalSessionCandidatesViaExistingAppServerClient({
          client,
          processEnv,
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
      incomplete = true;
      continue;
    }
    listed.push(...result.map((candidate) => ({
      ...candidate,
      details: {
        ...(candidate.details ?? {}),
        source: homeEntry.source,
      },
    })).filter((candidate) => {
      if (!searchTerm) return true;
      const details = candidate.details as Record<string, unknown> | undefined;
      const cwd = typeof details?.cwd === 'string' ? details.cwd : undefined;
      const title = candidate.title;
      const haystack = `${candidate.remoteSessionId}${title ? ` ${title}` : ''}${cwd ? ` ${cwd}` : ''}`.toLowerCase();
      return haystack.includes(searchTerm);
    }));
  }

  return { candidates: listed, incomplete };
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

async function listRolloutCandidates(params: Readonly<{
  source: CodexExternalSessionSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  offset: number;
  limit: number;
  searchTerm?: string;
  searchMode?: 'fast' | 'full';
}> & CodexExternalSessionInvocationBounds): Promise<Readonly<{ candidates: CodexExternalSessionCandidate[]; totalCount: number; searchIncomplete?: boolean }>> {
  const selection = await selectCodexRolloutCandidateEntries({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
    offset: params.offset,
    limit: params.limit,
    searchTerm: params.searchTerm,
    searchMode: params.searchMode,
    signal: params.signal,
    deadlineAtMs: params.deadlineAtMs,
  });

  const buildCandidates = async (entries: readonly CodexRolloutCandidateEntry[], includeTitle: boolean) =>
    await mapCodexExternalSessionWorkWithConcurrency(
      entries,
      resolveCodexRolloutSearchBuildConcurrency(params.env),
      ({ remoteSessionId, group, source }) => buildRolloutCandidate({
        remoteSessionId,
        group,
        env: params.env,
        source,
        includeTitle,
        signal: params.signal,
        deadlineAtMs: params.deadlineAtMs,
      }),
      params,
    );

  if (selection.kind === 'direct') {
    // Exact-id lookups are the host candidate index's hydration route, so they
    // must carry the title the indexed row deliberately does not persist. It is
    // one bounded rollout read for one already-selected candidate.
    const candidates = await buildCandidates(selection.entries, true);
    return {
      candidates,
      totalCount: selection.totalCount,
      ...(selection.searchIncomplete ? { searchIncomplete: true } : {}),
    };
  }

  const allCandidates = await buildCandidates(selection.entries, true);
  const filtered = filterCodexRolloutCandidatesBySearchTerm({
    candidates: allCandidates,
    searchTerm: params.searchTerm ?? '',
  });
  return {
    candidates: filtered.slice(params.offset, params.offset + params.limit),
    totalCount: filtered.length,
    ...(selection.searchIncomplete ? { searchIncomplete: true } : {}),
  };
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
  activeServerDir: string;
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

export async function listCodexSessionCandidates(params: Readonly<{
  source: CodexExternalSessionSource;
  activeServerDir: string;
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
  // An explicitly fast, unsearched browse builds the host candidate index from
  // bounded scan chunks. Every invocation has execution authority; capability
  // absence is not a second candidate-source decision path.
  // Search — including the index owner's own per-row hydration — keeps the exact
  // filename/metadata search path, which prunes by filename before it stats or
  // opens anything and so answers an id lookup in one call.
  if (params.searchMode === 'fast' && !searchTerm) {
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
  const offset = decodeCodexExternalSessionIndexCursor(params.cursor);
  // The index cursor has exactly ONE owner: the canonical merged ordering paged
  // by `pageMergedCandidateOrdering` below. The app-server half of that ordering
  // is unpaged, so the rollout half must supply the ordering PREFIX `[0, offset +
  // limit)` rather than a page of its own. Applying the offset to both halves
  // dropped the first `offset` merged rows and could answer a valid cursor with
  // an empty page under that same cursor — a browse that reports "no more
  // results" while candidates remain.
  const rolloutListing = await listRolloutCandidates({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
    offset: 0,
    limit: offset + limit,
    searchTerm,
    searchMode: params.searchMode,
    signal: params.signal,
    deadlineAtMs: params.deadlineAtMs,
  });
  const pageMergedCandidateOrdering = (
    ordering: readonly CodexExternalSessionCandidate[],
    totalCount: number,
  ) => {
    const candidates = ordering.slice(offset, offset + limit);
    const nextOffset = offset + candidates.length;
    return {
      candidates: [...candidates],
      nextCursor: nextOffset < totalCount ? encodeCodexExternalSessionIndexCursor(nextOffset) : null,
    };
  };
  const exactRolloutIdMatch = Boolean(searchTerm)
    && rolloutListing.candidates.some((candidate) => candidate.remoteSessionId.toLowerCase() === searchTerm)
    && rolloutListing.searchIncomplete !== true;
  if (exactRolloutIdMatch) {
    return pageMergedCandidateOrdering(rolloutListing.candidates, rolloutListing.totalCount);
  }

  const appServerListing = params.searchMode === 'fast'
    ? {
      candidates: [] as CodexExternalSessionCandidate[],
      incomplete: false,
    }
    : await listCodexSessionCandidatesViaAppServerWithBudget({
      source: params.source,
      activeServerDir: params.activeServerDir,
      env: params.env,
      exec: params.exec,
      searchTerm,
      signal: params.signal,
      deadlineAtMs: params.deadlineAtMs,
    });
  throwIfCodexExternalSessionInvocationStopped(params);
  const searchIncomplete = rolloutListing.searchIncomplete === true || appServerListing.incomplete === true;
  if (appServerListing.candidates.length === 0) {
    return {
      ...pageMergedCandidateOrdering(rolloutListing.candidates, rolloutListing.totalCount),
      ...(searchIncomplete ? { searchIncomplete: true } : {}),
    };
  }

  const merged = new Map<string, CodexExternalSessionCandidate>();
  for (const candidate of appServerListing.candidates) merged.set(candidate.remoteSessionId, candidate);
  for (const candidate of rolloutListing.candidates) merged.set(candidate.remoteSessionId, candidate);

  const ordering = Array.from(merged.values())
    .sort((left, right) =>
      right.updatedAtMs - left.updatedAtMs
      || compareCodexRolloutCandidateCodeUnits(left.remoteSessionId, right.remoteSessionId),
    );

  return {
    ...pageMergedCandidateOrdering(ordering, Math.max(rolloutListing.totalCount, merged.size)),
    ...(searchIncomplete ? { searchIncomplete: true } : {}),
  };
}
