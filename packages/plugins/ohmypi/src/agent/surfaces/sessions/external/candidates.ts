import { createHash } from 'node:crypto';
import { lstat, opendir, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  readJsonlSessionLastActivityMs,
  scanJsonlSessionFile,
  ExternalSessionContentSearchYield,
} from '@happier-dev/plugin-sdk/sessions/file-stores';
import type { AgentExternalSessionCandidate } from '@happier-dev/plugin-sdk/sessions/external';
import {
  deriveExternalSessionActivity,
  ExternalSessionActivityPageBudgetError,
  pageExternalSessionCandidatesByActivity,
  parseExternalSessionActivityPosition,
  readSessionInputPromptUserTextV1,
  type ExternalSessionActivityPosition,
} from '@happier-dev/plugin-sdk/sessions/external';

import { resolveOhMyPiSessionsRoot } from './files.js';
import { resolveOhMyPiAgentDir, type OhMyPiExternalSessionSource } from './source.js';

export type OhMyPiExternalSessionCandidate = Readonly<{
  remoteSessionId: string;
  title?: string;
  messageCount?: number;
  updatedAtMs: number;
  createdAtMs?: number;
  activity?: ReturnType<typeof deriveExternalSessionActivity>;
  match?: AgentExternalSessionCandidate['match'];
  details: Readonly<{
    workingDirectory: string | null;
    agentDir: string;
    sessionFilePath: string;
  }>;
}>;

export type OhMyPiCandidateResultBudget = Readonly<{
  fits(
    candidates: readonly OhMyPiExternalSessionCandidate[],
    nextCursor: string | null,
    searchIncomplete: boolean | undefined,
  ): boolean;
}>;

type CandidateScanPosition = Readonly<{
  rootEntryOffset: number;
  rootName: string | null;
  rootGeneration: string | null;
  fileEntryOffset: number;
}>;

/** A searched listing's resumable directory position. */
type CandidateSearchCursorV3 = Readonly<{
  v: 3;
  kind: 'ohMyPiCandidateSearchScan';
  sourceGeneration: string;
  position: CandidateScanPosition;
}>;

/** Unsearched Browse continuation: the last row served, in activity order. */
type CandidateActivityCursorV1 = Readonly<{
  v: 1;
  kind: 'ohMyPiCandidateActivity';
  after: ExternalSessionActivityPosition;
}>;

type FileIdentity = Readonly<{
  dev: string;
  ino: string;
  birthtimeMs: number;
  mtimeMs: number;
  size: number;
}>;

const GENERATION_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const SEARCH_CURSOR_PREFIX = 'omp3';
const ACTIVITY_CURSOR_PREFIX = 'ompa1';
/** Prefix of the retired index-scan cursor; a continuation of it is stale, not malformed. */
const RETIRED_INDEX_CURSOR_PREFIX = 'omp2.';

const OH_MY_PI_CANDIDATE_TITLE_MAX_CHARS = 120;

function normalizeOhMyPiCandidateTitle(value: string | null): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (normalized.length <= OH_MY_PI_CANDIDATE_TITLE_MAX_CHARS) return normalized;
  const prefixLimit = OH_MY_PI_CANDIDATE_TITLE_MAX_CHARS - 3;
  const prefix = normalized.slice(0, prefixLimit);
  const safePrefix = /[\uD800-\uDBFF]$/u.test(prefix) ? prefix.slice(0, -1) : prefix;
  return `${safePrefix.trimEnd()}...`;
}

/**
 * Oh My Pi never persists an agent-authored title, so a candidate's only title
 * evidence is the first user message the bounded session scan already returned.
 */
export function formatOhMyPiCandidateTitle(value: string | null): string | null {
  return normalizeOhMyPiCandidateTitle(typeof value === 'string' ? readSessionInputPromptUserTextV1(value) : null);
}

export class OhMyPiCandidateInvalidCursorError extends Error {
  readonly name = 'OhMyPiCandidateInvalidCursorError';
}

export class OhMyPiCandidateResultBudgetTooSmallError extends Error {
  readonly name = 'OhMyPiCandidateResultBudgetTooSmallError';
}

