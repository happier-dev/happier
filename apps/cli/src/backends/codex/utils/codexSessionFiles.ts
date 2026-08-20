import { readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveConfiguredCodexHome } from '@/backends/codex/utils/resolveConfiguredCodexHome';

const CODEX_NATIVE_SEARCH_MAX_DEPTH = 8;

/**
 * Codex rollout file names are `rollout-<ISO-timestamp>-<sessionId>.jsonl`. A match for a vendor
 * resume id is an exact `-<id>.jsonl` SUFFIX on a `rollout-` prefixed name — never a substring of the
 * id (so `-6425384658.jsonl` does not match the full uuid) and never a non-rollout `session-<id>.jsonl`.
 */
export function isMatchingCodexRolloutFileName(name: string, vendorResumeId: string): boolean {
  return name.startsWith('rollout-') && name.endsWith(`-${vendorResumeId}.jsonl`);
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
}>): Promise<string | null> {
  async function walk(currentDir: string, depth: number): Promise<string | null> {
    if (depth > CODEX_NATIVE_SEARCH_MAX_DEPTH) return null;

    const subDirectoryNames: string[] = [];
    try {
      const entries = await readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const entryName = String(entry.name);
        if (entry.isDirectory()) {
          subDirectoryNames.push(entryName);
          continue;
        }
        if (!entry.isFile()) continue;
        if (isMatchingCodexRolloutFileName(entryName, params.vendorResumeId)) {
          return join(currentDir, entryName);
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
}>): string | null {
  function walk(currentDir: string, depth: number): string | null {
    if (depth > CODEX_NATIVE_SEARCH_MAX_DEPTH) return null;

    const subDirectoryNames: string[] = [];
    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const entryName = String(entry.name);
        if (entry.isDirectory()) {
          subDirectoryNames.push(entryName);
          continue;
        }
        if (!entry.isFile()) continue;
        if (isMatchingCodexRolloutFileName(entryName, params.vendorResumeId)) {
          return join(currentDir, entryName);
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
