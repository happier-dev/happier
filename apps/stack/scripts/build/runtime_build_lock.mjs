import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, link, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

import { observePidLiveness } from '../utils/proc/pids.mjs';

function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readBuildLockSnapshot(lockPath) {
  let stats;
  try {
    stats = await stat(lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { exists: true, readable: false, mtimeMs: 0, raw: null, owner: null };
    }
    return { exists: false, readable: false, mtimeMs: 0, raw: null, owner: null };
  }

  try {
    const raw = await readFile(lockPath, 'utf-8');
    const parsed = safeParseJson(raw);
    return {
      exists: true,
      readable: true,
      mtimeMs: stats.mtimeMs,
      raw,
      owner: parsed && typeof parsed === 'object' ? parsed : null,
    };
  } catch {
    return { exists: true, readable: false, mtimeMs: stats.mtimeMs, raw: null, owner: null };
  }
}

async function restoreQuarantinedBuildLock(lockPath, reclaimPath) {
  for (const restore of [
    () => link(reclaimPath, lockPath),
    () => copyFile(reclaimPath, lockPath, fsConstants.COPYFILE_EXCL),
  ]) {
    try {
      await restore();
      try {
        await unlink(reclaimPath);
      } catch {}
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return true;
    }
  }
  return false;
}

async function classifyRetainedBuildLocks(lockPath, classificationOptions) {
  const prefix = `${basename(lockPath)}.reclaim-`;
  const retainedPaths = [];
  for (const name of (await readdir(dirname(lockPath))).filter((entry) => entry.startsWith(prefix))) {
    const retainedPath = join(dirname(lockPath), name);
    const snapshot = await readBuildLockSnapshot(retainedPath);
    if (!snapshot.exists) continue;
    if (shouldReclaimBuildLockSnapshot(snapshot, classificationOptions)) {
      const retired = await reclaimBuildLockSnapshot(retainedPath, snapshot.raw);
      if (!retired) {
        throw new Error(`[build] runtime build lock recovery cleanup failed (${lockPath})`);
      }
      continue;
    }
    retainedPaths.push(retainedPath);
  }
  return retainedPaths;
}

async function recoverRetainedBuildLock(lockPath, classificationOptions) {
  const retainedPaths = await classifyRetainedBuildLocks(lockPath, classificationOptions);
  if (retainedPaths.length === 0) return false;
  if (retainedPaths.length > 1) {
    throw new Error(`[build] runtime build lock recovery is ambiguous (${lockPath})`);
  }
  const restored = await restoreQuarantinedBuildLock(
    lockPath,
    retainedPaths[0],
  );
  if (!restored) {
    const [currentLock, retainedLock] = await Promise.all([
      readBuildLockSnapshot(lockPath),
      readBuildLockSnapshot(retainedPaths[0]),
    ]);
    if (!currentLock.exists && !retainedLock.exists) {
      return false;
    }
    throw new Error(`[build] runtime build lock recovery is pending (${lockPath})`);
  }
  return true;
}

function shouldReclaimBuildLockSnapshot(
  snapshot,
  {
    nowMs = Date.now(),
    initializationGraceMs = 5_000,
    observePidLivenessImpl = observePidLiveness,
    readProcessInstanceFingerprintSyncImpl = readProcessInstanceFingerprintSync,
  } = {},
) {
  if (!snapshot.exists) return true;
  if (!snapshot.readable) return false;

  const ownerPid = Number(snapshot.owner?.pid);
  if (Number.isInteger(ownerPid) && ownerPid > 1) {
    const liveness = observePidLivenessImpl(ownerPid);
    if (liveness?.status === 'dead') return true;
    if (liveness?.status !== 'alive') return false;
    const expectedFingerprint = String(snapshot.owner?.processInstanceFingerprint ?? '').trim();
    if (!expectedFingerprint) return false;
    const observedFingerprint = String(readProcessInstanceFingerprintSyncImpl(ownerPid, {
      expectedFingerprint,
    }) ?? '').trim();
    return observedFingerprint !== '' && observedFingerprint !== expectedFingerprint;
  }

  return nowMs - snapshot.mtimeMs > initializationGraceMs;
}

