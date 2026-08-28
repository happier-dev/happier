import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import {
  ensureExecutionHostServiceTunnel,
  inspectExecutionHostStackRuntime,
  stopExecutionHostServiceTunnel,
  superviseExecutionHostServiceTunnel,
  waitForExecutionHostServiceTunnel,
} from './service_tunnel.mjs';

function profile(limaHome) {
  return {
    version: 2,
    mode: 'managed-lima',
    activation: 'active',
    instance: 'primary',
    limaHome,
    profile: 'balanced',
    pressureProfile: 'none',
    guestWorkspaceDir: '/home/guest/.happier-stack/workspace',
    mirrorWorkspaceDir: '/Users/example/.happier-stack/workspace-mirror',
    controllerEntrypoint: '/Users/example/happier/dev/apps/stack/scripts/execution_host_bridge.mjs',
    workspaces: [{
      id: '0.3',
      hostSourceDir: '/Users/example/happier/dev',
      hostMirrorDir: '/Users/example/.happier-stack/workspace-mirror/0.3',
      guestDir: '/home/guest/.happier-stack/workspace/0.3',
    }],
  };
}

function runtimeProjection({
  stackName = 'repo-dev-1234567890',
  serverPort = 52753,
  backendPort = 52754,
  expoPort = 18829,
} = {}) {
  return [
    `stackName=${stackName}`,
    `serverPort=${serverPort}`,
    `expoPort=${expoPort}`,
    JSON.stringify({
      stackName,
      ports: { server: serverPort, serverBackend: backendPort },
      serverProxy: { enabled: true, mode: 'proxy' },
      expo: { port: expoPort, webPort: expoPort, mobilePort: null, webEnabled: true, devClientEnabled: false },
    }),
  ].join('\n');
}

function runtimeExecutor(out) {
  const calls = [];
  return {
    calls,
    capture: async (command, args) => {
      calls.push({ command, args });
      return { exitCode: 0, out, err: '' };
    },
  };
}

function tunnelBoundary({ listenerPids, fingerprint = 'darwin-ps:started', marker = 'primary:0.3:repo-dev-1234567890' } = {}) {
  const spawned = [];
  const terminated = [];
  return {
    spawned,
    terminated,
    spawn(command, args, options) {
      const child = { pid: 731, unref() {} };
      spawned.push({ command, args, options, child });
      return child;
    },
    async listListeners(port, options) {
      const pids = typeof listenerPids === 'function'
        ? listenerPids(port, spawned, options)
        : listenerPids.get(port) ?? [];
      return { status: 'ok', supported: true, pids };
    },
    async probePortBinding() {
      return { status: 'free' };
    },
    readFingerprint() {
      return fingerprint;
    },
    async observeProcess(pid) {
      return {
        status: 'ok',
        line: `${pid} ssh HAPPIER_STACK_PROCESS_KIND=execution-host-service-tunnel HAPPIER_STACK_EXECUTION_HOST_TUNNEL=${marker}`,
      };
    },
    async terminate(pid, options) {
      terminated.push({ pid, options });
      return { ok: true, signal: 'SIGTERM' };
    },
    async delay() {},
  };
}

async function waitForTunnelState(statePath, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      const value = predicate(state);
      if (value) return value;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const value = predicate(null);
      if (value) return value;
    }
    // Let the separately invoked canonical reconciler reach its next boundary.
    // This deliberately avoids inventing a test-only production hook.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for service tunnel state: ${statePath}`);
}

test('runtime projection reads only the selected guest Stack declaration and maps server backend plus Expo web', async () => {
  const executor = runtimeExecutor(runtimeProjection());
  const result = await inspectExecutionHostStackRuntime({
    profile: profile('/Users/example/.happier-stack/lima'),
    workspaceId: '0.3',
    stackName: 'repo-dev-1234567890',
    executor,
  });

  assert.equal(result.stackName, 'repo-dev-1234567890');
  assert.deepEqual(result.forwards, [
    { service: 'server', listenHost: '0.0.0.0', listenPort: 52753, targetHost: '127.0.0.1', targetPort: 52754 },
    { service: 'expo-web', listenHost: '0.0.0.0', listenPort: 18829, targetHost: '127.0.0.1', targetPort: 18829 },
  ]);
  assert.deepEqual(executor.calls[0].args.slice(0, 7), [
    'shell', '--workdir', '/home/guest/.happier-stack/workspace/0.3', 'primary', '--', 'sh', '-lc',
  ]);
  assert.match(executor.calls[0].args[7], /HAPPIER_STACK_REPO_DIR/);
  assert.doesNotMatch(executor.calls[0].args[7], /\bnode\b/);
  assert.equal(executor.calls[0].args.at(-1), 'repo-dev-1234567890');
});

