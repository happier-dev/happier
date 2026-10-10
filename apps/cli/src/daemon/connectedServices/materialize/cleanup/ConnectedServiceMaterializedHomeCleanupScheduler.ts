import { lstat, readdir, realpath, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isAbsolute, relative } from 'node:path';

import { normalizeMaterializationKeyForPath } from '../normalizeMaterializationKeyForPath';
import { hasLocalConnectedServiceResumeState } from '../../stateSharing/connectedServiceStateSharingManifest';

/**
 * Provider-agnostic hygiene hook applied to every retained materialized-home root before
 * orphan cleanup. Provider-specific knowledge (which credential file lives where, and how to
 * sanitize it) is owned by the contributing plugin — this scheduler only orchestrates the call.
 */
export type ConnectedServiceRetainedMaterializedHomeSanitizer = (homeRootDir: string) => Promise<void> | void;

type MaterializedHomeCleanupTargetKind = 'identity_root' | 'attempt_root' | 'isolation_root';

type MaterializedHomeCleanupTarget = Readonly<{
  targetKind: MaterializedHomeCleanupTargetKind;
  segment: string;
  path: string;
  mtimeMs: number;
  baseDir: string;
}>;

export type ConnectedServiceMaterializedHomeCleanupResult = Readonly<{
  targetKind: MaterializedHomeCleanupTargetKind;
  path: string;
  cleaned: boolean;
  retained?: boolean;
  abandoned?: boolean;
}>;

type RemovePath = typeof rm;

type MaterializedHomeCleanupFileOperation =
  | 'lstat'
  | 'readdir'
  | 'realpath'
  | 'rm'
  | 'sanitizeRetainedHome'
  | 'readResumeState'
  | 'stat';

const DEFAULT_FILE_OPERATION_TIMEOUT_MS = 5_000;

export class ConnectedServiceMaterializedHomeCleanupFileOperationTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';

  constructor(readonly operation: MaterializedHomeCleanupFileOperation, readonly path: string, readonly timeoutMs: number) {
    super(`Materialized-home cleanup ${operation} timed out after ${timeoutMs}ms: ${path}`);
    this.name = 'ConnectedServiceMaterializedHomeCleanupFileOperationTimeoutError';
  }
}

export type ConnectedServiceRetainedMaterializationKeysResult =
  | Iterable<string>
  | Readonly<{ status: 'available'; keys: Iterable<string> }>
  | Readonly<{ status: 'unavailable' }>;

type RetainedSegmentsSnapshot = Readonly<{
  retainedSegments: ReadonlySet<string>;
  retainedKeys: ReadonlySet<string>;
  identityDeletionAuthority: 'confirmed' | 'unavailable';
}>;

function normalizeFileOperationTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_FILE_OPERATION_TIMEOUT_MS;
  if (!Number.isFinite(value)) return DEFAULT_FILE_OPERATION_TIMEOUT_MS;
  return Math.max(1, Math.trunc(value));
}

async function runFileOperationWithTimeout<T>(input: Readonly<{
  operation: MaterializedHomeCleanupFileOperation;
  path: string;
  timeoutMs: number;
  run: () => Promise<T>;
}>): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const operationPromise = input.run().then(
    (value) => ({ status: 'completed' as const, value }),
    (error) => ({ status: 'failed' as const, error }),
  );
  const timeoutPromise = new Promise<Readonly<{ status: 'timed_out' }>>((resolve) => {
    timeoutHandle = setTimeout(() => {
      resolve({ status: 'timed_out' });
    }, input.timeoutMs);
    (timeoutHandle as unknown as { unref?: () => void })?.unref?.();
  });

  const result = await Promise.race([operationPromise, timeoutPromise]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  timeoutHandle = null;

  if (result.status === 'completed') return result.value;
  if (result.status === 'failed') throw result.error;
  throw new ConnectedServiceMaterializedHomeCleanupFileOperationTimeoutError(
    input.operation,
    input.path,
    input.timeoutMs,
  );
}

