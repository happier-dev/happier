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
  writeSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { createFileChangeObserver, DEFAULT_FILE_CHANGE_CATCH_UP_MS } from './fileChangeObserver.mjs';
import { createWorkspaceBundleLockPriorityOwner } from './workspaceBundleLockPriority.mjs';

import {
  createWorkspaceLockLeaseValue,
  workspaceLockLeaseMatchesOwner,
} from './workspaceLockLease.mjs';
import {
  observeProcessLivenessSync,
  readProcessHostIdentitySync,
  readProcessInstanceFingerprintSync,
} from './processInstance.mjs';

export const WORKSPACE_BUNDLE_LOCK_TIMEOUT_ERROR_CODE = 'EWORKSPACEBUNDLELOCKTIMEOUT';
export const WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE = 'EWORKSPACEBUNDLELOCKBUSY';
export const WORKSPACE_BUNDLE_LOCK_OWNERSHIP_LOST_ERROR_CODE = 'EWORKSPACEBUNDLELOCKOWNERSHIPLOST';
export const DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS = 30 * 60_000;

let cachedProcessHostIdentity;

function readCurrentProcessHostIdentity(options = {}) {
  if (typeof options.readProcessHostIdentityImpl === 'function') {
    return options.readProcessHostIdentityImpl();
  }
  if (cachedProcessHostIdentity === undefined) {
    cachedProcessHostIdentity = readProcessHostIdentitySync();
  }
  return cachedProcessHostIdentity;
}

function lockOwnerObservationOptions(options, initializationGraceMs) {
  return {
    initializationGraceMs,
    priorityClaimStaleAfterMs: options.priorityClaimStaleAfterMs,
    isRunningPidImpl: options.isRunningPidImpl,
    readProcessInstanceFingerprintSyncImpl: options.readProcessInstanceFingerprintSyncImpl,
    readProcessHostIdentityImpl: options.readProcessHostIdentityImpl,
  };
}

function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

const WORKSPACE_LOCK_HEARTBEAT_WORKER_SOURCE = `
const { closeSync, openSync, readFileSync, writeSync } = require('node:fs');
const { workerData } = require('node:worker_threads');

function refresh() {
  let fd = null;
  try {
    fd = openSync(workerData.lockPath, 'r+');
    const raw = readFileSync(fd, 'utf8');
    const owner = JSON.parse(raw);
    if (
      Number(owner?.pid) !== workerData.pid
      || String(owner?.token ?? '') !== workerData.ownerToken
      || String(owner?.processInstanceFingerprint ?? '') !== workerData.processInstanceFingerprint
    ) return;
    const timestampMatch = /"updatedAtMs":(\\d+)/.exec(raw);
    const nextTimestamp = String(Date.now());
    if (!timestampMatch || timestampMatch[1].length !== nextTimestamp.length) return;
    const timestampOffset = Buffer.byteLength(
      raw.slice(0, timestampMatch.index + timestampMatch[0].length - timestampMatch[1].length),
      'utf8',
    );
    // Update only the authenticated owner's fixed-width timestamp through the opened inode. If a
    // contender renames this lock and installs a successor, this descriptor remains attached to the
    // retired inode and cannot overwrite the successor's identity.
    writeSync(fd, nextTimestamp, timestampOffset, 'utf8');
  } catch {
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
}

refresh();
setInterval(refresh, workerData.intervalMs);
`;

function startWorkspaceLockHeartbeat({
  lockPath,
  ownerToken,
  processInstanceFingerprint,
  staleAfterMs,
}) {
  if (!(staleAfterMs > 0)) return null;
  try {
    const worker = new Worker(WORKSPACE_LOCK_HEARTBEAT_WORKER_SOURCE, {
      eval: true,
      execArgv: process.execArgv.filter((arg) => !String(arg).startsWith('--input-type')),
      workerData: {
        lockPath,
        pid: process.pid,
        ownerToken,
        processInstanceFingerprint: String(processInstanceFingerprint ?? ''),
        intervalMs: Math.max(10, Math.min(5_000, Math.floor(staleAfterMs / 4) || 10)),
      },
    });
    worker.on('error', () => {});
    worker.unref();
    return worker;
  } catch {
    return null;
  }
}

function stopWorkspaceLockHeartbeat(worker) {
  if (!worker) return;
  void worker.terminate().catch(() => {});
}

