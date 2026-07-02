import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { withWorkspaceBundleLock } from './workspaceBundleLock.mjs';

test('withWorkspaceBundleLock serializes concurrent workspace bundling through a single lock', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const events = [];
    let releaseFirst = null;

    const first = withWorkspaceBundleLock(
      async () => {
        events.push('first:start');
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
        events.push('first:end');
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(events, ['first:start']);

    const second = withWorkspaceBundleLock(
      async () => {
        events.push('second:start');
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(events, ['first:start']);

    releaseFirst?.();
    await Promise.all([first, second]);

    assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock does not remove a successor owner lock while reclaiming a stale lock', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-successor-'));
  try {
    const moduleUrl = new URL('./workspaceBundleLock.mjs', import.meta.url).href;
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const lockPath = ${JSON.stringify(lockPath)};
const staleOwner = { pid: 999999, createdAtMs: Date.now() };
const successorOwner = { pid: process.pid, createdAtMs: Date.now() };

fs.writeFileSync(lockPath, JSON.stringify(staleOwner), 'utf8');

const originalRenameSync = fs.renameSync;
const originalUnlinkSync = fs.unlinkSync;
let injectedSuccessor = false;

function injectSuccessorOwner(path) {
  if (String(path) !== lockPath || injectedSuccessor) return;
  injectedSuccessor = true;
  fs.writeFileSync(lockPath, JSON.stringify(successorOwner), 'utf8');
}

fs.renameSync = function patchedRenameSync(from, to) {
  injectSuccessorOwner(from);
  return originalRenameSync.call(this, from, to);
};

fs.unlinkSync = function patchedUnlinkSync(path) {
  injectSuccessorOwner(path);
  return originalUnlinkSync.call(this, path);
};

syncBuiltinESMExports();

const { withWorkspaceBundleLock } = await import(${JSON.stringify(moduleUrl)});
let enteredCriticalSection = false;

await assert.rejects(
  () =>
    withWorkspaceBundleLock(
      async () => {
        enteredCriticalSection = true;
      },
      {
        lockPath,
        timeoutMs: 80,
        pollIntervalMs: 10,
        staleAfterMs: 120_000,
      },
    ),
  /Timed out waiting for workspace bundle lock/,
);

assert.equal(injectedSuccessor, true);
assert.equal(enteredCriticalSection, false);
const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
assert.equal(owner.pid, successorOwner.pid);
assert.equal(owner.createdAtMs, successorOwner.createdAtMs);
`;

    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      timeout: 10_000,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
