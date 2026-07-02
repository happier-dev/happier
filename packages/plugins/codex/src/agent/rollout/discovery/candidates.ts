import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { ExternalSessionsSource } from '@happier-dev/protocol';

import type { CodexExternalSessionHomeEntry } from './homeEntries.js';
import { homeEntries } from './homeEntries.js';
import {
  parseCodexRolloutSessionIdFromFilename,
  readCodexSessionMetaFromRollout,
} from './indexData.js';

export type CodexRolloutCandidateGroup = Readonly<{
  updatedAtMs: number;
  archived: boolean;
  latestFilePath: string;
  earliestFilePath: string;
  earliestMtimeMs: number;
  latestSortMs: number;
  earliestSortMs: number;
}>;

export type CodexRolloutCandidateEntry = Readonly<{
  remoteSessionId: string;
  source: CodexExternalSessionHomeEntry['source'];
  group: CodexRolloutCandidateGroup;
}>;

export type CodexRolloutCandidateSelection = Readonly<
  | {
    kind: 'direct';
    entries: CodexRolloutCandidateEntry[];
    totalCount: number;
    buildMode: 'sessionStore' | 'knownRolloutFiles';
    searchIncomplete?: boolean;
  }
  | {
    kind: 'candidateSearch';
    entries: CodexRolloutCandidateEntry[];
    groupedTotalCount: number;
    searchIncomplete: boolean;
  }
>;

type RolloutFileEntry = Readonly<{
  filePath: string;
  mtimeMs: number;
  archived: boolean;
}>;

type SearchableRolloutCandidate = Readonly<{
  remoteSessionId: string;
  title?: string | null;
  details?: unknown;
}>;

async function collectRolloutFiles(params: Readonly<{
  rootDir: string;
  maxDepth: number;
  archived: boolean;
  filenameIncludes?: string;
}>): Promise<RolloutFileEntry[]> {
  const out: RolloutFileEntry[] = [];
  const maxDepth = Math.max(0, Math.trunc(params.maxDepth));
  const filenameIncludes = typeof params.filenameIncludes === 'string'
    ? params.filenameIncludes.trim().toLowerCase()
    : '';

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const name = typeof entry.name === 'string' ? entry.name : String(entry.name);
      const full = join(dir, name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      if (filenameIncludes && !name.toLowerCase().includes(filenameIncludes)) continue;
      try {
        const s = await stat(full);
        out.push({ filePath: full, mtimeMs: s.mtimeMs, archived: params.archived });
      } catch {
        // Ignore unreadable rollout files; discovery should be best-effort.
      }
    }
  }

  await walk(params.rootDir, 0);
  return out;
}

