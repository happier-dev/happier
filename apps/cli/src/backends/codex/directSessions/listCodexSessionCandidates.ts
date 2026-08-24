import type { DirectSessionCandidateV1, DirectSessionsSource } from '@happier-dev/protocol';

import { logger } from '@/utils/logger';

import { createCodexAppServerClient } from '../appServer/client/createCodexAppServerClient';
import { listCodexDirectSessionCandidatesViaExistingAppServerClient } from '../appServer/session/listCodexDirectSessionCandidatesViaAppServer';
import { listCodexDirectSessionCandidatesViaRollouts } from './listCodexDirectSessionCandidatesViaRollouts';
import { resolveCodexHomeEntriesForDirectSessionsSource } from './resolveCodexHomeEntriesForDirectSessionsSource';
import { resolveCodexAppServerProcessEnv } from '../appServer/resolveCodexAppServerProcessEnv';

type IndexCursorV1 = Readonly<{ v: 1; kind: 'index'; offset: number }>;

function encodeIndexCursor(offset: number): string {
  const cursor: IndexCursorV1 = { v: 1, kind: 'index', offset: Math.max(0, Math.trunc(offset)) };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeIndexCursor(raw: string | undefined): number {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as any;
    if (!parsed || typeof parsed !== 'object') return 0;
    if (parsed.v !== 1 || parsed.kind !== 'index') return 0;
    const offset = typeof parsed.offset === 'number' && Number.isFinite(parsed.offset) ? Math.trunc(parsed.offset) : 0;
    return Math.max(0, offset);
  } catch {
    return 0;
  }
}

function resolveCodexDirectListAppServerBudgetMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.HAPPIER_CODEX_DIRECT_SESSIONS_APP_SERVER_LIST_TIMEOUT_MS ?? ''), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 750;
}

function mergeCodexDirectSessionCandidate(params: Readonly<{
  rolloutCandidate: DirectSessionCandidateV1;
  appServerCandidate: DirectSessionCandidateV1 | undefined;
}>): DirectSessionCandidateV1 {
  const appServerTitle = params.appServerCandidate?.title?.trim();
  if (!appServerTitle) return params.rolloutCandidate;
  return {
    ...params.rolloutCandidate,
    title: appServerTitle,
  };
}

async function listCodexSessionCandidatesViaAppServerWithBudget(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  searchTerm?: string;
}>): Promise<Readonly<{ candidates: DirectSessionCandidateV1[]; incomplete: boolean }>> {
  const budgetMs = resolveCodexDirectListAppServerBudgetMs(params.env);
  const homeEntries = await resolveCodexHomeEntriesForDirectSessionsSource({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
  });

  const listed: DirectSessionCandidateV1[] = [];
  let incomplete = false;
  const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim().toLowerCase() : '';
  for (const homeEntry of homeEntries) {
    const processEnv = await resolveCodexAppServerProcessEnv({
      processEnv: { ...process.env, ...params.env },
      affinity: {
        home: homeEntry.source.kind === 'codexHome' ? homeEntry.source.home : 'user',
        homePath: homeEntry.codexHome,
      },
    });
    const startedAtMs = Date.now();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let client: Awaited<ReturnType<typeof createCodexAppServerClient>> | null = null;

    const listPromise = (async (): Promise<DirectSessionCandidateV1[] | null> => {
      try {
        client = await createCodexAppServerClient({ processEnv });
        if (timedOut) {
          await client.dispose().catch(() => undefined);
          return null;
        }
        return await listCodexDirectSessionCandidatesViaExistingAppServerClient({ client, processEnv });
      } catch {
        return null;
      } finally {
        if (client) {
          await client.dispose().catch(() => undefined);
        }
      }
    })();

    const result = await Promise.race<DirectSessionCandidateV1[] | null>([
      listPromise,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true;
          void client?.dispose().catch(() => undefined);
          resolve(null);
        }, budgetMs);
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });

    logger.debug('[directSessions.codex.appServerCandidates] list finished', {
      homeKind: homeEntry.source.kind,
      elapsedMs: Date.now() - startedAtMs,
      budgetMs,
      timedOut,
      returnedCandidates: result?.length ?? 0,
      searchTermLength: searchTerm.length,
    });

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

