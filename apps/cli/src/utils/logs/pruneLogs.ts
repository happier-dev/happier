import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readStoragePathIdentity, removeStoragePath } from '@/storage/trash/removeStoragePath';

export type PruneLogsParams = Readonly<{
  dir: string;
  suffix: string;
  excludeSuffix?: string;
  keepCount?: number;
  olderThanMs?: number;
  /** Total bytes the matching logs, kept paths included, may use; the oldest others go first. */
  maxTotalBytes?: number;
  keepPath?: string;
  keepPaths?: readonly string[];
  measure?: (paths: readonly string[]) => Promise<ReadonlyMap<string, number>>;
  beforeEffect?: () => Promise<void>;
}>;

export type PruneLogsResult = Readonly<{
  pruned: number;
  freedBytes: number;
  oldestRemainingAtMs: number | null;
  failures: readonly Readonly<{ path: string; error: unknown }>[];
}>;

function normalizeKeepCount(keepCount: number): number {
  if (!Number.isFinite(keepCount)) return 0;
  return Math.max(0, Math.floor(keepCount));
}

function sortNewestFirst(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

export async function pruneLogs(params: PruneLogsParams): Promise<PruneLogsResult> {
    const result: { pruned: number; freedBytes: number; oldestRemainingAtMs: number | null; failures: { path: string; error: unknown }[] } = {
      pruned: 0, freedBytes: 0, oldestRemainingAtMs: null, failures: [],
    };
    const keepPaths = new Set([...(params.keepPaths ?? []), ...(params.keepPath ? [params.keepPath] : [])].map(path => resolve(path)));
    let names: string[];
    try { names = await readdir(params.dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result; throw error; }
    const entries = names
      .filter((entry) => entry.endsWith(params.suffix))
      .filter((entry) => !params.excludeSuffix || !entry.endsWith(params.excludeSuffix))
      .sort(sortNewestFirst);

    const candidates: { path: string; identity: Awaited<ReturnType<typeof readStoragePathIdentity>>; mtimeMs: number }[] = [];
    const remaining: { path: string; mtimeMs: number; size: number }[] = [];
    let keptBytes = 0;
    for (const [index, name] of entries.entries()) {
      const path = join(params.dir, name);
      const kept = keepPaths.has(resolve(path));
      if (kept && params.maxTotalBytes === undefined) continue;
      let stat;
      try { stat = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      if (kept) { keptBytes += stat.size; continue; }
      const byCount = params.keepCount !== undefined && index >= normalizeKeepCount(params.keepCount);
      const byAge = params.olderThanMs !== undefined && stat.mtimeMs <= params.olderThanMs;
      if (byCount || byAge) candidates.push({ path, identity: await readStoragePathIdentity(path), mtimeMs: stat.mtimeMs });
      else remaining.push({ path, mtimeMs: stat.mtimeMs, size: stat.size });
    }
    // Keep the newest data: once the budget is spent, every older log goes, even a smaller one.
    let totalBytes = keptBytes;
    let overBudget = false;
    for (const entry of remaining.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
      overBudget ||= params.maxTotalBytes !== undefined && totalBytes + entry.size > params.maxTotalBytes;
      if (overBudget) {
        candidates.push({ path: entry.path, identity: await readStoragePathIdentity(entry.path), mtimeMs: entry.mtimeMs });
        continue;
      }
      totalBytes += entry.size;
      result.oldestRemainingAtMs = Math.min(result.oldestRemainingAtMs ?? Infinity, entry.mtimeMs);
    }
    if (candidates.length) await params.beforeEffect?.();
    const measured = candidates.length && params.measure ? await params.measure(candidates.map(candidate => candidate.path)) : undefined;
    for (const candidate of candidates) {
      try {
        await removeStoragePath(candidate.path, { allowedRoot: params.dir, expectedIdentity: candidate.identity,
          beforeEffect: async () => {
            if ((await lstat(candidate.path)).mtimeMs !== candidate.mtimeMs) throw Object.assign(new Error('Log changed during pruning'), { code: 'changed_since_review' });
            await params.beforeEffect?.();
          } });
        result.pruned += 1; result.freedBytes += measured?.get(candidate.path) ?? 0;
      } catch (error) {
        result.failures.push({ path: candidate.path, error });
        if (error instanceof Error && error.name === 'AbortError') break;
      }
    }
    return result;
}
