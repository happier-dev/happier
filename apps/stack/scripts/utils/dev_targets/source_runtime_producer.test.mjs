import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { startDevReloadCoordinator } from '../dev/devReloadCoordinator.mjs';
import { resolveRemoteCommandPolicy, renderNativeCommandPolicy } from './remote_commands.mjs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { captureDevTargetSyncFixture } from '../../testkit/core/dev_target_sync.mjs';
import { prepareSourceRuntimeProducerOnTarget, createSourceRuntimeProducerReload } from './source_runtime_producer.mjs';

test('an unavailable producer source mirror settles as a typed recoverable failure', async t => {
  const fixture = await createTempFixture(t, { prefix: 'source-producer-unavailable-' });
  await fs.writeFile(fixture.path('package.json'), JSON.stringify({ workspaces: [] }));
  await assert.rejects(prepareSourceRuntimeProducerOnTarget({
    target: { name: 'nl3', platform: 'posix', ssh: 'fixture-nl3', repoDir: '/srv/source', cliHomeDir: '/srv/state' },
    repoDir: fixture.root, producerStackBaseDir: fixture.path('repo-source-fixture'), producerStackName: 'repo-source-fixture',
    components: [{ component: 'daemon' }], env: { HAPPIER_STACK_STORAGE_DIR: fixture.root },
  }, { runCaptureResult: async () => ({ ok: false, exitCode: 1, err: 'source mirror is offline' }) }), error => {
    assert.equal(error.code, 'source_runtime_producer_unavailable');
    assert.equal(error.target, 'nl3');
    assert.match(error.nextAction, /synchronization/);
    return true;
  });
});

test('remote producer dispatch carries the controller authority and requested host provider', async t => {
  const fixture = await createTempFixture(t, { prefix: 'source-producer-dispatch-' });
  await fs.writeFile(fixture.path('package.json'), JSON.stringify({ workspaces: [] }));
  const components = [{ component: 'server', serverComponent: 'happier-server-light', dbProvider: 'sqlite' }, { component: 'daemon' }];
  const producerStackName = 'repo-source-fixture';
  const env = { PATH: process.env.PATH, HAPPIER_STACK_STORAGE_DIR: fixture.root };
  const requests = [];
  for (const target of [
    { name: 'nl3', platform: 'posix', ssh: 'fixture-posix', repoDir: '/srv/source-fixture', cliHomeDir: '/srv/fixture-state' },
    { name: 'windows', platform: 'windows', ssh: 'fixture-windows', repoDir: 'C:\\source-fixture', cliHomeDir: 'C:\\fixture-state' },
  ]) {
    const result = await prepareSourceRuntimeProducerOnTarget({ target, repoDir: fixture.root,
      producerStackBaseDir: fixture.path(producerStackName), producerStackName, components,
      sourceCapturedAfter: '2026-11-09T00:00:00.000Z', env, logger: { log() {}, error() {} } }, {
      runCaptureResult: ({ command, args }) => captureDevTargetSyncFixture(command, args),
      spawnProcess: input => { requests.push(input); return { completion: Promise.resolve({ code: 0, signal: null }) }; },
    });
    assert.equal(result.code, 0);
  }
  assert.equal(requests.length, 2, 'one producer request per actual execution host');
  for (const request of requests) {
    const remoteCommand = request.args.at(-1);
    const encoded = /-EncodedCommand\s+([A-Za-z0-9+/=]+)/i.exec(remoteCommand)?.[1];
    const script = encoded ? Buffer.from(encoded, 'base64').toString('utf16le') : remoteCommand;
    assert.match(script, /HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK/);
    assert.match(script, /repo-source-fixture/);
    assert.match(script, /sqlite/);
    assert.match(script, /2026-11-09T00:00:00\.000Z/);
    assert.doesNotMatch(script, /--heavyweight-admission/);
  }
});

