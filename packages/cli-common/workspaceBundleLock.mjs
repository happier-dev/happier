import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  fchmodSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  createWorkspaceLockLeaseValue,
  workspaceLockLeaseMatchesOwner,
} from './workspaceLockLease.mjs';
import { readProcessInstanceFingerprintSync } from './processInstance.mjs';

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
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { exists: true, readable: false, mtimeMs: 0, raw: null, owner: null };
    }
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

function readWorkspaceLockProcessInstanceFingerprint(pid, expectedFingerprint, options = {}) {
  if (typeof options.readProcessInstanceFingerprintSyncImpl === 'function') {
    return options.readProcessInstanceFingerprintSyncImpl(pid, expectedFingerprint);
  }
  return readProcessInstanceFingerprintSync(pid, {
    windowsCreationDateFormat: 'iso',
    expectedFingerprint,
  });
}

function shouldReclaimLockSnapshot(snapshot, staleAfterMs, nowMs, options = {}) {
  if (!snapshot.exists) return true;
  if (!snapshot.readable) return false;
  const ownerPid = Number(snapshot.owner?.pid);
  if (Number.isFinite(ownerPid) && ownerPid > 0) {
    if (!(options.isRunningPidImpl ?? isRunningPid)(ownerPid)) return true;
    const expectedFingerprint = String(snapshot.owner?.processInstanceFingerprint ?? '').trim();
    if (!expectedFingerprint) return false;
    const observedFingerprint = readWorkspaceLockProcessInstanceFingerprint(
      ownerPid,
      expectedFingerprint,
      options,
    );
    if (!observedFingerprint) return false;
    return observedFingerprint !== expectedFingerprint;
  }
  const updatedAtMs = Number(
    snapshot.owner?.updatedAtMs
      ?? snapshot.owner?.createdAtMs
      ?? snapshot.mtimeMs
      ?? 0,
  );
  const initializationGraceMs = Math.max(
    0,
    Number(options.initializationGraceMs ?? Math.min(5_000, staleAfterMs)) || 0,
  );
  return updatedAtMs > 0 && nowMs - updatedAtMs > initializationGraceMs;
}

export function isWorkspaceBundleLockActive(lockPath, options = {}) {
  return observeWorkspaceBundleLock(lockPath, options).active;
}

export function observeWorkspaceBundleLock(lockPath, options = {}) {
  const snapshot = readLockOwnerSnapshot(lockPath);
  const active = snapshot.exists && !shouldReclaimLockSnapshot(
    snapshot,
    options.staleAfterMs ?? 240_000,
    options.nowMs ?? Date.now(),
    options,
  );
  const stableOwnerIdentity = !active
    ? null
    : JSON.stringify([
      Number(snapshot.owner?.pid) || null,
      String(snapshot.owner?.token ?? '').trim() || null,
      String(snapshot.owner?.processInstanceFingerprint ?? '').trim() || null,
      Number(snapshot.owner?.createdAtMs) || null,
    ]);
  const ownerId = stableOwnerIdentity
    ? createHash('sha256').update(stableOwnerIdentity).digest('hex')
    : null;
  return { active, ownerId };
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
    restoreQuarantinedLockSnapshot(lockPath, reclaimPath);
    return false;
  }

  if (movedRaw === expectedRaw) {
    try {
      unlinkSync(reclaimPath);
    } catch {}
    return true;
  }

  restoreQuarantinedLockSnapshot(lockPath, reclaimPath);
  return false;
}

function restoreQuarantinedLockSnapshot(lockPath, reclaimPath) {
  for (const restore of [
    () => linkSync(reclaimPath, lockPath),
    () => copyFileSync(reclaimPath, lockPath, fsConstants.COPYFILE_EXCL),
  ]) {
    try {
      restore();
      try {
        unlinkSync(reclaimPath);
      } catch {}
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return true;
    }
  }
  return false;
}

