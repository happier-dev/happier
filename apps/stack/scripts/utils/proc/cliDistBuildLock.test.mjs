import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  DEFAULT_CLI_DIST_BUILD_LOCK_TIMEOUT_MS,
  loadWorkspaceBundleLockModule,
  withCliDistBuildLock,
} from './cliDistBuildLock.mjs';

test('default CLI dist lock budget covers long current-byte workspace publishers', () => {
  assert.ok(
    DEFAULT_CLI_DIST_BUILD_LOCK_TIMEOUT_MS >= 30 * 60_000,
    'source-dev workspace publishers can legitimately hold the shared CLI dist lock for more than four minutes under concurrent load',
  );
});

test('workspace lock loader rejects mounted modules without the canonical timeout owner', async () => {
  const canonicalSourceModule = {
    DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS: 30 * 60_000,
    WORKSPACE_BUNDLE_LOCK_TIMEOUT_ERROR_CODE: 'EWORKSPACEBUNDLELOCKTIMEOUT',
    observeWorkspaceBundleLock() {},
  };
  const mountedBase = {
    WORKSPACE_BUNDLE_LOCK_TIMEOUT_ERROR_CODE: 'EWORKSPACEBUNDLELOCKTIMEOUT',
    isWorkspaceBundleLockActive() {},
    observeWorkspaceBundleLock() {},
    resolveWorkspaceBundleLockPath() {},
    withWorkspaceBundleLock() {},
  };

  for (const invalidTimeout of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    let sourceLoads = 0;
    const mountedModule = {
      ...mountedBase,
      ...(invalidTimeout === undefined
        ? {}
        : { DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS: invalidTimeout }),
    };
    const selected = await loadWorkspaceBundleLockModule({
      importPackageModule: async () => mountedModule,
      sourceModulePath: '/canonical/workspaceBundleLock.mjs',
      existsSyncImpl: () => true,
      importModule: async () => {
        sourceLoads += 1;
        return canonicalSourceModule;
      },
    });
    assert.equal(selected, canonicalSourceModule);
    assert.equal(sourceLoads, 1);
  }

  const validMountedModule = {
    ...mountedBase,
    DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS: 30 * 60_000,
  };
  const selected = await loadWorkspaceBundleLockModule({
    importPackageModule: async () => validMountedModule,
    sourceModulePath: '/canonical/workspaceBundleLock.mjs',
    existsSyncImpl: () => true,
    importModule: async () => {
      throw new Error('valid mounted owner must not fall back to source');
    },
  });
  assert.equal(selected, validMountedModule);
});

test('withCliDistBuildLock permits reentry only with the current owner lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-cli-dist-lock-reentry-'));
  try {
    const lockPath = join(root, 'cli-dist-build.lock');
    const result = await withCliDistBuildLock(
      async ({ heldLockValue }) =>
        await withCliDistBuildLock(
          async () => 'nested',
          {
            lockPath,
            heldLockValue,
            timeoutMs: 60,
            pollIntervalMs: 10,
            staleAfterMs: 1_000,
          },
        ),
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );

    assert.equal(result, 'nested');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('withCliDistBuildLock reclaims a fresh lock from a dead owner pid immediately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-cli-dist-lock-'));
  const lockPath = join(root, 'cli-dist-build.lock');

  try {
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 999999,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      }),
      'utf8',
    );

    const result = await withCliDistBuildLock(
      async () => {
        const owner = JSON.parse(await readFile(lockPath, 'utf8'));
        assert.equal(owner.pid, process.pid);
        return 'ok';
      },
      {
        lockPath,
        timeoutMs: 200,
        pollIntervalMs: 10,
        staleAfterMs: 120_000,
      },
    );

    assert.equal(result, 'ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('withCliDistBuildLock reports wait progress while a live owner holds the lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-cli-dist-lock-wait-'));
  const lockPath = join(root, 'cli-dist-build.lock');
  const waitEvents = [];

  try {
    const holder = withCliDistBuildLock(
      async () => {
        await delay(40);
        return 'held';
      },
      {
        lockPath,
        timeoutMs: 500,
        pollIntervalMs: 10,
        staleAfterMs: 120_000,
      },
    );

    while (true) {
      try {
        const owner = JSON.parse(await readFile(lockPath, 'utf8'));
        assert.equal(owner.pid, process.pid);
        break;
      } catch {
        await delay(1);
      }
    }

    const result = await withCliDistBuildLock(
      async ({ waited }) => {
        assert.equal(waited, true);
        return 'ok';
      },
      {
        lockPath,
        timeoutMs: 500,
        pollIntervalMs: 10,
        staleAfterMs: 120_000,
        onWait: (event) => {
          waitEvents.push(event);
        },
      },
    );

    assert.equal(result, 'ok');
    assert.ok(waitEvents.length >= 1);
    assert.equal(waitEvents[0].lockPath, lockPath);
    assert.equal(waitEvents[0].owner.pid, process.pid);

    await holder;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('withCliDistBuildLock does not reclaim an old lock while the owner pid is alive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-cli-dist-lock-live-owner-'));
  const lockPath = join(root, 'cli-dist-build.lock');
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
        withCliDistBuildLock(
          async () => {
            enteredCriticalSection = true;
          },
          {
            lockPath,
            timeoutMs: 60,
            pollIntervalMs: 10,
            staleAfterMs: 10,
          },
        ),
      /Timed out waiting for CLI dist build lock/,
    );

    assert.equal(enteredCriticalSection, false);
    assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), owner);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('withCliDistBuildLock does not heartbeat over or unlink a successor owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-cli-dist-lock-successor-'));
  const lockPath = join(root, 'cli-dist-build.lock');
  const successorOwner = {
    pid: process.pid + 1_000_000,
    createdAtMs: Date.now() + 1,
    updatedAtMs: Date.now() + 1,
  };

  try {
    await withCliDistBuildLock(
      async () => {
        await writeFile(lockPath, JSON.stringify(successorOwner), 'utf8');
        await delay(620);
        assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), successorOwner);
      },
      {
        lockPath,
        timeoutMs: 500,
        pollIntervalMs: 10,
        staleAfterMs: 20,
      },
    );

    assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), successorOwner);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('withCliDistBuildLock does not delete a successor owner during stale-owner reclaim', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-cli-dist-lock-reclaim-race-'));
  try {
    const moduleUrl = new URL('./cliDistBuildLock.mjs', import.meta.url).href;
    const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const originalRenameSync = fs.renameSync;
const originalRmSync = fs.rmSync;
const lockPath = join(${JSON.stringify(tmp)}, 'cli-dist-build.lock');
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

const { withCliDistBuildLock } = await import(${JSON.stringify(moduleUrl)});

await assert.rejects(
  () =>
    withCliDistBuildLock(
      async () => {
        enteredCriticalSection = true;
      },
      {
        lockPath,
        timeoutMs: 80,
        pollIntervalMs: 10,
        staleAfterMs: 1,
      },
    ),
  /Timed out waiting for CLI dist build lock/,
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

test('withCliDistBuildLock removes and reacquires the lock after cleanup on Windows-shaped filesystems', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-cli-dist-lock-cleanup-'));
  try {
    const moduleUrl = new URL('./cliDistBuildLock.mjs', import.meta.url).href;
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

const { withCliDistBuildLock } = await import(${JSON.stringify(moduleUrl)});
const lockPath = join(${JSON.stringify(tmp)}, 'locks', 'cli-dist-build.lock');

await withCliDistBuildLock(
  async () => {},
  { lockPath, timeoutMs: 50, pollIntervalMs: 5, staleAfterMs: 50 },
);

await withCliDistBuildLock(
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
