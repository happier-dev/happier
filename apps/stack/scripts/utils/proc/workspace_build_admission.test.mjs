import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { observeWorkspaceBundleLockPriority, withWorkspaceBundleLock, WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE } from '../../../../../packages/cli-common/workspaceBundleLock.mjs';
import { resolveWorkspaceBuildAdmissionInvocation, runWorkspaceBuildAdmission, withWorkspaceBuildResources } from './workspace_build_admission.mjs';
import { resolveDependencyRefreshLockPath, withDependencyRefreshLock } from './dependency_refresh.mjs';
import * as dependencies from './dependency_refresh.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveCommandWorkspaceLocks, resolveHeavyweightMemoryFloorKiB, resolvePackageCommandPolicy, resolveRemoteCommandPolicy } from '../dev_targets/remote_commands.mjs';
import { spawnTestProcess } from '../../testkit/core/spawn_test_process.mjs';
import { buildNativeAdmissionFixtureEnv, holdNativeAdmissionFixtureMemory, installNativeAdmissionFixture, installWorkspaceAdmissionProcessFixture } from '../../testkit/core/native_admission_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { join } from 'node:path';
import { ensureWebUiDependencies } from '../../build/build_web_artifact.mjs';
import { once } from 'node:events';
import { DEFAULT_FILE_CHANGE_CATCH_UP_MS } from '../../../../../packages/cli-common/fileChangeObserver.mjs';
import { withPatchedProcessEnv } from '../../testkit/core/env_scope.mjs';

test('broker publication wait preserves its existing priority ahead of a newer standalone publisher', {
  skip: process.platform !== 'linux', timeout: 15_000,
}, async t => {
  // The fixture's standalone publisher is independent of the routed test's
  // admitted workspace leases; its temporary lock may use ordinary waiting.
  withPatchedProcessEnv(t, { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: undefined });
  const fixture = await createTempFixture(t, { prefix: 'hstack-publication-priority-retention-' });
  const native = await installWorkspaceAdmissionProcessFixture(t, fixture.root);
  const lockPath = fixture.path('publication.lock');
  const orderPath = fixture.path('order');
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(t.signal.reason);
  t.signal.addEventListener('abort', cancel, { once: true });
  let pending, newer;
  try {
    await withWorkspaceBundleLock(async () => {
      pending = runWorkspaceBuildAdmission({
        command: process.execPath, args: ['-e', 'require("node:fs").appendFileSync(process.argv[1],"older\\n")', orderPath],
        launcherPath: native.launcher, admissionClass: 'compilation',
        locks: [{ path: lockPath }], env: buildNativeAdmissionFixtureEnv(native.env),
        signal: cancellation.signal, stdio: ['ignore', 'pipe', 'pipe'],
      });
      await waitForBrokerState(native, status => status.waitingCount === 1, t.signal);
      assert.notEqual(observeWorkspaceBundleLockPriority(lockPath), '[]',
        'a broker wait must retain the canonical priority scope after its failed resource attempt');
      let waiting;
      const ready = new Promise(resolve => { waiting = resolve; });
      newer = withWorkspaceBundleLock(async () => {
        await writeFile(orderPath, 'newer\n', { flag: 'a' });
      }, { lockPath, signal: cancellation.signal, onWait: waiting });
      await ready;
    }, { lockPath, signal: cancellation.signal });
    assert.equal((await pending).status, 0);
    await newer;
    assert.equal(await readFile(orderPath, 'utf8'), 'older\nnewer\n');
    assert.equal(observeWorkspaceBundleLockPriority(lockPath), '[]');
    await assertBrokerIdle(native);
  } finally {
    cancellation.abort();
    await Promise.allSettled([pending, newer]);
    t.signal.removeEventListener('abort', cancel);
  }
});

test('broker admission reclaims a dead same-host holder without a filesystem release event', {
  skip: process.platform !== 'linux', timeout: 15_000,
}, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dead-publication-holder-' });
  const native = await installWorkspaceAdmissionProcessFixture(t, fixture.root);
  const lockPath = fixture.path('publication.lock');
  const source = `import {withWorkspaceBundleLock} from ${JSON.stringify(new URL('../../../../../packages/cli-common/workspaceBundleLock.mjs', import.meta.url).href)};
    await withWorkspaceBundleLock(async () => {
      process.stdin.once('data', () => process.exit(0));
      process.stdout.write('held');
      await new Promise(() => {});
    }, {lockPath: process.argv[1]});`;
  const owner = spawnTestProcess(process.execPath, ['--input-type=module', '-e', source, lockPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = once(owner, 'close');
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(t.signal.reason);
  t.signal.addEventListener('abort', cancel, { once: true });
  let pending;
  try {
    await once(owner.stdout, 'data', { signal: t.signal });
    pending = runWorkspaceBuildAdmission({
      command: process.execPath, args: ['-e', 'process.stdout.write("published")'],
      launcherPath: native.launcher, admissionClass: 'compilation',
      locks: [{ path: lockPath }], env: buildNativeAdmissionFixtureEnv(native.env),
      signal: cancellation.signal, stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForBrokerState(native, status => status.waitingCount === 1, t.signal);
    const blocked = await native.brokerStatus();
    await delay(2 * DEFAULT_FILE_CHANGE_CATCH_UP_MS, undefined, { signal: t.signal });
    assert.equal((await native.brokerStatus()).sampleCount, blocked.sampleCount,
      'live heartbeats and catch-up checks must not resample capacity or retry admission');
    owner.stdin.end('exit');
    assert.equal((await exited)[0], 0);
    const result = await pending;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'published');
    await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
    await assertBrokerIdle(native);
  } finally {
    cancellation.abort();
    if (owner.exitCode === null) owner.stdin.end('exit');
    await exited;
    await pending;
    t.signal.removeEventListener('abort', cancel);
  }
});

async function assertBrokerIdle(native) {
  const { activeCount, waitingCount } = await native.brokerStatus();
  assert.equal(activeCount, 0, 'completed work releases every host slot');
  assert.equal(waitingCount, 0, 'completed work leaves no queued request');
}

async function waitForBrokerState(native, matches, signal) {
  // Observe the public broker projection. Status reads do not sample host
  // resources; the test signal owns the wait's lifetime.
  for (;;) {
    signal.throwIfAborted();
    // Let the real command start its broker with the fixture OS environment.
    // A status call before that point would start it from the test runner.
    try { await lstat(native.resourceSamplesPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await delay(10, undefined, { signal });
      continue;
    }
    const status = await native.brokerStatus();
    if (matches(status)) return status;
    await delay(10, undefined, { signal });
  }
}

async function dependencyReadScopeFixture(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-read-scope-' });
  const env = { ...buildNativeAdmissionFixtureEnv(), HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_DEV_TARGET_EXECUTION: '', HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  delete env.HAPPIER_BUILD_DEPENDENCY_CUSTODY;
  await mkdir(fixture.path('node_modules'));
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true }));
  await writeFile(fixture.path('pnpm-lock.yaml'), '# installed A\n');
  return { fixture, env };
}

test('broker publication wait reports its resource and live holder before the payload starts', { skip: process.platform !== 'linux', timeout: 15000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-publication-wait-visibility-' });
  const native = await installWorkspaceAdmissionProcessFixture(t, fixture.root);
  const lockPath = fixture.path('publication.lock');
  const cancellation = new AbortController();
  let stderr = '';
  let stdout = '';
  let pending;
  try {
    await withWorkspaceBundleLock(async () => {
      pending = runWorkspaceBuildAdmission({
        command: process.execPath, args: ['-e', 'process.stdout.write("published")'],
        launcherPath: native.launcher, admissionClass: 'compilation',
        locks: [{ path: lockPath }], env: buildNativeAdmissionFixtureEnv(native.env),
        signal: cancellation.signal, stdio: ['ignore', 'pipe', 'pipe'],
        onStderr: value => { stderr += value; }, onStdout: value => { stdout += value; },
      });
      await waitForBrokerState(native, status => status.waitingCount === 1, t.signal);
      assert.ok(stderr.includes(lockPath), 'a queued publication must identify its blocking resource');
      assert.ok(stderr.includes(`pid=${process.pid}`), 'a queued publication must identify its live holder');
      assert.equal(stdout, '', 'publication waits must not start the payload');
      const status = await native.brokerStatus();
      assert.equal(status.activeCount, 0, 'resource waits retain no host capacity');
    }, { lockPath, signal: t.signal });
    const result = await pending;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'published', 'release must launch the payload once without a retry');
    await assertBrokerIdle(native);
  } finally {
    cancellation.abort();
    await pending;
  }
});

test('warm readiness callbacks perform zero dependency writer work', async t => {
  const { fixture, env } = await dependencyReadScopeFixture(t);
  await dependencies.withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
  const lockPath = dependencies.resolveDependencyRefreshLockPath(fixture.root, env);
  const link = fs.linkSync;
  let acquisitions = 0, callbacks = 0, installations = 0;
  fs.linkSync = (source, destination) => {
    if (destination === lockPath) acquisitions++;
    return link(source, destination);
  };
  syncBuiltinESMExports();
  try {
    const options = { installDir: fixture.root, env, onDependenciesReady: async () => { callbacks++; } };
    await dependencies.withDependencyRefresh(options, async () => { installations++; });
    await dependencies.adoptDependencyInstallation(options);
  } finally { fs.linkSync = link; syncBuiltinESMExports(); }
  assert.equal(callbacks, 2);
  assert.equal(installations, 0);
  assert.equal(acquisitions, 0, 'readiness inspection does not request mutation custody');
});

