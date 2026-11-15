// @happier-test-preparation source-condition
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveInstalledFirstPartyComponentPaths } from '@happier-dev/cli-common/firstPartyRuntime';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawnTestProcess } from './testkit/core/spawn_test_process.mjs';
import { applyStackDaemonLifecycleScopeEnv } from './utils/auth/stable_scope_id.mjs';
import { resolvePreferredStackDaemonStatePaths } from './utils/auth/credentials_paths.mjs';

import { withPatchedProcessEnv } from './testkit/core/env_scope.mjs';
import { createRuntimeSnapshotFixture } from './testkit/runtime_snapshot_testkit.mjs';
import { writeRuntimeSnapshotLayout } from './testkit/core/runtime_snapshot_layout.mjs';
import { readStackInfoSnapshot } from './stack/stack_info_snapshot.mjs';
import { resolveRemoteStackStatePaths } from './utils/dev_targets/remote_commands.mjs';
import { runCommandCapture } from './testkit/core/run_node_capture.mjs';

test('reload observes the managed CLI through its install owner and preserves absence', async t => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'managed-cli-info' });
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_FIRST_PARTY_INSTALL_HOME: join(fixture.root, 'installed') });
  const readInfo = () => readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
  assert.deepEqual((await readInfo()).runtime.managedCli, { status: 'absent', binaryPath: null });
  const paths = resolveInstalledFirstPartyComponentPaths({ componentId: 'happier-cli', processEnv: process.env });
  const binaryPath = paths.resolvedBinaryPath ?? paths.binaryPath;
  await mkdir(dirname(binaryPath), { recursive: true });
  await writeFile(binaryPath, 'managed-cli-fixture');
  assert.deepEqual((await readInfo()).runtime.managedCli, { status: 'installed', binaryPath });
});

test('reload observes managed CLI on the daemon host without substituting the controller install', async t => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'remote-managed-cli-info' });
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  await writeFile(join(fixture.stackDir, 'dev-targets.json'), JSON.stringify({ version: 3,
    targets: [{ name: 'worker', platform: 'posix', ssh: 'daemon-worker', repoDir: process.cwd(),
      cliHomeDir: join(fixture.root, 'worker-cli') }] }));
  await writeFile(join(fixture.stackDir, 'stack.runtime.json'), JSON.stringify({ version: 1,
    stackName: fixture.stackName, sourceRuntimeIdentities: {}, placement: { daemon: 'worker' },
    remoteTargets: { worker: { runtimeMode: 'source-snapshot', services: { daemon: true },
      status: 'running', serviceStatus: { daemon: 'running' } } } }));
  const managedCli = { status: 'installed', binaryPath: '/worker/cli/versions/one/happier' };
  // SSH is the system boundary; the real runtime observer and snapshot projection remain in use.
  const readInfo = out => readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName,
    synchronizeDaemonState: false, runRemoteProcessImpl: async () => ({ code: 0, out: JSON.stringify(out) }) });
  const observation = { serviceStatus: { daemon: 'running' },
    sourceRuntimeIdentities: { daemon: { selected: 'daemon-code', loaded: 'daemon-code' } }, managedCli };
  observation.daemonEntry = { selected: '/worker/source/cli/src/index.mjs', loaded: '/worker/managed/package-dist/index.mjs' };
  observation.daemonParticipants = [{ identity: 'account-b', status: 'running', selected: 'daemon-code',
    loaded: 'old-code', sourceTime: '2026-11-03T12:59:00.000Z', reason: 'participant_source_stale' }];
  assert.deepEqual((await readInfo(observation)).runtime.managedCli, managedCli);
  assert.deepEqual((await readInfo(observation)).runtime.daemonEntry, observation.daemonEntry);
  assert.deepEqual((await readInfo(observation)).runtime.daemonParticipants, observation.daemonParticipants);
  const runtimePath = join(fixture.stackDir, 'stack.runtime.json');
  const incumbent = JSON.parse(await readFile(runtimePath, 'utf8'));
  await writeFile(runtimePath, JSON.stringify({ ...incumbent,
    stopRequest: { requestedAt: new Date().toISOString() } }));
  const interrupted = await readInfo(observation);
  assert.deepEqual(interrupted.runtime.managedCli, managedCli,
    'an interrupted stop must retain the observation needed to verify its recovery');
  assert.ok(interrupted.runtime.health.issues.includes('stop_cleanup_incomplete'));
  delete observation.managedCli;
  delete observation.daemonEntry;
  assert.equal((await readInfo(observation)).runtime.managedCli, null);
  assert.equal((await readInfo(observation)).runtime.daemonEntry, null);
});

