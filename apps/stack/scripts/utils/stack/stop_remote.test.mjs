import test from 'node:test';
import assert from 'node:assert/strict';
import { access, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnTestProcess } from '../../testkit/core/spawn_test_process.mjs';
import { buildRemoteQaBrowserStopCommand, resolveRemoteStackStatePaths } from '../dev_targets/remote_commands.mjs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { spawnDetachedInlineNodeTestProcess } from '../../testkit/core/spawn_test_process.mjs';
import { completeInterruptedStackStopBeforeStart, stopStackWithEnv as stopStackWithEnvImpl } from './stop.mjs';
import { captureDevTargetSyncFixture } from '../../testkit/core/dev_target_sync.mjs';
import { runCaptureResult } from '../proc/proc.mjs';
import { withDependencyConsumption, withDependencyRefresh, withDependencyRefreshLock } from '../proc/dependency_refresh.mjs';
import { readStackRuntimeStateFile, recordStackRuntimeStart, recordStackRuntimeUpdate } from './runtime_state.mjs';
import { resolveMutagenSessionName } from '../dev_targets/mutagen_project.mjs';
import { resolveRuntimeBuildAuthority } from '../../runtime/shared/runtime_build_authority.mjs';

function stopStackWithEnvOwner(input, dependencies = {}) {
  const capture = dependencies.runCaptureResultImpl;
  if (!capture) return stopStackWithEnvImpl(input, dependencies);
  // Native service retirement can still need synchronization fixtures; browser
  // retirement contacts its host directly without source preparation.
  return stopStackWithEnvImpl(input, { ...dependencies, runCaptureResultImpl: (command, args, options) =>
    captureDevTargetSyncFixture(command, args) ?? capture(command, args, options) });
}

function stopStackWithEnv(input, dependencies = {}) {
  const capture = dependencies.runCaptureResultImpl;
  if (!capture) return stopStackWithEnvOwner(input, dependencies);
  return stopStackWithEnvOwner(input, { ...dependencies, runCaptureResultImpl: (command, args, options) => {
    // These external SSH fixtures own native service state, not a browser.
    // Supply the actual browser inventory wire shape while keeping all Stack
    // decisions, retirement, ownership and persistence logic real.
    if (command === 'ssh' && String(args.at(-1)).includes('qa_browser_retirement.mjs')) {
      return { ok: true, exitCode: 0, out: JSON.stringify({ stackName: input.stackName, pids: [] }), err: '' };
    }
    return capture(command, args, options);
  } });
}

async function fixture(t, { inheritedTargets = false, targetName = 'linux1' } = {}) {
  const { root } = await createTempFixture(t, { prefix: 'hstack-stop-remote-' });
  const baseDir = join(root, 'test-remote');
  await mkdir(baseDir);
  const target = { name: targetName, platform: 'posix', ssh: `test-${targetName}`, repoDir: '/remote/repo', cliHomeDir: '/remote/home' };
  const env = { HAPPIER_STACK_REPO_DIR: root, HAPPIER_STACK_ENV_FILE: join(baseDir, 'env'), HAPPIER_STACK_STORAGE_DIR: root };
  await writeFile(join(baseDir, 'dev-targets.json'), JSON.stringify({ version: 1, targets: inheritedTargets ? [] : [target] }));
  if (inheritedTargets) {
    const authority = resolveRuntimeBuildAuthority({ rootDir: root, consumerStackName: 'test-remote', env, createRepoIdentityIfMissing: false });
    await mkdir(authority.producerStackBaseDir, { recursive: true });
    await writeFile(join(authority.producerStackBaseDir, 'dev-targets.json'), JSON.stringify({ version: 1, targets: [target] }));
  }
  const statePath = join(baseDir, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, { stackName: 'test-remote', ownerPid: null,
    placement: { daemon: targetName }, sourceRuntimeIdentities: {},
    remoteTargets: { [targetName]: { services: { daemon: true }, status: 'running', serviceStatus: { daemon: 'running' } } } });
  return { baseDir, statePath, target, input: { rootDir: root, baseDir, stackName: 'test-remote',
    env,
    json: true, noDocker: true, autoSweep: false } };
}

