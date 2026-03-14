import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { acquireRuntimeBuildLock } from './runtime_build_lock.mjs';

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPidExit(pid, { timeoutMs = 5_000, pollMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(pollMs);
  }
  return !isPidAlive(pid);
}

async function terminateChildProcessAndWait(child, { timeoutMs = 5_000 } = {}) {
  const pid = Number(child?.pid);
  if (!Number.isFinite(pid) || pid <= 1) return;
  if (!isPidAlive(pid)) return;

  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }
  if (await waitForPidExit(pid, { timeoutMs: Math.floor(timeoutMs / 2), pollMs: 25 })) return;

  try {
    child.kill('SIGKILL');
  } catch {
    // ignore
  }
  const exited = await waitForPidExit(pid, { timeoutMs: Math.floor(timeoutMs / 2), pollMs: 25 });
  assert.equal(exited, true, `expected child pid ${pid} to exit after termination`);
}

test('acquireRuntimeBuildLock replaces a stale dead-pid lock', async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'happier-runtime-build-lock-stale-'));
  const lockPath = join(runtimeDir, 'build.lock');

  t.after(async () => {
    await rm(runtimeDir, { recursive: true, force: true });
  });

  await writeFile(lockPath, JSON.stringify({ pid: 999999, createdAt: '2026-03-07T00:00:00.000Z' }) + '\n', 'utf-8');

  const release = await acquireRuntimeBuildLock({ lockPath });
  const raw = await readFile(lockPath, 'utf-8');
  const json = JSON.parse(raw);

  assert.equal(json.pid, process.pid);
  assert.ok(typeof json.createdAt === 'string' && json.createdAt.length > 0);

  await release();
});

test('acquireRuntimeBuildLock fails closed when a live pid owns the lock', async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'happier-runtime-build-lock-live-'));
  const lockPath = join(runtimeDir, 'build.lock');

  t.after(async () => {
    await rm(runtimeDir, { recursive: true, force: true });
  });

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  assert.ok(child.pid && child.pid > 1);

  try {
    await writeFile(lockPath, JSON.stringify({ pid: child.pid, createdAt: '2026-03-07T00:00:00.000Z' }) + '\n', 'utf-8');

    await assert.rejects(
      () => acquireRuntimeBuildLock({ lockPath }),
      /runtime build is already in progress .*pid=/i,
    );
  } finally {
    await terminateChildProcessAndWait(child);
  }
});
