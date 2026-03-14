import { mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { isPidAlive } from './pids.mjs';

function parseLockOwner(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function serializeLockOwner(nowMs) {
  return JSON.stringify({
    pid: process.pid,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
}

function describeLockOwner(lockPath, nowMs) {
  const owner = parseLockOwner(lockPath);
  if (!owner) return 'owner=unknown';
  const ageMs = Math.max(0, nowMs - Number(owner.updatedAtMs ?? owner.createdAtMs ?? nowMs));
  return `pid=${String(owner.pid ?? 'unknown')} ageMs=${ageMs}`;
}

function shouldReclaimLock(lockPath, staleAfterMs, nowMs) {
  let stats;
  try {
    stats = statSync(lockPath);
  } catch {
    return false;
  }
  const owner = parseLockOwner(lockPath);
  const ownerPid = Number(owner?.pid);
  if (Number.isFinite(ownerPid) && ownerPid > 1 && !isPidAlive(ownerPid)) {
    return true;
  }
  const updatedAtMs = Number(owner?.updatedAtMs ?? owner?.createdAtMs ?? stats.mtimeMs ?? 0);
  return updatedAtMs > 0 && nowMs - updatedAtMs > staleAfterMs;
}

export async function withCliDistBuildLock(fn, options = {}) {
  const lockPath = options.lockPath;
  if (!lockPath) {
    throw new Error('withCliDistBuildLock requires options.lockPath');
  }

  mkdirSync(dirname(lockPath), { recursive: true });

  const timeoutMs = options.timeoutMs ?? 240_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const staleAfterMs = options.staleAfterMs ?? timeoutMs;
  const startedAt = Date.now();

  let fd = null;
  let heartbeat = null;
  let waited = false;
  while (true) {
    try {
      fd = openSync(lockPath, 'wx');
      writeFileSync(fd, serializeLockOwner(Date.now()), 'utf8');
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (shouldReclaimLock(lockPath, staleAfterMs, Date.now())) {
        try {
          rmSync(lockPath, { force: true });
        } catch {}
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for CLI dist build lock: ${lockPath} (${describeLockOwner(lockPath, Date.now())})`);
      }
      waited = true;
      await delay(pollIntervalMs);
    }
  }

  try {
    heartbeat = setInterval(() => {
      try {
        writeFileSync(lockPath, serializeLockOwner(Date.now()), 'utf8');
      } catch {}
    }, Math.max(500, Math.min(5_000, Math.floor(staleAfterMs / 4))));
    return await fn({ waited });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (fd !== null) {
      try {
        unlinkSync(lockPath);
      } catch {}
    }
  }
}