for (const dependencyState of ['failed', 'locked']) test(`browser retirement ignores ${dependencyState} dependencies and reclaims only owned processes`, { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await rm(f.statePath);
  const mirror = join(f.baseDir, 'mirror');
  // A source mirror with no installed packages and a real failed/held
  // publication. Only the package-manager callback and SSH are external fixtures.
  const files = [
    'apps/stack/bin/localSourceRuntimeBootstrap.mjs',
    'apps/stack/scripts/utils/dev_targets/qa_browser.mjs',
    'apps/stack/scripts/utils/dev_targets/qa_browser_retirement.mjs',
    'apps/stack/scripts/utils/proc/ownership.mjs',
    'apps/stack/scripts/utils/proc/proc.mjs',
    'apps/stack/scripts/utils/proc/pids.mjs',
    'apps/stack/scripts/utils/proc/terminate.mjs',
    'apps/stack/scripts/utils/proc/boundedLog.mjs',
    'apps/stack/scripts/utils/process/resolveCommandInvocation.mjs',
    'packages/cli-common/processInstance.mjs',
    'packages/cli-common/src/process/processLiveness.ts',
    'packages/cli-common/windowsCommandInvocation.mjs',
  ];
  for (const relative of files) {
    const destination = join(mirror, relative);
    await mkdir(dirname(destination), { recursive: true });
    try { await copyFile(new URL(`../../../../../${relative}`, import.meta.url), destination); }
    catch (error) { if (error.code !== 'ENOENT' || !relative.endsWith('qa_browser_retirement.mjs')) throw error; }
  }
  await writeFile(join(mirror, 'package.json'), JSON.stringify({ private: true }));
  const dependencyEnv = { ...process.env, HAPPIER_STACK_HOME_DIR: join(f.baseDir, 'dependency-home'),
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  const dependencyOptions = { installDir: mirror, env: dependencyEnv };
  if (dependencyState === 'failed') {
    await assert.rejects(withDependencyRefresh({ ...dependencyOptions, force: true }, async () => {
      throw new Error('fixture package manager failed');
    }), { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED' });
  } else {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const holder = withDependencyRefreshLock(dependencyOptions, async () => {
      entered.resolve(); await release.promise;
    });
    t.after(async () => { release.resolve(); await holder; });
    await Promise.race([entered.promise, holder.then(() => assert.fail('writer exited before admission'))]);
  }
  let admitted = false;
  await assert.rejects(withDependencyConsumption({ ...dependencyOptions, wait: false }, () => { admitted = true; }));
  assert.equal(admitted, false, 'the fixture must really refuse dependency consumption');
  const preload = join(f.baseDir, 'unrelated-dependency-preload.mjs');
  const publicationEntered = join(f.baseDir, 'publication-entered');
  const shellStartup = join(f.baseDir, 'shell-startup');
  // A host's noninteractive startup can replace a shell exit status. The
  // cleanup command must preserve unavailable-helper status through that OS boundary.
  await writeFile(shellStartup, "trap 'exit 1' EXIT\n");
  await writeFile(preload, `import { writeFileSync } from 'node:fs';
import { withDependencyConsumption } from ${JSON.stringify(new URL('../proc/dependency_refresh.mjs', import.meta.url).href)};
writeFileSync(${JSON.stringify(publicationEntered)}, 'entered');
await withDependencyConsumption({ installDir: ${JSON.stringify(mirror)}, env: { ...process.env,
  HAPPIER_STACK_HOME_DIR: ${JSON.stringify(dependencyEnv.HAPPIER_STACK_HOME_DIR)} }, wait: false }, () => {});
`);
  const healthy = { ...f.target, name: 'reachable', ssh: 'test-reachable', repoDir: mirror };
  const offline = { ...healthy, name: 'offline', ssh: 'test-offline' };
  await writeFile(join(f.baseDir, 'dev-targets.json'), JSON.stringify({ version: 1, targets: [healthy, offline] }));
  const paths = resolveRemoteStackStatePaths(healthy, { stackName: f.input.stackName, runtimeMode: 'controlled' });
  const profile = join(f.baseDir, 'browser-profile');
  await mkdir(profile);
  const children = [];
  async function browser(stackName, envPath, kind) {
    const child = spawnTestProcess(process.execPath, ['-e', `
      const fs = require('node:fs');
      process.on('SIGTERM', () => { fs.rmSync(${JSON.stringify(profile)}, { recursive: true, force: true }); process.exit(0); });
      setInterval(() => {}, 1000);
      console.log('ready');
    `], { env: { ...process.env, NODE_OPTIONS: '', HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath, HAPPIER_STACK_PROCESS_KIND: kind }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    await once(child.stdout, 'data');
    return child;
  }
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode != null || child.signalCode != null) continue;
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
  });
  const owned = await browser(f.input.stackName, paths.stackEnvPath, 'browser');
  const neighbor = await browser(`${f.input.stackName}-neighbor`, paths.stackEnvPath, 'browser');
  const otherKind = await browser(f.input.stackName, paths.stackEnvPath, 'session');
  const otherEnv = await browser(f.input.stackName, `${paths.stackEnvPath}-neighbor`, 'browser');
  const remoteEnv = { ...process.env, NODE_OPTIONS: `--import=${preload}`, BASH_ENV: shellStartup };
  const direct = await runCaptureResult('/bin/bash', ['-c', buildRemoteQaBrowserStopCommand(healthy, { stackName: f.input.stackName })], { env: remoteEnv });
  assert.equal(direct.ok, true, direct.err);
  assert.deepEqual(JSON.parse(direct.out), { stackName: f.input.stackName, pids: [owned.pid] });
  await assert.rejects(access(profile), { code: 'ENOENT' });
  await assert.rejects(access(publicationEntered), { code: 'ENOENT' });
  const secondOwned = await browser(f.input.stackName, paths.stackEnvPath, 'browser');
  let preparation = 0;
  const captureRemote = async (command, args) => {
    if (command !== 'ssh') { preparation++; return { ok: false, exitCode: 1, out: '', err: `dependency publication ${dependencyState}` }; }
    if (args.includes('test-offline')) return { ok: false, exitCode: 255, out: '', err: 'host offline' };
    return runCaptureResult('/bin/bash', ['-c', args.at(-1)], { env: remoteEnv });
  };
  const stopped = await stopStackWithEnvImpl(f.input, { runCaptureResultImpl: captureRemote });
  assert.equal(stopped.finalization.finalized, true);
  assert.deepEqual(stopped.errors, []);
  assert.equal(preparation, 0, 'retirement must not consume source synchronization or dependency publication');
  assert.deepEqual(stopped.browsers.remote, [{ target: 'reachable', stackName: f.input.stackName, pids: [secondOwned.pid] }]);
  assert.equal(stopped.browsers.warnings[0].code, 'browser_cleanup_unreachable:offline');
  assert.match(stopped.browsers.warnings[0].error, /host offline/);
  assert.equal(stopped.browsers.warnings.length, 1);
  await rm(join(mirror, 'apps/stack/scripts/utils/proc/ownership.mjs'));
  const incomplete = await stopStackWithEnvImpl(f.input, { runCaptureResultImpl: captureRemote });
  assert.equal(incomplete.finalization.finalized, true, 'an incomplete source helper must settle unavailable');
  assert.match(incomplete.browsers.warnings.find(warning => warning.code.endsWith(':reachable')).error, /source module missing/);
  await rm(join(mirror, 'apps/stack/scripts/utils/dev_targets/qa_browser_retirement.mjs'));
  const unavailable = await stopStackWithEnvImpl(f.input, { runCaptureResultImpl: captureRemote });
  assert.equal(unavailable.finalization.finalized, true, 'an unpublished native helper must remain optional');
  assert.deepEqual(unavailable.browsers.warnings.map(warning => warning.code).sort(), [
    'browser_cleanup_unreachable:offline', 'browser_cleanup_unreachable:reachable',
  ]);
  assert.match(unavailable.browsers.warnings.find(warning => warning.code.endsWith(':reachable')).error, /helper unavailable/);
  for (const relative of ['apps/stack/scripts/utils/proc/ownership.mjs', 'apps/stack/scripts/utils/dev_targets/qa_browser_retirement.mjs']) {
    await copyFile(new URL(`../../../../../${relative}`, import.meta.url), join(mirror, relative));
  }
  const recoveredOwned = await browser(f.input.stackName, paths.stackEnvPath, 'browser');
  const recovered = await stopStackWithEnvImpl(f.input, { runCaptureResultImpl: captureRemote });
  assert.equal(recovered.finalization.finalized, true);
  assert.deepEqual(recovered.browsers.remote, [{ target: 'reachable', stackName: f.input.stackName, pids: [recoveredOwned.pid] }]);
  assert.deepEqual(recovered.browsers.warnings.map(warning => warning.code), ['browser_cleanup_unreachable:offline']);
  for (const child of [neighbor, otherKind, otherEnv]) assert.equal(child.exitCode, null, 'foreign process must survive');
});

test('unreachable browser target warns without preventing stack stop or reachable browser cleanup', async t => {
  const f = await fixture(t, { targetName: 'linux3' });
  await rm(f.statePath);
  const healthy = { ...f.target, name: 'linux1', ssh: 'test-linux1' };
  await writeFile(join(f.baseDir, 'dev-targets.json'), JSON.stringify({ version: 1, targets: [f.target, healthy] }));
  // Exercise the real stop/browser owners; only the external SSH boundary is replaced.
  const stopped = await stopStackWithEnvOwner(f.input, { runCaptureResultImpl: async (_command, args) =>
    args.includes('test-linux3')
      ? { ok: false, exitCode: 255, out: '', err: 'ssh: connect to host linux3 port 22: Connection timed out' }
      : { ok: true, exitCode: 0, out: JSON.stringify({ stackName: f.input.stackName, pids: [1234] }), err: '' } });
  assert.equal(stopped.finalization.finalized, true, 'disposable browser confirmation must not block local stop');
  assert.deepEqual(stopped.errors, []);
  assert.deepEqual(stopped.browsers.warnings.map(warning => warning.code), ['browser_cleanup_unreachable:linux3']);
  assert.deepEqual(stopped.browsers.remote, [{ target: 'linux1', stackName: f.input.stackName, pids: [1234] }]);
});

test('unreachable browser hosts warn while reachable browsers are reaped and recovered hosts join the next sweep', async t => {
  const f = await fixture(t, { targetName: 'nl1' });
  await rm(f.statePath);
  const names = ['nl1', 'nl3', 'windows1-linux', 'windows2-linux'];
  const targets = names.map(name => ({ ...f.target, name, ssh: `test-${name}` }));
  await writeFile(join(f.baseDir, 'dev-targets.json'), JSON.stringify({ version: 1, targets }));
  let recovered = false;
  const reaped = [];
  const capture = async (command, args) => {
    assert.equal(command, 'ssh');
    const name = names.find(name => args.includes(`test-${name}`));
    assert.ok(name, 'cleanup must address a configured worker');
    if (!recovered && ['windows1-linux', 'windows2-linux'].includes(name)) {
      return { ok: false, exitCode: 255, out: '', err: 'fixture host unreachable' };
    }
    reaped.push(name);
    return { ok: true, exitCode: 0, out: JSON.stringify({ stackName: f.input.stackName, pids: [1234, 5678] }), err: '' };
  };
  const stopped = await stopStackWithEnvImpl(f.input, { runCaptureResultImpl: capture });
  assert.equal(stopped.finalization.finalized, true);
  assert.deepEqual(stopped.errors, []);
  assert.deepEqual(stopped.browsers.warnings.map(warning => warning.code).sort(), [
    'browser_cleanup_unreachable:windows1-linux', 'browser_cleanup_unreachable:windows2-linux',
  ]);
  assert.deepEqual(reaped.sort(), ['nl1', 'nl3']);
  assert.ok(stopped.browsers.remote.every(result => result.pids.length === 2), 'each reachable worker confirms the entire marked browser sweep');
  recovered = true;
  reaped.length = 0;
  const retried = await stopStackWithEnvImpl(f.input, { runCaptureResultImpl: capture });
  assert.equal(retried.finalization.finalized, true);
  assert.deepEqual(retried.browsers.warnings, []);
  assert.deepEqual(reaped.sort(), [...names].sort(), 'recovery must not leave a worker excluded from later orphan cleanup');
});

test('contacted browser workers with invalid cleanup confirmation fail closed', async t => {
  const f = await fixture(t);
  await rm(f.statePath);
  for (const out of ['not-json', JSON.stringify({ stackName: 'other-stack', pids: [] }),
    JSON.stringify({ stackName: f.input.stackName, pids: [0] })]) {
    const stopped = await stopStackWithEnvOwner(f.input, { runCaptureResultImpl: async () => ({ ok: true, exitCode: 0, out, err: '' }) });
    assert.equal(stopped.finalization.finalized, false, 'a contacted worker must positively confirm this Stack browser cleanup');
    assert.equal(stopped.finalization.reason, 'browser_cleanup_incomplete');
    assert.equal(stopped.errors[0].step, 'browsers');
  }
});

for (const platform of ['posix', 'windows']) {
  test(`preserving a remote daemon retires server and UI but retains daemon custody (${platform})`, async t => {
    const f = await fixture(t);
    const target = platform === 'windows' ? { ...f.target, platform, repoDir: 'C:/repo', cliHomeDir: 'C:/cli' } : f.target;
    await writeFile(join(f.baseDir, 'dev-targets.json'), JSON.stringify({ version: 1, targets: [target] }));
    await recordStackRuntimeUpdate(f.statePath, { remoteTargets: { linux1: {
      services: { daemon: true, server: true, expo: true },
      serviceStatus: { daemon: 'running', server: 'running', expo: 'running' },
    } } });
    let daemonAlive = true;
    let serverAlive = true;
    let uiAlive = true;
    // Only SSH/native process effects are simulated; Stop and custody are real.
    const runCaptureResultImpl = async (_command, args) => {
        const raw = String(args.at(-1));
        const command = platform === 'windows' ? Buffer.from(raw.split(' ').at(-1), 'base64').toString('utf16le') : raw;
        if (command.includes('stack stop')) {
          if (!command.includes('--preserve-daemon')) daemonAlive = false;
          serverAlive = false;
          uiAlive = false;
        } else if (command.includes('stack.runtime.json')) {
          const alive = serverAlive || uiAlive || (daemonAlive && !command.includes('"preserveDaemon":true'));
          return { ok: !alive, exitCode: alive ? 1 : 0 };
        }
        return { ok: true, exitCode: 0 };
    };
    const stopped = await stopStackWithEnv({ ...f.input, preserveDaemon: true }, { runCaptureResultImpl });
    assert.equal(daemonAlive, true, 'native Stop must honor the preservation request');
    assert.equal(serverAlive, false);
    assert.equal(uiAlive, false);
    assert.equal(stopped.finalization.finalized, true);
    const retained = await readStackRuntimeStateFile(f.statePath);
    assert.equal(retained.ownerPid, null);
    assert.equal(retained.stopRequest, null);
    assert.equal(retained.placement.daemon, 'linux1');
    assert.equal(retained.remoteTargets.linux1.serviceStatus.daemon, 'running');
    assert.equal(retained.remoteTargets.linux1.serviceStatus.server, 'stopped');
    assert.equal(retained.remoteTargets.linux1.serviceStatus.expo, 'stopped');
    assert.equal(retained.remoteTargets.linux1.forwardPid, null);
    const fullStop = await stopStackWithEnv(f.input, { runCaptureResultImpl });
    assert.equal(daemonAlive, false, 'a later full Stop consumes preserved native custody');
    assert.equal(fullStop.finalization.finalized, true);
    assert.equal(await readStackRuntimeStateFile(f.statePath), null);
  });
}

test('reachable browser cleanup failure still prevents stack stop finalization', async t => {
  const f = await fixture(t);
  await rm(f.statePath);
  const stopped = await stopStackWithEnvOwner(f.input, { runCaptureResultImpl: async () => ({
    ok: false, exitCode: 1, out: '', err: '[dev-targets] browser pid 1234 cleanup unconfirmed: permission_denied',
  }) });
  assert.equal(stopped.finalization.finalized, false);
  assert.equal(stopped.finalization.reason, 'browser_cleanup_incomplete');
  assert.equal(stopped.errors[0].step, 'browsers');
});

test('unreachable remote retirement finalizes local stop and survives a move to a healthy target until settlement', async t => {
  const f = await fixture(t, { targetName: 'linux3' });
  const runner = spawnDetachedInlineNodeTestProcess(`
    const server = require('node:net').createServer();
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    HAPPIER_STACK_STACK: f.input.stackName,
    HAPPIER_STACK_ENV_FILE: f.input.env.HAPPIER_STACK_ENV_FILE,
    HAPPIER_STACK_PROCESS_KIND: 'infra',
  } });
  t.after(async () => {
    if (runner.exitCode != null || runner.signalCode != null) return;
    const exited = once(runner, 'exit');
    runner.kill('SIGKILL');
    await exited;
  });
  const [output] = await once(runner.stdout, 'data');
  const port = Number(String(output).trim());
  await recordStackRuntimeUpdate(f.statePath, { ownerPid: runner.pid,
    remoteTargets: { linux3: { forwardPid: runner.pid } } });
  const unreachable = async () => ({ ok: false, exitCode: 255,
    err: 'ssh: connect to host 100.104.26.0 port 22: Connection timed out' });
  const stopped = await stopStackWithEnv(f.input, { runCaptureResultImpl: unreachable });
  assert.equal(stopped.finalization.finalized, true);
  assert.deepEqual(stopped.errors, []);
  assert.deepEqual(stopped.remoteRetirementPending.map(item => item.target), ['linux3'], 'local success must expose the unconfirmed remote retirement');
  assert.equal(runner.exitCode != null || runner.signalCode != null, true, 'the old controller can no longer recreate forwards');
  const retained = await readStackRuntimeStateFile(f.statePath);
  assert.equal(retained.ownerPid, null);
  assert.equal(retained.stopRequest, null);
  assert.equal(retained.remoteTargets.linux3.status, 'retirement-pending');
  assert.equal(retained.remoteTargets.linux3.runtimeMode, 'source-snapshot');
  assert.equal(retained.remoteTargets.linux3.forwardPid, null);
  assert.deepEqual(retained.remoteTargets.linux3.services, { daemon: true });
  const listener = createServer();
  t.after(() => listener.close());
  listener.listen(port, '127.0.0.1');
  await once(listener, 'listening');
  assert.equal(listener.address().port, port, 'local ingress is released');

  const healthy = { ...f.target, name: 'linux1', ssh: 'test-linux1' };
  await writeFile(join(f.baseDir, 'dev-targets.json'), JSON.stringify({ version: 1,
    targets: [f.target, healthy], runtimePlacement: { daemon: { mode: 'prefer-target', target: 'linux1', fallback: 'local' } } }));
  assert.equal((await completeInterruptedStackStopBeforeStart(f.input)).reason, 'no_stop_request');
  await recordStackRuntimeStart(f.statePath, { stackName: f.input.stackName, ownerPid: null,
    placement: { daemon: 'linux1' }, remoteTargets: { linux1: {
      services: { daemon: true }, status: 'running', serviceStatus: { daemon: 'running' },
    } } });
  assert.equal((await readStackRuntimeStateFile(f.statePath)).remoteTargets.linux3.status, 'retirement-pending');
  const second = await stopStackWithEnv(f.input, { runCaptureResultImpl: async (_command, args) =>
    args.includes('test-linux3') ? unreachable() : { ok: true, exitCode: 0 } });
  assert.equal(second.finalization.finalized, true, 'unreachable prior placement does not block the new lifecycle');
  assert.equal((await readStackRuntimeStateFile(f.statePath)).remoteTargets.linux3.status, 'retirement-pending');
  let nativeAlive = true;
  const settled = await stopStackWithEnv(f.input, { runCaptureResultImpl: async (_command, args) => {
    if (String(args.at(-1)).includes('stack stop')) nativeAlive = false;
    return { ok: !nativeAlive, exitCode: nativeAlive ? 1 : 0 };
  } });
  assert.equal(nativeAlive, false, 'recontact invokes the existing native retirement owner');
  assert.equal(settled.finalization.finalized, true);
  assert.equal(await readStackRuntimeStateFile(f.statePath), null);
});

test('ambiguous SSH loss and reachable retirement failure do not permit local finalization', async t => {
  const f = await fixture(t);
  for (const result of [
    { exitCode: 255, err: 'remote process exited with code 255' },
    { exitCode: 255, err: 'Permission denied (publickey).' },
    { exitCode: null, signal: 'SIGTERM', err: '' },
    { exitCode: 1, err: 'session_cleanup_incomplete' },
  ]) {
    const stopped = await stopStackWithEnv(f.input, { runCaptureResultImpl: async () => ({ ok: false, ...result }) });
    assert.equal(stopped.finalization.finalized, false);
    assert.equal(stopped.finalization.reason, 'remote_cleanup_incomplete');
    assert.ok((await readStackRuntimeStateFile(f.statePath)).stopRequest);
  }
});

test('recorded remote runtime already gone after interrupted stop is verified retired despite unknown exit status', async t => {
  const f = await fixture(t);
  const nativeStatePath = join(f.baseDir, 'native-runtime.json');
  await writeFile(nativeStatePath, JSON.stringify({ ownerPid: 2147483647, processes: { daemonPid: 2147483647 } }));
  const stopped = await stopStackWithEnv(f.input, { runCaptureResultImpl: async (_command, args) => {
    const command = String(args.at(-1));
    if (command.includes('stack stop')) {
      // The remote runtime is gone, but loss of its transport leaves no exit status.
      // Only external SSH is simulated; the parent retirement/state owners are real.
      await rm(nativeStatePath);
      return { ok: false, exitCode: null, signal: 'SIGTERM', out: '', err: '' };
    }
    const present = await readStackRuntimeStateFile(nativeStatePath);
    return { ok: !present, exitCode: present ? 1 : 0, out: '', err: '' };
  } });
  assert.equal(stopped.finalization.finalized, true, 'verified native absence is retirement, independent of transport exit status');
  assert.deepEqual(stopped.errors, []);
  assert.equal(await readStackRuntimeStateFile(nativeStatePath), null);
  assert.equal(await readStackRuntimeStateFile(f.statePath), null, 'retired target no longer strands parent state');
});

test('a refused remote SSH connection leaves retirement pending without blocking local stop', async t => {
  const f = await fixture(t);
  const stopped = await stopStackWithEnv(f.input, { runCaptureResultImpl: async () => ({ ok: false,
    exitCode: 255, err: 'ssh: connect to host 100.104.26.0 port 22: Connection refused' }) });
  assert.equal(stopped.finalization.finalized, true);
  assert.deepEqual(stopped.errors, []);
  assert.equal((await readStackRuntimeStateFile(f.statePath)).remoteTargets.linux1.status, 'retirement-pending');
});

test('never-started unreachable target releases local stop but preserves unknown prior native custody', async t => {
  const f = await fixture(t);
  await recordStackRuntimeUpdate(f.statePath, { remoteTargets: { linux1: {
    status: 'starting', phase: 'prepare', forwardPid: null, serviceStatus: { daemon: 'starting' },
  } } });
  const stopped = await stopStackWithEnv(f.input, { runCaptureResultImpl: async () => ({ ok: false,
    exitCode: 255, err: 'ssh: connect to host linux1 port 22: No route to host' }) });
  assert.equal(stopped.finalization.finalized, true, 'failure before worker dispatch must not strand the local controller');
  assert.deepEqual(stopped.errors, []);
  const retained = await readStackRuntimeStateFile(f.statePath);
  assert.equal(retained.remoteTargets.linux1.status, 'retirement-pending', 'never launched here does not prove that a previous native daemon or Session is absent');
  assert.equal(retained.remoteTargets.linux1.forwardPid, null);
  assert.equal(retained.stopRequest, null);
  assert.deepEqual(stopped.remoteRetirementPending.map(item => item.target), ['linux1']);
});

test('a retirement transport failure still blocks stop when the fresh probe reaches a surviving remote runtime', async t => {
  const f = await fixture(t);
  const stopped = await stopStackWithEnv(f.input, { runCaptureResultImpl: async (_command, args) =>
    String(args.at(-1)).includes('stack stop')
      ? { ok: false, exitCode: 255, err: 'ssh: connect to host 100.104.26.0 port 22: Connection timed out' }
      : { ok: false, exitCode: 1 } });
  assert.equal(stopped.finalization.finalized, false, 'reachable unretired Sessions retain custody');
  assert.equal(stopped.finalization.reason, 'remote_cleanup_incomplete');
  assert.ok((await readStackRuntimeStateFile(f.statePath)).stopRequest);
});

test('parent stop retains remote custody on native Session cleanup failure and retries it through the same owner', async t => {
  const f = await fixture(t, { inheritedTargets: true });
  let nativeAlive = true;
  let cleanupAllowed = false;
  const commands = [];
  // Only external process execution is replaced; configuration, native command
  // construction, parent stop and state writes are real.
  const capture = async (_command, args) => {
    const remote = String(args.at(-1));
    commands.push(remote);
    if (args.includes('mutagen')) {
      return { ok: true, exitCode: 0, out: JSON.stringify([{ name: resolveMutagenSessionName('linux1', f.input.rootDir),
        paused: false, status: 'watching', successfulCycles: 1, alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }]) };
    }
    if (remote.includes('stack stop')) {
      if (cleanupAllowed) nativeAlive = false;
      return { ok: cleanupAllowed, exitCode: cleanupAllowed ? 0 : 1, err: cleanupAllowed ? '' : 'session_cleanup_incomplete' };
    }
    return { ok: !nativeAlive, exitCode: nativeAlive ? 1 : 0 };
  };
  const failed = await stopStackWithEnv(f.input, { runCaptureResultImpl: capture });
  assert.equal(failed.finalization.finalized, false, 'a surviving native role must prevent parent stopped success');
  const retained = await readStackRuntimeStateFile(f.statePath);
  assert.equal(retained.placement.daemon, 'linux1');
  assert.ok(retained.stopRequest, 'a retry must retain stop custody');
  assert.equal(nativeAlive, true);
  cleanupAllowed = true;
  const stopped = await stopStackWithEnv(f.input, { runCaptureResultImpl: capture });
  assert.equal(nativeAlive, false, 'retry must reach the native guarded stop rather than erase parent metadata');
  assert.equal(stopped.finalization.finalized, true);
  assert.equal(await readStackRuntimeStateFile(f.statePath), null);
  assert.equal(commands.filter(command => command.includes('stack stop')).length, 2);
});

test('parent stop refuses to forget a recorded remote target removed from configuration', async t => {
  const f = await fixture(t);
  await writeFile(join(f.baseDir, 'dev-targets.json'), JSON.stringify({ version: 1, targets: [] }));
  const result = await stopStackWithEnv(f.input, { runCaptureResultImpl: async () => assert.fail('no target transport is configured') });
  assert.equal(result.finalization.finalized, false);
  assert.equal((await readStackRuntimeStateFile(f.statePath)).placement.daemon, 'linux1');
});

test('parent stop uses the retained native scope before a controlled target reaches readiness', async t => {
  const f = await fixture(t);
  await recordStackRuntimeUpdate(f.statePath, { sourceRuntimeIdentities: null,
    remoteTargets: { linux1: { runtimeMode: 'controlled', status: 'starting', serviceStatus: { daemon: 'starting' } } } });
  let stoppedNativeScope = null;
  const result = await stopStackWithEnv(f.input, { runCaptureResultImpl: async (_command, args) => {
    if (args.includes('mutagen')) return { ok: true, exitCode: 0, out: JSON.stringify([{ name: resolveMutagenSessionName('linux1', f.input.rootDir),
      paused: false, status: 'watching', successfulCycles: 1, alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }]) };
    const command = String(args.at(-1));
    if (command.includes('stack stop')) { stoppedNativeScope = command; return { ok: true, exitCode: 0 }; }
    return { ok: false, exitCode: 1 };
  } });
  assert.equal(result.finalization.finalized, true);
  assert.ok(stoppedNativeScope?.includes('/remote/home/stack-state/test-remote/cli'), 'the stop must use the native retained scope, not a legacy target-derived Stack');
});

test('parent stop releases recorded local forwards after remote retirement and preserves another stack forward', async t => {
  const f = await fixture(t);
  const startForward = async stackName => {
    const child = spawnDetachedInlineNodeTestProcess(`
      const server = require('node:net').createServer();
      server.listen(0, '127.0.0.1', () => console.log(server.address().port));
    `, { stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: stackName === f.input.stackName ? f.input.env.HAPPIER_STACK_ENV_FILE : join(f.baseDir, 'other-env'),
      HAPPIER_STACK_PROCESS_KIND: 'infra',
    } });
    t.after(async () => {
      if (child.exitCode != null || child.signalCode != null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    });
    const [output] = await once(child.stdout, 'data');
    return { child, port: Number(String(output).trim()) };
  };
  const owned = await startForward(f.input.stackName);
  const other = await startForward('another-stack');
  await recordStackRuntimeUpdate(f.statePath, { remoteTargets: {
    linux1: { status: 'stopped', serviceStatus: { daemon: 'stopped' }, forwardPid: owned.child.pid },
    stale: { services: {}, status: 'stopped', forwardPid: other.child.pid },
  } });
  const stopped = await stopStackWithEnv(f.input, { runCaptureResultImpl: runCaptureResult });
  assert.equal(owned.child.exitCode != null || owned.child.signalCode != null, true,
    'remote service retirement must not leave its controller-local forward alive');
  assert.equal(other.child.exitCode, null, 'a stale PID record grants no authority over another stack');
  assert.equal(other.child.signalCode, null);
  assert.equal(stopped.finalization.finalized, true);
  assert.equal(await readStackRuntimeStateFile(f.statePath), null);
  const listener = createServer();
  t.after(() => listener.close());
  listener.listen(owned.port, '127.0.0.1');
  await once(listener, 'listening');
  assert.equal(listener.address().port, owned.port, 'restart can reuse the released ingress port');
});

test('parent stop retires a native target without a healthy source synchronization', async t => {
  const f = await fixture(t);
  let nativeAlive = true;
  const result = await stopStackWithEnv(f.input, { runCaptureResultImpl: async (commandName, args) => {
    if (commandName === 'mutagen' || args.includes('mutagen')) return { ok: false, exitCode: 1, err: 'beta transition problem' };
    const command = String(args.at(-1));
    if (command.includes('stack stop')) {
      nativeAlive = false;
      return { ok: true, exitCode: 0 };
    }
    return { ok: !nativeAlive, exitCode: nativeAlive ? 1 : 0 };
  } });
  assert.equal(nativeAlive, false);
  assert.equal(result.finalization.finalized, true);
  assert.deepEqual(result.browsers.warnings, [], 'browser cleanup does not consume source synchronization');
  assert.equal(await readStackRuntimeStateFile(f.statePath), null);
});

test('remote stop uses an independent SSH transport when a shared master refuses new sessions', async t => {
  const f = await fixture(t);
  let nativeAlive = true;
  const result = await stopStackWithEnv(f.input, { runCaptureResultImpl: async (_command, args) => {
    if (args.includes('mutagen')) return { ok: true, exitCode: 0, out: JSON.stringify([{
      name: resolveMutagenSessionName('linux1', f.input.rootDir), paused: false,
      status: 'watching', successfulCycles: 1,
      alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true },
    }]) };
    if (!args.includes('ControlMaster=no') || !args.includes('ControlPath=none')) {
      return { ok: false, exitCode: 255, err: 'Session open refused by peer' };
    }
    if (String(args.at(-1)).includes('stack stop')) nativeAlive = false;
    return { ok: !nativeAlive, exitCode: nativeAlive ? 1 : 0 };
  } });
  assert.equal(nativeAlive, false);
  assert.equal(result.finalization.finalized, true);
});