test('runtime projection exposes the pinned Expo endpoint when Expo runs on a Dev Target', async () => {
  const executor = runtimeExecutor([
    'stackName=repo-dev-1234567890',
    'serverPort=52753',
    'expoPort=18829',
    JSON.stringify({
      stackName: 'repo-dev-1234567890',
      ports: { server: 52753, serverBackend: null },
      serverProxy: { enabled: false, mode: 'direct' },
      placement: { server: 'mac-host', expo: 'mac-host', daemon: 'local' },
      remoteTargets: {
        'mac-host': {
          services: { server: true, expo: true, daemon: true },
          serviceStatus: { server: 'running', expo: 'running', daemon: 'running' },
          status: 'running',
        },
      },
      expo: null,
    }),
  ].join('\n'));

  const result = await inspectExecutionHostStackRuntime({
    profile: profile('/Users/example/.happier-stack/lima'),
    workspaceId: '0.3',
    stackName: 'repo-dev-1234567890',
    executor,
  });

  assert.deepEqual(result.forwards, [
    { service: 'server', listenHost: '0.0.0.0', listenPort: 52753, targetHost: '127.0.0.1', targetPort: 52753 },
    { service: 'expo', listenHost: '0.0.0.0', listenPort: 18829, targetHost: '127.0.0.1', targetPort: 18829 },
  ]);
});

test('execution-host service tunnel starts one detached SSH transport with all runtime-declared public TCP services and is idempotent', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-service-tunnel-' });
  const env = { HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  const listenerPids = (port, spawned) => spawned.length > 0 && (port === 52753 || port === 18829)
    ? [731]
    : [];
  const boundary = tunnelBoundary({ listenerPids });
  const executor = runtimeExecutor(runtimeProjection());
  const input = {
    profile: profile(fixture.path('lima')),
    workspaceId: '0.3',
    executor,
    env,
    boundary,
  };

  const first = await ensureExecutionHostServiceTunnel(input);
  const second = await ensureExecutionHostServiceTunnel(input);

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(boundary.spawned.length, 1);
  const spawn = boundary.spawned[0];
  assert.equal(spawn.command, 'ssh');
  assert.equal(spawn.options.detached, true);
  assert.equal(spawn.options.shell, false);
  assert.equal(spawn.options.env.HAPPIER_STACK_PROCESS_KIND, 'execution-host-service-tunnel');
  assert.deepEqual(spawn.args, [
    '-T',
    '-F', `${fixture.path('lima')}/primary/ssh.config`,
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    '-o', 'SetEnv=HAPPIER_STACK_EXECUTION_HOST_TUNNEL=primary:0.3:repo-dev-1234567890',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-L', '*:52753:127.0.0.1:52754',
    '-L', '*:18829:127.0.0.1:18829',
    '-N', 'lima-primary',
  ]);
  const state = JSON.parse(await readFile(first.statePath, 'utf8'));
  assert.equal(state.pid, 731);
  assert.equal(state.processInstanceFingerprint, 'darwin-ps:started');
  assert.equal(state.transition, undefined, 'steady-state records retain the established active shape');
});

test('service tunnel admits free ports by binding and scopes listener ownership checks to its SSH PID', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-service-tunnel-scoped-listeners-' });
  const bindProbes = [];
  const boundary = tunnelBoundary({
    listenerPids: (_port, _spawned, options) => {
      if (!Array.isArray(options?.candidatePids) || options.candidatePids.length !== 1 || options.candidatePids[0] !== 731) {
        throw new Error('service tunnel must not use unscoped listener discovery');
      }
      return [731];
    },
  });
  boundary.probePortBinding = async (port, options) => {
    bindProbes.push({ port, host: options?.host });
    return { status: 'free' };
  };
  const input = {
    profile: profile(fixture.path('lima')),
    workspaceId: '0.3',
    executor: runtimeExecutor(runtimeProjection()),
    env: { HAPPIER_STACK_HOME_DIR: fixture.path('home') },
    boundary,
  };

  const first = await ensureExecutionHostServiceTunnel(input);
  const repeated = await ensureExecutionHostServiceTunnel(input);

  assert.equal(first.status, 'running');
  assert.equal(repeated.status, 'running');
  assert.deepEqual(bindProbes, [
    { port: 52753, host: '0.0.0.0' },
    { port: 18829, host: '0.0.0.0' },
  ]);
});

