import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { spawnTestProcess } from '../testkit/core/spawn_test_process.mjs';
import { withWorkspaceBundleLock } from '@happier-dev/cli-common/workspaceBundleLock';
import { dirname, join } from 'node:path';
import { withRuntimePublicationFlight } from './build_stack_artifacts.mjs';

test('publication flights surface QA last-green packages for built and joined results', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'qa-stale-flight-' });
  const authority = { producerStackName: 'producer', producerStackBaseDir: fixture.root };
  const artifactDir = fixture.path('artifacts', 'web', 'stale-web');
  mkdirSync(join(artifactDir, 'payload'), { recursive: true });
  writeFileSync(join(artifactDir, 'payload', 'index.html'), '<html>web</html>');
  const stalePackages = [{ packageName: '@happier-dev/example', outputIdentity: 'last-green', diagnosticSummary: 'error TS2322' }];
  const manifest = { version: 1, component: 'web', artifactFingerprint: 'stale-web', sourceFingerprint: 'source', payloadDir: 'payload', entrypoint: 'index.html', stalePackages };
  writeFileSync(join(artifactDir, 'manifest.json'), JSON.stringify(manifest));
  const options = { authority, observedStartedSeq: 0, selection: { components: { web: true }, activateRuntime: false },
    publish: async () => ({ artifacts: { web: { artifactDir, manifest } }, snapshotId: null }) };
  const built = await withRuntimePublicationFlight(options);
  assert.equal(built.publicationFlight, 'built');
  assert.deepEqual(built.stalePackages, stalePackages);
  const joined = await withRuntimePublicationFlight({ ...options, publish: async () => { throw new Error('must join'); } });
  assert.equal(joined.publicationFlight, 'joined');
  assert.deepEqual(joined.stalePackages, stalePackages);
  const state = JSON.parse(readFileSync(fixture.path('stack.runtime.json'), 'utf8'));
  assert.deepEqual(state.runtimePublication.components.web.stalePackages, stalePackages);
});

test('flight result reuse checks web payload integrity before joining', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'runtime-flight-web-integrity-' });
  const authority = { producerStackName: 'producer', producerStackBaseDir: fixture.root };
  const artifactDir = fixture.path('artifacts', 'web', 'web');
  mkdirSync(join(artifactDir, 'payload'), { recursive: true });
  mkdirSync(fixture.path('runtime'), { recursive: true });
  writeFileSync(fixture.path('runtime', 'publication-started.json'), JSON.stringify({ startedSeq: 1 }));
  writeFileSync(fixture.path('runtime', 'publication-success.json'), JSON.stringify({
    seq: 1, components: ['web'], artifactFingerprints: { web: 'web' }, snapshotId: null,
  }));
  writeFileSync(join(artifactDir, 'manifest.json'), JSON.stringify({
    version: 1, component: 'web', artifactFingerprint: 'web',
    sourceFingerprint: 'source', payloadDir: 'payload', entrypoint: 'index.html',
  }));
  const options = {
    authority, observedStartedSeq: 0,
    selection: { components: { web: true }, activateRuntime: false },
    publish: async () => { throw new Error('fresh publication required'); },
  };
  writeFileSync(join(artifactDir, 'payload', 'index.html'), '<script src="chunk.js"></script>');
  writeFileSync(join(artifactDir, 'payload', 'chunk.js'), 'bundle');
  assert.equal((await withRuntimePublicationFlight(options)).publicationFlight, 'joined');
  unlinkSync(join(artifactDir, 'payload', 'chunk.js'));
  await assert.rejects(withRuntimePublicationFlight(options), /fresh publication required/);
  writeFileSync(join(artifactDir, 'payload', 'chunk.js'), 'bundle');
  writeFileSync(join(artifactDir, 'payload', 'index.html'), '');
  await assert.rejects(withRuntimePublicationFlight(options), /fresh publication required/);
});

