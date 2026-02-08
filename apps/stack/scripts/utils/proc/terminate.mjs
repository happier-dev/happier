import { isPidAlive } from './pids.mjs';

function nowMs() {
  return Date.now();
}

async function waitForExit(pid, timeoutMs) {
  const end = nowMs() + Math.max(0, Number(timeoutMs) || 0);
  while (nowMs() < end) {
    if (!isTargetAlive(pid)) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 40));
  }
  return !isTargetAlive(pid);
}

function killGroup(pid, signal) {
  if (!pid || pid <= 1) return;
  try {
    if (process.platform !== 'win32') process.kill(-pid, signal);
    else {
      // Windows doesn't implement POSIX signal semantics; process.kill(pid, SIGINT/SIGTERM)
      // targets the single process and may terminate it immediately instead of graceful group shutdown.
      process.kill(pid, signal);
    }
  } catch {
    // ignore
  }
}

function isTargetAlive(pid) {
  if (!pid || pid <= 1) return false;
  if (process.platform === 'win32') {
    return isPidAlive(pid);
  }
  try {
    process.kill(-pid, 0);
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

export async function terminateProcessGroup(pid, { graceMs = 800, signal = 'SIGINT' } = {}) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return { ok: false, reason: 'bad_pid' };
  if (!isTargetAlive(n)) return { ok: true, alreadyExited: true };

  const perSignalMs = Math.max(50, Number(graceMs) || 0);
  const startSignal = normalizeStartSignal(signal);
  const sequence = [startSignal, 'SIGINT', 'SIGTERM', 'SIGKILL'].filter(
    (sig, index, arr) => arr.indexOf(sig) === index
  );

  for (const sig of sequence) {
    killGroup(n, sig);
    // eslint-disable-next-line no-await-in-loop
    const exited = await waitForExit(n, sig === 'SIGKILL' ? Math.min(400, perSignalMs) : perSignalMs);
    if (exited) return { ok: true, signal: sig };
  }

  return { ok: !isTargetAlive(n), signal: 'SIGKILL' };
}