test('dependency readiness observes zero waits for a writer that has not begun mutation', async t => {
  const { fixture, env } = await dependencyReadScopeFixture(t);
  await dependencies.withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
  const start = Promise.withResolvers();
  const cancellation = new AbortController();
  let waits = 0;
  const read = (async () => {
    await start.promise;
    await dependencies.waitForDependencyRefresh({ installDir: fixture.root, signal: cancellation.signal,
      env: { ...env, HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0' } })
      .catch(error => { if (!cancellation.signal.aborted) throw error; });
  })();
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...args) {
    if (String(chunk).includes('dependency refresh lock')) {
      waits++; cancellation.abort(new Error('readiness waited for an unmutated gate'));
    }
    return write.call(this, chunk, ...args);
  };
  try {
    await dependencies.withDependencyRefreshLock({ installDir: fixture.root, env }, async () => {
      start.resolve(); await read;
    });
  } finally { process.stderr.write = write; }
  assert.equal(waits, 0);
});

test('warm refresh preserves cancellation before readiness and before successful completion', async t => {
  const { fixture, env } = await dependencyReadScopeFixture(t);
  await dependencies.withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
  let callbacks = 0;
  const cancelled = new AbortController();
  const reason = new Error('fixture readiness cancelled');
  cancelled.abort(reason);
  await assert.rejects(dependencies.withDependencyRefresh({ installDir: fixture.root, env,
    signal: cancelled.signal, onDependenciesReady: async () => { callbacks++; } }, async () => {}), error => error === reason);
  assert.equal(callbacks, 0);
  const during = new AbortController();
  await assert.rejects(dependencies.withDependencyRefresh({ installDir: fixture.root, env,
    signal: during.signal, onDependenciesReady: async () => { callbacks++; during.abort(reason); } }, async () => {}), error => error === reason);
  assert.equal(callbacks, 1);
});

test('dependency readiness waits for real marked mutation and reads only completed installed bytes', async t => {
  const { fixture, env } = await dependencyReadScopeFixture(t);
  await dependencies.withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
  const output = fixture.path('node_modules', 'installed-output');
  const start = Promise.withResolvers(), leave = Promise.withResolvers();
  let waits = 0, observations = 0;
  const reader = (async () => {
    await start.promise;
    await dependencies.waitForDependencyRefresh({ installDir: fixture.root,
      env: { ...env, HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0' } });
    observations++;
    assert.equal(await readFile(output, 'utf8'), 'complete');
  })();
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...args) {
    if (String(chunk).includes('dependency refresh lock')) { waits++; leave.resolve(); }
    return write.call(this, chunk, ...args);
  };
  try {
    await dependencies.withDependencyRefreshLock({ installDir: fixture.root, env }, async () => {
      await dependencies.markDependencyMutation({ installDir: fixture.root, env });
      await writeFile(output, 'partial');
      start.resolve(); await leave.promise;
      assert.equal(observations, 0);
      await writeFile(output, 'complete');
    });
    await reader;
  } finally { process.stderr.write = write; }
  assert.equal(waits, 1);
  assert.equal(observations, 1);
});

test('predecessor Yarn readiness waits for its unmarked installation writer', async t => {
  const { fixture, env } = await dependencyReadScopeFixture(t);
  // ../0.2 at 7a014178: dependency_refresh.mjs:210-263 takes this owner-file
  // gate for installation but publishes neither a mutation generation nor a
  // marker until installation finishes. Preserve that observed cold state.
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true, packageManager: 'yarn@1.22.22' }));
  const output = fixture.path('node_modules', 'installed-output');
  const start = Promise.withResolvers(), waiting = Promise.withResolvers();
  let waits = 0, observations = 0;
  const reader = (async () => {
    await start.promise;
    await dependencies.waitForDependencyRefresh({ installDir: fixture.root,
      env: { ...env, HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0' } });
    observations++;
    return await readFile(output, 'utf8');
  })();
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...args) {
    if (String(chunk).includes('dependency refresh lock')) { waits++; waiting.resolve('waiting'); }
    return write.call(this, chunk, ...args);
  };
  try {
    await dependencies.withDependencyRefreshLock({ installDir: fixture.root, env }, async () => {
      await writeFile(output, 'partial');
      start.resolve();
      assert.equal(await Promise.race([waiting.promise, reader.then(() => 'completed')]), 'waiting');
      assert.equal(observations, 0);
      await writeFile(output, 'complete');
    });
    assert.equal(await reader, 'complete');
  } finally { process.stderr.write = write; }
  assert.equal(waits, 1);
  assert.equal(observations, 1);
});

test('web export mutates under exclusion only for changed canonical postinstall inputs or outputs', { skip: process.platform === 'win32' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-web-read-scope-' });
  await installNativeAdmissionFixture({ root: fixture.root });
  const root = fixture.path('native-owner');
  const uiDir = join(root, 'apps', 'ui');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const name of ['ui', 'cli', 'server']) {
    await mkdir(join(root, 'apps', name), { recursive: true });
    await writeFile(join(root, 'apps', name, 'package.json'), '{}');
  }
  await writeFile(join(uiDir, 'package.json'), JSON.stringify({ private: true, name: '@happier-dev/app',
    happier: { installFreshnessInputs: ['tools/atmosphere'] },
    scripts: { 'postinstall:real': 'node postinstall.mjs' } }));
  await mkdir(join(uiDir, 'tools/atmosphere'), { recursive: true });
  await copyFile(new URL('../../../../ui/tools/resolveUiPostinstallTasks.mjs', import.meta.url),
    join(uiDir, 'tools/resolveUiPostinstallTasks.mjs'));
  const sourceInput = join(uiDir, 'tools/atmosphere/input.js');
  await writeFile(sourceInput, 'first input');
  const output = join(root, 'node_modules/react-native-enriched-markdown/lib/module/web/streamingReveal.js');
  const observed = join(root, 'postinstall-observation.json');
  const refreshOwner = new URL('./dependency_refresh.mjs', import.meta.url).href;
  await writeFile(join(root, 'postinstall.mjs'), `
    import { readFile, mkdir, writeFile } from 'node:fs/promises';
    import { dirname } from 'node:path';
    import { readDependencyPublicationState, withDependencyConsumption } from ${JSON.stringify(refreshOwner)};
    const prior = await readFile(${JSON.stringify(observed)}, 'utf8').then(JSON.parse).catch(() => ({ writes: 0 }));
    const state = await readDependencyPublicationState({ installDir: process.cwd(), env: process.env });
    let consumerEntries = 0;
    await withDependencyConsumption({ installDir: process.cwd(), wait: false,
      env: { ...process.env, HAPPIER_BUILD_DEPENDENCY_CUSTODY: '' } }, () => { consumerEntries++; })
      .catch(error => { if (error.code !== 'EJSONOWNERFILELOCKBUSY') throw error; });
    await mkdir(dirname(${JSON.stringify(output)}), { recursive: true });
    await writeFile(${JSON.stringify(output)}, 'complete output');
    await writeFile(${JSON.stringify(observed)}, JSON.stringify({ writes: prior.writes + 1,
      writerActive: state.writerActive, consumerEntries }));
  `);
  // Only the package-manager executable is replaced. The real web entry,
  // dependency owner, task selector, freshness digests and locks all execute.
  await writeFile(join(root, '.fixture-pnpm/bin/pnpm'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log(${JSON.stringify(/^pnpm@([^+]+)/u.exec(manifest.packageManager)[1])}); process.exit(0); }
if (!process.argv.includes('postinstall:real')) process.exit(97);
require('node:child_process').execFileSync(process.execPath, [${JSON.stringify(join(root, 'postinstall.mjs'))}], { stdio: 'inherit' });
`);
  const env = { ...buildNativeAdmissionFixtureEnv(), HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_DEV_TARGET_EXECUTION: '', HAPPIER_UI_VENDOR_WEB_ASSETS: '0',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0',
    PATH: `${join(root, '.fixture-pnpm/bin')}:${process.env.PATH}` };
  await dependencies.withDependencyRefresh({ installDir: root, env }, async () => {});
  await ensureWebUiDependencies({ uiDir, env });
  assert.deepEqual(JSON.parse(await readFile(observed, 'utf8')), { writes: 1, writerActive: true, consumerEntries: 0 });
  const publication = await dependencies.readDependencyPublicationState({ installDir: root, env });
  await ensureWebUiDependencies({ uiDir, env });
  assert.equal(JSON.parse(await readFile(observed, 'utf8')).writes, 1, 'unchanged web preparation performs no write');
  assert.deepEqual(await dependencies.readDependencyPublicationState({ installDir: root, env }), publication);
  await writeFile(sourceInput, 'changed full-postinstall source input');
  await ensureWebUiDependencies({ uiDir, env });
  assert.deepEqual(JSON.parse(await readFile(observed, 'utf8')), { writes: 2, writerActive: true, consumerEntries: 0 });
  await unlink(output);
  await ensureWebUiDependencies({ uiDir, env });
  assert.deepEqual(JSON.parse(await readFile(observed, 'utf8')), { writes: 3, writerActive: true, consumerEntries: 0 },
    'a matching input record cannot hide a missing required output');
});

for (const placement of ['controller', 'worker', 'admission-worker']) test(`a self-dispatching package command retains zero dependency readers during remote admission (${placement})`, { skip: process.platform !== 'linux', timeout: 60_000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dispatch-read-scope-' });
  const native = await installNativeAdmissionFixture({ root: fixture.root, prepareDependencies: true });
  const root = join(fixture.root, 'native-owner');
  writeFakeBin({ root, binDirName: 'node_modules/.bin', name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '73400320 73400320\\n' ;;
  */proc/pressure/memory*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  const manifestPath = join(root, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, scripts: {
    test: './apps/stack/bin/hstack-exec --script=test:local',
    'test:local': 'node --test fixture.test.mjs',
  } }));
  await writeFile(join(root, 'fixture.test.mjs'), 'import test from "node:test"; test("admitted payload", () => {});');
  const configPath = join(root, 'execution-config.json');
  await writeFile(configPath, JSON.stringify({ version: 3, targets: [], commandExecution: { mode: 'local' } }));
  const trace = join(root, 'package-scripts.jsonl');
  const env = { ...buildNativeAdmissionFixtureEnv(), HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_EXEC_CONFIG_PATH: configPath,
    PATH: `${join(root, '.fixture-pnpm/bin')}:${join(root, 'node_modules/.bin')}:${process.env.PATH}`,
    HAPPIER_DEV_TARGET_EXECUTION: placement === 'controller' ? '' : '1',
    HAPPIER_HSTACK_EXECUTION: placement === 'admission-worker' ? '1' : '',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '1' };
  await dependencies.withDependencyRefresh({ installDir: root, env: { ...env,
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' } }, async () => {});
  // Only the external package-manager executable is substituted. Its manifest
  // script executes the real public launcher, which queues at the real broker.
  await writeFile(join(root, '.fixture-pnpm/bin/pnpm'), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log(${JSON.stringify(/^pnpm@([^+]+)/u.exec(manifest.packageManager)[1])}); process.exit(0); }
const scripts = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts;
const name = process.argv.slice(2).find(arg => Object.hasOwn(scripts, arg));
if (!name) process.exit(97);
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(name) + '\\n');
process.execve('/bin/sh', ['/bin/sh', '-c', scripts[name]], process.env);
`);
  const nestedPolicy = await resolvePackageCommandPolicy(['pnpm', 'run', 'test:local'], { repoRoot: root, cwd: root, env });
  const pressure = await holdNativeAdmissionFixtureMemory(t, { ...native, env }, {
    totalKiB: 2 * resolveHeavyweightMemoryFloorKiB(nestedPolicy.heavyClass,
      { machine: placement === 'controller' ? 'local' : 'worker' }), availableKiB: 0,
  });
  const args = placement === 'admission-worker'
    ? ['--heavyweight-admission', '--class=validation',
      `--workspace-locks=${JSON.stringify([{ kind: 'dependency', installDir: root,
        path: dependencies.resolveDependencyRefreshLockPath(root, env) }])}`, '--', 'pnpm', 'run', 'test']
    : ['--local', '--', 'pnpm', 'run', 'test'];
  const started = Promise.withResolvers(), finish = Promise.withResolvers();
  let stderr = '';
  // Reproduce the actual outer executor's canonical resource selection. Its
  // payload starts a public launcher; that launcher's own admission is nested.
  const locks = resolveCommandWorkspaceLocks(resolveRemoteCommandPolicy(['node', '--test', 'fixture.test.mjs'],
    { repoRoot: root }), root, env);
  const outer = withWorkspaceBuildResources({ locks, env, signal: t.signal }, async outerEnv => {
    const child = spawnTestProcess(native.launcher, args, {
      cwd: root, env: outerEnv, stdio: ['ignore', 'ignore', 'pipe'], signal: t.signal,
    });
    const terminal = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    child.stderr.on('data', chunk => { stderr += chunk; });
    started.resolve({ terminal });
    await finish.promise;
    return await terminal;
  });
  let result;
  try {
    const { terminal } = await Promise.race([started.promise, outer]);
    await Promise.race([waitForBrokerState(native, status => status.waitingCount === 1, t.signal), terminal.then(result => {
        throw new Error(`Package command exited before admission wait: ${result.code}; ${stderr}`);
      })]);
    assert.deepEqual((await readFile(trace, 'utf8')).trim().split('\n').map(value => JSON.parse(value)), ['test'],
      'the outer package script has run and its nested finite payload is still queued');
    const readers = await fs.promises.readdir(`${dependencies.resolveDependencyRefreshLockPath(root, env)}.readers`)
      .catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    assert.equal(readers.length, 0, 'nested admission must not retain the outer executor dependency reader');
    let writerEntries = 0;
    await dependencies.withDependencyRefreshLock({ installDir: root, env, wait: false }, () => { writerEntries++; })
      .catch(error => { if (error.code !== 'EJSONOWNERFILELOCKBUSY') throw error; });
    assert.equal(writerEntries, 1, 'remote admission must retain zero writer-excluding readers on either host');
  } finally {
    await pressure.release();
    finish.resolve();
    result = await outer;
  }
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
});

test('unchanged input refresh performs zero writer work or waits behind a writer draining local readers', async t => {
  const { fixture, env } = await dependencyReadScopeFixture(t);
  await dependencies.withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
  const lockPath = dependencies.resolveDependencyRefreshLockPath(fixture.root, env);
  const consuming = Promise.withResolvers(), release = Promise.withResolvers(), acquired = Promise.withResolvers();
  const reader = dependencies.withDependencyConsumption({ installDir: fixture.root, env }, async () => {
    consuming.resolve(); await release.promise;
  });
  await consuming.promise;
  const link = fs.linkSync;
  fs.linkSync = (source, destination) => {
    const result = link(source, destination);
    if (destination === lockPath) acquired.resolve();
    return result;
  };
  syncBuiltinESMExports();
  const writer = dependencies.withDependencyRefreshLock({ installDir: fixture.root, env }, async () => {});
  await acquired.promise;
  let writerAcquisitions = 0, installs = 0, waits = 0;
  const cancellation = new AbortController();
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...args) {
    if (String(chunk).includes(lockPath) && String(chunk).includes('dependency refresh lock')) {
      waits++;
      cancellation.abort(new Error('unchanged refresh requested a dependency wait'));
    }
    return write.call(this, chunk, ...args);
  };
  fs.linkSync = (source, destination) => {
    if (destination === lockPath) writerAcquisitions++;
    return link(source, destination);
  };
  syncBuiltinESMExports();
  try {
    await dependencies.withDependencyRefresh({ installDir: fixture.root, signal: cancellation.signal,
      env: { ...env, HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0' } }, async () => { installs++; })
      .catch(error => { if (!cancellation.signal.aborted) throw error; });
  } finally {
    process.stderr.write = write;
    fs.linkSync = link; syncBuiltinESMExports();
    release.resolve(); await reader; await writer;
  }
  assert.equal(waits, 0, 'unchanged canonical inputs do not wait for an unmutated writer gate');
  assert.equal(writerAcquisitions, 0);
  assert.equal(installs, 0);
});

test('a changed input refresh waits for a live local consumer and installs exactly once after it leaves', async t => {
  const { fixture, env } = await dependencyReadScopeFixture(t);
  await dependencies.withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
  const lockPath = dependencies.resolveDependencyRefreshLockPath(fixture.root, env);
  const consuming = Promise.withResolvers(), release = Promise.withResolvers(), waiting = Promise.withResolvers(), start = Promise.withResolvers();
  let installs = 0;
  const writer = (async () => {
    await start.promise;
    await dependencies.withDependencyRefresh({ installDir: fixture.root,
      env: { ...env, HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0' } }, async () => { installs++; });
  })();
  const reader = dependencies.withDependencyConsumption({ installDir: fixture.root, env }, async () => {
    consuming.resolve(); await release.promise;
  });
  await consuming.promise;
  await writeFile(fixture.path('pnpm-lock.yaml'), '# changed input\n');
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...args) {
    if (String(chunk).includes(lockPath) && String(chunk).includes('dependency consumers lock')) waiting.resolve('waiting');
    return write.call(this, chunk, ...args);
  };
  try {
    start.resolve();
    assert.equal(await Promise.race([waiting.promise, writer.then(() => 'completed')]), 'waiting');
    assert.equal(installs, 0, 'a writer may not mutate beneath a live local consumer');
  } finally {
    process.stderr.write = write;
    release.resolve(); await reader; await writer;
  }
  assert.equal(installs, 1);
});
// Coordination 2026-10-30 20:16: explicit actual-import scopes retain readers;
// docs/testing.md permits loud, retryable late-load failures during refresh.
test('an idle payload retains zero dependency readers after its dependency read finishes', async t => {
  const { fixture, env } = await dependencyReadScopeFixture(t);
  const dependency = fixture.path('node_modules', 'initial-load.cjs');
  const lateDependency = fixture.path('node_modules', 'late-load.cjs');
  await writeFile(dependency, 'module.exports = "complete";');
  await writeFile(lateDependency, 'module.exports = "late";');
  const locks = resolveCommandWorkspaceLocks(resolveRemoteCommandPolicy(['node', '--test', 'load.test.mjs'],
    { repoRoot: fixture.root }), fixture.root, env);
  const loaded = Promise.withResolvers(), finish = Promise.withResolvers();
  const payload = withWorkspaceBuildResources({ locks, env, signal: t.signal }, async () => {
    const result = await dependencies.withDependencyConsumption({ installDir: fixture.root, env },
      async () => (await import(pathToFileURL(dependency).href)).default);
    loaded.resolve(result);
    await finish.promise;
    return await import(pathToFileURL(lateDependency).href);
  });
  const outcome = payload.then(result => ({ result }), error => ({ error }));
  assert.equal(await loaded.promise, 'complete');
  let writers = 0;
  try {
    const readers = await fs.promises.readdir(`${dependencies.resolveDependencyRefreshLockPath(fixture.root, env)}.readers`)
      .catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    await withDependencyRefreshLock({ installDir: fixture.root, env, wait: false }, async () => {
      writers++;
      await unlink(lateDependency);
    }).catch(error => { if (error.code !== 'EJSONOWNERFILELOCKBUSY') throw error; });
    assert.equal(readers.length, 0, 'the completed dependency import must not retain custody for an idle payload');
    assert.equal(writers, 1);
  } finally {
    finish.resolve();
    await outcome;
  }
  const { error } = await outcome;
  assert.equal(error?.code, 'ERR_MODULE_NOT_FOUND', 'late-load failures propagate to the requester');
  assert.match(error.message, /late-load\.cjs/);
});

test('a refresh cannot remove a dependency during an explicit actual-import scope', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-refresh-consumption-' });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  await mkdir(fixture.path('node_modules'));
  await writeFile(fixture.path('package.json'), '{"private":true}');
  const dependency = fixture.path('node_modules', 'late-load.cjs');
  await writeFile(dependency, 'module.exports = "old-complete";');
  const consuming = Promise.withResolvers(), resumeLoad = Promise.withResolvers();
  const reader = dependencies.withDependencyConsumption({ installDir: fixture.root, env, signal: t.signal }, async () => {
    consuming.resolve();
    await resumeLoad.promise;
    return (await import(pathToFileURL(dependency).href)).default;
  });
  await consuming.promise;
  try {
    // A missing lease exposes the half-install window at a real module load.
    await withDependencyRefreshLock({ installDir: fixture.root, env, wait: false }, async () => {
      await unlink(dependency);
    }).catch(error => {
      if (error.code !== 'EJSONOWNERFILELOCKBUSY') throw error;
    });
  } finally { resumeLoad.resolve(); }
  assert.equal(await reader, 'old-complete');
  await withDependencyRefreshLock({ installDir: fixture.root, env, wait: false }, async () => {
    await writeFile(dependency, 'module.exports = "new-complete";');
  });
  assert.equal(await readFile(dependency, 'utf8'), 'module.exports = "new-complete";');
});

test('independent consumers share the tree and nested consumption preserves explicit environment overrides', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-shared-consumption-' });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '0' };
  await writeFile(fixture.path('package.json'), '{"private":true}');
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const first = dependencies.withDependencyConsumption({ installDir: fixture.root, env, signal: t.signal }, async () => {
    entered.resolve(); await release.promise;
  });
  await entered.promise;
  try {
    await dependencies.withDependencyConsumption({ installDir: fixture.root, env, signal: t.signal }, async readerEnv => {
      await dependencies.withDependencyConsumption({ installDir: fixture.root,
        env: { ...readerEnv, HAPPIER_TEST_CONSUMER_VALUE: 'inner' } }, nestedEnv => {
        assert.equal(nestedEnv.HAPPIER_TEST_CONSUMER_VALUE, 'inner');
      });
    });
    await assert.rejects(withDependencyRefreshLock({ installDir: fixture.root, env, wait: false },
      () => assert.fail('refresh entered while an independent reader was live')), { code: 'EJSONOWNERFILELOCKBUSY' });
  } finally { release.resolve(); await first; }
  await withDependencyRefreshLock({ installDir: fixture.root, env, wait: false }, () => {});
});

test('an installer can load and repair prerequisites in a child without waiting on its own reader exclusion', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-writer-child-consumption-' });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  await mkdir(fixture.path('node_modules'));
  await writeFile(fixture.path('package.json'), '{"private":true}');
  const modulePath = fixture.path('node_modules', 'prerequisite.cjs');
  const childSource = `
    import assert from 'node:assert/strict';
    import { writeFile } from 'node:fs/promises';
    import { withDependencyConsumption, withDependencyRefreshLock } from ${JSON.stringify(new URL('./dependency_refresh.mjs', import.meta.url).href)};
    await withDependencyConsumption({ installDir: ${JSON.stringify(fixture.root)} }, async () => {
      assert.equal((await import(${JSON.stringify(pathToFileURL(modulePath).href)})).default, 'complete');
    });
    await withDependencyRefreshLock({ installDir: ${JSON.stringify(fixture.root)} }, async () => {
      await writeFile(${JSON.stringify(fixture.path('child-prepared'))}, 'ready');
    });
  `;
  await dependencies.withDependencyRefresh({ installDir: fixture.root, env, force: true }, async ({ env: writerEnv }) => {
    await writeFile(modulePath, 'module.exports = "complete";');
    await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', childSource],
      { env: writerEnv, signal: t.signal });
  });
  assert.equal(await readFile(fixture.path('child-prepared'), 'utf8'), 'ready');
  assert.equal((await dependencies.inspectDependencyRefresh({ installDir: fixture.root, env })).required, false);
});

// Coordination 2026-10-30 20:16 and docs/testing.md: finite execution keeps
// publication custody, while completed imports do not exclude refresh.
for (const mode of ['standalone', 'broker']) test(`finite payloads retain publication custody and permit dependency refresh after imports (${mode})`, {
  skip: mode === 'broker' && process.platform !== 'linux',
}, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-legacy-admission-' });
  const native = mode === 'broker' ? await installWorkspaceAdmissionProcessFixture(t, fixture.root) : null;
  const lockPath = fixture.path('publisher.lock');
  const leaseOwner = new URL('../../../../../packages/cli-common/workspaceBundleLock.mjs', import.meta.url).href;
  const dependencyOwner = new URL('./dependency_refresh.mjs', import.meta.url).href;
  const env = { ...buildNativeAdmissionFixtureEnv(native?.env), HAPPIER_STACK_HOME_DIR: fixture.root,
    CI: '1', HAPPIER_DEV_TARGET_EXECUTION: '', HAPPIER_HSTACK_LOCAL_ADMISSION_REQUIRED: '' };
  const result = await runWorkspaceBuildAdmission({
    command: process.execPath,
    args: ['--input-type=module', '-e', `import {callerHoldsWorkspaceBundleLock} from ${JSON.stringify(leaseOwner)};
      if(!callerHoldsWorkspaceBundleLock(${JSON.stringify(lockPath)},process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD)) process.exit(81);
      const assert=(await import('node:assert/strict')).default;
      const {withDependencyRefreshLock}=await import(${JSON.stringify(dependencyOwner)});
      let writers=0;
      await withDependencyRefreshLock({installDir:${JSON.stringify(fixture.root)},
        env:{...process.env,HAPPIER_BUILD_DEPENDENCY_CUSTODY:''},wait:false},async()=>{writers++;});
      assert.equal(writers,1);
      process.stdout.write('published');`],
    locks: [{ kind: 'workspace', path: lockPath }],
    env,
    ...(native ? { launcherPath: native.launcher } : {}),
    admissionRequired: mode === 'broker', signal: t.signal, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'published');
  await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
  await withDependencyRefreshLock({ installDir: fixture.root, env, wait: false }, () => {});
  if (native) await assertBrokerIdle(native);
});

test('a local package producer reuses covered compiler admission without another host slot', { skip: process.platform !== 'linux', timeout: 15000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-local-compiler-admission-' });
  const native = await installNativeAdmissionFixture({ root: fixture.root });
  const { launcher, admissionRoot } = native;
  const compilerOwner = new URL('../../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs', import.meta.url).href;
  const payload = `import {spawn} from 'node:child_process';
    import {resolveTypeScriptCliInvocation} from ${JSON.stringify(compilerOwner)};
    const {requestAdmissionSample}=await import(${JSON.stringify(pathToFileURL(native.admissionClientPath).href)});
    const before=await requestAdmissionSample(${JSON.stringify(admissionRoot)});
    if(before.activeCount!==1 || before.waitingCount!==0) process.exit(81);
      const invocation=resolveTypeScriptCliInvocation({repoRoot:process.cwd(),workspaceDir:process.cwd(),env:process.env,invocationKind:'build',admissionClass:'package-dist'});
      // Replace only the external compiler payload; policy, native admission,
      // process ancestry and publication custody execute unchanged.
      const args=invocation.argsPrefix.slice(0,invocation.argsPrefix.indexOf(invocation.compilerPath));
      args.push('-e','process.stdout.write("compiler-entered")');
      const child=spawn(${JSON.stringify(launcher)},args,{env:process.env,stdio:'inherit'});
      process.exitCode=await new Promise(resolve=>child.once('close',resolve));
    const after=await requestAdmissionSample(${JSON.stringify(admissionRoot)});
    if(after.sampleCount!==before.sampleCount || after.activeCount!==1) process.exit(82);`;
  const result = await runWorkspaceBuildAdmission({ command: '/bin/sh',
    args: [launcher, '--local', '--allow-local-compilation', '--', process.execPath, '--input-type=module', '-e', payload], launcherPath: launcher,
    locks: [{ path: fixture.path('publisher.lock') }], admissionClass: 'package-dist',
    env: { ...buildNativeAdmissionFixtureEnv(), CI: '', HAPPIER_DEV_TARGET_EXECUTION: '', HAPPIER_HSTACK_EXECUTION: '1' },
    signal: t.signal, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'compiler-entered');
  await assertBrokerIdle(native);
});

test('batch resource closure covers transitive publishers and detects graph changes', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-batch-resource-closure-' });
  for (const app of ['ui', 'cli', 'server']) {
    await mkdir(fixture.path('apps', app), { recursive: true });
    await writeFile(fixture.path('apps', app, 'package.json'), JSON.stringify({ name: `@happier-dev/fixture-${app}`,
      ...(app === 'cli' ? { dependencies: { '@happier-dev/alpha': 'workspace:*' } } : {}) }));
  }
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true }));
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  for (const name of ['alpha', 'beta', 'unrelated']) {
    await mkdir(fixture.path('packages', name), { recursive: true });
    await writeFile(fixture.path('packages', name, 'package.json'), JSON.stringify({ name: `@happier-dev/${name}`,
      ...(name === 'alpha' ? { main: './dist/index.js', scripts: { build: 'node scripts/build.mjs' },
        dependencies: { '@happier-dev/beta': 'workspace:*', '@happier-dev/fixture-cli': 'workspace:*' } } : {}) }));
  }
  const { collectWorkspaceBuildBatchResources, ensureWorkspacePackagesBuiltByName } = await import('../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs');
  const selected = [fixture.path('apps', 'cli'), fixture.path('apps', 'ui'), fixture.path('packages', 'beta')];
  const before = await collectWorkspaceBuildBatchResources(selected, { admissionClass: 'package-dist' });
  assert.deepEqual(before.packageNames, ['@happier-dev/alpha', '@happier-dev/beta']);
  assert.deepEqual(before.locks.filter(lock => lock.kind === 'dependency'), []);
  assert.equal(before.locks.length, 3, 'bundle publisher and two package publishers');
  assert.equal(before.admissionClass, 'compilation', 'choose the producer requirement before acquiring the lower reader envelope');
  assert.deepEqual(await collectWorkspaceBuildBatchResources([...selected].reverse(), { admissionClass: 'package-dist' }), before);
  assert.equal((await collectWorkspaceBuildBatchResources(selected, { admissionClass: 'compilation-ui' })).admissionClass,
    'compilation-ui', 'a reader envelope that already covers producers is retained');
  assert.deepEqual(before.consumerOnlyPackageNames, ['@happier-dev/fixture-cli', '@happier-dev/fixture-ui']);
  let compilerCalls = 0;
  await withWorkspaceBuildResources({ locks: before.locks, env: buildNativeAdmissionFixtureEnv(), signal: t.signal }, async env => {
    const result = await ensureWorkspacePackagesBuiltByName(fixture.root, before.packageNames, {
      env, buildMode: 'strict', inheritedAdmission: true, visitedNames: before.consumerOnlyPackageNames,
      signal: t.signal, workspaceBuildBoundary: {
        prepareEnv: async (_dir, value) => value,
        // The compiler process is the system boundary; graph traversal,
        // fingerprinting, mounted publication and custody remain real.
        runPackageBuild: async (_dir, { env }) => {
          compilerCalls++;
          await mkdir(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, { recursive: true });
          await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const ready = true;\n');
        },
      },
    });
    assert.deepEqual(result.built, ['@happier-dev/alpha']);
  });
  assert.equal(compilerCalls, 1, 'consumer self-cycle is skipped without requesting its absent publication lease');
  await writeFile(fixture.path('packages', 'beta', 'package.json'), JSON.stringify({ name: '@happier-dev/beta',
    dependencies: { '@happier-dev/unrelated': 'workspace:*' } }));
  const after = await collectWorkspaceBuildBatchResources(selected);
  assert.notEqual(after.identity, before.identity);
  assert.deepEqual(after.packageNames, ['@happier-dev/alpha', '@happier-dev/beta', '@happier-dev/unrelated']);
  assert.equal(after.locks.length, before.locks.length + 1);
});

