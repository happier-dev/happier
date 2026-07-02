import {
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
  lstat,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Settings isolation guard for `/model` and `/effort` controls.
 *
 * `/model` and `/effort` persist defaults into the active Claude config root. The guard resolves the
 * exact config root from the SPAWNED process env, snapshots the precise files those controls can
 * touch (`settings.json`, `settings.local.json`, `.claude.json`) — following symlinks so linked
 * connected-service homes are write-through restored — acquires a per-config-root lock so concurrent
 * sessions cannot race snapshot/restore, and verifies byte equality after restore. If restore cannot
 * be guaranteed it returns `{ ok: false }` and the controller must not let a dependent prompt proceed.
 */

const DEFAULT_TRACKED_FILES = ['settings.json', 'settings.local.json', '.claude.json'] as const;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 60_000;
const LOCK_DIR_NAME = '.happier-tui-control.lock';

function readNonEmpty(value: string | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Resolve the Claude config root the SPAWNED process actually uses. Mirrors the auth
 * materialization idiom (`CLAUDE_CONFIG_DIR` explicit override wins, then the Happier-managed
 * `HAPPIER_CLAUDE_CONFIG_DIR`, then `~/.claude`). `HOME`/`USERPROFILE` are read from the same env
 * so Windows launch envs resolve first-class.
 */
export function resolveClaudeConfigRootFromEnv(env: Readonly<Record<string, string | undefined>>): string {
  const explicit = readNonEmpty(env.CLAUDE_CONFIG_DIR);
  if (explicit) return explicit;
  const managed = readNonEmpty(env.HAPPIER_CLAUDE_CONFIG_DIR);
  if (managed) return managed;
  const home = readNonEmpty(env.HOME) ?? readNonEmpty(env.USERPROFILE) ?? homedir();
  return join(home, '.claude');
}

export type SettingsGuardSnapshotFile = Readonly<{
  relPath: string;
  absPath: string;
  existedBefore: boolean;
  isSymlink: boolean;
  resolvedPath: string;
  content: Buffer | null;
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

// In-process serialization keyed by the (best-effort resolved) config root path. Guarantees same-process
// snapshot/restore ordering before the cross-process advisory lock dir is even attempted.
const IN_PROCESS_LOCKS = new Map<string, Promise<void>>();

async function acquireInProcessLock(key: string): Promise<() => void> {
  const previous = IN_PROCESS_LOCKS.get(key) ?? Promise.resolve();
  let releaseFn: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  IN_PROCESS_LOCKS.set(key, previous.then(() => held));
  await previous;
  return () => {
    releaseFn();
    // Drop the registry entry once the chain tail returns to idle so the map does not grow unbounded.
    void held.then(() => {
      if (IN_PROCESS_LOCKS.get(key) === held) IN_PROCESS_LOCKS.delete(key);
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

async function snapshotFile(configDir: string, relPath: string): Promise<SettingsGuardSnapshotFile> {
  const absPath = join(configDir, relPath);
  const link = await lstatOrNull(absPath);
  if (!link) {
    return { relPath, absPath, existedBefore: false, isSymlink: false, resolvedPath: absPath, content: null };
  }
  const isSymlink = link.isSymbolicLink();
  let resolvedPath = absPath;
  if (isSymlink) {
    try {
      resolvedPath = await realpath(absPath);
    } catch {
      // Dangling symlink: treat the link target as non-existent content.
      return { relPath, absPath, existedBefore: true, isSymlink, resolvedPath: absPath, content: null };
    }
  }
  let content: Buffer | null = null;
  try {
    content = await readFile(resolvedPath);
  } catch {
    content = null;
  }
  return { relPath, absPath, existedBefore: true, isSymlink, resolvedPath, content };
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

  await writeFile(file.resolvedPath, file.content);
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
      const lockKey = (await pathExists(configDir)) ? await realpath(configDir).catch(() => configDir) : configDir;
      const releaseInProcess = await acquireInProcessLock(lockKey);

      const lockDir = join(configDir, LOCK_DIR_NAME);
      const startedAt = nowMs();
      let lockHeld = false;
      try {
        await mkdir(configDir, { recursive: true });
        for (;;) {
          try {
            await mkdir(lockDir);
            lockHeld = true;
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const lockInfo = await lstatOrNull(lockDir);
            if (lockInfo && nowMs() - Number(lockInfo.mtimeMs) > lockStaleMs) {
              await rm(lockDir, { recursive: true, force: true });
              continue;
            }
            if (nowMs() - startedAt > lockTimeoutMs) {
              throw new Error(`timed out acquiring Claude settings lock for ${configDir}`);
            }
            await wait(25);
          }
        }
      } catch (error) {
        releaseInProcess();
        throw error;
      }

      let snapshot: readonly SettingsGuardSnapshotFile[];
      try {
        snapshot = await Promise.all(trackedFiles.map((relPath) => snapshotFile(configDir, relPath)));
      } catch (error) {
        if (lockHeld) await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        releaseInProcess();
        throw error;
      }

      let released = false;
      const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        if (lockHeld) await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        releaseInProcess();
      };

      return {
        configDir,
        snapshot,
        async restore(): Promise<SettingsGuardRestoreResult> {
          for (const file of snapshot) {
            const result = await restoreFile(file);
            if (!result.ok) return result;
          }
          return { ok: true };
        },
        release,
      };
    },
  };
}
