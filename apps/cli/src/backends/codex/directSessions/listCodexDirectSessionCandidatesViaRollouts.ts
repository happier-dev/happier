import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { DirectSessionCandidateV1 } from '@happier-dev/protocol';

import { deriveDirectSessionActivityFromTimestamp } from '@/api/directSessions/activity/deriveDirectSessionActivityFromTimestamp';
import { mapWithConcurrency } from '@/api/directSessions/discovery/mapWithConcurrency';

import { readCodexSessionMetaFromRollout } from '../localControl/rolloutDiscovery';
import { readCodexSessionTitleFromRollout } from './readCodexSessionTitleFromRollout';
import type { CodexDirectSessionHomeEntry } from './resolveCodexHomeEntriesForDirectSessionsSource';
import { resolveCodexHomeEntriesForDirectSessionsSource } from './resolveCodexHomeEntriesForDirectSessionsSource';

type RolloutCandidateGroup = Readonly<{
  updatedAtMs: number;
  archived: boolean;
  latestFilePath: string;
  earliestFilePath: string;
  earliestMtimeMs: number;
  latestSortMs: number;
  earliestSortMs: number;
}>;

async function collectRolloutFiles(params: Readonly<{
  rootDir: string;
  maxDepth: number;
  archived: boolean;
  filenameIncludes?: string;
}>): Promise<Array<{ filePath: string; mtimeMs: number; archived: boolean }>> {
  const out: Array<{ filePath: string; mtimeMs: number; archived: boolean }> = [];
  const maxDepth = Math.max(0, Math.trunc(params.maxDepth));
  const filenameIncludes = typeof params.filenameIncludes === 'string'
    ? params.filenameIncludes.trim().toLowerCase()
    : '';

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: any[];
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
        // ignore unreadable
      }
    }
  }

  await walk(params.rootDir, 0);
  return out;
}

function parseResumeIdFromRolloutFilename(filePath: string): string | null {
  const name = basename(filePath);
  const match = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/i.exec(name);
  return match ? match[1] : null;
}