for (const failure of ['none', 'lease', 'producer', 'identity', 'capacity']) test(`composed batch inherits its sole reservation and exact publication custody (${failure})`, { skip: process.platform !== 'linux', timeout: 15000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-composed-build-' });
  const native = await installWorkspaceAdmissionProcessFixture(t, fixture.root);
  const { launcher, admissionRoot } = native;
  const lockPath = fixture.path('producer.lock');
  const ownerUrl = new URL('./workspace_build_admission.mjs', import.meta.url).href;
  const leaf = `import {requestAdmissionSample} from ${JSON.stringify(pathToFileURL(native.admissionClientPath).href)};
    const status=await requestAdmissionSample(${JSON.stringify(admissionRoot)});
    if(status.activeCount!==1 || status.waitingCount!==0) process.exit(81);
    if(Number(process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_FLOOR_KIB)!==status.reservedMemoryKiB) process.exit(82);
    process.stdout.write('producer-entered');process.exit(${failure === 'producer' ? 23 : 0});`;
  const payload = `import {runWorkspaceBuildAdmission} from ${JSON.stringify(ownerUrl)};
    const env={...process.env};
    ${failure === 'lease' ? "delete env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;delete env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES;" : ''}
    ${failure === 'identity' ? "delete env.HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT;" : ''}
    const result=await runWorkspaceBuildAdmission({command:process.execPath,args:['--input-type=module','-e',${JSON.stringify(leaf)}],
      launcherPath:${JSON.stringify(launcher)},locks:[{path:${JSON.stringify(failure === 'lease' ? fixture.path('unreserved.lock') : lockPath)}}],
      env,inheritedAdmission:true,admissionClass:${JSON.stringify(failure === 'capacity' ? 'compilation-ui' : 'package-dist')},stdio:['ignore','pipe','pipe']});
    process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');process.exit(result.status??1);`;
  const result = await runWorkspaceBuildAdmission({ command: process.execPath, args: ['--input-type=module', '-e', payload],
    launcherPath: launcher, admissionClass: 'compilation-cli', locks: [{ path: lockPath }],
    env: buildNativeAdmissionFixtureEnv(native.env), signal: t.signal, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(result.status, failure === 'none' ? 0 : failure === 'producer' ? 23 : 1, result.stderr);
  assert.equal(result.stdout, ['lease', 'identity', 'capacity'].includes(failure) ? '' : 'producer-entered');
  await assertBrokerIdle(native);
  await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
});

test('cancelling an inherited producer releases the containing reservation and every lease', { skip: process.platform !== 'linux', timeout: 15000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-cancel-composed-build-' });
  const native = await installWorkspaceAdmissionProcessFixture(t, fixture.root);
  const { launcher, admissionRoot } = native;
  const lockPath = fixture.path('producer.lock');
  const payload = `import {runWorkspaceBuildAdmission} from ${JSON.stringify(new URL('./workspace_build_admission.mjs', import.meta.url).href)};
    const result=await runWorkspaceBuildAdmission({command:process.execPath,args:['-e','process.stdout.write("producer-started");setInterval(()=>{},1000)'],
      launcherPath:${JSON.stringify(launcher)},locks:[{path:${JSON.stringify(lockPath)}}],
      inheritedAdmission:true,env:process.env,stdio:'inherit'});process.exit(result.status??1);`;
  const cancellation = new AbortController();
  const result = await runWorkspaceBuildAdmission({ command: process.execPath, args: ['--input-type=module', '-e', payload],
    launcherPath: launcher, admissionClass: 'compilation-cli', locks: [{ path: lockPath }],
    env: buildNativeAdmissionFixtureEnv(native.env), signal: cancellation.signal, stdio: ['ignore', 'pipe', 'pipe'],
    onStdout: value => { if (String(value).includes('producer-started')) cancellation.abort(); } });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /producer-started/);
  await assertBrokerIdle(native);
  await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
});

// D1 gives a child its parent's fixed slot. Declare the composed compiler
// floor before admission rather than upgrading a live validation reservation.
for (const journey of ['plugin dev install', 'combined typecheck', 'nested compiler', 'failed nested publisher']) test(`${journey} waits for a nested publisher without retaining another workspace lease`, {
  skip: process.platform !== 'linux', timeout: 15000,
}, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-nested-publisher-order-' });
  const native = await installWorkspaceAdmissionProcessFixture(t, fixture.root);
  const foreign = fixture.path('foreign.lock');
  const first = fixture.path('first.lock');
  const ownerUrl = new URL('./workspace_build_admission.mjs', import.meta.url).href;
  const leaf = 'process.stdout.write("published\\n")' + (journey === 'failed nested publisher' ? ';process.exitCode=1' : '');
  const phases = journey === 'combined typecheck'
    ? [[{ path: first }], [{ path: foreign }]] : [[{ path: first }, { path: foreign }]];
  const payload = `import {runWorkspaceBuildAdmission} from ${JSON.stringify(ownerUrl)};
    for(const locks of ${JSON.stringify(phases)}) {
      const result=await runWorkspaceBuildAdmission({command:process.execPath,args:['-e',${JSON.stringify(leaf)}],
        locks,admissionClass:${JSON.stringify(journey === 'nested compiler' ? 'compilation' : 'package-dist')},env:process.env});
      if(result.error || result.signal || result.status!==0) process.exit(result.status ?? 1);
    }`;
  const cancellation = new AbortController();
  let blocked;
  const contention = new Promise(resolve => { blocked = resolve; });
  let parent;
  try {
    await withWorkspaceBundleLock(async () => {
      parent = runWorkspaceBuildAdmission({ command: process.execPath, args: ['--input-type=module', '-e', payload],
        launcherPath: native.launcher, admissionClass: 'compilation', env: native.env,
        signal: cancellation.signal, stdio: ['ignore', 'pipe', 'pipe'],
        onStderr: value => { if (/Workspace publication lease is busy:|workspace-lease-busy/u.test(String(value))) blocked(); } });
      await Promise.race([contention, parent.then(result => assert.fail(`parent exited before contention: ${result.status}: ${result.stderr}`))]);
      // On the old guard, the busy diagnostic precedes the terminal refusal.
      // A live reservation alone is insufficient: the parent must stay pending
      // until the holder releases, and must then finish without a relaunch.
      const status = await native.brokerStatus();
      assert.equal(status.activeCount, 1);
      assert.equal(status.reservedMemoryKiB, resolveHeavyweightMemoryFloorKiB('compilation'),
        'a busy publication lease must not enlarge the declared composed reservation');
      assert.equal(status.waitingCount, 0, 'nested publication reuses its parent reservation');
      await assert.rejects(lstat(first), { code: 'ENOENT' }, 'a resource wait must release every partial publication scope');
    }, { lockPath: foreign, signal: t.signal });
    const result = await parent;
    assert.equal(result.status, journey === 'failed nested publisher' ? 1 : 0, result.stderr);
    assert.doesNotMatch(result.stderr, /HSTACK_WORKSPACE_ADMISSION_ORDER/u, 'a transient resource wait is not a terminal refusal');
    assert.equal(result.stdout, journey === 'combined typecheck' ? 'published\npublished\n' : 'published\n');
    await assertBrokerIdle(native);
    await assert.rejects(lstat(first), { code: 'ENOENT' });
    await assert.rejects(lstat(foreign), { code: 'ENOENT' });
  } finally {
    cancellation.abort();
    await parent;
  }
});

