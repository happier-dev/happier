import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { PluginStorePaths } from './paths';

const PLUGIN_STORE_LOCK_TIMEOUT_MS_ENV = 'HAPPIER_PLUGIN_STORE_LOCK_TIMEOUT_MS';
const PLUGIN_STORE_LOCK_STALE_AFTER_MS_ENV = 'HAPPIER_PLUGIN_STORE_LOCK_STALE_AFTER_MS';

const DEFAULT_PLUGIN_STORE_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_PLUGIN_STORE_LOCK_STALE_AFTER_MS = 120_000;

export const PLUGIN_STATE_LOCK_NAME = 'plugin-state.v1.lock';
export const MARKETPLACE_SOURCE_REGISTRY_LOCK_NAME = 'marketplace-source-registry.v1.lock';

function resolvePositiveEnvInt(params: Readonly<{
  envName: string;
  defaultValue: number;
  maxValue: number;
}>): number {
  const raw = process.env[params.envName]?.trim();
  if (!raw) {
    return params.defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Invalid ${params.envName} value: ${raw}`);
  }

  return Math.min(Math.floor(parsed), params.maxValue);
}

function resolvePluginStoreLockTimeoutMs(): number {
  return resolvePositiveEnvInt({
    envName: PLUGIN_STORE_LOCK_TIMEOUT_MS_ENV,
    defaultValue: DEFAULT_PLUGIN_STORE_LOCK_TIMEOUT_MS,
    maxValue: 60_000,
  });
}

function resolvePluginStoreLockStaleAfterMs(): number {
  return resolvePositiveEnvInt({
    envName: PLUGIN_STORE_LOCK_STALE_AFTER_MS_ENV,
    defaultValue: DEFAULT_PLUGIN_STORE_LOCK_STALE_AFTER_MS,
    maxValue: 3_600_000,
  });
}

async function shouldBreakLock(params: Readonly<{
  lockFilePath: string;
  nowMs: number;
  timeoutMs: number;
  staleAfterMs: number;
}>): Promise<boolean> {
  let ageMs = 0;
  try {
    const lockStat = await stat(params.lockFilePath);
    if (!Number.isFinite(lockStat.mtimeMs)) {
      return false;
    }
    ageMs = Math.max(0, params.nowMs - lockStat.mtimeMs);
  } catch {
    return false;
  }

  try {
    const raw = await readFile(params.lockFilePath, 'utf8');
    const parsed = JSON.parse(raw) as { pid?: unknown };
    const pid = typeof parsed.pid === 'number' ? parsed.pid : Number(parsed.pid);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(Math.floor(pid), 0);
        return false;
      } catch {
        return true;
      }
    }
  } catch {
    // fall through
  }

  return ageMs > Math.min(params.timeoutMs, params.staleAfterMs);
}

export async function withPluginStoreLock<T>(params: Readonly<{
  paths: PluginStorePaths;
  lockName: string;
  fn: () => Promise<T>;
}>): Promise<T> {
  const timeoutMs = resolvePluginStoreLockTimeoutMs();
  const staleAfterMs = resolvePluginStoreLockStaleAfterMs();
  const startedAt = Date.now();
  const lockFilePath = join(params.paths.locksDir, params.lockName);

  await mkdir(params.paths.locksDir, { recursive: true });

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  while (!handle) {
    try {
      handle = await open(lockFilePath, 'wx');
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        createdAtMs: Date.now(),
      }), { encoding: 'utf8' });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code ?? '';
      if (code !== 'EEXIST') {
        if (code === 'ENOENT') {
          await mkdir(params.paths.locksDir, { recursive: true });
          continue;
        }
        throw error;
      }

      const nowMs = Date.now();
      if (await shouldBreakLock({
        lockFilePath,
        nowMs,
        timeoutMs,
        staleAfterMs,
      })) {
        await unlink(lockFilePath).catch(() => undefined);
        continue;
      }

      if (nowMs - startedAt > timeoutMs) {
        throw new Error(`Timeout acquiring plugin store lock '${params.lockName}' after ${timeoutMs}ms`);
      }

      await new Promise((resolve) => setTimeout(resolve, Math.min(25 + Math.floor((nowMs - startedAt) / 10), 100)));
    }
  }

  try {
    return await params.fn();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(lockFilePath).catch(() => undefined);
  }
}
