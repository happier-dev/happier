import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import * as dependencies from './dependency_refresh.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
async function setup(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-writer-only-refresh-' });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_DEV_TARGET_EXECUTION: '',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  delete env.HAPPIER_BUILD_DEPENDENCY_CUSTODY;
  await mkdir(fixture.path('node_modules'));
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true }));
  await writeFile(fixture.path('pnpm-lock.yaml'), '# installed A\n');
  return { fixture, env };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}



test('a detached former writer cannot bypass a later independent writer', async t => {
  const { fixture, env } = await setup(t);
  const resumeDetached = deferred(), detachedEntered = deferred();
  let detached;
  await dependencies.withDependencyRefreshLock({ installDir: fixture.root, env }, async () => {
    detached = (async () => {
      await resumeDetached.promise;
      await dependencies.withDependencyRefreshLock({ installDir: fixture.root, env }, async () => { detachedEntered.resolve(); });
    })();
  });
  let timer;
  try {
    await dependencies.withDependencyRefreshLock({ installDir: fixture.root, env }, async () => {
      resumeDetached.resolve();
      const result = await Promise.race([detachedEntered.promise.then(() => 'bypassed'),
        new Promise(resolve => { timer = setTimeout(() => resolve('waiting'), 50); })]);
      assert.equal(result, 'waiting', 'released asynchronous context grants no writer authority');
    });
    await detached;
  } finally { clearTimeout(timer); await detached; }
});

test('a second writer waits then rechecks and reuses the first installation', async t => {
  const { fixture, env } = await setup(t);
  const entered = deferred(), release = deferred();
  let installs = 0;
  const first = dependencies.withDependencyRefresh({ installDir: fixture.root, env }, async () => {
    installs++; entered.resolve(); await release.promise;
  });
  await entered.promise;
  const second = dependencies.withDependencyRefresh({ installDir: fixture.root, env }, async () => { installs++; });
  try { assert.equal(installs, 1); }
  finally { release.resolve(); }
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.refreshed, true);
  assert.equal(b.refreshed, false);
  assert.equal(installs, 1);
});

test('starter readiness waits for an active writer and consumes complete installed bytes', async t => {
  const { fixture, env } = await setup(t);
  const entered = deferred(), release = deferred();
  const sentinel = fixture.path('node_modules', 'ready.js');
  const writer = dependencies.withDependencyRefresh({ installDir: fixture.root, env }, async () => {
    await writeFile(sentinel, 'partial'); entered.resolve(); await release.promise;
    await writeFile(sentinel, 'complete');
  });
  await entered.promise;
  let consumed = false;
  const starter = dependencies.withDependencyRefresh({ installDir: fixture.root, env }, async () => assert.fail('the active writer prepares the tree'))
    .then(async () => { assert.equal(await readFile(sentinel, 'utf8'), 'complete'); consumed = true; });
  try { assert.equal(consumed, false); }
  finally { release.resolve(); }
  await Promise.all([writer, starter]);
  assert.equal(consumed, true);
});

test('nested prerequisite writers reuse only their own asynchronous writer context', { timeout: 2000 }, async t => {
  const { fixture, env } = await setup(t);
  let writes = 0;
  await dependencies.withDependencyRefreshLock({ installDir: fixture.root, env, signal: t.signal }, async () => {
    // The existing PM callback passes the writer environment to its nested
    // prerequisite owner. Reentrancy must not require inherited reader state.
    const nestedEnv = dependencies.resolveLockedInstallEnv(env);
    assert.equal(Object.hasOwn(nestedEnv, 'HAPPIER_BUILD_DEPENDENCY_CUSTODY'), false);
    await dependencies.withDependencyRefreshLock({ installDir: fixture.root, env: nestedEnv, signal: t.signal }, async () => { writes++; });
  });
  assert.equal(writes, 1);
});