test('a nested publisher retaining another workspace lease still refuses foreign contention', {
  skip: process.platform !== 'linux', timeout: 15000,
}, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-nested-held-writer-' });
  const native = await installWorkspaceAdmissionProcessFixture(t, fixture.root);
  const owned = fixture.path('owned.lock');
  const foreign = fixture.path('foreign.lock');
  const ownerUrl = new URL('./workspace_build_admission.mjs', import.meta.url).href;
  const payload = `import {runWorkspaceBuildAdmission} from ${JSON.stringify(ownerUrl)};
    const result=await runWorkspaceBuildAdmission({command:process.execPath,args:['-e','process.stdout.write("unsafe")'],
      locks:[{path:${JSON.stringify(foreign)}}],env:process.env});
    process.exit(result.status ?? 1);`;
  await withWorkspaceBundleLock(async () => {
    const result = await runWorkspaceBuildAdmission({ command: process.execPath, args: ['--input-type=module', '-e', payload],
      launcherPath: native.launcher, admissionClass: 'compilation', locks: [{ path: owned }],
      env: native.env, signal: t.signal, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /HSTACK_WORKSPACE_ADMISSION_ORDER/);
    assert.equal(result.stdout, '');
    await assert.rejects(lstat(owned), { code: 'ENOENT' });
    await assertBrokerIdle(native);
  }, { lockPath: foreign, signal: t.signal });
});

