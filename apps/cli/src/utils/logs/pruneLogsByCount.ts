import { lstat, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

export type PruneLogsByCountParams = Readonly<{
  dir: string;
  suffix: string;
  /** Entries matching this suffix are ignored entirely (not pruned, not counted against keepCount). */
  excludeSuffix?: string;
  keepCount: number;
  /** Total bytes the matching logs, kept paths included, may use; the oldest others go first. */
  maxTotalBytes?: number;
  keepPath?: string;
  keepPaths?: readonly string[];
}>;

export type PruneLogsByCountResult = Readonly<{
  pruned: number;
}>;

function resolveKeepCount(keepCount: number): number {
  if (!Number.isFinite(keepCount)) return 0;
  return Math.max(0, Math.floor(keepCount));
}

function sortNewestFirst(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

export async function pruneLogsByCount(params: PruneLogsByCountParams): Promise<PruneLogsByCountResult> {
  try {
    const keepCount = resolveKeepCount(params.keepCount);
    const keepName = params.keepPath ? basename(params.keepPath) : null;
    const keepNames = new Set((params.keepPaths ?? []).map((entry) => basename(entry)));
    const entries = (await readdir(params.dir))
      .filter((entry) => entry.endsWith(params.suffix))
      .filter((entry) => !params.excludeSuffix || !entry.endsWith(params.excludeSuffix))
      .sort(sortNewestFirst);

    const keep = new Set(entries.slice(0, keepCount));
    const exempt = new Set(keepNames);
    if (keepName !== null) exempt.add(keepName);
    for (const name of exempt) keep.add(name);

    if (params.maxTotalBytes !== undefined) {
      // Keep the newest data: once the budget is spent, every older log goes, even a smaller one.
      const sized: { name: string; size: number; mtimeMs: number }[] = [];
      let totalBytes = 0;
      for (const name of entries) {
        if (!keep.has(name)) continue;
        try {
          const stat = await lstat(join(params.dir, name));
          if (exempt.has(name)) totalBytes += stat.size;
          else sized.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          // A log removed concurrently uses no budget.
        }
      }
      let overBudget = false;
      for (const entry of sized.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
        overBudget ||= totalBytes + entry.size > params.maxTotalBytes;
        if (overBudget) keep.delete(entry.name);
        else totalBytes += entry.size;
      }
    }

    let pruned = 0;
    for (const entry of entries) {
      if (keep.has(entry)) continue;
      try {
        await rm(join(params.dir, entry), { force: true });
        pruned += 1;
      } catch {
        // Best-effort pruning only.
      }
    }

    return { pruned };
  } catch {
    return { pruned: 0 };
  }
}
