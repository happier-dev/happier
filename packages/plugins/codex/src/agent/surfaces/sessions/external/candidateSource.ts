import {
  deriveExternalSessionActivity,
  type ExternalSessionCandidateV1,
  type ExternalSessionsSource,
} from '@happier-dev/plugin-sdk/experimental/sessions';
import type { PluginExecService } from '@happier-dev/plugin-sdk/runtime';
import { isChangeTitleToolNameAlias } from '@happier-dev/protocol/tools/v2';
import {
  isRecord,
  readJsonlFileForwardLines,
} from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';
import { raceWithTimeout } from '@happier-dev/plugin-sdk/experimental/timeout';

import {
  createCodexNativeAppServerClient,
  type CodexAppServerClient,
  type DisposableCodexAppServerClient,
} from '../../../runtime/appServer/client.js';
import { buildCodexAgentRuntimeDescriptorV1 } from '../../../../protocol/runtimeDescriptorV1.js';
import {
  type CodexRolloutCandidateEntry,
  type CodexRolloutCandidateGroup,
  filterCodexRolloutCandidatesBySearchTerm,
  pageCodexRolloutCandidateEntries,
  resolveCodexRolloutSearchBuildConcurrency,
  selectCodexRolloutCandidateEntries,
} from '../../../rollout/discovery/candidates.js';
import { homeEntries as resolveHomeEntries } from '../../../rollout/discovery/homeEntries.js';
import { readCodexSessionMetaFromRollout } from '../../../rollout/discovery/indexData.js';
import { mapCodexRolloutEventToActions } from '../../../rollout/projection/actions.js';
import {
  decodeCodexExternalSessionIndexCursor,
  decodeCodexExternalSessionCandidateCursor,
  encodeCodexExternalSessionCandidateCursor,
  encodeCodexExternalSessionIndexCursor,
  resolveCodexExternalSessionAppServerListBudgetMs,
} from './candidates.js';

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
const CODEX_TITLE_SCAN_CHUNK_MAX_BYTES = 128 * 1024;
const CODEX_TITLE_SCAN_CHUNK_MAX_ITEMS = 64;
const CODEX_TITLE_SCAN_TOTAL_MAX_BYTES = 1024 * 1024;
const CODEX_TITLE_SCAN_TOTAL_MAX_ITEMS = 512;
const CODEX_TITLE_MAX_CHARS = 120;
const CODEX_TITLE_BOILERPLATE_PATTERNS = [
  '# session title',
  'at the start of the session',
  'change_title tool',
  '<environment_context>',
  '<instructions>',
  '<turn_aborted>',
  '# agents.md instructions',
] as const;

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

async function mapWithConcurrency<TInput, TOutput>(
  input: readonly TInput[],
  concurrency: number,
  mapper: (item: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const limit = Math.max(1, Math.trunc(concurrency));
  const output = new Array<TOutput>(input.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, input.length) }, async () => {
      while (nextIndex < input.length) {
        const index = nextIndex;
        nextIndex += 1;
        output[index] = await mapper(input[index]!);
      }
    }),
  );
  return output;
}

function readCodexExternalSessionTitleCandidate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  const title = normalized.length <= CODEX_TITLE_MAX_CHARS
    ? normalized
    : normalized.slice(0, CODEX_TITLE_MAX_CHARS - 3).trimEnd() + '...';
  const lowerTitle = title.toLowerCase();
  if (CODEX_TITLE_BOILERPLATE_PATTERNS.some((pattern) => lowerTitle.includes(pattern))) {
    return null;
  }
  return title;
}

function readTitleFromCodexTitleToolInput(input: unknown): string | null {
  return readCodexExternalSessionTitleCandidate(isRecord(input) ? input.title : null);
}

async function readCodexSessionTitleFromRollout(filePath: string): Promise<string | null> {
  let fallbackAssistantText: string | null = null;
  let offsetBytes = 0;
  let scannedBytes = 0;
  let scannedItems = 0;

  while (scannedBytes < CODEX_TITLE_SCAN_TOTAL_MAX_BYTES && scannedItems < CODEX_TITLE_SCAN_TOTAL_MAX_ITEMS) {
    const page = await readJsonlFileForwardLines({
      filePath,
      offsetBytes,
      maxBytes: Math.min(CODEX_TITLE_SCAN_CHUNK_MAX_BYTES, CODEX_TITLE_SCAN_TOTAL_MAX_BYTES - scannedBytes),
      maxItems: Math.min(CODEX_TITLE_SCAN_CHUNK_MAX_ITEMS, CODEX_TITLE_SCAN_TOTAL_MAX_ITEMS - scannedItems),
    });

    for (const line of page.items) {
      if (line.value === null) continue;
      for (const action of mapCodexRolloutEventToActions(line.value, { debug: false })) {
        if (action.type === 'tool-call' && isChangeTitleToolNameAlias(action.name)) {
          const title = readTitleFromCodexTitleToolInput(action.input);
          if (title) return title;
        }
        if (action.type === 'user-text') {
          const title = readCodexExternalSessionTitleCandidate(action.text);
          if (title) return title;
        }
        if (action.type === 'assistant-text' && fallbackAssistantText === null) {
          fallbackAssistantText = readCodexExternalSessionTitleCandidate(action.text);
        }
      }
    }

    if (page.reachedEnd || page.nextOffsetBytes <= offsetBytes) break;
    scannedBytes += Math.max(0, page.nextOffsetBytes - offsetBytes);
    scannedItems += page.items.length;
    offsetBytes = page.nextOffsetBytes;
  }

  return fallbackAssistantText;
}

