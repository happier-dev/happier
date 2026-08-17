import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { pruneStackRunnerLogs } from './runner_log_retention.mjs';

test('runner log retention preserves the active runner, newest bounded history, and unrelated logs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runner-log-retention-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });

  const oldest = join(root, 'dev.100.log');
  const active = join(root, 'dev.200.log');
  const newest = join(root, 'run.300.log');
  const unrelated = join(root, 'server.log');
  await writeFile(oldest, 'oldest');
  await writeFile(active, 'active');
  await writeFile(newest, 'newest');
  await writeFile(unrelated, 'server');

  const result = await pruneStackRunnerLogs({
    logsDir: root,
    preservePaths: [active],
    keepCount: 1,
    maxTotalBytes: 1024,
  });

  assert.deepEqual(result.removedPaths, [oldest]);
  assert.deepEqual((await readdir(root)).sort(), [
    'dev.200.log',
    'run.300.log',
    'server.log',
  ]);
  assert.equal(await readFile(active, 'utf8'), 'active');
  assert.equal(await readFile(unrelated, 'utf8'), 'server');
});

test('runner log retention keeps one newest runner even when it exceeds the byte budget', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runner-log-budget-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'dev.100.log'), 'older');
  await writeFile(join(root, 'dev.200.log'), 'newest-is-larger-than-budget');

  await pruneStackRunnerLogs({
    logsDir: root,
    keepCount: 8,
    maxTotalBytes: 1,
  });

  assert.deepEqual(await readdir(root), ['dev.200.log']);
});
