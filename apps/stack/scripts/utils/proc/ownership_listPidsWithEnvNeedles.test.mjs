import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listPidsWithEnvNeedles, parsePsPidCommandOutputForNeedles } from './ownership.mjs';

test('parsePsPidCommandOutputForNeedles requires all needles to match', () => {
  const output = [
    '101 node server.js HAPPIER_STACK_ENV_FILE=/tmp/a/env HAPPIER_STACK_PROCESS_KIND=infra',
    '102 node server.js HAPPIER_STACK_ENV_FILE=/tmp/a/env HAPPIER_STACK_PROCESS_KIND=session',
    '103 node server.js HAPPIER_STACK_ENV_FILE=/tmp/b/env HAPPIER_STACK_PROCESS_KIND=infra',
  ].join('\n');

  const pids = parsePsPidCommandOutputForNeedles(output, [
    'HAPPIER_STACK_ENV_FILE=/tmp/a/env',
    'HAPPIER_STACK_PROCESS_KIND=infra',
  ]);

  assert.deepEqual(pids, [101]);
});

test('parsePsPidCommandOutputForNeedles deduplicates matches and ignores invalid pid lines', () => {
  const output = [
    '201 cmd HAPPIER_STACK_ENV_FILE=/tmp/x/env HAPPIER_STACK_PROCESS_KIND=infra',
    'not-a-pid cmd HAPPIER_STACK_ENV_FILE=/tmp/x/env HAPPIER_STACK_PROCESS_KIND=infra',
    '201 cmd HAPPIER_STACK_ENV_FILE=/tmp/x/env HAPPIER_STACK_PROCESS_KIND=infra',
    '1 cmd HAPPIER_STACK_ENV_FILE=/tmp/x/env HAPPIER_STACK_PROCESS_KIND=infra',
  ].join('\n');

  const pids = parsePsPidCommandOutputForNeedles(output, [
    'HAPPIER_STACK_ENV_FILE=/tmp/x/env',
    'HAPPIER_STACK_PROCESS_KIND=infra',
  ]);

  assert.deepEqual(pids, [201]);
});

test('listPidsWithEnvNeedles finds real stack-owned infra processes', async (t) => {
  if (process.platform === 'win32') {
    t.skip('requires posix process listing');
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-needles-live-'));
  const envPath = join(tmp, 'env');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      HAPPIER_STACK_STACK: 'test-stack',
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'infra',
    },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();

  const childPid = Number(child.pid);
  try {
    assert.ok(Number.isFinite(childPid) && childPid > 1, 'expected child pid');
    const needles = [
      `HAPPIER_STACK_ENV_FILE=${envPath}`,
      'HAPPIER_STACK_PROCESS_KIND=infra',
    ];
    const timeoutMs = 5_000;
    const startedAt = Date.now();
    let found = [];
    while (Date.now() - startedAt < timeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      found = await listPidsWithEnvNeedles(needles);
      if (found.includes(childPid)) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.ok(found.includes(childPid), `expected pid ${childPid} in ${JSON.stringify(found)}`);
  } finally {
    try {
      process.kill(-childPid, 'SIGKILL');
    } catch {
      // ignore
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});
