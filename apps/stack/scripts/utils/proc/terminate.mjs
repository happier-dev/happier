import { spawn } from 'node:child_process';

import {
  processInstanceFingerprintMatches,
  readProcessInstanceFingerprintSync,
} from '@happier-dev/cli-common/processInstance';
import { isPidAlive, observePidLiveness } from './pids.mjs';
import { observeWindowsProcessDescendants } from './windows_process_descendants.mjs';

function resolveProcessBoundary(boundary = {}) {
  return {
    platform: boundary.platform ?? process.platform,
    isPidAlive: boundary.isPidAlive ?? isPidAlive,
    observePidLiveness: boundary.observePidLiveness ?? ((pid) => observePidLiveness(pid)),
    readProcessInstanceFingerprint:
      boundary.readProcessInstanceFingerprint ?? ((pid) => readProcessInstanceFingerprintSync(pid)),
    kill: boundary.kill ?? ((pid, signal) => process.kill(pid, signal)),
    spawn: boundary.spawn ?? spawn,
    observeProcessDescendants:
      boundary.observeProcessDescendants ?? ((pid, fingerprint) => observeWindowsProcessDescendants(pid, { fingerprint })),
  };
}

async function observeExpectedProcessInstance(pid, processInstanceFingerprint, boundary) {
  const expected = String(processInstanceFingerprint ?? '').trim();
  if (!expected) return { status: 'not_required' };
  const liveness = boundary.observePidLiveness(pid);
  if (liveness?.status === 'dead') return { status: 'dead' };
  if (liveness?.status !== 'alive') return { status: 'inconclusive', reason: 'liveness_inconclusive' };
  const observed = await boundary.readProcessInstanceFingerprint(pid);
  if (!String(observed ?? '').trim()) {
    // A process that exits during the read leaves it empty, which says nothing about a live one.
    return boundary.observePidLiveness(pid)?.status === 'dead'
      ? { status: 'dead' }
      : { status: 'inconclusive', reason: 'process_instance_unavailable' };
  }
  return processInstanceFingerprintMatches(expected, observed)
    ? { status: 'matches' }
    : { status: 'mismatch', reason: 'process_instance_mismatch' };
}

async function waitForPidDeath(pid, timeoutMs, boundary, processInstanceFingerprint = null) {
  const end = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < end) {
    const observation = boundary.observePidLiveness(pid);
    if (observation?.status === 'dead') return observation;
    // eslint-disable-next-line no-await-in-loop
    const identity = await observeExpectedProcessInstance(pid, processInstanceFingerprint, boundary);
    if (identity.status === 'dead') return { status: 'dead', reason: 'not_found' };
    if (identity.status === 'mismatch' || identity.status === 'inconclusive') {
      return { status: 'replaced', reason: identity.reason };
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const observation = boundary.observePidLiveness(pid);
  if (observation?.status === 'dead') return observation;
  const identity = await observeExpectedProcessInstance(pid, processInstanceFingerprint, boundary);
  if (identity.status === 'dead') return { status: 'dead', reason: 'not_found' };
  return identity.status === 'mismatch' || identity.status === 'inconclusive'
    ? { status: 'replaced', reason: identity.reason }
    : observation;
}

export async function terminateProcessPid(
  pid,
  {
    graceMs = 800,
    signal = 'SIGTERM',
    processInstanceFingerprint = null,
    boundary: boundaryOverrides,
  } = {},
) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return { ok: false, reason: 'bad_pid' };
  const boundary = resolveProcessBoundary(boundaryOverrides);
  const before = boundary.observePidLiveness(n);
  if (before?.status === 'dead') return { ok: true, alreadyExited: true, reason: 'already_exited' };
  if (before?.status !== 'alive') return { ok: false, reason: 'liveness_inconclusive' };
  const initialIdentity = await observeExpectedProcessInstance(n, processInstanceFingerprint, boundary);
  if (initialIdentity.status === 'dead') {
    return { ok: true, alreadyExited: true, reason: 'already_exited' };
  }
  if (initialIdentity.status === 'mismatch' || initialIdentity.status === 'inconclusive') {
    return { ok: false, reason: initialIdentity.reason };
  }

  const startSignal = normalizeStartSignal(signal);
  try {
    boundary.kill(n, startSignal);
  } catch (error) {
    if (error?.code === 'ESRCH') return { ok: true, alreadyExited: true, reason: 'already_exited' };
  }
  let observed = await waitForPidDeath(n, graceMs, boundary, processInstanceFingerprint);
  if (observed?.status === 'dead') return { ok: true, signal: startSignal };
  if (observed?.status === 'replaced') return { ok: false, reason: observed.reason, signal: startSignal };

  try {
    boundary.kill(n, 'SIGKILL');
  } catch (error) {
    if (error?.code === 'ESRCH') return { ok: true, alreadyExited: true, reason: 'already_exited' };
  }
  observed = await waitForPidDeath(
    n,
    Math.min(400, Math.max(50, Number(graceMs) || 0)),
    boundary,
    processInstanceFingerprint,
  );
  if (observed?.status === 'replaced') {
    return { ok: false, reason: observed.reason, signal: 'SIGKILL' };
  }
  return observed?.status === 'dead'
    ? { ok: true, signal: 'SIGKILL' }
    : { ok: false, reason: observed?.status === 'alive' ? 'pid_still_alive' : 'liveness_inconclusive', signal: 'SIGKILL' };
}

async function waitForExit(pid, timeoutMs, boundary) {
  const end = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < end) {
    if (!isTargetAlive(pid, boundary)) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 40));
  }
  return !isTargetAlive(pid, boundary);
}

