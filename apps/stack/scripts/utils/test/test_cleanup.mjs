import { rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';

export function registerTestCleanup(t, cleanup) {
  if (t?.after) t.after(cleanup);
  return cleanup;
}

export async function removeDirForce(dir) {
  if (!dir) return;
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

export function removeDirForceSync(dir) {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures in test fixtures
  }
}
