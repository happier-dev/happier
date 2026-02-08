import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquirePgliteDirLock } from './utils/pglite_lock.mjs';

function lockPathForDbDir(dbDir) {
  return join(dirname(dbDir), '.happier.pglite.lock');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

test('acquirePgliteDirLock creates and releases lock', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'happier-pglite-lock-'));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  const dbDir = join(base, 'pglite');
  const lockPath = lockPathForDbDir(dbDir);

  const release = await acquirePgliteDirLock(dbDir, { purpose: 'test' });
  const raw = await readFile(lockPath, 'utf-8');
  const json = JSON.parse(raw);
  assert.equal(json.pid, process.pid);
  assert.equal(json.purpose, 'test');
  assert.equal(json.psEnvLine, undefined);
  assert.ok(typeof json.pidStartTime === 'string' && json.pidStartTime.length > 0);

  await release();
  await assert.rejects(() => readFile(lockPath, 'utf-8'), /no such file|ENOENT/i);
});

test('acquirePgliteDirLock replaces stale lock (dead pid)', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'happier-pglite-lock-stale-'));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  const dbDir = join(base, 'pglite');
  const lockPath = lockPathForDbDir(dbDir);

  await writeFile(
    lockPath,
    JSON.stringify({ pid: 999999, createdAt: new Date().toISOString(), purpose: 'stale', dbDir }) + '\n',
    'utf-8'
  );

  const release = await acquirePgliteDirLock(dbDir, { purpose: 'fresh' });
  const raw = await readFile(lockPath, 'utf-8');
  const json = JSON.parse(raw);
  assert.equal(json.pid, process.pid);
  assert.equal(json.purpose, 'fresh');
  await release();
});

test('acquirePgliteDirLock fails closed when lock pid is alive', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'happier-pglite-lock-live-'));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  const dbDir = join(base, 'pglite');
  const lockPath = lockPathForDbDir(dbDir);

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  assert.ok(child.pid && child.pid > 1);

  try {
    await writeFile(
      lockPath,
      JSON.stringify({ pid: child.pid, createdAt: new Date().toISOString(), purpose: 'live', dbDir }) + '\n',
      'utf-8'
    );

    await assert.rejects(() => acquirePgliteDirLock(dbDir, { purpose: 'should-fail' }), /in use by pid=/i);
  } finally {
    await terminateChildProcessAndWait(child);
  }
});

test('acquirePgliteDirLock replaces lock when pid is alive but the start-time fingerprint mismatches', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'happier-pglite-lock-mismatch-'));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  const dbDir = join(base, 'pglite');
  const lockPath = lockPathForDbDir(dbDir);

  const originalCreatedAt = '2000-01-01T00:00:00.000Z';
  await writeFile(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      createdAt: originalCreatedAt,
      purpose: 'mismatch',
      dbDir,
      pidStartTime: 'Mon Jan 01 00:00:00 1990',
    }) + '\n',
    'utf-8'
  );

  const release = await acquirePgliteDirLock(dbDir, { purpose: 'fresh' });
  const raw = await readFile(lockPath, 'utf-8');
  const json = JSON.parse(raw);
  assert.equal(json.pid, process.pid);
  assert.equal(json.purpose, 'fresh');
  assert.notEqual(json.createdAt, originalCreatedAt);

  await release();
});