function killGroup(pid, signal, boundary) {
  if (!pid || pid <= 1) return;
  try {
    if (boundary.platform !== 'win32') boundary.kill(-pid, signal);
    else {
      // Windows doesn't implement POSIX signal semantics; process.kill(pid, SIGINT/SIGTERM)
      // targets the single process and may terminate it immediately instead of graceful group shutdown.
      boundary.kill(pid, signal);
    }
  } catch {
    // ignore
  }
}

async function forceKillWindowsProcessTree(pid, timeoutMs, boundary) {
  return await new Promise((resolve) => {
    let settled = false;
    let child = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        // ignore; timeout remains a failed tree-termination proof
      }
      finish(false);
    }, Math.max(50, Number(timeoutMs) || 0));

    try {
      child = boundary.spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      });
      child.once('error', () => finish(false));
      child.once('exit', (code) => finish(code === 0));
    } catch {
      finish(false);
    }
  });
}

function isTargetAlive(pid, boundary) {
  if (!pid || pid <= 1) return false;
  if (boundary.platform === 'win32') {
    return boundary.isPidAlive(pid);
  }
  try {
    boundary.kill(-pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

function normalizeStartSignal(signal) {
  const s = String(signal ?? '').trim().toUpperCase();
  if (s === 'SIGINT' || s === 'SIGTERM' || s === 'SIGKILL') return s;
  return 'SIGINT';
}

/** A missing leader says nothing about its children, so its tree needs evidence of its own. */
async function proveExitedWindowsTree(pid, processInstanceFingerprint, boundary) {
  const unproven = { ok: false, reason: 'leader_absent_without_tree_proof' };
  if (!String(processInstanceFingerprint ?? '').trim()) return unproven;
  const descendants = await boundary.observeProcessDescendants(pid, processInstanceFingerprint);
  if (descendants?.status === 'none') return { ok: true, alreadyExited: true };
  return descendants?.status === 'present'
    ? { ok: false, reason: 'descendants_remain', pids: descendants.pids }
    : unproven;
}

export async function terminateProcessGroup(
  pid,
  {
    graceMs = 800,
    signal = 'SIGINT',
    identityPid = pid,
    processInstanceFingerprint = null,
    boundary: boundaryOverrides,
  } = {},
) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return { ok: false, reason: 'bad_pid' };
  const boundary = resolveProcessBoundary(boundaryOverrides);
  const normalizedIdentityPid = Number(identityPid);
  // The fingerprint dates the leader only when it was taken from this same process.
  const leaderFingerprint = normalizedIdentityPid === n ? processInstanceFingerprint : null;
  if (!isTargetAlive(n, boundary)) {
    return boundary.platform === 'win32'
      ? await proveExitedWindowsTree(n, leaderFingerprint, boundary)
      : { ok: true, alreadyExited: true };
  }
  if (processInstanceFingerprint && (!Number.isFinite(normalizedIdentityPid) || normalizedIdentityPid <= 1)) {
    return { ok: false, reason: 'bad_identity_pid' };
  }
  const observeGroupIdentity = () => observeExpectedProcessInstance(
    normalizedIdentityPid,
    processInstanceFingerprint,
    boundary,
  );
  const initialIdentity = await observeGroupIdentity();
  if (initialIdentity.status === 'mismatch' || initialIdentity.status === 'inconclusive') {
    return { ok: false, reason: initialIdentity.reason };
  }

  const perSignalMs = Math.max(50, Number(graceMs) || 0);
  if (boundary.platform === 'win32') {
    // A leader-only soft signal cannot prove that its descendants exited. Windows taskkill /T /F
    // is the process-tree boundary, so invoke it while the observed leader is still alive.
    const treeKilled = await forceKillWindowsProcessTree(n, Math.min(2_000, perSignalMs), boundary);
    const exited = await waitForExit(n, Math.min(400, perSignalMs), boundary);
    if (exited && !treeKilled) return await proveExitedWindowsTree(n, leaderFingerprint, boundary);
    const finalIdentity = await observeGroupIdentity();
    if (!exited && (finalIdentity.status === 'mismatch' || finalIdentity.status === 'inconclusive')) {
      return { ok: false, reason: finalIdentity.reason, signal: 'SIGKILL' };
    }
    return { ok: treeKilled && exited, signal: 'SIGKILL' };
  }

  const startSignal = normalizeStartSignal(signal);
  const sequence = [startSignal, 'SIGINT', 'SIGTERM', 'SIGKILL'].filter(
    (sig, index, arr) => arr.indexOf(sig) === index
  );

  for (const sig of sequence) {
    // eslint-disable-next-line no-await-in-loop
    const identity = await observeGroupIdentity();
    if (identity.status === 'mismatch' || identity.status === 'inconclusive') {
      return { ok: false, reason: identity.reason, signal: sig };
    }
    killGroup(n, sig, boundary);
    // eslint-disable-next-line no-await-in-loop
    const exited = await waitForExit(n, sig === 'SIGKILL' ? Math.min(400, perSignalMs) : perSignalMs, boundary);
    if (exited) return { ok: true, signal: sig };
    // eslint-disable-next-line no-await-in-loop
    const afterSignalIdentity = await observeGroupIdentity();
    if (afterSignalIdentity.status === 'mismatch' || afterSignalIdentity.status === 'inconclusive') {
      return { ok: false, reason: afterSignalIdentity.reason, signal: sig };
    }
  }

  return { ok: !isTargetAlive(n, boundary), signal: 'SIGKILL' };
}
