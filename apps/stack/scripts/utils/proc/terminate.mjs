import { isPidAlive } from './pids.mjs';
import { spawn } from 'node:child_process';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

function resolveProcessBoundary(boundary = {}) {
  return {
    platform: boundary.platform ?? process.platform,
    isPidAlive: boundary.isPidAlive ?? isPidAlive,
    kill: boundary.kill ?? ((pid, signal) => process.kill(pid, signal)),
    spawn: boundary.spawn ?? spawn,
    readProcessInstanceFingerprint: boundary.readProcessInstanceFingerprint
      ?? ((pid, expectedFingerprint = null) => readProcessInstanceFingerprintSync(pid, {
        platform: boundary.platform ?? process.platform,
        expectedFingerprint,
      })),
  };
}

function nowMs() {
  return Date.now();
}

function observeProcessInstance(identityPid, expectedFingerprint, boundary) {
  const expected = String(expectedFingerprint ?? '').trim();
  if (!expected) return { status: 'unavailable' };
  let observed = null;
  try {
    observed = boundary.readProcessInstanceFingerprint(identityPid, expected);
  } catch {
    observed = null;
  }
  if (observed === expected) return { status: 'same', fingerprint: observed };
  if (observed) return { status: 'changed', fingerprint: observed };
  return boundary.isPidAlive(identityPid)
    ? { status: 'unavailable' }
    : { status: 'exited' };
}

async function waitForExit(pid, timeoutMs, boundary, identity) {
  const end = nowMs() + Math.max(0, Number(timeoutMs) || 0);
  while (nowMs() < end) {
    const targetAlive = identity.isTargetAlive(pid, boundary);
    const processInstance = observeProcessInstance(
      identity.identityPid,
      identity.processInstanceFingerprint,
      boundary,
    );
    if (!targetAlive) {
      return processInstance.status === 'changed' || processInstance.status === 'unavailable'
        ? processInstance
        : { status: 'exited' };
    }
    if (processInstance.status === 'exited') return { status: 'identity_exited' };
    if (processInstance.status !== 'same') return processInstance;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 40));
  }
  const targetAlive = identity.isTargetAlive(pid, boundary);
  const processInstance = observeProcessInstance(
    identity.identityPid,
    identity.processInstanceFingerprint,
    boundary,
  );
  if (!targetAlive) {
    return processInstance.status === 'changed' || processInstance.status === 'unavailable'
      ? processInstance
      : { status: 'exited' };
  }
  if (processInstance.status === 'exited') return { status: 'identity_exited' };
  return processInstance.status === 'same'
    ? { status: 'timeout' }
    : processInstance;
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
      try { child?.kill('SIGKILL'); } catch {}
      finish(false);
    }, Math.max(50, Number(timeoutMs) || 0));
    try {
      child = boundary.spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true, shell: false,
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

function isPidTargetAlive(pid, boundary) {
  return Boolean(pid && pid > 1 && boundary.isPidAlive(pid));
}

function normalizeStartSignal(signal) {
  const s = String(signal ?? '').trim().toUpperCase();
  if (s === 'SIGINT' || s === 'SIGTERM' || s === 'SIGKILL') return s;
  return 'SIGINT';
}

function resolveExpectedProcessInstance(identityPid, suppliedFingerprint, boundary) {
  const supplied = String(suppliedFingerprint ?? '').trim();
  if (supplied) return supplied;
  try {
    return String(boundary.readProcessInstanceFingerprint(identityPid) ?? '').trim() || null;
  } catch {
    return null;
  }
}

export async function terminateProcessPid(pid, {
  graceMs = 800,
  signal = 'SIGINT',
  processInstanceFingerprint = null,
  boundary: boundaryOverrides,
} = {}) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return { ok: false, reason: 'bad_pid' };
  const boundary = resolveProcessBoundary(boundaryOverrides);
  if (!isPidTargetAlive(n, boundary)) return { ok: true, alreadyExited: true };
  const expectedFingerprint = resolveExpectedProcessInstance(n, processInstanceFingerprint, boundary);
  if (!expectedFingerprint) return { ok: false, reason: 'process_instance_unavailable' };
  const initialIdentity = observeProcessInstance(n, expectedFingerprint, boundary);
  if (initialIdentity.status !== 'same') {
    return {
      ok: initialIdentity.status === 'exited',
      reason: initialIdentity.status === 'changed'
        ? 'process_instance_changed'
        : initialIdentity.status === 'exited'
          ? 'already_exited'
          : 'process_instance_unavailable',
    };
  }

  const perSignalMs = Math.max(50, Number(graceMs) || 0);
  const startSignal = normalizeStartSignal(signal);
  const sequence = [startSignal, 'SIGINT', 'SIGTERM', 'SIGKILL'].filter(
    (sig, index, arr) => arr.indexOf(sig) === index,
  );
  let lastSignal = null;
  for (const sig of sequence) {
    const beforeSignal = observeProcessInstance(n, expectedFingerprint, boundary);
    if (beforeSignal.status !== 'same') {
      if (beforeSignal.status === 'unavailable') {
        return { ok: false, ...(lastSignal ? { signal: lastSignal } : {}), reason: 'process_instance_unavailable' };
      }
      if (lastSignal) {
        return { ok: true, signal: lastSignal, reason: 'process_instance_exited' };
      }
      return beforeSignal.status === 'exited'
        ? { ok: true, alreadyExited: true, reason: 'already_exited' }
        : { ok: false, reason: 'process_instance_changed' };
    }
    try {
      boundary.kill(n, sig);
    } catch {}
    lastSignal = sig;
    // eslint-disable-next-line no-await-in-loop
    const exit = await waitForExit(n, sig === 'SIGKILL' ? Math.min(400, perSignalMs) : perSignalMs, boundary, {
      identityPid: n,
      processInstanceFingerprint: expectedFingerprint,
      isTargetAlive: isPidTargetAlive,
    });
    if (exit.status === 'exited') return { ok: true, signal: sig };
    if (exit.status === 'changed' || exit.status === 'identity_exited') {
      return { ok: true, signal: sig, reason: 'process_instance_exited' };
    }
    if (exit.status === 'unavailable') return { ok: false, signal: sig, reason: 'process_instance_unavailable' };
  }
  return { ok: false, signal: 'SIGKILL', reason: 'kill_timeout' };
}

