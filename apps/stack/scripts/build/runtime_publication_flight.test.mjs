import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { spawnTestProcess } from '../testkit/core/spawn_test_process.mjs';
import { writeManagedRuntimeSnapshotLayout } from '../testkit/core/runtime_snapshot_layout.mjs';
import { withWorkspaceBundleLock } from '@happier-dev/cli-common/workspaceBundleLock';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { dirname, join } from 'node:path';
import { retainBuiltRuntimeArtifacts, withRuntimePublicationAdmission, withRuntimePublicationFlight } from './build_stack_artifacts.mjs';

test('a preparation that loses its target flight cannot publish completed success', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'runtime-flight-lost-owner-' });
  const authority = { producerStackName: 'producer', producerStackBaseDir: fixture.root };
  const target = { platform: process.platform, arch: process.arch };
  await assert.rejects(withRuntimePublicationFlight({ authority, target,
    selection: { components: { web: true }, activateRuntime: false },
    publish: async ({ withPublication }) => {
      unlinkSync(fixture.path('runtime', `publication.${target.platform}-${target.arch}.lock`));
      return await withPublication(async () => ({
        artifacts: { web: { manifest: { artifactFingerprint: 'lost-owner' } } }, snapshotId: null,
      }));
    },
  }), error => error.code === 'EWORKSPACEBUNDLELOCKOWNERSHIPLOST');
  assert.equal(existsSync(fixture.path('runtime', 'publication-success.json')), false);
});

test('publication retention preserves another target still constructing its artifact', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'runtime-flight-retention-' });
  const native = { platform: process.platform, arch: process.arch };
  const foreign = { platform: process.platform, arch: process.arch === 'x64' ? 'arm64' : 'x64' };
  const staging = fixture.path('artifacts', 'web', `.tmp.1.${process.pid}.foreign`);
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, 'compiler-output'), 'unfinished');
  const artifactDir = fixture.path('artifacts', 'web', 'native');
  mkdirSync(join(artifactDir, 'payload'), { recursive: true });
  writeFileSync(join(artifactDir, 'payload', 'index.html'), '<html>web</html>');
  const manifest = { version: 1, component: 'web', artifactFingerprint: 'native',
    sourceFingerprint: 'native', payloadDir: 'payload', entrypoint: 'index.html', target: native };
  writeFileSync(join(artifactDir, 'manifest.json'), JSON.stringify(manifest));
  const demandDir = fixture.path('runtime', 'publication-demands');
  mkdirSync(demandDir, { recursive: true });
  const demandPath = join(demandDir, 'foreign.json');
  writeFileSync(demandPath, JSON.stringify({ pid: process.pid,
    processInstanceFingerprint: readProcessInstanceFingerprintSync(process.pid), target: foreign, components: ['web'] }));
  const retain = () => retainBuiltRuntimeArtifacts({ stackBaseDir: fixture.root,
    artifacts: { web: { artifactDir, manifest } }, target: native,
    env: {}, retentionPolicy: { artifactKeepCount: 1, runtimeSnapshotKeepCount: 1 } });
  await retain();
  assert.equal(existsSync(join(staging, 'compiler-output')), true,
    'publication on one target must not delete an active target staging tree');
  unlinkSync(demandPath);
  await retain();
  assert.equal(existsSync(staging), false, 'ordinary retention resumes after competing demand finishes');
});