export class OhMyPiCandidateSourceChangedError extends Error {
  readonly name = 'OhMyPiCandidateSourceChangedError';
}

function encodeSearchCursor(cursor: CandidateSearchCursorV3): string {
  return [
    SEARCH_CURSOR_PREFIX,
    cursor.sourceGeneration,
    cursor.position.rootEntryOffset.toString(36),
    cursor.position.rootName
      ? Buffer.from(cursor.position.rootName, 'utf8').toString('base64url')
      : '-',
    cursor.position.rootGeneration ?? '-',
    cursor.position.fileEntryOffset.toString(36),
  ].join('.');
}

function encodeActivityCursor(after: ExternalSessionActivityPosition): string {
  return `${ACTIVITY_CURSOR_PREFIX}.${Buffer.from(JSON.stringify(after), 'utf8').toString('base64url')}`;
}

function decodeActivityCursor(raw: string): CandidateActivityCursorV1 | null {
  const [prefix, payload, ...rest] = raw.split('.');
  if (prefix !== ACTIVITY_CURSOR_PREFIX || !payload || rest.length > 0) return null;
  try {
    const after = parseExternalSessionActivityPosition(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    return after ? { v: 1, kind: 'ohMyPiCandidateActivity', after } : null;
  } catch {
    return null;
  }
}

function isPosition(value: unknown): value is CandidateScanPosition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Number.isSafeInteger(record.rootEntryOffset)
    && (record.rootEntryOffset as number) >= 0
    && (record.rootName === null || (typeof record.rootName === 'string' && record.rootName.length > 0))
    && (record.rootGeneration === null || (typeof record.rootGeneration === 'string' && record.rootGeneration.length > 0))
    && ((record.rootName === null) === (record.rootGeneration === null))
    && Number.isSafeInteger(record.fileEntryOffset)
    && (record.fileEntryOffset as number) >= 0;
}

function decodeSearchCursor(raw: string | undefined): CandidateSearchCursorV3 | null {
  if (!raw?.trim()) return null;
  try {
    const value = raw.split('.');
    if (value.length !== 6) return null;
    const [version, sourceGeneration, rootEntryOffset, rootName, rootGeneration, fileEntryOffset] = value;
    const parseInteger = (input: string | undefined): number | null => {
      if (!input || !/^[0-9a-z]+$/.test(input)) return null;
      const parsed = Number.parseInt(input, 36);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    };
    const parsedRootName = rootName === '-'
      ? null
      : Buffer.from(rootName ?? '', 'base64url').toString('utf8');
    if (
      rootName !== '-'
      && (
        !rootName
        || !parsedRootName
        || Buffer.from(parsedRootName, 'utf8').toString('base64url') !== rootName
      )
    ) return null;
    const position = {
      rootEntryOffset: parseInteger(rootEntryOffset),
      rootName: parsedRootName,
      rootGeneration: rootGeneration === '-' ? null : rootGeneration,
      fileEntryOffset: parseInteger(fileEntryOffset),
    };
    if (
      version !== SEARCH_CURSOR_PREFIX
      || typeof sourceGeneration !== 'string'
      || !GENERATION_PATTERN.test(sourceGeneration)
      || !isPosition(position)
      || (position.rootGeneration !== null && !GENERATION_PATTERN.test(position.rootGeneration))
    ) return null;
    return { v: 3, kind: 'ohMyPiCandidateSearchScan', sourceGeneration, position };
  } catch {
    return null;
  }
}

function fileIdentity(metadata: Readonly<{
  dev: number | bigint;
  ino: number | bigint;
  birthtimeMs: number;
  mtimeMs: number;
  size: number;
}>): FileIdentity {
  return {
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    birthtimeMs: metadata.birthtimeMs,
    mtimeMs: metadata.mtimeMs,
    size: metadata.size,
  };
}

function formatPhysicalGeneration(metadata: Readonly<{
  dev: number | bigint;
  ino: number | bigint;
  birthtimeMs: number;
  mtimeMs: number;
}>): string {
  return createHash('sha256').update([
    String(metadata.dev),
    String(metadata.ino),
    String(metadata.birthtimeMs),
    String(metadata.mtimeMs),
  ].join(':'), 'utf8').digest().subarray(0, 12).toString('base64url');
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size;
}

