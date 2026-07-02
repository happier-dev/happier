import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { isPidAlive } from '../proc/pids.mjs';

function parseLockOwner(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
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

function lockScopeHash({ internalServerUrl = '', stackName = '' } = {}) {
  return createHash('sha256')
    .update(String(stackName ?? '').trim())
    .update('\n')
    .update(String(internalServerUrl ?? '').trim())
    .digest('hex')
    .slice(0, 16);
}

export function resolveStackDaemonLifecycleLockPath({ cliHomeDir, internalServerUrl = '', stackName = '' } = {}) {
  const home = String(cliHomeDir ?? '').trim();
  if (!home) {
    throw new Error('resolveStackDaemonLifecycleLockPath requires cliHomeDir');
  }
  return join(home, 'locks', `daemon-lifecycle-${lockScopeHash({ internalServerUrl, stackName })}.lock`);
}

export function isStackDaemonLifecycleLockActive(lockPath, options = {}) {
  const staleAfterMs = options.staleAfterMs ?? 60_000;
  const nowMs = options.nowMs ?? Date.now();
  try {
    statSync(lockPath);
  } catch {
    return false;
  }
  return !shouldReclaimLock(lockPath, staleAfterMs, nowMs);
}

export async function withStackDaemonLifecycleLock(scope, fn, options = {}) {
  const lockPath = options.lockPath ?? resolveStackDaemonLifecycleLockPath(scope);
  mkdirSync(dirname(lockPath), { recursive: true });

  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 125;
  const staleAfterMs = options.staleAfterMs ?? Math.max(60_000, timeoutMs);
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
        throw new Error(`Timed out waiting for daemon lifecycle lock: ${lockPath} (${describeLockOwner(lockPath, Date.now())})`);
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
    return await fn({ waited, lockPath });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
      fd = null;
      try {
        unlinkSync(lockPath);
      } catch {}
    }
  }
}
