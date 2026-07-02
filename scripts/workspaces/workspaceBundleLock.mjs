import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

function serializeLockOwner(createdAtMs) {
  return JSON.stringify({ pid: process.pid, createdAtMs });
}

function parseLockOwner(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { pid: null, createdAtMs: null };

  try {
    const parsed = JSON.parse(text);
    return {
      pid: typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) && parsed.pid > 0 ? parsed.pid : null,
      createdAtMs:
        typeof parsed.createdAtMs === 'number' && Number.isFinite(parsed.createdAtMs) && parsed.createdAtMs > 0
          ? parsed.createdAtMs
          : null,
    };
  } catch {
    return { pid: null, createdAtMs: null };
  }
}

function readLockOwnerSnapshot(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    return { exists: true, raw, owner: parseLockOwner(raw) };
  } catch {
    return { exists: false, raw: null, owner: { pid: null, createdAtMs: null } };
  }
}

function isRunningPid(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') return false;
    return true;
  }
}

function shouldReclaimLockSnapshot(snapshot, staleAfterMs, nowMs) {
  if (!snapshot.exists) return true;
  const { owner } = snapshot;
  if (owner.pid == null && owner.createdAtMs == null) return true;
  if (owner.pid != null && !isRunningPid(owner.pid)) return true;
  if (owner.createdAtMs != null && nowMs - owner.createdAtMs > staleAfterMs) return true;
  return false;
}

function reclaimLockSnapshot(lockPath, expectedRaw) {
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
    // Leave the quarantined path in place rather than deleting an owner we cannot verify.
    return false;
  }

  if (movedRaw === expectedRaw) {
    try {
      unlinkSync(reclaimPath);
    } catch {
      // ignore
    }
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

export async function withWorkspaceBundleLock(fn, options = {}) {
  const lockPath = options.lockPath;
  if (!String(lockPath ?? '').trim()) {
    throw new Error('Missing workspace bundle lock path');
  }

  mkdirSync(dirname(lockPath), { recursive: true });

  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 240_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const staleAfterMs = options.staleAfterMs ?? timeoutMs;

  let fd = null;
  let heartbeatTimer = null;
  let ownLockRaw = null;
  while (true) {
    try {
      ownLockRaw = serializeLockOwner(Date.now());
      fd = openSync(lockPath, 'wx');
      writeFileSync(fd, ownLockRaw, 'utf8');
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      ownLockRaw = null;
      const snapshot = readLockOwnerSnapshot(lockPath);
      if (shouldReclaimLockSnapshot(snapshot, staleAfterMs, Date.now())) {
        reclaimLockSnapshot(lockPath, snapshot.raw);
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        const { owner } = readLockOwnerSnapshot(lockPath);
        const ownerLabel =
          owner.pid != null
            ? `pid=${owner.pid}, createdAtMs=${owner.createdAtMs ?? 'unknown'}`
            : owner.createdAtMs != null
              ? `createdAtMs=${owner.createdAtMs}`
              : 'unknown owner';
        throw new Error(`Timed out waiting for workspace bundle lock: ${lockPath} (${ownerLabel})`);
      }
      await sleep(pollIntervalMs);
    }
  }

  try {
    if (staleAfterMs > 0) {
      const heartbeatIntervalMs = Math.max(250, Math.min(5_000, Math.floor(staleAfterMs / 4) || 250));
      heartbeatTimer = setInterval(() => {
        try {
          const snapshot = readLockOwnerSnapshot(lockPath);
          if (snapshot.raw !== ownLockRaw) return;
          ownLockRaw = serializeLockOwner(Date.now());
          writeFileSync(lockPath, ownLockRaw, 'utf8');
        } catch {
          // Best-effort lease heartbeat only.
        }
      }, heartbeatIntervalMs);
      heartbeatTimer.unref();
    }

    return await fn();
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    try {
      if (fd != null) closeSync(fd);
    } catch {
      // ignore
    }
    try {
      const snapshot = readLockOwnerSnapshot(lockPath);
      if (snapshot.raw === ownLockRaw) unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}
