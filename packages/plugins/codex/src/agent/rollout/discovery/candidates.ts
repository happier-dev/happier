import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  mapCodexExternalSessionWorkWithConcurrency,
  throwIfCodexExternalSessionInvocationStopped,
  type CodexExternalSessionInvocationBounds,
} from '../../surfaces/sessions/external/invocationBounds.js';
import type { CodexExternalSessionSource } from '../../surfaces/sessions/external/models.js';
import type { CodexExternalSessionHomeEntry } from './homeEntries.js';
import { homeEntries } from './homeEntries.js';
import {
  parseCodexRolloutSessionIdFromFilename,
  readCodexSessionMetaFromRollout,
} from './indexData.js';
import {
  CODEX_ROLLOUT_TITLE_HEAD_BUDGET,
  readCodexSessionTitleFromRollout,
} from './rolloutTitle.js';

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
  /**
   * The session's first user message, read from the same earliest rollout file
   * the selected-candidate build reads. Absent when the row has no usable title;
   * an identifier-only row is correct, an invented one is not.
   */
  title?: string;
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

/**
 * Continuation key for the bounded candidate scan the host candidate-index owner
 * drives. It names a traversal position — the last rollout file consumed, in the
 * deterministic container/filename order below — not a position in the final
 * last-activity order, because the host index alone sorts and serves the ordered
 * page. A traversal position is stable under the mutation a browse actually
 * races: appending to an existing rollout moves that session's activity key but
 * not its place in the traversal. Fencing it on every swept file's mtime instead
 * would restart the whole multi-chunk build on any live Codex turn.
 *
 * `sourceGeneration` is scoped to exactly what THIS resume point depends on: the
 * single day container the cursor resumes inside, whose entry set decides
 * whether `fileName` is still the right anchor. A rollout created in any other
 * container cannot move that anchor, so it must not discard an in-progress
 * build — a corpus-wide generation makes an actively used Codex install restart
 * its build faster than the build advances, and it never converges.
 */
export type CodexRolloutCandidateScanBoundary = Readonly<{
  sourceGeneration: string;
  containerKey: string;
  fileName: string;
  scanned: number;
}>;

export type CodexRolloutCandidateScanChunk = Readonly<{
  entries: CodexRolloutCandidateEntry[];
  sourceGeneration: string;
  /** Cumulative rollout files consumed by this build, for `preparation.scanned`. */
  scanned: number;
  nextBoundary: CodexRolloutCandidateScanBoundary | null;
  sourceChanged?: boolean;
}>;

type RolloutFileEntry = Readonly<{
  filePath: string;
  mtimeMs: number;
  archived: boolean;
}>;

type CandidateContainer = Readonly<{
  key: string;
  dir: string;
  archived: boolean;
  source: CodexExternalSessionHomeEntry['source'];
}>;

type SearchableRolloutCandidate = Readonly<{
  remoteSessionId: string;
  title?: string | null;
  details?: unknown;
}>;

type GroupedRolloutCandidates = Map<string, {
  group: CodexRolloutCandidateGroup;
  source: CodexExternalSessionHomeEntry['source'];
}>;

/**
 * Ordering is compared by UTF-16 code unit, never by `localeCompare`: the host
 * candidate-query owner sorts and validates candidate pages with an explicit
 * code-unit comparator, and Codex provider ids are not guaranteed lowercase
 * UUIDs (both rollout filenames and `session_meta.id` accept arbitrary ids), so
 * ICU collation would order a page the host then rejects as unordered.
 */
export function compareCodexRolloutCandidateCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * The single candidate ordering rule: most recent activity first, with the
 * provider session id breaking ties so paging is deterministic.
 */
export function compareCodexRolloutCandidateEntries(
  left: CodexRolloutCandidateEntry,
  right: CodexRolloutCandidateEntry,
): number {
  return right.group.updatedAtMs - left.group.updatedAtMs
    || compareCodexRolloutCandidateCodeUnits(
      String(left.remoteSessionId),
      String(right.remoteSessionId),
    );
}

