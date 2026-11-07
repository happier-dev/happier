import { readdirSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveConfiguredCodexHome } from '@/backends/codex/utils/resolveConfiguredCodexHome';

const CODEX_NATIVE_SEARCH_MAX_DEPTH = 8;
const CODEX_ROLLOUT_SUFFIX_PATTERN = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl(?:\.zst)?$/i;
const CODEX_ROLLOUT_ID_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$/i;

export type CodexRolloutFilename = Readonly<{
  sessionId: string;
  threadId?: string;
  turnId?: string;
}>;

/** Physical rollout formats supported by Codex, including legacy noncanonical names. */
export function isCodexRolloutFilePath(path: string): boolean {
  return /\.jsonl(?:\.zst)?$/i.test(path);
}

/** Codex indexes the logical plain path even while the physical rollout is compressed. */
export function resolveCodexLogicalRolloutPath(path: string): string {
  return /\.jsonl\.zst$/i.test(path) ? path.slice(0, -4) : path;
}

/** Leave decoding and append-time materialization to Codex's native rollout owner. */
export async function resolveExistingCodexRolloutPath(path: string): Promise<string | null> {
  const plainPath = resolveCodexLogicalRolloutPath(path);
  const candidates = isCodexRolloutFilePath(path) ? [plainPath, `${plainPath}.zst`] : [path];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
  }
  return null;
}

/** Parses all supported rollout suffixes and identifies UUID-based continuations. */
export function parseCodexRolloutFilename(filePath: string): CodexRolloutFilename | null {
  const name = filePath.split(/[/\\\\]/).pop() ?? '';
  const suffix = CODEX_ROLLOUT_SUFFIX_PATTERN.exec(name)?.[1];
  if (!suffix) return null;
  const ids = CODEX_ROLLOUT_ID_PATTERN.exec(suffix);
  return {
    sessionId: suffix,
    ...(ids?.[1] ? { threadId: ids[1] } : {}),
    ...(ids?.[2] ? { turnId: ids[2] } : {}),
  };
}

/**
 * Codex rollout file names are usually `rollout-<ISO-timestamp>-<sessionId>.jsonl`. Newer Codex
 * continuations can append a turn UUID to the thread UUID (`<sessionId>_<turnId>`); both forms are
 * accepted, but the thread id itself must remain an exact suffix component and never a substring.
 */
export function isMatchingCodexRolloutFileName(name: string, vendorResumeId: string): boolean {
  if (!name.startsWith('rollout-')) return false;
  const parsed = parseCodexRolloutFilename(name);
  return isMatchingCodexRolloutIdentity(parsed?.sessionId, vendorResumeId)
    || isMatchingCodexRolloutIdentity(parsed?.threadId, vendorResumeId);
}

/** Matches discovered rollout identities while preserving exact boundaries for opaque IDs. */
export function isMatchingCodexRolloutIdentity(candidateId: string | undefined, requestedId: string): boolean {
  return candidateId === requestedId
    || (isUuid(candidateId) && isUuid(requestedId) && candidateId.toLowerCase() === requestedId.toLowerCase());
}

function isUuid(value: string | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * The NATIVE Codex sessions root the user's locally-run Codex CLI writes to: `<codexHome>/sessions`,
 * where `codexHome` honors `$CODEX_HOME` and otherwise defaults to `~/.codex`. This is the root the
 * connected-service switch was structurally blind to (the Codex analogue of the PI VG-8 gap): a
 * session started OUTSIDE Happier lives here, and a native→connected resume must prove reachability
 * from it and import it before spawn.
 */
export function resolveCodexNativeSessionsRoot(env: NodeJS.ProcessEnv): string {
  return join(resolveConfiguredCodexHome(env), 'sessions');
}

/**
 * A Codex thread id, or nothing.
 *
 * The id becomes a file-name SUFFIX in every search below, so one carrying a
 * path separator is not a thread id and must never be searched for. Shared by
 * every caller that turns an id into a file so the guard cannot drift between
 * them.
 */
export function normalizeCodexVendorResumeId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  return trimmed;
}

