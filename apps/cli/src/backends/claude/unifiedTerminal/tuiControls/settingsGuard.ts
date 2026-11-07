import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
  lstat,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import { resolveConfiguredClaudeConfigDir } from '@/backends/claude/utils/resolveConfiguredClaudeConfigDir';

/**
 * Settings isolation guard for `/model` and `/effort` controls (B12, Settings Isolation Rules).
 *
 * `/model` and `/effort` persist defaults into the active Claude config root. The guard resolves the
 * exact config root from the SPAWNED process env, snapshots the precise files those controls can
 * touch (`settings.json`, `settings.local.json`, `.claude.json`) — following symlinks so linked
 * connected-service homes are write-through restored — acquires a lock at the resolved settings root so concurrent
 * sessions cannot race snapshot/restore, and verifies byte equality after restore. If restore cannot
 * be guaranteed it returns `{ ok: false }` and the controller must not let a dependent prompt proceed.
 */

const DEFAULT_TRACKED_FILES = ['settings.json', 'settings.local.json', '.claude.json'] as const;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 60_000;
const LOCK_DIR_NAME = '.happier-tui-control.lock';
const JOURNAL_FILE_NAME = 'settings-journal.json';

export function resolveClaudeConfigRootFromEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  return resolveConfiguredClaudeConfigDir({ env, platform });
}

/** Resolve the write-through target; unavailable links must never be replaced by a settings write. */
export async function resolveClaudeSettingsFilePath(configDir: string): Promise<string> {
  const settingsPath = join(configDir, 'settings.json');
  try {
    return await realpath(settingsPath);
  } catch (error) {
    if ((await lstatOrNull(settingsPath))?.isSymbolicLink()) throw error;
    return settingsPath;
  }
}

export type SettingsGuardSnapshotFile = Readonly<{
  relPath: string;
  absPath: string;
  existedBefore: boolean;
  isSymlink: boolean;
  resolvedPath: string;
  content: Buffer | null;
  mode: number | null;
}>;

export type SettingsGuardRestoreResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: string }>;

export interface SettingsGuardSession {
  readonly configDir: string;
  readonly snapshot: readonly SettingsGuardSnapshotFile[];
  restore(): Promise<SettingsGuardRestoreResult>;
  release(): Promise<void>;
}

export interface SettingsGuard {
  acquire(): Promise<SettingsGuardSession>;
}

// In-process serialization keyed by the resolved settings root path. Guarantees same-process
// snapshot/restore ordering before the cross-process advisory lock dir is even attempted.
const IN_PROCESS_LOCKS = new Map<string, Promise<void>>();

export function getClaudeSettingsGuardInProcessLockCountForTesting(): number {
  return IN_PROCESS_LOCKS.size;
}