async function reclaimBuildLockSnapshot(lockPath, expectedRaw) {
  if (expectedRaw == null) return true;
  const reclaimPath = `${lockPath}.reclaim-${process.pid}-${randomUUID()}`;

  try {
    await rename(lockPath, reclaimPath);
  } catch (error) {
    return error?.code === 'ENOENT';
  }

  let movedRaw;
  try {
    movedRaw = await readFile(reclaimPath, 'utf8');
  } catch {
    await restoreQuarantinedBuildLock(lockPath, reclaimPath);
    return false;
  }

  if (movedRaw === expectedRaw) {
    try {
      await unlink(reclaimPath);
    } catch {}
    return true;
  }

  await restoreQuarantinedBuildLock(lockPath, reclaimPath);
  return false;
}

export async function acquireRuntimeBuildLock({
  lockPath,
  readProcessInstanceFingerprintSyncImpl = readProcessInstanceFingerprintSync,
  observePidLivenessImpl = observePidLiveness,
  timeoutMs = 240_000,
  pollIntervalMs = 250,
  onWait,
} = {}) {
  const resolvedLockPath = String(lockPath ?? '').trim();
  if (!resolvedLockPath) throw new Error('Missing runtime build lock path');
  const startedAt = Date.now();

  while (true) {
    if (!(await readBuildLockSnapshot(resolvedLockPath)).exists) {
      if (await recoverRetainedBuildLock(resolvedLockPath, {
        observePidLivenessImpl,
        readProcessInstanceFingerprintSyncImpl,
      })) continue;
    }
    try {
      const handle = await open(resolvedLockPath, 'wx', 0o600);
      const ownerRaw = JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        token: randomUUID(),
        processInstanceFingerprint: readProcessInstanceFingerprintSyncImpl(process.pid) ?? null,
      }) + '\n';
      try {
        await handle.writeFile(ownerRaw, 'utf-8');
      } finally {
        await handle.close();
      }

      let retainedPaths;
      try {
        retainedPaths = await classifyRetainedBuildLocks(resolvedLockPath, {
          observePidLivenessImpl,
          readProcessInstanceFingerprintSyncImpl,
        });
      } catch (error) {
        const released = await reclaimBuildLockSnapshot(resolvedLockPath, ownerRaw);
        if (!released) {
          throw new Error(`[build] failed to safely revalidate runtime build lock (${resolvedLockPath})`);
        }
        throw error;
      }
      if (retainedPaths.length > 0) {
        const released = await reclaimBuildLockSnapshot(resolvedLockPath, ownerRaw);
        if (!released) {
          throw new Error(`[build] failed to safely reclaim runtime build lock (${resolvedLockPath})`);
        }
        await recoverRetainedBuildLock(resolvedLockPath, {
          observePidLivenessImpl,
          readProcessInstanceFingerprintSyncImpl,
        });
        continue;
      }

      return async function release() {
        await reclaimBuildLockSnapshot(resolvedLockPath, ownerRaw);
      };
    } catch (e) {
      if (!e || typeof e !== 'object' || !('code' in e) || e.code !== 'EEXIST') {
        throw e;
      }

      const snapshot = await readBuildLockSnapshot(resolvedLockPath);
      const existingPid = Number(snapshot.owner?.pid);
      if (shouldReclaimBuildLockSnapshot(snapshot, {
        observePidLivenessImpl,
        readProcessInstanceFingerprintSyncImpl,
      })) {
        const reclaimed = await reclaimBuildLockSnapshot(resolvedLockPath, snapshot.raw);
        if (!reclaimed) {
          const replacement = await readBuildLockSnapshot(resolvedLockPath);
          if (!replacement.exists) {
            throw new Error(`[build] failed to safely reclaim runtime build lock (${resolvedLockPath})`);
          }
          const replacementPid = Number(replacement.owner?.pid);
          throw new Error(
            `[build] runtime build is already in progress (lock: ${resolvedLockPath}, pid=${Number.isFinite(replacementPid) ? replacementPid : 'unknown'}). ` +
            'Wait for the current owner to finish and retry.',
          );
        }
        continue;
      }

      const waitedMs = Date.now() - startedAt;
      if (waitedMs >= timeoutMs) {
        throw new Error(
          `[build] timed out waiting for runtime build lock (lock: ${resolvedLockPath}, pid=${Number.isFinite(existingPid) ? existingPid : 'unknown'}).`,
        );
      }
      if (typeof onWait === 'function') {
        try {
          onWait({
            lockPath: resolvedLockPath,
            owner: snapshot.owner,
            waitedMs,
            timeoutMs,
          });
        } catch {}
      }
      await delay(Math.max(1, Math.min(pollIntervalMs, timeoutMs - waitedMs)));
    }
  }
}
