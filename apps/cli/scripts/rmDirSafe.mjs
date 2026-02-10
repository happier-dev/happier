import { rmSync } from 'node:fs';

function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  // Node doesn't have a built-in sync sleep. Atomics.wait is deterministic and doesn't require timers.
  const buf = new SharedArrayBuffer(4);
  const arr = new Int32Array(buf);
  Atomics.wait(arr, 0, 0, ms);
}

function isRetryableRmError(err) {
  const code = err && typeof err === 'object' ? err.code : null;
  return (
    code === 'ENOTEMPTY' ||
    code === 'EBUSY' ||
    code === 'EPERM' ||
    code === 'EACCES'
  );
}

/**
 * Best-effort directory removal for local/dev workflows.
 *
 * Motivation: in local environments (especially with other watchers running) a recursive remove can race
 * with other processes recreating files and sporadically throw ENOTEMPTY. We'll harden this with retries.
 */
export function rmDirSafeSync(dirPath, opts = {}) {
  const {
    recursive = true,
    force = true,
    retries = 5,
    delayMs = 25,
    rmSyncImpl = rmSync,
  } = opts;

  const maxAttempts = Math.max(1, Number.isFinite(retries) ? retries + 1 : 1);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      rmSyncImpl(dirPath, { recursive, force });
      return;
    } catch (err) {
      if (!isRetryableRmError(err) || attempt === maxAttempts - 1) throw err;
      sleepSync(delayMs);
    }
  }
}
