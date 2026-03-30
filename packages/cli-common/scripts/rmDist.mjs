import { rmSync } from 'node:fs';

function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function isRetryableRmError(error) {
  const code = error && typeof error === 'object' ? error.code : null;
  return code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'EINTR';
}

export function rmDistSync(options = {}) {
  const targetDir = String(options.targetDir ?? 'dist').trim() || 'dist';
  const retries = Number.isFinite(options.retries) ? options.retries : 5;
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : 25;
  const rmSyncImpl = options.rmSyncImpl ?? rmSync;
  const maxAttempts = Math.max(1, retries + 1);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      rmSyncImpl(targetDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetryableRmError(error) || attempt === maxAttempts - 1) throw error;
      sleepSync(delayMs);
    }
  }
}

export function main() {
  rmDistSync({
    // Local dev can run with other watchers rebuilding dist; give ourselves a bit of headroom.
    retries: 25,
    delayMs: 20,
  });
}

const isEntrypoint = (() => {
  const arg = typeof process.argv?.[1] === 'string' ? process.argv[1] : '';
  if (!arg) return false;
  return arg.endsWith('/scripts/rmDist.mjs') || arg.endsWith('\\scripts\\rmDist.mjs');
})();

if (isEntrypoint) {
  main();
}