test('stack info reports remembered port changes without claiming a stopped controller URL is live', async t => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'stable-port-info' });
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  const portAllocations = { controller: { port: 43124, previousPort: 43123, reason: 'previous-port-occupied' },
    servers: { nl3: { port: 14322, previousPort: 14321, reason: 'previous-port-occupied' } } };
  await writeFile(join(fixture.stackDir, 'stack.runtime.json'), JSON.stringify({ version: 1,
    stackName: fixture.stackName, ownerPid: null, processes: {}, portAllocations }));
  const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
  assert.deepEqual(out.runtime.portAllocations, portAllocations);
  assert.equal(out.urls.internalServerUrl, null);
  assert.equal(out.ports.server, null);
});

test('stack info preserves distinct remote loaded source times without controller substitution', async t => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'source-times-info' });
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  await writeFile(join(fixture.stackDir, 'env'), 'HAPPIER_STACK_RUNTIME_MODE=source-snapshot\nHAPPIER_STACK_SERVE_UI=0\nHAPPIER_STACK_DAEMON=0\n');
  const serverTime = '2026-10-29T12:01:00.000Z';
  const daemonTime = '2026-10-29T12:03:00.000Z';
  const remoteTargets = Object.fromEntries([['server', serverTime], ['daemon', daemonTime]].map(([component, sourceTime]) =>
    [component, { runtimeMode: 'source-snapshot', services: { [component]: true }, status: 'running',
      serviceStatus: { [component]: 'running' },
      sourceRuntimeIdentities: { [component]: { selected: `${component}-code`, loaded: `${component}-code`, sourceTime } } }]));
  const statePath = join(fixture.stackDir, 'stack.runtime.json');
  const state = { version: 1, stackName: fixture.stackName, sourceRuntimeIdentities: {},
    placement: { server: 'server', daemon: 'daemon' }, remoteTargets };
  await writeFile(statePath, JSON.stringify(state));
  const readInfo = () => readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName,
    observeRemoteSourceRuntime: false, synchronizeDaemonState: false });
  const out = await readInfo();
  assert.equal(out.runtime.sourceRuntimeIdentities.server.sourceTime, serverTime);
  assert.equal(out.runtime.sourceRuntimeIdentities.daemon.sourceTime, daemonTime);

  await writeFile(join(fixture.stackDir, 'dev-targets.json'), JSON.stringify({ version: 3,
    targets: ['server', 'daemon'].map(name => ({ name, platform: 'posix', ssh: `${name}-ssh`,
      repoDir: process.cwd(), cliHomeDir: join(fixture.root, name, 'cli') })) }));
  let observations = 0;
  const observed = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName,
    synchronizeDaemonState: false, runRemoteProcessImpl: async ({ args }) => {
      observations++;
      const component = args.includes('server-ssh') ? 'server' : 'daemon';
      return { code: 0, out: JSON.stringify({ serviceStatus: { [component]: 'running' },
        sourceRuntimeIdentities: state.remoteTargets[component].sourceRuntimeIdentities,
        ...(component === 'server' ? { database: { provider: 'sqlite', sharedSource: false,
          sourceStack: null, filesBackend: 'local', basis: 'loaded-source-bundle' } } : {}) }) };
    } });
  assert.equal(observed.runtime.sourceRuntimeIdentities.server.sourceTime, serverTime);
  assert.equal(observed.runtime.sourceRuntimeIdentities.daemon.sourceTime, daemonTime);
  assert.equal(observations, 2, 'source times ride the existing one observation per runtime host');

  const entrypoint = join(fixture.stackDir, 'controller-bundle/apps/server/sources/main.mjs');
  await mkdir(join(fixture.stackDir, 'source-runtime'), { recursive: true });
  await mkdir(join(fixture.stackDir, 'controller-bundle/apps/server/sources'), { recursive: true });
  await writeFile(entrypoint, 'export {};');
  await writeFile(join(fixture.stackDir, 'controller-bundle/source-bundle.json'), JSON.stringify({ identity: 'server-code', entrypoint }));
  await writeFile(join(fixture.stackDir, 'source-runtime/selected-server.json'), JSON.stringify({ entrypoint }));
  delete state.remoteTargets.server.sourceRuntimeIdentities.server.sourceTime;
  await writeFile(statePath, JSON.stringify(state));
  assert.equal((await readInfo()).runtime.sourceRuntimeIdentities.server.sourceTime ?? null, null,
    'remote capture metadata must never come from a controller completion record');
});