test('service tunnel recognizes its PID-verified SSH child when macOS hides process environment', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-service-tunnel-macos-ownership-' });
  const boundary = tunnelBoundary({
    listenerPids: (port, spawned) => spawned.length > 0 && (port === 52753 || port === 18829) ? [731] : [],
  });
  boundary.observeProcess = async (pid) => ({
    status: 'ok',
    line: `${pid} ssh ${boundary.spawned[0].args.join(' ')}`,
  });
  const input = {
    profile: profile(fixture.path('lima')),
    workspaceId: '0.3',
    executor: runtimeExecutor(runtimeProjection()),
    env: { HAPPIER_STACK_HOME_DIR: fixture.path('home') },
    boundary,
  };

  await ensureExecutionHostServiceTunnel(input);
  const repeated = await ensureExecutionHostServiceTunnel(input);

  assert.equal(repeated.status, 'running');
  assert.equal(repeated.changed, false);
  assert.equal(boundary.spawned.length, 1);
});

test('service tunnel adopts its legacy exact SSH plan when macOS hid the old environment-only marker', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-service-tunnel-legacy-macos-ownership-' });
  const boundary = tunnelBoundary({
    listenerPids: (port, spawned) => spawned.length > 0 && (port === 52753 || port === 18829) ? [731] : [],
  });
  boundary.observeProcess = async (pid) => {
    const args = [...boundary.spawned[0].args];
    const markerIndex = args.findIndex((argument) => argument.startsWith('SetEnv=HAPPIER_STACK_EXECUTION_HOST_TUNNEL='));
    args.splice(markerIndex - 1, 2);
    return { status: 'ok', line: `${pid} ssh ${args.join(' ')}` };
  };
  const input = {
    profile: profile(fixture.path('lima')),
    workspaceId: '0.3',
    executor: runtimeExecutor(runtimeProjection()),
    env: { HAPPIER_STACK_HOME_DIR: fixture.path('home') },
    boundary,
  };

  await ensureExecutionHostServiceTunnel(input);
  const repeated = await ensureExecutionHostServiceTunnel(input);

  assert.equal(repeated.status, 'running');
  assert.equal(repeated.changed, false);
  assert.equal(boundary.spawned.length, 1);
});

test('service tunnel readiness waits for a just-started Stack runtime instead of leaving host ports absent', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-service-tunnel-readiness-' });
  const calls = [];
  const executor = {
    async capture() {
      calls.push('inspect');
      return calls.filter((call) => call === 'inspect').length === 1
        ? { exitCode: 3, out: '', err: '' }
        : { exitCode: 0, out: runtimeProjection(), err: '' };
    },
  };
  const boundary = tunnelBoundary({
    listenerPids: (port, spawned) => spawned.length > 0 && (port === 52753 || port === 18829) ? [731] : [],
  });
  boundary.delay = async () => { calls.push('delay'); };

  const result = await waitForExecutionHostServiceTunnel({
    profile: profile(fixture.path('lima')),
    workspaceId: '0.3',
    stackName: 'repo-dev-1234567890',
    executor,
    env: { HAPPIER_STACK_HOME_DIR: fixture.path('home') },
    boundary,
  });

  assert.equal(result.status, 'running');
  assert.deepEqual(calls, ['inspect', 'delay', 'inspect']);
  assert.equal(boundary.spawned.length, 1);
});

