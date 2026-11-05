import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { sanitizeStackTestRunnerEnv } from '../test/test_env.mjs';
import { prepareDependencyConsumersForRefresh } from './dependency_consumers.mjs';
import { withDependencyRefresh } from './dependency_refresh.mjs';

test('dependency consumer inventory permits pending starts and foreign legacy Expo without process mutation', { timeout: 10000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-refresh-consumers-' });
  const stacks = fixture.path('stacks');
  const installDir = fixture.path('repo');
  await mkdir(join(installDir, 'node_modules'), { recursive: true });
  await writeFile(join(installDir, 'package.json'), '{"private":true}');
  for (const name of ['starting', 'serving', 'stopped']) {
    const base = join(stacks, name);
    await mkdir(join(base, 'source-runtime'), { recursive: true });
    await mkdir(join(base, 'expo-dev', 'legacy'), { recursive: true });
    await writeFile(join(base, 'env'), `HAPPIER_STACK_REPO_DIR=${installDir}\n`);
    await writeFile(join(base, 'stack.runtime.json'), JSON.stringify({ ownerPid: name === 'stopped' ? null : process.pid }));
    if (name === 'starting') await writeFile(join(base, 'source-runtime/start.pending.json'), JSON.stringify({ phase: 'preparing', pid: process.pid }));
    if (name === 'serving') await writeFile(join(base, 'expo-dev/legacy/expo.state.json'), JSON.stringify({ pid: process.pid, uiDir: installDir, stackName: 'foreign' }));
  }
  const env = {
    ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root }),
    HAPPIER_STACK_STORAGE_DIR: stacks, HAPPIER_STACK_HOME_DIR: fixture.path('home'),
    HAPPIER_STACK_ENV_FILE: '', HAPPIER_STACK_STACK: '',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0',
  };
  const result = await prepareDependencyConsumersForRefresh({ installDir, env });
  assert.deepEqual(result.stacksNeedingRestart, ['serving', 'starting']);
  const statePaths = ['starting', 'serving', 'stopped'].map(name => join(stacks, name, 'stack.runtime.json'));
  statePaths.push(join(stacks, 'starting', 'source-runtime/start.pending.json'), join(stacks, 'serving', 'expo-dev/legacy/expo.state.json'));
  const before = await Promise.all(statePaths.map(path => readFile(path, 'utf8')));
  let installs = 0;
  const refreshed = await withDependencyRefresh({ installDir, env, signal: t.signal }, async () => { installs++; });
  assert.equal(installs, 1, 'producer installation must not depend on its pending Expo borrower becoming ready');
  assert.equal(refreshed.refreshed, true);
  assert.deepEqual(refreshed.stacksNeedingRestart, ['serving', 'starting']);
  assert.deepEqual(await Promise.all(statePaths.map(path => readFile(path, 'utf8'))), before,
    'refresh leaves consumer lifecycle and pending-readiness records unchanged');
});
