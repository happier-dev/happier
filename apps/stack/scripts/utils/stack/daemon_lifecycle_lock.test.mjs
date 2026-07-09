import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { withStackDaemonLifecycleLock } from './daemon_lifecycle_lock.mjs';

test('withStackDaemonLifecycleLock does not reclaim an old lock while the owner pid is alive', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-daemon-lifecycle-lock-live-owner-'));
  const lockPath = join(tmp, 'daemon-lifecycle.lock');
  const scope = { cliHomeDir: tmp, internalServerUrl: 'http://127.0.0.1:3011', stackName: 'dev' };
  const owner = {
    pid: process.pid,
    createdAtMs: Date.now() - 60_000,
    updatedAtMs: Date.now() - 60_000,
  };
  let enteredCriticalSection = false;

  try {
    await writeFile(lockPath, JSON.stringify(owner), 'utf8');

    await assert.rejects(
      () =>
        withStackDaemonLifecycleLock(
          scope,
          async () => {
            enteredCriticalSection = true;
          },
          { lockPath, timeoutMs: 60, pollIntervalMs: 10, staleAfterMs: 10 },
        ),
      /Timed out waiting for daemon lifecycle lock/,
    );

    assert.equal(enteredCriticalSection, false);
    assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), owner);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('withStackDaemonLifecycleLock does not heartbeat over or unlink a successor owner', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-daemon-lifecycle-lock-successor-'));
  const lockPath = join(tmp, 'daemon-lifecycle.lock');
  const scope = { cliHomeDir: tmp, internalServerUrl: 'http://127.0.0.1:3011', stackName: 'dev' };
  const successorOwner = {
    pid: process.pid + 1_000_000,
    createdAtMs: Date.now() + 1,
    updatedAtMs: Date.now() + 1,
  };

  try {
    await withStackDaemonLifecycleLock(
      scope,
      async () => {
        await writeFile(lockPath, JSON.stringify(successorOwner), 'utf8');
        await delay(620);
        assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), successorOwner);
      },
      { lockPath, timeoutMs: 500, pollIntervalMs: 10, staleAfterMs: 20 },
    );

    assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), successorOwner);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('withStackDaemonLifecycleLock does not delete a successor owner during stale-owner reclaim', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-daemon-lifecycle-lock-reclaim-race-'));
  try {
    const moduleUrl = new URL('./daemon_lifecycle_lock.mjs', import.meta.url).href;
    const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const originalRenameSync = fs.renameSync;
const originalRmSync = fs.rmSync;
const lockPath = join(${JSON.stringify(tmp)}, 'daemon-lifecycle.lock');
const scope = {
  cliHomeDir: ${JSON.stringify(tmp)},
  internalServerUrl: 'http://127.0.0.1:3011',
  stackName: 'dev',
};
const staleOwner = {
  pid: 999999,
  createdAtMs: Date.now() - 60_000,
  updatedAtMs: Date.now() - 60_000,
};
const successorOwner = {
  pid: process.pid,
  createdAtMs: Date.now() + 1,
  updatedAtMs: Date.now() + 1,
};
let replaced = false;
let enteredCriticalSection = false;

fs.writeFileSync(lockPath, JSON.stringify(staleOwner), 'utf8');

function installSuccessorBeforeReclaim(path) {
  if (String(path) !== lockPath || replaced) return;
  replaced = true;
  fs.writeFileSync(lockPath, JSON.stringify(successorOwner), 'utf8');
}

fs.renameSync = function patchedRenameSync(oldPath, newPath) {
  installSuccessorBeforeReclaim(oldPath);
  return originalRenameSync.call(this, oldPath, newPath);
};

fs.rmSync = function patchedRmSync(path, options) {
  installSuccessorBeforeReclaim(path);
  return originalRmSync.call(this, path, options);
};

syncBuiltinESMExports();

const { withStackDaemonLifecycleLock } = await import(${JSON.stringify(moduleUrl)});

await assert.rejects(
  () =>
    withStackDaemonLifecycleLock(
      scope,
      async () => {
        enteredCriticalSection = true;
      },
      { lockPath, timeoutMs: 80, pollIntervalMs: 10, staleAfterMs: 1 },
    ),
  /Timed out waiting for daemon lifecycle lock/,
);

assert.equal(enteredCriticalSection, false);
assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), successorOwner);
`;

    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 1_000,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

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
