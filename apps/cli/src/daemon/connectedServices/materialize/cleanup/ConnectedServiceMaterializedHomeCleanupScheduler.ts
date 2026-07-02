import { lstat, readdir, realpath, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isAbsolute, relative } from 'node:path';

import { normalizeMaterializationKeyForPath } from '../normalizeMaterializationKeyForPath';

type MaterializedHomeCleanupTargetKind = 'identity_root' | 'attempt_root';

type MaterializedHomeCleanupTarget = Readonly<{
  targetKind: MaterializedHomeCleanupTargetKind;
  segment: string;
  path: string;
  mtimeMs: number;
}>;

export type ConnectedServiceMaterializedHomeCleanupResult = Readonly<{
  targetKind: MaterializedHomeCleanupTargetKind;
  path: string;
  cleaned: boolean;
  retained?: boolean;
  abandoned?: boolean;
}>;

type RemovePath = typeof rm;

async function readDirectoryEntries(path: string): Promise<ReadonlyArray<Readonly<{ name: string; path: string }>>> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: join(path, entry.name) }));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function readDirectoryMtimeMs(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function normalizeMaterializationKeys(keys: Iterable<string>): Set<string> {
  const segments = new Set<string>();
  for (const key of keys) {
    const normalized = String(key ?? '').trim();
    if (!normalized) continue;
    segments.add(normalizeMaterializationKeyForPath(normalized));
  }
  return segments;
}

export class ConnectedServiceMaterializedHomeCleanupScheduler {
  readonly #baseDir: string;
  readonly #nowMs: () => number;
  readonly #orphanTtlMs: number;
  readonly #attemptTtlMs: number;
  readonly #maxCleanupRetries: number;
  readonly #removePath: RemovePath;
  readonly #failedAttemptsByPath = new Map<string, number>();
  readonly #abandonedPaths = new Set<string>();

  constructor(private readonly deps: Readonly<{
    baseDir: string;
    nowMs: () => number;
    getLiveMaterializationKeys: () => Iterable<string>;
    getRetainedMaterializationKeys?: () => Promise<Iterable<string>> | Iterable<string>;
    orphanTtlMs?: number;
    attemptTtlMs?: number;
    maxCleanupRetries?: number;
    removePath?: RemovePath;
  }>) {
    this.#baseDir = deps.baseDir;
    this.#nowMs = deps.nowMs;
    this.#orphanTtlMs = Math.max(0, Math.trunc(deps.orphanTtlMs ?? 24 * 60 * 60_000));
    this.#attemptTtlMs = Math.max(0, Math.trunc(deps.attemptTtlMs ?? 60 * 60_000));
    this.#maxCleanupRetries = Math.max(1, Math.trunc(deps.maxCleanupRetries ?? 3));
    this.#removePath = deps.removePath ?? rm;
  }

  async #readRetainedSegments(): Promise<Set<string>> {
    const liveSegments = normalizeMaterializationKeys(this.deps.getLiveMaterializationKeys());
    const retainedKeys = await Promise.resolve(this.deps.getRetainedMaterializationKeys?.() ?? []);
    for (const segment of normalizeMaterializationKeys(retainedKeys)) {
      liveSegments.add(segment);
    }
    return liveSegments;
  }

  async #listCleanupTargets(retainedSegments: ReadonlySet<string>): Promise<ReadonlyArray<MaterializedHomeCleanupTarget>> {
    const nowMs = this.#nowMs();
    const targets: MaterializedHomeCleanupTarget[] = [];
    for (const entry of await readDirectoryEntries(this.#baseDir)) {
      if (entry.name === '.attempts') continue;
      if (retainedSegments.has(entry.name)) continue;
      const mtimeMs = await readDirectoryMtimeMs(entry.path);
      if (mtimeMs === null) continue;
      if (nowMs - mtimeMs < this.#orphanTtlMs) continue;
      targets.push({
        targetKind: 'identity_root',
        segment: entry.name,
        path: entry.path,
        mtimeMs,
      });
    }

    const attemptsRoot = join(this.#baseDir, '.attempts');
    for (const entry of await readDirectoryEntries(attemptsRoot)) {
      const mtimeMs = await readDirectoryMtimeMs(entry.path);
      if (mtimeMs === null) continue;
      if (nowMs - mtimeMs < this.#attemptTtlMs) continue;
      targets.push({
        targetKind: 'attempt_root',
        segment: entry.name,
        path: entry.path,
        mtimeMs,
      });
    }
    return targets;
  }

  async #isContainedDirectory(path: string): Promise<boolean> {
    try {
      const targetStat = await lstat(path);
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) return false;
      const [baseRealPath, targetRealPath] = await Promise.all([
        realpath(this.#baseDir),
        realpath(path),
      ]);
      const rel = relative(baseRealPath, targetRealPath);
      return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async #isRetainedIdentityTarget(target: MaterializedHomeCleanupTarget): Promise<boolean> {
    if (target.targetKind !== 'identity_root') return false;
    return (await this.#readRetainedSegments()).has(target.segment);
  }

  async #removeTarget(target: MaterializedHomeCleanupTarget): Promise<ConnectedServiceMaterializedHomeCleanupResult> {
    if (this.#abandonedPaths.has(target.path)) {
      return {
        targetKind: target.targetKind,
        path: target.path,
        cleaned: false,
        abandoned: true,
      };
    }
    if (await this.#isRetainedIdentityTarget(target)) {
      return {
        targetKind: target.targetKind,
        path: target.path,
        cleaned: false,
        retained: true,
      };
    }
    if (!await this.#isContainedDirectory(target.path)) {
      return {
        targetKind: target.targetKind,
        path: target.path,
        cleaned: false,
        retained: true,
      };
    }
    try {
      await this.#removePath(target.path, { recursive: true, force: true });
      this.#failedAttemptsByPath.delete(target.path);
      this.#abandonedPaths.delete(target.path);
      return {
        targetKind: target.targetKind,
        path: target.path,
        cleaned: true,
      };
    } catch (error) {
      const attempts = (this.#failedAttemptsByPath.get(target.path) ?? 0) + 1;
      this.#failedAttemptsByPath.set(target.path, attempts);
      if (attempts >= this.#maxCleanupRetries) {
        this.#abandonedPaths.add(target.path);
      }
      throw error;
    }
  }

  async reconcile(): Promise<ReadonlyArray<ConnectedServiceMaterializedHomeCleanupResult>> {
    const retainedSegments = await this.#readRetainedSegments();
    const results: ConnectedServiceMaterializedHomeCleanupResult[] = [];
    for (const target of await this.#listCleanupTargets(retainedSegments)) {
      results.push(await this.#removeTarget(target));
    }
    return results;
  }

  async cleanupPendingMaterializedHomes(): Promise<ReadonlyArray<ConnectedServiceMaterializedHomeCleanupResult>> {
    return await this.reconcile();
  }
}