test('service tunnel supervision replaces one transiently exited owned SSH transport and stops on cancellation', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-service-tunnel-supervision-' });
  const env = { HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  const controller = new AbortController();
  let activePid = null;
  let nextPid = 731;
  let delays = 0;
  const boundary = tunnelBoundary({
    listenerPids: () => activePid == null ? [] : [activePid],
  });
  boundary.spawn = (command, args, options) => {
    const child = { pid: nextPid, unref() {} };
    nextPid += 1;
    activePid = child.pid;
    boundary.spawned.push({ command, args, options, child });
    return child;
  };
  boundary.readFingerprint = (pid) => `darwin-ps:${pid}`;
  boundary.observeProcess = async (pid) => (
    pid === activePid
      ? {
          status: 'ok',
          line: `${pid} ssh HAPPIER_STACK_PROCESS_KIND=execution-host-service-tunnel HAPPIER_STACK_EXECUTION_HOST_TUNNEL=primary:0.3:repo-dev-1234567890`,
        }
      : { status: 'not_found' }
  );
  boundary.delay = async () => {
    delays += 1;
    if (delays === 1) {
      activePid = null;
      return;
    }
    if (delays === 2) {
      activePid = null;
      controller.abort();
    }
  };

  const result = await superviseExecutionHostServiceTunnel({
    profile: profile(fixture.path('lima')),
    workspaceId: '0.3',
    stackName: 'repo-dev-1234567890',
    executor: runtimeExecutor(runtimeProjection()),
    env,
    boundary,
    signal: controller.signal,
  });

  assert.equal(result.status, 'cancelled');
  assert.equal(boundary.spawned.length, 2, 'the exited child should receive exactly one replacement');
  assert.equal(boundary.terminated.length, 0, 'a missing child must not cause any port-owner termination');
  const state = JSON.parse(await readFile(`${fixture.path('home')}/execution-host-tunnels/primary-0.3.json`, 'utf8'));
  assert.equal(state.pid, 732);
});

test('service tunnel supervision does not poll a stable initial remote Expo projection', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-service-tunnel-supervision-expo-' });
  const env = { HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  const controller = new AbortController();
  let activePid = null;
  let nextPid = 731;
  let delays = 0;
  const executor = runtimeExecutor(runtimeProjection({ expoPort: 19364 }));
  const boundary = tunnelBoundary({
    listenerPids: (_port, _spawned, { candidatePids } = {}) => (
      activePid != null && candidatePids?.includes(activePid) ? [activePid] : []
    ),
  });
  boundary.spawn = (command, args, options) => {
    const child = { pid: nextPid, unref() {} };
    nextPid += 1;
    activePid = child.pid;
    boundary.spawned.push({ command, args, options, child });
    return child;
  };
  boundary.readFingerprint = (pid) => `darwin-ps:${pid}`;
  boundary.observeProcess = async (pid) => (
    pid === activePid
      ? {
          status: 'ok',
          line: `${pid} ssh HAPPIER_STACK_PROCESS_KIND=execution-host-service-tunnel HAPPIER_STACK_EXECUTION_HOST_TUNNEL=primary:0.3:repo-dev-1234567890`,
        }
      : { status: 'not_found' }
  );
  boundary.terminate = async (pid, options) => {
    boundary.terminated.push({ pid, options });
    if (pid === activePid) activePid = null;
    return { ok: true, signal: 'SIGTERM' };
  };
  boundary.delay = async () => {
    delays += 1;
    if (delays === 2) controller.abort();
  };

  const result = await superviseExecutionHostServiceTunnel({
    profile: profile(fixture.path('lima')),
    workspaceId: '0.3',
    stackName: 'repo-dev-1234567890',
    executor,
    env,
    boundary,
    signal: controller.signal,
  });

  assert.equal(result.status, 'cancelled');
  assert.equal(executor.calls.length, 1, 'a stable plan must not spawn a guest executor on every health check');
  assert.equal(boundary.spawned.length, 1);
  assert.equal(boundary.terminated.length, 0);
  const state = JSON.parse(await readFile(`${fixture.path('home')}/execution-host-tunnels/primary-0.3.json`, 'utf8'));
  assert.deepEqual(state.forwards, [
    { service: 'server', listenHost: '0.0.0.0', listenPort: 52753, targetHost: '127.0.0.1', targetPort: 52754 },
    { service: 'expo-web', listenHost: '0.0.0.0', listenPort: 19364, targetHost: '127.0.0.1', targetPort: 19364 },
  ]);
});

