import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { beginPendingSourceStart, readPendingSourcePreparation, SOURCE_START_SUPERSEDED_MARKER } from './pending_source_start.mjs';
import { fileURLToPath } from 'node:url';
import { sanitizeStackTestRunnerEnv } from '../../utils/test/test_env.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { runNodeCapture } from '../../testkit/core/run_node_capture.mjs';
import { withJsonOwnerFileLock } from '../../utils/proc/jsonOwnerFileLock.mjs';
import { withDependencyRefresh } from '../../utils/proc/dependency_refresh.mjs';

test('source preparation can register after a failed install so its producer can repair it', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-pending-install-retry-', registerCleanup: false });
  const repoDir = fixture.path('repo');
  const stackBaseDir = fixture.path('stacks', 'preparing');
  let start;
  t.after(async () => { await start?.dispose(); await fixture.cleanup(); });
  for (const project of ['cli', 'ui']) {
    await mkdir(join(repoDir, 'apps', project), { recursive: true });
    await writeFile(join(repoDir, 'apps', project, 'package.json'), JSON.stringify({ name: `@fixture/${project}` }));
  }
  await mkdir(join(repoDir, 'packages'));
  await mkdir(join(repoDir, 'node_modules'));
  const env = sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root, repoDir });
  await assert.rejects(withDependencyRefresh({ installDir: repoDir, force: true, env }, async () => {
    throw Object.assign(new Error('ERR_PNPM_OUTDATED_LOCKFILE'), { code: 'ERR_PNPM_OUTDATED_LOCKFILE' });
  }), { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED', pnpmErrorCode: 'ERR_PNPM_OUTDATED_LOCKFILE' });

  start = await beginPendingSourceStart({ stackBaseDir, repoDir, env });
  assert.deepEqual(await readPendingSourcePreparation({ stackBaseDir }), { phase: 'preparing' });
});

