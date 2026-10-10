import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { spawnDetachedInlineNodeTestProcess } from '../../testkit/core/spawn_test_process.mjs';
import { completeInterruptedStackStopBeforeStart, stopStackWithEnv as stopStackWithEnvOwner } from './stop.mjs';
import { readStackRuntimeStateFile, recordStackRuntimeStart, recordStackRuntimeUpdate } from './runtime_state.mjs';
import { resolveMutagenSessionName } from '../dev_targets/mutagen_project.mjs';
import { resolveRuntimeBuildAuthority } from '../../runtime/shared/runtime_build_authority.mjs';

function stopStackWithEnv(input, dependencies = {}) {
  const capture = dependencies.runCaptureResultImpl;
  if (!capture) return stopStackWithEnvOwner(input, dependencies);
  return stopStackWithEnvOwner(input, { ...dependencies, runCaptureResultImpl: (command, args, options) => {
    // These external SSH fixtures own native service state, not a browser.
    // Supply the actual browser inventory wire shape while keeping all Stack
    // decisions, retirement, ownership and persistence logic real.
    if (command === 'ssh' && String(args.at(-1)).includes('qa_browser.mjs --stop-stack')) {
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
  assert.deepEqual(stopped.browsers.warnings.map(warning => warning.code), ['browser_cleanup_unconfirmed:linux3']);
  assert.deepEqual(stopped.browsers.remote, [{ target: 'linux1', stackName: f.input.stackName, pids: [1234] }]);
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
    const stopped = await stopStackWithEnv({ ...f.input, preserveDaemon: true }, {
      // Only SSH/native process effects are simulated; Stop and custody are real.
      runCaptureResultImpl: async (_command, args) => {
        const raw = String(args.at(-1));
        const command = platform === 'windows' ? Buffer.from(raw.split(' ').at(-1), 'base64').toString('utf16le') : raw;
        if (command.includes('stack stop')) {
          daemonAlive = command.includes('--preserve-daemon');
          serverAlive = false;
          uiAlive = false;
        }
        return { ok: true, exitCode: 0 };
      },
    });
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
  const stopped = await stopStackWithEnv(f.input);
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
  const result = await stopStackWithEnv(f.input, { runCaptureResultImpl: async (_command, args) => {
    if (args.includes('mutagen')) return { ok: false, exitCode: 1, err: 'beta transition problem' };
    const command = String(args.at(-1));
    if (command.includes('stack stop')) {
      nativeAlive = false;
      return { ok: true, exitCode: 0 };
    }
    return { ok: !nativeAlive, exitCode: nativeAlive ? 1 : 0 };
  } });
  assert.equal(nativeAlive, false);
  assert.equal(result.finalization.finalized, true);
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
