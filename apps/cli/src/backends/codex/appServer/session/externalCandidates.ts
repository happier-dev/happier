import type { ExternalSessionCandidateV1, ExternalSessionsSource } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { logger } from '@/utils/logger';
import { createPluginExecService } from '@/plugins/runtime/context/exec';
import { createPluginDisposableRegistry } from '@/plugins/runtime/lifecycle/disposables';
import type { ExternalSessionCandidateHostAdapter } from '@/session/external/candidates/host';

import { createCodexAppServerClient } from '@happier-dev/plugins-codex/agent/runtime/appServer/client';
import { listCodexExternalSessionCandidatesViaExistingAppServerClient } from './candidates';
import { homeEntries as resolveHomeEntries } from '@happier-dev/plugins-codex/agent/rollout/discovery/homeEntries';
import {
  decodeCodexExternalSessionIndexCursor,
  encodeCodexExternalSessionIndexCursor,
  resolveCodexExternalSessionAppServerListBudgetMs,
} from '@happier-dev/plugins-codex/agent/surfaces/sessions/external/candidates';
import { rolloutCandidates } from '../../rollout/sessionStore/candidates';

const APP_SERVER_TIMEOUT_CLEANUP_WAIT_MS = 250;

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function requestImmediateExecProcessKill(disposable: unknown): void {
  if (!disposable || typeof disposable !== 'object') return;
  const processHandle = (disposable as Readonly<{ process?: unknown }>).process;
  if (!processHandle || typeof processHandle !== 'object') return;
  const pid = (processHandle as Readonly<{ pid?: unknown }>).pid;
  if (typeof pid === 'number' && Number.isFinite(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process already exited.
    }
  }
  const kill = (processHandle as Readonly<{ kill?: unknown }>).kill;
  if (typeof kill === 'function') {
    try {
      kill.call(processHandle, 'SIGKILL');
    } catch {
      // Disposal below is the authoritative cleanup path.
    }
  }
}

async function listCodexSessionCandidatesViaAppServerWithBudget(params: Readonly<{
  source: ExternalSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
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
    const startedAtMs = Date.now();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let client: Awaited<ReturnType<typeof createCodexAppServerClient>> | null = null;
    const abortController = new AbortController();
    const execDisposables = createPluginDisposableRegistry();

    const listPromise = (async (): Promise<ExternalSessionCandidateV1[] | null> => {
      try {
        client = await createCodexAppServerClient({
          exec: createPluginExecService({
            addDisposable: execDisposables.add,
            rpcLogAllowedDirectories: [configuration.logsDir],
            signal: abortController.signal,
          }),
          processEnv,
        });
        if (timedOut) {
          await client.dispose().catch(() => undefined);
          return null;
        }
        return await listCodexExternalSessionCandidatesViaExistingAppServerClient({ client, processEnv });
      } catch {
        return null;
      } finally {
        if (client) {
          await client.dispose().catch(() => undefined);
        }
        await execDisposables.dispose().catch(() => undefined);
      }
    })();

    const result = await Promise.race<ExternalSessionCandidateV1[] | null>([
      listPromise,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => {
          void (async () => {
            timedOut = true;
            abortController.abort();
            for (const disposable of execDisposables.entries()) {
              requestImmediateExecProcessKill(disposable);
            }
            const cleanupPromise = Promise.all([
              client?.dispose().catch(() => undefined) ?? Promise.resolve(undefined),
              execDisposables.dispose().catch(() => undefined),
            ]);
            void listPromise.catch(() => null);
            await Promise.race([
              cleanupPromise,
              wait(APP_SERVER_TIMEOUT_CLEANUP_WAIT_MS),
            ]);
            resolve(null);
          })();
        }, budgetMs);
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });

    logger.debug('[externalSessions.codex.appServerCandidates] list finished', {
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
  source: ExternalSessionsSource;
  activeServerDir: string;
  env?: NodeJS.ProcessEnv;
  cursor?: string;
  limit: number;
  searchTerm?: string;
  searchMode?: 'fast' | 'full';
}>): Promise<Readonly<{ candidates: ExternalSessionCandidateV1[]; nextCursor: string | null; searchIncomplete?: boolean }>> {
  const env = params.env ?? process.env;

  const offset = decodeCodexExternalSessionIndexCursor(params.cursor);
  const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim().toLowerCase() : '';
  const limit = Math.max(1, Math.trunc(params.limit));
  const rolloutListing = await rolloutCandidates({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env,
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
    return {
      candidates: rolloutListing.candidates,
      nextCursor,
    };
  }

  const appServerListing = params.searchMode === 'fast'
    ? { candidates: [] as ExternalSessionCandidateV1[], incomplete: Boolean(searchTerm) }
    : await listCodexSessionCandidatesViaAppServerWithBudget({
      source: params.source,
      activeServerDir: params.activeServerDir,
      env,
      searchTerm,
    });
  const appServerCandidates = appServerListing.candidates;
  const searchIncomplete = rolloutListing.searchIncomplete === true || appServerListing.incomplete === true;

  if (appServerCandidates.length === 0) {
    const nextOffset = offset + rolloutListing.candidates.length;
    const nextCursor = nextOffset < rolloutListing.totalCount ? encodeCodexExternalSessionIndexCursor(nextOffset) : null;
    return {
      candidates: rolloutListing.candidates,
      nextCursor,
      ...(searchIncomplete ? { searchIncomplete: true } : {}),
    };
  }

  const effectiveRolloutListing = appServerCandidates.length > 0 && offset > 0
    ? await rolloutCandidates({
      source: params.source,
      activeServerDir: params.activeServerDir,
      env,
      offset: 0,
      limit: offset + limit,
      searchTerm,
      searchMode: params.searchMode,
    })
    : rolloutListing;

  const merged = new Map<string, ExternalSessionCandidateV1>();
  for (const candidate of appServerCandidates) {
    merged.set(candidate.remoteSessionId, candidate);
  }
  for (const candidate of effectiveRolloutListing.candidates) {
    merged.set(candidate.remoteSessionId, candidate);
  }

  const candidates = Array.from(merged.values())
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs || String(a.remoteSessionId).localeCompare(String(b.remoteSessionId)))
    .slice(offset, offset + limit);
  const totalCount = Math.max(effectiveRolloutListing.totalCount, merged.size);

  const nextOffset = offset + candidates.length;
  const nextCursor = nextOffset < totalCount ? encodeCodexExternalSessionIndexCursor(nextOffset) : null;

  return {
    candidates,
    nextCursor,
    ...(searchIncomplete || effectiveRolloutListing.searchIncomplete === true ? { searchIncomplete: true } : {}),
  };
}

export function createCodexExternalSessionCandidateHostAdapter(params: Readonly<{
  activeServerDir: string;
  env?: NodeJS.ProcessEnv;
}>): ExternalSessionCandidateHostAdapter {
  return {
    providerId: 'codex',
    listViaChildHost: async (input) => {
      const res = await listCodexSessionCandidates({
        source: input.source,
        activeServerDir: params.activeServerDir,
        env: params.env ?? process.env,
        cursor: input.cursor,
        limit: input.limit,
        searchTerm: input.searchTerm,
        searchMode: input.searchMode,
      });
      return {
        candidates: res.candidates,
        nextCursor: res.nextCursor,
        ...(res.searchIncomplete ? { searchIncomplete: true } : {}),
      };
    },
  };
}