function parseRolloutTimestampMs(filePath: string): number {
  const name = basename(filePath);
  const match = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-/i.exec(name);
  if (!match) return Number.NEGATIVE_INFINITY;
  const iso = `${match[1].replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3')}Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
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

export function resolveCodexRolloutSearchCandidateLimit(params: Readonly<{
  env: NodeJS.ProcessEnv;
  searchMode?: 'fast' | 'full';
}>): number {
  if (params.searchMode === 'fast') {
    return parsePositiveIntEnv({
      env: params.env,
      key: 'HAPPIER_CODEX_EXTERNAL_SESSIONS_FAST_SEARCH_CANDIDATE_LIMIT',
      defaultValue: 200,
      min: 1,
      max: 5000,
    });
  }
  return parsePositiveIntEnv({
    env: params.env,
    key: 'HAPPIER_CODEX_EXTERNAL_SESSIONS_FULL_SEARCH_CANDIDATE_LIMIT',
    defaultValue: 1000,
    min: 1,
    max: 25_000,
  });
}

export function resolveCodexRolloutSearchBuildConcurrency(env: NodeJS.ProcessEnv): number {
  return parsePositiveIntEnv({
    env,
    key: 'HAPPIER_CODEX_EXTERNAL_SESSIONS_SEARCH_BUILD_CONCURRENCY',
    defaultValue: 8,
    min: 1,
    max: 64,
  });
}

export function normalizeCodexRolloutCandidateSearchTerm(searchTerm: string | undefined): string {
  return typeof searchTerm === 'string' ? searchTerm.trim().toLowerCase() : '';
}

export function canSearchCodexRolloutFilename(searchTerm: string): boolean {
  return searchTerm.length >= 4 && /^[a-z0-9._:-]+$/i.test(searchTerm);
}

async function resolveRolloutCandidateSessionId(filePath: string): Promise<string | null> {
  const fromFilename = parseCodexRolloutSessionIdFromFilename(filePath);
  if (fromFilename) {
    return fromFilename;
  }
  const sessionMeta = await readCodexSessionMetaFromRollout(filePath);
  const sessionId = typeof sessionMeta?.id === 'string' ? sessionMeta.id.trim() : '';
  return sessionId || null;
}

export async function collectCodexRolloutCandidateEntries(params: Readonly<{
  source: ExternalSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  filenameIncludes?: string;
}>): Promise<CodexRolloutCandidateEntry[]> {
  const entries = await homeEntries({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
  });
  const grouped = new Map<string, {
    group: CodexRolloutCandidateGroup;
    source: CodexExternalSessionHomeEntry['source'];
  }>();

  for (const homeEntry of entries) {
    const files = [
      ...(await collectRolloutFiles({
        rootDir: join(homeEntry.codexHome, 'sessions'),
        maxDepth: 10,
        archived: false,
        filenameIncludes: params.filenameIncludes,
      })),
      ...(await collectRolloutFiles({
        rootDir: join(homeEntry.codexHome, 'archived_sessions'),
        maxDepth: 10,
        archived: true,
        filenameIncludes: params.filenameIncludes,
      })),
    ];
    for (const entry of files) {
      const remoteSessionId = await resolveRolloutCandidateSessionId(entry.filePath);
      if (!remoteSessionId) continue;
      const existing = grouped.get(remoteSessionId);
      const entrySortMs = parseRolloutTimestampMs(entry.filePath);
      if (!existing) {
        grouped.set(remoteSessionId, {
          source: homeEntry.source,
          group: {
            updatedAtMs: entry.mtimeMs,
            archived: entry.archived,
            latestFilePath: entry.filePath,
            earliestFilePath: entry.filePath,
            earliestMtimeMs: entry.mtimeMs,
            latestSortMs: entrySortMs,
            earliestSortMs: entrySortMs,
          },
        });
        continue;
      }
      grouped.set(remoteSessionId, {
        source: entrySortMs >= existing.group.latestSortMs ? homeEntry.source : existing.source,
        group: {
          updatedAtMs: Math.max(existing.group.updatedAtMs, entry.mtimeMs),
          archived: existing.group.archived && entry.archived,
          latestFilePath: entrySortMs >= existing.group.latestSortMs ? entry.filePath : existing.group.latestFilePath,
          earliestFilePath: entrySortMs <= existing.group.earliestSortMs ? entry.filePath : existing.group.earliestFilePath,
          earliestMtimeMs: Math.min(existing.group.earliestMtimeMs, entry.mtimeMs),
          latestSortMs: Math.max(existing.group.latestSortMs, entrySortMs),
          earliestSortMs: Math.min(existing.group.earliestSortMs, entrySortMs),
        },
      });
    }
  }

  return Array.from(grouped.entries())
    .map(([remoteSessionId, entry]) => ({
      remoteSessionId,
      source: entry.source,
      group: entry.group,
    }))
    .sort((a, b) => b.group.updatedAtMs - a.group.updatedAtMs || String(a.remoteSessionId).localeCompare(String(b.remoteSessionId)));
}

export async function selectCodexRolloutCandidateEntries(params: Readonly<{
  source: ExternalSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  offset?: number;
  limit?: number;
  searchTerm?: string;
  searchMode?: 'fast' | 'full';
}>): Promise<CodexRolloutCandidateSelection> {
  const searchTerm = normalizeCodexRolloutCandidateSearchTerm(params.searchTerm);
  const offset = Math.max(0, Math.trunc(params.offset ?? 0));
  const requestedLimit = Math.max(1, Math.trunc(params.limit ?? 1));

  if (searchTerm && canSearchCodexRolloutFilename(searchTerm)) {
    const filenameMatches = await collectCodexRolloutCandidateEntries({
      source: params.source,
      activeServerDir: params.activeServerDir,
      env: params.env,
      filenameIncludes: searchTerm,
    });
    if (filenameMatches.length > 0) {
      const exactIdMatch = filenameMatches.some(({ remoteSessionId }) => remoteSessionId.toLowerCase() === searchTerm);
      return {
        kind: 'direct',
        entries: filenameMatches.slice(offset, offset + requestedLimit),
        totalCount: filenameMatches.length,
        buildMode: exactIdMatch ? 'knownRolloutFiles' : 'sessionStore',
        ...(params.searchMode === 'fast' && !exactIdMatch ? { searchIncomplete: true } : {}),
      };
    }
    if (params.searchMode === 'fast') {
      return {
        kind: 'direct',
        entries: [],
        totalCount: 0,
        buildMode: 'sessionStore',
        searchIncomplete: true,
      };
    }
  }

  const groupedCandidates = await collectCodexRolloutCandidateEntries({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
  });

  if (!searchTerm) {
    return {
      kind: 'direct',
      entries: groupedCandidates.slice(offset, offset + requestedLimit),
      totalCount: groupedCandidates.length,
      buildMode: 'sessionStore',
    };
  }

  const searchCandidateLimit = resolveCodexRolloutSearchCandidateLimit({
    env: params.env,
    searchMode: params.searchMode,
  });
  const entriesToSearch = groupedCandidates.slice(0, searchCandidateLimit);
  return {
    kind: 'candidateSearch',
    entries: entriesToSearch,
    groupedTotalCount: groupedCandidates.length,
    searchIncomplete: entriesToSearch.length < groupedCandidates.length,
  };
}

function readCandidateCwd(candidate: SearchableRolloutCandidate): string | undefined {
  if (!candidate.details || typeof candidate.details !== 'object' || Array.isArray(candidate.details)) {
    return undefined;
  }
  const cwd = (candidate.details as Readonly<{ cwd?: unknown }>).cwd;
  return typeof cwd === 'string' ? cwd : undefined;
}

export function filterCodexRolloutCandidatesBySearchTerm<T extends SearchableRolloutCandidate>(params: Readonly<{
  candidates: readonly T[];
  searchTerm: string;
}>): T[] {
  const searchTerm = normalizeCodexRolloutCandidateSearchTerm(params.searchTerm);
  if (!searchTerm) {
    return [...params.candidates];
  }
  return params.candidates.filter((candidate) => {
    const cwd = readCandidateCwd(candidate);
    const title = typeof candidate.title === 'string' ? candidate.title : '';
    const haystack = `${candidate.remoteSessionId}${title ? ` ${title}` : ''}${cwd ? ` ${cwd}` : ''}`.toLowerCase();
    return haystack.includes(searchTerm);
  });
}
