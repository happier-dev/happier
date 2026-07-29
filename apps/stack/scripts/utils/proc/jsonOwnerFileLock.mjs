import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { isPidAlive } from './pids.mjs';

export function parseJsonOwnerLockRaw(raw) {
  try {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readJsonOwnerLockRaw(lockPath) {
  try {
    return readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
}

export function readJsonOwnerLockSnapshot(lockPath) {
  const raw = readJsonOwnerLockRaw(lockPath);
  if (raw == null) return { exists: false, raw: null, owner: null };
  return { exists: true, raw, owner: parseJsonOwnerLockRaw(raw) };
}

function serializeJsonOwnerLock(nowMs) {
  return JSON.stringify({
    pid: process.pid,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
}

export function describeJsonOwnerLock(lockPath, nowMs) {
  const owner = readJsonOwnerLockSnapshot(lockPath).owner;
  if (!owner) return 'owner=unknown';
  const ageMs = Math.max(0, nowMs - Number(owner.updatedAtMs ?? owner.createdAtMs ?? nowMs));
  return `pid=${String(owner.pid ?? 'unknown')} ageMs=${ageMs}`;
}

export function shouldReclaimJsonOwnerLockSnapshot(snapshot, staleAfterMs, nowMs, fallbackMtimeMs = 0, options = {}) {
  if (!snapshot.exists) return true;
  const owner = snapshot.owner;
  const ownerPid = Number(owner?.pid);
  if (Number.isFinite(ownerPid) && ownerPid > 1) {
    if (!isPidAlive(ownerPid)) return true;
    if (options.allowLiveOwnerStaleReclaim !== true) return false;
    const updatedAtMs = Number(owner?.updatedAtMs ?? owner?.createdAtMs ?? fallbackMtimeMs);
    return updatedAtMs > 0 && nowMs - updatedAtMs > staleAfterMs;
  }
  const updatedAtMs = Number(owner?.updatedAtMs ?? owner?.createdAtMs ?? fallbackMtimeMs);
  return updatedAtMs > 0 && nowMs - updatedAtMs > staleAfterMs;
}

function shouldReclaimJsonOwnerLock(lockPath, staleAfterMs, nowMs, options = {}) {
  let stats;
  try {
    stats = statSync(lockPath);
  } catch {
    return false;
  }
  return shouldReclaimJsonOwnerLockSnapshot(readJsonOwnerLockSnapshot(lockPath), staleAfterMs, nowMs, stats.mtimeMs, options);
}

function reclaimJsonOwnerLockSnapshot(lockPath, expectedRaw) {
  if (expectedRaw == null) return true;
  const reclaimPath = `${lockPath}.reclaim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    renameSync(lockPath, reclaimPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }

  let movedRaw = null;
  try {
    movedRaw = readFileSync(reclaimPath, 'utf8');
  } catch {
    return false;
  }

  if (movedRaw === expectedRaw) {
    try {
      unlinkSync(reclaimPath);
    } catch {}
    return true;
  }

  try {
    writeFileSync(lockPath, movedRaw, { encoding: 'utf8', flag: 'wx' });
    unlinkSync(reclaimPath);
  } catch {
    // Another owner already has the lock path. Keep the quarantined file for diagnostics.
  }
  return false;
}

export function isJsonOwnerFileLockActive(lockPath, options = {}) {
  const staleAfterMs = options.staleAfterMs ?? 240_000;
  const nowMs = options.nowMs ?? Date.now();
  try {
    statSync(lockPath);
  } catch {
    return false;
  }
  return !shouldReclaimJsonOwnerLock(lockPath, staleAfterMs, nowMs, options);
}

export async function withJsonOwnerFileLock(fn, options = {}) {
  const lockPath = options.lockPath;
  if (!lockPath) {
    throw new Error('withJsonOwnerFileLock requires options.lockPath');
  }

  mkdirSync(dirname(lockPath), { recursive: true });

  const timeoutMs = options.timeoutMs ?? 240_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const staleAfterMs = options.staleAfterMs ?? timeoutMs;
  const startedAt = Date.now();
  const errorLabel = options.errorLabel ?? 'JSON owner file lock';

  let fd = null;
  let heartbeat = null;
  let ownLockRaw = null;
  let waited = false;

  while (true) {
    try {
      ownLockRaw = serializeJsonOwnerLock(Date.now());
      fd = openSync(lockPath, 'wx');
      writeFileSync(fd, ownLockRaw, 'utf8');
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      ownLockRaw = null;
      const snapshot = readJsonOwnerLockSnapshot(lockPath);
      let fallbackMtimeMs = 0;
      try {
        fallbackMtimeMs = statSync(lockPath).mtimeMs;
      } catch {}
      if (shouldReclaimJsonOwnerLockSnapshot(snapshot, staleAfterMs, Date.now(), fallbackMtimeMs, options)) {
        reclaimJsonOwnerLockSnapshot(lockPath, snapshot.raw);
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for ${errorLabel}: ${lockPath} (${describeJsonOwnerLock(lockPath, Date.now())})`);
      }
      waited = true;
      if (typeof options.onWait === 'function') {
        try {
          options.onWait({
            lockPath,
            owner: snapshot.owner,
            staleAfterMs,
            timeoutMs,
            waitedMs: Date.now() - startedAt,
          });
        } catch {}
      }
      await delay(pollIntervalMs);
    }
  }

  try {
    heartbeat = setInterval(() => {
      try {
        if (readJsonOwnerLockRaw(lockPath) !== ownLockRaw) return;
        ownLockRaw = serializeJsonOwnerLock(Date.now());
        writeFileSync(lockPath, ownLockRaw, 'utf8');
      } catch {}
    }, Math.max(500, Math.min(5_000, Math.floor(staleAfterMs / 4))));
    return await fn({ waited, lockPath });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
      fd = null;
      try {
        if (readJsonOwnerLockRaw(lockPath) === ownLockRaw) unlinkSync(lockPath);
      } catch {}
    }
  }
}
