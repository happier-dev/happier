import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { DirectSessionCandidateV1, DirectSessionsSource } from '@happier-dev/protocol';

import { deriveDirectSessionActivityFromTimestamp } from '@/api/directSessions/activity/deriveDirectSessionActivityFromTimestamp';
import { mapWithConcurrency } from '@/api/directSessions/discovery/mapWithConcurrency';
import { logger } from '@/utils/logger';

import { readClaudeSessionTitle } from './readClaudeSessionTitle';
import { readClaudeSessionWorkingDirectory } from './getClaudeDirectSessionWorkingDirectory';
import { resolveClaudeConfigDirForDirectSessions } from './resolveClaudeConfigDir';

type IndexCursorV1 = Readonly<{ v: 1; kind: 'index'; offset: number }>;

type DiscoveredClaudeSession = Readonly<{
  remoteSessionId: string;
  projectId: string;
  fullPath: string;
  updatedAtMs: number;
}>;

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

function parsePositiveIntEnv(params: Readonly<{
  env: NodeJS.ProcessEnv;
  key: string;
  defaultValue: number;
  min: number;
  max: number;
}>): number {
  const raw = Number.parseInt(String(params.env[params.key] ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : params.defaultValue;
  return Math.max(params.min, Math.min(params.max, configured));
}

function resolveClaudeSessionDiscoveryConcurrency(env: NodeJS.ProcessEnv): number {
  return parsePositiveIntEnv({
    env,
    key: 'HAPPIER_DIRECT_SESSIONS_CLAUDE_DISCOVERY_CONCURRENCY',
    defaultValue: 64,
    min: 1,
    max: 512,
  });
}

function resolveClaudeSearchTitleCandidateLimit(env: NodeJS.ProcessEnv): number {
  return parsePositiveIntEnv({
    env,
    key: 'HAPPIER_DIRECT_SESSIONS_CLAUDE_SEARCH_TITLE_CANDIDATE_LIMIT',
    defaultValue: 2000,
    min: 1,
    max: 50_000,
  });
}

function canSearchClaudeFilename(searchTerm: string): boolean {
  return searchTerm.length > 0 && !searchTerm.includes('/') && !searchTerm.includes('\\') && !searchTerm.endsWith('.jsonl');
}

async function buildClaudeCandidate(params: Readonly<{
  session: DiscoveredClaudeSession;
  env: NodeJS.ProcessEnv;
}>): Promise<DirectSessionCandidateV1> {
  let title: string | null = null;
  try {
    title = await readClaudeSessionTitle(params.session.fullPath);
  } catch {
    title = null;
  }
  const cwd = await readClaudeSessionWorkingDirectory(params.session.fullPath);

  return {
    remoteSessionId: params.session.remoteSessionId,
    ...(title ? { title } : {}),
    updatedAtMs: params.session.updatedAtMs,
    activity: deriveDirectSessionActivityFromTimestamp({ updatedAtMs: params.session.updatedAtMs, env: params.env }),
    details: { projectId: params.session.projectId, ...(cwd ? { cwd } : {}) },
  };
}

type ListClaudeSessionCandidatesParams = Readonly<{
  source: DirectSessionsSource;
  env?: NodeJS.ProcessEnv;
  cursor?: string;
  limit: number;
  searchTerm?: string;
  searchMode?: 'fast' | 'full';
}>;

type ClaudeSessionCandidatesListing = Readonly<{ candidates: DirectSessionCandidateV1[]; nextCursor: string | null; searchIncomplete?: boolean }>;

// Clients poll the candidate list, and a listing reads every transcript. Listing is a
// local filesystem scan that always settles, so an identical call arriving while one
// is running shares it instead of stacking another full scan on the daemon event loop.
// Only calls on the process environment are shared: a caller-supplied env is an input
// the key does not capture.
const inFlightListings = new Map<string, Promise<ClaudeSessionCandidatesListing>>();

export async function listClaudeSessionCandidates(params: ListClaudeSessionCandidatesParams): Promise<ClaudeSessionCandidatesListing> {
  if (params.env) return await scanClaudeSessionCandidates(params);
  const key = JSON.stringify([params.source, params.cursor ?? null, params.limit, params.searchTerm ?? null, params.searchMode ?? null]);
  const pending = inFlightListings.get(key);
  if (pending) return await pending;
  const started = scanClaudeSessionCandidates(params);
  inFlightListings.set(key, started);
  try {
    return await started;
  } finally {
    if (inFlightListings.get(key) === started) inFlightListings.delete(key);
  }
}

async function scanClaudeSessionCandidates(params: ListClaudeSessionCandidatesParams): Promise<ClaudeSessionCandidatesListing> {
  const env = params.env ?? process.env;
  const startedAtMs = Date.now();
  const startMemory = process.memoryUsage();
  const configDir = resolveClaudeConfigDirForDirectSessions({ source: params.source, env });
  const projectsDir = join(configDir, 'projects');
  const discoveryConcurrency = resolveClaudeSessionDiscoveryConcurrency(env);
  const limit = Math.max(1, Math.trunc(params.limit));
  const offset = decodeIndexCursor(params.cursor);

  const rawSearchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim() : '';
  const searchTerm = rawSearchTerm.toLowerCase();

  let projectEntries: any[];
  try {
    projectEntries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    projectEntries = [];
  }

  const exactSessionMatches = searchTerm && canSearchClaudeFilename(rawSearchTerm)
    ? (await mapWithConcurrency(projectEntries, discoveryConcurrency, async (projectEntry): Promise<DiscoveredClaudeSession | null> => {
      if (!projectEntry.isDirectory()) return null;
      if (projectEntry.isSymbolicLink()) return null;
      const projectId = typeof projectEntry.name === 'string' ? projectEntry.name : String(projectEntry.name);
      const fullPath = join(projectsDir, projectId, `${rawSearchTerm}.jsonl`);
      try {
        const s = await stat(fullPath);
        if (!s.isFile()) return null;
        return {
          remoteSessionId: rawSearchTerm,
          projectId,
          fullPath,
          updatedAtMs: Math.trunc(s.mtimeMs),
        } satisfies DiscoveredClaudeSession;
      } catch {
        return null;
      }
    })).filter((session): session is DiscoveredClaudeSession => session !== null)
    : [];

  if (exactSessionMatches.length > 0) {
    const sortedExactMatches = exactSessionMatches
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs || String(a.projectId).localeCompare(String(b.projectId)));
    const pageSessions = sortedExactMatches.slice(offset, offset + limit);
    const candidates = await mapWithConcurrency(pageSessions, discoveryConcurrency, (session) => buildClaudeCandidate({ session, env }));
    const nextOffset = offset + candidates.length;
    const nextCursor = nextOffset < sortedExactMatches.length ? encodeIndexCursor(nextOffset) : null;
    logger.debug('[directSessions.claude.candidates] exact id list finished', {
      elapsedMs: Date.now() - startedAtMs,
      searchTermLength: rawSearchTerm.length,
      returnedCandidates: candidates.length,
      heapDeltaBytes: process.memoryUsage().heapUsed - startMemory.heapUsed,
      rssBytes: process.memoryUsage().rss,
    });
    return { candidates, nextCursor };
  }

  const discoveredSessions = (
    await mapWithConcurrency(projectEntries, discoveryConcurrency, async (projectEntry): Promise<DiscoveredClaudeSession[]> => {
      if (!projectEntry.isDirectory()) return [];
      if (projectEntry.isSymbolicLink()) return [];

      const projectId = typeof projectEntry.name === 'string' ? projectEntry.name : String(projectEntry.name);
      const projectPath = join(projectsDir, projectId);

      let sessionEntries: any[];
      try {
        sessionEntries = await readdir(projectPath, { withFileTypes: true });
      } catch {
        return [];
      }

      const sessions = await mapWithConcurrency(sessionEntries, discoveryConcurrency, async (entry): Promise<DiscoveredClaudeSession | null> => {
        if (!entry.isFile()) return null;
        if (entry.isSymbolicLink()) return null;
        const name = typeof entry.name === 'string' ? entry.name : String(entry.name);
        if (!name.endsWith('.jsonl')) return null;
        const remoteSessionId = name.slice(0, -'.jsonl'.length);
        if (!remoteSessionId) return null;
        if (remoteSessionId.includes('/') || remoteSessionId.includes('\\')) return null;

        const full = join(projectPath, name);
        try {
          const s = await stat(full);
          return {
            remoteSessionId,
            projectId,
            fullPath: full,
            updatedAtMs: Math.trunc(s.mtimeMs),
          } satisfies DiscoveredClaudeSession;
        } catch {
          return null;
        }
      });

      return sessions.filter((session): session is DiscoveredClaudeSession => session !== null);
    })
  ).flat();

  const sortedSessions = discoveredSessions
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs || String(a.remoteSessionId).localeCompare(String(b.remoteSessionId)));

  let searchIncomplete = false;
  let searchedTotalCount: number | null = null;
  const searchedPage = searchTerm
    ? await (async (): Promise<DirectSessionCandidateV1[]> => {
      if (params.searchMode === 'fast') {
        searchIncomplete = true;
        const metadataMatches = sortedSessions.filter((session) => {
          const haystack = `${session.remoteSessionId} ${session.projectId}`.toLowerCase();
          return haystack.includes(searchTerm);
        });
        searchedTotalCount = metadataMatches.length;
        return mapWithConcurrency(
          metadataMatches.slice(offset, offset + limit),
          discoveryConcurrency,
          (session) => buildClaudeCandidate({ session, env }),
        );
      }

      const titleSearchLimit = resolveClaudeSearchTitleCandidateLimit(env);
      const sessionsToSearch = sortedSessions.slice(0, titleSearchLimit);
      searchIncomplete = sessionsToSearch.length < sortedSessions.length;
      const filtered = (await mapWithConcurrency(sessionsToSearch, discoveryConcurrency, async (session): Promise<DirectSessionCandidateV1 | null> => {
        const candidate = await buildClaudeCandidate({ session, env });
        const haystack = `${candidate.remoteSessionId} ${session.projectId}${candidate.title ? ` ${candidate.title}` : ''}`.toLowerCase();
        return haystack.includes(searchTerm) ? candidate : null;
      })).filter((candidate): candidate is DirectSessionCandidateV1 => candidate !== null);
      searchedTotalCount = filtered.length;
      return filtered.slice(offset, offset + limit);
    })()
    : null;

  const page = searchedPage
    ?? await mapWithConcurrency(sortedSessions.slice(offset, offset + limit), discoveryConcurrency, (session) => buildClaudeCandidate({ session, env }));
  const filteredCount = searchedTotalCount ?? sortedSessions.length;
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < filteredCount ? encodeIndexCursor(nextOffset) : null;

  logger.debug('[directSessions.claude.candidates] list finished', {
    elapsedMs: Date.now() - startedAtMs,
    searchTermLength: rawSearchTerm.length,
    searchMode: params.searchMode ?? 'default',
    discoveredSessions: sortedSessions.length,
    returnedCandidates: page.length,
    hasNextCursor: Boolean(nextCursor),
    searchIncomplete,
    heapDeltaBytes: process.memoryUsage().heapUsed - startMemory.heapUsed,
    rssBytes: process.memoryUsage().rss,
  });

  return {
    candidates: page,
    nextCursor,
    ...(searchIncomplete ? { searchIncomplete: true } : {}),
  };
}
