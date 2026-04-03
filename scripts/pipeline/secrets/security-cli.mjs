// @ts-check

import { spawnSync } from 'node:child_process';

export function assertSecurityCliAvailable() {
  const res = spawnSync('security', [], { stdio: 'ignore' });
  if (res.error && res.error.code === 'ENOENT') {
    const err = new Error('Keychain secrets require the `security` CLI (available by default on macOS).');
    // Mirror the underlying failure mode so callers can treat this as "keychain unavailable" in auto mode.
    // @ts-expect-error - attach a standard Node error code for downstream classification.
    err.code = 'ENOENT';
    throw err;
  }
}