test('real source runner keeps its pending marker through server spawn and cleans up failed readiness', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-start-readiness-' });
  const stackName = 'readiness';
  const stackBaseDir = fixture.path('stacks', stackName);
  const fakeRepo = fixture.path('repo');
  const bundle = fixture.path('stacks', 'source-bundles', 'retained');
  const serverDir = join(bundle, 'apps', 'server');
  const entrypoint = join(serverDir, 'src', 'index.mjs');
  const pendingPath = join(stackBaseDir, 'source-runtime', 'start.pending.json');
  const observation = fixture.path('spawn-observation.json');
  await mkdir(join(stackBaseDir, 'source-runtime'), { recursive: true });
  await mkdir(join(serverDir, 'src'), { recursive: true });
  await mkdir(join(fakeRepo, 'node_modules'), { recursive: true });
  for (const name of ['server', 'cli', 'ui']) {
    await mkdir(join(fakeRepo, 'apps', name), { recursive: true });
    await writeFile(join(fakeRepo, 'apps', name, 'package.json'), JSON.stringify({ name, private: true }));
  }
  await writeFile(join(fakeRepo, 'package.json'), JSON.stringify({ private: true }));
  await writeFile(join(fakeRepo, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({ type: 'module' }));
  // Only the server executable is replaced. The real runner, pending owner,
  // runtime publication, spawn and child-bound readiness remain composed.
  await writeFile(entrypoint, `import { existsSync, writeFileSync } from 'node:fs';
    import { withDependencyRefreshLock } from ${JSON.stringify(new URL('../../utils/proc/dependency_refresh.mjs', import.meta.url).href)};
    import { prepareDependencyConsumersForRefresh } from ${JSON.stringify(new URL('../../utils/proc/dependency_consumers.mjs', import.meta.url).href)};
    let refreshCode = null;
    try {
      await withDependencyRefreshLock({ installDir: ${JSON.stringify(fakeRepo)}, env: process.env },
        () => prepareDependencyConsumersForRefresh({ installDir: ${JSON.stringify(fakeRepo)}, env: process.env }));
    } catch (error) { refreshCode = error.code; }
    writeFileSync(${JSON.stringify(observation)}, JSON.stringify({ pending: existsSync(${JSON.stringify(pendingPath)}), refreshCode }));
    process.exit(9);
  `);
  await writeFile(join(bundle, 'source-bundle.json'), JSON.stringify({ identity: 'retained',
    entrypoint, serverDir, serverComponent: 'happier-server-light', dbProvider: 'sqlite', env: {}, args: [] }));
  await writeFile(join(stackBaseDir, 'source-runtime', 'selected-server.json'), JSON.stringify({ entrypoint }));
  const envPath = join(stackBaseDir, 'env');
  await writeFile(envPath, `HAPPIER_STACK_REPO_DIR=${fakeRepo}\n`);
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const result = await runNodeCapture([fileURLToPath(new URL('../../run.mjs', import.meta.url)),
    '--runtime=source', '--reuse-source-runtime', '--no-dev-targets', '--no-daemon', '--no-ui', '--no-browser'], {
    env: { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root, repoDir: fakeRepo }),
      HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'), HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath, HAPPIER_STACK_RUNTIME_STATE_PATH: join(stackBaseDir, 'stack.runtime.json'),
      HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light', HAPPIER_DB_PROVIDER: 'sqlite',
      HAPPIER_STACK_SERVER_PORT: String(port), HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
      HAPPIER_STACK_PRISMA_MIGRATE: '0', HAPPIER_STACK_AUTO_AUTH_SEED: '0',
      HAPPIER_STACK_MIGRATE_CREDENTIALS: '0', HAPPIER_STACK_TAILSCALE_SERVE: '0',
      HAPPIER_DEV_TARGET_EXECUTION: '1', CI: '1' },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr + result.stdout, /exited before becoming ready/i);
  await assert.rejects(readFile(pendingPath), { code: 'ENOENT' });
  // Once startup cleanup retires the marker, live runtime membership is
  // advisory. Exercise the real dependency writer at that lifecycle seam.
  await writeFile(join(stackBaseDir, 'stack.runtime.json'), JSON.stringify({ stackName, ownerPid: process.pid }));
  const outcome = await withDependencyRefresh({ installDir: fakeRepo, force: true,
    env: { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root,
      HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'), HAPPIER_STACK_ENV_FILE: '',
      HAPPIER_STACK_PM_CACHE_BASE_DIR: fixture.path('cache'), HAPPIER_STACK_REPO_DIR: fakeRepo } }, async () => {})
    .then(refreshed => ({ refreshed: refreshed.refreshed, stacksNeedingRestart: refreshed.stacksNeedingRestart }),
      error => ({ code: error.code }));
  assert.deepEqual({ atSpawn: JSON.parse(await readFile(observation, 'utf8')), afterStartup: outcome }, {
    atSpawn: { pending: true, refreshCode: 'HAPPIER_DEPENDENCY_STACK_START_IN_PROGRESS' },
    afterStartup: { refreshed: true, stacksNeedingRestart: [stackName] },
  });
});

test('real source runner emits canonical supersession and exits before starting services', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-superseded-runner-' });
  const stackName = 'fixture-superseded-runner';
  const stackBaseDir = fixture.path(stackName);
  const successor = await beginPendingSourceStart({ stackBaseDir });
  t.after(() => successor.dispose());
  const envPath = fixture.path(stackName, 'env');
  await writeFile(envPath, '');
  const before = await readFile(fixture.path(stackName, 'source-runtime/start.pending.json'), 'utf8');
  const repoDir = fileURLToPath(new URL('../../../../../', import.meta.url));
  const result = await runNodeCapture([fileURLToPath(new URL('../../run.mjs', import.meta.url)),
    '--runtime=source', '--source-start-request-id=older-request'], {
    env: { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root, repoDir }),
      HAPPIER_STACK_STORAGE_DIR: fixture.root, HAPPIER_STACK_HOME_DIR: fixture.root,
      HAPPIER_STACK_STACK: stackName, HAPPIER_STACK_ENV_FILE: envPath },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.split('\n').includes(SOURCE_START_SUPERSEDED_MARKER));
  assert.equal(await readFile(fixture.path(stackName, 'source-runtime/start.pending.json'), 'utf8'), before);
  await assert.rejects(readFile(fixture.path(stackName, 'stack.runtime.json')), { code: 'ENOENT' });
});