test('rolling production reaches commands-only hosts while an unavailable peer cannot suppress another host', async t => {
  const fixture = await createTempFixture(t, { prefix: 'source-producer-targets-' });
  await fs.writeFile(fixture.path('package.json'), JSON.stringify({ workspaces: [] }));
  const services = { server: false, daemon: false, expo: false };
  const targets = ['windows', 'nl3', 'mac-disabled'].map(name => ({ name, platform: 'posix', ssh: name,
    repoDir: `/srv/${name}`, cliHomeDir: `/state/${name}` }));
  const requests = [], failures = [];
  const producer = await createSourceRuntimeProducerReload({ repoDir: fixture.root, stackBaseDir: fixture.path('repo-source-fixture'),
    stackName: 'repo-source-fixture', servicePlans: targets.map(target => ({ target, services,
      commands: target.name !== 'mac-disabled' })),
    localComponents: [],
    remoteComponents: [{ component: 'server', serverComponent: 'happier-server-light', dbProvider: 'sqlite' }, { component: 'daemon' }],
    env: { PATH: process.env.PATH, HAPPIER_STACK_STORAGE_DIR: fixture.root, HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'repo-source-fixture' },
    logger: { log() {}, error(message) { failures.push(message); } },
  }, {
    runCaptureResult: ({ command, args }) => captureDevTargetSyncFixture(command, args),
    spawnProcess: input => {
      requests.push(input);
      return { completion: Promise.resolve({ code: input.args.includes('windows') ? 255 : 0, signal: null }) };
    },
  });
  await producer.executor.build();
  assert.equal(requests.length, 2, 'eligible command hosts each receive one request; disabled mac receives none');
  assert.ok(requests.some(request => request.args.includes('nl3')), 'commands-only nl3 is prepared without a runtime service');
  assert.ok(requests.every(request => !request.args.includes('mac-disabled')));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /source_runtime_producer_unavailable/);
});

test('source producer transport leaves finite compiler admission at the producer', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/, '');
  const args = ['node', '--conditions=happier-source', '--import=./apps/stack/bin/localSourceRuntimeBootstrap.mjs',
    './apps/stack/scripts/utils/dev_targets/source_runtime_producer.mjs', '--worker', '{}'];
  const policy = resolveRemoteCommandPolicy(args, { cwd: root });
  assert.equal(policy.selfPublisher, '1', 'a rolling coordinator must not reserve capacity before its finite producer');
  assert.equal(policy.kind, 'source-test', 'the source preloaded worker consumes no emitted workspace closure');
  if (process.platform === 'win32') return;
  const fixture = await createTempFixture(t, { prefix: 'source-producer-policy-' });
  const artifact = fixture.path('policy.sh');
  await fs.writeFile(artifact, renderNativeCommandPolicy());
  const native = spawnSync('/bin/sh', ['-c', '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s,%s" "$policy_kind" "$policy_selfPublisher"',
    'policy', artifact, root, ...args], { encoding: 'utf8' });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stdout, 'source-test,1');
});

test('rolling source production coalesces edits while one compiler is running', async t => {
  const fixture = await createTempFixture(t, { prefix: 'source-runtime-producer-watch-' });
  const source = fixture.path('entry.ts');
  await fs.writeFile(source, 'export const value = 0;');
  let watchOptions;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let builds = 0;
  const failures = [];
  const coordinator = startDevReloadCoordinator({
    descriptors: [{ id: 'runtime-source', target: 'source-runtime', paths: [source] }],
    // The compiler is the system boundary. Source observation and scheduling stay real.
    executors: [{ target: 'source-runtime', async build() {
      builds += 1;
      entered();
      if (builds === 1) await held;
    } }],
    logger: { log() {}, warn() {}, error(message) { failures.push(message); } },
  }, { watchDebouncedImpl(options) { watchOptions = options; return { close() {} }; } });
  t.after(async () => { release(); await coordinator.close(); });
  const initial = coordinator.requestReload('source-runtime');
  await Promise.race([started, initial]);
  assert.equal(builds, 1, 'the dev owner starts production for the source-runtime target');
  for (let value = 1; value <= 24; value += 1) {
    await fs.writeFile(source, `export const value = ${value};`);
    watchOptions.onObservation({ eventType: 'change', watchPath: source, filename: 'entry.ts' });
  }
  release();
  await initial;
  assert.equal(builds, 2, 'one latest-source trailing pass replaces 24 queued source edits');
  assert.deepEqual(failures, []);
});