test('stack info lists only running shared database co-writers and compares loaded bundle times', async t => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'new-consumer' });
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  const sourceStack = 'database-source';
  const sourceEnvPath = join(fixture.storageDir, sourceStack, 'env');
  // Live peers are recorded by a live, stack-owned lifecycle process (the real process boundary).
  const ownedLifecycle = name => {
    const child = spawnTestProcess(process.execPath, ['-e', 'setInterval(() => {}, 60000)'],
      { env: { ...process.env, HAPPIER_STACK_STACK: name, HAPPIER_STACK_ENV_FILE: join(fixture.storageDir, name, 'env'),
        HAPPIER_STACK_PROCESS_KIND: 'infra' } });
    t.after(() => child.kill('SIGKILL'));
    return child.pid;
  };
  const exitedPid = async () => {
    const child = spawnTestProcess(process.execPath, ['-e', '']);
    await once(child, 'exit');
    return child.pid;
  };
  async function writeStack(name, { identity, time, source = sourceStack, status = 'running', selected = identity,
    ownerPid = ownedLifecycle(name) }) {
    const baseDir = join(fixture.storageDir, name);
    const bundleDir = join(baseDir, 'bundle');
    const entrypoint = join(bundleDir, 'apps/server/sources/main.mjs');
    await mkdir(join(bundleDir, 'apps/server/sources'), { recursive: true });
    await mkdir(join(baseDir, 'source-runtime'), { recursive: true });
    await writeFile(entrypoint, 'export {};\n');
    const manifestPath = join(bundleDir, 'source-bundle.json');
    await writeFile(manifestPath, JSON.stringify({ identity, entrypoint }));
    await utimes(manifestPath, new Date(time), new Date(time));
    await writeFile(join(baseDir, 'source-runtime/selected-server.json'), JSON.stringify({ entrypoint }));
    await writeFile(join(baseDir, 'env'), 'HAPPIER_STACK_RUNTIME_MODE=source-snapshot\nHAPPIER_STACK_SERVE_UI=0\nHAPPIER_STACK_DAEMON=0\nHAPPIER_DB_PROVIDER=sqlite\n'
      + (source ? `HAPPIER_STACK_SHARED_DB_SOURCE_STACK=${source}\nHAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE=${sourceEnvPath}\n` : ''));
    await writeFile(join(baseDir, 'stack.runtime.json'), JSON.stringify({ version: 1, stackName: name, ownerPid,
      startedAt: new Date().toISOString(), sourceRuntimeIdentities: { server: { selected, loaded: identity } },
      placement: { server: 'worker' }, remoteTargets: { worker: { services: { server: true }, startedAt: time,
        status, serviceStatus: { server: status }, sourceRuntimeIdentities: { server: { selected, loaded: identity, sourceTime: time } } } } }));
  }
  await writeStack(sourceStack, { identity: 'source-build', time: '2026-10-26T12:00:00.000Z', source: null });
  await writeStack(fixture.stackName, { identity: 'new-build', time: '2026-10-28T12:00:00.000Z' });
  await writeStack('older-consumer', { identity: 'old-build', time: '2026-10-27T12:00:00.000Z', selected: 'pending-build' });
  await writeStack('stopped-consumer', { identity: 'stopped-build', time: '2026-10-25T12:00:00.000Z', status: 'stopped' });
  // A remote record still saying "running" after the controller lifecycle that wrote it exited is a
  // ghost (agent-qa-capabilities/-coord-n2/-changes-walkthrough on 2026-11-15), not a co-writer.
  await writeStack('abandoned-consumer', { identity: 'abandoned-build', time: '2026-10-24T12:00:00.000Z',
    ownerPid: await exitedPid() });
  await writeStack('unrelated-stack', { identity: 'unrelated-build', time: '2026-10-24T12:00:00.000Z', source: null });
  let remoteReads = 0;
  const readInfo = stackName => readStackInfoSnapshot({ rootDir: process.cwd(), stackName,
    observeRemoteSourceRuntime: false, synchronizeDaemonState: false,
    runRemoteProcessImpl: async () => { remoteReads++; throw new Error('unexpected remote observation'); } });
  const out = await readInfo(fixture.stackName);
  assert.equal(out.sharedDatabase.sourceStack, sourceStack);
  assert.equal(out.sharedDatabase.role, 'consumer');
  assert.equal(out.sharedDatabase.basis, 'local-stack-state');
  assert.deepEqual(out.sharedDatabase.coWriters.map(({ stackName, role, loadedSourceIdentity, staleCoWriter, host, startedAt }) =>
    ({ stackName, role, loadedSourceIdentity, staleCoWriter, host, startedAt })), [
    { stackName: sourceStack, role: 'source', loadedSourceIdentity: 'source-build', staleCoWriter: true,
      host: 'worker', startedAt: '2026-10-26T12:00:00.000Z' },
    { stackName: 'older-consumer', role: 'consumer', loadedSourceIdentity: 'old-build', staleCoWriter: true,
      host: 'worker', startedAt: '2026-10-27T12:00:00.000Z' },
  ]);
  const source = await readInfo(sourceStack);
  assert.equal(source.sharedDatabase.role, 'source');
  assert.deepEqual(source.sharedDatabase.coWriters.map(row => [row.stackName, row.staleCoWriter]),
    [['new-consumer', false], ['older-consumer', false]]);
  const pendingManifestPath = join(fixture.storageDir, 'older-consumer/bundle/source-bundle.json');
  const pendingManifest = JSON.parse(await readFile(pendingManifestPath, 'utf8'));
  await writeFile(pendingManifestPath, JSON.stringify({ ...pendingManifest, identity: 'pending-build' }));
  const unknownStatePath = join(fixture.storageDir, 'older-consumer/stack.runtime.json');
  const unknownState = JSON.parse(await readFile(unknownStatePath, 'utf8'));
  delete unknownState.remoteTargets.worker.sourceRuntimeIdentities.server.sourceTime;
  await writeFile(unknownStatePath, JSON.stringify(unknownState));
  const unknown = await readInfo(fixture.stackName);
  assert.equal(unknown.sharedDatabase.coWriters.find(row => row.stackName === 'older-consumer').staleCoWriter, null);
  assert.equal(unknown.sharedDatabase.coWriters.find(row => row.stackName === 'older-consumer').loadedSourceIdentity, 'old-build');
  const peerDir = join(fixture.storageDir, 'older-consumer');
  await writeRuntimeSnapshotLayout({ stackDir: peerDir, snapshotId: 'old-native',
    createdAt: '2026-10-27T00:00:00.000Z' });
  const peerStatePath = join(peerDir, 'stack.runtime.json');
  const peerState = JSON.parse(await readFile(peerStatePath, 'utf8'));
  peerState.sourceRuntimeIdentities = null;
  peerState.remoteTargets.worker.sourceRuntimeIdentities = null;
  peerState.remoteTargets.worker.runtimeMode = 'controlled';
  peerState.runtimeSnapshotId = 'old-native';
  const peerEnvPath = join(peerDir, 'env');
  await writeFile(peerEnvPath, (await readFile(peerEnvPath, 'utf8'))
    .replace('HAPPIER_STACK_RUNTIME_MODE=source-snapshot', 'HAPPIER_STACK_RUNTIME_MODE=require'));
  await writeFile(peerStatePath, JSON.stringify(peerState));
  const native = (await readInfo(fixture.stackName)).sharedDatabase.coWriters.find(row => row.stackName === 'older-consumer');
  assert.equal(native.loadedSnapshotId, 'old-native');
  assert.equal(native.loadedSourceIdentity, null);
  assert.equal(native.staleCoWriter, true);
  for (const name of [fixture.stackName, 'older-consumer']) {
    const path = join(fixture.storageDir, name, 'stack.runtime.json');
    const state = JSON.parse(await readFile(path, 'utf8'));
    state.remoteTargets.worker.serviceStatus.server = 'stopped';
    await writeFile(path, JSON.stringify(state));
  }
  assert.deepEqual((await readInfo(sourceStack)).sharedDatabase.coWriters, []);
  assert.equal(remoteReads, 0, 'co-writer inventory never contacts peer servers');
});