function refreshWorkspaceLockHeartbeat({
  lockPath,
  ownerToken,
  processInstanceFingerprint,
}, options = {}) {
  let fd = null;
  try {
    fd = openSync(lockPath, 'r+');
    const raw = readFileSync(fd, 'utf8');
    const owner = parseLockOwner(raw);
    if (
      Number(owner?.pid) !== process.pid
      || String(owner?.token ?? '') !== ownerToken
      || String(owner?.processInstanceFingerprint ?? '') !== String(processInstanceFingerprint ?? '')
    ) return;
    const timestampMatch = /"updatedAtMs":(\d+)/.exec(raw);
    const nextTimestamp = String(Date.now());
    if (!timestampMatch || timestampMatch[1].length !== nextTimestamp.length) return;
    const timestampOffset = Buffer.byteLength(
      raw.slice(0, timestampMatch.index + timestampMatch[0].length - timestampMatch[1].length),
      'utf8',
    );
    options.beforeWorkspaceLockHeartbeatWriteImpl?.({ lockPath });
    // The descriptor remains attached to the admitted owner inode if a
    // contender replaces the lock path between authentication and this write.
    writeSync(fd, nextTimestamp, timestampOffset, 'utf8');
  } catch {
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
}

function lockSnapshotUnchanged(left, right) {
  return Boolean(left?.exists) === Boolean(right?.exists)
    && Boolean(left?.readable) === Boolean(right?.readable)
    && left?.raw === right?.raw;
}

async function waitForWorkspaceBundleLockChange({
  lockPath,
  claimPath,
  lockSnapshot,
  claimSnapshot,
  maxWaitMs,
  signal,
  observer,
  prioritySnapshot,
  priorityOptions,
}) {
  const key = snapshot => [Boolean(snapshot?.exists), Boolean(snapshot?.readable), snapshot?.raw];
  await observer.wait({
    snapshot: JSON.stringify([key(lockSnapshot), key(claimSnapshot), prioritySnapshot]),
    readSnapshot: () => JSON.stringify([key(readLockOwnerSnapshot(lockPath)), key(readLockOwnerSnapshot(claimPath)),
      observeWorkspaceBundleLockPriority(lockPath, priorityOptions)]),
    maxWaitMs, signal,
  });
}

function resolveWorkspaceBundleLockWaitMs({
  options,
  snapshot,
  staleAfterMs,
  startedAt,
  timeoutMs,
  initializationGraceMs,
}) {
  const nowMs = Date.now();
  const remainingTimeoutMs = hasFreshAuthenticatedOwnerHeartbeat(snapshot, staleAfterMs, nowMs)
    ? Infinity
    : Math.max(1, timeoutMs - (nowMs - startedAt));
  const configuredFallbackMs = Number(options.watchFallbackMs);
  const fallbackMs = Number.isFinite(configuredFallbackMs) && configuredFallbackMs > 0
    ? configuredFallbackMs
    : DEFAULT_FILE_CHANGE_CATCH_UP_MS;
  const configuredClaimStaleAfterMs = Number(options.priorityClaimStaleAfterMs);
  const claimRecheckMs = Number.isFinite(configuredClaimStaleAfterMs) && configuredClaimStaleAfterMs > 0
    ? configuredClaimStaleAfterMs
    : fallbackMs;
  return Math.max(1, Math.min(
    fallbackMs,
    remainingTimeoutMs,
    Math.max(1, initializationGraceMs),
    claimRecheckMs,
  ));
}

export function resolveWorkspaceBundleLockPath(repoRoot) {
  return resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
}

export function resolveCliSharedDepsBuildLockPath(repoRoot) {
  return resolve(repoRoot, '.project', 'tmp', 'cli-shared-deps.lock');
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
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { exists: false, readable: false, mtimeMs: 0, raw: null, owner: null };
    }
    // An existing owner that cannot be read cannot be authenticated or safely reclaimed. Keep it
    // distinct from ENOENT so callers enter the bounded wait/timeout path instead of spinning.
    return { exists: true, readable: false, mtimeMs: stats.mtimeMs, raw: null, owner: null };
  }
}