const ownerUrl = new URL('./build_stack_artifacts.mjs', import.meta.url).href;
const workerSource = `
import * as owner from ${JSON.stringify(ownerUrl)};
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const [root, id, componentsJson, fail, observationRaw, clockBack] = process.argv.slice(1);
const components = JSON.parse(componentsJson);
if (clockBack) { const now = Date.now; Date.now = () => now() - Number(clockBack); }
const authority = { producerStackName: 'producer', producerStackBaseDir: root };
const observedStartedSeq = observationRaw ? JSON.parse(observationRaw) : owner.captureRuntimePublicationStartedSeq({ authority });
await writeFile(join(root, id + '.requested'), JSON.stringify(observedStartedSeq));
const selection = { components: Object.fromEntries(components.map(c => [c, true])), activateRuntime: false };
// The workload is the OS/compiler boundary: real processes and filesystem
// artifacts. Admission, reuse, locking and runtime-state writes remain real.
const publish = async () => {
  await mkdir(join(root, 'preparing'));
  await writeFile(join(root, id + '.started'), String(Date.now()));
  try {
    while (!existsSync(join(root, id + '.release'))) await delay(10);
    if (fail === 'fail') throw new Error('compiler failed');
    const input = await readFile(join(root, 'input'), 'utf8');
    const artifacts = {};
    for (const component of components) {
      const artifactDir = join(root, 'artifacts', component, input);
      await mkdir(join(artifactDir, 'payload'), { recursive: true });
      await writeFile(join(artifactDir, 'payload', 'entrypoint'), input);
      const manifest = {
        version: 1, artifactFingerprint: input, component,
        sourceFingerprint: input, source: { input },
        entrypoint: 'entrypoint', payloadDir: 'payload', createdAt: new Date().toISOString(),
      };
      await writeFile(join(artifactDir, 'manifest.json'), JSON.stringify(manifest));
      artifacts[component] = { artifactDir, manifest };
    }
    return { ok: true, snapshotId: null, snapshotPath: null, artifacts, source: { input } };
  } finally { await rm(join(root, 'preparing'), { recursive: true }); }
};
const flight = owner.withRuntimePublicationFlight;
try {
  const result = await flight({
    authority,
    selection, observedStartedSeq,
    env: { HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0' }, publish,
  });
  await writeFile(join(root, id + '.result'), JSON.stringify(result));
} catch (error) {
  await writeFile(join(root, id + '.error'), error.message);
  process.exitCode = 1;
}
`;

function waitForAny(paths, completion) {
  return new Promise((resolve, reject) => {
    let watcher;
    const check = () => {
      const found = paths.find(path => existsSync(path));
      if (!found) return false;
      watcher?.close();
      resolve(found);
      return true;
    };
    watcher = watch(dirname(paths[0]), check);
    watcher.on('error', error => { watcher.close(); reject(error); });
    check();
    // Process completion, rather than an invented startup deadline, decides
    // missing progress. A loaded remote worker can take time to import source.
    completion.then(result => {
      if (check()) return;
      watcher.close();
      reject(new Error(`child exited before producing ${paths.join(', ')}: ${JSON.stringify(result)}`));
    }, error => { watcher.close(); reject(error); });
  });
}

const waitFor = (path, completion) => waitForAny([path], completion);