function isCanonicalCodexThreadId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function resolveResumeIdFromRolloutFile(filePath: string): Promise<string | null> {
  const filenameId = parseResumeIdFromRolloutFilename(filePath);
  if (!filenameId) return null;

  // Codex normally ends rollout filenames with the thread UUID. Newer Codex versions can append
  // a second UUID for a fork/continuation (for example `<thread>_<turn>`), while session_meta.id
  // remains the UUID accepted by thread/resume. Keep the fast filename path for canonical IDs and
  // consult the rollout metadata only for non-canonical suffixes.
  if (isCanonicalCodexThreadId(filenameId)) return filenameId;
  const metadata = await readCodexSessionMetaFromRollout(filePath);
  const metadataId = typeof metadata?.id === 'string' ? metadata.id.trim() : '';
  return metadataId || filenameId;
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

function resolveRolloutSearchCandidateLimit(params: Readonly<{ env: NodeJS.ProcessEnv; searchMode?: 'fast' | 'full' }>): number {
  if (params.searchMode === 'fast') {
    return parsePositiveIntEnv({
      env: params.env,
      key: 'HAPPIER_CODEX_DIRECT_SESSIONS_FAST_SEARCH_CANDIDATE_LIMIT',
      defaultValue: 200,
      min: 1,
      max: 5000,
    });
  }
  return parsePositiveIntEnv({
    env: params.env,
    key: 'HAPPIER_CODEX_DIRECT_SESSIONS_FULL_SEARCH_CANDIDATE_LIMIT',
    defaultValue: 1000,
    min: 1,
    max: 25_000,
  });
}

function resolveRolloutSearchBuildConcurrency(env: NodeJS.ProcessEnv): number {
  return parsePositiveIntEnv({
    env,
    key: 'HAPPIER_CODEX_DIRECT_SESSIONS_SEARCH_BUILD_CONCURRENCY',
    defaultValue: 8,
    min: 1,
    max: 64,
  });
}

function canSearchRolloutFilename(searchTerm: string): boolean {
  return searchTerm.length >= 4 && /^[a-z0-9._:-]+$/i.test(searchTerm);
}

async function buildRolloutCandidate(params: Readonly<{
  remoteSessionId: string;
  group: RolloutCandidateGroup;
  env: NodeJS.ProcessEnv;
  source: CodexDirectSessionHomeEntry['source'];
}>): Promise<DirectSessionCandidateV1> {
  const [latestMeta, earliestMeta, title] = await Promise.all([
    readCodexSessionMetaFromRollout(params.group.latestFilePath),
    readCodexSessionMetaFromRollout(params.group.earliestFilePath),
    readCodexSessionTitleFromRollout(params.group.earliestFilePath),
  ]);
  const cwd = latestMeta && typeof latestMeta.cwd === 'string' ? latestMeta.cwd : undefined;
  const createdAtMs = (() => {
    const ts = earliestMeta && typeof earliestMeta.timestamp === 'string' ? Date.parse(earliestMeta.timestamp) : NaN;
    if (Number.isFinite(ts) && ts >= 0) return Math.trunc(ts);
    return Math.trunc(params.group.earliestMtimeMs);
  })();

  return {
    remoteSessionId: params.remoteSessionId,
    ...(title ? { title } : {}),
    createdAtMs,
    updatedAtMs: Math.trunc(params.group.updatedAtMs),
    archived: params.group.archived,
    activity: deriveDirectSessionActivityFromTimestamp({ updatedAtMs: params.group.updatedAtMs, env: params.env }),
    details: {
      ...(cwd ? { cwd } : {}),
      source: params.source,
    },
  };
}

export async function listCodexDirectSessionCandidatesViaRollouts(params: Readonly<{
  source: CodexDirectSessionHomeEntry['source'];
  activeServerDir: string;
  env?: NodeJS.ProcessEnv;
  offset?: number;
  limit?: number;
  searchTerm?: string;
  searchMode?: 'fast' | 'full';
}>): Promise<Readonly<{ candidates: DirectSessionCandidateV1[]; totalCount: number; searchIncomplete?: boolean }>> {
  const env = params.env ?? process.env;
  const homeEntries = await resolveCodexHomeEntriesForDirectSessionsSource({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env,
  });
  const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim().toLowerCase() : '';
  const offset = Math.max(0, Math.trunc(params.offset ?? 0));
  const requestedLimit = Math.max(1, Math.trunc(params.limit ?? 1));

  async function collectGroupedCandidates(filenameIncludes?: string): Promise<Array<{
    remoteSessionId: string;
    entry: { group: RolloutCandidateGroup; source: CodexDirectSessionHomeEntry['source'] };
  }>> {
    const grouped = new Map<string, { group: RolloutCandidateGroup; source: CodexDirectSessionHomeEntry['source'] }>();
    for (const homeEntry of homeEntries) {
      const files = [
        ...(await collectRolloutFiles({ rootDir: join(homeEntry.codexHome, 'sessions'), maxDepth: 10, archived: false, filenameIncludes })),
        ...(await collectRolloutFiles({ rootDir: join(homeEntry.codexHome, 'archived_sessions'), maxDepth: 10, archived: true, filenameIncludes })),
      ];
      for (const entry of files) {
        const resumeId = await resolveResumeIdFromRolloutFile(entry.filePath);
        if (!resumeId) continue;
        const existing = grouped.get(resumeId);
        const entrySortMs = parseRolloutTimestampMs(entry.filePath);
        if (!existing) {
          grouped.set(resumeId, {
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
        grouped.set(resumeId, {
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
      .map(([remoteSessionId, entry]) => ({ remoteSessionId, entry }))
      .sort((a, b) => b.entry.group.updatedAtMs - a.entry.group.updatedAtMs || String(a.remoteSessionId).localeCompare(String(b.remoteSessionId)));
  }

  async function buildCandidates(entries: ReadonlyArray<{
    remoteSessionId: string;
    entry: { group: RolloutCandidateGroup; source: CodexDirectSessionHomeEntry['source'] };
  }>): Promise<DirectSessionCandidateV1[]> {
    return mapWithConcurrency(entries, resolveRolloutSearchBuildConcurrency(env), ({ remoteSessionId, entry }) =>
      buildRolloutCandidate({ remoteSessionId, group: entry.group, env, source: entry.source }),
    );
  }

  if (searchTerm && canSearchRolloutFilename(searchTerm)) {
    const filenameMatches = await collectGroupedCandidates(searchTerm);
    if (filenameMatches.length > 0) {
      const pageEntries = filenameMatches.slice(offset, offset + requestedLimit);
      const candidates = await buildCandidates(pageEntries);
      const exactIdMatch = filenameMatches.some(({ remoteSessionId }) => remoteSessionId.toLowerCase() === searchTerm);
      return {
        candidates,
        totalCount: filenameMatches.length,
        searchIncomplete: params.searchMode === 'fast' && !exactIdMatch,
      };
    }
    if (params.searchMode === 'fast') {
      return { candidates: [], totalCount: 0, searchIncomplete: true };
    }
  }

  const groupedCandidates = await collectGroupedCandidates();
  const limit = Math.max(1, Math.trunc(params.limit ?? groupedCandidates.length ?? 1));

  if (!searchTerm) {
    const pageEntries = groupedCandidates.slice(offset, offset + limit);
    const candidates = await buildCandidates(pageEntries);
    return { candidates, totalCount: groupedCandidates.length };
  }

  const searchCandidateLimit = resolveRolloutSearchCandidateLimit({ env, searchMode: params.searchMode });
  const entriesToSearch = groupedCandidates.slice(0, searchCandidateLimit);
  const allCandidates = await buildCandidates(entriesToSearch);
  const filtered = allCandidates.filter((candidate) => {
    const cwd = candidate.details?.cwd;
    const title = candidate.title;
    const haystack = `${candidate.remoteSessionId}${title ? ` ${title}` : ''}${cwd ? ` ${cwd}` : ''}`.toLowerCase();
    return haystack.includes(searchTerm);
  });

  return {
    candidates: filtered.slice(offset, offset + limit),
    totalCount: filtered.length,
    searchIncomplete: entriesToSearch.length < groupedCandidates.length,
  };
}