test('cancelling a nested publication wait releases its sole reservation', {
  skip: process.platform !== 'linux', timeout: 15000,
}, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-cancel-nested-wait-' });
  const native = await installWorkspaceAdmissionProcessFixture(t, fixture.root);
  const foreign = fixture.path('foreign.lock');
  const payload = `import {runWorkspaceBuildAdmission} from ${JSON.stringify(new URL('./workspace_build_admission.mjs', import.meta.url).href)};
    const result=await runWorkspaceBuildAdmission({command:process.execPath,args:['-e','process.stdout.write("unsafe")'],
      locks:[{path:${JSON.stringify(foreign)}}],env:process.env});
    process.exit(result.status ?? 1);`;
  const cancellation = new AbortController();
  await withWorkspaceBundleLock(async () => {
    const result = await runWorkspaceBuildAdmission({ command: process.execPath, args: ['--input-type=module', '-e', payload],
      launcherPath: native.launcher, admissionClass: 'compilation', env: native.env,
      signal: cancellation.signal, stdio: ['ignore', 'pipe', 'pipe'],
      onStderr: value => { if (/Workspace publication lease is busy:|workspace-lease-busy/u.test(String(value))) cancellation.abort(); } });
    assert.equal(cancellation.signal.aborted, true, result.stderr);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    await assertBrokerIdle(native);
  }, { lockPath: foreign, signal: t.signal });
});

