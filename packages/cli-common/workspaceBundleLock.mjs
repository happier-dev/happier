import { randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  createWorkspaceLockLeaseValue,
  workspaceLockLeaseMatchesOwner,
} from './workspaceLockLease.mjs';
import {
  processInstanceFingerprintMatches,
  readProcessInstanceFingerprintSync,
} from './processInstance.mjs';

export const WORKSPACE_BUNDLE_LOCK_TIMEOUT_ERROR_CODE = 'EWORKSPACEBUNDLELOCKTIMEOUT';

function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

export function resolveWorkspaceBundleLockPath(repoRoot) {
  return resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
}

function parseLockOwner(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readLockOwnerSnapshot(lockPath) {
  let stats;
  try {
    stats = statSync(lockPath);
  } catch {
    return { exists: false, readable: false, mtimeMs: 0, raw: null, owner: null };
  }

  try {
    const raw = readFileSync(lockPath, 'utf8');
    return { exists: true, readable: true, mtimeMs: stats.mtimeMs, raw, owner: parseLockOwner(raw) };
  } catch {
    // An existing owner that cannot be read cannot be authenticated or safely reclaimed. Keep it
    // distinct from ENOENT so callers enter the bounded wait/timeout path instead of spinning.
    return { exists: true, readable: false, mtimeMs: stats.mtimeMs, raw: null, owner: null };
  }
}

function isRunningPid(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function shouldReclaimLockSnapshot(snapshot, staleAfterMs, nowMs, options = {}) {
  if (!snapshot.exists) return true;
  if (!snapshot.readable) return false;
  const ownerPid = Number(snapshot.owner?.pid);
  if (Number.isFinite(ownerPid) && ownerPid > 0) {
    const isRunningPidImpl = options.isRunningPidImpl ?? isRunningPid;
    if (!isRunningPidImpl(ownerPid)) return true;
    const expectedFingerprint = String(snapshot.owner?.processInstanceFingerprint ?? '').trim();
    if (!expectedFingerprint) return false;
    const readFingerprint = options.readProcessInstanceFingerprintImpl ?? readProcessInstanceFingerprintSync;
    const observedFingerprint = readFingerprint(ownerPid);
    return Boolean(observedFingerprint)
      && !processInstanceFingerprintMatches(expectedFingerprint, observedFingerprint);
  }
  const updatedAtMs = Number(
    snapshot.owner?.updatedAtMs
      ?? snapshot.owner?.createdAtMs
      ?? snapshot.mtimeMs
      ?? 0,
  );
  return updatedAtMs > 0 && nowMs - updatedAtMs > staleAfterMs;
}

export function isWorkspaceBundleLockActive(lockPath, options = {}) {
  const snapshot = readLockOwnerSnapshot(lockPath);
  return snapshot.exists && !shouldReclaimLockSnapshot(
    snapshot,
    options.staleAfterMs ?? 240_000,
    options.nowMs ?? Date.now(),
    options,
  );
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
    // A successor owns the canonical path. Preserve the quarantined snapshot for diagnostics.
  }
  return false;
}

function serializeLockOwner({ createdAtMs, updatedAtMs, ownerToken, processInstanceFingerprint }) {
  return JSON.stringify({
    pid: process.pid,
    createdAtMs,
    updatedAtMs,
    token: ownerToken,
    processInstanceFingerprint,
  });
}

function callerHoldsWorkspaceBundleLock(lockPath, heldLockValue) {
  const snapshot = readLockOwnerSnapshot(lockPath);
  return snapshot.exists && workspaceLockLeaseMatchesOwner({
    lockPath,
    leaseValue: heldLockValue,
    owner: snapshot.owner,
  });
}

function describeLockOwner(snapshot, nowMs) {
  if (!snapshot.owner) return 'owner=unknown';
  const ageMs = Math.max(
    0,
    nowMs - Number(snapshot.owner.updatedAtMs ?? snapshot.owner.createdAtMs ?? nowMs),
  );
  return `pid=${String(snapshot.owner.pid ?? 'unknown')} ageMs=${ageMs}`;
}

function createWorkspaceBundleLockTimeoutError({ errorLabel, lockPath, snapshot }) {
  const error = new Error(
    `Timed out waiting for ${errorLabel}: ${lockPath} (${describeLockOwner(snapshot, Date.now())})`,
  );
  error.code = WORKSPACE_BUNDLE_LOCK_TIMEOUT_ERROR_CODE;
  return error;
}

function resolveHeldLockValue(options) {
  return String(options.heldLockValue ?? options.heldLockPath ?? '').trim();
}

function notifyWaiter(options, lockPath, snapshot, startedAt, staleAfterMs, timeoutMs) {
  if (typeof options.onWait !== 'function') return;
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

function cleanupFailedOwnerInitialization(lockPath, fd, initializationError) {
  try {
    if (fd !== null) closeSync(fd);
  } catch {}

  try {
    unlinkSync(lockPath);
  } catch (cleanupError) {
    throw new AggregateError(
      [initializationError, cleanupError],
      `Failed to initialize and clean up workspace bundle lock: ${lockPath}`,
    );
  }
}

export async function withWorkspaceBundleLock(fn, options = {}) {
  options.signal?.throwIfAborted();
  const lockPath = String(options.lockPath ?? '').trim();
  if (!lockPath) throw new Error('Missing workspace bundle lock path');

  const inheritedValue = resolveHeldLockValue(options);
  if (callerHoldsWorkspaceBundleLock(lockPath, inheritedValue)) {
    return await fn({
      waited: false,
      lockPath,
      heldLockValue: inheritedValue,
      inherited: true,
    });
  }

  mkdirSync(dirname(lockPath), { recursive: true });
  const timeoutMs = options.timeoutMs === null ? null : (options.timeoutMs ?? 240_000);
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const staleAfterMs = options.staleAfterMs ?? timeoutMs ?? 240_000;
  const startedAt = Date.now();
  const ownerToken = randomUUID();
  let createdAtMs = 0;
  let ownLockRaw = null;
  let fd = null;
  let heartbeat = null;
  let waited = false;
  const readProcessInstanceFingerprintImpl = options.readProcessInstanceFingerprintImpl
    ?? readProcessInstanceFingerprintSync;
  const processInstanceFingerprint = readProcessInstanceFingerprintImpl(process.pid);

  while (true) {
    options.signal?.throwIfAborted();
    try {
      createdAtMs = Date.now();
      ownLockRaw = serializeLockOwner({
        createdAtMs,
        updatedAtMs: createdAtMs,
        ownerToken,
        processInstanceFingerprint,
      });
      fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(fd, ownLockRaw, 'utf8');
      } catch (initializationError) {
        cleanupFailedOwnerInitialization(lockPath, fd, initializationError);
        fd = null;
        throw initializationError;
      }
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      ownLockRaw = null;
      const snapshot = readLockOwnerSnapshot(lockPath);
      if (shouldReclaimLockSnapshot(snapshot, staleAfterMs, Date.now(), options)) {
        reclaimLockSnapshot(lockPath, snapshot.raw);
        continue;
      }
      if (timeoutMs !== null && Date.now() - startedAt > timeoutMs) {
        const errorLabel = options.errorLabel ?? 'workspace bundle lock';
        throw createWorkspaceBundleLockTimeoutError({ errorLabel, lockPath, snapshot });
      }
      waited = true;
      notifyWaiter(options, lockPath, snapshot, startedAt, staleAfterMs, timeoutMs);
      options.signal?.throwIfAborted();
      try {
        await sleep(pollIntervalMs, undefined, { signal: options.signal });
      } catch (error) {
        options.signal?.throwIfAborted();
        throw error;
      }
    }
  }

  try {
    if (staleAfterMs > 0) {
      heartbeat = setInterval(() => {
        try {
          if (readLockOwnerSnapshot(lockPath).raw !== ownLockRaw) return;
          ownLockRaw = serializeLockOwner({
            createdAtMs,
            updatedAtMs: Date.now(),
            ownerToken,
            processInstanceFingerprint,
          });
          writeFileSync(lockPath, ownLockRaw, 'utf8');
        } catch {}
      }, Math.max(250, Math.min(5_000, Math.floor(staleAfterMs / 4) || 250)));
      heartbeat.unref();
    }

    return await fn({
      waited,
      lockPath,
      heldLockValue: createWorkspaceLockLeaseValue({ lockPath, ownerToken }),
      inherited: false,
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    try {
      if (fd !== null) closeSync(fd);
    } catch {}
    try {
      if (readLockOwnerSnapshot(lockPath).raw === ownLockRaw) unlinkSync(lockPath);
    } catch {}
  }
}

export function withWorkspaceBundleLockSync(fn, options = {}) {
  const lockPath = String(options.lockPath ?? '').trim();
  if (!lockPath) throw new Error('Missing workspace bundle lock path');

  const inheritedValue = resolveHeldLockValue(options);
  if (callerHoldsWorkspaceBundleLock(lockPath, inheritedValue)) {
    return fn({ waited: false, lockPath, heldLockValue: inheritedValue, inherited: true });
  }

  mkdirSync(dirname(lockPath), { recursive: true });
  const timeoutMs = options.timeoutMs ?? 240_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const staleAfterMs = options.staleAfterMs ?? timeoutMs;
  const startedAt = Date.now();
  const ownerToken = randomUUID();
  const createdAtMs = Date.now();
  let ownLockRaw = null;
  let fd = null;
  let waited = false;
  const readProcessInstanceFingerprintImpl = options.readProcessInstanceFingerprintImpl
    ?? readProcessInstanceFingerprintSync;
  const processInstanceFingerprint = readProcessInstanceFingerprintImpl(process.pid);

  while (true) {
    try {
      ownLockRaw = serializeLockOwner({
        createdAtMs,
        updatedAtMs: Date.now(),
        ownerToken,
        processInstanceFingerprint,
      });
      fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(fd, ownLockRaw, 'utf8');
      } catch (initializationError) {
        cleanupFailedOwnerInitialization(lockPath, fd, initializationError);
        fd = null;
        throw initializationError;
      }
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      ownLockRaw = null;
      const snapshot = readLockOwnerSnapshot(lockPath);
      if (shouldReclaimLockSnapshot(snapshot, staleAfterMs, Date.now(), options)) {
        reclaimLockSnapshot(lockPath, snapshot.raw);
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        const errorLabel = options.errorLabel ?? 'workspace bundle lock';
        throw createWorkspaceBundleLockTimeoutError({ errorLabel, lockPath, snapshot });
      }
      waited = true;
      notifyWaiter(options, lockPath, snapshot, startedAt, staleAfterMs, timeoutMs);
      sleepSync(pollIntervalMs);
    }
  }

  try {
    return fn({
      waited,
      lockPath,
      heldLockValue: createWorkspaceLockLeaseValue({ lockPath, ownerToken }),
      inherited: false,
    });
  } finally {
    try {
      if (fd !== null) closeSync(fd);
    } catch {}
    try {
      if (readLockOwnerSnapshot(lockPath).raw === ownLockRaw) unlinkSync(lockPath);
    } catch {}
  }
}