export async function terminateProcessGroup(pid, {
  graceMs = 800,
  signal = 'SIGINT',
  identityPid = pid,
  processInstanceFingerprint = null,
  boundary: boundaryOverrides,
} = {}) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return { ok: false, reason: 'bad_pid' };
  const identityPidNum = Number(identityPid);
  if (!Number.isFinite(identityPidNum) || identityPidNum <= 1) {
    return { ok: false, reason: 'bad_identity_pid' };
  }
  const boundary = resolveProcessBoundary(boundaryOverrides);
  if (!isTargetAlive(n, boundary)) {
    return boundary.platform === 'win32'
      ? { ok: false, reason: 'leader_absent_without_tree_proof' }
      : { ok: true, alreadyExited: true };
  }
  const expectedFingerprint = resolveExpectedProcessInstance(
    identityPidNum,
    processInstanceFingerprint,
    boundary,
  );
  if (!expectedFingerprint) return { ok: false, reason: 'process_instance_unavailable' };
  const initialIdentity = observeProcessInstance(identityPidNum, expectedFingerprint, boundary);
  if (initialIdentity.status !== 'same') {
    return {
      ok: false,
      reason: initialIdentity.status === 'changed'
        ? 'process_instance_changed'
        : initialIdentity.status === 'exited'
          ? 'identity_exited_before_group_cleanup'
          : 'process_instance_unavailable',
    };
  }

  const perSignalMs = Math.max(50, Number(graceMs) || 0);
  if (boundary.platform === 'win32') {
    const beforeTreeKill = observeProcessInstance(identityPidNum, expectedFingerprint, boundary);
    if (beforeTreeKill.status !== 'same') {
      return {
        ok: false,
        reason: beforeTreeKill.status === 'changed'
          ? 'process_instance_changed_before_group_cleanup'
          : beforeTreeKill.status === 'exited'
            ? 'identity_exited_before_group_cleanup'
            : 'process_instance_unavailable',
      };
    }
    const treeKilled = await forceKillWindowsProcessTree(n, Math.min(2_000, perSignalMs), boundary);
    const exited = await waitForExit(n, Math.min(400, perSignalMs), boundary, {
      identityPid: identityPidNum,
      processInstanceFingerprint: expectedFingerprint,
      isTargetAlive,
    });
    return {
      ok: treeKilled && ['exited', 'changed', 'identity_exited'].includes(exited.status),
      signal: 'SIGKILL',
      ...(!treeKilled || !['exited', 'changed', 'identity_exited'].includes(exited.status)
        ? { reason: exited.status === 'unavailable' ? 'process_instance_unavailable' : 'kill_timeout' }
        : {}),
    };
  }
  const startSignal = normalizeStartSignal(signal);
  const sequence = [startSignal, 'SIGINT', 'SIGTERM', 'SIGKILL'].filter(
    (sig, index, arr) => arr.indexOf(sig) === index
  );

  let lastSignal = null;
  for (const sig of sequence) {
    const beforeSignal = observeProcessInstance(identityPidNum, expectedFingerprint, boundary);
    if (beforeSignal.status !== 'same') {
      return {
        ok: false,
        ...(lastSignal ? { signal: lastSignal } : {}),
        reason: beforeSignal.status === 'changed'
          ? 'process_instance_changed_before_group_cleanup'
          : beforeSignal.status === 'exited'
            ? 'identity_exited_before_group_cleanup'
            : 'process_instance_unavailable',
      };
    }
    killGroup(n, sig, boundary);
    lastSignal = sig;
    // eslint-disable-next-line no-await-in-loop
    const exited = await waitForExit(n, sig === 'SIGKILL' ? Math.min(400, perSignalMs) : perSignalMs, boundary, {
      identityPid: identityPidNum,
      processInstanceFingerprint: expectedFingerprint,
      isTargetAlive,
    });
    if (exited.status === 'exited') return { ok: true, signal: sig };
    if (exited.status === 'changed') {
      return { ok: false, signal: sig, reason: 'process_instance_changed_before_group_cleanup' };
    }
    if (exited.status === 'unavailable' || exited.status === 'identity_exited') {
      return { ok: false, signal: sig, reason: 'process_instance_unavailable' };
    }
  }

  const completionIdentity = observeProcessInstance(identityPidNum, expectedFingerprint, boundary);
  if (completionIdentity.status !== 'same') {
    return {
      ok: false,
      signal: 'SIGKILL',
      reason: completionIdentity.status === 'changed'
        ? 'process_instance_changed_before_group_cleanup'
        : 'process_instance_unavailable',
    };
  }
  return { ok: !isTargetAlive(n, boundary), signal: 'SIGKILL', reason: 'kill_timeout' };
}