async function withHappierHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/ready') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? Number(address.port) : 0;
  return {
    port,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('readStackInfoSnapshot reports active runtime snapshot metadata', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'prod-dev' });
  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(out.runtime.activeSnapshotId, 'snap-1');
    assert.equal(Object.hasOwn(out, 'sharedDatabase'), false);
    assert.equal(out.runtime.snapshotPath, fixture.snapshotDir);
    assert.equal(out.runtime.valid, true);
    assert.equal(out.runtime.snapshotComponents.server.entrypoint, 'server/happier-server');
    assert.equal(out.runtime.runtimePublication, null);
  } finally {
    restore();
  }
});

test('stopped remote shared stack resolves configured database identity on the source host', async t => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'remote-db-info' });
  const repoDir = fileURLToPath(new URL('../../../', import.meta.url));
  const target = { name: 'worker', platform: 'posix', ssh: 'fixture-ssh', repoDir,
    cliHomeDir: join(fixture.root, 'worker', 'cli') };
  const paths = resolveRemoteStackStatePaths(target, { stackName: fixture.stackName, runtimeMode: 'source-snapshot' });
  const sourceEnvPath = join(fixture.root, 'source-env');
  const env = `HAPPIER_STACK_RUNTIME_MODE=source-snapshot\nHAPPIER_STACK_SERVE_UI=0\nHAPPIER_STACK_DAEMON=0\nHAPPIER_DB_PROVIDER=sqlite\nHAPPIER_STACK_SHARED_DB_SOURCE_STACK=source-dev\nHAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE=${sourceEnvPath}\n`;
  await writeFile(join(fixture.stackDir, 'env'), env);
  await mkdir(paths.stackBaseDir, { recursive: true });
  await writeFile(paths.stackEnvPath, env);
  await writeFile(sourceEnvPath, 'HAPPIER_DB_PROVIDER=sqlite\nHAPPIER_FILES_BACKEND=local\n');
  await writeFile(join(fixture.stackDir, 'dev-targets.json'), JSON.stringify({ version: 3,
    targets: [target], runtimePlacement: { server: { mode: 'prefer-target', target: target.name, fallback: 'error' } } }));
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  let probes = 0;
  const runRemoteProcessImpl = async ({ args }) => {
    probes++;
    const result = await runCommandCapture('bash', ['-c', args.at(-1)]);
    return { code: result.code, out: result.stdout, err: result.stderr };
  };
  const out = await readStackInfoSnapshot({ rootDir: repoDir, stackName: fixture.stackName, runRemoteProcessImpl });
  assert.deepEqual(out.database, { provider: 'sqlite', sharedSource: true, sourceStack: 'source-dev',
    filesBackend: 'local', basis: 'configured' });
  assert.equal(probes, 1, 'one host observation resolves configured identity without a running server or database');
  await rm(sourceEnvPath);
  const missing = await readStackInfoSnapshot({ rootDir: repoDir, stackName: fixture.stackName, runRemoteProcessImpl });
  assert.deepEqual(missing.database, { provider: null, sharedSource: true, sourceStack: 'source-dev',
    filesBackend: null, basis: 'unavailable' });
});

