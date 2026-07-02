import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('withStackDaemonLifecycleLock removes and reacquires the lock after cleanup on Windows-shaped filesystems', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-daemon-lifecycle-lock-cleanup-'));
  try {
    const moduleUrl = new URL('./daemon_lifecycle_lock.mjs', import.meta.url).href;
    const script = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const originalOpenSync = fs.openSync;
const originalCloseSync = fs.closeSync;
const originalUnlinkSync = fs.unlinkSync;
const openLockPaths = new Map();

fs.openSync = function patchedOpenSync(path, flags, mode) {
  const fd = originalOpenSync.call(this, path, flags, mode);
  openLockPaths.set(String(path), fd);
  return fd;
};

fs.closeSync = function patchedCloseSync(fd) {
  for (const [path, openFd] of openLockPaths.entries()) {
    if (openFd === fd) {
      openLockPaths.delete(path);
      break;
    }
  }
  return originalCloseSync.call(this, fd);
};

fs.unlinkSync = function patchedUnlinkSync(path) {
  if (openLockPaths.has(String(path))) {
    const error = new Error(\`EPERM: file is in use, unlink '\${String(path)}'\`);
    error.code = 'EPERM';
    throw error;
  }
  return originalUnlinkSync.call(this, path);
};

syncBuiltinESMExports();

const { withStackDaemonLifecycleLock } = await import(${JSON.stringify(moduleUrl)});
const lockPath = join(${JSON.stringify(tmp)}, 'locks', 'daemon-lifecycle.lock');
const scope = {
  cliHomeDir: ${JSON.stringify(tmp)},
  internalServerUrl: 'http://127.0.0.1:3011',
  stackName: 'dev',
};

await withStackDaemonLifecycleLock(
  scope,
  async () => {},
  { lockPath, timeoutMs: 50, pollIntervalMs: 5, staleAfterMs: 50 },
);

await withStackDaemonLifecycleLock(
  scope,
  async () => {},
  { lockPath, timeoutMs: 50, pollIntervalMs: 5, staleAfterMs: 50 },
);
`;

    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', script],
      {
        encoding: 'utf-8',
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