async function inspectCandidateFile(params: Readonly<{
  filePath: string;
  sessionRoot: string;
  agentDir: string;
  env: NodeJS.ProcessEnv;
  searchTerm: string;
}>): Promise<OhMyPiExternalSessionCandidate | null> {
  const beforeMetadata = await lstat(params.filePath);
  if (!beforeMetadata.isFile() || beforeMetadata.isSymbolicLink()) return null;
  const before = fileIdentity(beforeMetadata);
  const scanned = await scanJsonlSessionFile(params.filePath);
  const afterMetadata = await lstat(params.filePath);
  const after = fileIdentity(afterMetadata);
  if (
    !afterMetadata.isFile()
    || afterMetadata.isSymbolicLink()
    || !sameFileIdentity(before, after)
  ) throwSourceChanged();
  if (!scanned) return null;
  // The bounded scan already read the head of this file; the derived title reuses
  // that result and never opens the session file a second time.
  const persistedTitle = scanned.title === null || scanned.title === undefined
    ? null
    : scanned.title;
  const title = persistedTitle === null
    ? formatOhMyPiCandidateTitle(scanned.firstUserMessage)
    : normalizeOhMyPiCandidateTitle(persistedTitle);
  const haystack = [
    scanned.sessionId,
    persistedTitle ?? title ?? '',
    scanned.cwd ?? '',
    basename(params.sessionRoot),
  ].join(' ').toLowerCase();
  if (params.searchTerm && !haystack.includes(params.searchTerm)) return null;
  return {
      remoteSessionId: scanned.sessionId,
      ...(title ? { title } : {}),
      updatedAtMs: scanned.lastActivityAtMs || Math.trunc(afterMetadata.mtimeMs),
      ...(typeof scanned.createdAtMs === 'number' ? { createdAtMs: scanned.createdAtMs } : {}),
      activity: deriveExternalSessionActivity({
        updatedAtMs: scanned.lastActivityAtMs || Math.trunc(afterMetadata.mtimeMs),
        env: params.env,
      }),
      details: {
        workingDirectory: scanned.cwd,
        agentDir: params.agentDir,
        sessionFilePath: params.filePath,
      },
  };
}

function throwSourceChanged(): never {
  throw new OhMyPiCandidateSourceChangedError(
    'Oh My Pi candidate source changed while paging.',
  );
}

function searchIncomplete(searchTerm: string, hasMore: boolean): true | undefined {
  return searchTerm && hasMore ? true : undefined;
}

/**
 * Browse's activity fact for every session file: the same last-activity rule
 * the candidate publishes (`readJsonlSessionLastActivityMs`, the scanner's
 * `lastActivityAtMs`, else mtime), read from each file's tail without its
 * title or messages. The tie-break is the file's path under the sessions root.
 */
async function listOhMyPiSessionActivity(params: Readonly<{
  sessionsRoot: string;
  signal?: AbortSignal;
}>): Promise<readonly Readonly<{ remoteSessionId: string; updatedAtMs: number; filePath: string; sessionRoot: string }>[]> {
  const roots = await readdir(params.sessionsRoot, { withFileTypes: true });
  const rows: { remoteSessionId: string; updatedAtMs: number; filePath: string; sessionRoot: string }[] = [];
  for (const root of roots) {
    params.signal?.throwIfAborted();
    if (!root.isDirectory() || root.isSymbolicLink()) continue;
    const sessionRoot = join(params.sessionsRoot, root.name);
    const files = await readdir(sessionRoot, { withFileTypes: true }).catch(() => []);
    const found = await Promise.all(files.map(async (file) => {
      if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith('.jsonl')) return null;
      const filePath = join(sessionRoot, file.name);
      const activity = await readJsonlSessionLastActivityMs(filePath);
      if (activity === null) return null;
      const updatedAtMs = activity || Math.trunc((await lstat(filePath).catch(() => null))?.mtimeMs ?? 0);
      return { remoteSessionId: `${root.name}/${file.name}`, updatedAtMs, filePath, sessionRoot };
    }));
    for (const row of found) if (row) rows.push(row);
  }
  params.signal?.throwIfAborted();
  return rows;
}