test('source snapshot info never depends on native selection and hides stopped loaded identities', async t => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'source-info' });
  await writeFile(join(fixture.stackDir, 'env'), 'HAPPIER_STACK_RUNTIME_MODE=source-snapshot\nHAPPIER_STACK_DAEMON=0\nHAPPIER_STACK_SERVE_UI=0\n');
  await writeFile(join(fixture.stackDir, 'stack.runtime.json'), JSON.stringify({ version: 1, stackName: fixture.stackName,
    ownerPid: 999999999, runtimeSnapshotId: null,
    sourceRuntimeIdentities: { server: { selected: 'new-code', loaded: 'old-code' } },
  }));
  const reload = { status: 'failed', message: 'candidate-entry-load-failed', logPath: join(fixture.stackDir, 'logs/run.reload.log'),
    component: 'server', entryGraph: 'server', firstFailingModule: 'apps/server/sources/refusal.ts',
    code: 'ESHAREDDBMIGRATIONSMISSING', sourceStack: 'repo-dev-a1cc5e0671',
    missingMigrations: ['20261029120000_missing_first', '20261029130000_missing_second'] };
  await mkdir(join(fixture.stackDir, 'source-runtime'), { recursive: true });
  await writeFile(join(fixture.stackDir, 'source-runtime/reload.json'), JSON.stringify(reload));
  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(out.runtime.mode, 'source-snapshot');
    assert.equal(out.runtime.selectedSnapshotId, null);
    assert.equal(out.runtime.loadedSnapshotId, null);
    assert.deepEqual(out.runtime.sourceRuntimeIdentities, { server: { selected: 'new-code', loaded: null } });
    assert.equal(out.runtime.pendingManualRestart, false);
    assert.deepEqual(out.runtime.sourceReload, reload);
  } finally { restore(); }
});

test('remote-only info reports the recorded running role and an incomplete stop instead of stopped', async t => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'remote-stop-info' });
  await writeFile(join(fixture.stackDir, 'env'), 'HAPPIER_STACK_RUNTIME_MODE=source-snapshot\nHAPPIER_STACK_DAEMON=1\nHAPPIER_STACK_SERVE_UI=0\n');
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  const runtimePath = join(fixture.stackDir, 'stack.runtime.json');
  const state = { version: 1, stackName: fixture.stackName, ownerPid: null, sourceRuntimeIdentities: {},
    placement: { daemon: 'linux1' }, remoteTargets: { linux1: { services: { daemon: true }, status: 'running', serviceStatus: { daemon: 'running' } } } };
  await writeFile(runtimePath, JSON.stringify(state));
  const running = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
  assert.equal(running.runtime.components.daemon.running, true);
  assert.equal(running.runtime.running, true, 'aggregate must include remote daemon ownership');
  assert.notEqual(running.runtime.health.status, 'stopped');
  await writeFile(runtimePath, JSON.stringify({ ...state, stopRequest: { requestedAt: '2026-10-09T00:00:00.000Z' },
    remoteTargets: { linux1: { services: { daemon: true }, status: 'failed', phase: 'stop', serviceStatus: { daemon: 'failed' } } } }));
  const failed = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
  assert.equal(failed.runtime.components.daemon.running, false, 'failure is not proof of running');
  assert.equal(failed.runtime.health.status, 'degraded');
  assert.ok(failed.runtime.health.issues.includes('stop_cleanup_incomplete'));
  await writeFile(runtimePath, JSON.stringify({ ...state,
    remoteTargets: { linux1: { services: { daemon: true }, status: 'failed', phase: 'stop', serviceStatus: { daemon: 'failed' } } } }));
  const ownerFailed = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
  assert.equal(ownerFailed.runtime.health.status, 'degraded', 'owner-initiated failed retirement also preserves remote custody');
});