test('refresh records the identity consumed before install and a later source edit requires the next refresh', async t => {
  const { fixture, env } = await setup(t);
  let installs = 0;
  await dependencies.withDependencyRefresh({ installDir: fixture.root, env }, async () => {
    installs++;
    await writeFile(fixture.path('pnpm-lock.yaml'), '# edited while installing\n');
  });
  const marker = JSON.parse(await readFile(dependencies.resolveDependencyRefreshMarkerPath(fixture.root), 'utf8'));
  assert.equal(typeof marker.identity, 'string');
  assert.deepEqual(Object.keys(marker).sort(), ['identity', 'stacksNeedingRestart', 'version']);
  assert.equal((await dependencies.inspectDependencyRefresh({ installDir: fixture.root, env })).required, true);
  await dependencies.withDependencyRefresh({ installDir: fixture.root, env }, async () => { installs++; });
  assert.equal((await dependencies.inspectDependencyRefresh({ installDir: fixture.root, env })).required, false);
  assert.equal(installs, 2);
});

test('output repair failure preserves an already-admitted marker', async t => {
  const { fixture, env } = await setup(t);
  await dependencies.withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
  const marker = dependencies.resolveDependencyRefreshMarkerPath(fixture.root);
  const before = await readFile(marker, 'utf8');
  await assert.rejects(dependencies.withDependencyRefresh({ installDir: fixture.root, env,
    onDependenciesReady: async () => { throw new Error('output prerequisite failed'); } },
  async () => assert.fail('warm output repair does not install')), /output prerequisite failed/);
  assert.equal(await readFile(marker, 'utf8'), before);
});

test('explicit no-refresh flags preserve the installed marker and skip installation', async t => {
  const { fixture, env } = await setup(t);
  await dependencies.withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
  const marker = dependencies.resolveDependencyRefreshMarkerPath(fixture.root);
  const before = await readFile(marker, 'utf8');
  await writeFile(fixture.path('pnpm-lock.yaml'), '# changed while refresh is disabled\n');
  for (const flag of ['HAPPIER_STACK_SKIP_REFRESH_DEPS', 'HAPPIER_STACK_DISABLE_REFRESH_DEPS']) {
    assert.deepEqual(await dependencies.withDependencyRefresh({ installDir: fixture.root, env: { ...env, [flag]: '1' } },
      async () => assert.fail('an explicit no-refresh flag must prevent installation')),
    { refreshed: false, reason: 'refresh-disabled' });
    assert.equal(await readFile(marker, 'utf8'), before);
  }
  assert.equal((await dependencies.inspectDependencyRefresh({ installDir: fixture.root, env })).required, true);
});

test('explicit provisioner adoption admits a new tree but never certifies mismatched or malformed existing markers', async t => {
  const { fixture, env } = await setup(t);
  const options = { installDir: fixture.root, env };
  assert.deepEqual(await dependencies.adoptDependencyInstallation(options),
    { refreshed: false, reason: 'adopted-installation' });
  await dependencies.assertDependenciesReady(options);
  const marker = dependencies.resolveDependencyRefreshMarkerPath(fixture.root);
  const before = await readFile(marker, 'utf8');
  await writeFile(fixture.path('pnpm-lock.yaml'), '# provisioner has not installed this edit\n');
  await assert.rejects(dependencies.adoptDependencyInstallation(options),
    { code: 'HAPPIER_DEPENDENCIES_NEED_REFRESH' });
  assert.equal(await readFile(marker, 'utf8'), before);
  await writeFile(marker, 'malformed existing marker');
  await assert.rejects(dependencies.adoptDependencyInstallation(options),
    { code: 'HAPPIER_DEPENDENCIES_NEED_REFRESH' });
  assert.equal(await readFile(marker, 'utf8'), 'malformed existing marker');
});

