// @happier-test-preparation source
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { inspectDependencyRefresh, readDependencyPublicationState, resolveDependencyRefreshMarkerPath,
  withDependencyRefresh } from './dependency_refresh.mjs';

const execFileAsync = promisify(execFile);
const ownerUrl = new URL('./dependency_refresh.mjs', import.meta.url).href;

async function setup(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-refresh-process-lifecycle-' });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_DEV_TARGET_EXECUTION: '',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  delete env.HAPPIER_BUILD_DEPENDENCY_CUSTODY;
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await mkdir(fixture.path('node_modules'));
  const options = { installDir: fixture.root, env, signal: t.signal };
  await withDependencyRefresh(options, () => writeFile(fixture.path('node_modules', 'installed.js'), 'complete'));
  return { fixture, env, options };
}

test('a restarted dependency consumer reuses an existing completed installation without republishing', async t => {
  const { fixture, env, options } = await setup(t);
  const markerPath = resolveDependencyRefreshMarkerPath(fixture.root);
  const marker = await readFile(markerPath, 'utf8');
  const publication = await readDependencyPublicationState(options);
  await execFileAsync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { assertDependenciesReady, withDependencyConsumption, withDependencyRefresh }
      from ${JSON.stringify(ownerUrl)};
    const options = { installDir: process.argv[1], env: process.env };
    await assertDependenciesReady(options);
    assert.deepEqual(await withDependencyRefresh(options, () => assert.fail('completed installation reinstalled')),
      { refreshed: false, reason: 'up-to-date' });
    assert.equal(await withDependencyConsumption(options,
      () => readFile(process.argv[1] + '/node_modules/installed.js', 'utf8')), 'complete');
  `, fixture.root], { env, signal: t.signal });
  assert.equal(await readFile(markerPath, 'utf8'), marker);
  assert.deepEqual(await readDependencyPublicationState(options), publication,
    'a fresh consumer must not publish a replacement generation');
});

test('a restarted dependency owner refuses and repairs bytes left by an installer process exit', async t => {
  const { fixture, env, options } = await setup(t);
  const markerPath = resolveDependencyRefreshMarkerPath(fixture.root);
  const marker = await readFile(markerPath, 'utf8');
  const publication = await readDependencyPublicationState(options);
  // Exit inside the real writer, leaving both its owner file and unpublished
  // mutation on disk. This differs from a rejected callback with normal cleanup.
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { writeFile } from 'node:fs/promises';
    import { withDependencyRefresh } from ${JSON.stringify(ownerUrl)};
    await withDependencyRefresh({ installDir: process.argv[1], env: process.env, force: true }, async () => {
      await writeFile(process.argv[1] + '/node_modules/installed.js', 'partial');
      process.exit(23);
    });
  `, fixture.root], { env, encoding: 'utf8' });
  if (crashed.error) throw crashed.error;
  assert.equal(crashed.status, 23);
  assert.equal(await readFile(markerPath, 'utf8'), marker);
  assert.equal(await readFile(fixture.path('node_modules', 'installed.js'), 'utf8'), 'partial');
  assert.equal((await inspectDependencyRefresh(options)).required, true,
    'a completed marker cannot certify an interrupted same-identity installation');
  await execFileAsync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { readFile, writeFile } from 'node:fs/promises';
    import { assertDependenciesReady, waitForDependencyRefresh, withDependencyConsumption, withDependencyRefresh }
      from ${JSON.stringify(ownerUrl)};
    const options = { installDir: process.argv[1], env: process.env };
    await assert.rejects(waitForDependencyRefresh(options),
      { code: 'HAPPIER_DEPENDENCIES_NEED_REFRESH', reason: 'unfinished-installation' });
    assert.equal((await withDependencyRefresh(options,
      () => writeFile(process.argv[1] + '/node_modules/installed.js', 'complete'))).refreshed, true);
    await assertDependenciesReady(options);
    assert.equal(await withDependencyConsumption(options,
      () => readFile(process.argv[1] + '/node_modules/installed.js', 'utf8')), 'complete');
  `, fixture.root], { env, signal: t.signal });
  assert.equal((await inspectDependencyRefresh(options)).required, false);
  assert.equal(await readFile(fixture.path('node_modules', 'installed.js'), 'utf8'), 'complete');
  const recovered = await readDependencyPublicationState(options);
  assert.equal(recovered.generation, recovered.completedGeneration);
  assert.notEqual(recovered.completedGeneration, publication.completedGeneration);
});