test('service tunnel supervision waits through a canonical replacement without starting a competing SSH transport', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-service-tunnel-supervision-replacement-' });
  const env = { HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  const statePath = `${fixture.path('home')}/execution-host-tunnels/primary-0.3.json`;
  const spawned = [];
  const terminated = [];
  let activePid = null;
  let nextPid = 731;
  let replacementListenersReady = false;
  let releaseReplacementListeners;
  const replacementListenersReleased = new Promise((resolve) => {
    releaseReplacementListeners = resolve;
  });
  let projection = runtimeProjection();
  const executor = { capture: async () => ({ exitCode: 0, out: projection, err: '' }) };
  const sharedBoundary = {
    spawn(command, args, options) {
      const child = { pid: nextPid, unref() {} };
      nextPid += 1;
      activePid = child.pid;
      spawned.push({ command, args, options, child });
      return child;
    },
    async listListeners() {
      return {
        status: 'ok',
        supported: true,
        pids: activePid != null && (activePid === 731 || replacementListenersReady) ? [activePid] : [],
      };
    },
    async probePortBinding() {
      return { status: 'free' };
    },
    readFingerprint(pid) {
      return `darwin-ps:${pid}`;
    },
    async observeProcess(pid) {
      return pid === activePid
        ? {
            status: 'ok',
            line: `${pid} ssh HAPPIER_STACK_PROCESS_KIND=execution-host-service-tunnel HAPPIER_STACK_EXECUTION_HOST_TUNNEL=primary:0.3:repo-dev-1234567890`,
          }
        : { status: 'not_found' };
    },
    async terminate(pid, options) {
      terminated.push({ pid, options });
      if (pid === activePid) activePid = null;
      return { ok: true, signal: 'SIGTERM' };
    },
  };
  const input = {
    profile: profile(fixture.path('lima')),
    workspaceId: '0.3',
    stackName: 'repo-dev-1234567890',
    executor,
    env,
  };
  await ensureExecutionHostServiceTunnel({
    ...input,
    boundary: { ...sharedBoundary, delay: async () => {} },
  });

  projection = runtimeProjection({ backendPort: 52755 });
  const replacement = ensureExecutionHostServiceTunnel({
    ...input,
    boundary: {
      ...sharedBoundary,
      async delay() {
        await replacementListenersReleased;
      },
    },
  });
  const phase = await waitForTunnelState(statePath, (state) => {
    if (state?.transition === 'replacing') return 'replacing';
    return state == null ? 'absent' : '';
  });
  assert.equal(phase, 'replacing', 'a replacement must retain a visible owner record while the new child binds');

  const controller = new AbortController();
  let monitorDelays = 0;
  const supervision = superviseExecutionHostServiceTunnel({
    ...input,
    boundary: {
      ...sharedBoundary,
      async delay() {
        monitorDelays += 1;
        if (monitorDelays === 1) {
          controller.abort();
        }
      },
    },
    signal: controller.signal,
  });

  // The supervisor started while the replacement owns the state lock. Finish
  // that canonical operation independently so its initial reconcile can
  // re-read the successor rather than start a competing transport.
  replacementListenersReady = true;
  releaseReplacementListeners();
  await replacement;
  const result = await supervision;

  assert.equal(result.status, 'cancelled');
  assert.deepEqual(spawned.map(({ child }) => child.pid), [731, 732]);
  assert.equal(terminated.length, 1);
});

test('service tunnel supervision treats an explicit stop as terminal for its current lifetime', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-service-tunnel-supervision-stop-' });
  const env = { HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  const controller = new AbortController();
  let activePid = null;
  let delays = 0;
  const boundary = tunnelBoundary({
    listenerPids: () => activePid == null ? [] : [activePid],
  });
  boundary.terminate = async (pid, options) => {
    boundary.terminated.push({ pid, options });
    if (pid === activePid) activePid = null;
    return { ok: true, signal: 'SIGTERM' };
  };
  boundary.observeProcess = async (pid) => (
    pid === activePid
      ? {
          status: 'ok',
          line: `${pid} ssh HAPPIER_STACK_PROCESS_KIND=execution-host-service-tunnel HAPPIER_STACK_EXECUTION_HOST_TUNNEL=primary:0.3:repo-dev-1234567890`,
        }
      : { status: 'not_found' }
  );
  boundary.spawn = (command, args, options) => {
    const child = { pid: 731, unref() {} };
    activePid = child.pid;
    boundary.spawned.push({ command, args, options, child });
    return child;
  };
  const input = {
    profile: profile(fixture.path('lima')),
    workspaceId: '0.3',
    stackName: 'repo-dev-1234567890',
    executor: runtimeExecutor(runtimeProjection()),
    env,
    boundary,
  };
  boundary.delay = async () => {
    delays += 1;
    if (delays === 1) {
      const stopped = await stopExecutionHostServiceTunnel(input);
      assert.equal(stopped.changed, true);
      return;
    }
    controller.abort();
  };

  const result = await superviseExecutionHostServiceTunnel({ ...input, signal: controller.signal });

  assert.equal(result.status, 'stopped');
  assert.equal(boundary.spawned.length, 1, 'an explicit stop must not be recreated by supervision');
  assert.equal(boundary.terminated.length, 1);
  assert.equal(boundary.terminated[0].pid, 731);
  const stoppedState = JSON.parse(await readFile(`${fixture.path('home')}/execution-host-tunnels/primary-0.3.json`, 'utf8'));
  assert.equal(stoppedState.transition, 'stopping');
});