test('preparation leaves shared publication available and different targets build concurrently without losing success', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'runtime-flight-scope-' });
  const authority = { producerStackName: 'producer', producerStackBaseDir: fixture.root };
  const native = { platform: process.platform, arch: process.arch };
  const foreign = { platform: process.platform, arch: process.arch === 'x64' ? 'arm64' : 'x64' };
  let release;
  let preparing;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { preparing = resolve; });
  const makeArtifact = (fingerprint, target) => {
    const artifactDir = fixture.path('artifacts', 'web', fingerprint);
    mkdirSync(join(artifactDir, 'payload'), { recursive: true });
    writeFileSync(join(artifactDir, 'payload', 'index.html'), '<html>web</html>');
    const manifest = { version: 1, component: 'web', artifactFingerprint: fingerprint,
      sourceFingerprint: fingerprint, payloadDir: 'payload', entrypoint: 'index.html', target };
    writeFileSync(join(artifactDir, 'manifest.json'), JSON.stringify(manifest));
    return { artifactDir, manifest };
  };
  const selection = { components: { web: true }, activateRuntime: false };
  const first = withRuntimePublicationFlight({ authority, target: native, selection, observedStartedSeq: 0,
    publish: async () => {
      preparing();
      await gate;
      return { artifacts: { web: makeArtifact('native', native) }, snapshotId: null };
    } });
  t.after(async () => { release(); await first; });
  await started;
  assert.equal(existsSync(fixture.path('runtime', 'publication.lock')), false,
    'dependency preparation and compilation must not own the shared publication lock');
  await withRuntimePublicationAdmission({ authority, publish: async () => {
    writeFileSync(fixture.path('independent-activation'), 'selected');
  } });
  const second = await withRuntimePublicationFlight({ authority, target: foreign, selection, observedStartedSeq: 0,
    publish: async () => ({ artifacts: { web: makeArtifact('foreign', foreign) }, snapshotId: null }) });
  assert.equal(second.publicationFlight, 'built');
  release();
  await first;
  for (const target of [native, foreign]) {
    const joined = await withRuntimePublicationFlight({ authority, target, selection, observedStartedSeq: 0,
      publish: async () => { throw new Error('concurrent success must be retained'); } });
    assert.equal(joined.publicationFlight, 'joined');
  }
});

test('publication demand cannot join a completed flight for a different target', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'target-flight-' });
  const authority = { producerStackName: 'producer', producerStackBaseDir: fixture.root };
  const artifactDir = fixture.path('artifacts', 'web', 'first');
  mkdirSync(join(artifactDir, 'payload'), { recursive: true });
  writeFileSync(join(artifactDir, 'payload', 'index.html'), '<html>web</html>');
  const manifest = { version: 1, component: 'web', artifactFingerprint: 'first', sourceFingerprint: 'source', payloadDir: 'payload', entrypoint: 'index.html' };
  writeFileSync(join(artifactDir, 'manifest.json'), JSON.stringify(manifest));
  const options = { authority, observedStartedSeq: 0, selection: { components: { web: true }, activateRuntime: false },
    publish: async () => ({ artifacts: { web: { artifactDir, manifest } }, snapshotId: null }) };
  await withRuntimePublicationFlight({ ...options, target: { platform: 'linux', arch: 'arm64' } });
  await assert.rejects(withRuntimePublicationFlight({ ...options, target: { platform: 'linux', arch: 'x64' },
    publish: async () => { throw new Error('target build required'); } }), /target build required/);
});

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
    seq: 1, targets: { [`${process.platform}/${process.arch}`]: { components: {
      web: { seq: 1, artifactFingerprint: 'web', snapshotId: null },
    } } },
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
const [root, id, componentsJson, fail, observationRaw, clockBack, optionsJson] = process.argv.slice(1);
const options = JSON.parse(optionsJson || '{}');
const components = JSON.parse(componentsJson);
if (clockBack) { const now = Date.now; Date.now = () => now() - Number(clockBack); }
const authority = { producerStackName: 'producer', producerStackBaseDir: root,
  consumerStackName: id, consumerStackBaseDir: join(root, 'stacks', id) };