function classifyRetainedLockSnapshots(
  lockPath,
  {
    staleAfterMs,
    initializationGraceMs,
    options,
  },
) {
  const prefix = `${basename(lockPath)}.reclaim-`;
  const retainedPaths = [];
  for (const name of readdirSync(dirname(lockPath)).filter((entry) => entry.startsWith(prefix))) {
    const retainedPath = join(dirname(lockPath), name);
    const snapshot = readLockOwnerSnapshot(retainedPath);
    if (!snapshot.exists) continue;
    if (shouldReclaimLockSnapshot(snapshot, staleAfterMs, Date.now(), {
      initializationGraceMs,
      isRunningPidImpl: options.isRunningPidImpl,
      readProcessInstanceFingerprintSyncImpl: options.readProcessInstanceFingerprintSyncImpl,
    })) {
      const retired = reclaimLockSnapshot(retainedPath, snapshot.raw);
      if (!retired) {
        throw new Error(`Workspace bundle lock recovery cleanup failed: ${lockPath}`);
      }
      continue;
    }
    retainedPaths.push(retainedPath);
  }
  return retainedPaths;
}

function recoverRetainedLockSnapshot(lockPath, classificationOptions) {
  const retainedPaths = classifyRetainedLockSnapshots(lockPath, classificationOptions);
  if (retainedPaths.length === 0) return false;
  if (retainedPaths.length > 1) {
    throw new Error(`Workspace bundle lock recovery is ambiguous: ${lockPath}`);
  }
  const restored = restoreQuarantinedLockSnapshot(
    lockPath,
    retainedPaths[0],
  );
  if (!restored) {
    throw new Error(`Workspace bundle lock recovery is pending: ${lockPath}`);
  }
  return true;
}

function serializeLockOwner({ createdAtMs, updatedAtMs, ownerToken, processInstanceFingerprint }) {
  return JSON.stringify({
    pid: process.pid,
    createdAtMs,
    updatedAtMs,
    token: ownerToken,
    processInstanceFingerprint: processInstanceFingerprint ?? null,
  });
}

function resolvePriorityClaimPath(lockPath) {
  return `${lockPath}.priority-claim`;
}

function ownerSnapshotMatchesCurrentProcess(snapshot, { ownerToken, processInstanceFingerprint }) {
  return snapshot.exists
    && snapshot.readable
    && Number(snapshot.owner?.pid) === process.pid
    && String(snapshot.owner?.token ?? '') === ownerToken
    && String(snapshot.owner?.processInstanceFingerprint ?? '') === String(processInstanceFingerprint ?? '');
}

function readWindowsEnvironmentValue(env, name) {
  const direct = env[name];
  if (typeof direct === 'string') return direct;

  const loweredName = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === loweredName && typeof value === 'string') return value;
  }
  return null;
}

function protectLockFile(lockPath, fd, options = {}) {
  if (typeof options.protectLockFileImpl === 'function') {
    options.protectLockFileImpl(lockPath, fd);
    return;
  }
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    (options.fchmodSyncImpl ?? fchmodSync)(fd, 0o600);
    return;
  }

  const env = options.env ?? process.env;
  const username = String(readWindowsEnvironmentValue(env, 'USERNAME') ?? '').trim();
  if (!username) {
    throw new Error(`Cannot protect workspace bundle lock without a Windows user identity: ${lockPath}`);
  }
  const systemRoot = String(readWindowsEnvironmentValue(env, 'SystemRoot') ?? '').trim();
  const windowsRoot = systemRoot || String(readWindowsEnvironmentValue(env, 'WINDIR') ?? '').trim();
  if (!windowsRoot || !win32.isAbsolute(windowsRoot)) {
    throw new Error(`Cannot protect workspace bundle lock without an absolute Windows system root: ${lockPath}`);
  }
  const icaclsPath = win32.join(windowsRoot, 'System32', 'icacls.exe');
  const result = (options.spawnSyncImpl ?? spawnSync)(
    icaclsPath,
    [lockPath, '/inheritance:r', '/grant:r', `${username}:(F)`],
    { encoding: 'utf8', windowsHide: true, shell: false },
  );
  if (result?.error || result?.signal || result?.status !== 0) {
    const detail = String(result?.stderr ?? result?.stdout ?? result?.error?.message ?? '').trim();
    throw new Error(`Failed to protect workspace bundle lock: ${lockPath}${detail ? ` (${detail})` : ''}`);
  }
}