function launch(t, fixture, id, components = ['server'], fail = '', observedStartedSeq = '', clockBack = '') {
  const child = spawnTestProcess(process.execPath, ['--input-type=module', '-e', workerSource,
    fixture.root, id, JSON.stringify(components), fail, String(observedStartedSeq), String(clockBack)], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const completion = once(child, 'exit').then(([code]) => {
    if (code !== 0) t.diagnostic(`${id} worker: ${stderr}`);
    return { code, stderr };
  });
  fixture.workers.push({ id, completion });
  return { completion, get stderr() { return stderr; } };
}

async function createFlightFixture(t, prefix) {
  const fixture = await createTempFixture(t, { prefix, registerCleanup: false });
  fixture.workers = [];
  fixture.beforeCleanup = [];
  mkdirSync(fixture.path('runtime'), { recursive: true });
  writeFileSync(fixture.path('runtime', 'publication-started.json'), JSON.stringify({ startedSeq: 0 }));
  t.after(async () => {
    for (const cleanup of fixture.beforeCleanup) await cleanup();
    for (const { id } of fixture.workers) writeFileSync(fixture.path(id + '.release'), 'release');
    await Promise.all(fixture.workers.map(({ completion }) => completion));
    await fixture.cleanup();
  });
  return fixture;
}

test('three process waiters serialize preparation and join one trailing publication with latest inputs', async (t) => {
  const fixture = await createFlightFixture(t, 'runtime-publication-flight-');
  writeFileSync(fixture.path('input'), 'first');
  const first = launch(t, fixture, 'first');
  await waitFor(fixture.path('first.started'), first.completion);
  const waiters = ['second', 'third', 'fourth'].map(id => ({ id, ...launch(t, fixture, id) }));
  await Promise.all(waiters.map(({ id, completion }) => waitFor(fixture.path(id + '.requested'), completion)));
  await delay(100);
  assert.equal(waiters.some(({ id }) => existsSync(fixture.path(id + '.error'))), false,
    'no waiter may begin preparation concurrently');
  writeFileSync(fixture.path('input'), 'latest');
  writeFileSync(fixture.path('first.release'), 'release');
  assert.equal((await first.completion).code, 0);
  const trailingPath = await waitForAny(waiters.map(({ id }) => fixture.path(id + '.started')),
    Promise.all(waiters.map(({ completion }) => completion)));
  const trailing = waiters.find(({ id }) => fixture.path(id + '.started') === trailingPath);
  assert.ok(trailing, 'one waiter must publish from inputs after its request');
  // A previously made request can reach admission after the trailing flight
  // starts (e.g. background child dispatch). It must still join that flight.
  const late = launch(t, fixture, 'late', ['server'], '', Number(readFileSync(fixture.path('second.requested'), 'utf8')));
  await waitFor(fixture.path('late.requested'), late.completion);
  writeFileSync(fixture.path(trailing.id + '.release'), 'release');
  const completions = await Promise.all(waiters.map(({ completion }) => completion));
  assert.deepEqual(completions.map(r => r.code), [0, 0, 0]);
  const results = waiters.map(({ id }) => JSON.parse(readFileSync(fixture.path(id + '.result'), 'utf8')));
  assert.deepEqual(results.map(r => r.publicationFlight).sort(), ['built', 'joined', 'joined']);
  assert.equal(waiters.filter(({ id }) => existsSync(fixture.path(id + '.started'))).length, 1);
  assert.ok(results.every(r => r.artifacts.server.manifest.artifactFingerprint === 'latest'));
  assert.ok(completions.some(r => /publication\.lock.*pid=/.test(r.stderr)), 'waiters report the actual producer holder');
  assert.equal((await late.completion).code, 0);
  assert.equal(JSON.parse(readFileSync(fixture.path('late.result'), 'utf8')).publicationFlight, 'joined');
  assert.equal(existsSync(fixture.path('late.started')), false);
});

test('a failed process flight cannot satisfy its waiter', async (t) => {
  const fixture = await createFlightFixture(t, 'runtime-publication-failure-');
  writeFileSync(fixture.path('input'), 'recovery');
  const first = launch(t, fixture, 'failed', ['server'], 'fail');
  await waitFor(fixture.path('failed.started'), first.completion);
  const waiter = launch(t, fixture, 'waiter');
  await waitFor(fixture.path('waiter.requested'), waiter.completion);
  await delay(100);
  assert.equal(existsSync(fixture.path('waiter.error')), false, 'waiter must wait for the failed owner');
  writeFileSync(fixture.path('failed.release'), 'release');
  assert.equal((await first.completion).code, 1);
  await waitFor(fixture.path('waiter.started'), waiter.completion);
  writeFileSync(fixture.path('waiter.release'), 'release');
  assert.equal((await waiter.completion).code, 0);
  const result = JSON.parse(readFileSync(fixture.path('waiter.result'), 'utf8'));
  assert.equal(result.publicationFlight, 'built');
  assert.equal(result.artifacts.server.manifest.artifactFingerprint, 'recovery');
});

test('real explicit and background entrypoints cannot enter preparation before producer flight admission', async (t) => {
  const fixture = await createFlightFixture(t, 'runtime-publication-entrypoints-');
  let release;
  let acquired;
  const admitted = new Promise(resolve => { acquired = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const holder = withWorkspaceBundleLock(async () => { acquired(); await gate; }, {
    lockPath: fixture.path('runtime', 'publication.lock'),
  });
  fixture.beforeCleanup.push(async () => { release(); await holder; });
  await admitted;
  const children = ['explicit', 'background'].map(id => {
    const source = `
      import * as owner from ${JSON.stringify(ownerUrl)};
      import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      const root = process.argv[1];
      const authority = {
        producerStackName: 'producer', producerStackBaseDir: root,
        consumerStackName: 'consumer', consumerStackBaseDir: join(root, 'consumer'),
      };
      const env = { ...process.env, HAPPIER_STACK_STACK: 'consumer', HAPPIER_STACK_REPO_DIR: root,
        HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0' };
      await writeFile(join(root, '${id}.requested'), 'ready');
      try {
        await owner.${id === 'explicit' ? 'buildStackArtifacts' : 'publishRepositoryRuntimeSnapshot'}({
          rootDir: root, authority, env,
          ${id === 'explicit' ? "argv: ['--daemon']" : "requestedComponents: ['daemon']"},
        });
      } catch (error) { await writeFile(join(root, '${id}.error'), error.message); }
    `;
    const child = spawnTestProcess(process.execPath, ['--input-type=module', '-e', source, fixture.root], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const completion = once(child, 'exit').then(([code]) => ({ code, stderr }));
    fixture.workers.push({ id, completion });
    return { id, completion };
  });
  await Promise.all(children.map(({ id, completion }) => waitFor(fixture.path(id + '.requested'), completion)));
  await delay(200);
  assert.ok(children.every(({ id }) => !existsSync(fixture.path(id + '.error'))),
    'neither public entrypoint may prepare/fail while another producer flight is active');
  release();
  await holder;
  const completions = await Promise.all(children.map(({ completion }) => completion));
  assert.ok(completions.every(({ code }) => code === 0));
  assert.ok(children.every(({ id }) => existsSync(fixture.path(id + '.error'))),
    'after admission each real missing-source preparation must fail');
  assert.ok(completions.every(({ stderr }) => stderr.includes('publication.lock')));
});

test('a joined explicit request commits completed artifacts and selects its own consumer; background joins preserve selection', async (t) => {
  const fixture = await createFlightFixture(t, 'runtime-publication-selection-');
  const owner = await import(ownerUrl);
  const authority = {
    producerStackName: 'producer', producerStackBaseDir: fixture.path('stacks', 'producer'),
    consumerStackName: 'consumer', consumerStackBaseDir: fixture.path('stacks', 'consumer'),
  };
  const env = {
    HAPPIER_STACK_STACK: 'consumer', HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'),
    HAPPIER_STACK_REPO_DIR: fixture.path('absent-source'),
  };
  const sourceMetadata = {
    repoDir: fixture.root, serverComponent: 'happier-server-light', dbProvider: 'sqlite',
    sourceFingerprint: 'source', builtAt: new Date().toISOString(),
  };
  const components = ['web', 'server', 'daemon'];
  const selection = { components: Object.fromEntries(components.map(c => [c, true])), activateRuntime: true };
  const artifacts = {};
  for (const component of components) {
    const artifactDir = join(authority.producerStackBaseDir, 'artifacts', component, component + '-identity');
    mkdirSync(join(artifactDir, 'payload'), { recursive: true });
    writeFileSync(join(artifactDir, 'payload', 'entrypoint'), component);
    if (component === 'daemon') {
      mkdirSync(join(artifactDir, 'payload', 'package-dist'), { recursive: true });
      writeFileSync(join(artifactDir, 'payload', 'package-dist', 'index.mjs'), 'export {};');
      writeFileSync(join(artifactDir, 'payload', 'package-dist', '.build-manifest.json'),
        JSON.stringify({ fingerprint: '0123456789abcdef', fileCount: 1 }));
    }
    const manifest = {
      version: 1, component, artifactFingerprint: component + '-identity',
      sourceFingerprint: 'source', source: sourceMetadata, createdAt: sourceMetadata.builtAt,
      payloadDir: 'payload', entrypoint: 'entrypoint',
    };
    writeFileSync(join(artifactDir, 'manifest.json'), JSON.stringify(manifest));
    artifacts[component] = { artifactDir, manifest };
  }
  mkdirSync(join(authority.producerStackBaseDir, 'runtime'), { recursive: true });
  writeFileSync(join(authority.producerStackBaseDir, 'runtime', 'publication-started.json'), JSON.stringify({ startedSeq: 0 }));
  const observedStartedSeq = owner.captureRuntimePublicationStartedSeq({ authority });
  const built = await owner.withRuntimePublicationFlight({
    authority, selection: { ...selection, activateRuntime: false }, env,
    publish: async () => ({ artifacts, source: sourceMetadata, snapshotId: null, snapshotPath: null }),
  });
  const joined = await owner.buildStackArtifacts({
    rootDir: fixture.path('absent-source'), argv: ['--all', '--activate-runtime'],
    authority, env, observedStartedSeq,
  });
  assert.equal(joined.publicationFlight, 'joined');
  assert.equal(joined.selected, true);
  assert.equal(joined.consumerStackName, 'consumer');
  assert.equal(built.snapshotId, null);
  assert.ok(joined.snapshotId);
  const pointer = JSON.parse(readFileSync(join(authority.consumerStackBaseDir, 'runtime', 'current.json'), 'utf8'));
  assert.equal(pointer.producerStackName, 'producer');
  assert.equal(pointer.snapshotId, joined.snapshotId);
  assert.match(readFileSync(join(authority.consumerStackBaseDir, 'env'), 'utf8'), /HAPPIER_STACK_RUNTIME_MODE=prefer/);
  const background = await owner.publishRepositoryRuntimeSnapshot({
    rootDir: fixture.path('absent-source'), authority, env, observedStartedSeq, requestedComponents: ['daemon'],
  });
  assert.equal(background.publicationFlight, 'joined');
  assert.equal(background.selected, false);
  assert.deepEqual(Object.keys(background.artifacts), ['daemon']);
  assert.equal(background.snapshotId, joined.snapshotId);
  assert.deepEqual(JSON.parse(readFileSync(join(authority.consumerStackBaseDir, 'runtime', 'current.json'), 'utf8')), pointer);
});

test('a successful flight for another component cannot satisfy uncovered demand', async (t) => {
  const fixture = await createFlightFixture(t, 'runtime-publication-coverage-');
  writeFileSync(fixture.path('input'), 'source');
  writeFileSync(fixture.path('server.release'), 'release');
  const observation = 0;
  assert.equal((await launch(t, fixture, 'server').completion).code, 0);
  writeFileSync(fixture.path('daemon.release'), 'release');
  const daemon = launch(t, fixture, 'daemon', ['daemon'], '', observation);
  assert.equal((await daemon.completion).code, 0);
  const result = JSON.parse(readFileSync(fixture.path('daemon.result'), 'utf8'));
  assert.equal(result.publicationFlight, 'built');
  assert.deepEqual(Object.keys(result.artifacts), ['daemon']);
  writeFileSync(fixture.path('input'), 'new-demand');
  writeFileSync(fixture.path('later.release'), 'release');
  assert.equal((await launch(t, fixture, 'later', ['daemon']).completion).code, 0);
  const later = JSON.parse(readFileSync(fixture.path('later.result'), 'utf8'));
  assert.equal(later.publicationFlight, 'built', 'a new request must not treat the record as a warm build cache');
  assert.equal(later.artifacts.daemon.manifest.artifactFingerprint, 'new-demand');
});

test('a fresh request after wall-clock rollback builds new inputs instead of joining an older success', async (t) => {
  const fixture = await createFlightFixture(t, 'runtime-flight-clock-');
  writeFileSync(fixture.path('input'), 'old-input');
  writeFileSync(fixture.path('old.release'), 'release');
  assert.equal((await launch(t, fixture, 'old').completion).code, 0);
  writeFileSync(fixture.path('input'), 'new-input');
  writeFileSync(fixture.path('new.release'), 'release');
  assert.equal((await launch(t, fixture, 'new', ['server'], '', '', 5000).completion).code, 0);
  const result = JSON.parse(readFileSync(fixture.path('new.result'), 'utf8'));
  assert.equal(result.artifacts.server.manifest.artifactFingerprint, 'new-input');
  assert.equal(result.publicationFlight, 'built');
});

test('missing or unreadable admission observations cannot reuse a recorded success', async (t) => {
  const fixture = await createFlightFixture(t, 'runtime-flight-unreadable-');
  const owner = await import(ownerUrl);
  const authority = { producerStackName: 'producer', producerStackBaseDir: fixture.root };
  const counterPath = fixture.path('runtime', 'publication-started.json');
  writeFileSync(fixture.path('input'), 'old-input');
  writeFileSync(fixture.path('old.release'), 'release');
  assert.equal((await launch(t, fixture, 'old').completion).code, 0);
  for (const [id, corrupt] of [['missing', false], ['unreadable', true]]) {
    if (corrupt) writeFileSync(counterPath, '{'); else unlinkSync(counterPath);
    assert.equal(owner.captureRuntimePublicationStartedSeq({ authority }), null);
    writeFileSync(fixture.path('input'), id + '-input');
    writeFileSync(fixture.path(id + '.release'), 'release');
    const child = launch(t, fixture, id);
    assert.equal((await child.completion).code, 0);
    const result = JSON.parse(readFileSync(fixture.path(id + '.result'), 'utf8'));
    assert.equal(result.publicationFlight, 'built');
    assert.equal(result.artifacts.server.manifest.artifactFingerprint, id + '-input');
  }
  // Also fail closed if a previously readable observation loses its counter
  // before admission, even though the success would otherwise cover demand.
  unlinkSync(counterPath);
  writeFileSync(fixture.path('input'), 'lost-counter-input');
  writeFileSync(fixture.path('lost.release'), 'release');
  assert.equal((await launch(t, fixture, 'lost', ['server'], '', 0).completion).code, 0);
  assert.equal(JSON.parse(readFileSync(fixture.path('lost.result'), 'utf8')).publicationFlight, 'built');
});

test('latest pending watcher demand cannot join a flight started between its two notifications', async (t) => {
  const fixture = await createFlightFixture(t, 'runtime-flight-latest-watcher-');
  const owner = await import(ownerUrl);
  const { createRepositoryRuntimePublicationController } = await import('../utils/dev/runtimeSnapshotPublisher.mjs');
  const { recordStackRuntimeUpdate } = await import('../utils/stack/runtime_state.mjs');
  const authority = { producerStackName: 'producer', producerStackBaseDir: fixture.root };
  let releaseServer;
  let serverDelivered;
  const serverGate = new Promise(resolve => { releaseServer = resolve; });
  const serverPending = new Promise(resolve => { serverDelivered = resolve; });
  const builds = [];
  const publisher = createRepositoryRuntimePublicationController({
    rootDir: fixture.root, authority, env: {}, runtimeStatePath: fixture.path('stack.runtime.json'),
    recordStackRuntimeUpdate,
    resolveRepositoryRuntimePublicationComponents: owner.resolveRepositoryRuntimePublicationComponents,
    // Child/compiler dispatch and delayed result delivery are the boundary
    // workload. The controller, reducer, admission and status writer stay real.
    publishRepositoryRuntimeSnapshot: async ({ requestedComponents: components, observedStartedSeq }) => {
      const component = components[0];
      const result = await owner.withRuntimePublicationFlight({
        authority, selection: { components: { [component]: true }, activateRuntime: false },
        observedStartedSeq,
        publish: async () => {
          const input = component === 'daemon' ? readFileSync(fixture.path('input'), 'utf8') : 'server-input';
          builds.push([component, input]);
          const artifactDir = fixture.path('artifacts', component, input);
          mkdirSync(join(artifactDir, 'payload'), { recursive: true });
          writeFileSync(join(artifactDir, 'payload', 'entrypoint'), input);
          const manifest = { version: 1, component, artifactFingerprint: input, sourceFingerprint: input,
            source: { input }, payloadDir: 'payload', entrypoint: 'entrypoint', createdAt: new Date().toISOString() };
          writeFileSync(join(artifactDir, 'manifest.json'), JSON.stringify(manifest));
          return { artifacts: { [component]: { artifactDir, manifest } } };
        },
      });
      if (component === 'server') { serverDelivered(); await serverGate; }
      return result;
    },
  });
  fixture.beforeCleanup.push(async () => { releaseServer(); publisher.close(); });
  writeFileSync(fixture.path('input'), 'old-input');
  const background = publisher.markRefreshed(['server', 'daemon']);
  await serverPending;
  publisher.markRefreshed(['daemon']);
  await delay(10);
  const explicit = launch(t, fixture, 'explicit', ['daemon']);
  await waitFor(fixture.path('explicit.started'), explicit.completion);
  await delay(10);
  publisher.markRefreshed(['daemon']);
  writeFileSync(fixture.path('explicit.release'), 'release');
  assert.equal((await explicit.completion).code, 0);
  writeFileSync(fixture.path('input'), 'new-input');
  releaseServer();
  const result = await background;
  assert.equal(result.artifacts.daemon.manifest.artifactFingerprint, 'new-input');
  assert.deepEqual(builds, [['server', 'server-input'], ['daemon', 'new-input']]);
});

test('activation cannot advance or prune snapshots while producer admission is held; joined external selection survives retention', async (t) => {
  const fixture = await createFlightFixture(t, 'runtime-flight-activation-');
  const owner = await import(ownerUrl);
  const { collectBuildSourceMetadata } = await import('./collect_build_source_metadata.mjs');
  const authority = { producerStackName: 'producer', producerStackBaseDir: fixture.path('stacks', 'producer'),
    consumerStackName: 'consumer', consumerStackBaseDir: fixture.path('stacks', 'consumer') };
  const env = { ...process.env, HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'),
    HAPPIER_STACK_STACK: 'consumer', HAPPIER_STACK_REPO_DIR: fixture.root,
    HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0' };
  const source = await collectBuildSourceMetadata({ rootDir: fixture.root, env });
  const components = ['web', 'server', 'daemon'];
  const selection = { components: { web: true, server: true, daemon: true }, activateRuntime: true };
  const createArtifacts = (suffix, builtAt) => Object.fromEntries(components.map(component => {
    const fingerprint = component + '-' + suffix;
    const artifactDir = join(authority.producerStackBaseDir, 'artifacts', component, fingerprint);
    const entrypoint = component === 'web' ? 'index.html' : 'entrypoint';
    mkdirSync(join(artifactDir, 'payload'), { recursive: true });
    writeFileSync(join(artifactDir, 'payload', entrypoint), fingerprint);
    if (component === 'daemon') {
      mkdirSync(join(artifactDir, 'payload', 'package-dist'), { recursive: true });
      writeFileSync(join(artifactDir, 'payload', 'package-dist', 'index.mjs'), 'export {};');
      writeFileSync(join(artifactDir, 'payload', 'package-dist', '.build-manifest.json'),
        JSON.stringify({ fingerprint: '0123456789abcdef', fileCount: 1 }));
    }
    const manifest = { version: 1, component, artifactFingerprint: fingerprint, sourceFingerprint: source.sourceFingerprint,
      source, payloadDir: 'payload', entrypoint, createdAt: builtAt };
    writeFileSync(join(artifactDir, 'manifest.json'), JSON.stringify(manifest));
    return [component, { artifactDir, manifest }];
  }));
  mkdirSync(join(authority.producerStackBaseDir, 'runtime'), { recursive: true });
  writeFileSync(join(authority.producerStackBaseDir, 'runtime', 'publication-started.json'), JSON.stringify({ startedSeq: 0 }));
  const observedStartedSeq = owner.captureRuntimePublicationStartedSeq({ authority });
  const artifacts = createArtifacts('old', '2026-01-01T00:00:00.000Z');
  const first = await owner.withRuntimePublicationFlight({ authority, selection, env, publish: async () => ({
    artifacts, source,
    ...await owner.publishBuiltRepositoryRuntimeSnapshot({ authority, selection, requestedComponents: components,
      sourceMetadata: source, artifacts, env, retentionPolicy: { runtimeSnapshotKeepCount: 1 } }),
  }) });
  createArtifacts('new', '2026-01-02T00:00:00.000Z');
  // Pause only the filesystem boundary while the real admitted join selects
  // its consumer. Activation must wait until that retention pin is installed.
  const joinSource = `
    import fs from 'node:fs/promises';
    import { existsSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    import { setTimeout as delay } from 'node:timers/promises';
    const root = process.argv[1];
    const consumer = join(root, 'stacks', 'consumer');
    const originalCopyFile = fs.copyFile;
    fs.copyFile = async (from, to, ...rest) => {
      if (to.startsWith(consumer) && from.endsWith('manifest.json')) {
        await fs.writeFile(join(root, 'join.selecting'), 'ready');
        while (!existsSync(join(root, 'join.release'))) await delay(10);
      }
      return await originalCopyFile(from, to, ...rest);
    };
    syncBuiltinESMExports();
    const owner = await import(${JSON.stringify(ownerUrl)});
    const result = await owner.withRuntimePublicationFlight({
      authority: { producerStackName: 'producer', producerStackBaseDir: join(root, 'stacks', 'producer'),
        consumerStackName: 'consumer', consumerStackBaseDir: consumer },
      selection: { components: { web: true, server: true, daemon: true }, activateRuntime: true },
      observedStartedSeq: ${observedStartedSeq}, selectConsumer: true,
      env: { ...process.env, HAPPIER_STACK_STACK: 'consumer', HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks') },
      publish: async () => { throw new Error('eligible join must not compile'); },
    });
    await fs.writeFile(join(root, 'join.result'), JSON.stringify(result));
  `;
  const joinChild = spawnTestProcess(process.execPath, ['--input-type=module', '-e', joinSource, fixture.root], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let joinStderr = '';
  joinChild.stderr.on('data', chunk => { joinStderr += chunk; });
  const joinCompletion = once(joinChild, 'exit').then(([code]) => ({ code, stderr: joinStderr }));
  fixture.workers.push({ id: 'join', completion: joinCompletion });
  await waitFor(fixture.path('join.selecting'), joinCompletion);
  const sourceCode = `
    import { activateRuntimeForAuthority } from ${JSON.stringify(new URL('../runtime_activate.mjs', import.meta.url).href)};
    import { writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const root = process.argv[1];
    await writeFile(join(root, 'activation.requested'), 'ready');
    const result = await activateRuntimeForAuthority({ rootDir: root, stackName: 'other',
      selectedComponents: { web: true, server: true, daemon: true },
      authority: { producerStackName: 'producer', producerStackBaseDir: join(root, 'stacks', 'producer'),
        consumerStackName: 'other', consumerStackBaseDir: join(root, 'stacks', 'other') },
      env: { ...process.env, HAPPIER_STACK_STACK: 'other', HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
        HAPPIER_STACK_REPO_DIR: root, HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0' },
      retentionPolicy: { runtimeSnapshotKeepCount: 1 },
    });
    await writeFile(join(root, 'activation.result'), JSON.stringify(result));
  `;
  const child = spawnTestProcess(process.execPath, ['--input-type=module', '-e', sourceCode, fixture.root], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const completion = once(child, 'exit').then(([code]) => ({ code, stderr }));
  fixture.workers.push({ id: 'activation', completion });
  await waitFor(fixture.path('activation.requested'), completion);
  await delay(300);
  assert.equal(existsSync(fixture.path('activation.result')), false, 'activation must wait for producer admission');
  const pointerPath = join(authority.producerStackBaseDir, 'runtime', 'current.json');
  assert.equal(JSON.parse(readFileSync(pointerPath, 'utf8')).snapshotId, first.snapshotId);
  writeFileSync(fixture.path('join.release'), 'release');
  assert.equal((await joinCompletion).code, 0, joinStderr);
  assert.equal(JSON.parse(readFileSync(fixture.path('join.result'), 'utf8')).publicationFlight, 'joined');
  assert.equal((await completion).code, 0, stderr);
  const activated = JSON.parse(readFileSync(fixture.path('activation.result'), 'utf8'));
  assert.notEqual(activated.runtime.snapshotId, first.snapshotId);
  assert.equal(existsSync(join(first.snapshotPath, 'manifest.json')), true, 'external consumer pin survives retention=1');
  const { inspectActiveRuntimeSnapshot } = await import('../runtime/launch/inspectActiveRuntimeSnapshot.mjs');
  const inspected = await inspectActiveRuntimeSnapshot({ stackBaseDir: authority.consumerStackBaseDir, env });
  assert.equal(inspected.valid, true, inspected.errors.join('\n'));
});