function withoutTitle(candidate: OhMyPiExternalSessionCandidate): OhMyPiExternalSessionCandidate {
  const { title: _discardedTitle, ...rest } = candidate;
  return rest;
}

async function listOhMyPiSessionCandidatesByActivity(params: Readonly<{
  sessionsRoot: string;
  agentDir: string;
  env: NodeJS.ProcessEnv;
  cursor?: string;
  limit: number;
  updatedAfterMs?: number;
  signal?: AbortSignal;
  resultBudget?: OhMyPiCandidateResultBudget;
}>): Promise<Readonly<{ candidates: OhMyPiExternalSessionCandidate[]; nextCursor: string | null }>> {
  const decoded = params.cursor ? decodeActivityCursor(params.cursor) : null;
  if (params.cursor && !decoded) {
    if (params.cursor.startsWith(RETIRED_INDEX_CURSOR_PREFIX)) throwSourceChanged();
    throw new OhMyPiCandidateInvalidCursorError('Invalid Oh My Pi candidate cursor.');
  }
  const sessionsRootMetadata = await lstat(params.sessionsRoot).catch(() => null);
  if (!sessionsRootMetadata?.isDirectory() || sessionsRootMetadata.isSymbolicLink()) {
    if (decoded) throwSourceChanged();
    return { candidates: [], nextCursor: null };
  }
  const updatedAfterMs = params.updatedAfterMs;
  const entries = (await listOhMyPiSessionActivity({ sessionsRoot: params.sessionsRoot, signal: params.signal }))
    .filter((entry) => updatedAfterMs === undefined || entry.updatedAtMs >= updatedAfterMs);
  try {
    const page = await pageExternalSessionCandidatesByActivity({
      entries,
      after: decoded?.after ?? null,
      limit: params.limit,
      ...(params.signal ? { signal: params.signal } : {}),
      readRows: async (rows) => await Promise.all(rows.map(async (row) => {
        const candidate = await inspectCandidateFile({
          filePath: row.filePath,
          sessionRoot: row.sessionRoot,
          agentDir: params.agentDir,
          env: params.env,
          searchTerm: '',
        }).catch((error: unknown) => {
          if (error instanceof OhMyPiCandidateSourceChangedError) throw error;
          return null;
        });
        // The listed activity is the row's place in this order; publish it.
        return candidate ? {
          ...candidate,
          updatedAtMs: row.updatedAtMs,
          activity: deriveExternalSessionActivity({ updatedAtMs: row.updatedAtMs, env: params.env }),
        } : null;
      })),
      ...(params.resultBudget ? {
        // A title is optional enrichment: a row that fits only without it is still served.
        fits: (candidates: readonly OhMyPiExternalSessionCandidate[], next: ExternalSessionActivityPosition | null) => {
          const cursor = next ? encodeActivityCursor(next) : null;
          return params.resultBudget!.fits(candidates, cursor, undefined)
            || params.resultBudget!.fits([...candidates.slice(0, -1), withoutTitle(candidates.at(-1)!)], cursor, undefined);
        },
      } : {}),
    });
    const nextCursor = page.next ? encodeActivityCursor(page.next) : null;
    const candidates: OhMyPiExternalSessionCandidate[] = [];
    for (const candidate of page.candidates) {
      candidates.push(!params.resultBudget || params.resultBudget.fits([...candidates, candidate], nextCursor, undefined)
        ? candidate
        : withoutTitle(candidate));
    }
    return { candidates, nextCursor };
  } catch (error) {
    if (error instanceof ExternalSessionActivityPageBudgetError) {
      throw new OhMyPiCandidateResultBudgetTooSmallError('Oh My Pi candidate result byte budget cannot fit one candidate.');
    }
    throw error;
  }
}

/**
 * Unsearched Browse pages in activity order (`listOhMyPiSessionCandidatesByActivity`).
 * A search walks the native directories in bounded, resumable chunks and
 * serves its matches in traversal order with `searchIncomplete` until done.
 */