function mergeRolloutCandidateFile(params: Readonly<{
  grouped: GroupedRolloutCandidates;
  remoteSessionId: string;
  filePath: string;
  mtimeMs: number;
  archived: boolean;
  source: CodexExternalSessionHomeEntry['source'];
}>): void {
  const entrySortMs = parseRolloutTimestampMs(params.filePath);
  const existing = params.grouped.get(params.remoteSessionId);
  if (!existing) {
    params.grouped.set(params.remoteSessionId, {
      source: params.source,
      group: {
        updatedAtMs: params.mtimeMs,
        archived: params.archived,
        latestFilePath: params.filePath,
        earliestFilePath: params.filePath,
        earliestMtimeMs: params.mtimeMs,
        latestSortMs: entrySortMs,
        earliestSortMs: entrySortMs,
      },
    });
    return;
  }
  params.grouped.set(params.remoteSessionId, {
    source: entrySortMs >= existing.group.latestSortMs ? params.source : existing.source,
    group: {
      updatedAtMs: Math.max(existing.group.updatedAtMs, params.mtimeMs),
      archived: existing.group.archived && params.archived,
      latestFilePath: entrySortMs >= existing.group.latestSortMs
        ? params.filePath
        : existing.group.latestFilePath,
      earliestFilePath: entrySortMs <= existing.group.earliestSortMs
        ? params.filePath
        : existing.group.earliestFilePath,
      earliestMtimeMs: Math.min(existing.group.earliestMtimeMs, params.mtimeMs),
      latestSortMs: Math.max(existing.group.latestSortMs, entrySortMs),
      earliestSortMs: Math.min(existing.group.earliestSortMs, entrySortMs),
    },
  });
}

function toOrderedRolloutCandidateEntries(
  grouped: GroupedRolloutCandidates,
): CodexRolloutCandidateEntry[] {
  return Array.from(grouped.entries())
    .map(([remoteSessionId, entry]) => ({
      remoteSessionId,
      source: entry.source,
      group: entry.group,
    }))
    .sort(compareCodexRolloutCandidateEntries);
}