test('only successful outer writers publish completion, including same-identity forced refreshes', async t => {
  const { fixture, env } = await setup(t);
  const options = { installDir: fixture.root, env };
  const generationPath = `${dependencies.resolveDependencyRefreshLockPath(fixture.root, env)}.generation`;
  const readGeneration = async () => JSON.parse(await readFile(generationPath, 'utf8'));
  await dependencies.withDependencyRefresh(options, async () => {});
  const initial = await readGeneration();
  assert.equal(initial.completedGeneration, initial.generation);
  const markerPath = dependencies.resolveDependencyRefreshMarkerPath(fixture.root);
  const marker = await readFile(markerPath, 'utf8');
  await dependencies.withDependencyRefresh({ ...options, force: true }, async () => {});
  const forced = await readGeneration();
  assert.equal((await dependencies.readDependencyPublicationState(options)).completedGeneration, forced.completedGeneration);
  assert.notEqual(forced.completedGeneration, initial.completedGeneration);
  assert.equal(forced.completedGeneration, forced.generation);
  assert.equal(await readFile(markerPath, 'utf8'), marker,
    'same-identity refresh is observable without changing install admission');
  await dependencies.withDependencyRefreshLock(options, async () => {
    await dependencies.markDependencyMutation(options);
    await dependencies.withDependencyRefreshLock(options, async () => {
      await dependencies.markDependencyMutation(options);
    });
    assert.equal((await readGeneration()).completedGeneration, forced.completedGeneration,
      'nested prerequisite completion cannot publish before its containing writer succeeds');
  });
  const nested = await readGeneration();
  assert.equal(nested.completedGeneration, nested.generation);
  assert.notEqual(nested.completedGeneration, forced.completedGeneration);
  for (const phase of ['install', 'outputs']) {
    if (phase === 'outputs') await dependencies.withDependencyRefresh(options, async () => {});
    const beforeFailure = await readGeneration();
    let outputFailureReached = false;
    await assert.rejects(dependencies.withDependencyRefresh({ ...options, force: phase === 'install',
      onDependenciesReady: phase === 'outputs' ? async () => {
        outputFailureReached = true;
        await dependencies.markDependencyMutation(options);
        throw new Error('K1 repair failed');
      } : null },
    async () => {
      assert.equal(phase, 'install', 'a warm K1 repair must reach its own failure without reinstalling');
      throw new Error('installation failed');
    }));
    assert.equal(outputFailureReached, phase === 'outputs');
    const failed = await readGeneration();
    assert.notEqual(failed.generation, beforeFailure.generation);
    assert.equal(failed.completedGeneration, beforeFailure.completedGeneration,
      'a failed installation or K1 repair does not publish success');
  }
  const beforeNoop = await readFile(generationPath, 'utf8');
  await dependencies.withDependencyRefreshLock(options, async () => {});
  assert.equal(await readFile(generationPath, 'utf8'), beforeNoop,
    'read-only writer scopes do not rewrite completion state');
});

test('a same-identity partial forced install preserves its marker and the next ordinary command reinstalls and recovers', async t => {
  const { fixture, env } = await setup(t);
  const options = { installDir: fixture.root, env };
  const output = fixture.path('node_modules', 'installed.js');
  await dependencies.withDependencyRefresh(options, async () => { await writeFile(output, 'complete'); });
  const markerPath = dependencies.resolveDependencyRefreshMarkerPath(fixture.root);
  const marker = await readFile(markerPath, 'utf8');
  await assert.rejects(dependencies.withDependencyRefresh({ ...options, force: true }, async () => {
    // A real installer subprocess can fail after it has linked some bytes.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import { writeFile } from 'node:fs/promises'; await writeFile(process.argv[1], 'partial'); process.exitCode = 2;", output],
    { encoding: 'utf8' });
    if (child.error) throw child.error;
    assert.equal(child.status, 2);
    throw new Error('installer subprocess failed after linking');
  }), { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED' });
  assert.equal(await readFile(markerPath, 'utf8'), marker);
  assert.equal(await readFile(output, 'utf8'), 'partial');
  assert.equal((await dependencies.inspectDependencyRefresh(options)).required, true,
    'the uncompleted writer attempt makes an unchanged install identity stale');
  let reinstalls = 0;
  const recovered = await dependencies.withDependencyRefresh(options, async () => {
    reinstalls++;
    await writeFile(output, 'complete');
  });
  assert.equal(recovered.refreshed, true);
  assert.equal(reinstalls, 1);
  assert.equal(await readFile(output, 'utf8'), 'complete');
  assert.equal((await dependencies.inspectDependencyRefresh(options)).required, false);
});

test('explicit adoption refuses an unfinished installation even without a prior marker', async t => {
  const { fixture, env } = await setup(t);
  const options = { installDir: fixture.root, env };
  await assert.rejects(dependencies.withDependencyRefresh(options, async () => {
    throw new Error('cold installer failed');
  }), { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED' });
  await assert.rejects(readFile(dependencies.resolveDependencyRefreshMarkerPath(fixture.root)), { code: 'ENOENT' });
  await assert.rejects(dependencies.adoptDependencyInstallation(options), { code: 'HAPPIER_DEPENDENCIES_NEED_REFRESH' });
});