test('source snapshot info defaults to borrowed Expo while preserving recorded export and headless choices', async t => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'source-ui-info' });
  const producerStackName = 'source-ui-producer';
  await writeFile(join(fixture.stackDir, 'env'), `HAPPIER_STACK_RUNTIME_MODE=source-snapshot\nHAPPIER_STACK_DAEMON=0\nHAPPIER_STACK_EXPO_SOURCE_STACK=${producerStackName}\n`);
  await mkdir(join(fixture.storageDir, producerStackName), { recursive: true });
  await writeFile(join(fixture.storageDir, producerStackName, 'stack.runtime.json'), JSON.stringify({ expo: {}, processes: {} }));
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  const sourceUiLaunch = { uiDir: '/remote/server/source-export/ui' };
  for (const sourceUi of [undefined, 'export', 'borrowed', 'disabled']) {
    await writeFile(join(fixture.stackDir, 'stack.runtime.json'), JSON.stringify({ version: 1, stackName: fixture.stackName,
      sourceRuntimeIdentities: {}, sourceUi, sourceUiLaunch,
    }));
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(Boolean(out.runtime.borrowedExpo), sourceUi == null || sourceUi === 'borrowed');
    assert.equal(out.runtime.sourceUi, sourceUi ?? 'borrowed');
    assert.deepEqual(out.runtime.sourceUiLaunch, sourceUi === 'export' ? sourceUiLaunch : null);
    if (sourceUi == null || sourceUi === 'borrowed') {
      assert.equal(out.runtime.borrowedExpo.producerStackName, producerStackName);
      assert.equal(out.runtime.components.ui.status, 'waiting for dev Expo');
    }
    if (sourceUi === 'disabled') assert.equal(out.runtime.components.ui.running, false);
  }
});

test('stack info exposes the foreign server pin but rejects a shared database consumer without admitted component placement', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'qa-shared-info' });
  const manifestPath = join(fixture.snapshotDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.target = { platform: 'darwin', arch: 'arm64' };
  manifest.components = { server: manifest.components.server };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await rm(join(fixture.snapshotDir, 'cli'), { recursive: true, force: true });
  await rm(join(fixture.snapshotDir, 'ui'), { recursive: true, force: true });
  await writeFile(join(fixture.stackDir, 'env'), 'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light\nHAPPIER_STACK_SHARED_DB_SOURCE_STACK=dev\n');
  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(out.runtime.valid, false);
    assert.match(out.runtime.errors.join('; '), /target is incompatible/);
    assert.match(out.runtime.errors.join('; '), /daemon snapshot.*placement host/);
    assert.equal(out.runtime.selectedSnapshotId, 'snap-1');
    assert.deepEqual(Object.keys(out.runtime.snapshotComponents), ['server']);
  } finally { restore(); }
});

test('stack info reports stale packages from the selected snapshot', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'qa-last-green-info' });
  const manifestPath = join(fixture.snapshotDir, 'manifest.json');
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const stalePackages = [
    { packageName: '@happier-dev/example', outputIdentity: 'prior-output', diagnosticSummary: 'error TS2322' },
    { packageName: '@happier-dev/cli', reason: 'typecheck', errorCount: 1, files: ['src/index.ts'], diagnosticSummary: 'src/index.ts(1,1): error TS2322: fixture' },
  ];
  manifest.components.daemon.stalePackages = stalePackages;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.deepEqual(out.runtime.snapshotComponents.daemon.stalePackages, stalePackages);
  } finally { restore(); }
});

test('readStackInfoSnapshot projects publication status from the existing runtime state', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'runtime-publication-status' });
  const status = {
    phase: 'publishing',
    components: {
      server: { phase: 'publishing', error: null },
      daemon: { phase: 'stale', error: null },
    },
    currentSnapshotId: 'snap-1',
  };
  await writeFile(
    join(fixture.stackDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName: fixture.stackName,
      ownerPid: 999_999_999,
      runtimePublication: status,
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.deepEqual(out.runtime.runtimePublication, status);
  } finally {
    restore();
  }
});

