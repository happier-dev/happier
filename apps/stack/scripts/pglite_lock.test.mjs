import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquirePgliteDirLock } from './utils/pglite_lock.mjs';

function lockPathForDbDir(dbDir) {
  return join(dirname(dbDir), '.happier.pglite.lock');
}

test('acquirePgliteDirLock creates and releases lock', async () => {
  const base = await mkdtemp(join(tmpdir(), 'happier-pglite-lock-'));
  const dbDir = join(base, 'pglite');
  const lockPath = lockPathForDbDir(dbDir);

  const release = await acquirePgliteDirLock(dbDir, { purpose: 'test' });
  const raw = await readFile(lockPath, 'utf-8');
  const json = JSON.parse(raw);
  assert.equal(json.pid, process.pid);
  assert.equal(json.purpose, 'test');

  await release();
  await assert.rejects(() => readFile(lockPath, 'utf-8'), /no such file|ENOENT/i);
});

test('acquirePgliteDirLock replaces stale lock (dead pid)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'happier-pglite-lock-stale-'));
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

test('acquirePgliteDirLock fails closed when lock pid is alive', async () => {
  const base = await mkdtemp(join(tmpdir(), 'happier-pglite-lock-live-'));
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
    child.kill('SIGKILL');
  }
});