export async function listOhMyPiSessionCandidates(params: Readonly<{
  source: OhMyPiExternalSessionSource;
  env?: NodeJS.ProcessEnv;
  cursor?: string;
  limit: number;
  searchTerm?: string;
  updatedAfterMs?: number;
  signal?: AbortSignal;
  resultBudget?: OhMyPiCandidateResultBudget;
  searchCandidate?: (candidate: OhMyPiExternalSessionCandidate) => Promise<OhMyPiExternalSessionCandidate | null>;
}>): Promise<Readonly<{
  candidates: OhMyPiExternalSessionCandidate[];
  nextCursor: string | null;
  searchIncomplete?: true;
}>> {
  params.signal?.throwIfAborted();
  const env = params.env ?? process.env;
  const agentDir = resolveOhMyPiAgentDir({ source: params.source, env });
  const sessionsRoot = await resolveOhMyPiSessionsRoot({ source: params.source, env });
  const searchTerm = typeof params.searchTerm === 'string'
    ? params.searchCandidate ? params.searchTerm : params.searchTerm.trim().toLowerCase()
    : '';
  const limit = Math.max(1, Math.trunc(params.limit));
  if (!searchTerm && !params.searchCandidate) {
    return await listOhMyPiSessionCandidatesByActivity({
      sessionsRoot,
      agentDir,
      env,
      ...(params.cursor ? { cursor: params.cursor } : {}),
      limit,
      ...(params.updatedAfterMs === undefined ? {} : { updatedAfterMs: params.updatedAfterMs }),
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.resultBudget ? { resultBudget: params.resultBudget } : {}),
    });
  }
  const decoded = params.cursor ? decodeSearchCursor(params.cursor) : null;
  if (params.cursor && !decoded) {
    throw new OhMyPiCandidateInvalidCursorError('Invalid Oh My Pi candidate cursor.');
  }

  const sessionsRootMetadata = await lstat(sessionsRoot).catch(() => null);
  if (!sessionsRootMetadata?.isDirectory() || sessionsRootMetadata.isSymbolicLink()) {
    if (decoded) throwSourceChanged();
    return { candidates: [], nextCursor: null };
  }
  const sourceGeneration = formatPhysicalGeneration(sessionsRootMetadata);
  if (decoded && decoded.sourceGeneration !== sourceGeneration) throwSourceChanged();

  let position: CandidateScanPosition = decoded?.position ?? {
    rootEntryOffset: 0,
    rootName: null,
    rootGeneration: null,
    fileEntryOffset: 0,
  };
  const cursorAt = (at: CandidateScanPosition): string => encodeSearchCursor({
    v: 3, kind: 'ohMyPiCandidateSearchScan', sourceGeneration, position: at,
  });
  const candidates: OhMyPiExternalSessionCandidate[] = [];
  let inspectedEntries = 0;
  let inspectedRoots = 0;
  const rootDirectory = await opendir(sessionsRoot);
  try {
    let currentRootOffset = 0;
    for await (const rootEntry of rootDirectory) {
      params.signal?.throwIfAborted();
      if (currentRootOffset < position.rootEntryOffset) {
        currentRootOffset += 1;
        continue;
      }
      if (inspectedRoots >= limit) {
        return {
          candidates,
          nextCursor: cursorAt({ rootEntryOffset: currentRootOffset, rootName: null, rootGeneration: null, fileEntryOffset: 0 }),
          ...(searchIncomplete(searchTerm, true) ? { searchIncomplete: true } : {}),
        };
      }
      inspectedRoots += 1;
      const rootPath = join(sessionsRoot, rootEntry.name);
      const rootMetadata = await lstat(rootPath).catch(() => null);
      if (
        !rootEntry.isDirectory()
        || rootEntry.isSymbolicLink()
        || !rootMetadata?.isDirectory()
        || rootMetadata.isSymbolicLink()
      ) {
        currentRootOffset += 1;
        position = { rootEntryOffset: currentRootOffset, rootName: null, rootGeneration: null, fileEntryOffset: 0 };
        continue;
      }
      const rootGeneration = formatPhysicalGeneration(rootMetadata);
      if (
        position.rootEntryOffset === currentRootOffset
        && position.rootName !== null
        && (
          position.rootName !== rootEntry.name
          || position.rootGeneration !== rootGeneration
        )
      ) throwSourceChanged();

      const sessionDirectory = await opendir(rootPath);
      let fileOffset = 0;
      try {
        for await (const fileEntry of sessionDirectory) {
          params.signal?.throwIfAborted();
          if (fileOffset < position.fileEntryOffset) {
            fileOffset += 1;
            continue;
          }
          if (inspectedEntries >= limit) {
            const currentRootMetadata = await lstat(rootPath).catch(() => null);
            if (
              !currentRootMetadata?.isDirectory()
              || formatPhysicalGeneration(currentRootMetadata) !== rootGeneration
            ) throwSourceChanged();
            return {
              candidates,
              nextCursor: cursorAt({ rootEntryOffset: currentRootOffset, rootName: rootEntry.name, rootGeneration, fileEntryOffset: fileOffset }),
              ...(searchIncomplete(searchTerm, true) ? { searchIncomplete: true } : {}),
            };
          }
          inspectedEntries += 1;
          fileOffset += 1;
          if (
            !fileEntry.isFile()
            || fileEntry.isSymbolicLink()
            || !fileEntry.name.endsWith('.jsonl')
          ) continue;

          const filePath = join(rootPath, fileEntry.name);
          const cursorBeforeCandidate = cursorAt({
            rootEntryOffset: currentRootOffset, rootName: rootEntry.name, rootGeneration, fileEntryOffset: fileOffset - 1,
          });
          let candidate: OhMyPiExternalSessionCandidate | null = null;
          try {
            candidate = await inspectCandidateFile({
              filePath,
              sessionRoot: rootPath,
              agentDir,
              env,
              searchTerm: params.searchCandidate ? '' : searchTerm,
            }).catch((error: unknown) => {
              if (error instanceof OhMyPiCandidateSourceChangedError) throw error;
              return null;
            });
            if (candidate && params.searchCandidate) candidate = await params.searchCandidate(candidate);
          } catch (error) {
            if (!(error instanceof ExternalSessionContentSearchYield)) throw error;
            return { candidates, nextCursor: cursorBeforeCandidate, searchIncomplete: true };
          }
          if (!candidate) continue;

          const nextCursor = cursorAt({
            rootEntryOffset: currentRootOffset, rootName: rootEntry.name, rootGeneration, fileEntryOffset: fileOffset,
          });
          const nextSearchIncomplete = searchIncomplete(searchTerm, true);
          const proposed = [...candidates, candidate];
          if (!params.resultBudget || params.resultBudget.fits(proposed, nextCursor, nextSearchIncomplete)) {
            candidates.push(candidate);
            continue;
          }
          const { title: _discardedTitle, ...candidateWithoutTitle } = candidate;
          if (params.resultBudget.fits([...candidates, candidateWithoutTitle], nextCursor, nextSearchIncomplete)) {
            candidates.push(candidateWithoutTitle);
            continue;
          }
          if (candidates.length === 0) {
            throw new OhMyPiCandidateResultBudgetTooSmallError(
              'Oh My Pi candidate result byte budget cannot fit one candidate.',
            );
          }
          return {
            candidates,
            nextCursor: cursorBeforeCandidate,
            ...(searchIncomplete(searchTerm, true) ? { searchIncomplete: true } : {}),
          };
        }
      } finally {
        await sessionDirectory.close().catch(() => undefined);
      }
      const currentRootMetadata = await lstat(rootPath).catch(() => null);
      if (
        !currentRootMetadata?.isDirectory()
        || formatPhysicalGeneration(currentRootMetadata) !== rootGeneration
      ) throwSourceChanged();
      currentRootOffset += 1;
      position = { rootEntryOffset: currentRootOffset, rootName: null, rootGeneration: null, fileEntryOffset: 0 };
    }
  } finally {
    await rootDirectory.close().catch(() => undefined);
  }

  const finalSessionsRootMetadata = await lstat(sessionsRoot).catch(() => null);
  if (
    !finalSessionsRootMetadata?.isDirectory()
    || formatPhysicalGeneration(finalSessionsRootMetadata) !== sourceGeneration
  ) throwSourceChanged();
  return { candidates, nextCursor: null };
}