test('readStackInfoSnapshot does not adopt a healthy endpoint from stale runtime state', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'runtime-foreign-endpoint' });
  const listener = await withHappierHealthServer();
  await writeFile(
    join(fixture.stackDir, 'env'),
    `HAPPIER_STACK_SERVER_COMPONENT=happier-server-light\nHAPPIER_STACK_SERVER_PORT=${listener.port}\nHAPPIER_STACK_DAEMON=0\n`,
    'utf-8',
  );
  await writeFile(
    join(fixture.stackDir, 'stack.runtime.json'),
    JSON.stringify({
      version: 1,
      stackName: fixture.stackName,
      ownerPid: 999_999_999,
      runtimeSnapshotId: 'snap-stale',
      processes: { serverPid: 999_999_998 },
      ports: { server: listener.port },
    }) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(out.runtime.running, false);
    assert.equal(out.runtime.components.server.running, false);
    assert.equal(out.runtime.loadedSnapshotId, null);
    assert.equal(out.urls.internalServerUrl, null);
    assert.equal(out.urls.uiUrl, null);
  } finally {
    restore();
    await listener.close();
  }
});

test('readStackInfoSnapshot reports invalid runtime pointers instead of marking them valid', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'prod-dev' });
  await writeFile(
    join(fixture.stackDir, 'runtime', 'current.json'),
    JSON.stringify({
      version: 1,
      snapshotId: 'snap-1',
      snapshotPath: join(fixture.root, 'escaped-runtime'),
      sourceFingerprint: 'src-1',
    }, null, 2) + '\n',
    'utf-8',
  );

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(out.runtime.activeSnapshotId, 'snap-1');
    assert.equal(out.runtime.snapshotPath, join(fixture.root, 'escaped-runtime'));
    assert.equal(out.runtime.valid, false);
    assert.match(out.runtime.errors.join('\n'), /outside the stack runtime builds dir/i);
  } finally {
    restore();
  }
});

test('readStackInfoSnapshot reports runtime snapshots with missing daemon node entrypoints as invalid', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'prod-dev' });
  await rm(join(fixture.snapshotDir, 'cli', 'package-dist', 'index.mjs'), { force: true });
  await rm(join(fixture.stackDir, 'runtime', 'current', 'cli', 'package-dist', 'index.mjs'), { force: true });

  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  try {
    const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName });
    assert.equal(out.runtime.activeSnapshotId, 'snap-1');
    assert.equal(out.runtime.snapshotPath, fixture.snapshotDir);
    assert.equal(out.runtime.valid, false);
    assert.match(out.runtime.errors.join('\n'), /missing daemon node entrypoint/i);
  } finally {
    restore();
  }
});

