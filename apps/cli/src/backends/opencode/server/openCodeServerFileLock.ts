import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isOpenCodeServerPidAlive } from './openCodeServerProcessState';

function resolveManagedServerStartTimeoutMsFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = typeof env.HAPPIER_OPENCODE_SERVER_START_TIMEOUT_MS === 'string'
    ? env.HAPPIER_OPENCODE_SERVER_START_TIMEOUT_MS.trim()
    : '';
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 30_000;
  return Math.min(Math.floor(n), 120_000);
}

export function resolveOpenCodeServerLockTimeoutMsFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = typeof env.HAPPIER_OPENCODE_SERVER_LOCK_TIMEOUT_MS === 'string'
    ? env.HAPPIER_OPENCODE_SERVER_LOCK_TIMEOUT_MS.trim()
    : '';
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return Math.max(20_000, Math.min(resolveManagedServerStartTimeoutMsFromEnv(env), 60_000));
  }
  return Math.min(Math.floor(n), 60_000);
}

function resolveLockStaleAfterMsFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = typeof env.HAPPIER_OPENCODE_SERVER_LOCK_STALE_AFTER_MS === 'string'
    ? env.HAPPIER_OPENCODE_SERVER_LOCK_STALE_AFTER_MS.trim()
    : '';
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 300_000;
  return Math.min(Math.floor(n), 3_600_000);
}

async function shouldBreakLock(
  lockFile: string,
  nowMs: number,
  staleAfterMs: number,
  timeoutMs: number,
): Promise<boolean> {
  let ageMs = 0;
  try {
    const st = await stat(lockFile);
    if (!Number.isFinite(st.mtimeMs)) return false;
    ageMs = nowMs - st.mtimeMs;
    if (!Number.isFinite(ageMs) || ageMs < 0) ageMs = 0;
  } catch {
    return false;
  }

  try {
    const raw = await readFile(lockFile, 'utf8');
    const parsed = JSON.parse(raw);
    const pid = typeof (parsed as any)?.pid === 'number' ? (parsed as any).pid : Number((parsed as any)?.pid);
    if (Number.isFinite(pid) && pid > 0) {
      return !isOpenCodeServerPidAlive(Math.floor(pid));
    }
  } catch {
    // fall through
  }

  return ageMs > Math.min(staleAfterMs, timeoutMs);
}

export async function withOpenCodeServerFileLock<T>(lockFile: string, fn: () => Promise<T>): Promise<T> {
  const timeoutMs = resolveOpenCodeServerLockTimeoutMsFromEnv(process.env);
  const staleAfterMs = resolveLockStaleAfterMsFromEnv(process.env);
  const startedAt = Date.now();
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  await mkdir(dirname(lockFile), { recursive: true });

  while (!handle) {
    try {
      handle = await open(lockFile, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }), { encoding: 'utf8' });
    } catch (error: any) {
      const code = typeof error?.code === 'string' ? String(error.code) : '';
      if (code && code !== 'EEXIST') {
        if (code === 'ENOENT') {
          await mkdir(dirname(lockFile), { recursive: true });
          continue;
        }
        throw new Error(`Failed to acquire OpenCode server lock: ${code}`);
      }
      if (!code) {
        throw error instanceof Error ? error : new Error('Failed to acquire OpenCode server lock');
      }
      if (code === 'EEXIST') {
        const st = await stat(lockFile).catch(() => null);
        if (st?.isDirectory?.()) {
          throw new Error('Failed to acquire OpenCode server lock: EISDIR');
        }
      }

      const now = Date.now();
      if (await shouldBreakLock(lockFile, now, staleAfterMs, timeoutMs)) {
        try {
          await unlink(lockFile);
        } catch {
          // ignore
        }
        continue;
      }

      if (now - startedAt > timeoutMs) {
        throw new Error(`Timeout acquiring OpenCode server lock after ${timeoutMs}ms`);
      }

      const delay = Math.min(25 + Math.floor((now - startedAt) / 10), 100);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      await handle.close();
    } catch {
      // ignore
    }
    try {
      await unlink(lockFile);
    } catch {
      // ignore
    }
  }
}