export async function listCodexSessionCandidates(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  env?: NodeJS.ProcessEnv;
  cursor?: string;
  limit: number;
  searchTerm?: string;
  searchMode?: 'fast' | 'full';
}>): Promise<Readonly<{ candidates: DirectSessionCandidateV1[]; nextCursor: string | null; searchIncomplete?: boolean }>> {
  const env = params.env ?? process.env;

  const startedAtMs = Date.now();
  const startMemory = process.memoryUsage();
  const offset = decodeIndexCursor(params.cursor);
  const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim().toLowerCase() : '';
  const limit = Math.max(1, Math.trunc(params.limit));
  const rolloutListing = await listCodexDirectSessionCandidatesViaRollouts({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env,
    offset,
    limit,
    searchTerm,
    searchMode: params.searchMode,
  });
  const exactRolloutMatch = Boolean(searchTerm)
    && rolloutListing.candidates.some((candidate) => candidate.remoteSessionId.toLowerCase() === searchTerm)
    && !rolloutListing.searchIncomplete;
  const appServerListing = params.searchMode === 'fast' || exactRolloutMatch
    ? { candidates: [] as DirectSessionCandidateV1[], incomplete: Boolean(searchTerm) && !exactRolloutMatch }
    : await listCodexSessionCandidatesViaAppServerWithBudget({
      source: params.source,
      activeServerDir: params.activeServerDir,
      env,
      searchTerm,
    });
  const appServerCandidates = appServerListing.candidates;
  const searchIncomplete = Boolean(rolloutListing.searchIncomplete || appServerListing.incomplete);

  logger.debug('[directSessions.codex.candidates] list finished', {
    elapsedMs: Date.now() - startedAtMs,
    searchTermLength: searchTerm.length,
    searchMode: params.searchMode ?? 'default',
    rolloutCandidates: rolloutListing.candidates.length,
    rolloutTotalCount: rolloutListing.totalCount,
    appServerCandidates: appServerCandidates.length,
    searchIncomplete,
    heapDeltaBytes: process.memoryUsage().heapUsed - startMemory.heapUsed,
    rssBytes: process.memoryUsage().rss,
  });

  if (appServerCandidates.length === 0) {
    const nextOffset = offset + rolloutListing.candidates.length;
    const nextCursor = nextOffset < rolloutListing.totalCount ? encodeIndexCursor(nextOffset) : null;
    return {
      candidates: rolloutListing.candidates,
      nextCursor,
      ...(searchIncomplete ? { searchIncomplete: true } : {}),
    };
  }

  const effectiveRolloutListing = appServerCandidates.length > 0 && offset > 0
    ? await listCodexDirectSessionCandidatesViaRollouts({
      source: params.source,
      activeServerDir: params.activeServerDir,
      env,
      offset: 0,
      limit: offset + limit,
      searchTerm,
      searchMode: params.searchMode,
    })
    : rolloutListing;

  const merged = new Map<string, DirectSessionCandidateV1>();
  for (const candidate of appServerCandidates) {
    merged.set(candidate.remoteSessionId, candidate);
  }
  for (const rolloutCandidate of effectiveRolloutListing.candidates) {
    merged.set(rolloutCandidate.remoteSessionId, mergeCodexDirectSessionCandidate({
      rolloutCandidate,
      appServerCandidate: merged.get(rolloutCandidate.remoteSessionId),
    }));
  }

  const candidates = Array.from(merged.values())
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs || String(a.remoteSessionId).localeCompare(String(b.remoteSessionId)))
    .slice(offset, offset + limit);
  const totalCount = Math.max(effectiveRolloutListing.totalCount, merged.size);

  const nextOffset = offset + candidates.length;
  const nextCursor = nextOffset < totalCount ? encodeIndexCursor(nextOffset) : null;

  return {
    candidates,
    nextCursor,
    ...(searchIncomplete ? { searchIncomplete: true } : {}),
  };
}