async function readDirectoryEntries(path: string, timeoutMs: number): Promise<ReadonlyArray<Readonly<{ name: string; path: string }>>> {
  try {
    const entries = await runFileOperationWithTimeout({
      operation: 'readdir',
      path,
      timeoutMs,
      run: async () => await readdir(path, { withFileTypes: true }),
    });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: join(path, entry.name) }));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function readDirectoryMtimeMs(path: string, timeoutMs: number): Promise<number | null> {
  try {
    return (await runFileOperationWithTimeout({
      operation: 'stat',
      path,
      timeoutMs,
      run: async () => await stat(path),
    })).mtimeMs;
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

function normalizeRetainedMaterializationKeysResult(
  result: ConnectedServiceRetainedMaterializationKeysResult,
): Readonly<{ status: 'available'; keys: Iterable<string> } | { status: 'unavailable' }> {
  if (typeof result === 'object' && result !== null && 'status' in result) {
    if (result.status === 'unavailable') return { status: 'unavailable' };
    return { status: 'available', keys: result.keys };
  }
  return { status: 'available', keys: result };
}

export class ConnectedServiceMaterializedHomeCleanupScheduler {
  readonly #baseDir: string;
  readonly #nowMs: () => number;
  readonly #orphanTtlMs: number;
  readonly #attemptTtlMs: number;
  readonly #maxCleanupRetries: number;
  readonly #fileOperationTimeoutMs: number;
  readonly #removePath: RemovePath;
  readonly #sanitizeRetainedMaterializedHome: ConnectedServiceRetainedMaterializedHomeSanitizer | null;
  readonly #failedAttemptsByPath = new Map<string, number>();
  readonly #abandonedPaths = new Set<string>();

  constructor(private readonly deps: Readonly<{
    baseDir: string;
    isolationBaseDir?: string;
    nowMs: () => number;
    getLiveMaterializationKeys: () => Iterable<string>;
    getRetainedMaterializationKeys?: () => Promise<ConnectedServiceRetainedMaterializationKeysResult> | ConnectedServiceRetainedMaterializationKeysResult;
    sanitizeRetainedMaterializedHome?: ConnectedServiceRetainedMaterializedHomeSanitizer;
    orphanTtlMs?: number;
    attemptTtlMs?: number;
    maxCleanupRetries?: number;
    fileOperationTimeoutMs?: number;
    removePath?: RemovePath;
  }>) {
    this.#baseDir = deps.baseDir;
    this.#nowMs = deps.nowMs;
    this.#orphanTtlMs = Math.max(0, Math.trunc(deps.orphanTtlMs ?? 24 * 60 * 60_000));
    this.#attemptTtlMs = Math.max(0, Math.trunc(deps.attemptTtlMs ?? 60 * 60_000));
    this.#maxCleanupRetries = Math.max(1, Math.trunc(deps.maxCleanupRetries ?? 3));
    this.#fileOperationTimeoutMs = normalizeFileOperationTimeoutMs(deps.fileOperationTimeoutMs);
    this.#removePath = deps.removePath ?? rm;
    this.#sanitizeRetainedMaterializedHome = deps.sanitizeRetainedMaterializedHome ?? null;
  }

  async #readRetainedSegments(): Promise<RetainedSegmentsSnapshot> {
    const retainedKeys = new Set(this.deps.getLiveMaterializationKeys());
    const liveSegments = normalizeMaterializationKeys(retainedKeys);
    const retainedResult = normalizeRetainedMaterializationKeysResult(
      await Promise.resolve(this.deps.getRetainedMaterializationKeys?.() ?? []),
    );
    if (retainedResult.status === 'unavailable') {
      return {
        retainedSegments: liveSegments,
        retainedKeys,
        identityDeletionAuthority: 'unavailable',
      };
    }
    for (const key of retainedResult.keys) retainedKeys.add(key);
    for (const segment of normalizeMaterializationKeys(retainedKeys)) {
      liveSegments.add(segment);
    }
    return {
      retainedSegments: liveSegments,
      retainedKeys,
      identityDeletionAuthority: 'confirmed',
    };
  }

  async #listCleanupTargets(retainedSnapshot: RetainedSegmentsSnapshot): Promise<ReadonlyArray<MaterializedHomeCleanupTarget>> {
    const nowMs = this.#nowMs();
    const targets: MaterializedHomeCleanupTarget[] = [];
    if (retainedSnapshot.identityDeletionAuthority === 'confirmed') {
      for (const entry of await readDirectoryEntries(this.#baseDir, this.#fileOperationTimeoutMs)) {
        if (entry.name === '.attempts') continue;
        // ../0.2 may materialize directly under identity.id; current homes use its hash.
        if (retainedSnapshot.retainedSegments.has(entry.name) || retainedSnapshot.retainedKeys.has(entry.name)) continue;
        const mtimeMs = await readDirectoryMtimeMs(entry.path, this.#fileOperationTimeoutMs);
        if (mtimeMs === null) continue;
        if (nowMs - mtimeMs < this.#orphanTtlMs) continue;
        targets.push({
          targetKind: 'identity_root',
          segment: entry.name,
          path: entry.path,
          mtimeMs,
          baseDir: this.#baseDir,
        });
      }
      if (this.deps.isolationBaseDir) {
        for (const agent of await readDirectoryEntries(this.deps.isolationBaseDir, this.#fileOperationTimeoutMs)) {
          // Routing ids have one segment; qualified contribution ids have plugin/local segments.
          // Only execution_run has a producer and Run identity in this owner.
          const agentRoots = [agent.path, ...(await readDirectoryEntries(agent.path, this.#fileOperationTimeoutMs))
            .filter(entry => entry.name !== 'execution_run' && entry.name !== 'ephemeral_task')
            .map(entry => entry.path)];
          for (const agentRoot of agentRoots) {
            const runScope = join(agentRoot, 'execution_run');
            if (!await this.#isContainedDirectory(runScope, this.deps.isolationBaseDir)) continue;
            for (const entry of await readDirectoryEntries(runScope, this.#fileOperationTimeoutMs)) {
              if (retainedSnapshot.retainedKeys.has(entry.name)) continue;
              const mtimeMs = await readDirectoryMtimeMs(entry.path, this.#fileOperationTimeoutMs);
              if (mtimeMs === null || nowMs - mtimeMs < this.#orphanTtlMs) continue;
              targets.push({ targetKind: 'isolation_root', segment: entry.name, path: entry.path,
                mtimeMs, baseDir: this.deps.isolationBaseDir });
            }
          }
        }
      }
    }

    const attemptsRoot = join(this.#baseDir, '.attempts');
    for (const entry of await readDirectoryEntries(attemptsRoot, this.#fileOperationTimeoutMs)) {
      const mtimeMs = await readDirectoryMtimeMs(entry.path, this.#fileOperationTimeoutMs);
      if (mtimeMs === null) continue;
      if (nowMs - mtimeMs < this.#attemptTtlMs) continue;
      targets.push({
        targetKind: 'attempt_root',
        segment: entry.name,
        path: entry.path,
        mtimeMs,
        baseDir: this.#baseDir,
      });
    }
    return targets;
  }

  async #sanitizeRetainedMaterializedHomes(retainedSnapshot: RetainedSegmentsSnapshot): Promise<void> {
    const sanitize = this.#sanitizeRetainedMaterializedHome;
    if (!sanitize) return;
    await Promise.all(Array.from(retainedSnapshot.retainedSegments, async (segment) => {
      const homeRootDir = join(this.#baseDir, segment);
      await runFileOperationWithTimeout({
        operation: 'sanitizeRetainedHome',
        path: homeRootDir,
        timeoutMs: this.#fileOperationTimeoutMs,
        run: async () => {
          await sanitize(homeRootDir);
        },
      }).catch(() => undefined);
    }));
  }

  async #isContainedDirectory(path: string, baseDir: string): Promise<boolean> {
    try {
      const targetStat = await runFileOperationWithTimeout({
        operation: 'lstat',
        path,
        timeoutMs: this.#fileOperationTimeoutMs,
        run: async () => await lstat(path),
      });
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) return false;
      const [baseRealPath, targetRealPath] = await Promise.all([
        runFileOperationWithTimeout({
          operation: 'realpath',
          path: baseDir,
          timeoutMs: this.#fileOperationTimeoutMs,
          run: async () => await realpath(baseDir),
        }),
        runFileOperationWithTimeout({
          operation: 'realpath',
          path,
          timeoutMs: this.#fileOperationTimeoutMs,
          run: async () => await realpath(path),
        }),
      ]);
      const rel = relative(baseRealPath, targetRealPath);
      return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async #isRetainedIdentityTarget(target: MaterializedHomeCleanupTarget): Promise<boolean> {
    if (target.targetKind === 'attempt_root') return false;
    const retainedSnapshot = await this.#readRetainedSegments();
    if (retainedSnapshot.identityDeletionAuthority !== 'confirmed') return true;
    const referenced = retainedSnapshot.retainedKeys.has(target.segment)
      || target.targetKind === 'identity_root' && retainedSnapshot.retainedSegments.has(target.segment);
    if (referenced) return true;
    return await runFileOperationWithTimeout({
      operation: 'readResumeState', path: target.path, timeoutMs: this.#fileOperationTimeoutMs,
      run: async () => {
        if (await hasLocalConnectedServiceResumeState(target.path)) return true;
        if (target.targetKind !== 'identity_root') return false;
        // Materialized identity roots contain routing-id or plugin/local Agent homes.
        for (const agent of await readDirectoryEntries(target.path, this.#fileOperationTimeoutMs)) {
          if (await hasLocalConnectedServiceResumeState(agent.path)) return true;
          for (const local of await readDirectoryEntries(agent.path, this.#fileOperationTimeoutMs)) {
            if (await hasLocalConnectedServiceResumeState(local.path)) return true;
          }
        }
        return false;
      },
    });
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
    if (!await this.#isContainedDirectory(target.path, target.baseDir)) {
      return {
        targetKind: target.targetKind,
        path: target.path,
        cleaned: false,
        retained: true,
      };
    }
    try {
      await runFileOperationWithTimeout({
        operation: 'rm',
        path: target.path,
        timeoutMs: this.#fileOperationTimeoutMs,
        run: async () => await this.#removePath(target.path, { recursive: true, force: true }),
      });
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
    const retainedSnapshot = await this.#readRetainedSegments();
    await this.#sanitizeRetainedMaterializedHomes(retainedSnapshot);
    const results: ConnectedServiceMaterializedHomeCleanupResult[] = [];
    for (const target of await this.#listCleanupTargets(retainedSnapshot)) {
      results.push(await this.#removeTarget(target));
    }
    return results;
  }

  async cleanupPendingMaterializedHomes(): Promise<ReadonlyArray<ConnectedServiceMaterializedHomeCleanupResult>> {
    return await this.reconcile();
  }
}
