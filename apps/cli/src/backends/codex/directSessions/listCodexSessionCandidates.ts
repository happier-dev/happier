import type { DirectSessionCandidateV1, DirectSessionsSource } from '@happier-dev/protocol';

import { createCodexAppServerClient } from '../appServer/client/createCodexAppServerClient';
import { listCodexDirectSessionCandidatesViaExistingAppServerClient } from '../appServer/session/listCodexDirectSessionCandidatesViaAppServer';
import { listCodexDirectSessionCandidatesViaRollouts } from './listCodexDirectSessionCandidatesViaRollouts';
import { resolveCodexHomeEntriesForDirectSessionsSource } from './resolveCodexHomeEntriesForDirectSessionsSource';

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

async function listCodexSessionCandidatesViaAppServerWithBudget(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  searchTerm?: string;
}>): Promise<DirectSessionCandidateV1[]> {
  const budgetMs = resolveCodexDirectListAppServerBudgetMs(params.env);
  const homeEntries = await resolveCodexHomeEntriesForDirectSessionsSource({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
  });

  const listed: DirectSessionCandidateV1[] = [];
  const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim().toLowerCase() : '';
  for (const homeEntry of homeEntries) {
    const processEnv = {
      ...process.env,
      ...params.env,
      CODEX_HOME: homeEntry.codexHome,
    } as NodeJS.ProcessEnv;
    const client = await createCodexAppServerClient({ processEnv }).catch(() => null);
    if (!client) continue;
    const result = await Promise.race<DirectSessionCandidateV1[] | null>([
      listCodexDirectSessionCandidatesViaExistingAppServerClient({ client, processEnv })
        .then((value) => value)
        .catch(() => null)
        .finally(async () => {
          await client.dispose().catch(() => undefined);
        }),
      new Promise<null>((resolve) => setTimeout(async () => {
        await client.dispose().catch(() => undefined);
        resolve(null);
      }, budgetMs)),
    ]);
    if (!result) continue;
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

  return listed;
}

export async function listCodexSessionCandidates(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  env?: NodeJS.ProcessEnv;
  cursor?: string;
  limit: number;
  searchTerm?: string;
}>): Promise<Readonly<{ candidates: DirectSessionCandidateV1[]; nextCursor: string | null }>> {
  const env = params.env ?? process.env;

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
  });
  const appServerCandidates = await listCodexSessionCandidatesViaAppServerWithBudget({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env,
    searchTerm,
  });

  if (appServerCandidates.length === 0) {
    const nextOffset = offset + rolloutListing.candidates.length;
    const nextCursor = nextOffset < rolloutListing.totalCount ? encodeIndexCursor(nextOffset) : null;
    return {
      candidates: rolloutListing.candidates,
      nextCursor,
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
    })
    : rolloutListing;

  const merged = new Map<string, DirectSessionCandidateV1>();
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
  const nextCursor = nextOffset < totalCount ? encodeIndexCursor(nextOffset) : null;

  return { candidates, nextCursor };
}
