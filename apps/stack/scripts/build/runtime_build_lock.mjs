import { open, readFile, unlink } from 'node:fs/promises';

import { isPidAlive } from '../utils/proc/pids.mjs';

function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readBuildLock(lockPath) {
  try {
    const raw = await readFile(lockPath, 'utf-8');
    const parsed = safeParseJson(raw);
    if (!parsed || typeof parsed !== 'object') return { invalid: true };
    return parsed;
  } catch {
    return { invalid: true };
  }
}

async function removeBuildLock(lockPath) {
  try {
    await unlink(lockPath);
  } catch {
    // ignore
  }
}

export async function acquireRuntimeBuildLock({ lockPath }) {
  const resolvedLockPath = String(lockPath ?? '').trim();
  if (!resolvedLockPath) throw new Error('Missing runtime build lock path');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(resolvedLockPath, 'wx', 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            createdAt: new Date().toISOString(),
          }) + '\n',
          'utf-8',
        );
      } finally {
        await handle.close();
      }

      return async function release() {
        const existing = await readBuildLock(resolvedLockPath);
        const pid = Number(existing?.pid);
        if (Number.isFinite(pid) && pid === process.pid) {
          await removeBuildLock(resolvedLockPath);
        }
      };
    } catch (e) {
      if (!e || typeof e !== 'object' || !('code' in e) || e.code !== 'EEXIST') {
        throw e;
      }

      const existing = await readBuildLock(resolvedLockPath);
      const existingPid = Number(existing?.pid);
      const lockIsStale = Boolean(existing?.invalid) || !Number.isFinite(existingPid) || !isPidAlive(existingPid);

      if (lockIsStale) {
        await removeBuildLock(resolvedLockPath);
        continue;
      }

      throw new Error(
        `[build] runtime build is already in progress (lock: ${resolvedLockPath}, pid=${existingPid}). ` +
        `Wait for the other build to finish, or remove the stale lock if that process is gone.`,
      );
    }
  }

  throw new Error(`[build] failed to acquire runtime build lock after retries (${resolvedLockPath})`);
}
