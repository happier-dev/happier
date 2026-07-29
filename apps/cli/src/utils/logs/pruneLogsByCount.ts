import { readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

export type PruneLogsByCountParams = Readonly<{
  dir: string;
  suffix: string;
  excludeSuffix?: string;
  keepCount: number;
  keepPath?: string;
  keepPaths?: readonly string[];
}>;

export type PruneLogsByCountResult = Readonly<{
  pruned: number;
}>;

function normalizeKeepCount(keepCount: number): number {
  if (!Number.isFinite(keepCount)) return 0;
  return Math.max(0, Math.floor(keepCount));
}

function sortNewestFirst(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

export async function pruneLogsByCount(params: PruneLogsByCountParams): Promise<PruneLogsByCountResult> {
  try {
    const keepCount = normalizeKeepCount(params.keepCount);
    const keepNames = new Set<string>();
    if (params.keepPath) keepNames.add(basename(params.keepPath));
    for (const keepPath of params.keepPaths ?? []) {
      keepNames.add(basename(keepPath));
    }
    const entries = (await readdir(params.dir))
      .filter((entry) => entry.endsWith(params.suffix))
      .filter((entry) => !params.excludeSuffix || !entry.endsWith(params.excludeSuffix))
      .sort(sortNewestFirst);

    const keep = new Set(entries.slice(0, keepCount));
    for (const keepName of keepNames) {
      keep.add(keepName);
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