function tryAcquirePriorityClaim({
  claimPath,
  ownerToken,
  processInstanceFingerprint,
  staleAfterMs,
  initializationGraceMs,
  options,
}) {
  let claimRaw = null;
  let fd = null;
  try {
    const nowMs = Date.now();
    claimRaw = serializeLockOwner({
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      ownerToken,
      processInstanceFingerprint,
    });
    fd = openSync(claimPath, 'wx', 0o600);
    try {
      protectLockFile(claimPath, fd, options);
      writeFileSync(fd, claimRaw, 'utf8');
    } catch (initializationError) {
      cleanupFailedOwnerInitialization(claimPath, fd, initializationError);
      fd = null;
      throw initializationError;
    }
    try {
      closeSync(fd);
      fd = null;
    } catch (closeError) {
      cleanupFailedOwnerInitialization(claimPath, fd, closeError);
      fd = null;
      throw closeError;
    }
    return { acquired: true, raw: claimRaw };
  } catch (error) {
    try {
      if (fd !== null) closeSync(fd);
    } catch {}
    if (error?.code !== 'EEXIST') throw error;
    const snapshot = readLockOwnerSnapshot(claimPath);
    if (ownerSnapshotMatchesCurrentProcess(snapshot, { ownerToken, processInstanceFingerprint })) {
      return { acquired: true, raw: snapshot.raw };
    }
    if (shouldReclaimLockSnapshot(snapshot, staleAfterMs, Date.now(), {
      initializationGraceMs,
      readProcessInstanceFingerprintSyncImpl: options.readProcessInstanceFingerprintSyncImpl,
    })) {
      const reclaimed = reclaimLockSnapshot(claimPath, snapshot.raw);
      return { acquired: false, raw: null, retry: reclaimed };
    }
    return { acquired: false, raw: null, retry: false, snapshot };
  }
}

function refreshPriorityClaim({
  claimPath,
  claimRaw,
  ownerToken,
  processInstanceFingerprint,
}) {
  const snapshot = readLockOwnerSnapshot(claimPath);
  if (snapshot.raw !== claimRaw || !ownerSnapshotMatchesCurrentProcess(snapshot, {
    ownerToken,
    processInstanceFingerprint,
  })) {
    return null;
  }
  const nextRaw = serializeLockOwner({
    createdAtMs: Number(snapshot.owner.createdAtMs) || Date.now(),
    updatedAtMs: Date.now(),
    ownerToken,
    processInstanceFingerprint,
  });
  writeFileSync(claimPath, nextRaw, 'utf8');
  return nextRaw;
}