const observedStartedSeq = observationRaw ? JSON.parse(observationRaw) : owner.captureRuntimePublicationStartedSeq({ authority });
await writeFile(join(root, id + '.requested'), JSON.stringify(observedStartedSeq));
const selection = { components: Object.fromEntries(components.map(c => [c, true])), activateRuntime: options.activateRuntime === true };
const env = { ...process.env, HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0',
  HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'), HAPPIER_STACK_STACK: id };
// The workload is the OS/compiler boundary: real processes and filesystem
// artifacts. Admission, reuse, locking and runtime-state writes remain real.
const publish = async ({ selection: admittedSelection = selection, selectConsumer = false } = {}) => {
  const admittedComponents = Object.keys(admittedSelection.components).filter(c => admittedSelection.components[c]);
  await mkdir(join(root, 'preparing'));
  await writeFile(join(root, id + '.started'), String(Date.now()));
  await writeFile(join(root, id + '.selection'), JSON.stringify({ ...admittedSelection, selectConsumer }));
  try {
    while (!existsSync(join(root, id + '.release'))) await delay(10);
    if (fail === 'fail') throw new Error('compiler failed');
    const input = await readFile(join(root, 'input'), 'utf8');
    const source = { input, repoDir: root, sourceFingerprint: input,
      serverComponent: 'happier-server-light', dbProvider: 'sqlite', builtAt: new Date().toISOString() };
    const artifacts = {};
    for (const component of admittedComponents) {
      const artifactDir = join(root, 'artifacts', component, input);
      await mkdir(join(artifactDir, 'payload'), { recursive: true });
      await writeFile(join(artifactDir, 'payload', 'entrypoint'), input);
      if (component === 'daemon') {
        await mkdir(join(artifactDir, 'payload', 'package-dist'), { recursive: true });
        await writeFile(join(artifactDir, 'payload', 'package-dist', 'index.mjs'), 'export {};');
        await writeFile(join(artifactDir, 'payload', 'package-dist', '.build-manifest.json'),
          JSON.stringify({ fingerprint: '0123456789abcdef', fileCount: 1 }));
      }
      const manifest = {
        version: 1, artifactFingerprint: input, component,
        sourceFingerprint: input, source,
        entrypoint: 'entrypoint', payloadDir: 'payload', createdAt: new Date().toISOString(),
      };
      await writeFile(join(artifactDir, 'manifest.json'), JSON.stringify(manifest));
      artifacts[component] = { artifactDir, manifest };
    }
    const publication = admittedSelection.activateRuntime || selectConsumer
      ? await owner.publishBuiltRepositoryRuntimeSnapshot({ authority, selection: admittedSelection,
          requestedComponents: admittedComponents, sourceMetadata: source, artifacts, env,
          retentionPolicy: { runtimeSnapshotKeepCount: 4 } })
      : { snapshotId: null, snapshotPath: null };
    return { ok: true, ...publication, artifacts, source };
  } finally { await rm(join(root, 'preparing'), { recursive: true }); }
};
const flight = owner.withRuntimePublicationFlight;
try {
  const result = await flight({
    authority,
    selection, observedStartedSeq,
    env, publish, selectConsumer: options.selectConsumer === true,
  });
  await writeFile(join(root, id + '.result'), JSON.stringify(result));
} catch (error) {
  await writeFile(join(root, id + '.error'), error.message);
  process.stderr.write(error.stack + '\\n');
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

test('worker placement wait retains one merged demand without holding the target flight lock', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'runtime-placement-wait-' });
  const authority = { producerStackName: 'producer', producerStackBaseDir: fixture.root };
  const target = { platform: process.platform, arch: process.arch };
  const lockPath = fixture.path('runtime', `publication.${target.platform}-${target.arch}.lock`);
  const artifactDir = fixture.path('artifacts', 'web', 'admitted');
  mkdirSync(join(artifactDir, 'payload'), { recursive: true });
  writeFileSync(join(artifactDir, 'payload', 'index.html'), '<html>admitted</html>');
  const manifest = { version: 1, component: 'web', artifactFingerprint: 'admitted',
    sourceFingerprint: 'admitted', payloadDir: 'payload', entrypoint: 'index.html', target };
  writeFileSync(join(artifactDir, 'manifest.json'), JSON.stringify(manifest));
  let release;
  let waiting;
  let admitted = false;
  let placements = 0;
  const permit = new Promise(resolve => { release = resolve; });
  const entering = new Promise(resolve => { waiting = resolve; });
  const options = { authority, target, observedStartedSeq: 0,
    selection: { components: { web: true }, activateRuntime: false },
    // Worker admission is the OS boundary. Demand merging, locks, integrity and
    // successful publication reuse beneath it remain real.
    admitExecution: async ({ run }) => {
      placements += 1;
      waiting();
      await permit;
      admitted = true;
      return await run({});
    },
    publish: async () => {
      assert.equal(admitted, true, 'compilation must wait for actual worker admission');
      assert.equal(existsSync(lockPath), true, 'execution owns the target lease');
      return { artifacts: { web: { artifactDir, manifest } }, snapshotId: null };
    },
  };
  const first = withRuntimePublicationFlight(options);
  first.catch(() => {});
  t.after(async () => { release(); await first.catch(() => {}); });
  await Promise.race([entering, first]);
  assert.equal(existsSync(lockPath), false, 'worker pressure is not target execution');
  assert.equal(existsSync(fixture.path('runtime', 'publication.lock')), false);
  const second = withRuntimePublicationFlight(options);
  second.catch(() => {});
  t.after(async () => { release(); await second.catch(() => {}); });
  await waitForPendingDemands(fixture, 2, Promise.all([first, second]));
  assert.equal(placements, 1, 'same-target demand must not register a second worker job');
  release();
  assert.deepEqual((await Promise.all([first, second])).map(result => result.publicationFlight).sort(), ['built', 'joined']);
  assert.equal(placements, 1, 'a covered follower joins without worker admission');
});

