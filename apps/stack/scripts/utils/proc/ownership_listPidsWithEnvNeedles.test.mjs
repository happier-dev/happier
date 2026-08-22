import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnDetachedInlineNodeTestProcess } from '../../testkit/core/spawn_test_process.mjs';
import {
  listPidsWithEnvNeedles,
  listPidsWithEnvNeedlesAndEnvBindingNames,
  listPsPidsForEnvQueries,
  parsePsPidCommandOutputForNeedles,
  parsePsPidCommandOutputForNeedlesAndEnvBindingNames,
  textContainsNeedle,
} from './ownership.mjs';

test('listPsPidsForEnvQueries resolves multiple ownership queries from one macOS snapshot', async () => {
  let captures = 0;
  const output = [
    '101 cmd HAPPIER_STACK_ENV_FILE=/tmp/a/env HAPPIER_STACK_PROCESS_KIND=infra',
    '102 cmd HAPPIER_STACK_ENV_FILE=/tmp/a/env npm_package_name=@happier-dev/server npm_lifecycle_event=dev',
  ].join('\n');

  const result = await listPsPidsForEnvQueries([
    { needles: ['HAPPIER_STACK_ENV_FILE=/tmp/a/env', 'HAPPIER_STACK_PROCESS_KIND=infra'] },
    {
      needles: ['HAPPIER_STACK_ENV_FILE=/tmp/a/env', 'npm_package_name=@happier-dev/server'],
      bindingNames: ['npm_lifecycle_event'],
    },
  ], {
    platform: 'darwin',
    runCaptureImpl: async () => { captures += 1; return output; },
  });

  assert.equal(captures, 1);
  assert.deepEqual(result, [[101], [102]]);
});

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

test('parsePsPidCommandOutputForNeedles matches environment bindings exactly', () => {
  const output = [
    '301 cmd HAPPIER_STACK_ENV_FILE=/tmp/stack/env-old HAPPIER_STACK_PROCESS_KIND=infra',
    '302 cmd HAPPIER_HOME_DIR=/tmp/stack/cli-other HAPPIER_STACK_PROCESS_KIND=daemon',
    '303 cmd HAPPIER_STACK_ENV_FILE=/tmp/stack/env HAPPIER_STACK_PROCESS_KIND=infra',
  ].join('\n');

  assert.deepEqual(parsePsPidCommandOutputForNeedles(output, [
    'HAPPIER_STACK_ENV_FILE=/tmp/stack/env',
    'HAPPIER_STACK_PROCESS_KIND=infra',
  ]), [303]);
  assert.deepEqual(parsePsPidCommandOutputForNeedles(output, [
    'HAPPIER_HOME_DIR=/tmp/stack/cli',
    'HAPPIER_STACK_PROCESS_KIND=daemon',
  ]), []);
});

test('textContainsNeedle matches exact environment bindings in nul-delimited proc environ text', () => {
  const envText = [
    'HAPPIER_STACK_ENV_FILE=/tmp/stack/env',
    'HAPPIER_STACK_PROCESS_KIND=infra',
    'HAPPIER_HOME_DIR=/tmp/stack/cli',
  ].join('\0');

  assert.equal(textContainsNeedle(envText, 'HAPPIER_STACK_ENV_FILE=/tmp/stack/env'), true);
  assert.equal(textContainsNeedle(envText, 'HAPPIER_HOME_DIR=/tmp/stack/cli'), true);
  assert.equal(textContainsNeedle(envText, 'HAPPIER_STACK_ENV_FILE=/tmp/stack/env-old'), false);
});

test('parsePsPidCommandOutputForNeedlesAndEnvBindingNames requires binding names without pinning values', () => {
  const output = [
    '401 cmd HAPPIER_STACK_ENV_FILE=/tmp/stack/env npm_lifecycle_event=dev:light npm_package_name=@happier-dev/server',
    '402 cmd HAPPIER_STACK_ENV_FILE=/tmp/stack/env npm_package_name=@happier-dev/server',
    '403 cmd HAPPIER_STACK_ENV_FILE=/tmp/stack/env npm_lifecycle_event= npm_package_name=@happier-dev/server',
    '404 cmd HAPPIER_STACK_ENV_FILE=/tmp/stack/env-extra npm_lifecycle_event=dev:light npm_package_name=@happier-dev/server',
  ].join('\n');

  assert.deepEqual(parsePsPidCommandOutputForNeedlesAndEnvBindingNames(
    output,
    [
      'HAPPIER_STACK_ENV_FILE=/tmp/stack/env',
      'npm_package_name=@happier-dev/server',
    ],
    ['npm_lifecycle_event']
  ), [401, 403]);
});

test('listPidsWithEnvNeedles finds real stack-owned infra processes', async (t) => {
  if (process.platform === 'win32') {
    t.skip('requires posix process listing');
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-needles-live-'));
  const envPath = join(tmp, 'env');
  const child = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1000)', {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      HAPPIER_STACK_STACK: 'test-stack',
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_PROCESS_KIND: 'infra',
    },
    stdio: 'ignore',
  });

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

test('listPidsWithEnvNeedlesAndEnvBindingNames finds real processes with present env bindings', async (t) => {
  if (process.platform === 'win32') {
    t.skip('requires posix process listing');
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-needles-binding-live-'));
  const envPath = join(tmp, 'env');
  const child = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1000)', {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      HAPPIER_STACK_STACK: 'test-stack',
      HAPPIER_STACK_ENV_FILE: envPath,
      npm_lifecycle_event: 'dev:light',
      npm_package_name: '@happier-dev/server',
    },
    stdio: 'ignore',
  });

  const childPid = Number(child.pid);
  try {
    assert.ok(Number.isFinite(childPid) && childPid > 1, 'expected child pid');
    const timeoutMs = 5_000;
    const startedAt = Date.now();
    let found = [];
    while (Date.now() - startedAt < timeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      found = await listPidsWithEnvNeedlesAndEnvBindingNames([
        `HAPPIER_STACK_ENV_FILE=${envPath}`,
        'npm_package_name=@happier-dev/server',
      ], ['npm_lifecycle_event']);
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