test('required inherited admission rejects absent custody instead of creating a reservation', { skip: process.platform !== 'linux', timeout: 10000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-required-inheritance-' });
  const native = await installNativeAdmissionFixture({ root: fixture.root });
  const { launcher, admissionRoot } = native;
  const result = await runWorkspaceBuildAdmission({ command: process.execPath, args: ['-e', 'process.stdout.write("unexpected")'],
    launcherPath: launcher, inheritedAdmission: true, env: buildNativeAdmissionFixtureEnv(), signal: t.signal,
    stdio: ['ignore', 'pipe', 'pipe'] });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  await assertBrokerIdle(native);
});

test('resource-blocked batch holds no capacity while the external publisher enters admission', { skip: process.platform !== 'linux', timeout: 15000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-batch-external-contention-' });
  const native = await installWorkspaceAdmissionProcessFixture(t, fixture.root);
  const { launcher, admissionRoot } = native;
  const lockPath = fixture.path('producer.lock');
  const cancellation = new AbortController();
  let batch;
  try {
    await withWorkspaceBundleLock(async () => {
      batch = runWorkspaceBuildAdmission({ command: process.execPath, args: ['-e', 'process.stdout.write("batch-entered")'],
        launcherPath: launcher, admissionClass: 'compilation-cli', locks: [{ path: lockPath, errorLabel: 'batch-producer' }],
        env: buildNativeAdmissionFixtureEnv(native.env), signal: cancellation.signal, stdio: ['ignore', 'pipe', 'pipe'] });
      await Promise.race([waitForBrokerState(native, status => status.waitingCount === 1 && status.activeCount === 0, t.signal),
        batch.then(result => assert.fail(`batch exited before contention: ${result.status}: ${result.stderr}`))]);
      assert.equal((await native.brokerStatus()).activeCount, 0, 'blocked head must not reserve capacity');
      assert.equal((await native.brokerStatus()).waitingCount, 1);
      const external = await runWorkspaceBuildAdmission({ command: process.execPath, args: ['-e', 'process.stdout.write("external-entered")'],
        launcherPath: launcher, env: buildNativeAdmissionFixtureEnv(native.env), signal: t.signal, stdio: ['ignore', 'pipe', 'pipe'] });
      assert.equal(external.status, 0, external.stderr);
      assert.equal(external.stdout, 'external-entered');
    }, { lockPath, signal: t.signal });
    const result = await batch;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'batch-entered');
    await assertBrokerIdle(native);
  } finally {
    cancellation.abort();
    await batch;
  }
});