function clearPriorityClaimIfOwned(claimPath, claimRaw) {
  if (claimRaw == null) return true;
  try {
    if (readLockOwnerSnapshot(claimPath).raw !== claimRaw) return true;
    if (reclaimLockSnapshot(claimPath, claimRaw)) return true;
    return readLockOwnerSnapshot(claimPath).raw !== claimRaw;
  } catch {
    return false;
  }
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
  const timeoutMs = options.timeoutMs ?? 240_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const staleAfterMs = options.staleAfterMs ?? timeoutMs;
  const initializationGraceMs = options.initializationGraceMs ?? Math.min(5_000, staleAfterMs);
  const startedAt = Date.now();
  const ownerToken = randomUUID();
  const processInstanceFingerprint = readWorkspaceLockProcessInstanceFingerprint(
    process.pid,
    null,
    options,
  );
  const claimPath = resolvePriorityClaimPath(lockPath);
  let createdAtMs = 0;
  let ownLockRaw = null;
  let ownClaimRaw = null;
  let fd = null;
  let heartbeat = null;
  let waited = false;

  try {
    while (true) {
      if (ownClaimRaw !== null) {
        ownClaimRaw = refreshPriorityClaim({
          claimPath,
          claimRaw: ownClaimRaw,
          ownerToken,
          processInstanceFingerprint,
        });
      }

      if (ownClaimRaw === null) {
        const lockSnapshot = readLockOwnerSnapshot(lockPath);
        const claimSnapshot = readLockOwnerSnapshot(claimPath);
        if (claimSnapshot.exists && shouldReclaimLockSnapshot(claimSnapshot, staleAfterMs, Date.now(), {
          initializationGraceMs,
          readProcessInstanceFingerprintSyncImpl: options.readProcessInstanceFingerprintSyncImpl,
        })) {
          if (reclaimLockSnapshot(claimPath, claimSnapshot.raw)) continue;
        }
        if (
          claimSnapshot.exists
          && lockSnapshot.exists
          && !shouldReclaimLockSnapshot(lockSnapshot, staleAfterMs, Date.now(), {
            initializationGraceMs,
            readProcessInstanceFingerprintSyncImpl: options.readProcessInstanceFingerprintSyncImpl,
          })
        ) {
          if (Date.now() - startedAt > timeoutMs) {
            const errorLabel = options.errorLabel ?? 'workspace bundle lock';
            throw createWorkspaceBundleLockTimeoutError({
              errorLabel,
              lockPath,
              snapshot: lockSnapshot,
            });
          }
          waited = true;
          notifyWaiter(options, lockPath, lockSnapshot, startedAt, staleAfterMs, timeoutMs);
          await sleep(Math.max(pollIntervalMs, 25));
          continue;
        }
      }

      if (!readLockOwnerSnapshot(lockPath).exists && recoverRetainedLockSnapshot(lockPath, {
        staleAfterMs,
        initializationGraceMs,
        options,
      })) {
        continue;
      }

      try {
        createdAtMs = Date.now();
        ownLockRaw = serializeLockOwner({
          createdAtMs,
          updatedAtMs: createdAtMs,
          ownerToken,
          processInstanceFingerprint,
        });
        fd = openSync(lockPath, 'wx', 0o600);
        try {
          protectLockFile(lockPath, fd, options);
          writeFileSync(fd, ownLockRaw, 'utf8');
        } catch (initializationError) {
          cleanupFailedOwnerInitialization(lockPath, fd, initializationError);
          fd = null;
          throw initializationError;
        }
        let retainedPaths;
        try {
          retainedPaths = classifyRetainedLockSnapshots(lockPath, {
            staleAfterMs,
            initializationGraceMs,
            options,
          });
        } catch (revalidationError) {
          closeSync(fd);
          fd = null;
          if (!reclaimLockSnapshot(lockPath, ownLockRaw)) {
            throw new Error(`Failed to safely revalidate workspace bundle lock: ${lockPath}`);
          }
          ownLockRaw = null;
          throw revalidationError;
        }
        if (retainedPaths.length > 0) {
          closeSync(fd);
          fd = null;
          if (!reclaimLockSnapshot(lockPath, ownLockRaw)) {
            throw new Error(`Failed to safely reclaim workspace bundle lock: ${lockPath}`);
          }
          ownLockRaw = null;
          recoverRetainedLockSnapshot(lockPath, {
            staleAfterMs,
            initializationGraceMs,
            options,
          });
          continue;
        }
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        ownLockRaw = null;
        let snapshot = readLockOwnerSnapshot(lockPath);
        if (shouldReclaimLockSnapshot(snapshot, staleAfterMs, Date.now(), {
          initializationGraceMs,
          readProcessInstanceFingerprintSyncImpl: options.readProcessInstanceFingerprintSyncImpl,
        })) {
          if (reclaimLockSnapshot(lockPath, snapshot.raw)) continue;
          snapshot = readLockOwnerSnapshot(lockPath);
          if (!snapshot.exists) {
            throw new Error(`Failed to safely reclaim workspace bundle lock: ${lockPath}`);
          }
        }
        if (ownClaimRaw === null) {
          const claim = tryAcquirePriorityClaim({
            claimPath,
            ownerToken,
            processInstanceFingerprint,
            staleAfterMs,
            initializationGraceMs,
            options,
          });
          if (claim.acquired) ownClaimRaw = claim.raw;
          if (claim.retry) continue;
        }
        if (Date.now() - startedAt > timeoutMs) {
          const errorLabel = options.errorLabel ?? 'workspace bundle lock';
          throw createWorkspaceBundleLockTimeoutError({ errorLabel, lockPath, snapshot });
        }
        waited = true;
        notifyWaiter(options, lockPath, snapshot, startedAt, staleAfterMs, timeoutMs);
        await sleep(ownClaimRaw !== null ? Math.min(pollIntervalMs, 5) : pollIntervalMs);
      }
    }
  } catch (error) {
    clearPriorityClaimIfOwned(claimPath, ownClaimRaw);
    throw error;
  }

  try {
    if (!clearPriorityClaimIfOwned(claimPath, ownClaimRaw)) {
      throw new Error(`Failed to clear acquired workspace bundle lock priority claim: ${claimPath}`);
    }
    ownClaimRaw = null;
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
    clearPriorityClaimIfOwned(claimPath, ownClaimRaw);
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
  const initializationGraceMs = options.initializationGraceMs ?? Math.min(5_000, staleAfterMs);
  const startedAt = Date.now();
  const ownerToken = randomUUID();
  const processInstanceFingerprint = readWorkspaceLockProcessInstanceFingerprint(
    process.pid,
    null,
    options,
  );
  const claimPath = resolvePriorityClaimPath(lockPath);
  const createdAtMs = Date.now();
  let ownLockRaw = null;
  let ownClaimRaw = null;
  let fd = null;
  let waited = false;

  try {
    while (true) {
      if (ownClaimRaw !== null) {
        ownClaimRaw = refreshPriorityClaim({
          claimPath,
          claimRaw: ownClaimRaw,
          ownerToken,
          processInstanceFingerprint,
        });
      }

      if (ownClaimRaw === null) {
        const lockSnapshot = readLockOwnerSnapshot(lockPath);
        const claimSnapshot = readLockOwnerSnapshot(claimPath);
        if (claimSnapshot.exists && shouldReclaimLockSnapshot(claimSnapshot, staleAfterMs, Date.now(), {
          initializationGraceMs,
          readProcessInstanceFingerprintSyncImpl: options.readProcessInstanceFingerprintSyncImpl,
        })) {
          if (reclaimLockSnapshot(claimPath, claimSnapshot.raw)) continue;
        }
        if (
          claimSnapshot.exists
          && lockSnapshot.exists
          && !shouldReclaimLockSnapshot(lockSnapshot, staleAfterMs, Date.now(), {
            initializationGraceMs,
            readProcessInstanceFingerprintSyncImpl: options.readProcessInstanceFingerprintSyncImpl,
          })
        ) {
          if (Date.now() - startedAt > timeoutMs) {
            const errorLabel = options.errorLabel ?? 'workspace bundle lock';
            throw createWorkspaceBundleLockTimeoutError({
              errorLabel,
              lockPath,
              snapshot: lockSnapshot,
            });
          }
          waited = true;
          notifyWaiter(options, lockPath, lockSnapshot, startedAt, staleAfterMs, timeoutMs);
          sleepSync(Math.max(pollIntervalMs, 25));
          continue;
        }
      }

      if (!readLockOwnerSnapshot(lockPath).exists && recoverRetainedLockSnapshot(lockPath, {
        staleAfterMs,
        initializationGraceMs,
        options,
      })) {
        continue;
      }

      try {
        ownLockRaw = serializeLockOwner({
          createdAtMs,
          updatedAtMs: Date.now(),
          ownerToken,
          processInstanceFingerprint,
        });
        fd = openSync(lockPath, 'wx', 0o600);
        try {
          protectLockFile(lockPath, fd, options);
          writeFileSync(fd, ownLockRaw, 'utf8');
        } catch (initializationError) {
          cleanupFailedOwnerInitialization(lockPath, fd, initializationError);
          fd = null;
          throw initializationError;
        }
        let retainedPaths;
        try {
          retainedPaths = classifyRetainedLockSnapshots(lockPath, {
            staleAfterMs,
            initializationGraceMs,
            options,
          });
        } catch (revalidationError) {
          closeSync(fd);
          fd = null;
          if (!reclaimLockSnapshot(lockPath, ownLockRaw)) {
            throw new Error(`Failed to safely revalidate workspace bundle lock: ${lockPath}`);
          }
          ownLockRaw = null;
          throw revalidationError;
        }
        if (retainedPaths.length > 0) {
          closeSync(fd);
          fd = null;
          if (!reclaimLockSnapshot(lockPath, ownLockRaw)) {
            throw new Error(`Failed to safely reclaim workspace bundle lock: ${lockPath}`);
          }
          ownLockRaw = null;
          recoverRetainedLockSnapshot(lockPath, {
            staleAfterMs,
            initializationGraceMs,
            options,
          });
          continue;
        }
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        ownLockRaw = null;
        let snapshot = readLockOwnerSnapshot(lockPath);
        if (shouldReclaimLockSnapshot(snapshot, staleAfterMs, Date.now(), {
          initializationGraceMs,
          readProcessInstanceFingerprintSyncImpl: options.readProcessInstanceFingerprintSyncImpl,
        })) {
          if (reclaimLockSnapshot(lockPath, snapshot.raw)) continue;
          snapshot = readLockOwnerSnapshot(lockPath);
          if (!snapshot.exists) {
            throw new Error(`Failed to safely reclaim workspace bundle lock: ${lockPath}`);
          }
        }
        if (ownClaimRaw === null) {
          const claim = tryAcquirePriorityClaim({
            claimPath,
            ownerToken,
            processInstanceFingerprint,
            staleAfterMs,
            initializationGraceMs,
            options,
          });
          if (claim.acquired) ownClaimRaw = claim.raw;
          if (claim.retry) continue;
        }
        if (Date.now() - startedAt > timeoutMs) {
          const errorLabel = options.errorLabel ?? 'workspace bundle lock';
          throw createWorkspaceBundleLockTimeoutError({ errorLabel, lockPath, snapshot });
        }
        waited = true;
        notifyWaiter(options, lockPath, snapshot, startedAt, staleAfterMs, timeoutMs);
        sleepSync(ownClaimRaw !== null ? Math.min(pollIntervalMs, 5) : pollIntervalMs);
      }
    }
  } catch (error) {
    clearPriorityClaimIfOwned(claimPath, ownClaimRaw);
    throw error;
  }

  try {
    if (!clearPriorityClaimIfOwned(claimPath, ownClaimRaw)) {
      throw new Error(`Failed to clear acquired workspace bundle lock priority claim: ${claimPath}`);
    }
    ownClaimRaw = null;
    return fn({
      waited,
      lockPath,
      heldLockValue: createWorkspaceLockLeaseValue({ lockPath, ownerToken }),
      inherited: false,
    });
  } finally {
    clearPriorityClaimIfOwned(claimPath, ownClaimRaw);
    try {
      if (fd !== null) closeSync(fd);
    } catch {}
    try {
      if (readLockOwnerSnapshot(lockPath).raw === ownLockRaw) unlinkSync(lockPath);
    } catch {}
  }
}
