// @happier-test-preparation source
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { resolveDependencyRefreshLockPath } from '../proc/dependency_refresh.mjs';

test('remote custody retains the installed generation using the dispatched Node with no usable node on PATH', { skip: process.platform === 'win32' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-remote-retention-' });
  const scripts = [
    'dev_targets/remote_execution_custody.sh', 'dev_targets/native_execution_signals.sh',
    'proc/native_process_identity.sh', 'proc/native_process_priority.sh',
  ];
  await Promise.all(scripts.map(async script => {
    const destination = fixture.path('apps/stack/scripts/utils', script);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(new URL(`../${script}`, import.meta.url), destination);
  }));
  const generation = 'g000000001-0000abcd';
  await mkdir(fixture.path('node_modules'));
  await symlink(`../.happier/deps/node_modules/${generation}/node_modules`, fixture.path('node_modules/.happier-dependency-generation'));
  const retain = new URL('../proc/retain_dependency_generation.mjs', import.meta.url);
  await writeFile(fixture.path('apps/stack/scripts/utils/proc/retain_dependency_generation.mjs'), `import ${JSON.stringify(retain.href)};\n`);
  const { binDir } = writeFakeBin({ root: fixture.root, name: 'node', content: '#!/bin/sh\necho "node: command not found" >&2\nexit 127\n' });
  const env = { ...process.env, PATH: `${binDir}:/usr/bin:/bin`, HAPPIER_STACK_HOME_DIR: fixture.path('home'),
    HAPPIER_REMOTE_EXEC_NODE: process.execPath };
  const pidFile = fixture.path('job.pid');
  const result = spawnSync('/bin/bash', [
    fixture.path('apps/stack/scripts/utils/dev_targets/remote_execution_custody.sh'), 'payload', pidFile, 'retention',
    String(process.pid), '-', '/bin/sh', '-c', 'echo ok',
  ], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'ok');
  assert.doesNotMatch(result.stderr, /node: command not found|dependency generation retention failed/);
  const [, payloadPid] = (await readFile(pidFile, 'utf8')).split('\n');
  const readers = `${resolveDependencyRefreshLockPath(fixture.root, env)}.readers`;
  const [record] = await readdir(readers);
  assert.deepEqual(JSON.parse(await readFile(join(readers, record), 'utf8')), { pid: Number(payloadPid), generation });
});
