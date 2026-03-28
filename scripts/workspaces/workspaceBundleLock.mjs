import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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

function isRunningPid(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') return false;
    return true;
  }
}

function shouldReclaimLock(lockPath, staleAfterMs, nowMs) {
  try {
    const owner = parseLockOwner(readFileSync(lockPath, 'utf8'));
    if (owner.pid == null && owner.createdAtMs == null) return true;
    if (owner.pid != null && !isRunningPid(owner.pid)) return true;
    if (owner.createdAtMs != null && nowMs - owner.createdAtMs > staleAfterMs) return true;
  } catch {
    return true;
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
  while (true) {
    try {
      fd = openSync(lockPath, 'wx');
      writeFileSync(fd, serializeLockOwner(Date.now()), 'utf8');
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (shouldReclaimLock(lockPath, staleAfterMs, Date.now())) {
        try {
          unlinkSync(lockPath);
        } catch {
          // ignore
        }
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        const owner = parseLockOwner(readFileSync(lockPath, 'utf8'));
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
          writeFileSync(lockPath, serializeLockOwner(Date.now()), 'utf8');
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
      unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