function waitForPendingDemands(fixture, count, completion) {
  const directory = fixture.path('runtime', 'publication-demands');
  return new Promise((resolve, reject) => {
    const check = () => {
      const demands = readdirSync(directory).filter(name => !name.startsWith('.') && name.endsWith('.json'));
      if (demands.length < count) return false;
      watcher.close();
      resolve();
      return true;
    };
    const watcher = watch(directory, check);
    watcher.on('error', error => { watcher.close(); reject(error); });
    check();
    completion.then(result => {
      if (check()) return;
      watcher.close();
      reject(new Error(`workers exited before registering ${count} demands: ${JSON.stringify(result)}`));
    }, error => { watcher.close(); reject(error); });
  });
}

function launch(t, fixture, id, components = ['server'], fail = '', observedStartedSeq = '', clockBack = '', options = {}) {
  const child = spawnTestProcess(process.execPath, ['--input-type=module', '-e', workerSource,
    fixture.root, id, JSON.stringify(components), fail, String(observedStartedSeq), String(clockBack), JSON.stringify(options)], { stdio: ['ignore', 'ignore', 'pipe'] });
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

test('five concurrent requests serialize preparation and join one trailing publication with latest inputs', async (t) => {
  const fixture = await createFlightFixture(t, 'runtime-publication-flight-');
  writeFileSync(fixture.path('input'), 'first');
  const first = launch(t, fixture, 'first');
  await waitFor(fixture.path('first.started'), first.completion);
  const waiters = ['second', 'third', 'fourth', 'fifth'].map(id => ({ id, ...launch(t, fixture, id) }));
  await Promise.all(waiters.map(({ id, completion }) => waitFor(fixture.path(id + '.requested'), completion)));
  await waitForPendingDemands(fixture, 5, Promise.all(waiters.map(({ completion }) => completion)));
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
  assert.deepEqual(completions.map(r => r.code), [0, 0, 0, 0]);
  const results = waiters.map(({ id }) => JSON.parse(readFileSync(fixture.path(id + '.result'), 'utf8')));
  assert.deepEqual(results.map(r => r.publicationFlight).sort(), ['built', 'joined', 'joined', 'joined']);
  assert.equal(waiters.filter(({ id }) => existsSync(fixture.path(id + '.started'))).length, 1);
  assert.ok(results.every(r => r.artifacts.server.manifest.artifactFingerprint === 'latest'));
  assert.ok(completions.some(r => /publication\.[^.]+\.lock.*pid=/.test(r.stderr)), 'waiters report the actual target flight holder');
  assert.equal((await late.completion).code, 0);
  assert.equal(JSON.parse(readFileSync(fixture.path('late.result'), 'utf8')).publicationFlight, 'joined');
  assert.equal(existsSync(fixture.path('late.started')), false);
});

test('mixed pending daemon, server and all demands share exactly one following publication', async (t) => {
  const fixture = await createFlightFixture(t, 'runtime-flight-demand-union-');
  writeFileSync(fixture.path('input'), 'first');
  const first = launch(t, fixture, 'first');
  await waitFor(fixture.path('first.started'), first.completion);
  const waiters = [ ['daemon', ['daemon']], ['server', ['server']], ['all', ['web', 'server', 'daemon']] ]
    .map(([id, components]) => ({ id, components, ...launch(t, fixture, id, components, '', '', '',
      id === 'all' ? { activateRuntime: true, selectConsumer: true } : {}) }));
  await Promise.all(waiters.map(({ id, completion }) => waitFor(fixture.path(id + '.requested'), completion)));
  await waitForPendingDemands(fixture, 4, Promise.all(waiters.map(({ completion }) => completion)));
  writeFileSync(fixture.path('input'), 'latest');
  writeFileSync(fixture.path('first.release'), 'release');
  assert.equal((await first.completion).code, 0);
  const trailingPath = await waitForAny(waiters.map(({ id }) => fixture.path(id + '.started')),
    Promise.all(waiters.map(({ completion }) => completion)));
  const trailing = waiters.find(({ id }) => fixture.path(id + '.started') === trailingPath);
  for (const { id } of waiters) writeFileSync(fixture.path(id + '.release'), 'release');
  assert.ok((await Promise.all(waiters.map(({ completion }) => completion))).every(result => result.code === 0));
  assert.equal(waiters.filter(({ id }) => existsSync(fixture.path(id + '.started'))).length, 1,
    'the one following workload must build the union, whichever waiter acquires admission');
  const built = JSON.parse(readFileSync(fixture.path(trailing.id + '.result'), 'utf8'));
  assert.deepEqual(Object.keys(built.artifacts).sort(), ['daemon', 'server', 'web']);
  const admittedSelection = JSON.parse(readFileSync(fixture.path(trailing.id + '.selection'), 'utf8'));
  assert.equal(admittedSelection.activateRuntime, true, 'pending activation reaches the one admitted workload');
  assert.equal(admittedSelection.selectConsumer, true, 'pending selection reaches the one admitted workload');
  assert.ok(built.snapshotId, 'the union produces a selectable complete snapshot');
  for (const { id, components } of waiters) {
    const result = JSON.parse(readFileSync(fixture.path(id + '.result'), 'utf8'));
    assert.ok(components.every(component => result.artifacts[component]?.manifest.artifactFingerprint === 'latest'));
    assert.equal(result.selected === true, id === 'all', 'each requester controls only its own consumer selection');
  }
});

test('an interleaved other-target success preserves earlier per-component completed demand', async (t) => {
  const fixture = await createFlightFixture(t, 'runtime-flight-target-history-');
  const authority = { producerStackName: 'producer', producerStackBaseDir: fixture.root };
  const makeArtifact = (component, fingerprint, target) => {
    const artifactDir = fixture.path('artifacts', component, fingerprint);
    mkdirSync(join(artifactDir, 'payload'), { recursive: true });
    writeFileSync(join(artifactDir, 'payload', 'entrypoint'), fingerprint);
    const manifest = { version: 1, component, artifactFingerprint: fingerprint, sourceFingerprint: fingerprint,
      entrypoint: 'entrypoint', payloadDir: 'payload', target };
    writeFileSync(join(artifactDir, 'manifest.json'), JSON.stringify(manifest));
    return { artifactDir, manifest };
  };
  const target = { platform: process.platform, arch: process.arch };
  const otherTarget = { platform: process.platform, arch: process.arch === 'arm64' ? 'x64' : 'arm64' };
  const web = makeArtifact('web', 'web-native', target);
  const server = makeArtifact('server', 'server-native', target);
  const foreign = makeArtifact('web', 'web-foreign', otherTarget);
  for (const [component, artifact, flightTarget] of [['web', web, target], ['server', server, target], ['web', foreign, otherTarget]]) {
    await withRuntimePublicationFlight({ authority, target: flightTarget,
      selection: { components: { [component]: true }, activateRuntime: false },
      publish: async () => ({ artifacts: { [component]: artifact }, snapshotId: null }) });
  }
  const joined = await withRuntimePublicationFlight({ authority, target, observedStartedSeq: 0,
    selection: { components: { web: true, server: true }, activateRuntime: false },
    publish: async () => { throw new Error('satisfied components must not rebuild'); } });
  assert.equal(joined.publicationFlight, 'joined');
  assert.equal(joined.artifacts.web.manifest.artifactFingerprint, 'web-native');
  assert.equal(joined.artifacts.server.manifest.artifactFingerprint, 'server-native');
});

test('joined component history uses its retained snapshot or composes a successful mixed vector without rebuilding', async (t) => {
  const fixture = await createFlightFixture(t, 'runtime-flight-component-snapshots-');
  const owner = await import(ownerUrl);
  const authority = { producerStackName: 'producer', producerStackBaseDir: fixture.root };
  const env = { ...process.env, HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks') };
  await writeManagedRuntimeSnapshotLayout({ stackDir: fixture.root, snapshotId: 'old' });
  await writeManagedRuntimeSnapshotLayout({ stackDir: fixture.root, snapshotId: 'newer' });
  const source = { repoDir: fixture.root, sourceFingerprint: 'managed-source', serverComponent: 'happier-server-light', dbProvider: 'sqlite' };
  const artifact = (component, suffix) => {
    const artifactDir = fixture.path('artifacts', component, `${component}-${suffix}`);
    const path = join(artifactDir, 'manifest.json');
    const manifest = { ...JSON.parse(readFileSync(path, 'utf8')), source };
    writeFileSync(path, JSON.stringify(manifest));
    return { artifactDir, manifest };
  };
  const completed = [];
  for (const [component, suffix] of [['web', 'old'], ['server', 'newer']]) {
    completed.push(await owner.withRuntimePublicationFlight({ authority, env,
      selection: { components: { [component]: true }, activateRuntime: false },
      publish: async () => {
        const publication = await owner.publishBuiltRepositoryRuntimeSnapshot({ authority, env, selection: { components: { [component]: true } },
          requestedComponents: ['web', 'server', 'daemon'], sourceMetadata: source,
          artifacts: Object.fromEntries(['web', 'server', 'daemon'].map(c => [c, artifact(c, suffix)])),
          retentionPolicy: { runtimeSnapshotKeepCount: 4 } });
        return { ...publication, artifacts: { [component]: artifact(component, suffix) } };
      } }));
  }
  const options = { authority, env, observedStartedSeq: 0,
    publish: async () => { throw new Error('successful component history must not rebuild'); } };
  const web = await owner.withRuntimePublicationFlight({ ...options,
    selection: { components: { web: true }, activateRuntime: false } });
  assert.equal(web.publicationFlight, 'joined');
  assert.equal(web.snapshotId, completed[0].snapshotId, 'the newer server snapshot cannot replace the retained web completion');
  const mixed = await owner.withRuntimePublicationFlight({ ...options,
    selection: { components: { web: true, server: true }, activateRuntime: false } });
  assert.equal(mixed.publicationFlight, 'joined');
  assert.equal(mixed.artifacts.web.manifest.artifactFingerprint, 'web-old');
  assert.equal(mixed.artifacts.server.manifest.artifactFingerprint, 'server-newer');
  const manifest = JSON.parse(readFileSync(join(mixed.snapshotPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.components.web.artifactFingerprint, 'web-old');
  assert.equal(manifest.components.server.artifactFingerprint, 'server-newer');
});

test('dead waiter demand does not add components or activation to the next publication', async (t) => {
  const fixture = await createFlightFixture(t, 'runtime-flight-dead-demand-');
  const child = spawnTestProcess(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  const demandDir = fixture.path('runtime', 'publication-demands');
  mkdirSync(demandDir, { recursive: true });
  const deadPath = join(demandDir, 'dead-waiter.json');
  writeFileSync(deadPath, JSON.stringify({ pid: child.pid, target: { platform: process.platform, arch: process.arch },
    components: ['daemon'], activateRuntime: true, selectConsumer: true, observedStartedSeq: 0 }));
  const reusedPath = join(demandDir, 'reused-pid.json');
  writeFileSync(reusedPath, JSON.stringify({ pid: process.pid,
    processInstanceFingerprint: readProcessInstanceFingerprintSync(process.pid) + '-prior-process',
    target: { platform: process.platform, arch: process.arch }, components: ['web'],
    activateRuntime: true, selectConsumer: true, observedStartedSeq: 0 }));
  writeFileSync(fixture.path('input'), 'server-only');
  writeFileSync(fixture.path('live.release'), 'release');
  assert.equal((await launch(t, fixture, 'live').completion).code, 0);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(fixture.path('live.result'), 'utf8')).artifacts), ['server']);
  const selection = JSON.parse(readFileSync(fixture.path('live.selection'), 'utf8'));
  assert.equal(selection.activateRuntime, false);
  assert.equal(selection.selectConsumer, false);
  assert.equal(existsSync(deadPath), false, 'dead request is reclaimed by the publication owner');
  assert.equal(existsSync(reusedPath), false, 'a live recycled PID does not retain the former process demand');
  assert.deepEqual(readdirSync(demandDir), [], 'completed request leaves no live demand');
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
  assert.ok(completions.every(({ stderr }) => /publication(?:\.[^.]+)?\.lock/.test(stderr)));
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
  const published = await owner.buildStackArtifacts({
    rootDir: fixture.path('absent-source'), argv: ['--daemon'],
    authority, env, observedStartedSeq,
  });
  assert.equal(published.publicationFlight, 'joined');
  assert.ok(published.snapshotId);
  assert.equal(published.selected, false);
  assert.equal(existsSync(join(authority.consumerStackBaseDir, 'runtime', 'current.json')), false);
  assert.equal(existsSync(join(authority.producerStackBaseDir, 'runtime', 'current.json')), false,
    'a joined publication without activation must not select the producer');
  const joined = await owner.buildStackArtifacts({
    rootDir: fixture.path('absent-source'), argv: ['--all', '--activate-runtime'],
    authority, env, observedStartedSeq,
  });
  assert.equal(joined.publicationFlight, 'joined');
  assert.equal(joined.selected, true);
  assert.equal(joined.consumerStackName, 'consumer');
  assert.equal(built.snapshotId, null);
  assert.ok(joined.snapshotId);
  assert.equal(joined.snapshotId, published.snapshotId);
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