test('retiring a completed start cancels its queued background producer without cancelling the serving signal', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-source-background-retirement-' });
  const start = await beginPendingSourceStart({ stackBaseDir: fixture.root });
  const lockPath = fixture.path('producer.lock');
  let queued;
  const waiting = new Promise(resolve => { queued = resolve; });
  let producerEntered = false;
  let background;
  t.after(() => start.dispose());
  await withJsonOwnerFileLock(async () => {
    background = start.prepareInBackground(signal => withJsonOwnerFileLock(async () => {
      producerEntered = true;
    }, { lockPath, signal, onWait: queued }));
    void background.catch(() => {});
    await Promise.race([waiting, background]);
    await start.publish(async () => {});
    await start.dispose();
    await assert.rejects(background, { name: 'AbortError' });
    assert.equal(producerEntered, false);
    assert.equal(start.signal.aborted, false);
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid,
      'retirement must leave the independent producer owner untouched');
  }, { lockPath });
});

test('a delegated process shares its parent start without superseding or retiring it', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-pending-source-delegated-', registerCleanup: false });
  const parent = await beginPendingSourceStart({ stackBaseDir: fixture.root });
  let successor;
  t.after(async () => { await parent.dispose(); await successor?.dispose(); await fixture.cleanup(); });
  await parent.retainPreparation(fixture.path('prepared'));
  const markerPath = fixture.path('source-runtime/start.pending.json');
  const markerBefore = JSON.parse(await readFile(markerPath, 'utf8'));
  const moduleUrl = new URL('./pending_source_start.mjs', import.meta.url).href;
  const delegated = await runNodeCapture(['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { beginPendingSourceStart } from ${JSON.stringify(moduleUrl)};
    const start = await beginPendingSourceStart({ stackBaseDir: ${JSON.stringify(fixture.root)},
      requestId: ${JSON.stringify(parent.requestId)} });
    try {
      assert.equal(start.requestId, ${JSON.stringify(parent.requestId)});
      await start.publish(async () => {});
    } finally { await start.dispose(); }
  `]);
  assert.equal(delegated.code, 0, delegated.stderr);
  assert.deepEqual(JSON.parse(await readFile(markerPath, 'utf8')), markerBefore,
    'delegated publication and cleanup retain the parent marker and preparation');
  await parent.publishPreparation(async () => writeFile(fixture.path('adopted'), 'yes'));
  assert.equal(parent.signal.aborted, false);
  successor = await beginPendingSourceStart({ stackBaseDir: fixture.root, requestId: 'next-parent', replacePending: true });
  await assert.rejects(beginPendingSourceStart({ stackBaseDir: fixture.root, requestId: parent.requestId }),
    { code: 'ESOURCESTARTSUPERSEDED' }, 'a stale delegated half cannot overwrite a genuine successor');
  await assert.rejects(parent.publish(async () => {}), { code: 'ESOURCESTARTSUPERSEDED' });
  await successor.publish(async () => {});
});

test('a delegated remote start replaces abandoned preparation and keeps its retry in the same request', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-pending-source-abandoned-', registerCleanup: false });
  const moduleUrl = new URL('./pending_source_start.mjs', import.meta.url).href;
  let current;
  let retry;
  t.after(async () => { await retry?.dispose(); await current?.dispose(); await fixture.cleanup(); });
  const abandoned = await runNodeCapture(['--input-type=module', '-e', `
    import { beginPendingSourceStart } from ${JSON.stringify(moduleUrl)};
    const start = await beginPendingSourceStart({ stackBaseDir: ${JSON.stringify(fixture.root)},
      requestId: 'previous-controller' });
    await start.setPhase({ phase: 'queued', component: 'server' });
    // Exiting the process without cleanup models a lost remote worker.
  `]);
  assert.equal(abandoned.code, 0, abandoned.stderr);
  current = await beginPendingSourceStart({ stackBaseDir: fixture.root, requestId: 'current-controller' });
  await current.retainPreparation(fixture.path('current-prepared'));
  retry = await beginPendingSourceStart({ stackBaseDir: fixture.root, requestId: current.requestId });
  await retry.publish(async () => writeFile(fixture.path('retry-published'), 'yes'));
  await retry.dispose();
  assert.equal(current.signal.aborted, false);
  assert.equal(JSON.parse(await readFile(fixture.path('source-runtime/start.pending.json'), 'utf8')).requestId,
    current.requestId, 'retry publication must retain the current owner claim');
  await assert.rejects(beginPendingSourceStart({ stackBaseDir: fixture.root, requestId: 'previous-controller' }),
    { code: 'ESOURCESTARTSUPERSEDED' }, 'an old worker must not overwrite a live successor');
  await current.publish(async () => writeFile(fixture.path('current-published'), 'yes'));
  assert.equal(await readFile(fixture.path('current-published'), 'utf8'), 'yes');
});

test('a same-request retry reclaims a dead child owner and preserves its pending preparations', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-pending-source-same-request-', registerCleanup: false });
  const moduleUrl = new URL('./pending_source_start.mjs', import.meta.url).href;
  const preparationDir = fixture.path('prepared');
  let retry;
  t.after(async () => { await retry?.dispose(); await fixture.cleanup(); });
  const abandoned = await runNodeCapture(['--input-type=module', '-e', `
    import { beginPendingSourceStart } from ${JSON.stringify(moduleUrl)};
    const start = await beginPendingSourceStart({ stackBaseDir: ${JSON.stringify(fixture.root)}, requestId: 'controller' });
    await start.retainPreparation(${JSON.stringify(preparationDir)});
    await start.setPhase({ phase: 'queued', component: 'server' });
    // The real child exits without disposing its pending start.
  `]);
  assert.equal(abandoned.code, 0, abandoned.stderr);
  assert.equal(await readPendingSourcePreparation({ stackBaseDir: fixture.root }), null,
    'a dead child cannot publish active preparation');
  retry = await beginPendingSourceStart({ stackBaseDir: fixture.root, requestId: 'controller' });
  const markerPath = fixture.path('source-runtime/start.pending.json');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  assert.equal(marker.pid, process.pid, 'the retry must own the marker with its live PID');
  assert.equal(marker.requestId, 'controller');
  assert.deepEqual(marker.preparationDirs, [preparationDir], 'completed preparations remain pinned for the same request');
  await retry.setPhase({ phase: 'building', component: 'server' });
  assert.deepEqual(await readPendingSourcePreparation({ stackBaseDir: fixture.root }), { phase: 'building', component: 'server' });
  await retry.publish(async () => writeFile(fixture.path('selected'), 'retry'));
  assert.equal(await readFile(fixture.path('selected'), 'utf8'), 'retry');
  await assert.rejects(readFile(markerPath), { code: 'ENOENT' }, 'successful retry removes its marker');
});

test('a delegated start cannot replace a marker when its owner liveness is inconclusive', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-pending-source-unknown-', registerCleanup: false });
  const owner = await beginPendingSourceStart({ stackBaseDir: fixture.root });
  t.after(async () => { await owner.dispose(); await fixture.cleanup(); });
  const markerPath = fixture.path('source-runtime/start.pending.json');
  const marker = { requestId: owner.requestId, pid: 12345, phase: 'queued' };
  await writeFile(markerPath, JSON.stringify(marker));
  const realKill = process.kill.bind(process);
  // The OS signal probe is the external boundary; keep claim/lock logic real.
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === marker.pid) throw Object.assign(new Error('probe unavailable'), { code: 'EIO' });
    return realKill(pid, signal);
  });
  await assert.rejects(beginPendingSourceStart({ stackBaseDir: fixture.root, requestId: 'contender' }),
    { code: 'ESOURCESTARTSUPERSEDED' });
  await assert.rejects(beginPendingSourceStart({ stackBaseDir: fixture.root, requestId: owner.requestId }),
    { code: 'ESOURCESTARTSUPERSEDED' }, 'same-request delegation also requires conclusive live custody');
  assert.deepEqual(JSON.parse(await readFile(markerPath, 'utf8')), marker);
});

test('a newer process cancels only its stack pending start and prevents stale publication', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-pending-source-start-', registerCleanup: false });
  const first = await beginPendingSourceStart({ stackBaseDir: fixture.path('same-stack') });
  const other = await beginPendingSourceStart({ stackBaseDir: fixture.path('other-stack') });
  const lockPath = fixture.path('shared-bundle.lock');
  let releaseBuild;
  let buildEntered;
  const buildReady = new Promise(resolve => { buildEntered = resolve; });
  const buildHeld = new Promise(resolve => { releaseBuild = resolve; });
  const build = withJsonOwnerFileLock(async () => { buildEntered(); await buildHeld; }, { lockPath });
  await buildReady;
  let waiterEntered;
  const waiterReady = new Promise(resolve => { waiterEntered = resolve; });
  const waiting = withJsonOwnerFileLock(async () => 'acquired', {
    lockPath, signal: first.signal, onWait: waiterEntered,
  }).then(value => value, error => error.name);
  t.after(async () => {
    releaseBuild();
    await Promise.allSettled([build, waiting]);
    await first.dispose();
    await other.dispose();
    await fixture.cleanup();
  });
  await waiterReady;
  const moduleUrl = new URL('./pending_source_start.mjs', import.meta.url).href;
  const replacement = await runNodeCapture(['--input-type=module', '-e', `
    import { beginPendingSourceStart } from ${JSON.stringify(moduleUrl)};
    const start = await beginPendingSourceStart({ stackBaseDir: ${JSON.stringify(fixture.path('same-stack'))} });
    await start.publish(async () => {});
    await start.dispose();
  `]);
  assert.equal(replacement.code, 0, replacement.stderr);
  const abortObserved = first.signal.aborted || await Promise.race([
    new Promise(resolve => first.signal.addEventListener('abort', () => resolve(true), { once: true })),
    delay(1_000).then(() => false),
  ]);
  assert.equal(abortObserved, true, 'the earlier stack start must self-cancel');
  assert.equal(await waiting, 'AbortError', 'the superseded start leaves its pre-build wait');
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid, 'the shared builder keeps ownership');
  assert.equal(other.signal.aborted, false, 'a different stack remains pending');
  let stalePublished = false;
  await assert.rejects(first.publish(async () => { stalePublished = true; }), { code: 'ESOURCESTARTSUPERSEDED' });
  await assert.rejects(first.publishPreparation(async () => { stalePublished = true; }), { code: 'ESOURCESTARTSUPERSEDED' });
  await assert.rejects(first.setPhase({ phase: 'building', component: 'daemon' }), { code: 'ESOURCESTARTSUPERSEDED' });
  assert.equal(stalePublished, false);
  await other.retainPreparation(fixture.path('other-preparation'));
  await other.setPhase({ phase: 'building', component: 'server' }, 'server-host');
  await other.setPhase({ phase: 'queued', component: 'daemon' }, 'daemon-host');
  await other.publishPreparation(async () => writeFile(fixture.path('other-prepared'), 'ready'));
  await other.retainPreparation(fixture.path('other-ui'));
  const retained = JSON.parse(await readFile(fixture.path('other-stack/source-runtime/start.pending.json'), 'utf8'));
  assert.deepEqual(retained.preparationDirs, [fixture.path('other-preparation'), fixture.path('other-ui')]);
  assert.deepEqual(retained.targets, { 'server-host': { phase: 'building', component: 'server' },
    'daemon-host': { phase: 'queued', component: 'daemon' } });
  assert.equal(retained.preparationDir, fixture.path('other-preparation'),
    'older loaded retainers keep the primary reload graph while a web product is pinned separately');
  await other.publish(async () => writeFile(fixture.path('other-published'), 'yes'));
  assert.equal(await readFile(fixture.path('other-published'), 'utf8'), 'yes');
});

test('completed starts stop observing successors and old cleanup preserves the current pending start', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-pending-source-start-retire-', registerCleanup: false });
  const first = await beginPendingSourceStart({ stackBaseDir: fixture.root });
  await first.publish(async () => {});
  const second = await beginPendingSourceStart({ stackBaseDir: fixture.root });
  t.after(async () => { await first.dispose(); await second.dispose(); await fixture.cleanup(); });
  await first.dispose();
  await second.publish(async () => writeFile(fixture.path('current-published'), 'yes'));
  assert.equal(first.signal.aborted, false, 'an active start must not be cancelled');
  assert.equal(await readFile(fixture.path('current-published'), 'utf8'), 'yes');
});

test('publication checks the marker even before a supersession event is observed', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-pending-source-start-publish-', registerCleanup: false });
  const first = await beginPendingSourceStart({ stackBaseDir: fixture.root });
  const current = await beginPendingSourceStart({ stackBaseDir: fixture.root });
  t.after(async () => { await first.dispose(); await current.dispose(); await fixture.cleanup(); });
  let published = false;
  await assert.rejects(first.publish(async () => { published = true; }), { code: 'ESOURCESTARTSUPERSEDED' });
  assert.equal(published, false);
  await first.dispose();
  await current.publish(async () => writeFile(fixture.path('selected'), 'current'));
  assert.equal(await readFile(fixture.path('selected'), 'utf8'), 'current');
});
