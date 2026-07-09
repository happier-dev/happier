import { lstat, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
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

type MaterializedHomeCleanupFileOperation =
  | 'lstat'
  | 'readFile'
  | 'readdir'
  | 'realpath'
  | 'rm'
  | 'stat'
  | 'writeFile';

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

function stripClaudeRefreshTokenFields(value: unknown): unknown | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const credential = root.claudeAiOauth;
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)) return null;
  const credentialRecord = credential as Record<string, unknown>;
  if (
    !('refreshToken' in credentialRecord)
    && !('refresh_token' in credentialRecord)
    && !('RT' in credentialRecord)
  ) {
    return null;
  }
  const {
    refreshToken: _refreshToken,
    refresh_token: _refresh_token,
    RT: _rt,
    ...withoutRefreshTokens
  } = credentialRecord;
  return {
    ...root,
    claudeAiOauth: withoutRefreshTokens,
  };
}

async function stripLegacyClaudeRefreshTokensFromMaterializedHome(credentialPath: string, timeoutMs: number): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await runFileOperationWithTimeout({
      operation: 'readFile',
      path: credentialPath,
      timeoutMs,
      run: async () => await readFile(credentialPath, 'utf8'),
    })) as unknown;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    return;
  }
  const stripped = stripClaudeRefreshTokenFields(parsed);
  if (!stripped) return;
  await runFileOperationWithTimeout({
    operation: 'writeFile',
    path: credentialPath,
    timeoutMs,
    run: async () => await writeFile(credentialPath, `${JSON.stringify(stripped)}\n`),
  });
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
  readonly #failedAttemptsByPath = new Map<string, number>();
  readonly #abandonedPaths = new Set<string>();

  constructor(private readonly deps: Readonly<{
    baseDir: string;
    nowMs: () => number;
    getLiveMaterializationKeys: () => Iterable<string>;
    getRetainedMaterializationKeys?: () => Promise<ConnectedServiceRetainedMaterializationKeysResult> | ConnectedServiceRetainedMaterializationKeysResult;
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
  }

  async #readRetainedSegments(): Promise<RetainedSegmentsSnapshot> {
    const liveSegments = normalizeMaterializationKeys(this.deps.getLiveMaterializationKeys());
    const retainedResult = normalizeRetainedMaterializationKeysResult(
      await Promise.resolve(this.deps.getRetainedMaterializationKeys?.() ?? []),
    );
    if (retainedResult.status === 'unavailable') {
      return {
        retainedSegments: liveSegments,
        identityDeletionAuthority: 'unavailable',
      };
    }
    const retainedKeys = retainedResult.keys;
    for (const segment of normalizeMaterializationKeys(retainedKeys)) {
      liveSegments.add(segment);
    }
    return {
      retainedSegments: liveSegments,
      identityDeletionAuthority: 'confirmed',
    };
  }

  async #listCleanupTargets(retainedSnapshot: RetainedSegmentsSnapshot): Promise<ReadonlyArray<MaterializedHomeCleanupTarget>> {
    const nowMs = this.#nowMs();
    const targets: MaterializedHomeCleanupTarget[] = [];
    if (retainedSnapshot.identityDeletionAuthority === 'confirmed') {
      for (const entry of await readDirectoryEntries(this.#baseDir, this.#fileOperationTimeoutMs)) {
        if (entry.name === '.attempts') continue;
        if (retainedSnapshot.retainedSegments.has(entry.name)) continue;
        const mtimeMs = await readDirectoryMtimeMs(entry.path, this.#fileOperationTimeoutMs);
        if (mtimeMs === null) continue;
        if (nowMs - mtimeMs < this.#orphanTtlMs) continue;
        targets.push({
          targetKind: 'identity_root',
          segment: entry.name,
          path: entry.path,
          mtimeMs,
        });
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
      });
    }
    return targets;
  }

  async #stripLegacyClaudeRefreshTokens(retainedSnapshot: RetainedSegmentsSnapshot): Promise<void> {
    await Promise.all(Array.from(retainedSnapshot.retainedSegments, async (segment) => {
      await stripLegacyClaudeRefreshTokensFromMaterializedHome(
        join(this.#baseDir, segment, 'claude', '.credentials.json'),
        this.#fileOperationTimeoutMs,
      );
    }));
  }

  async #isContainedDirectory(path: string): Promise<boolean> {
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
          path: this.#baseDir,
          timeoutMs: this.#fileOperationTimeoutMs,
          run: async () => await realpath(this.#baseDir),
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
    if (target.targetKind !== 'identity_root') return false;
    const retainedSnapshot = await this.#readRetainedSegments();
    if (retainedSnapshot.identityDeletionAuthority !== 'confirmed') return true;
    return retainedSnapshot.retainedSegments.has(target.segment);
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
    await this.#stripLegacyClaudeRefreshTokens(retainedSnapshot);
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
