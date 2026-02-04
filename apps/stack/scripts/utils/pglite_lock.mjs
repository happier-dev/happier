import { existsSync } from 'node:fs';
import { open, readFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isPidAlive } from './proc/pids.mjs';

function lockPathForDbDir(dbDir) {
  return join(dirname(dbDir), '.happier.pglite.lock');
}

function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readLock(lockPath) {
  try {
    if (!existsSync(lockPath)) return null;
    const raw = await readFile(lockPath, 'utf-8');
    const parsed = safeParseJson(raw);
    if (!parsed || typeof parsed !== 'object') return { invalid: true };
    return parsed;
  } catch {
    return { invalid: true };
  }
}

async function removeLock(lockPath) {
  try {
    await unlink(lockPath);
  } catch {
    // ignore
  }
}

export async function acquirePgliteDirLock(dbDir, { purpose = 'unknown' } = {}) {
  const resolvedDbDir = resolve(String(dbDir ?? ''));
  if (!resolvedDbDir) throw new Error('Missing dbDir');
  const lockPath = lockPathForDbDir(resolvedDbDir);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        const payload = {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          purpose,
          dbDir: resolvedDbDir,
        };
        await handle.writeFile(JSON.stringify(payload, null, 2) + '\n', 'utf-8');
      } finally {
        await handle.close();
      }

      return async function release() {
        const existing = await readLock(lockPath);
        const pid = Number(existing?.pid);
        if (Number.isFinite(pid) && pid === process.pid) {
          await removeLock(lockPath);
        }
      };
    } catch (e) {
      if (!e || typeof e !== 'object' || !('code' in e) || e.code !== 'EEXIST') {
        throw e;
      }

      const existing = await readLock(lockPath);
      const existingPid = Number(existing?.pid);
      const existingDbDir = existing?.dbDir ? resolve(String(existing.dbDir)) : '';
      const looksInvalid = Boolean(existing?.invalid);
      const pidAlive = Number.isFinite(existingPid) && isPidAlive(existingPid);
      const stale = looksInvalid || !pidAlive;

      if (stale) {
        await removeLock(lockPath);
        continue;
      }

      // Fail closed: if another live process owns the lock, refuse to proceed.
      // Even if dbDir mismatches, this lock still indicates the parent dir is in use.
      const meta = [
        existing?.purpose ? `purpose=${existing.purpose}` : '',
        existing?.createdAt ? `createdAt=${existing.createdAt}` : '',
        existingDbDir ? `dbDir=${existingDbDir}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      throw new Error(`pglite db dir is in use by pid=${existingPid}${meta ? ` (${meta})` : ''}`);
    }
  }

  throw new Error('Failed to acquire pglite lock after retries');
}