test('stack info observes each registered identity through live control and exact loaded bundle metadata', async t => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'participant-info' });
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  const cliHomeDir = join(fixture.stackDir, 'cli-identities', 'account-b');
  const env = applyStackDaemonLifecycleScopeEnv({ env: {
    HAPPIER_STACK_STACK: fixture.stackName, HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir, HAPPIER_HOME_DIR: cliHomeDir,
  }, stackName: fixture.stackName, cliIdentity: 'account-b' });
  const child = spawnTestProcess(process.execPath, ['-e', 'if(process.send)process.send("ready");setInterval(()=>{},1000)'],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  });
  await once(child, 'message');
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const entrypoint = join(fixture.stackDir, 'old-bundle/apps/cli/src/index.mjs');
  await mkdir(dirname(entrypoint), { recursive: true });
  await writeFile(entrypoint, 'export {};');
  const sourceTime = '2026-11-03T12:59:00.000Z';
  await writeFile(join(fixture.stackDir, 'old-bundle/source-bundle.json'), JSON.stringify({
    identity: 'daemon-old', entrypoint, sourceCapture: { inputIdentity: 'a'.repeat(64), capturedAt: sourceTime },
  }));
  const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, env });
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify({ pid: child.pid, httpPort: server.address().port,
    startedAt: Date.now(), startedWithCliVersion: 'test', controlToken: randomUUID(), startedWithRuntimeEntrypoint: entrypoint }));
  await writeFile(join(fixture.stackDir, 'stack.runtime.json'), JSON.stringify({ version: 1, stackName: fixture.stackName,
    sourceRuntimeIdentities: { daemon: { selected: 'daemon-new', loaded: 'daemon-new' } },
    daemon: { desiredStateByIdentity: { 'account-b': 'running', retired: 'stopped' } },
  }));
  const readInfo = () => readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName,
    synchronizeDaemonState: false });
  const first = await readInfo();
  const participant = first.runtime.daemonParticipants.find(row => row.identity === 'account-b');
  assert.equal(participant.status, 'running');
  assert.equal(participant.loaded, 'daemon-old');
  assert.equal(participant.sourceTime, sourceTime);
  assert.equal(participant.reason, 'participant_source_stale');
  assert.equal(requests, 1, 'one control read per registered live identity per observation');
  assert.equal(first.runtime.daemonParticipants.find(row => row.identity === 'retired').reason, null);
  const currentEntrypoint = join(fixture.stackDir, 'current-bundle/apps/cli/src/index.mjs');
  await mkdir(dirname(currentEntrypoint), { recursive: true });
  await writeFile(currentEntrypoint, 'export {};');
  const record = { identity: 'daemon-new', entrypoint: currentEntrypoint,
    sourceCapture: { inputIdentity: 'b'.repeat(64), capturedAt: '2026-11-04T08:00:00.000Z' } };
  await writeFile(join(fixture.stackDir, 'current-bundle/source-bundle.json'), JSON.stringify(record));
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  await writeFile(statePath, JSON.stringify({ ...state, startedWithRuntimeEntrypoint: currentEntrypoint }));
  assert.equal((await readInfo()).runtime.daemonParticipants.find(row => row.identity === 'account-b').reason, null);
  assert.equal(requests, 2);
  await writeFile(join(fixture.stackDir, 'stack.runtime.json'), JSON.stringify({ version: 1, stackName: fixture.stackName,
    sourceRuntimeIdentities: { daemon: { selected: 'daemon-new', loaded: 'daemon-new' } },
    daemon: { desiredStateByIdentity: { 'account-b': 'stopped', retired: 'stopped' } },
  }));
  const refusedStop = (await readInfo()).runtime.daemonParticipants.find(row => row.identity === 'account-b');
  assert.equal(refusedStop.loaded, 'daemon-new', 'a requested stop does not hide a participant that is still running');
  assert.equal(refusedStop.reason, 'daemon_stop_incomplete');
  const runtimeState = JSON.parse(await readFile(join(fixture.stackDir, 'stack.runtime.json'), 'utf8'));
  runtimeState.daemon.desiredStateByIdentity['account-b'] = 'running';
  await writeFile(join(fixture.stackDir, 'stack.runtime.json'), JSON.stringify(runtimeState));
  await writeFile(statePath, JSON.stringify({ ...state, startedWithRuntimeEntrypoint: join(fixture.stackDir, 'unrecorded.mjs') }));
  const unknown = (await readInfo()).runtime.daemonParticipants.find(row => row.identity === 'account-b');
  assert.equal(unknown.loaded, null);
  assert.equal(unknown.reason, 'participant_source_unknown');
});

test('stack info reports a failed daemon transport despite a live native process observation', async t => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'source-tunnel-info' });
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.storageDir });
  await writeFile(join(fixture.stackDir, 'env'), 'HAPPIER_STACK_RUNTIME_MODE=source-snapshot\nHAPPIER_STACK_SERVE_UI=0\nHAPPIER_STACK_DAEMON=1\n');
  const state = { version: 1, stackName: fixture.stackName, sourceRuntimeIdentities: {},
    placement: { server: 'server', daemon: 'daemon' },
    remoteTargets: {
      server: { runtimeMode: 'source-snapshot', services: { server: true }, status: 'running' },
      daemon: { runtimeMode: 'source-snapshot', services: { daemon: true }, status: 'retrying',
        phase: 'tunnel', forwardPid: null, serviceStatus: { daemon: 'retrying' } },
    } };
  await writeFile(join(fixture.stackDir, 'stack.runtime.json'), JSON.stringify(state));
  await writeFile(join(fixture.stackDir, 'dev-targets.json'), JSON.stringify({ version: 3,
    targets: ['server', 'daemon'].map(name => ({ name, platform: 'posix', ssh: `${name}-ssh`,
      repoDir: process.cwd(), cliHomeDir: join(fixture.root, name, 'cli') })) }));
  const out = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName: fixture.stackName,
    synchronizeDaemonState: false, runRemoteProcessImpl: async ({ args }) => {
      const component = args.includes('server-ssh') ? 'server' : 'daemon';
      return { code: 0, out: JSON.stringify({ serviceStatus: { [component]: 'running' }, sourceRuntimeIdentities: {} }) };
    } });
  assert.equal(out.runtime.components.daemon.running, false);
  assert.equal(out.runtime.health.status, 'degraded');
  assert.ok(out.runtime.health.issues.includes('daemon_unknown'));
  assert.equal(out.runtime.remoteTargets.daemon.status, 'retrying');
});