function isRunningPid(pid) {
  return observeProcessLivenessSync(pid).status !== 'dead';
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

function hasFreshAuthenticatedOwnerHeartbeat(snapshot, staleAfterMs, nowMs) {
  const ownerPid = Number(snapshot.owner?.pid);
  const ownerToken = String(snapshot.owner?.token ?? '').trim();
  const updatedAtMs = Number(
    snapshot.owner?.updatedAtMs
      ?? snapshot.owner?.createdAtMs
      ?? 0,
  );
  return Number.isInteger(ownerPid)
    && ownerPid > 0
    && ownerToken.length > 0
    && Number.isFinite(updatedAtMs)
    && updatedAtMs > 0
    && nowMs - updatedAtMs <= staleAfterMs;
}

function workspaceBundleLockWaitTimedOut(lockPath, snapshot, staleAfterMs, startedAt, timeoutMs, options, priorityClaim = false) {
  const nowMs = Date.now();
  // Healthy authenticated owners may publish for longer than the contention budget. The existing
  // heartbeat/reclamation policy owns their lifetime. An EEXIST/owner observation can straddle
  // release or initialization, so confirm the same blocker before applying the elapsed bound.
  if (nowMs - startedAt <= timeoutMs || hasFreshAuthenticatedOwnerHeartbeat(snapshot, staleAfterMs, nowMs)) {
    return false;
  }
  const currentSnapshot = readLockOwnerSnapshot(lockPath);
  if (!currentSnapshot.exists || !lockSnapshotUnchanged(snapshot, currentSnapshot)) return false;
  // Partial initialization has no owner to time out. The acquisition loop already waits for
  // initializationGraceMs and reclaims stable malformed bytes after that existing window.
  if (currentSnapshot.readable && currentSnapshot.owner === null) return false;
  const shouldReclaim = priorityClaim ? shouldReclaimPriorityClaimSnapshot : shouldReclaimLockSnapshot;
  return !shouldReclaim(currentSnapshot, staleAfterMs, nowMs, options);
}

function reclaimDecisionFromLocalProcess(snapshot, options = {}) {
  const ownerPid = Number(snapshot.owner?.pid);
  if (!Number.isFinite(ownerPid) || ownerPid <= 0) return null;
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

function shouldReclaimLockSnapshot(snapshot, staleAfterMs, nowMs, options = {}) {
  if (!snapshot.exists) return true;
  if (!snapshot.readable) return false;
  const currentHost = readCurrentProcessHostIdentity(options);
  const ownerMachineId = String(snapshot.owner?.processMachineId ?? '').trim();
  const ownerBootId = String(snapshot.owner?.processBootId ?? '').trim();
  if (
    currentHost?.bootId
    && ownerMachineId === currentHost.machineId
    && ownerBootId
    && ownerBootId !== currentHost.bootId
  ) {
    return true;
  }
  const ownerPidNamespace = String(snapshot.owner?.processPidNamespace ?? '').trim();
  // The owner shares this contender's PID space only when the recorded host identity proves it:
  // Linux also needs the same boot and PID namespace; darwin/win32 have one PID space per host.
  const ownerSharesLocalPidSpace = Boolean(
    currentHost
    && ownerMachineId === currentHost.machineId
    && (
      !currentHost.pidNamespaced
      || (
        ownerBootId === currentHost.bootId
        && currentHost.pidNamespace
        && ownerPidNamespace === currentHost.pidNamespace
      )
    )
  );
  if (ownerSharesLocalPidSpace && currentHost.pidNamespaced) {
    const localProcessDecision = reclaimDecisionFromLocalProcess(snapshot, options);
    if (localProcessDecision !== null) return localProcessDecision;
  } else if (ownerSharesLocalPidSpace) {
    // darwin/win32 incarnation fingerprints can vary with the observer's TZ/locale, so before the
    // lease expires only a provably absent pid is conclusive; a running pid with a different
    // fingerprint waits for the post-expiry local-process decision below.
    const ownerPid = Number(snapshot.owner?.pid);
    if (
      Number.isInteger(ownerPid)
      && ownerPid > 0
      && !(options.isRunningPidImpl ?? isRunningPid)(ownerPid)
    ) {
      return true;
    }
  }
  // Lock files can be shared across machines or PID namespaces. A contender's
  // process lookup cannot disprove a different namespace's fresh, authenticated
  // workspace-visible lease, so consult local PID/incarnation evidence only
  // after that lease has expired.
  if (hasFreshAuthenticatedOwnerHeartbeat(snapshot, staleAfterMs, nowMs)) return false;
  const ownerIsKnownForeignProcess = Boolean(
    currentHost
    && ownerMachineId
    && (
      ownerMachineId !== currentHost.machineId
      || (
        currentHost.pidNamespaced
        && ownerBootId === currentHost.bootId
        && currentHost.pidNamespace
        && ownerPidNamespace
        && ownerPidNamespace !== currentHost.pidNamespace
      )
    )
  );
  // Once a foreign owner stops refreshing its authenticated workspace-visible
  // lease, local PID/incarnation observations say nothing about that owner. In
  // particular, container PID namespaces can legitimately reuse both the PID
  // and Linux boot-relative process start time. Reclaim from the expired lease
  // instead of letting those unrelated local facts pin the lock forever.
  if (ownerIsKnownForeignProcess) return true;
  const localProcessDecision = reclaimDecisionFromLocalProcess(snapshot, options);
  if (localProcessDecision !== null) return localProcessDecision;
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

function shouldReclaimPriorityClaimSnapshot(snapshot, staleAfterMs, nowMs, options = {}) {
  if (snapshot.exists && snapshot.readable) {
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
    const configuredClaimStaleAfterMs = Number(
      options.priorityClaimStaleAfterMs ?? Math.min(staleAfterMs, 30_000),
    );
    const claimStaleAfterMs = Math.max(
      initializationGraceMs,
      Number.isFinite(configuredClaimStaleAfterMs) && configuredClaimStaleAfterMs >= 0
        ? configuredClaimStaleAfterMs
        : Math.min(staleAfterMs, 30_000),
    );
    if (updatedAtMs > 0 && nowMs - updatedAtMs > claimStaleAfterMs) {
      return true;
    }
  }
  return shouldReclaimLockSnapshot(snapshot, staleAfterMs, nowMs, options);
}

export function isWorkspaceBundleLockActive(lockPath, options = {}) {
  return observeWorkspaceBundleLock(lockPath, options).active;
}

export function observeWorkspaceBundleLock(lockPath, options = {}) {
  const snapshot = readLockOwnerSnapshot(lockPath);
  const active = snapshot.exists && !shouldReclaimLockSnapshot(
    snapshot,
    options.staleAfterMs ?? DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
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

function reclaimLockSnapshot(lockPath, expectedRaw, baseLockPath = lockPath) {
  if (expectedRaw == null) return true;
  // Retained snapshots share the base lock's namespace; never grow their names.
  const reclaimPath = `${baseLockPath}.reclaim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(lockPath, reclaimPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
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
    priorityClaim = false,
    releasedOwner,
  },
) {
  const prefix = `${basename(lockPath)}.reclaim-`;
  const retainedPaths = [];
  for (const name of readdirSync(dirname(lockPath)).filter((entry) => entry.startsWith(prefix))) {
    const retainedPath = join(dirname(lockPath), name);
    const snapshot = readLockOwnerSnapshot(retainedPath);
    if (!snapshot.exists) continue;
    const shouldReclaim = priorityClaim ? shouldReclaimPriorityClaimSnapshot : shouldReclaimLockSnapshot;
    if (
      (releasedOwner && ownerSnapshotMatchesCurrentProcess(snapshot, releasedOwner))
      || shouldReclaim(snapshot, staleAfterMs, Date.now(), lockOwnerObservationOptions(options, initializationGraceMs))
    ) {
      const retired = reclaimLockSnapshot(retainedPath, snapshot.raw, lockPath);
      if (!retired) {
        throw new Error(`Workspace bundle lock recovery cleanup failed: ${lockPath}`);
      }
      continue;
    }
    retainedPaths.push(retainedPath);
  }
  return retainedPaths;
}

function authenticatedRetainedOwnerIdentity(snapshot) {
  if (!snapshot.exists || !snapshot.readable) return null;
  const pid = Number(snapshot.owner?.pid);
  const createdAtMs = Number(snapshot.owner?.createdAtMs);
  const token = String(snapshot.owner?.token ?? '').trim();
  const processInstanceFingerprint = String(
    snapshot.owner?.processInstanceFingerprint ?? '',
  ).trim();
  if (
    !Number.isInteger(pid)
    || pid <= 0
    || !Number.isFinite(createdAtMs)
    || createdAtMs <= 0
    || !token
    || !processInstanceFingerprint
  ) return null;
  return JSON.stringify([pid, token, processInstanceFingerprint, createdAtMs]);
}

function recoverRetainedLockSnapshot(lockPath, classificationOptions) {
  const retainedSnapshots = classifyRetainedLockSnapshots(lockPath, classificationOptions)
    .map((retainedPath) => ({
      retainedPath,
      snapshot: readLockOwnerSnapshot(retainedPath),
    }))
    .filter(({ snapshot }) => snapshot.exists);
  if (retainedSnapshots.length === 0) return false;
  if (retainedSnapshots.length > 1) {
    const ownerIdentities = new Set(
      retainedSnapshots.map(({ snapshot }) => authenticatedRetainedOwnerIdentity(snapshot)),
    );
    if (ownerIdentities.size !== 1 || ownerIdentities.has(null)) {
      throw new Error(`Workspace bundle lock recovery is ambiguous: ${lockPath}`);
    }
    retainedSnapshots.sort((left, right) => {
      const updatedAtDifference = Number(right.snapshot.owner?.updatedAtMs ?? 0)
        - Number(left.snapshot.owner?.updatedAtMs ?? 0);
      return updatedAtDifference || left.retainedPath.localeCompare(right.retainedPath);
    });
  }
  const [preferred, ...duplicates] = retainedSnapshots;
  const restored = restoreQuarantinedLockSnapshot(
    lockPath,
    preferred.retainedPath,
  );
  if (!restored) {
    // Another contender may have restored or retired the classified snapshot.
    // Reobserve admission before retiring duplicates: they may be the last live
    // evidence of a claimant when the preferred snapshot disappeared.
    if (!readLockOwnerSnapshot(preferred.retainedPath).exists) return true;
    throw new Error(`Workspace bundle lock recovery is pending: ${lockPath}`);
  }
  for (const duplicate of duplicates) {
    if (!reclaimLockSnapshot(duplicate.retainedPath, duplicate.snapshot.raw, lockPath)) {
      throw new Error(`Workspace bundle lock recovery cleanup failed: ${lockPath}`);
    }
  }
  return true;
}

function serializeLockOwner({ createdAtMs, updatedAtMs, ownerToken, processInstanceFingerprint, priorityScopeId }, options = {}) {
  const host = readCurrentProcessHostIdentity(options);
  return JSON.stringify({
    pid: process.pid,
    createdAtMs,
    updatedAtMs,
    token: ownerToken,
    processInstanceFingerprint: processInstanceFingerprint ?? null,
    ...(priorityScopeId ? { priorityScopeId } : {}),
    ...(host ? {
      processMachineId: host.machineId,
      ...(host.bootId ? { processBootId: host.bootId } : {}),
      ...(host.pidNamespace ? { processPidNamespace: host.pidNamespace } : {}),
    } : {}),
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
    }, options);
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
    if (shouldReclaimPriorityClaimSnapshot(snapshot, staleAfterMs, Date.now(), lockOwnerObservationOptions(options, initializationGraceMs))) {
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
}, options = {}) {
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
  }, options);
  writeFileSync(claimPath, nextRaw, 'utf8');
  return nextRaw;
}

function clearPriorityClaimIfOwned(claimPath, claimRaw) {
  if (claimRaw == null) return true;
  if (readLockOwnerSnapshot(claimPath).raw !== claimRaw) return true;
  if (reclaimLockSnapshot(claimPath, claimRaw)) return true;
  return readLockOwnerSnapshot(claimPath).raw !== claimRaw;
}

export function callerHoldsWorkspaceBundleLock(lockPath, heldLockValue) {
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

function createWorkspaceBundleLockOwnershipLostError(lockPath) {
  const error = new Error(`Lost workspace bundle lock ownership: ${lockPath}`);
  error.code = WORKSPACE_BUNDLE_LOCK_OWNERSHIP_LOST_ERROR_CODE;
  return error;
}

function assertWorkspaceLockMayWait(options, lockPath, snapshot) {
  // Native admission alone marks charged payloads. This restriction cannot
  // admit a process or transfer a lease; even an explicit wait:true must not
  // let a lock-only consumer wait while its ancestor's envelope is charged.
  const admitted = options.env?.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED === '0'
    || process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED === '0';
  if (options.wait !== false && !admitted) return;
  const error = new Error(`${admitted ? 'HSTACK_WORKSPACE_ADMISSION_ORDER: ' : ''}Workspace publication lease is busy: ${lockPath} (${describeLockOwner(snapshot, Date.now())})`);
  error.code = WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE;
  throw error;
}

function resolveHeldLockValues(options) {
  const env = options.env ?? process.env;
  const primary = String(options.heldLockValue ?? options.heldLockPath
    ?? env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD ?? '').trim();
  // Joint build admission may own both publication and package leases. Each
  // remains an ordinary token-authenticated lease of the existing lock owner;
  // the outermost legacy value cannot represent both exact paths.
  let leases;
  try { leases = JSON.parse(env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES ?? '[]'); }
  catch { return [primary]; }
  return [primary, ...(Array.isArray(leases) ? leases.filter(lease => typeof lease === 'string') : [])];
}

function resolveHeldLockValue(options) {
  const values = resolveHeldLockValues(options);
  return values.find(value => callerHoldsWorkspaceBundleLock(options.lockPath, value)) ?? values[0];
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

const workspaceBundlePriority = createWorkspaceBundleLockPriorityOwner({
  read: readLockOwnerSnapshot,
  protect: protectLockFile,
  remove: reclaimLockSnapshot,
  sameOwner: (left, right, path) => {
    if (!String(left.owner?.token ?? '').trim()) return false;
    return workspaceLockLeaseMatchesOwner({ lockPath: path, owner: right.owner,
      leaseValue: createWorkspaceLockLeaseValue({ lockPath: path, ownerToken: left.owner.token }) });
  },
  owner: ({ createdAtMs }, options) => JSON.parse(serializeLockOwner({
    createdAtMs, updatedAtMs: Date.now(), ownerToken: randomUUID(),
    processInstanceFingerprint: options.priorityProcessFingerprint,
  }, options)),
  reclaimable: (snapshot, options) => shouldReclaimLockSnapshot(snapshot,
    options.staleAfterMs ?? DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS, Date.now(),
    lockOwnerObservationOptions(options, options.initializationGraceMs ?? 5_000)),
  recover: (path, options) => {
    try {
      return recoverRetainedLockSnapshot(path, {
        staleAfterMs: options.staleAfterMs ?? DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
        initializationGraceMs: options.initializationGraceMs ?? 5_000, options,
      });
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  },
  clear: (path, raw, owner, options) => {
    while (true) {
      if (!clearPriorityClaimIfOwned(path, raw)) return false;
      try {
        if (classifyRetainedLockSnapshots(path, {
          staleAfterMs: options.staleAfterMs ?? DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
          initializationGraceMs: options.initializationGraceMs ?? 5_000, options,
          releasedOwner: { ownerToken: owner.token, processInstanceFingerprint: owner.processInstanceFingerprint },
        }).length > 0) return false;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const current = readLockOwnerSnapshot(path);
      if (!current.exists) return true;
      // A peer can link the compared quarantine back before its unlink. The
      // bytes have not changed owners; finish withdrawing that restored record
      // before allowing the caller to retire any resource index.
      if (!current.readable || current.raw !== raw) return false;
    }
  },
  holdsPublication: (path, options) => resolveHeldLockValues(options)
    .some(value => callerHoldsWorkspaceBundleLock(path, value)),
});

function createPriorityScope(options, fingerprint) {
  return workspaceBundlePriority.create({ ...options, priorityProcessFingerprint: fingerprint });
}

/** Continuous preference only; actual publication exclusion remains this owner.
 * Dependency declarations are opaque here and authenticated by their producer. */
export function createWorkspaceBundleLockPriorityScope(options) {
  return createPriorityScope(options, readWorkspaceLockProcessInstanceFingerprint(process.pid, null, options));
}

export function observeWorkspaceBundleLockPriority(lockPath, options = {}) {
  return workspaceBundlePriority.snapshot(lockPath, options);
}

export function isWorkspaceBundleLockPriorityChange(lockPath, filename, priorityScope) {
  return workspaceBundlePriority.isRelevant(lockPath, filename, priorityScope);
}

export async function withWorkspaceBundleLock(fn, options = {}) {
  options.signal?.throwIfAborted();
  const lockPath = String(options.lockPath ?? '').trim();
  if (!lockPath) throw new Error('Missing workspace bundle lock path');

  const inheritedValue = resolveHeldLockValue(options);
  if (callerHoldsWorkspaceBundleLock(lockPath, inheritedValue)) {
    const assertOwned = () => {
      if (!callerHoldsWorkspaceBundleLock(lockPath, inheritedValue)) {
        throw createWorkspaceBundleLockOwnershipLostError(lockPath);
      }
    };
    options.signal?.throwIfAborted();
    return await fn({
      waited: false,
      lockPath,
      heldLockValue: inheritedValue,
      inherited: true,
      assertOwned,
    });
  }

  mkdirSync(dirname(lockPath), { recursive: true });
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS;
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
  let heartbeatWorker = null;
  let waited = false;
  const ownPriorityScope = !options.priorityScope && options.wait !== false;
  const priorityScope = options.priorityScope ?? (ownPriorityScope
    ? createPriorityScope({ ...options, resources: [{ path: lockPath }] }, processInstanceFingerprint) : null);
  const priorityObservationOptions = { ...options, priorityScope };
  // The acquisition owns one native watch. Reopening it on every fallback wake
  // repeatedly registers FSEvents clients during long macOS build contention.
  const observer = createFileChangeObserver([dirname(lockPath)], {
    isRelevant: (_directory, filename) => filename == null
      || String(filename) === basename(lockPath) || String(filename) === basename(claimPath)
      || isWorkspaceBundleLockPriorityChange(lockPath, filename, priorityScope),
  });
  const waitForLockChange = options.waitForLockChangeImpl
    ?? ((input) => waitForWorkspaceBundleLockChange({ ...input, observer, priorityOptions: priorityObservationOptions,
      prioritySnapshot: input.prioritySnapshot ?? observeWorkspaceBundleLockPriority(lockPath, priorityObservationOptions) }));
  const claimHistoryOptions = { staleAfterMs, initializationGraceMs, options, priorityClaim: true };
  classifyRetainedLockSnapshots(claimPath, claimHistoryOptions);

  try {
    if (options.priorityScope) priorityScope.activate();
    while (true) {
      options.signal?.throwIfAborted();
      let continuedThroughPriority = false;
      if (ownClaimRaw !== null) {
        ownClaimRaw = refreshPriorityClaim({
          claimPath,
          claimRaw: ownClaimRaw,
          ownerToken,
          processInstanceFingerprint,
        }, options);
      }

      if (ownClaimRaw === null) {
        if (!readLockOwnerSnapshot(claimPath).exists && recoverRetainedLockSnapshot(claimPath, claimHistoryOptions)) continue;
        const lockSnapshot = readLockOwnerSnapshot(lockPath);
        const claimSnapshot = readLockOwnerSnapshot(claimPath);
        if (claimSnapshot.exists && shouldReclaimPriorityClaimSnapshot(claimSnapshot, staleAfterMs, Date.now(), lockOwnerObservationOptions(options, initializationGraceMs))) {
          if (reclaimLockSnapshot(claimPath, claimSnapshot.raw)) continue;
        }
        if (claimSnapshot.exists) {
          const waitSnapshot = lockSnapshot.exists ? lockSnapshot : claimSnapshot;
          assertWorkspaceLockMayWait(options, lockPath, waitSnapshot);
          if (ownPriorityScope) priorityScope.activate();
          if (workspaceBundleLockWaitTimedOut(
            lockSnapshot.exists ? lockPath : claimPath,
            waitSnapshot, staleAfterMs, startedAt, timeoutMs,
            lockOwnerObservationOptions(options, initializationGraceMs), !lockSnapshot.exists,
          )) {
            const errorLabel = options.errorLabel ?? 'workspace bundle lock';
            throw createWorkspaceBundleLockTimeoutError({
              errorLabel,
              lockPath,
              snapshot: waitSnapshot,
            });
          }
          waited = true;
          notifyWaiter(options, lockPath, waitSnapshot, startedAt, staleAfterMs, timeoutMs);
          await waitForLockChange({
          signal: options.signal,
            lockPath,
            claimPath,
            lockSnapshot,
            claimSnapshot,
            maxWaitMs: resolveWorkspaceBundleLockWaitMs({
              options,
              snapshot: waitSnapshot,
              staleAfterMs,
              startedAt,
              timeoutMs,
              initializationGraceMs,
            }),
          });
          continue;
        }
      }

      if (ownClaimRaw === null && priorityScope) {
        const { predecessor, snapshot: prioritySnapshot } = workspaceBundlePriority.observation(lockPath, priorityScope, options);
        if (predecessor) {
          const lockSnapshot = readLockOwnerSnapshot(lockPath);
          continuedThroughPriority = !lockSnapshot.exists
            && workspaceBundlePriority.canContinue(priorityScope, predecessor, options);
          if (!continuedThroughPriority) {
            assertWorkspaceLockMayWait(options, lockPath, predecessor.snapshot);
            if (ownPriorityScope) priorityScope.activate();
            waited = true;
            notifyWaiter(options, lockPath, predecessor.snapshot, startedAt, staleAfterMs, timeoutMs);
            await waitForLockChange({ signal: options.signal, lockPath, claimPath,
              lockSnapshot, claimSnapshot: readLockOwnerSnapshot(claimPath), prioritySnapshot,
              maxWaitMs: resolveWorkspaceBundleLockWaitMs({ options, snapshot: predecessor.snapshot,
                staleAfterMs, startedAt, timeoutMs, initializationGraceMs }) });
            continue;
          }
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
          priorityScopeId: workspaceBundlePriority.scopeId(priorityScope),
        }, options);
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
        if (shouldReclaimLockSnapshot(snapshot, staleAfterMs, Date.now(), lockOwnerObservationOptions(options, initializationGraceMs))) {
          if (reclaimLockSnapshot(lockPath, snapshot.raw)) continue;
          snapshot = readLockOwnerSnapshot(lockPath);
          if (!snapshot.exists) {
            throw new Error(`Failed to safely reclaim workspace bundle lock: ${lockPath}`);
          }
        }
        assertWorkspaceLockMayWait(continuedThroughPriority ? { ...options, wait: false } : options, lockPath, snapshot);
        if (ownPriorityScope) priorityScope.activate();
        if (ownClaimRaw === null && !options.priorityScope
          && (!priorityScope || !workspaceBundlePriority.observation(lockPath, priorityScope, options).predecessor)) {
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
        if (workspaceBundleLockWaitTimedOut(
          lockPath, snapshot, staleAfterMs, startedAt, timeoutMs,
          lockOwnerObservationOptions(options, initializationGraceMs),
        )) {
          const errorLabel = options.errorLabel ?? 'workspace bundle lock';
          throw createWorkspaceBundleLockTimeoutError({ errorLabel, lockPath, snapshot });
        }
        waited = true;
        notifyWaiter(options, lockPath, snapshot, startedAt, staleAfterMs, timeoutMs);
        await waitForLockChange({
          signal: options.signal,
          lockPath,
          claimPath,
          lockSnapshot: snapshot,
          claimSnapshot: readLockOwnerSnapshot(claimPath),
          maxWaitMs: resolveWorkspaceBundleLockWaitMs({
            options,
            snapshot,
            staleAfterMs,
            startedAt,
            timeoutMs,
            initializationGraceMs,
          }),
        });
      }
    }
  } catch (error) {
    clearPriorityClaimIfOwned(claimPath, ownClaimRaw);
    classifyRetainedLockSnapshots(claimPath, { ...claimHistoryOptions, releasedOwner: { ownerToken, processInstanceFingerprint } });
    throw error;
  } finally {
    observer.close();
    if (ownPriorityScope && fd === null) priorityScope.dispose();
  }

  try {
    if (ownPriorityScope) priorityScope.dispose();
    // The acquired lock now owns exclusion. A reaper may restore this claim during
    // quarantine validation; retain it for the existing release cleanup instead
    // of failing publication after admission. Filesystem errors still propagate.
    if (clearPriorityClaimIfOwned(claimPath, ownClaimRaw)) ownClaimRaw = null;
    const heartbeatParams = {
      lockPath,
      ownerToken,
      processInstanceFingerprint,
      staleAfterMs,
    };
    heartbeatWorker = (options.startWorkspaceLockHeartbeatImpl ?? startWorkspaceLockHeartbeat)(
      heartbeatParams,
    );
    if (!heartbeatWorker && staleAfterMs > 0) {
      heartbeat = setInterval(() => {
        refreshWorkspaceLockHeartbeat(heartbeatParams, options);
      }, Math.max(250, Math.min(5_000, Math.floor(staleAfterMs / 4) || 250)));
      heartbeat.unref();
    }

    const assertOwned = () => {
      if (!ownerSnapshotMatchesCurrentProcess(readLockOwnerSnapshot(lockPath), {
        ownerToken,
        processInstanceFingerprint,
      })) {
        throw createWorkspaceBundleLockOwnershipLostError(lockPath);
      }
    };
    options.signal?.throwIfAborted();
    // A currentness/import probe can outlive the priority handoff lease. Admit the
    // waiter first so the existing owner heartbeat protects its progress and no
    // publisher can replace the output graph while the waiter validates reuse.
    if (waited && typeof options.tryResolveWaiter === 'function') {
      const resolution = await options.tryResolveWaiter();
      options.signal?.throwIfAborted();
      assertOwned();
      if (resolution?.resolved === true) return resolution.value;
    }
    return await fn({
      waited,
      lockPath,
      heldLockValue: createWorkspaceLockLeaseValue({ lockPath, ownerToken }),
      inherited: false,
      assertOwned,
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    stopWorkspaceLockHeartbeat(heartbeatWorker);
    try {
      if (fd !== null) closeSync(fd);
    } catch {}
    try {
      if (ownerSnapshotMatchesCurrentProcess(readLockOwnerSnapshot(lockPath), {
        ownerToken,
        processInstanceFingerprint,
      })) unlinkSync(lockPath);
    } catch {}
    clearPriorityClaimIfOwned(claimPath, ownClaimRaw);
    classifyRetainedLockSnapshots(claimPath, { ...claimHistoryOptions, releasedOwner: { ownerToken, processInstanceFingerprint } });
  }
}

export function withWorkspaceBundleLockSync(fn, options = {}) {
  const lockPath = String(options.lockPath ?? '').trim();
  if (!lockPath) throw new Error('Missing workspace bundle lock path');

  const inheritedValue = resolveHeldLockValue(options);
  if (callerHoldsWorkspaceBundleLock(lockPath, inheritedValue)) {
    const assertOwned = () => {
      if (!callerHoldsWorkspaceBundleLock(lockPath, inheritedValue)) {
        throw createWorkspaceBundleLockOwnershipLostError(lockPath);
      }
    };
    return fn({
      waited: false,
      lockPath,
      heldLockValue: inheritedValue,
      inherited: true,
      assertOwned,
    });
  }

  mkdirSync(dirname(lockPath), { recursive: true });
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS;
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
  let heartbeatWorker = null;
  const ownPriorityScope = !options.priorityScope && options.wait !== false;
  const priorityScope = options.priorityScope ?? (ownPriorityScope
    ? createPriorityScope({ ...options, resources: [{ path: lockPath }] }, processInstanceFingerprint) : null);
  const claimHistoryOptions = { staleAfterMs, initializationGraceMs, options, priorityClaim: true };
  classifyRetainedLockSnapshots(claimPath, claimHistoryOptions);

  try {
    if (options.priorityScope) priorityScope.activate();
    while (true) {
      let continuedThroughPriority = false;
      if (ownClaimRaw !== null) {
        ownClaimRaw = refreshPriorityClaim({
          claimPath,
          claimRaw: ownClaimRaw,
          ownerToken,
          processInstanceFingerprint,
        }, options);
      }

      if (ownClaimRaw === null) {
        if (!readLockOwnerSnapshot(claimPath).exists && recoverRetainedLockSnapshot(claimPath, claimHistoryOptions)) continue;
        const lockSnapshot = readLockOwnerSnapshot(lockPath);
        const claimSnapshot = readLockOwnerSnapshot(claimPath);
        if (claimSnapshot.exists && shouldReclaimPriorityClaimSnapshot(claimSnapshot, staleAfterMs, Date.now(), lockOwnerObservationOptions(options, initializationGraceMs))) {
          if (reclaimLockSnapshot(claimPath, claimSnapshot.raw)) continue;
        }
        if (claimSnapshot.exists) {
          const waitSnapshot = lockSnapshot.exists ? lockSnapshot : claimSnapshot;
          assertWorkspaceLockMayWait(options, lockPath, waitSnapshot);
          if (ownPriorityScope) priorityScope.activate();
          if (workspaceBundleLockWaitTimedOut(
            lockSnapshot.exists ? lockPath : claimPath,
            waitSnapshot, staleAfterMs, startedAt, timeoutMs,
            lockOwnerObservationOptions(options, initializationGraceMs), !lockSnapshot.exists,
          )) {
            const errorLabel = options.errorLabel ?? 'workspace bundle lock';
            throw createWorkspaceBundleLockTimeoutError({
              errorLabel,
              lockPath,
              snapshot: waitSnapshot,
            });
          }
          waited = true;
          notifyWaiter(options, lockPath, waitSnapshot, startedAt, staleAfterMs, timeoutMs);
          sleepSync(Math.max(pollIntervalMs, 25));
          continue;
        }
      }

      if (ownClaimRaw === null && priorityScope) {
        const { predecessor } = workspaceBundlePriority.observation(lockPath, priorityScope, options);
        if (predecessor) {
          continuedThroughPriority = !readLockOwnerSnapshot(lockPath).exists
            && workspaceBundlePriority.canContinue(priorityScope, predecessor, options);
          if (!continuedThroughPriority) {
            assertWorkspaceLockMayWait(options, lockPath, predecessor.snapshot);
            if (ownPriorityScope) priorityScope.activate();
            waited = true;
            notifyWaiter(options, lockPath, predecessor.snapshot, startedAt, staleAfterMs, timeoutMs);
            sleepSync(Math.max(pollIntervalMs, 25));
            continue;
          }
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
          priorityScopeId: workspaceBundlePriority.scopeId(priorityScope),
        }, options);
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
        if (shouldReclaimLockSnapshot(snapshot, staleAfterMs, Date.now(), lockOwnerObservationOptions(options, initializationGraceMs))) {
          if (reclaimLockSnapshot(lockPath, snapshot.raw)) continue;
          snapshot = readLockOwnerSnapshot(lockPath);
          if (!snapshot.exists) {
            throw new Error(`Failed to safely reclaim workspace bundle lock: ${lockPath}`);
          }
        }
        assertWorkspaceLockMayWait(continuedThroughPriority ? { ...options, wait: false } : options, lockPath, snapshot);
        if (ownPriorityScope) priorityScope.activate();
        if (ownClaimRaw === null && !options.priorityScope
          && (!priorityScope || !workspaceBundlePriority.observation(lockPath, priorityScope, options).predecessor)) {
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
        if (workspaceBundleLockWaitTimedOut(
          lockPath, snapshot, staleAfterMs, startedAt, timeoutMs,
          lockOwnerObservationOptions(options, initializationGraceMs),
        )) {
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
    classifyRetainedLockSnapshots(claimPath, { ...claimHistoryOptions, releasedOwner: { ownerToken, processInstanceFingerprint } });
    throw error;
  } finally {
    if (ownPriorityScope && fd === null) priorityScope.dispose();
  }

  try {
    if (ownPriorityScope) priorityScope.dispose();
    // Keep an inconclusive cleanup for release; admission already holds the lock.
    if (clearPriorityClaimIfOwned(claimPath, ownClaimRaw)) ownClaimRaw = null;
    heartbeatWorker = (options.startWorkspaceLockHeartbeatImpl ?? startWorkspaceLockHeartbeat)({
      lockPath,
      ownerToken,
      processInstanceFingerprint,
      staleAfterMs,
    });
    const assertOwned = () => {
      if (!ownerSnapshotMatchesCurrentProcess(readLockOwnerSnapshot(lockPath), {
        ownerToken,
        processInstanceFingerprint,
      })) {
        throw createWorkspaceBundleLockOwnershipLostError(lockPath);
      }
    };
    return fn({
      waited,
      lockPath,
      heldLockValue: createWorkspaceLockLeaseValue({ lockPath, ownerToken }),
      inherited: false,
      assertOwned,
    });
  } finally {
    stopWorkspaceLockHeartbeat(heartbeatWorker);
    try {
      if (fd !== null) closeSync(fd);
    } catch {}
    try {
      if (ownerSnapshotMatchesCurrentProcess(readLockOwnerSnapshot(lockPath), {
        ownerToken,
        processInstanceFingerprint,
      })) unlinkSync(lockPath);
    } catch {}
    clearPriorityClaimIfOwned(claimPath, ownClaimRaw);
    classifyRetainedLockSnapshots(claimPath, { ...claimHistoryOptions, releasedOwner: { ownerToken, processInstanceFingerprint } });
  }
}