async function collectRolloutFiles(params: Readonly<{
  rootDir: string;
  maxDepth: number;
  archived: boolean;
  filenameIncludes?: string;
}> & CodexExternalSessionInvocationBounds): Promise<RolloutFileEntry[]> {
  const out: RolloutFileEntry[] = [];
  const maxDepth = Math.max(0, Math.trunc(params.maxDepth));
  const filenameIncludes = typeof params.filenameIncludes === 'string'
    ? params.filenameIncludes.trim().toLowerCase()
    : '';

  async function walk(dir: string, depth: number): Promise<void> {
    throwIfCodexExternalSessionInvocationStopped(params);
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      throwIfCodexExternalSessionInvocationStopped(params);
      return;
    }
    throwIfCodexExternalSessionInvocationStopped(params);
    for (const entry of entries) {
      throwIfCodexExternalSessionInvocationStopped(params);
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
        throwIfCodexExternalSessionInvocationStopped(params);
        out.push({ filePath: full, mtimeMs: s.mtimeMs, archived: params.archived });
      } catch {
        throwIfCodexExternalSessionInvocationStopped(params);
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

async function resolveRolloutCandidateSessionId(
  filePath: string,
  bounds: CodexExternalSessionInvocationBounds,
): Promise<string | null> {
  throwIfCodexExternalSessionInvocationStopped(bounds);
  const fromFilename = parseCodexRolloutSessionIdFromFilename(filePath);
  if (fromFilename) {
    return fromFilename;
  }
  const sessionMeta = await readCodexSessionMetaFromRollout(filePath, bounds);
  throwIfCodexExternalSessionInvocationStopped(bounds);
  const sessionId = typeof sessionMeta?.id === 'string' ? sessionMeta.id.trim() : '';
  return sessionId || null;
}

export async function collectCodexRolloutCandidateEntries(params: Readonly<{
  source: CodexExternalSessionSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  filenameIncludes?: string;
}> & CodexExternalSessionInvocationBounds): Promise<CodexRolloutCandidateEntry[]> {
  throwIfCodexExternalSessionInvocationStopped(params);
  const entries = await homeEntries({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env: params.env,
    signal: params.signal,
    deadlineAtMs: params.deadlineAtMs,
  });
  throwIfCodexExternalSessionInvocationStopped(params);
  const grouped: GroupedRolloutCandidates = new Map();

  for (const homeEntry of entries) {
    throwIfCodexExternalSessionInvocationStopped(params);
    const files = [
      ...(await collectRolloutFiles({
        rootDir: join(homeEntry.codexHome, 'sessions'),
        maxDepth: 10,
        archived: false,
        filenameIncludes: params.filenameIncludes,
        signal: params.signal,
        deadlineAtMs: params.deadlineAtMs,
      })),
      ...(await collectRolloutFiles({
        rootDir: join(homeEntry.codexHome, 'archived_sessions'),
        maxDepth: 10,
        archived: true,
        filenameIncludes: params.filenameIncludes,
        signal: params.signal,
        deadlineAtMs: params.deadlineAtMs,
      })),
    ];
    for (const entry of files) {
      throwIfCodexExternalSessionInvocationStopped(params);
      const remoteSessionId = await resolveRolloutCandidateSessionId(entry.filePath, params);
      if (!remoteSessionId) continue;
      mergeRolloutCandidateFile({
        grouped,
        remoteSessionId,
        filePath: entry.filePath,
        mtimeMs: entry.mtimeMs,
        archived: entry.archived,
        source: homeEntry.source,
      });
    }
  }

  return toOrderedRolloutCandidateEntries(grouped);
}

export async function selectCodexRolloutCandidateEntries(params: Readonly<{
  source: CodexExternalSessionSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  offset?: number;
  limit?: number;
  searchTerm?: string;
  searchMode?: 'fast' | 'full';
}> & CodexExternalSessionInvocationBounds): Promise<CodexRolloutCandidateSelection> {
  throwIfCodexExternalSessionInvocationStopped(params);
  const searchTerm = normalizeCodexRolloutCandidateSearchTerm(params.searchTerm);
  const offset = Math.max(0, Math.trunc(params.offset ?? 0));
  const requestedLimit = Math.max(1, Math.trunc(params.limit ?? 1));

  if (searchTerm && canSearchCodexRolloutFilename(searchTerm)) {
    const filenameMatches = await collectCodexRolloutCandidateEntries({
      source: params.source,
      activeServerDir: params.activeServerDir,
      env: params.env,
      filenameIncludes: searchTerm,
      signal: params.signal,
      deadlineAtMs: params.deadlineAtMs,
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
    signal: params.signal,
    deadlineAtMs: params.deadlineAtMs,
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

async function readDirectoryEntries(
  dir: string,
  bounds: CodexExternalSessionInvocationBounds,
): Promise<Dirent[]> {
  throwIfCodexExternalSessionInvocationStopped(bounds);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    throwIfCodexExternalSessionInvocationStopped(bounds);
    return entries;
  } catch {
    throwIfCodexExternalSessionInvocationStopped(bounds);
    return [];
  }
}

async function describeDirectoryGeneration(
  dir: string,
  bounds: CodexExternalSessionInvocationBounds,
): Promise<string> {
  throwIfCodexExternalSessionInvocationStopped(bounds);
  try {
    const metadata = await stat(dir, { bigint: true });
    throwIfCodexExternalSessionInvocationStopped(bounds);
    return [
      String(metadata.dev),
      String(metadata.ino),
      String(metadata.birthtimeNs),
      String(metadata.mtimeNs),
      String(metadata.ctimeNs),
      String(metadata.size),
    ].join(':');
  } catch {
    throwIfCodexExternalSessionInvocationStopped(bounds);
    return 'missing';
  }
}

function directoryEntryName(entry: Dirent): string {
  return typeof entry.name === 'string' ? entry.name : String(entry.name);
}

function isDirectoryEntry(entry: Dirent, pattern: RegExp): boolean {
  return entry.isDirectory()
    && !entry.isSymbolicLink()
    && pattern.test(directoryEntryName(entry));
}

async function listCandidateContainersForHome(params: Readonly<{
  entry: CodexExternalSessionHomeEntry;
  homeIndex: number;
}> & CodexExternalSessionInvocationBounds): Promise<CandidateContainer[]> {
  const containers: CandidateContainer[] = [];
  const homeKey = String(params.homeIndex).padStart(6, '0');
  const sessionsRoot = join(params.entry.codexHome, 'sessions');
  const yearEntries = await readDirectoryEntries(sessionsRoot, params);
  containers.push({
    key: `${homeKey}:2:0000/00/00`,
    dir: sessionsRoot,
    archived: false,
    source: params.entry.source,
  });
  for (const yearEntry of yearEntries.filter((entry) =>
    isDirectoryEntry(entry, /^\d{4}$/u),
  )) {
    throwIfCodexExternalSessionInvocationStopped(params);
    const year = directoryEntryName(yearEntry);
    const yearDir = join(sessionsRoot, year);
    const monthEntries = await readDirectoryEntries(yearDir, params);
    for (const monthEntry of monthEntries.filter((entry) =>
      isDirectoryEntry(entry, /^(?:0[1-9]|1[0-2])$/u),
    )) {
      throwIfCodexExternalSessionInvocationStopped(params);
      const month = directoryEntryName(monthEntry);
      const monthDir = join(yearDir, month);
      const dayEntries = await readDirectoryEntries(monthDir, params);
      for (const dayEntry of dayEntries.filter((entry) =>
        isDirectoryEntry(entry, /^(?:0[1-9]|[12]\d|3[01])$/u),
      )) {
        throwIfCodexExternalSessionInvocationStopped(params);
        const day = directoryEntryName(dayEntry);
        // Codex's measured native layout is sessions/YYYY/MM/DD/*.jsonl.
        // Keep day contents lazy so page one never stats/builds the full corpus.
        containers.push({
          key: `${homeKey}:2:${year}/${month}/${day}`,
          dir: join(monthDir, day),
          archived: false,
          source: params.entry.source,
        });
      }
    }
  }

  containers.push({
    key: `${homeKey}:1:0000/00/00`,
    dir: join(params.entry.codexHome, 'archived_sessions'),
    archived: true,
    source: params.entry.source,
  });
  return containers;
}

/**
 * Fingerprints exactly what one resume point depends on: the container the
 * cursor resumes inside. Its entry set is what decides whether the boundary's
 * `fileName` anchor is still correct, so a mutation there must invalidate the
 * cursor and a mutation anywhere else must not.
 */
async function resolveResumeContainerGeneration(params: Readonly<{
  containers: readonly CandidateContainer[];
  containerKey: string | null;
}> & CodexExternalSessionInvocationBounds): Promise<string> {
  throwIfCodexExternalSessionInvocationStopped(params);
  const hash = createHash('sha256').update('codexRolloutCandidateResume:v1\n', 'utf8');
  if (!params.containerKey) {
    return hash.update('none\n', 'utf8').digest('base64url');
  }
  const container = params.containers.find(({ key }) => key === params.containerKey);
  hash.update(`${params.containerKey}:`, 'utf8');
  hash.update(
    container
      ? `${await describeDirectoryGeneration(container.dir, params)}\n`
      : 'missing\n',
    'utf8',
  );
  return hash.digest('base64url');
}

async function listCandidateCorpusContainers(params: Readonly<{
  source: CodexExternalSessionSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
}> & CodexExternalSessionInvocationBounds): Promise<CandidateContainer[]> {
  throwIfCodexExternalSessionInvocationStopped(params);
  const entries = (await homeEntries(params))
    .sort((left, right) =>
      compareCodexRolloutCandidateCodeUnits(left.codexHome, right.codexHome)
      || compareCodexRolloutCandidateCodeUnits(
        JSON.stringify(left.source),
        JSON.stringify(right.source),
      ),
    );
  const perHome = await Promise.all(entries.map((entry, homeIndex) =>
    listCandidateContainersForHome({
      entry,
      homeIndex,
      signal: params.signal,
      deadlineAtMs: params.deadlineAtMs,
    }),
  ));
  throwIfCodexExternalSessionInvocationStopped(params);
  return perHome
    .flat()
    .sort((left, right) => compareCodexRolloutCandidateCodeUnits(right.key, left.key));
}

function rolloutCandidateFileNames(entries: readonly Dirent[]): string[] {
  return entries
    .filter((entry) => {
      if (entry.isSymbolicLink() || !entry.isFile()) return false;
      const name = directoryEntryName(entry);
      return name.startsWith('rollout-') && name.endsWith('.jsonl');
    })
    .map(directoryEntryName)
    // Newest creation stamp first, by UTF-16 code unit for the same reason the
    // candidate order is: an ICU collation here would put the traversal and the
    // `fileName` cursor comparison below into different orders.
    .sort((left, right) => compareCodexRolloutCandidateCodeUnits(right, left));
}

/**
 * Reads the title for the rows a chunk actually returns — never for a scanned
 * file the chunk discards — from the same earliest rollout file the
 * selected-candidate build reads. This is the only reason the identifier-only
 * IN-PROGRESS page is not permanent on a large corpus: the host index serves
 * partial rows without hydration, so a title has to arrive on the row itself.
 */
async function withRolloutCandidateTitles(params: Readonly<{
  entries: readonly CodexRolloutCandidateEntry[];
  env: NodeJS.ProcessEnv;
}> & CodexExternalSessionInvocationBounds): Promise<CodexRolloutCandidateEntry[]> {
  return await mapCodexExternalSessionWorkWithConcurrency(
    params.entries,
    resolveCodexRolloutSearchBuildConcurrency(params.env),
    async (entry) => {
      const title = await readCodexSessionTitleFromRollout(
        entry.group.earliestFilePath,
        params,
        CODEX_ROLLOUT_TITLE_HEAD_BUDGET,
      );
      return title ? { ...entry, title } : entry;
    },
    params,
  );
}

/**
 * One bounded scan chunk of the rollout corpus, in newest-container-first
 * traversal order.
 *
 * Complete work per call is bounded by `limit`: the corpus description reads
 * only `sessions/YYYY/MM/DD` directory metadata (measured ~10–25 ms on a
 * 49,880-file corpus), and only the rollout files this chunk actually consumes
 * are statted or opened. Nothing here reads, stats, or groups the whole corpus,
 * because the whole corpus does not fit the SDK's 3,000 ms per-source head
 * acquisition: sweeping every rollout mtime to sort by last activity measured
 * 2.9–3.7 s cold on that same corpus, and repeated once per continuation page.
 *
 * Last-activity ordering is therefore not this function's job. The host
 * candidate-index owner accumulates these exact chunks, sorts them with the same
 * `updatedAtMs`-then-code-unit rule, and alone serves the ordered page.
 */
export async function scanCodexRolloutCandidateChunk(params: Readonly<{
  source: CodexExternalSessionSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
  limit: number;
  after?: CodexRolloutCandidateScanBoundary | null;
}> & CodexExternalSessionInvocationBounds): Promise<CodexRolloutCandidateScanChunk> {
  throwIfCodexExternalSessionInvocationStopped(params);
  const containers = await listCandidateCorpusContainers(params);
  throwIfCodexExternalSessionInvocationStopped(params);
  const after = params.after ?? null;
  const resumeGeneration = await resolveResumeContainerGeneration({
    containers,
    containerKey: after?.containerKey ?? null,
    signal: params.signal,
    deadlineAtMs: params.deadlineAtMs,
  });
  if (after && after.sourceGeneration !== resumeGeneration) {
    return {
      entries: [],
      sourceGeneration: resumeGeneration,
      scanned: after.scanned,
      nextBoundary: null,
      sourceChanged: true,
    };
  }

  const limit = Math.max(1, Math.trunc(params.limit));
  const grouped: GroupedRolloutCandidates = new Map();
  let lastConsumed: Readonly<{
    containerKey: string;
    fileName: string;
    sourceGeneration: string;
  }> | null = null;
  let scanned = after?.scanned ?? 0;
  let hasMore = false;

  outer:
  for (const container of containers) {
    throwIfCodexExternalSessionInvocationStopped(params);
    // Containers are ordered by descending key, so everything already consumed
    // sorts above the boundary container.
    if (after && compareCodexRolloutCandidateCodeUnits(container.key, after.containerKey) > 0) {
      continue;
    }
    // Captured BEFORE this container's entries are listed, so a rollout created
    // between the two is either consumed by this chunk or invalidates the next
    // one — never silently skipped by an anchor that already accounts for it.
    const containerGeneration = container.key === after?.containerKey
      ? resumeGeneration
      : await resolveResumeContainerGeneration({
        containers,
        containerKey: container.key,
        signal: params.signal,
        deadlineAtMs: params.deadlineAtMs,
      });
    const fileNames = rolloutCandidateFileNames(
      await readDirectoryEntries(container.dir, params),
    );
    for (const fileName of fileNames) {
      throwIfCodexExternalSessionInvocationStopped(params);
      if (
        after
        && container.key === after.containerKey
        && compareCodexRolloutCandidateCodeUnits(fileName, after.fileName) >= 0
      ) {
        continue;
      }
      const filePath = join(container.dir, fileName);
      const remoteSessionId = await resolveRolloutCandidateSessionId(filePath, params);
      if (!remoteSessionId) {
        scanned += 1;
        lastConsumed = { containerKey: container.key, fileName, sourceGeneration: containerGeneration };
        continue;
      }
      // Stop before consuming a file that would exceed the chunk bound, so the
      // boundary always names a fully consumed file.
      if (!grouped.has(remoteSessionId) && grouped.size >= limit) {
        hasMore = true;
        break outer;
      }
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(filePath)).mtimeMs;
        throwIfCodexExternalSessionInvocationStopped(params);
      } catch {
        throwIfCodexExternalSessionInvocationStopped(params);
        scanned += 1;
        lastConsumed = { containerKey: container.key, fileName, sourceGeneration: containerGeneration };
        continue;
      }
      mergeRolloutCandidateFile({
        grouped,
        remoteSessionId,
        filePath,
        mtimeMs,
        archived: container.archived,
        source: container.source,
      });
      scanned += 1;
      lastConsumed = { containerKey: container.key, fileName, sourceGeneration: containerGeneration };
    }
  }

  return {
    entries: await withRolloutCandidateTitles({
      entries: toOrderedRolloutCandidateEntries(grouped),
      env: params.env,
      signal: params.signal,
      deadlineAtMs: params.deadlineAtMs,
    }),
    sourceGeneration: resumeGeneration,
    scanned,
    nextBoundary: hasMore && lastConsumed
      ? { ...lastConsumed, scanned }
      : null,
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