test('a queued explicit stop observes a failed replacement as already stopped', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-service-tunnel-replacement-stop-' });
  const env = { HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  const spawned = [];
  const terminated = [];
  let activePid = null;
  let projection = runtimeProjection();
  let replacement = false;
  let queuedStop = null;
  let input;
  const boundary = {
    spawn(command, args, options) {
      const child = { pid: 731, unref() {} };
      activePid = child.pid;
      spawned.push({ command, args, options, child });
      return child;
    },
    async listListeners() {
      if (activePid != null) return { status: 'ok', supported: true, pids: [activePid] };
      if (!replacement) return { status: 'ok', supported: true, pids: [] };
      return { status: 'ok', supported: true, pids: [999] };
    },
    async probePortBinding() {
      if (!replacement) return { status: 'free' };
      queuedStop ??= stopExecutionHostServiceTunnel(input);
      return { status: 'in_use', reason: 'address-in-use' };
    },
    readFingerprint(pid) {
      return `darwin-ps:${pid}`;
    },
    async observeProcess(pid) {
      return pid === activePid
        ? {
            status: 'ok',
            line: `${pid} ssh HAPPIER_STACK_PROCESS_KIND=execution-host-service-tunnel HAPPIER_STACK_EXECUTION_HOST_TUNNEL=primary:0.3:repo-dev-1234567890`,
          }
        : { status: 'not_found' };
    },
    async terminate(pid, options) {
      terminated.push({ pid, options });
      if (pid === activePid) activePid = null;
      return { ok: true, signal: 'SIGTERM' };
    },
    async delay() {},
  };
  input = {
    profile: profile(fixture.path('lima')),
    workspaceId: '0.3',
    stackName: 'repo-dev-1234567890',
    executor: { capture: async () => ({ exitCode: 0, out: projection, err: '' }) },
    env,
    boundary,
  };
  await ensureExecutionHostServiceTunnel(input);

  projection = runtimeProjection({ backendPort: 52755 });
  replacement = true;
  await assert.rejects(
    ensureExecutionHostServiceTunnel(input),
    (error) => error?.code === 'EXECUTION_HOST_SERVICE_TUNNEL_PORT_CONFLICT',
  );

  const stopped = await queuedStop;
  assert.equal(stopped.reason, 'not_found');
  await assert.rejects(
    readFile(`${fixture.path('home')}/execution-host-tunnels/primary-0.3.json`, 'utf8'),
    (error) => error?.code === 'ENOENT',
  );
  assert.equal(spawned.length, 1);
  assert.equal(terminated.length, 1);
});