async function listThreadsForArchiveStateWithClient(params: Readonly<{
  client: CodexAppServerClient;
  processEnv: NodeJS.ProcessEnv;
  archived: boolean;
}>): Promise<CodexAppServerThread[]> {
  const pageSize = readThreadListPageSize(params.processEnv);
  const out: CodexAppServerThread[] = [];
  let cursor: string | null | undefined = undefined;
  while (true) {
    const result = await params.client.request('thread/list', {
      limit: pageSize,
      sortKey: 'updated_at',
      archived: params.archived,
      ...(cursor ? { cursor } : {}),
    }) as ThreadListResult;
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
}>): Promise<ExternalSessionCandidateV1[]> {
  const [nonArchivedThreads, archivedThreads] = await Promise.all([
    listThreadsForArchiveStateWithClient({ client: params.client, processEnv: params.processEnv, archived: false }),
    listThreadsForArchiveStateWithClient({ client: params.client, processEnv: params.processEnv, archived: true }),
  ]);

  const toCandidate = (thread: CodexAppServerThread, archived: boolean): ExternalSessionCandidateV1 => {
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
  source: ExternalSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  exec: PluginExecService;
  searchTerm?: string;
}>): Promise<Readonly<{ candidates: ExternalSessionCandidateV1[]; incomplete: boolean }>> {
  const budgetMs = resolveCodexExternalSessionAppServerListBudgetMs(params.env);
  const homeEntries = await resolveHomeEntries({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
  });

  const listed: ExternalSessionCandidateV1[] = [];
  let incomplete = false;
  const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim().toLowerCase() : '';
  for (const homeEntry of homeEntries) {
    const processEnv = {
      ...process.env,
      ...params.env,
      CODEX_HOME: homeEntry.codexHome,
    } as NodeJS.ProcessEnv;
    const abortController = new AbortController();
    let client: Awaited<ReturnType<typeof createCodexNativeAppServerClient>> | null = null;

    const listPromise = (async (): Promise<ExternalSessionCandidateV1[] | null> => {
      try {
        client = await createCodexNativeAppServerClient({
          exec: params.exec,
          processEnv,
          signal: abortController.signal,
        });
        return await listCodexExternalSessionCandidatesViaExistingAppServerClient({ client, processEnv });
      } catch {
        return null;
      } finally {
        await disposeCodexAppServerClientBestEffort(client);
      }
    })();

    const budgetedResult = await raceWithTimeout(listPromise, budgetMs);
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
}>): Promise<ExternalSessionCandidateV1> {
  const [latestMeta, earliestMeta, title] = await Promise.all([
    readCodexSessionMetaFromRollout(params.group.latestFilePath),
    readCodexSessionMetaFromRollout(params.group.earliestFilePath),
    params.includeTitle ? readCodexSessionTitleFromRollout(params.group.earliestFilePath) : Promise.resolve(null),
  ]);
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
  source: ExternalSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  offset: number;
  limit: number;
  searchTerm?: string;
  searchMode?: 'fast' | 'full';
}>): Promise<Readonly<{ candidates: ExternalSessionCandidateV1[]; totalCount: number; searchIncomplete?: boolean }>> {
  const selection = await selectCodexRolloutCandidateEntries({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
    offset: params.offset,
    limit: params.limit,
    searchTerm: params.searchTerm,
    searchMode: params.searchMode,
  });

  const buildCandidates = async (entries: readonly CodexRolloutCandidateEntry[], includeTitle: boolean) =>
    await mapWithConcurrency(
      entries,
      resolveCodexRolloutSearchBuildConcurrency(params.env),
      ({ remoteSessionId, group, source }) => buildRolloutCandidate({
        remoteSessionId,
        group,
        env: params.env,
        source,
        includeTitle,
      }),
    );

  if (selection.kind === 'direct') {
    const candidates = await buildCandidates(selection.entries, selection.buildMode !== 'knownRolloutFiles');
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

async function listBoundedRolloutCandidates(params: Readonly<{
  source: ExternalSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  cursor?: string;
  limit: number;
  searchTerm?: string;
  searchMode?: 'fast' | 'full';
}>): Promise<Readonly<{
  candidates: ExternalSessionCandidateV1[];
  nextCursor: string | null;
  searchIncomplete?: boolean;
}>> {
  const after = params.cursor
    ? decodeCodexExternalSessionCandidateCursor(params.cursor)
    : null;
  if (params.cursor && !after) {
    throw new CodexExternalSessionCandidateSourceChangedError();
  }
  const page = await pageCodexRolloutCandidateEntries({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
    limit: params.limit,
    after,
  });
  if (page.sourceChanged) {
    throw new CodexExternalSessionCandidateSourceChangedError();
  }
  const hydrated = await mapWithConcurrency(
    page.entries,
    resolveCodexRolloutSearchBuildConcurrency(params.env),
    ({ remoteSessionId, group, source }) => buildRolloutCandidate({
      remoteSessionId,
      group,
      env: params.env,
      source,
      includeTitle: true,
    }),
  );
  const candidates = filterCodexRolloutCandidatesBySearchTerm({
    candidates: hydrated,
    searchTerm: params.searchTerm ?? '',
  });
  return {
    candidates,
    nextCursor: page.nextBoundary
      ? encodeCodexExternalSessionCandidateCursor(page.nextBoundary)
      : null,
    ...(params.searchTerm && (page.nextBoundary || params.searchMode === 'fast')
      ? { searchIncomplete: true }
      : {}),
  };
}

export async function listCodexSessionCandidates(params: Readonly<{
  source: ExternalSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  exec?: PluginExecService;
  cursor?: string;
  limit: number;
  searchTerm?: string;
  searchMode?: 'fast' | 'full';
}>): Promise<Readonly<{
  candidates: ExternalSessionCandidateV1[];
  nextCursor: string | null;
  searchIncomplete?: boolean;
}>> {
  const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim().toLowerCase() : '';
  const limit = Math.max(1, Math.trunc(params.limit));
  if (!params.exec) {
    return await listBoundedRolloutCandidates({
      source: params.source,
      activeServerDir: params.activeServerDir,
      env: params.env,
      cursor: params.cursor,
      limit,
      searchTerm,
      searchMode: params.searchMode,
    });
  }
  const offset = decodeCodexExternalSessionIndexCursor(params.cursor);
  const rolloutListing = await listRolloutCandidates({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
    offset,
    limit,
    searchTerm,
    searchMode: params.searchMode,
  });
  const exactRolloutIdMatch = Boolean(searchTerm)
    && rolloutListing.candidates.some((candidate) => candidate.remoteSessionId.toLowerCase() === searchTerm)
    && rolloutListing.searchIncomplete !== true;
  if (exactRolloutIdMatch) {
    const nextOffset = offset + rolloutListing.candidates.length;
    const nextCursor = nextOffset < rolloutListing.totalCount ? encodeCodexExternalSessionIndexCursor(nextOffset) : null;
    return { candidates: rolloutListing.candidates, nextCursor };
  }

  const appServerListing = params.searchMode === 'fast' || !params.exec
    ? {
      candidates: [] as ExternalSessionCandidateV1[],
      incomplete: params.searchMode === 'fast' ? Boolean(searchTerm) : true,
    }
    : await listCodexSessionCandidatesViaAppServerWithBudget({
      source: params.source,
      activeServerDir: params.activeServerDir,
      env: params.env,
      exec: params.exec,
      searchTerm,
    });
  const searchIncomplete = rolloutListing.searchIncomplete === true || appServerListing.incomplete === true;
  if (appServerListing.candidates.length === 0) {
    const nextOffset = offset + rolloutListing.candidates.length;
    const nextCursor = nextOffset < rolloutListing.totalCount ? encodeCodexExternalSessionIndexCursor(nextOffset) : null;
    return {
      candidates: rolloutListing.candidates,
      nextCursor,
      ...(searchIncomplete ? { searchIncomplete: true } : {}),
    };
  }

  const merged = new Map<string, ExternalSessionCandidateV1>();
  for (const candidate of appServerListing.candidates) merged.set(candidate.remoteSessionId, candidate);
  for (const candidate of rolloutListing.candidates) merged.set(candidate.remoteSessionId, candidate);

  const candidates = Array.from(merged.values())
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.remoteSessionId.localeCompare(b.remoteSessionId))
    .slice(offset, offset + limit);
  const totalCount = Math.max(rolloutListing.totalCount, merged.size);
  const nextOffset = offset + candidates.length;

  return {
    candidates,
    nextCursor: nextOffset < totalCount ? encodeCodexExternalSessionIndexCursor(nextOffset) : null,
    ...(searchIncomplete ? { searchIncomplete: true } : {}),
  };
}