function compareDescending(a: string, b: string): number {
  return b.localeCompare(a);
}

/**
 * Id-targeted native rollout search. Codex date-partitions rollouts as `YYYY/MM/DD/rollout-*.jsonl`
 * and a real native home holds tens of thousands of files, so a generic capped tree walk
 * (DEFAULT_MAX_SEARCH_FILES) would miss the target. This walk:
 *   - matches on directory entry NAMES only (no `stat`, no content reads) for the exact id suffix,
 *   - descends date partitions NEWEST-first (lexicographic descending sort of subdir names, which is
 *     chronological for zero-padded `YYYY`/`MM`/`DD`/timestamped names), short-circuiting on first hit,
 *   - applies NO per-call file-count cap for the id-targeted match.
 * Returns the absolute path of the first matching rollout, or null.
 */
export async function findCodexRolloutFileById(params: Readonly<{
  sessionsRoot: string;
  vendorResumeId: string;
  includeCompressed?: boolean;
}>): Promise<string | null> {
  async function walk(currentDir: string, depth: number): Promise<string | null> {
    if (depth > CODEX_NATIVE_SEARCH_MAX_DEPTH) return null;

    const subDirectoryNames: string[] = [];
    try {
      const entries = await readdir(currentDir, { withFileTypes: true });
      const fileNames = new Set(entries.filter(entry => entry.isFile()).map(entry => String(entry.name)));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const entryName = String(entry.name);
        if (entry.isDirectory()) {
          subDirectoryNames.push(entryName);
          continue;
        }
        if (!entry.isFile()) continue;
        if (params.includeCompressed === false && entryName !== resolveCodexLogicalRolloutPath(entryName)) continue;
        if (isMatchingCodexRolloutFileName(entryName, params.vendorResumeId)) {
          const plainName = resolveCodexLogicalRolloutPath(entryName);
          return join(currentDir, fileNames.has(plainName) ? plainName : entryName);
        }
      }
    } catch {
      return null;
    }

    subDirectoryNames.sort(compareDescending);
    for (const subDirectoryName of subDirectoryNames) {
      const found = await walk(join(currentDir, subDirectoryName), depth + 1);
      if (found) return found;
    }
    return null;
  }

  return await walk(params.sessionsRoot, 0);
}

/**
 * Synchronous counterpart for catalog hooks that must return a cheap hint without introducing async
 * work at call sites. Keep the traversal contract byte-for-byte aligned with findCodexRolloutFileById.
 */
export function findCodexRolloutFileByIdSync(params: Readonly<{
  sessionsRoot: string;
  vendorResumeId: string;
  includeCompressed?: boolean;
}>): string | null {
  function walk(currentDir: string, depth: number): string | null {
    if (depth > CODEX_NATIVE_SEARCH_MAX_DEPTH) return null;

    const subDirectoryNames: string[] = [];
    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      const fileNames = new Set(entries.filter(entry => entry.isFile()).map(entry => String(entry.name)));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const entryName = String(entry.name);
        if (entry.isDirectory()) {
          subDirectoryNames.push(entryName);
          continue;
        }
        if (!entry.isFile()) continue;
        if (params.includeCompressed === false && entryName !== resolveCodexLogicalRolloutPath(entryName)) continue;
        if (isMatchingCodexRolloutFileName(entryName, params.vendorResumeId)) {
          const plainName = resolveCodexLogicalRolloutPath(entryName);
          return join(currentDir, fileNames.has(plainName) ? plainName : entryName);
        }
      }
    } catch {
      return null;
    }

    subDirectoryNames.sort(compareDescending);
    for (const subDirectoryName of subDirectoryNames) {
      const found = walk(join(currentDir, subDirectoryName), depth + 1);
      if (found) return found;
    }
    return null;
  }

  return walk(params.sessionsRoot, 0);
}