test('service tunnel serializes a stale reconciliation before a successor can publish its transport', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-service-tunnel-handoff-' });
  const env = { HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  const statePath = `${fixture.path('home')}/execution-host-tunnels/primary-0.3.json`;
  const spawned = [];
  let activePid = null;
  let nextPid = 731;
  let releaseStaleInspection;
  const staleInspectionReleased = new Promise((resolve) => { releaseStaleInspection = resolve; });
  let staleInspectionEntered;
  const staleInspectionStarted = new Promise((resolve) => { staleInspectionEntered = resolve; });
  let successorInspectionEntered = false;
  let successorInspectionStarted;
  const successorInspection = new Promise((resolve) => { successorInspectionStarted = resolve; });

  const makeBoundary = ({ stale = false, successor = false } = {}) => ({
    spawn(command, args, options) {
      const child = { pid: nextPid, unref() {} };
      nextPid += 1;
      activePid = child.pid;
      spawned.push({ command, args, options, child });
      return child;
    },
    async listListeners(_port, { candidatePids } = {}) {
      return {
        status: 'ok',
        supported: true,
        pids: candidatePids?.includes(activePid) ? [activePid] : [],
      };
    },
    async probePortBinding() {
      return activePid == null
        ? { status: 'free' }
        : { status: 'in_use', reason: 'address-in-use' };
    },
    readFingerprint(pid) {
      return `darwin-ps:${pid}`;
    },
    async observeProcess(pid) {
      if (stale && pid === 731) {
        staleInspectionEntered();
        await staleInspectionReleased;
        if (activePid === pid) activePid = null;
        return { status: 'not_found' };
      }
      if (successor && pid === 731) {
        successorInspectionEntered = true;
        successorInspectionStarted();
        if (activePid === pid) activePid = null;
        return { status: 'not_found' };
      }
      return pid === activePid
        ? {
            status: 'ok',
            line: `${pid} ssh HAPPIER_STACK_PROCESS_KIND=execution-host-service-tunnel HAPPIER_STACK_EXECUTION_HOST_TUNNEL=primary:0.3:repo-dev-1234567890`,
          }
        : { status: 'not_found' };
    },
    async terminate(pid) {
      if (pid === activePid) activePid = null;
      return { ok: true, signal: 'SIGTERM' };
    },
    async delay() {},
  });
  const input = {
    profile: profile(fixture.path('lima')),
    workspaceId: '0.3',
    stackName: 'repo-dev-1234567890',
    executor: runtimeExecutor(runtimeProjection()),
    env,
  };
  await ensureExecutionHostServiceTunnel({ ...input, boundary: makeBoundary() });

  const stale = ensureExecutionHostServiceTunnel({ ...input, boundary: makeBoundary({ stale: true }) });
  await staleInspectionStarted;
  const successor = ensureExecutionHostServiceTunnel({ ...input, boundary: makeBoundary({ successor: true }) });
  await Promise.race([
    successorInspection,
    new Promise((resolve) => setTimeout(resolve, 100)),
  ]);
  releaseStaleInspection();
  const outcomes = await Promise.allSettled([stale, successor]);

  assert.equal(successorInspectionEntered, false, 'the successor must wait until the incumbent reconciliation releases its state ownership');
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ['fulfilled', 'fulfilled']);
  assert.deepEqual(spawned.map(({ child }) => child.pid), [731, 732]);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.pid, 732);
});

test('a cancelled reconciliation waiting behind an incumbent cannot replace its successor', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-service-tunnel-cancelled-handoff-' });
  const env = { HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  const spawned = [];
  let activePid = null;
  let nextPid = 731;
  let releaseIncumbentInspection;
  const incumbentInspectionReleased = new Promise((resolve) => { releaseIncumbentInspection = resolve; });
  let incumbentInspectionEntered;
  const incumbentInspectionStarted = new Promise((resolve) => { incumbentInspectionEntered = resolve; });

  const makeBoundary = ({ blockOldPid = false } = {}) => ({
    spawn(command, args, options) {
      const child = { pid: nextPid, unref() {} };
      nextPid += 1;
      activePid = child.pid;
      spawned.push({ command, args, options, child });
      return child;
    },
    async listListeners(_port, { candidatePids } = {}) {
      return {
        status: 'ok',
        supported: true,
        pids: candidatePids?.includes(activePid) ? [activePid] : [],
      };
    },
    async probePortBinding() {
      return activePid == null
        ? { status: 'free' }
        : { status: 'in_use', reason: 'address-in-use' };
    },
    readFingerprint(pid) {
      return `darwin-ps:${pid}`;
    },
    async observeProcess(pid) {
      if (blockOldPid && pid === 731) {
        incumbentInspectionEntered();
        await incumbentInspectionReleased;
        if (activePid === pid) activePid = null;
        return { status: 'not_found' };
      }
      return pid === activePid
        ? {
            status: 'ok',
            line: `${pid} ssh HAPPIER_STACK_PROCESS_KIND=execution-host-service-tunnel HAPPIER_STACK_EXECUTION_HOST_TUNNEL=primary:0.3:repo-dev-1234567890`,
          }
        : { status: 'not_found' };
    },
    async terminate(pid) {
      if (pid === activePid) activePid = null;
      return { ok: true, signal: 'SIGTERM' };
    },
    async delay() {},
  });
  const base = {
    profile: profile(fixture.path('lima')),
    workspaceId: '0.3',
    stackName: 'repo-dev-1234567890',
    env,
  };
  await ensureExecutionHostServiceTunnel({
    ...base,
    executor: runtimeExecutor(runtimeProjection()),
    boundary: makeBoundary(),
  });

  const incumbent = ensureExecutionHostServiceTunnel({
    ...base,
    executor: runtimeExecutor(runtimeProjection({ backendPort: 52755 })),
    boundary: makeBoundary({ blockOldPid: true }),
  });
  await incumbentInspectionStarted;

  const controller = new AbortController();
  const cancelledExecutor = runtimeExecutor(runtimeProjection({ backendPort: 52756 }));
  const cancelled = ensureExecutionHostServiceTunnel({
    ...base,
    executor: cancelledExecutor,
    boundary: makeBoundary(),
    signal: controller.signal,
  });
  controller.abort();
  releaseIncumbentInspection();

  const [replaced, cancelledResult] = await Promise.all([incumbent, cancelled]);

  assert.equal(replaced.status, 'running');
  assert.equal(cancelledResult.status, 'cancelled');
  assert.equal(cancelledExecutor.calls.length, 0, 'a cancelled waiter must not read or act on the successor plan');
  assert.deepEqual(spawned.map(({ child }) => child.pid), [731, 732]);
  const state = JSON.parse(await readFile(`${fixture.path('home')}/execution-host-tunnels/primary-0.3.json`, 'utf8'));
  assert.equal(state.pid, 732);
  assert.equal(state.forwards[0].targetPort, 52755);
});