test('build:packages waits for a foreign transitive producer before capacity admission', { skip: process.platform !== 'linux', timeout: 15000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-build-packages-contention-' });
  const native = await installNativeAdmissionFixture({ root: fixture.root });
  const { launcher, admissionRoot } = native;
  const { resolvePackageCommandPolicy } = await import('../dev_targets/remote_commands.mjs');
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const policy = await resolvePackageCommandPolicy(['pnpm', 'run', 'build:packages', '@happier-dev/protocol', '@happier-dev/transfers'], { repoRoot: root, cwd: root });
  const lockPath = fixture.path('transitive-producer.lock');
  const ownerUrl = new URL('./workspace_build_admission.mjs', import.meta.url).href;
  const payload = `import {runWorkspaceBuildAdmission} from ${JSON.stringify(ownerUrl)};
    const result=await runWorkspaceBuildAdmission({command:process.execPath,args:['-e','process.stdout.write("published")'],
      launcherPath:${JSON.stringify(launcher)},locks:[{path:${JSON.stringify(lockPath)}}],
      env:process.env,stdio:['ignore','pipe','pipe'],onStderr:value=>process.stderr.write(value)});
    process.stdout.write(result.stdout??'');process.exitCode=result.status??1;`;
  const env = buildNativeAdmissionFixtureEnv();
  const cancellation = new AbortController();
  let terminal;
  try {
    await withWorkspaceBundleLock(async () => {
      if (policy.selfPublisher === '1') {
        const child = spawnTestProcess(process.execPath, ['--input-type=module', '-e', payload], { env, signal: cancellation.signal, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', value => { stdout += value; });
        child.stderr.on('data', value => { stderr += value; });
        terminal = new Promise(resolve => child.once('close', status => resolve({ status, stdout, stderr })));
      } else {
        terminal = runWorkspaceBuildAdmission({ command: process.execPath, args: ['--input-type=module', '-e', payload],
          launcherPath: launcher, admissionClass: policy.heavyClass, env, signal: cancellation.signal,
          stdio: ['ignore', 'pipe', 'pipe'] });
      }
      await Promise.race([waitForBrokerState(native, status => status.waitingCount === 1 && status.activeCount === 0, t.signal),
        terminal.then(result => assert.fail(`producer terminated instead of waiting before admission: ${result.stderr}`))]);
      assert.equal((await native.brokerStatus()).activeCount, 0, 'foreign publication wait must hold no capacity');
    }, { lockPath, signal: t.signal });
    const result = await terminal;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'published');
    await assertBrokerIdle(native);
  } finally {
    cancellation.abort();
    await terminal;
  }
});

// Real source-policy processes precede each payload. Their cumulative startup
// is not a publication deadline; retain the containing runner's cancellation.
for (const { entry, separator, producerExit, globbing } of [
  { entry: 'local', separator: '&&', producerExit: 0 },
  { entry: 'explicit', separator: '&&', producerExit: 0 },
  { entry: 'explicit', separator: '&&', producerExit: 23 },
  { entry: 'explicit', separator: ';', producerExit: 23 },
  { entry: 'explicit', separator: '&&', producerExit: 0, globbing: true },
]) test(`${entry} compound build:packages waits before admission then admits the exact raw Vitest payload (${separator}, producer ${producerExit}${globbing ? ', shell glob' : ''})`, { skip: process.platform !== 'linux' }, async t => {
  let stdout = '', stderr = '';
  const fixture = await createTempFixture(t, { prefix: 'happier-compound-admission-' });
  const native = await installWorkspaceAdmissionProcessFixture(t, fixture.root);
  const { launcher, admissionRoot } = native;
  const repoRoot = fixture.path('native-owner');
  const manifestPath = join(repoRoot, 'package.json');
  writeFakeBin({ root: fixture.root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, scripts: {
    'build:packages': 'node scripts/workspaces/ensureWorkspacePackagesBuiltCli.mjs',
  } }));
  await mkdir(join(repoRoot, 'apps/cli'), { recursive: true });
  await writeFile(join(repoRoot, 'apps/cli/package.json'), JSON.stringify({ name: '@fixture/cli', happierSourceTestTools: [] }));
  const lockPath = fixture.path('agents.lock');
  if (globbing) {
    await writeFile(join(repoRoot, 'fixture-one.manifest'), 'one');
    await writeFile(join(repoRoot, 'fixture-two.manifest'), 'two');
  }
  const ownerUrl = new URL('./workspace_build_admission.mjs', import.meta.url).href;
  writeFakeBin({ root: fixture.root, name: 'pnpm', content: `#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]==='run' && args[1]==='build:packages') {
  const {runWorkspaceBuildAdmission}=await import(${JSON.stringify(ownerUrl)});
  const result=await runWorkspaceBuildAdmission({command:process.execPath,args:['-e','process.stdout.write("published")'],
    launcherPath:${JSON.stringify(launcher)},locks:[{path:${JSON.stringify(lockPath)}}],env:process.env,stdio:'inherit'});
  process.exitCode=result.status===0 ? Number(process.env.FIXTURE_PRODUCER_EXIT) : result.status??1;
} else {
  const {existsSync}=await import('node:fs');
  const {requestAdmissionSample}=await import(${JSON.stringify(pathToFileURL(native.admissionClientPath).href)});
  if(args.at(-1)!=='inspects the Codex authored manifest within the worker heap budget') process.exit(81);
  if(process.env.FIXTURE_EXPECT_GLOB==='1' && (!args.includes('fixture-one.manifest') || !args.includes('fixture-two.manifest') || args.includes('fixture-*.manifest'))) process.exit(84);
  if((await requestAdmissionSample(${JSON.stringify(admissionRoot)})).activeCount!==1) process.exit(82);
  if(existsSync(${JSON.stringify(lockPath)})) process.exit(83);
  process.stdout.write('checked');
}
` });
  const command = 'pnpm run build:packages @happier-dev/protocol @happier-dev/plugin-sdk && pnpm --dir apps/cli exec vitest run --config vitest.config.ts scripts/build-owned/bundledPlugins/typescriptModuleInspection.test.ts -t "inspects the Codex authored manifest within the worker heap budget"';
  const sequence = separator === '&&' ? command : command.replace(' && ', ' ; ');
  const shellCommand = globbing ? sequence.replace(' -t ', ' fixture-*.manifest -t ') : sequence;
  const env = { ...buildNativeAdmissionFixtureEnv(native.env), CI: '', PATH: `${fixture.path('bin')}:${native.env.PATH}`,
    HAPPIER_HSTACK_EXECUTION: '', HAPPIER_DEV_TARGET_EXECUTION: '1', FIXTURE_PRODUCER_EXIT: String(producerExit),
    FIXTURE_EXPECT_GLOB: globbing ? '1' : '0' };
  let terminal;
  const cancellation = new AbortController();
  let invocation = [launcher, '--local', '--', 'sh', '-c', shellCommand];
  if (entry === 'explicit') {
    const { buildRemoteExecCommand, resolvePackageCommandPolicy } = await import('../dev_targets/remote_commands.mjs');
    const policy = await resolvePackageCommandPolicy(['sh', '-c', shellCommand], { repoRoot, cwd: repoRoot });
    invocation = ['-c', buildRemoteExecCommand({ name: 'worker', platform: 'posix', repoDir: repoRoot,
      cliHomeDir: fixture.path('cli-home'), remotePath: [fixture.path('bin'), ...native.env.PATH.split(':')] }, {
      commandArgs: ['sh', '-c', shellCommand], commandPolicy: policy, admissionClass: policy.heavyClass,
      executionId: 'compound-admission-regression', environment: { HAPPIER_DEV_TARGET_EXECUTION: '1' },
    })];
  }
  try {
    await withWorkspaceBundleLock(async () => {
      const child = spawnTestProcess('/bin/sh', invocation, {
        cwd: repoRoot, env, signal: cancellation.signal, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', value => { stdout += value; });
      child.stderr.on('data', value => { stderr += value; });
      terminal = new Promise(resolve => child.once('close', status => resolve({ status, stdout, stderr })));
      await Promise.race([waitForBrokerState(native, status => status.waitingCount === 1 && status.activeCount === 0, t.signal),
        terminal.then(result => assert.fail(`compound terminated before producer readiness: ${result.stderr}`))]);
      assert.equal((await native.brokerStatus()).activeCount, 0, 'foreign producer wait holds zero test capacity');
    }, { lockPath, signal: t.signal });
    const result = await terminal;
    const stopsAfterProducer = producerExit !== 0 && separator === '&&';
    assert.equal(result.status, stopsAfterProducer ? producerExit : 0, result.stderr);
    assert.equal(result.stdout, stopsAfterProducer ? 'published' : 'publishedchecked');
    await assertBrokerIdle(native);
  } finally {
    cancellation.abort();
    await terminal;
  }
});

for (const platform of ['linux', 'win32']) test(`finite admission requests no dependency consumption on ${platform}`, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-dependency-admission-platform-' });
  const env = { ...buildNativeAdmissionFixtureEnv(), HAPPIER_STACK_HOME_DIR: fixture.root };
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  // Platform selection is an OS boundary. The resource/queue implementation
  // remains real; native Windows filesystem execution is a separate check.
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  let invocation;
  try {
    invocation = resolveWorkspaceBuildAdmissionInvocation({ command: process.execPath, args: ['-e', ''],
      repoDir: fixture.root, env });
  } finally { Object.defineProperty(process, 'platform', descriptor); }
  const rawLocks = platform === 'win32'
    ? invocation.args[2]
    : invocation.args.find(value => value.startsWith('--workspace-locks=')).slice('--workspace-locks='.length);
  assert.deepEqual(JSON.parse(rawLocks), []);
  if (platform === 'win32') {
    assert.equal(invocation.command, process.execPath);
    assert.equal(invocation.args[1], '--standalone');
  } else {
    assert.equal(invocation.command, '/bin/sh');
    assert.ok(invocation.args.includes('--heavyweight-admission'));
  }
});

for (const phase of ['capacity', 'execution']) test(`dependency writers are excluded only during reader execution, not ${phase} waits`, {
  skip: phase === 'capacity' && process.platform !== 'linux', timeout: 10000,
}, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-writer-only-admission-' });
  const env = { ...buildNativeAdmissionFixtureEnv(), HAPPIER_STACK_HOME_DIR: fixture.root };
  let writerEntries = 0;
  const write = () => withDependencyRefreshLock({ installDir: fixture.root, env, wait: false, signal: t.signal },
    async () => { writerEntries++; });
  if (phase === 'execution') {
    const locks = [{ kind: 'dependency', installDir: fixture.root,
      path: resolveDependencyRefreshLockPath(fixture.root, env) }];
    await withWorkspaceBuildResources({ locks, env, signal: t.signal }, async () => {
      await assert.rejects(write(), { code: 'HSTACK_WORKSPACE_ADMISSION_ORDER' });
    });
    await write();
  } else {
    const native = await installWorkspaceAdmissionProcessFixture(t, fixture.root);
    writeFakeBin({ root: fixture.root, binDirName: 'native-owner/node_modules/.bin', name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '1 73400320\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
    const holder = await holdNativeAdmissionFixtureMemory(t, native, { totalKiB: 73400320, availableKiB: 1 });
    const observedArrival = new Promise(resolve => {
      const watcher = fs.watch(native.resourceSamplesPath, () => { watcher.close(); resolve(); });
      t.after(() => watcher.close());
    });
    const cancellation = new AbortController();
    const pending = runWorkspaceBuildAdmission({ command: process.execPath, args: ['-e', 'process.stdout.write("consumed")'],
      launcherPath: native.launcher, repoDir: fixture.root, env: { ...native.env, HAPPIER_STACK_HOME_DIR: fixture.root },
      signal: cancellation.signal, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await Promise.race([observedArrival, pending.then(result => assert.fail(`reader terminated before queuing: ${result.status}: ${result.stderr}`))]);
      assert.equal((await native.brokerStatus()).waitingCount, 1);
      await write();
      await holder.release(() => writeFile(native.memoryOverridePath, JSON.stringify({
        availableMemoryKiB: 73400320, totalMemoryKiB: 73400320,
      })));
      const result = await pending;
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'consumed');
      await assertBrokerIdle(native);
    } finally {
      cancellation.abort();
      await holder.release();
      await pending;
    }
  }
  assert.equal(writerEntries, 1, 'writers can enter before admission or after consumption, never inside a reader');
});

test('Turbo preserves authenticated build transport context without forwarding unrelated environment', async t => {
  const require = createRequire(import.meta.url);
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'x64' ? '64' : process.arch;
  const extension = process.platform === 'win32' ? '.exe' : '';
  let turbo;
  for (const name of [`@turbo/${platform}-${arch}`, `turbo-${platform}-${arch}`]) {
    try { turbo = require.resolve(`${name}/bin/turbo${extension}`); break; }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  }
  assert.ok(turbo, 'the installed native Turbo binary is required; the probe never installs dependencies');
  const turboPackage = JSON.parse(await readFile(require.resolve('turbo/package.json'), 'utf8'));
  t.diagnostic(`installed Turbo ${turboPackage.version}`);

  const fixture = await createTempFixture(t, { prefix: 'happier-turbo-build-context-' });
  const packageDir = fixture.path('packages', 'probe');
  await mkdir(packageDir, { recursive: true });
  const contextKeys = [
    'HAPPIER_BUILD_DEPENDENCY_CUSTODY',
    'HAPPIER_DEV_TARGET_EXECUTION',
    'HAPPIER_HSTACK_EXECUTION',
    'HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN',
    'HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT',
    'HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE',
    'HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT',
    'HAPPIER_HEAVYWEIGHT_ADMISSION_FLOOR_KIB',
    'HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD',
    'HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES',
    'HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED',
  ];
  const unrelatedKey = 'HAPPIER_UNRELATED_TURBO_CONTEXT_PROBE';
  const config = JSON.parse(await readFile(new URL('../../../../../turbo.json', import.meta.url), 'utf8'));
  const transportConfig = Object.fromEntries(['envMode', 'globalEnv', 'globalPassThroughEnv']
    .filter(key => config[key] !== undefined).map(key => [key, config[key]]));
  await Promise.all([
    writeFile(fixture.path('package.json'), JSON.stringify({ name: 'build-context-probe', private: true,
      packageManager: JSON.parse(await readFile(new URL('../../../../../package.json', import.meta.url), 'utf8')).packageManager })),
    writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - packages/*\n'),
    writeFile(fixture.path('pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/probe: {}\n"),
    writeFile(fixture.path('turbo.json'), JSON.stringify({ ...transportConfig,
      tasks: { 'context-probe': { cache: false } } })),
    writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@happier-test/build-context-probe',
      version: '1.0.0', scripts: { 'context-probe': 'node probe.cjs' } })),
    // Only harmless sentinels reach this OS boundary. It neither authenticates
    // tokens nor takes locks; the existing admission tests own those checks.
    writeFile(join(packageDir, 'probe.cjs'), `require('node:fs').writeFileSync('context.json', JSON.stringify(
      Object.fromEntries(${JSON.stringify([...contextKeys, unrelatedKey])}.map(key => [key, process.env[key] ?? null]))));`),
  ]);
  const sentinels = Object.fromEntries(contextKeys.map(key => [key, `sentinel:${key}`]));
  const env = { ...process.env, ...sentinels, [unrelatedKey]: 'must-not-be-forwarded',
    TURBO_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' };
  delete env.TURBO_ENV_MODE;
  const child = spawnTestProcess(turbo, ['run', 'context-probe', '--filter=@happier-test/build-context-probe',
    '--cache=local:', '--output-logs=errors-only'], { cwd: fixture.root, env, signal: t.signal,
    stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stdout.on('data', chunk => { diagnostics += chunk; });
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(status, 0, diagnostics);
  const received = JSON.parse(await readFile(join(packageDir, 'context.json'), 'utf8'));
  assert.equal(received[unrelatedKey], null, 'Turbo must retain strict filtering for unrelated environment');
  assert.deepEqual(received, { ...sentinels, [unrelatedKey]: null },
    'finite descendants must retain placement, native admission and authenticated resource-custody transport');
});

test('typecheck declaration phase cannot wait while retaining an inherited package writer', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-declaration-writer-order-' });
  const owned = fixture.path('owned.lock');
  const foreign = fixture.path('foreign.lock');
  await withWorkspaceBundleLock(async ({ heldLockValue }) => {
    const env = { ...buildNativeAdmissionFixtureEnv(), HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
      HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '0' };
    await withWorkspaceBundleLock(async () => {
      await assert.rejects(withWorkspaceBuildResources({ locks: [{ path: foreign }], env,
        typecheckDeclarationPhase: true }, () => assert.fail('foreign writer must not be acquired')), {
        code: WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE,
      });
    }, { lockPath: foreign, signal: t.signal });
  }, { lockPath: owned, signal: t.signal });
});

test('development startup production runs locally without joining validation capacity admission including nested compilers', { skip: process.platform !== 'linux', timeout: 10000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-dev-startup-admission-' });
  const native = await installNativeAdmissionFixture({ root: fixture.root });
  const { launcher, admissionRoot } = native;
  writeFakeBin({ root: fixture.root, name: 'awk', content: '#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "1 73400320\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n' });
  const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`, HAPPIER_DEV_TARGET_EXECUTION: '',
    HAPPIER_HSTACK_EXECUTION: '1', HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '',
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: '[]' };
  const cancellation = new AbortController();
  const compiler = fixture.path('compiler.cjs');
  await writeFile(compiler, 'process.stdout.write("started");');
  const compilerOwner = new URL('../../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs', import.meta.url).href;
  const compile = `import {spawnSync} from 'node:child_process';
    import {resolveTypeScriptCliInvocation} from ${JSON.stringify(compilerOwner)};
    const invocation = resolveTypeScriptCliInvocation({args:[],env:process.env,
      requireResolve:()=>${JSON.stringify(fixture.path('compiler-package.json'))},
      readFileSyncImpl:()=>JSON.stringify({bin:{tsc:'./compiler.cjs'}})});
    const command = invocation.command.endsWith('/apps/stack/bin/hstack-exec') ? ${JSON.stringify(launcher)} : invocation.command;
    const result = spawnSync(command,invocation.argsPrefix,{env:process.env,encoding:'utf8'});
    process.stdout.write(result.stdout??''); process.stderr.write(result.stderr??''); process.exit(result.status??1);`;
  let queued;
  const waiting = new Promise(resolve => { queued = resolve; });
  const run = runWorkspaceBuildAdmission({ command: process.execPath, args: ['--input-type=module', '-e', compile],
    locks: [{ path: fixture.path('producer.lock') }], launcherPath: launcher, cwd: fixture.root, env,
    devStartup: true, stdio: ['ignore', 'pipe', 'pipe'], signal: cancellation.signal,
    onStderr: value => { if (String(value).includes('waiting for heavyweight admission')) queued('queued'); } });
  try {
    const outcome = await Promise.race([run, waiting]);
    assert.notEqual(outcome, 'queued', 'Stack startup must not wait behind the validation capacity queue');
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(outcome.stdout, 'started');
    await assertBrokerIdle(native);
    await assert.rejects(lstat(fixture.path('producer.lock')), { code: 'ENOENT' });
  } finally {
    cancellation.abort();
    await run;
  }
});

for (const cancelled of [false, true]) test(`standalone workspace admission releases earlier resources ${cancelled ? 'when cancelled while queued' : 'before waiting for a later publisher'}`, async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-standalone-workspace-order-' });
  const first = fixture.path('first.lock');
  const second = fixture.path('second.lock');
  const env = { ...buildNativeAdmissionFixtureEnv(), CI: '1', HAPPIER_DEV_TARGET_EXECUTION: '',
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: '[]',
    HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: '' };
  let notifyWaiting;
  const waiting = new Promise(resolve => { notifyWaiting = resolve; });
  const cancellation = new AbortController();
  let build, failure;
  await withWorkspaceBundleLock(async () => {
    build = runWorkspaceBuildAdmission({ command: process.execPath, args: ['-e', 'process.stdout.write("published")'],
      locks: [{ path: first }, { path: second }], cwd: fixture.root, env, signal: cancellation.signal,
      admissionRequired: false, stdio: ['ignore', 'pipe', 'pipe'],
      onStderr: chunk => { if (String(chunk).includes(second)) notifyWaiting(); } });
    await Promise.race([waiting, build.then(result => assert.fail(`publisher exited without waiting: ${result.stderr}`))]);
    try {
      await assert.rejects(lstat(first), { code: 'ENOENT' }, 'a queued multi-resource publisher must release its earlier lease');
      await withWorkspaceBundleLock(() => {}, { lockPath: first, wait: false });
    } catch (error) { failure = error; }
    if (cancelled) {
      cancellation.abort();
      assert.equal((await build).error?.name, 'AbortError');
    }
  }, { lockPath: second });
  const result = await build;
  if (!cancelled) assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, cancelled ? '' : 'published');
  await assert.rejects(lstat(first), { code: 'ENOENT' });
  if (failure) throw failure;
});

test('workspace resource contention never retries an entered publisher', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-workspace-publisher-error-' });
  const lockPath = fixture.path('publisher.lock');
  let entries = 0;
  const failure = new Error('nested publisher is unavailable');
  failure.code = WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE;
  await assert.rejects(withWorkspaceBuildResources({ locks: [{ path: lockPath }] }, async () => {
    entries++;
    throw failure;
  }), error => error === failure);
  assert.equal(entries, 1, 'a writer error must not replay publication');
  await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
});

// D1-D3 replace the per-waiter event worker with the host broker.
// Idle resource-sampling and socket-release contracts live in admission_broker.test.mjs.
