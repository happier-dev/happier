import { type Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { DirectSessionCandidateV1, DirectSessionsSource } from '@happier-dev/protocol';

import { deriveDirectSessionActivityFromTimestamp } from '@/api/directSessions/activity/deriveDirectSessionActivityFromTimestamp';
import { mapWithConcurrency } from '@/api/directSessions/discovery/mapWithConcurrency';
import { logger } from '@/utils/logger';

import { readPiSessionHeader } from './readPiSessionHeader';
import { readPiSessionTitle } from './readPiSessionTitle';
import { extractPiSessionIdFromFilename, resolvePiDirectSessionFile } from './resolvePiDirectSessionFile';
import { resolvePiAgentDir } from './resolvePiAgentDir';

type IndexCursorV1 = Readonly<{ v: 1; kind: 'index'; offset: number }>;

function encodeIndexCursor(offset: number): string {
  const cursor: IndexCursorV1 = { v: 1, kind: 'index', offset: Math.max(0, Math.trunc(offset)) };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeIndexCursor(raw: string | undefined): number {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return 0;
    const value = parsed as Record<string, unknown>;
    if (value.v !== 1 || value.kind !== 'index') return 0;
    const offset = typeof value.offset === 'number' && Number.isFinite(value.offset) ? value.offset : 0;
    return Math.max(0, Math.trunc(offset));
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

function resolvePiDiscoveryConcurrency(env: NodeJS.ProcessEnv): number {
  return parsePositiveIntEnv({
    env,
    key: 'HAPPIER_DIRECT_SESSIONS_PI_DISCOVERY_CONCURRENCY',
    defaultValue: 64,
    min: 1,
    max: 512,
  });
}

function resolvePiSearchCandidateLimit(env: NodeJS.ProcessEnv): number {
  return parsePositiveIntEnv({
    env,
    key: 'HAPPIER_DIRECT_SESSIONS_PI_SEARCH_CANDIDATE_LIMIT',
    defaultValue: 2000,
    min: 1,
    max: 50_000,
  });
}

type DiscoveredPiSession = Readonly<{
  id: string;
  dirName: string;
  fileName: string;
  filePath: string;
  mtimeMs: number;
}>;

async function buildPiCandidate(params: Readonly<{
  session: DiscoveredPiSession;
  env: NodeJS.ProcessEnv;
}>): Promise<DirectSessionCandidateV1> {
  const [header, title] = await Promise.all([
    readPiSessionHeader(params.session.filePath).catch(() => null),
    readPiSessionTitle(params.session.filePath).catch(() => null),
  ]);

  // Prefer the authoritative header id; fall back to the filename UUID when the header is unreadable.
  const remoteSessionId = header?.id?.trim() || params.session.id;
  const cwd = header?.cwd?.trim() || null;

  return {
    remoteSessionId,
    ...(title ? { title } : {}),
    updatedAtMs: params.session.mtimeMs,
    activity: deriveDirectSessionActivityFromTimestamp({ updatedAtMs: params.session.mtimeMs, env: params.env }),
    details: {
      ...(cwd ? { cwd } : {}),
      sessionDirName: params.session.dirName,
    },
  };
}

export async function listPiSessionCandidates(params: Readonly<{
  source: DirectSessionsSource;
  env?: NodeJS.ProcessEnv;
  cursor?: string;
  limit: number;
  searchTerm?: string;
  searchMode?: 'fast' | 'full';
}>): Promise<Readonly<{ candidates: DirectSessionCandidateV1[]; nextCursor: string | null; searchIncomplete?: boolean }>> {
  const env = params.env ?? process.env;
  const startedAtMs = Date.now();
  const agentDir = resolvePiAgentDir({ source: params.source, env });
  const sessionsDir = join(agentDir, 'sessions');
  const concurrency = resolvePiDiscoveryConcurrency(env);
  const limit = Math.max(1, Math.trunc(params.limit));
  const offset = decodeIndexCursor(params.cursor);

  const rawSearchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim() : '';
  const searchTerm = rawSearchTerm.toLowerCase();

  let dirEntries: Dirent<string>[];
  try {
    dirEntries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    dirEntries = [];
  }

  // Phase 1: stat every session file. The session id is the filename UUID, so no header read is
  // needed for discovery — headers/titles are read only for the page slice (Phase 2).
  const discoveredSessions = (
    await mapWithConcurrency(dirEntries, concurrency, async (dirEntry): Promise<DiscoveredPiSession[]> => {
      if (!dirEntry.isDirectory()) return [];
      if (dirEntry.isSymbolicLink()) return [];
      const dirName = typeof dirEntry.name === 'string' ? dirEntry.name : String(dirEntry.name);
      if (!dirName || dirName.includes('/') || dirName.includes('\\')) return [];

      let fileEntries: Dirent<string>[];
      try {
        fileEntries = await readdir(join(sessionsDir, dirName), { withFileTypes: true });
      } catch {
        return [];
      }

      const sessions = await mapWithConcurrency(fileEntries, concurrency, async (fe): Promise<DiscoveredPiSession | null> => {
        if (!fe.isFile()) return null;
        if (fe.isSymbolicLink()) return null;
        const fileName = typeof fe.name === 'string' ? fe.name : String(fe.name);
        const id = extractPiSessionIdFromFilename(fileName);
        if (!id) return null;
        const filePath = join(sessionsDir, dirName, fileName);
        try {
          const s = await stat(filePath);
          if (!s.isFile()) return null;
          return { id, dirName, fileName, filePath, mtimeMs: Math.trunc(s.mtimeMs) };
        } catch {
          return null;
        }
      });

      return sessions.filter((session): session is DiscoveredPiSession => session !== null);
    })
  ).flat();

  const sortedSessions = discoveredSessions.sort(
    (a, b) => b.mtimeMs - a.mtimeMs || String(a.id).localeCompare(String(b.id)),
  );

  // Exact-id fast path: when the search term is a bare session id, resolve straight to that file
  // (authoritative, no scan-order dependence).
  if (searchTerm && !rawSearchTerm.includes('/')) {
    const resolved = await resolvePiDirectSessionFile({ source: params.source, env, remoteSessionId: rawSearchTerm }).catch(() => null);
    if (resolved) {
      let exactStat: Awaited<ReturnType<typeof stat>> | null = null;
      try {
        exactStat = await stat(resolved.filePath);
      } catch {
        exactStat = null;
      }
      if (exactStat?.isFile()) {
        const pageOffset = Math.min(offset, 1);
        if (pageOffset > 0) {
          return { candidates: [], nextCursor: null };
        }
        const candidate = await buildPiCandidate({
          session: {
            id: rawSearchTerm,
            dirName: '',
            fileName: '',
            filePath: resolved.filePath,
            mtimeMs: Math.trunc(exactStat.mtimeMs),
          },
          env,
        });
        return { candidates: [candidate], nextCursor: null };
      }
    }
  }

  let searchIncomplete = false;
  let searchedPage: DirectSessionCandidateV1[] | null = null;

  if (searchTerm) {
    if (params.searchMode === 'fast') {
      searchIncomplete = true;
      const metadataMatches = sortedSessions.filter((session) => {
        const haystack = `${session.id} ${session.dirName}`.toLowerCase();
        return haystack.includes(searchTerm);
      });
      const page = metadataMatches.slice(offset, offset + limit);
      searchedPage = await mapWithConcurrency(page, concurrency, (session) => buildPiCandidate({ session, env }));
    } else {
      const searchCandidateLimit = resolvePiSearchCandidateLimit(env);
      const sessionsToSearch = sortedSessions.slice(0, searchCandidateLimit);
      searchIncomplete = sessionsToSearch.length < sortedSessions.length;
      const withTitles = await mapWithConcurrency(sessionsToSearch, concurrency, async (session): Promise<DirectSessionCandidateV1 | null> => {
        const candidate = await buildPiCandidate({ session, env });
        const haystack = `${candidate.remoteSessionId} ${session.dirName}${candidate.title ? ` ${candidate.title}` : ''}`.toLowerCase();
        return haystack.includes(searchTerm) ? candidate : null;
      });
      const filtered = withTitles.filter((candidate): candidate is DirectSessionCandidateV1 => candidate !== null);
      searchedPage = filtered.slice(offset, offset + limit);
    }
  }

  const page =
    searchedPage
    ?? await mapWithConcurrency(sortedSessions.slice(offset, offset + limit), concurrency, (session) => buildPiCandidate({ session, env }));

  const filteredCount = searchTerm
    ? (searchedPage ? Math.max(sortedSessions.length, offset + page.length) : sortedSessions.length)
    : sortedSessions.length;
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < filteredCount ? encodeIndexCursor(nextOffset) : null;

  logger.debug('[directSessions.pi.candidates] list finished', {
    elapsedMs: Date.now() - startedAtMs,
    searchTermLength: rawSearchTerm.length,
    searchMode: params.searchMode ?? 'default',
    discoveredSessions: sortedSessions.length,
    returnedCandidates: page.length,
    hasNextCursor: Boolean(nextCursor),
    searchIncomplete,
  });

  return {
    candidates: page,
    nextCursor,
    ...(searchIncomplete ? { searchIncomplete: true } : {}),
  };
}