test('service tunnel fails closed on a foreign listener and never terminates it', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-service-tunnel-conflict-' });
  const boundary = tunnelBoundary({ listenerPids: new Map([[52753, [999]], [18829, []]]) });
  boundary.probePortBinding = async (port) => (
    port === 52753
      ? { status: 'in_use', reason: 'address-in-use' }
      : { status: 'free' }
  );
  await assert.rejects(
    ensureExecutionHostServiceTunnel({
      profile: profile(fixture.path('lima')),
      workspaceId: '0.3',
      executor: runtimeExecutor(runtimeProjection()),
      env: { HAPPIER_STACK_HOME_DIR: fixture.path('home') },
      boundary,
    }),
    (error) => error?.code === 'EXECUTION_HOST_SERVICE_TUNNEL_PORT_CONFLICT' && error?.port === 52753,
  );
  assert.equal(boundary.spawned.length, 0);
  assert.equal(boundary.terminated.length, 0);
});

test('service tunnel refuses to stop when its saved PID has a different process incarnation', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-service-tunnel-successor-' });
  const env = { HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  const listeners = (port, spawned) => spawned.length > 0 && (port === 52753 || port === 18829)
    ? [731]
    : [];
  const setup = tunnelBoundary({ listenerPids: listeners });
  const input = {
    profile: profile(fixture.path('lima')),
    workspaceId: '0.3',
    executor: runtimeExecutor(runtimeProjection()),
    env,
    boundary: setup,
  };
  await ensureExecutionHostServiceTunnel(input);

  const replacement = tunnelBoundary({ listenerPids: listeners, fingerprint: 'darwin-ps:replacement' });
  const stopped = await stopExecutionHostServiceTunnel({ ...input, boundary: replacement });

  assert.equal(stopped.changed, false);
  assert.equal(stopped.reason, 'process_instance_changed');
  assert.equal(replacement.terminated.length, 0);
});

test('service tunnel replaces only its PID-verified SSH child when a Stack runtime declares a changed backend', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-service-tunnel-reconcile-' });
  const env = { HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  let backendPort = 52754;
  const executor = {
    async capture() {
      return { exitCode: 0, out: runtimeProjection({ backendPort }), err: '' };
    },
  };
  const boundary = tunnelBoundary({
    listenerPids: (port, spawned) => spawned.length > boundary.terminated.length && (port === 52753 || port === 18829)
      ? [731]
      : [],
  });
  const input = {
    profile: profile(fixture.path('lima')),
    workspaceId: '0.3',
    executor,
    env,
    boundary,
  };

  await ensureExecutionHostServiceTunnel(input);
  backendPort = 52755;
  const reconciled = await ensureExecutionHostServiceTunnel(input);

  assert.equal(reconciled.changed, true);
  assert.equal(boundary.spawned.length, 2);
  assert.equal(boundary.terminated.length, 1);
  assert.equal(boundary.terminated[0].pid, 731);
});
