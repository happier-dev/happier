import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, readFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isPidAlive } from './proc/pids.mjs';
import { getPidStartTime } from './proc/ownership.mjs';

const PGLITE_LOCK_FILENAME = '.happier.pglite.lock';

export function getPgliteDirLockPath(dbDir) {
  const resolvedDbDir = resolve(String(dbDir ?? ''));
  const short = createHash('sha256').update(resolvedDbDir).digest('hex').slice(0, 12);
  return join(dirname(resolvedDbDir), `${PGLITE_LOCK_FILENAME}.${short}`);
}

function legacyAdjacentLockPathForDbDir(dbDir) {
  return join(dirname(dbDir), PGLITE_LOCK_FILENAME);
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

async function assertNoLiveLegacyAdjacentLock(resolvedDbDir) {
  const legacyLockPath = legacyAdjacentLockPathForDbDir(resolvedDbDir);
  const hashedLockPath = getPgliteDirLockPath(resolvedDbDir);
  if (legacyLockPath === hashedLockPath) return;

  const existing = await readLock(legacyLockPath);
  if (!existing) return;
  if (existing.invalid) {
    throw new Error(`pglite legacy lock is invalid: ${legacyLockPath}`);
  }

  const existingPid = Number(existing?.pid);
  const existingDbDir = existing?.dbDir ? resolve(String(existing.dbDir)) : '';
  const sameDbDir = existingDbDir ? existingDbDir === resolvedDbDir : true;
  if (!sameDbDir) return;

  if (Number.isFinite(existingPid) && isPidAlive(existingPid)) {
    const meta = [
      existing?.purpose ? `purpose=${existing.purpose}` : '',
      existing?.createdAt ? `createdAt=${existing.createdAt}` : '',
      existingDbDir ? `dbDir=${existingDbDir}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    throw new Error(`pglite db dir is in use by pid=${existingPid}${meta ? ` (${meta})` : ''}`);
  }

  await removeLock(legacyLockPath);
}

export async function acquirePgliteDirLock(dbDir, { purpose = 'unknown' } = {}) {
  const resolvedDbDir = resolve(String(dbDir ?? ''));
  if (!resolvedDbDir) throw new Error('Missing dbDir');
  await assertNoLiveLegacyAdjacentLock(resolvedDbDir);
  const legacyInsideDbDir = join(resolvedDbDir, PGLITE_LOCK_FILENAME);
  await removeLock(legacyInsideDbDir);
  const lockPath = getPgliteDirLockPath(resolvedDbDir);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        const payload = {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          purpose,
          dbDir: resolvedDbDir,
          pidStartTime: await getPidStartTime(process.pid),
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
      const stale = await (async () => {
        if (looksInvalid) return true;
        if (!pidAlive) return true;
        const expectedStartTime = typeof existing?.pidStartTime === 'string' ? existing.pidStartTime.trim() : '';
        if (!expectedStartTime) return false;
        const currentStartTime = await getPidStartTime(existingPid);
        // Fail-open for fingerprint lookup errors: do not break lock acquisition.
        if (!currentStartTime) return false;
        return currentStartTime.trim() !== expectedStartTime;
      })();

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

export async function waitForPgliteDirLockRelease(
  dbDir,
  { timeoutMs = 5_000, intervalMs = 100, sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)) } = {}
) {
  const resolvedDbDir = resolve(String(dbDir ?? ''));
  if (!resolvedDbDir) return true;
  const lockPaths = [getPgliteDirLockPath(resolvedDbDir), legacyAdjacentLockPathForDbDir(resolvedDbDir)];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let held = false;
    for (const lockPath of lockPaths) {
      // eslint-disable-next-line no-await-in-loop
      const existing = await readLock(lockPath);
      if (!existing) continue;
      if (existing.invalid) {
        held = true;
        continue;
      }
      const existingDbDir = existing?.dbDir ? resolve(String(existing.dbDir)) : '';
      if (lockPath === legacyAdjacentLockPathForDbDir(resolvedDbDir) && existingDbDir && existingDbDir !== resolvedDbDir) {
        continue;
      }
      const existingPid = Number(existing?.pid);
      if (Number.isFinite(existingPid) && isPidAlive(existingPid)) {
        held = true;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await removeLock(lockPath);
    }
    if (!held) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }

  return false;
}