async function acquireInProcessLock(key: string): Promise<() => void> {
  const previous = IN_PROCESS_LOCKS.get(key) ?? Promise.resolve();
  let releaseFn: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  const tail = previous.then(() => held);
  IN_PROCESS_LOCKS.set(key, tail);
  await previous;
  return () => {
    releaseFn();
    // Drop the registry entry once the chain tail returns to idle so the map does not grow unbounded.
    void tail.then(() => {
      if (IN_PROCESS_LOCKS.get(key) === tail) IN_PROCESS_LOCKS.delete(key);
    });
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

async function chmodIfSupported(path: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return;
  await chmod(path, mode).catch(() => undefined);
}

function tempSiblingPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
}

async function writeFileAtomically(path: string, content: Buffer | string, mode: number | null): Promise<void> {
  const tempPath = tempSiblingPath(path);
  const writeMode = mode ?? 0o600;
  try {
    await writeFile(tempPath, content, { mode: writeMode });
    await chmodIfSupported(tempPath, writeMode);
    await rename(tempPath, path);
    await chmodIfSupported(path, writeMode);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function snapshotFile(configDir: string, relPath: string): Promise<SettingsGuardSnapshotFile> {
  const absPath = join(configDir, relPath);
  const link = await lstatOrNull(absPath);
  if (!link) {
    return { relPath, absPath, existedBefore: false, isSymlink: false, resolvedPath: absPath, content: null, mode: null };
  }
  const isSymlink = link.isSymbolicLink();
  let resolvedPath = absPath;
  if (isSymlink) {
    try {
      resolvedPath = await realpath(absPath);
    } catch {
      // Dangling symlink: treat the link target as non-existent content.
      return { relPath, absPath, existedBefore: true, isSymlink, resolvedPath: absPath, content: null, mode: null };
    }
  }
  let content: Buffer | null = null;
  let mode: number | null = null;
  try {
    mode = (await stat(resolvedPath)).mode & 0o777;
  } catch {
    mode = null;
  }
  try {
    content = await readFile(resolvedPath);
  } catch {
    content = null;
  }
  return { relPath, absPath, existedBefore: true, isSymlink, resolvedPath, content, mode };
}

async function restoreFile(file: SettingsGuardSnapshotFile): Promise<SettingsGuardRestoreResult> {
  if (!file.existedBefore) {
    // The control may have created the file; remove it to restore the original absence.
    if (await pathExists(file.absPath)) {
      await rm(file.absPath, { force: true });
    }
    if (await pathExists(file.absPath)) {
      return { ok: false, reason: `failed to remove created file ${file.relPath}` };
    }
    return { ok: true };
  }

  if (file.content === null) return { ok: true };

  await writeFileAtomically(file.resolvedPath, file.content, file.mode);
  let after: Buffer;
  try {
    after = await readFile(file.resolvedPath);
  } catch {
    return { ok: false, reason: `failed to re-read ${file.relPath} after restore` };
  }
  if (!after.equals(file.content)) {
    return { ok: false, reason: `byte mismatch after restoring ${file.relPath}` };
  }
  return { ok: true };
}

type SettingsGuardJournal = Readonly<{
  version: 1;
  files: readonly SettingsGuardJournalFile[];
}>;

type SettingsGuardJournalFile = Readonly<{
  relPath: string;
  absPath: string;
  existedBefore: boolean;
  isSymlink: boolean;
  resolvedPath: string;
  contentBase64: string | null;
  mode?: number | null;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseJournalFile(value: unknown): SettingsGuardSnapshotFile | null {
  const record = asRecord(value);
  if (!record) return null;
  if (
    typeof record.relPath !== 'string'
    || typeof record.absPath !== 'string'
    || typeof record.existedBefore !== 'boolean'
    || typeof record.isSymlink !== 'boolean'
    || typeof record.resolvedPath !== 'string'
    || !(record.contentBase64 === null || typeof record.contentBase64 === 'string')
  ) {
    return null;
  }
  return {
    relPath: record.relPath,
    absPath: record.absPath,
    existedBefore: record.existedBefore,
    isSymlink: record.isSymlink,
    resolvedPath: record.resolvedPath,
    content: typeof record.contentBase64 === 'string' ? Buffer.from(record.contentBase64, 'base64') : null,
    mode: typeof record.mode === 'number' && Number.isFinite(record.mode) ? record.mode & 0o777 : null,
  };
}

function parseJournal(value: unknown): readonly SettingsGuardSnapshotFile[] | null {
  const record = asRecord(value);
  if (!record || record.version !== 1 || !Array.isArray(record.files)) return null;
  const files: SettingsGuardSnapshotFile[] = [];
  for (const file of record.files) {
    const parsed = parseJournalFile(file);
    if (!parsed) return null;
    files.push(parsed);
  }
  return files;
}

async function writeJournal(lockDir: string, snapshot: readonly SettingsGuardSnapshotFile[]): Promise<void> {
  const journal: SettingsGuardJournal = {
    version: 1,
    files: snapshot.map((file): SettingsGuardJournalFile => ({
      relPath: file.relPath,
      absPath: file.absPath,
      existedBefore: file.existedBefore,
      isSymlink: file.isSymlink,
      resolvedPath: file.resolvedPath,
      contentBase64: file.content === null ? null : file.content.toString('base64'),
      mode: file.mode,
    })),
  };
  await writeFileAtomically(join(lockDir, JOURNAL_FILE_NAME), JSON.stringify(journal), 0o600);
}

async function restoreJournalIfPresent(lockDir: string): Promise<SettingsGuardRestoreResult> {
  const journalPath = join(lockDir, JOURNAL_FILE_NAME);
  let raw: string;
  try {
    raw = await readFile(journalPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true };
    return { ok: false, reason: `failed to read stale settings journal` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: `failed to parse stale settings journal` };
  }

  const snapshot = parseJournal(parsed);
  if (!snapshot) return { ok: false, reason: `invalid stale settings journal` };

  for (const file of snapshot) {
    const result = await restoreFile(file);
    if (!result.ok) return result;
  }
  await rm(journalPath, { force: true });
  return { ok: true };
}

export function createClaudeSettingsGuard(params: Readonly<{
  configDir: string;
  nowMs?: (() => number) | undefined;
  wait?: ((ms: number) => Promise<void>) | undefined;
  lockTimeoutMs?: number | undefined;
  lockStaleMs?: number | undefined;
  trackedFiles?: readonly string[] | undefined;
}>): SettingsGuard {
  const configDir = params.configDir;
  const nowMs = params.nowMs ?? Date.now;
  const wait = params.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const lockTimeoutMs = Math.max(1, params.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const lockStaleMs = Math.max(1, params.lockStaleMs ?? DEFAULT_LOCK_STALE_MS);
  const trackedFiles = params.trackedFiles ?? DEFAULT_TRACKED_FILES;

  return {
    async acquire(): Promise<SettingsGuardSession> {
      await mkdir(configDir, { recursive: true });
      const configRoot = await realpath(configDir);
      const lockRoot = await resolveClaudeSettingsFilePath(configDir)
        .then((settingsPath) => realpath(dirname(settingsPath)))
        .catch(() => configRoot);
      const releaseInProcess = await acquireInProcessLock(lockRoot);

      const lockDir = join(lockRoot, LOCK_DIR_NAME);
      // CLI 0.2.20 journals used the profile root. Recover that known legacy location only after
      // taking the shared target lock, and retain its lock until release. This cannot coordinate
      // a native writer with an already-running older guard in an unknown linked profile.
      const lockDirs = configRoot === lockRoot ? [lockDir] : [lockDir, join(configRoot, LOCK_DIR_NAME)];
      const heldLockDirs: string[] = [];
      const startedAt = nowMs();
      let released = false;
      const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        await Promise.all(heldLockDirs.map((heldDir) => rm(heldDir, { recursive: true, force: true }).catch(() => undefined)));
        releaseInProcess();
      };

      let snapshot: readonly SettingsGuardSnapshotFile[];
      try {
        for (const currentLockDir of lockDirs) {
          for (;;) {
            try {
              await mkdir(currentLockDir, { mode: 0o700 });
              heldLockDirs.push(currentLockDir);
              await chmodIfSupported(currentLockDir, 0o700);
              break;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
              const lockInfo = await lstatOrNull(currentLockDir);
              if (lockInfo && nowMs() - Number(lockInfo.mtimeMs) > lockStaleMs) {
                const staleRestore = await restoreJournalIfPresent(currentLockDir);
                if (!staleRestore.ok) {
                  throw new Error(`failed to restore stale Claude settings journal for ${configDir}: ${staleRestore.reason}`);
                }
                await rm(currentLockDir, { recursive: true, force: true });
                continue;
              }
              if (nowMs() - startedAt > lockTimeoutMs) {
                throw new Error(`timed out acquiring Claude settings lock for ${configDir}`);
              }
              await wait(25);
            }
          }
        }
        snapshot = await Promise.all(trackedFiles.map((relPath) => snapshotFile(configDir, relPath)));
        await writeJournal(lockDir, snapshot);
      } catch (error) {
        await release();
        throw error;
      }

      return {
        configDir,
        snapshot,
        async restore(): Promise<SettingsGuardRestoreResult> {
          for (const file of snapshot) {
            const result = await restoreFile(file);
            if (!result.ok) return result;
          }
          await rm(join(lockDir, JOURNAL_FILE_NAME), { force: true });
          return { ok: true };
        },
        release,
      };
    },
  };
}

/** Serialize an intended persistent write without creating a rollback snapshot for its changes. */
export async function withClaudeSettingsWriteLock<T>(configDir: string, write: () => Promise<T>): Promise<T> {
  const session = await createClaudeSettingsGuard({ configDir, trackedFiles: [] }).acquire();
  try {
    return await write();
  } finally {
    await session.release();
  }
}
