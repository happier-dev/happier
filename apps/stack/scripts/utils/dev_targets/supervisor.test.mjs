import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  planRequiresRemoteCliWorkspacePreparation,
  prepareStackDevTargetSourceReload,
  resolvePreservedDaemonTargetPlans,
  resolveDefaultRemoteServerPort,
  resolveDefaultRemoteExpoPort,
  resolveRemoteServerReadyTimeoutMs,
  startStackDevTargets as startStackDevTargetsImpl,
  startStackDevTargetsInBackground,
} from './supervisor.mjs';
import { spawnProc } from '../proc/proc.mjs';
import { resolveDevTargetMutagenRuntime } from './mutagen_runtime.mjs';
import { prepareDevTargetOpenSsh, runDevTargetControlProcess } from './sync_project.mjs';
import { renderMutagenProject, resolveMutagenSessionName } from './mutagen_project.mjs';
import { resolveRemoteStackStatePaths } from './remote_commands.mjs';
import { writeManagedRuntimeSnapshotLayout } from '../../testkit/core/runtime_snapshot_layout.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { beginPendingSourceStart } from '../../runtime/shared/pending_source_start.mjs';
import * as pendingSourceStart from '../../runtime/shared/pending_source_start.mjs';
import { inspectDevTargetSync, runDevTargetDependencyBootstrap } from './executor.mjs';
import { readStackRuntimeStateFile, recordStackRuntimeStart, recordStackRuntimeUpdate } from '../stack/runtime_state.mjs';
import { decideDevStartupTopology, observeDevServerStartupTopology } from '../dev/devStartupTopology.mjs';
import { waitForBackgroundStackReadiness } from '../../stack/run_script_with_stack_env.mjs';

const successfulDependencyBootstrap = async () => ({ code: 0 });
const repoDir = fileURLToPath(new URL('../../../../../', import.meta.url));

test('superseded source worker terminates its controller without retries or retiring its successor', { timeout: 10_000 }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-superseded-controller-' });
  const target = { name: 'linux', platform: 'posix', ssh: 'linux-ssh', repoDir: '/remote/repo', cliHomeDir: '/remote/cli' };
  const successor = await beginPendingSourceStart({ stackBaseDir: join(root, 'native') });
  t.after(() => successor.dispose());
  const states = [];
  const commands = [];
  const children = [];
  let retries = 0;
  const controller = await startStackDevTargets({
    stackName: 'fixture-superseded', stackBaseDir: root, sourceDir: repoDir, localServerPort: 3005,
    publicServerUrl: 'http://127.0.0.1:3005',
    sourceSnapshot: true, credentialPath: join(root, 'credential'),
    remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
    targetPlans: [{ target, services: { server: true, daemon: false, expo: false } }],
    onTargetStateChange: state => states.push(state), env: {},
  }, {
    runProcess: async input => { commands.push(input); return { code: 0 }; },
    runCommand: async () => ({ code: 0, out: JSON.stringify({ retainedRemoteData: true }) }),
    spawnProcess: input => {
      let finish;
      const child = { ...input, exitCode: null, completion: new Promise(resolve => { finish = resolve; }), finish: value => finish(value) };
      children.push(child);
      return child;
    },
    stopProcess: async child => { if (child) { child.exitCode = 0; child.finish({ code: 0 }); } },
    waitForProcess: child => child.completion,
    waitForServerReady: async () => new Promise(() => {}),
    waitForRetry: async () => { retries++; await new Promise(() => {}); },
    logger: { error() {} },
  });
  try {
    assert.ok(controller.superseded instanceof Promise, 'a terminal source supersession must reach the runner lifetime owner');
    const worker = controller.workers[0];
    // Produce the terminal signal from the real pending-start authority, not copied log prose.
    let superseded;
    try { await beginPendingSourceStart({ stackBaseDir: join(root, 'native'), requestId: 'older-request' }); }
    catch (error) { superseded = error; }
    pendingSourceStart.emitSourceStartSuperseded(superseded, line => worker.onLine({ stream: 'stdout', line: line.trimEnd() }));
    const before = { commands: commands.length, states: states.length };
    worker.exitCode = 1;
    worker.finish({ code: 1 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(retries, 0, 'supersession is terminal rather than a source-crash retry');
    assert.equal(controller.isSuperseded, true);
    await controller.superseded;
    await controller.close();
    assert.equal(commands.length, before.commands, 'closing the older controller cannot stop/probe the newer runtime');
    assert.equal(states.length, before.states, 'the older controller cannot publish into successor state');
    assert.ok(children.every(child => child.exitCode != null), 'its own workers and forwards must exit');
    await successor.publish(async () => {});
  } finally { await controller.close(); }
});

for (const failure of ['sync', 'flush', 'directory', 'bootstrap']) {
test(`transient remote ${failure} failure uses target recovery without aborting the local Stack`, { timeout: 10_000 }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-transient-start-' });
  const target = { name: 'linux', platform: 'posix', ssh: 'linux-ssh', repoDir: '/remote/repo', cliHomeDir: '/remote/cli' };
  const states = [];
  const children = [];
  const delays = [];
  let failures = 0;
  let releaseRetry;
  const retryGate = new Promise(resolve => { releaseRetry = resolve; });
  let observeRunning;
  const running = new Promise(resolve => { observeRunning = resolve; });
  const unavailable = () => ++failures <= (failure === 'sync' ? 3 : 2);
  const controller = await startStackDevTargets({
    stackName: 'agent-qa', stackBaseDir: root, sourceDir: repoDir, localServerPort: 3005,
    sourceSnapshot: failure !== 'bootstrap', credentialPath: join(root, 'credential'),
    targetPlans: [{ target, services: { server: false, expo: false, daemon: true } }],
    onTargetStateChange: state => { states.push(state); if (state.status === 'running') observeRunning(); }, env: {},
  }, {
    // Mutagen/SSH are process boundaries; sync parsing and dependency bootstrap stay real.
    runProcess: async ({ command, args }) => {
      if (command === 'mutagen' && args[0] === 'sync' && args[1] === 'list'
        && failure === 'sync' && unavailable()) return { code: 1, err: 'beta scan EOF' };
      if (command === 'mutagen' && args[1] === 'flush' && failure === 'flush' && unavailable()) {
        return { code: 1, err: 'session is not currently able to synchronize' };
      }
      if (command === 'ssh' && failure === 'directory' && String(args.at(-1)).includes('mkdir -p') && unavailable()) {
        return { code: 255, err: 'connection timed out' };
      }
      if (command === 'ssh' && String(args.at(-1)).includes('sourceRuntimeIdentities')) return { code: 0,
        out: JSON.stringify({ sourceRuntimeIdentities: { daemon: { selected: 'current', loaded: 'current' } } }) };
      return { code: 0 };
    },
    inspectSync: options => inspectDevTargetSync(options, { runCaptureResult: async () => ({ ok: !unavailable(),
      out: JSON.stringify([{ name: resolveMutagenSessionName(target.name, repoDir), paused: false, status: 'watching',
        successfulCycles: 1, alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }]) }) }),
    runDependencyBootstrap: options => runDevTargetDependencyBootstrap(options, {
      runCommand: async () => ({ code: failure === 'bootstrap' && unavailable() ? 255 : 0 }),
    }),
    spawnProcess: input => { const child = { ...input, exitCode: null }; children.push(child); return child; },
    stopProcess: async child => { child.exitCode = 0; },
    waitForProcess: async () => new Promise(() => {}),
    waitForDaemonReady: async () => {},
    waitForRetry: async ({ delayMs }) => { delays.push(delayMs); await retryGate; }, logger: { error() {} },
  });
  try {
    assert.equal(controller.workers.length, 0);
    assert.ok(children.every(child => child.exitCode === null), 'a target failure must not close the controller');
    const expectedPhase = failure === 'bootstrap' ? 'bootstrap' : failure === 'directory' ? 'prepare' : 'sync';
    assert.ok(states.some(state => state.status === 'retrying' && state.phase === expectedPhase));
    releaseRetry();
    await running;
    assert.equal(controller.workers.length, 1);
    assert.deepEqual(delays, [5_000, 10_000]);
    assert.equal(controller.targetFailures.length, 0);
  } finally { releaseRetry(); await controller.close(); }
});
}

// The sync service owns fixture mirrors before any supervisor consumes them.
// Only the filesystem and external Mutagen process responses are fixture data;
// borrowing, parsing, readiness, retry and cleanup logic remain real.
async function startStackDevTargets(input, dependencies = {}) {
  const syncBase = input.syncStackBaseDir ?? input.stackBaseDir;
  if (!syncBase) return await startStackDevTargetsImpl(input, dependencies);
  const env = { ...input.env, HAPPIER_STACK_STORAGE_DIR: syncBase };
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir: syncBase, sourceDir: input.sourceDir, env });
  const legacyProject = join(syncBase, 'mutagen/mutagen.yml');
  const targets = input.syncTargets ?? input.targetPlans?.map(plan => plan.target) ?? input.targets ?? [];
  if (targets.length) {
    const existing = await readFile(legacyProject, 'utf8').catch(() => null);
    await mkdir(dirname(runtime.projectFile), { recursive: true });
    await writeFile(runtime.projectFile, existing ?? renderMutagenProject({sourceDir: input.sourceDir, targets, ownerId: 'dev-target-sync-service'}));
    await prepareDevTargetOpenSsh({ targets, mutagenDir: runtime.mutagenDir, env });
  }
  const runProcess = dependencies.runProcess;
  return await startStackDevTargetsImpl({ ...input, env }, {
    // Network readiness is an external boundary; unrelated transport tests do
    // not depend on a real server listening at their fixture port.
    waitForServerReady: async () => {},
    ...dependencies,
    ...(runProcess ? { runProcess: async request => {
      const result = await runProcess(request);
      if (request.command === 'mutagen' && request.args[0] === 'sync' && request.args[1] === 'list'
        && result?.code === 0 && !result.out) {
        return { ...result, out: JSON.stringify(targets.map(target => ({ name: resolveMutagenSessionName(target.name, input.sourceDir),
          paused: false, status: 'watching', successfulCycles: 1, alpha: {connected:true, scanned:true}, beta: {connected:true, scanned:true} }))) };
      }
      return result;
    } } : {}),
  });
}

for (const platform of ['posix', 'windows']) {
test(`source daemon tunnel failure waits for the local server and retries without failing startup (${platform})`, { timeout: 10_000 }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-source-tunnel-server-' });
  const target = { name: 'daemon', platform, ssh: 'daemon-ssh',
    repoDir: platform === 'windows' ? 'C:/happier' : '/remote/repo',
    cliHomeDir: platform === 'windows' ? 'C:/home/happier' : '/remote/home' };
  const credentialPath = join(root, 'credential');
  await writeFile(credentialPath, '{}');
  const states = [];
  const tunnels = [];
  const retries = [];
  let probes = 0;
  let releaseServer;
  const serverReady = new Promise(resolve => { releaseServer = resolve; });
  let observeServerWait;
  const waitingForServer = new Promise(resolve => { observeServerWait = resolve; });
  let observeRunning;
  const running = new Promise(resolve => { observeRunning = resolve; });
  const controller = await startStackDevTargets({
    stackName: 'agent-qa', stackBaseDir: root, sourceDir: repoDir,
    sourceSnapshot: true, credentialPath, localServerPort: 3005,
    publicServerUrl: 'http://127.0.0.1:3005',
    targetPlans: [{ target, services: { server: false, daemon: true, expo: false } }],
    onTargetStateChange: state => {
      states.push(state);
      if (state.status === 'running') observeRunning();
    }, env: {},
  }, {
    // SSH/processes and network readiness are the only substituted boundaries.
    runProcess: async ({ command, args }) => {
      const encoded = String(args.at(-1));
      const remote = platform === 'windows'
        ? Buffer.from(encoded.split(' -EncodedCommand ').at(-1), 'base64').toString('utf16le')
        : encoded;
      if (command === 'ssh' && (remote.includes('/dev/tcp/') || remote.includes('TcpClient'))) {
        probes += 1;
        if (probes === 1) tunnels[0].exitCode = 1;
        return { code: probes < 3 ? 1 : 0 };
      }
      if (command === 'ssh' && remote.includes('sourceRuntimeIdentities')) return { code: 0,
        out: JSON.stringify({ sourceRuntimeIdentities: { daemon: { selected: 'daemon-source', loaded: 'daemon-source' } } }) };
      return { code: 0 };
    },
    spawnProcess: input => {
      const child = { ...input, exitCode: null };
      if (input.command === 'ssh' && input.args.includes('-N')) tunnels.push(child);
      return child;
    },
    stopProcess: async child => { child.exitCode = 0; },
    waitForProcess: async () => await new Promise(() => {}),
    waitForRetry: async ({ attempt, delayMs }) => {
      retries.push({ attempt, delayMs });
      await new Promise(setImmediate);
    },
    waitForServerReady: async ({ url }) => {
      assert.equal(url, 'http://127.0.0.1:3005');
      observeServerWait();
      await serverReady;
    },
    waitForDaemonReady: async () => {}, logger: { error() {} },
  });
  try {
    await waitingForServer;
    assert.equal(probes, 1, 'no tunnel recheck while the local server is preparing');
    assert.equal(controller.workers.length, 0);
    assert.ok(states.some(state => state.status === 'retrying' && state.phase === 'tunnel'));
    releaseServer();
    await running;
    assert.equal(probes, 3, 'a subsequent live-tunnel refusal also uses target recovery');
    assert.equal(controller.workers.length, 1);
    assert.equal(tunnels.length, 2, 'replace the exited tunnel, but retain the live tunnel across refusal');
    assert.deepEqual(retries.slice(0, 2), [{ attempt: 1, delayMs: 5_000 }, { attempt: 2, delayMs: 10_000 }]);
  } finally { releaseServer(); await controller.close(); }
});
}

test('closing source daemon recovery cancels local server readiness without dispatching a worker', { timeout: 10_000 }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-source-tunnel-close-' });
  const target = { name: 'daemon', platform: 'posix', ssh: 'daemon-ssh', repoDir: '/remote/repo', cliHomeDir: '/remote/home' };
  const tunnels = [];
  let observeServerWait;
  const waitingForServer = new Promise(resolve => { observeServerWait = resolve; });
  let readinessSignal;
  let probes = 0;
  const controller = await startStackDevTargets({
    stackName: 'agent-qa', stackBaseDir: root, sourceDir: repoDir, sourceSnapshot: true,
    localServerPort: 3005, targetPlans: [{ target, services: { server: false, daemon: true, expo: false } }],
    env: { HAPPIER_STACK_AUTH_FLOW: '1' },
  }, {
    runProcess: async ({ command, args }) => {
      if (command === 'ssh' && String(args.at(-1)).includes('/dev/tcp/')) {
        probes += 1; tunnels[0].exitCode = 1; return { code: 1 };
      }
      return { code: 0 };
    },
    spawnProcess: input => { const child = { ...input, exitCode: null }; if (input.command === 'ssh') tunnels.push(child); return child; },
    stopProcess: async child => { child.exitCode = 0; },
    waitForProcess: async () => await new Promise(() => {}),
    waitForRetry: async () => { await new Promise(setImmediate); },
    waitForServerReady: async ({ signal }) => {
      readinessSignal = signal; observeServerWait();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }, logger: { error() {} },
  });
  await waitingForServer;
  await controller.close();
  assert.equal(readinessSignal.aborted, true);
  assert.equal(probes, 1);
  assert.equal(controller.workers.length, 0);
});

test('source Expo retires its legacy remote Stack before dependency bootstrap and on close', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-source-expo-retire-' });
  const target = { name: 'linux', platform: 'posix', ssh: 'linux-ssh', repoDir: '/remote/repo', cliHomeDir: '/remote/cli' };
  const events = [];
  let legacyAlive = true;
  const controller = await startStackDevTargets({
    stackName: 'repo-test', stackBaseDir: root, sourceDir: repoDir,
    localServerPort: 3005, localExpoPort: 19364,
    targetPlans: [{ target, services: { server: false, expo: true, daemon: false } }], env: {},
  }, {
    // SSH, package installation and network readiness are system boundaries.
    runProcess: async ({ command, args }) => {
      const remote = String(args.at(-1));
      if (command === 'ssh' && remote.includes('stack stop')) {
        events.push('stop'); legacyAlive = false;
      } else if (command === 'ssh' && remote.includes('stack.runtime.json')) {
        return { code: legacyAlive ? 1 : 0 };
      }
      return { code: 0 };
    },
    runDependencyBootstrap: options => runDevTargetDependencyBootstrap(options, {
      runCommand: async () => {
        events.push('bootstrap');
        assert.equal(legacyAlive, false, 'dependency mutation must follow retirement of the legacy reader');
        return { code: 0 };
      },
    }),
    spawnProcess: input => ({ ...input, exitCode: null }),
    stopProcess: async child => { child.exitCode = 0; },
    waitForProcess: async () => await new Promise(() => {}),
    waitForExpoReady: async () => {},
    waitForRetry: async () => await new Promise(() => {}),
    logger: { error() {} },
  });
  try {
    assert.deepEqual(events, ['stop', 'bootstrap']);
    assert.equal(controller.workers.length, 1);
  } finally { await controller.close(); }
  assert.deepEqual(events, ['stop', 'bootstrap', 'stop'], 'source shutdown must invoke the same target-owned Stack cleanup');
});

test('source bootstrap ownership refusal is actionable and does not retry the target', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-source-expo-refusal-' });
  for (const deferred of [false, true]) {
    const states = [];
    let retries = 0;
    const target = { name: 'linux', platform: 'posix', ssh: 'linux-ssh', repoDir: '/remote/repo', cliHomeDir: '/remote/cli' };
    const controller = await startStackDevTargets({
      stackName: 'repo-test', stackBaseDir: root, sourceDir: repoDir, localServerPort: 3005, localExpoPort: 19364,
      publicServerUrl: 'http://127.0.0.1:3005',
      targetPlans: [{ target, services: { server: deferred, expo: true, daemon: deferred } }],
      remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
      onTargetStateChange: state => states.push(state), env: { HAPPIER_STACK_AUTH_FLOW: '1' },
    }, {
      runProcess: async () => ({ code: 0 }),
      runDependencyBootstrap: options => runDevTargetDependencyBootstrap(options, {
        runCommand: async ({ onLine }) => {
          onLine({ stream: 'stderr', line: 'Error: Expo pid=123 has no verified dependency-safe restart owner. Stop its owning Stack on the target once.' });
          onLine({ stream: 'stderr', line: "code: 'HAPPIER_DEPENDENCY_METRO_RESTART_REQUIRED'" });
          return { code: 1 };
        },
      }),
      spawnProcess: input => ({ ...input, exitCode: null }),
      stopProcess: async child => { child.exitCode = 0; },
      waitForProcess: async () => await new Promise(() => {}),
      waitForServerReady: async () => {},
      waitForExpoReady: async () => await new Promise(() => {}),
      waitForRetry: async () => { retries += 1; await new Promise(() => {}); },
      logger: { error() {} },
    });
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(controller.workers.length, deferred ? 1 : 0, 'deferred refusal preserves the already-running server');
      assert.equal(retries, 0, 'unchanged unverified ownership needs operator recovery, not an endless restart request');
      const failure = states.find(state => state.status === 'failed');
      assert.ok(failure);
      assert.match(failure.error, /Stop its owning Stack/);
    } finally { await controller.close(); }
  }
});

const remoteLightSqliteRuntimeConfig = Object.freeze({
  serverComponentName: 'happier-server-light',
  dbProvider: 'sqlite',
  environment: {},
});

test('preserved remote daemon reconnects its original endpoint to a moved local server without replacing native custody', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-preserved-daemon-forward-' });
  const target = { name: 'linux3', platform: 'posix', ssh: 'linux3-ssh', repoDir: '/remote/repo', cliHomeDir: '/remote/home' };
  const children = [];
  const states = [];
  const commands = [];
  const statePath = join(root, 'stack.runtime.json');
  await recordStackRuntimeStart(statePath, { stackName: 'agent-qa', ownerPid: null,
    placement: { daemon: target.name }, remoteTargets: { [target.name]: {
      services: { daemon: true }, status: 'running', serviceStatus: { daemon: 'running' },
    } } });
  const targetPlans = resolvePreservedDaemonTargetPlans({ targetPlans: [], targets: [target],
    runtimeState: await readStackRuntimeStateFile(statePath), daemonRequested: false });
  let running;
  const ready = new Promise(resolve => { running = resolve; });
  const controller = await startStackDevTargets({
    stackName: 'agent-qa', stackBaseDir: root, sourceDir: repoDir, sourceSnapshot: true,
    localServerPort: 41005, credentialPath: join(root, 'credential'),
    targetPlans,
    onTargetStateChange: state => { states.push(state); if (state.status === 'running') running(); }, env: {},
  }, {
    runProcess: async ({ command, args }) => {
      if (command === 'ssh') {
        const remote = String(args.at(-1)); commands.push(remote);
        if (remote.includes('sourceRuntimeIdentities')) return { code: 0, out: JSON.stringify({
          sourceRuntimeIdentities: { daemon: { selected: 'preserved', loaded: 'preserved' } },
          daemonServerUrl: 'http://127.0.0.1:43001',
        }) };
      }
      return { code: 0 };
    },
    spawnProcess: input => { const child = { ...input, pid: 123, exitCode: null }; children.push(child); return child; },
    stopProcess: async child => { child.exitCode = 0; },
    waitForProcess: async () => new Promise(() => {}), waitForDaemonReady: async () => {},
    waitForRetry: async () => new Promise(() => {}), logger: { error() {} },
  });
  try {
    await ready;
    assert.equal(commands.some(command => command.includes('stack stop')), false, 'reconnect cannot retire the preserved daemon or its Sessions');
    assert.equal(controller.workers.length, 0, 'transport adoption must not launch a replacement native runner');
    const forward = children.find(child => child.command === 'ssh' && child.args.includes('-N'));
    assert.ok(forward.args.includes('127.0.0.1:43001:127.0.0.1:41005'), 'the incumbent private URL must reach the new server port');
    assert.deepEqual(states.at(-1).sourceRuntimeIdentities.daemon, { selected: 'preserved', loaded: 'preserved' });
  } finally { await controller.close({ preserveDaemon: true }); }
  assert.equal(commands.some(command => command.includes('stack stop')), false, 'preserving a transport-only adoption releases only the local forward');
});

for (const daemonUsesCanonicalUrl of [true, false]) {
test(`co-located server recovery retains its private port and the preserved daemon route (${daemonUsesCanonicalUrl ? 'canonical' : 'private'})`, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-preserved-daemon-server-forward-' });
  const localServerPort = 3027;
  const instanceId = 42;
  const incumbentServerPort = 43865;
  const target = { name: 'linux3', platform: 'posix', ssh: 'linux3-ssh', repoDir: '/remote/repo', cliHomeDir: '/remote/home' };
  const runtimeState = { remoteTargets: { [target.name]: {
    services: { server: true, daemon: true }, status: 'running', serviceStatus: { server: 'stopped', daemon: 'running' },
  } } };
  const targetPlans = resolvePreservedDaemonTargetPlans({
    targetPlans: [{ target, services: { server: true, expo: false, daemon: false } }],
    targets: [target], runtimeState, daemonRequested: false,
  });
  const children = [];
  const states = [];
  const controller = await startStackDevTargets({
    stackName: 'agent-qa', stackBaseDir: root, sourceDir: repoDir, sourceSnapshot: true,
    localServerPort, canonicalServerUrl: `http://happier-agent-qa.localhost:${localServerPort}`,
    publicServerUrl: `http://happier-agent-qa.localhost:${localServerPort}`,
    credentialPath: join(root, 'credential'), targetPlans, instanceId,
    onTargetStateChange: state => { states.push(state); },
    remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig, env: {},
  }, {
    runProcess: async ({ command, args }) => {
      const remote = String(args.at(-1));
      if (command === 'ssh' && remote.includes('sourceRuntimeIdentities')) return { code: 0, out: JSON.stringify({
        sourceRuntimeIdentities: { daemon: { selected: 'preserved', loaded: 'preserved' } },
        daemonServerUrl: `http://127.0.0.1:${daemonUsesCanonicalUrl ? localServerPort : incumbentServerPort}`,
        serverPort: incumbentServerPort,
      }) };
      return { code: 0 };
    },
    runCommand: async () => ({ code: 0, out: JSON.stringify({ retainedRemoteData: true }) }),
    spawnProcess: input => { const child = { ...input, exitCode: null }; children.push(child); return child; },
    stopProcess: async child => { child.exitCode = 0; },
    waitForProcess: async () => new Promise(() => {}),
    waitForServerReady: async () => new Promise(() => {}),
    waitForDaemonReady: async () => new Promise(() => {}),
  });
  try {
    const expectedPrivatePort = incumbentServerPort;
    const tunnel = children.find(child => child.command === 'ssh' && child.args.includes('-N'));
    const worker = children.find(child => child.command === 'ssh' && child.args.at(-1).includes('stack start'));
    assert.ok(tunnel?.args.includes(`127.0.0.1:${localServerPort}:127.0.0.1:${expectedPrivatePort}`),
      'the supervisor must keep the incumbent server port reachable for the preserved daemon');
    assert.ok(tunnel?.args.includes(`127.0.0.1:${localServerPort}:127.0.0.1:${localServerPort}`),
      'the preserved daemon must retain its descriptor-declared canonical endpoint');
    assert.ok(!tunnel?.args.includes(`127.0.0.1:${incumbentServerPort}:127.0.0.1:${localServerPort}`),
      'a reverse forward must not occupy the port the co-located replacement server needs');
    assert.match(worker?.args.at(-1) ?? '', new RegExp(`HAPPIER_STACK_SERVER_PORT=${expectedPrivatePort}`));
    assert.ok(states.every(state => !Object.hasOwn(state, 'serverPort')),
      'native startup evidence must not become a controller runtime field');

    const observe = serverPort => observeDevServerStartupTopology({
      serverRequested: true, stackMode: true, serverPort,
    }, {
      observeTcpPortAvailabilityImpl: async port => ({ status: port === localServerPort ? 'occupied' : 'free' }),
      observeRuntimePortOwnedByStackDevProxyImpl: async () => false,
      resolveStackOwnedServerListenPidImpl: async () => null,
    });
    const correct = await observe(expectedPrivatePort);
    assert.equal(correct.topology, 'absent', 'the remote start must observe the unoccupied private server port');
    assert.equal(decideDevStartupTopology({ serverRequested: true, serverTopology: correct.topology }).startServer, true);
    const miswired = await observe(localServerPort);
    assert.equal(miswired.topology, 'foreign');
    assert.throws(
      () => decideDevStartupTopology({ serverRequested: true, serverTopology: miswired.topology }),
      error => error?.code === 'ESERVERTOPOLOGYFOREIGN',
      'a genuinely foreign listener remains a fail-closed startup refusal',
    );
  } finally { await controller.close({ preserveDaemon: true }); }
});
}

for (const mode of ['foreground', 'background-ready', 'background-starting']) {
test(`next source start settles retirement and preserve-daemon close retains the native daemon (${mode})`, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-deferred-retirement-start-' });
  const statePath = join(root, 'stack.runtime.json');
  const target = { name: 'linux3', platform: 'posix', ssh: 'linux3-ssh', repoDir: '/remote/repo', cliHomeDir: '/remote/home' };
  await recordStackRuntimeStart(statePath, { stackName: 'agent-qa', ownerPid: null,
    remoteTargets: { linux3: { services: { server: true, daemon: true }, runtimeMode: 'source-snapshot',
      status: 'retirement-pending', serviceStatus: { server: 'retirement-pending', daemon: 'retirement-pending' } } } });
  const credentialPath = join(root, 'credential');
  await writeFile(credentialPath, '{}');
  let nativeAlive = true;
  let retirementConfirmed = false;
  let running;
  const ready = new Promise(resolve => { running = resolve; });
  let releaseStartup;
  const startupReleased = new Promise(resolve => { releaseStartup = resolve; });
  const options = {
    stackName: 'agent-qa', stackBaseDir: root, sourceDir: repoDir, sourceSnapshot: true, credentialPath,
    localServerPort: 3005, publicServerUrl: 'http://127.0.0.1:3005', sourceUi: 'export',
    remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
    targetPlans: [{ target, services: { server: true, daemon: true, expo: false } }],
    onTargetStateChange: async ({ name, ...state }) => {
      await recordStackRuntimeUpdate(statePath, { remoteTargets: { [name]: state } });
      if (state.status === 'running') running();
    }, env: {},
  };
  const dependencies = {
    runProcess: async ({ command, args }) => {
      const remote = String(args.at(-1));
      if (command === 'ssh' && remote.includes('sourceRuntimeIdentities')) return { code: 0,
        out: JSON.stringify({ sourceRuntimeIdentities: { server: { selected: 'server', loaded: 'server' },
          daemon: { selected: 'daemon', loaded: 'daemon' } } }) };
      if (command === 'ssh' && remote.includes('stack stop')) {
        assert.ok(remote.includes('/remote/home/stack-state/agent-qa/cli'), 'retirement uses the retained native scope');
        if (!remote.includes('--preserve-daemon')) nativeAlive = false;
        retirementConfirmed = true;
      } else if (command === 'ssh' && remote.includes('stack.runtime.json')) return { code: nativeAlive ? 1 : 0 };
      return { code: 0 };
    },
    runCommand: async () => ({ code: 0, out: JSON.stringify({ retainedRemoteData: true }) }),
    spawnProcess: input => {
      if (input.command === 'ssh') {
        assert.equal(retirementConfirmed, true, 'no replacement transport can reach the old daemon before retirement');
        nativeAlive = true;
      }
      return { ...input, exitCode: null };
    },
    stopProcess: async child => { child.exitCode = 0; },
    waitForProcess: async () => await new Promise(() => {}),
    waitForServerReady: async () => {}, waitForDaemonReady: async () => {},
    waitForRetry: async () => await new Promise(() => {}), logger: { error() {} },
  };
  const controller = mode !== 'foreground' ? startStackDevTargetsInBackground(options, {
    // Keep both supervisor owners real; only their process/network boundaries
    // are fixtures. Hold completion to exercise close during source startup.
    startStackDevTargetsImpl: async input => {
      const started = await startStackDevTargets(input, dependencies);
      await startupReleased;
      return started;
    },
  }) : await startStackDevTargets(options, dependencies);
  try {
    await ready;
    if (mode === 'background-ready') {
      releaseStartup();
      await controller.ready;
    }
    const state = await readStackRuntimeStateFile(statePath);
    assert.equal(state.remoteTargets.linux3.status, 'running');
    assert.equal(state.remoteTargets.linux3.serviceStatus.daemon, 'running');
    assert.equal(retirementConfirmed, true);
  } finally {
    const closing = controller.close({ preserveDaemon: true });
    releaseStartup();
    await closing;
  }
  assert.equal(nativeAlive, true, 'supervisor shutdown preserves the remote daemon');
  const retained = await readStackRuntimeStateFile(statePath);
  assert.equal(retained.remoteTargets.linux3.serviceStatus.daemon, 'running');
  assert.equal(retained.remoteTargets.linux3.serviceStatus.server, 'stopped');
});
}

for (const runtimeState of ['absent', 'unreadable', 'unreachable']) {
test(`source preparation phase followed by worker death retries only after remote runtime absence is verified (${runtimeState})`, async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-source-launch-retry-' });
  const target = { name: 'linux', platform: 'posix', ssh: 'linux-ssh', repoDir: '/remote/repo', cliHomeDir: '/remote/home' };
  const workers = [];
  const stops = [];
  const states = [];
  let absenceProbes = 0;
  let failLaunch;
  const firstExit = new Promise(resolve => { failLaunch = resolve; });
  let retryOutcome;
  const retried = new Promise(resolve => { retryOutcome = resolve; });
  let retries = 0;
  const controller = await startStackDevTargets({
    stackName: 'agent-qa', stackBaseDir: root, sourceDir: repoDir, sourceSnapshot: true,
    localServerPort: 3005, publicServerUrl: 'http://127.0.0.1:3005', sourceUi: 'export',
    remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
    onTargetStateChange: state => states.push(state),
    targetPlans: [{ target, services: { server: true, daemon: false, expo: false } }], env: {},
  }, {
    // SSH, remote filesystem state and process lifetimes are system boundaries.
    runProcess: async ({ command, args }) => {
      const remote = String(args.at(-1));
      if (command === 'ssh' && remote.includes('sourceRuntimeIdentities')) {
        return { code: runtimeState === 'unreachable' ? 255 : 1, err: 'runtime identity unavailable' };
      }
      if (command === 'ssh' && remote.includes('stack stop')) stops.push(remote);
      else if (command === 'ssh' && remote.includes('stack.runtime.json')) {
        absenceProbes += 1;
        return { code: workers.length === 0 || runtimeState === 'absent' ? 0 : runtimeState === 'unreachable' ? 255 : 1 };
      }
      return { code: 0 };
    },
    runCommand: async () => ({ code: 0, out: JSON.stringify({ retainedRemoteData: true }) }),
    spawnProcess: input => {
      const child = { ...input, exitCode: null };
      if (input.command === 'ssh' && input.args.at(-1).includes('stack start')) {
        workers.push(child);
        if (workers.length === 2) retryOutcome('launched');
      }
      return child;
    },
    stopProcess: async child => { child.exitCode = 0; },
    waitForProcess: async child => child === workers[0] ? firstExit : new Promise(() => {}),
    waitForServerReady: async () => await new Promise(() => {}),
    waitForRetry: async () => {
      if (++retries === 1) return;
      retryOutcome('blocked');
      await new Promise(() => {});
    }, logger: { error() {} },
  });
  try {
    workers[0].onLine({ stream: 'stdout', line: 'HSTACK_SOURCE_PREPARATION_PHASE={"phase":"queued","component":"server"}' });
    assert.ok(states.some(state => state.sourcePreparation?.phase === 'queued'));
    workers[0].exitCode = 1;
    failLaunch({ code: 1 });
    assert.equal(await retried, runtimeState === 'absent' ? 'launched' : 'blocked');
    assert.equal(workers.length, runtimeState === 'absent' ? 2 : 1);
    assert.ok(absenceProbes >= 2, 'a diagnostic phase cannot bypass the retry absence probe');
    assert.equal(states.findLast(state => state.status === 'retrying')?.sourcePreparation, null,
      'worker failure retires preparation diagnostics');
    assert.equal(stops.length, 0, 'retry must not retire a runtime whose absence is unverified');
    if (runtimeState === 'absent') {
      assert.match(workers[1].args.at(-1), /--restart/,
        'a failed launch must prepare current source instead of selecting the last-green bundle again');
      assert.doesNotMatch(workers[1].args.at(-1), /--reuse-source-runtime|--prepared-source-reload/);
    }
  } finally { await controller.close(); }
});
}

for (const preparedSourceReload of [false, true]) {
test(`source worker crash prepares current source instead of retaining its crashed graph (${preparedSourceReload ? 'prepared reload' : 'cached launch'})`, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-source-crash-refresh-' });
  const target = { name: 'linux', platform: 'posix', ssh: 'linux-ssh', repoDir: '/remote/repo', cliHomeDir: '/remote/home' };
  const workers = [];
  const stops = [];
  const states = [];
  const identities = { server: { selected: 'crashed-graph', loaded: 'crashed-graph' } };
  let startedAt = new Date().toISOString();
  let flushes = 0;
  let failWorker;
  const firstExit = new Promise(resolve => { failWorker = resolve; });
  let observeInitial;
  const initialReady = new Promise(resolve => { observeInitial = resolve; });
  let observeRecovery;
  const recovered = new Promise(resolve => { observeRecovery = resolve; });
  const controller = await startStackDevTargets({
    stackName: 'agent-qa', stackBaseDir: root, sourceDir: repoDir, sourceSnapshot: true,
    localServerPort: 3005, publicServerUrl: 'http://127.0.0.1:3005', sourceUi: 'export',
    remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
    targetPlans: [{ target, services: { server: true, daemon: false, expo: false } }],
    onTargetStateChange: state => {
      states.push(state);
      if (state.status === 'running') (workers.length === 1 ? observeInitial : observeRecovery)();
      if (workers.length === 2 && state.status === 'degraded') observeRecovery();
    },
    env: preparedSourceReload ? { HAPPIER_STACK_PREPARED_SOURCE_RELOAD: '1' } : {},
  }, {
    // SSH, process lifetimes and the remote runtime record are system boundaries.
    runProcess: async ({ command, args }) => {
      const remote = String(args.at(-1));
      if (command === 'mutagen' && args[1] === 'flush') flushes += 1;
      if (command === 'ssh' && remote.includes('sourceRuntimeIdentities')) return { code: 0,
        out: JSON.stringify({ startedAt, sourceRuntimeIdentities: identities, sourceUiLaunch: { uiDir: '/remote/crashed-ui' } }) };
      if (command === 'ssh' && remote.includes('stack stop')) stops.push(remote);
      else if (command === 'ssh' && remote.includes('stack.runtime.json')) return { code: workers.length ? 1 : 0 };
      return { code: 0 };
    },
    runCommand: async () => ({ code: 0, out: JSON.stringify({ retainedRemoteData: true }) }),
    spawnProcess: input => {
      const child = { ...input, exitCode: null };
      if (input.command === 'ssh' && input.args.at(-1).includes('stack start')) {
        workers.push(child);
        if (workers.length === 2) {
          // The source restart owner selects a new graph after its preflight.
          identities.server = { selected: 'fixed-graph', loaded: 'fixed-graph' };
          startedAt = new Date(Date.parse(startedAt) + 1).toISOString();
        }
      }
      return child;
    },
    stopProcess: async child => { child.exitCode = 0; },
    waitForProcess: async child => child === workers[0] ? firstExit : new Promise(() => {}),
    waitForServerReady: async () => {},
    waitForRetry: async () => await new Promise(setImmediate), logger: { error() {} },
  });
  try {
    await initialReady;
    const initialFlushes = flushes;
    workers[0].exitCode = 1;
    failWorker({ code: 1 });
    await recovered;
    const replacement = workers[1].args.at(-1);
    assert.match(replacement, /--restart/);
    assert.doesNotMatch(replacement, /--reuse-source-runtime|--prepared-source-reload|\/remote\/crashed-ui/,
      'worker failure must enter the canonical current-source preparation owner');
    assert.equal(flushes, initialFlushes + 1, 'current source reaches the mirror before replacement preparation');
    assert.equal(stops.length, 0, 'the restart preflight owns retirement after checking replacement source');
    assert.equal(states.at(-1).status, 'running', states.at(-1).error);
    assert.deepEqual(states.at(-1).sourceRuntimeIdentities.server, identities.server,
      'readiness must accept the newly prepared successor identity');
  } finally { await controller.close(); }
});
}

test('source refresh waits for the successor runtime incarnation while incumbent health remains available', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-source-refresh-owner-' });
  const target = { name: 'linux', platform: 'posix', ssh: 'linux-ssh', repoDir: '/remote/repo', cliHomeDir: join(root, 'home') };
  const paths = resolveRemoteStackStatePaths(target, { stackName: 'agent-qa', runtimeMode: 'source-snapshot' });
  const statePath = join(paths.stackBaseDir, 'stack.runtime.json');
  await mkdir(paths.stackBaseDir, { recursive: true });
  const identities = { server: { selected: 'unchanged-graph', loaded: 'unchanged-graph' } };
  const writeRuntime = () => recordStackRuntimeStart(statePath, {
    stackName: 'agent-qa', script: 'run.mjs', ephemeral: true, ownerPid: process.pid,
    processes: {}, sourceRuntimeIdentities: identities, sourceUi: 'disabled',
  });
  const incumbent = await writeRuntime();
  const workers = [];
  const states = [];
  let failWorker;
  const firstExit = new Promise(resolve => { failWorker = resolve; });
  let initiallyReady;
  const initial = new Promise(resolve => { initiallyReady = resolve; });
  let observeIncumbent;
  const incumbentObserved = new Promise(resolve => { observeIncumbent = resolve; });
  let releaseReadiness;
  const replacementReady = new Promise(resolve => { releaseReadiness = resolve; });
  let observeRecovery;
  const recovered = new Promise(resolve => { observeRecovery = resolve; });
  let successorPublished = false;
  let observeSuccessor;
  const successorObserved = new Promise(resolve => { observeSuccessor = resolve; });
  const execFileAsync = promisify(execFile);
  const controller = await startStackDevTargets({
    stackName: 'agent-qa', stackBaseDir: root, sourceDir: repoDir, sourceSnapshot: true,
    localServerPort: 3005, publicServerUrl: 'http://127.0.0.1:3005', sourceUi: 'disabled',
    remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
    targetPlans: [{ target, services: { server: true, daemon: false, expo: false } }], env: {},
    onTargetStateChange: state => {
      states.push(state);
      if (state.status === 'running') (workers.length === 1 ? initiallyReady : observeRecovery)();
    },
  }, {
    // Execute the real generated identity probe against the remote-state fixture.
    // SSH transport, remote state, process lifetime and HTTP health are boundaries.
    runProcess: async ({ command, args }) => {
      const remote = String(args.at(-1));
      if (command === 'ssh' && remote.includes('sourceRuntimeIdentities')) {
        let result;
        try { result = { code: 0, out: (await execFileAsync('/bin/bash', ['-c', remote])).stdout }; }
        catch (error) { result = { code: error.code, err: error.stderr }; }
        if (workers.length === 2) observeIncumbent();
        if (successorPublished) observeSuccessor();
        return result;
      }
      return { code: 0 };
    },
    runCommand: async () => ({ code: 0, out: JSON.stringify({ retainedRemoteData: true }) }),
    spawnProcess: input => {
      const child = { ...input, exitCode: null };
      if (input.command === 'ssh' && input.args.at(-1).includes('stack start')) workers.push(child);
      return child;
    },
    stopProcess: async child => { child.exitCode = 0; },
    waitForProcess: async child => child === workers[0] ? firstExit : new Promise(() => {}),
    waitForServerReady: async () => {}, // The incumbent's /health remains green during preflight.
    waitForRetry: async ({ attempt }) => { if (attempt === 1 && workers.length === 1) return; await replacementReady; },
    logger: { error() {} },
  });
  try {
    await initial;
    workers[0].exitCode = 1;
    failWorker({ code: 1 });
    await incumbentObserved;
    await new Promise(setImmediate);
    assert.notEqual(states.at(-1).status, 'running', 'incumbent health cannot confirm the replacement worker');
    const successor = await writeRuntime();
    assert.equal(successor.ownerPid, incumbent.ownerPid, 'OS PID reuse does not define a runtime incarnation');
    assert.notEqual(successor.startedAt, incumbent.startedAt, 'the canonical start owner advances its incarnation');
    successorPublished = true;
    releaseReadiness();
    await Promise.race([recovered, successorObserved.then(() => new Promise(setImmediate))]);
    assert.equal(states.at(-1).status, 'running', 'a canonical same-PID successor must become ready');
    assert.deepEqual(states.at(-1).sourceRuntimeIdentities, identities,
      'the same immutable graph is ready when a successor runtime owns it');
    assert.equal('ownerPid' in states.at(-1), false, 'execution-owner evidence stays internal to the probe');
    assert.equal('startedAt' in states.at(-1), false, 'incarnation evidence stays internal to the probe');
  } finally { releaseReadiness(); await controller.close(); }
});

for (const [readinessObserved, daemonReloaded] of [[true, false], [false, false], [true, true]]) {
test(`source recovery preserves daemon custody and reuses selected server, daemon and UI after transport loss (${daemonReloaded ? 'explicit daemon reload' : readinessObserved ? 'readiness observed' : 'before readiness observation'})`, async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-source-reconnect-' });
  const target = { name: 'linux', platform: 'posix', ssh: 'linux-ssh', repoDir: '/remote/repo', cliHomeDir: '/remote/home' };
  const workers = [];
  const stops = [];
  let remoteAlive = false;
  let drop;
  let recovered;
  const firstExit = new Promise(resolve => { drop = resolve; });
  const recovery = new Promise(resolve => { recovered = resolve; });
  let ready;
  const running = new Promise(resolve => { ready = resolve; });
  let observeRecoveredState;
  const recoveredState = new Promise(resolve => { observeRecoveredState = resolve; });
  const identities = { server: { selected: 'server-frozen', loaded: 'server-frozen' }, daemon: { selected: 'daemon-frozen', loaded: 'daemon-frozen' } };
  const uiDir = '/remote/frozen web/ui';
  const credentialPath = join(root, 'credential');
  await writeFile(credentialPath, '{}');
  const controller = await startStackDevTargets({
    stackName: 'agent-qa', stackBaseDir: root, sourceDir: repoDir, sourceSnapshot: true, credentialPath,
    localServerPort: 3005, publicServerUrl: 'http://127.0.0.1:3005', sourceUi: 'export',
    remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
    targetPlans: [{ target, services: { server: true, daemon: true, expo: false } }],
    onTargetStateChange: state => {
      if (state.status === 'running') ready();
      if (workers.length === 2 && ['running', 'degraded'].includes(state.status)) observeRecoveredState(state);
    }, env: {},
  }, {
    // SSH/network/process lifetimes are genuine system boundaries.
    runProcess: async ({ command, args }) => {
      const remote = String(args.at(-1));
      if (command === 'ssh' && remote.includes('sourceRuntimeIdentities')) return { code: 0, out: JSON.stringify({sourceRuntimeIdentities: identities, sourceUi: 'export', sourceUiLaunch: {uiDir}}) };
      if (command === 'ssh' && remote.includes('stack stop')) { stops.push(remote); remoteAlive = false; }
      else if (command === 'ssh' && remote.includes('stack.runtime.json')) return {code: remoteAlive ? 1 : 0};
      return { code: 0 };
    },
    runCommand: async () => ({ code: 0, out: JSON.stringify({retainedRemoteData:true}) }),
    spawnProcess: input => {
      const child = { ...input, exitCode: null };
      if (input.command === 'ssh' && input.args.at(-1).includes('stack start')) {
        workers.push(child);
        remoteAlive = true;
        if (workers.length === 2) recovered();
      }
      return child;
    },
    stopProcess: async child => { child.exitCode = 0; },
    waitForProcess: async child => child === workers[0] ? firstExit : new Promise(() => {}),
    waitForServerReady: async () => {
      if (!readinessObserved && workers.length === 1) await new Promise(() => {});
    }, waitForDaemonReady: async () => {},
    waitForRetry: async () => { await new Promise(setImmediate); }, logger: {error() {}},
  });
  try {
    if (readinessObserved) await running;
    if (daemonReloaded) identities.daemon = { selected: 'daemon-reloaded', loaded: 'daemon-reloaded' };
    const initialStops = stops.length;
    workers[0].exitCode = 255;
    drop({code:255});
    await recovery;
    if (daemonReloaded) {
      const state = await recoveredState;
      assert.equal(state.status, 'running', state.error);
      assert.deepEqual(state.sourceRuntimeIdentities.daemon, identities.daemon);
      assert.deepEqual(state.sourceRuntimeIdentities.server, identities.server);
    }
    assert.equal(stops.length, initialStops, 'SSH loss must not invoke full Stack stop against a surviving daemon');
    assert.doesNotMatch(workers[0].args.at(-1), /--reuse-source-runtime/);
    assert.match(workers[1].args.at(-1), /--reuse-source-runtime/);
    assert.match(workers[1].args.at(-1), /--restart/); // Existing runner replacement preserves daemon custody.
    assert.ok(workers[1].args.at(-1).includes(uiDir), 'server recovery keeps the observed frozen UI export');
  } finally { await controller.close(); }
  assert.ok(stops.length > 0, 'explicit shutdown still retires the remote Stack');
});
}

async function writeProducerSyncProject(stackBaseDir, sourceDir, target) {
  await mkdir(join(stackBaseDir, 'mutagen'), { recursive: true });
  await writeFile(join(stackBaseDir, 'mutagen/mutagen.yml'), renderMutagenProject({ sourceDir, targets: [target], ownerId: 'producer' }));
}

function readySyncResult(target) {
  return { code: 0, out: JSON.stringify([{ name: resolveMutagenSessionName(target.name), paused: false, status: 'watching', conflicts: [], excludedConflicts: 0,
    successfulCycles: 1, alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }]) };
}

test('remote source preparation refusal leaves the observed incumbent process and runtime record intact', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-remote-reload-refusal-' });
  const stackName = 'agent-qa';
  const brokenRepoDir = join(root, 'broken-repo');
  const target = { name: 'nl3', platform: 'posix', ssh: 'boundary-ssh', repoDir: brokenRepoDir,
    cliHomeDir: join(root, 'remote-home') };
  const producerStackBaseDir = join(root, 'producer');
  const env = { ...process.env, HAPPIER_STACK_STORAGE_DIR: join(root, 'storage'),
    HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light', HAPPIER_DB_PROVIDER: 'sqlite' };
  const mutagen = resolveDevTargetMutagenRuntime({ stackBaseDir: producerStackBaseDir, sourceDir: repoDir, env });
  await Promise.all([mkdir(brokenRepoDir, { recursive: true }), mkdir(dirname(mutagen.projectFile), { recursive: true })]);
  await writeFile(mutagen.projectFile, renderMutagenProject({ sourceDir: repoDir, targets: [target], ownerId: 'producer' }));
  const paths = resolveRemoteStackStatePaths(target, { stackName, runtimeMode: 'source-snapshot' });
  await mkdir(paths.stackBaseDir, { recursive: true });
  const incumbent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { incumbent.kill('SIGKILL'); } catch {} });
  await new Promise((resolve, reject) => { incumbent.once('spawn', resolve); incumbent.once('error', reject); });
  const runtimeStatePath = join(paths.stackBaseDir, 'stack.runtime.json');
  const initial = await recordStackRuntimeStart(runtimeStatePath, {
    stackName,
    script: 'run.mjs',
    ephemeral: true,
    ownerPid: incumbent.pid,
    processes: {},
  });
  const controller = new AbortController();
  const workerScript = fileURLToPath(new URL('../../runtime/launch/prepareSourceRuntimeReload.mjs', import.meta.url));
  await assert.rejects(prepareStackDevTargetSourceReload({
    stackName,
    stackBaseDir: join(root, 'consumer'),
    repoDir,
    placement: {
      authority: { producerStackBaseDir },
      config: { targets: [target] },
      targetPlans: [{ target, services: { server: false, daemon: true, expo: false } }],
    },
    args: ['--no-server', '--server-url=http://fixture.invalid', '--no-ui'],
    env,
    signal: controller.signal,
    serverRequested: false,
    sourceStartRequestId: 'remote-refusal',
  }, {
    runProcess: async () => readySyncResult(target),
    executorDependencies: {
      runCaptureResult: async () => ({ ok: true, out: readySyncResult(target).out, err: '', exitCode: 0 }),
      spawnProcess: input => spawnProc(input.label, process.execPath, [workerScript, '--worker', JSON.stringify({
        stackName,
        stackBaseDir: paths.stackBaseDir,
        repoDir: brokenRepoDir,
        args: ['--no-server', '--server-url=http://fixture.invalid', '--no-ui'],
        sourceStartRequestId: 'remote-refusal',
      })], input.env, { onLine: input.onLine, stdio: ['pipe', 'pipe', 'pipe'], ownedProcessGroup: true, silent: true }),
    },
  }), /preparation exited before readiness/);
  assert.doesNotThrow(() => process.kill(incumbent.pid, 0));
  const retained = await readStackRuntimeStateFile(runtimeStatePath);
  assert.equal(retained?.ownerPid, initial.ownerPid);
  assert.equal(retained?.startedAt, initial.startedAt);
});

test('remote source reload preparation forwards source maps to the actual UI builder without unrelated secrets', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-export-map-forward-' });
  const target = { name: 'nl3', platform: 'posix', ssh: 'boundary-ssh', repoDir: '/remote/repo', cliHomeDir: join(root, 'remote') };
  const producerStackBaseDir = join(root, 'producer');
  const env = { ...process.env, HAPPIER_STACK_STORAGE_DIR: join(root, 'storage'), HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light', HAPPIER_DB_PROVIDER: 'sqlite', HAPPIER_UI_EXPORT_SOURCE_MAPS: '1', UNRELATED_SECRET: 'not-a-forwarded-setting' };
  const mutagen = resolveDevTargetMutagenRuntime({ stackBaseDir: producerStackBaseDir, sourceDir: repoDir, env });
  await mkdir(dirname(mutagen.projectFile), { recursive: true });
  await writeFile(mutagen.projectFile, renderMutagenProject({ sourceDir: repoDir, targets: [target], ownerId: 'producer' }));
  let remoteCommand;
  const prepared = await prepareStackDevTargetSourceReload({ stackName: 'agent-qa', stackBaseDir: join(root, 'consumer'), repoDir,
    placement: { authority: { producerStackBaseDir }, config: { targets: [target] }, targetPlans: [{ target, services: { server: true, daemon: false, expo: false } }] },
    args: ['--ui=export', '--no-daemon'], env, signal: new AbortController().signal, serverRequested: true, sourceStartRequestId: 'map-forward',
  }, { runProcess: async () => readySyncResult(target), executorDependencies: {
    runCaptureResult: async () => ({ ok: true, out: readySyncResult(target).out, err: '', exitCode: 0 }),
    // SSH is the external boundary. The worker preserves the real readiness/control exchange.
    spawnProcess: input => {
      remoteCommand = input.args.at(-1);
      return spawnProc(input.label, process.execPath, ['-e', 'console.log("HSTACK_SOURCE_RELOAD_PREPARED"); process.stdin.on("data", () => process.exit(0))'], input.env,
        { onLine: input.onLine, stdio: ['pipe', 'pipe', 'pipe'], ownedProcessGroup: true, silent: true });
    },
  } });
  try {
    assert.ok(remoteCommand.replace(/["']/g, '').includes('HAPPIER_UI_EXPORT_SOURCE_MAPS=1'), 'reload worker dropped source maps before Expo/reuse fingerprinting');
    assert.doesNotMatch(remoteCommand, /UNRELATED_SECRET|not-a-forwarded-setting/);
    await prepared.activate();
  } finally { await prepared.close(); }
});

test('source snapshot supervisor builds on each mirror without native transfer or dependency preparation and projects observed identities', { timeout: 10_000 }, async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-source-snapshot-supervisor-' });
  const targets = ['server', 'daemon'].map(name => ({ name, platform: 'posix', ssh: `${name}-ssh`, repoDir: join(root, name, 'repo'), cliHomeDir: join(root, name, 'home') }));
  const stackName = 'agent-qa';
  const credentialPath = join(root, 'credential');
  await writeFile(credentialPath, '{}');
  const syncStackBaseDir = join(root, 'sync');
  await mkdir(join(syncStackBaseDir, 'mutagen'), { recursive: true });
  await writeFile(join(syncStackBaseDir, 'mutagen/mutagen.yml'), renderMutagenProject({ sourceDir: repoDir, targets, ownerId: 'producer' }));
  for (const target of targets) await mkdir(resolveRemoteStackStatePaths(target, { stackName, runtimeMode: 'controlled' }).stackBaseDir, { recursive: true });
  const states = [];
  let resolveRunning;
  const running = new Promise(resolve => { resolveRunning = resolve; });
  const commands = [];
  const dataChecks = [];
  const authorities = [];
  const spawned = [];
  const observed = Object.fromEntries(targets.map(target => [target.name, { [target.name]: { selected: `${target.name}-source`, loaded: `${target.name}-source` } }]));
  const phaseLogs = [];
  const execFileAsync = promisify(execFile);
  const runtimeStatePath = join(root, 'consumer', 'stack.runtime.json');
  const started = await recordStackRuntimeStart(runtimeStatePath, {
    stackName, ownerPid: process.pid, runtimeMode: 'source-snapshot',
    placement: { daemon: 'daemon' }, sourceRuntimeIdentities: {},
  });
  const controller = await startStackDevTargets({
    stackName, stackBaseDir: join(root, 'consumer'), syncStackBaseDir, sourceDir: repoDir,
    sourceSnapshot: true, credentialPath, localServerPort: 3005, publicServerUrl: 'http://127.0.0.1:3005',
    canonicalServerUrl: 'http://happier-agent-qa.localhost:3005',
    remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
    targetPlans: targets.map(target => ({ target, services: { server: target.name === 'server', daemon: target.name === 'daemon', expo: false } })),
    remoteWorkspacePreparation: async () => { throw new Error('source snapshots must not publish workspace dist'); },
    onServerDataAuthority: async state => { authorities.push(state); },
    onTargetStateChange: async state => {
      await recordStackRuntimeUpdate(runtimeStatePath, {
        remoteTargets: { [state.name]: state },
        ...(state.sourceRuntimeIdentities ? { sourceRuntimeIdentities: state.sourceRuntimeIdentities } : {}),
      });
      states.push(state);
      if (targets.every(target => states.some(state => state.name === target.name && state.status === 'running'))) resolveRunning();
    }, env: { HAPPIER_STACK_AUTH_FLOW: '1', HAPPIER_WEB_LATENCY_TRACE: '1' },
  }, {
    runProcess: async input => {
      commands.push(input);
      const command = String(input.args.at(-1));
      if (input.command === 'ssh' && command.includes('sourceRuntimeIdentities')) {
        const result = await execFileAsync('/bin/bash', ['-c', command]);
        return { code: 0, out: result.stdout };
      }
      return { code: 0, out: JSON.stringify(targets.map(target => JSON.parse(readySyncResult(target).out)[0])) };
    },
    runCommand: async input => { dataChecks.push(input); return { code: 0, out: JSON.stringify({ retainedRemoteData: true }) }; },
    runDependencyBootstrap: async () => { throw new Error('source snapshots must not bootstrap dependencies'); },
    transferFile: async () => { throw new Error('source snapshots must not transfer native archives'); },
    spawnProcess: input => {
      const child = { ...input, pid: process.pid, exitCode: null }; spawned.push(child);
      if (input.command === 'ssh' && input.args.at(-1).includes('stack start')) {
        const target = targets.find(target => input.args.includes(target.ssh));
        for (const phase of ['queued', 'building', 'prepared']) input.onLine?.({ stream: 'stdout',
          line: 'HSTACK_SOURCE_PREPARATION_PHASE=' + JSON.stringify({ phase, component: target.name }) });
        const paths = resolveRemoteStackStatePaths(target, { stackName, runtimeMode: 'controlled' });
        writeFileSync(join(paths.stackBaseDir, 'stack.runtime.json'), JSON.stringify({ sourceRuntimeIdentities: observed[target.name],
          ...(target.name === 'server' ? { sourceUi: 'export', sourceUiLaunch: { uiDir: join(root, 'server-export', 'ui') } } : {}),
        }));
      }
      return child;
    },
    stopProcess: async child => { child.exitCode = 0; },
    waitForProcess: async () => await new Promise(() => {}),
    waitForServerReady: async () => {}, waitForDaemonReady: async () => {},
    waitForRetry: async () => await new Promise(() => {}), logger: { error() {}, info(message) { phaseLogs.push(message); } },
  });
  try {
    assert.equal(controller.workers.length, 2);
    await running;
    await waitForBackgroundStackReadiness({
      stackName, scriptPath: 'run.mjs', runtimeStatePath,
      env: { HAPPIER_STACK_CLI_HOME_DIR: join(root, 'controller-cli') },
      internalServerUrl: 'http://127.0.0.1:3005', timeoutMs: 750,
      sourceDaemonLaunchAttempt: { ownerPid: process.pid, ownerStartedAt: started.startedAt },
      // HTTP is the external boundary; supervisor, projection and readiness stay real.
      waitForServerReadyImpl: async () => {}, isRunnerAlive: () => true,
    });
    assert.equal(dataChecks.length, 1);
    assert.equal(dataChecks[0].target.name, 'server');
    assert.deepEqual(authorities, [{ targetName: 'server' }]);
    const daemonStart = spawned.find(child => child.command === 'ssh' && child.args.includes('daemon-ssh')
      && child.args.at(-1).includes('stack start'));
    assert.match(daemonStart.args.at(-1), /HAPPIER_WEB_LATENCY_TRACE=1/,
      'the controller trace setting must reach the real remote daemon launch');
    for (const target of targets) {
      const running = states.find(state => state.name === target.name && state.status === 'running');
      assert.deepEqual(running?.sourceRuntimeIdentities, observed[target.name]);
      assert.equal(running.runtimeSnapshotId, undefined);
      for (const phase of ['queued', 'building']) assert.ok(states.some(state => state.name === target.name
        && state.phase === phase && state.sourcePreparation?.component === target.name));
      assert.equal(running.sourcePreparation, null, 'readiness retires preparation diagnostics');
      assert.deepEqual(running.sourceUiLaunch, target.name === 'server' ? { uiDir: join(root, 'server-export', 'ui') } : undefined);
      assert.ok(spawned.some(child => child.command === 'ssh' && child.args.includes(target.ssh) && /--runtime=.*source/.test(child.args.at(-1))));
    }
    assert.equal(commands.filter(input => input.command === 'mutagen' && input.args[1] === 'flush').length, 2);
    assert.equal(commands.some(input => String(input.args.at(-1)).includes('runtime_artifact_transfer.mjs')), false);
    const daemonTunnel = spawned.find(child => child.command === 'ssh' && child.args.includes('daemon-ssh') && child.args.includes('-N'));
    assert.ok(daemonTunnel.args.includes('127.0.0.1:3005:127.0.0.1:3005'),
      'the remote daemon must reach the descriptor-declared loopback Home endpoint');
    assert.equal(daemonTunnel.args.filter(arg => /^127\.0\.0\.1:\d+:127\.0\.0\.1:3005$/u.test(arg)).length, 2,
      'canonical Home reachability must retain the distinct private server forward');
    assert.ok(phaseLogs.some(message => /synchronization admission elapsedMs=\d+/.test(message)));
    for (const target of targets) {
      assert.ok(phaseLogs.some(message => message.includes(`${target.name} phase=${target.name}-readiness`)
        && /elapsedMs=\d+ startupElapsedMs=\d+ nextPhase=running/.test(message)));
    }
  } finally { await controller.close(); }
});

test('controlled lifecycle fails closed before a worker starts when retained-data admission fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-controlled-admission-'));
  const target = { name: 'linux', platform: 'posix', ssh: 'linux-ssh', repoDir: '/remote/repo', cliHomeDir: '/remote/cli' };
  const spawned = [];
  let controller;
  try {
    await writeProducerSyncProject(root, repoDir, target);
    await assert.rejects(async () => {
      controller = await startStackDevTargets({
        stackName: 'agent-qa', stackBaseDir: root, sourceDir: repoDir,
        localServerPort: 3005, publicServerUrl: 'http://127.0.0.1:3005',
        runtimeSnapshot: { snapshotId: 'qa', producerStackBaseDir: root },
        runtimeTarget: { platform: process.platform, arch: process.arch },
        remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
        targetPlans: [{ target, services: { server: true, expo: false, daemon: false } }], env: {},
      }, {
        runProcess: async () => readySyncResult(target),
        runCommand: async () => ({ code: 17 }), // SSH is a genuine system boundary.
        spawnProcess: input => { const child = { ...input, exitCode: null }; spawned.push(child); return child; },
        stopProcess: async child => { child.exitCode = 0; },
        waitForRetry: async () => await new Promise(() => {}),
        logger: { error() {} },
      });
    }, /retained server data operation failed/);
    assert.equal(spawned.filter(child => child.command === 'ssh').length, 0);
  } finally {
    await controller?.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const remoteServerPort of [undefined, 3005]) {
test(`controlled co-located supervisor transfers admitted bytes and owns only needed forwards (server port ${remoteServerPort ?? 'default'})`, async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-controlled-lifecycle-' });
  const snapshot = await writeManagedRuntimeSnapshotLayout({ stackDir: join(root, 'producer') });
  const target = { name: 'linux', platform: 'posix', ssh: 'boundary-ssh', repoDir, cliHomeDir: join(root, 'remote'), remoteServerPort };
  const paths = resolveRemoteStackStatePaths(target, { stackName: 'agent-qa', runtimeMode: 'controlled' });
  const syncStackBaseDir = join(root, 'producer-sync');
  await writeProducerSyncProject(syncStackBaseDir, repoDir, target);
  const credentialPath = join(root, 'credential');
  await writeFile(credentialPath, '{}');
  const calls = [];
  const spawned = [];
  const states = [];
  let resolveRunning;
  const running = new Promise(resolve => { resolveRunning = resolve; });
  const authorityPath = join(root, 'server-authority.json');
  const execFileAsync = promisify(execFile);
  const controller = await startStackDevTargets({
    stackName: 'agent-qa', stackBaseDir: join(root, 'consumer'), sourceDir: repoDir,
    syncStackBaseDir,
    localServerPort: 3005, publicServerUrl: 'http://127.0.0.1:3005', canonicalServerUrl: 'http://happier-agent-qa.localhost:3005',
    credentialPath, runtimeSnapshot: snapshot, runtimeTarget: snapshot.manifest.target,
    remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
    targetPlans: [{ target, services: { server: true, expo: false, daemon: true } }],
    onServerDataAuthority: async ({ targetName }) => { await writeFile(authorityPath, JSON.stringify({ targetName })); },
    onTargetStateChange: state => {
      states.push(state);
      if (state.status === 'running') resolveRunning();
    }, env: {},
  }, {
    // SSH/process and network readiness are the only substituted boundaries.
    runProcess: async input => {
      calls.push(input);
      const command = input.args.at(-1);
      if (input.command === 'ssh' && !/stack (?:start|stop)/.test(command)
        && (/runtime_artifact_transfer\.mjs|mkdir -p|s\.runtimeSnapshotId/.test(command))) {
        await execFileAsync('/bin/bash', ['-c', command]);
      }
      return readySyncResult(target);
    },
    runCommand: async () => ({ code: 0, out: JSON.stringify({ retainedRemoteData: false }) }),
    transferFile: async ({ localPath, remotePath }) => { await copyFile(localPath, remotePath); },
    runDependencyBootstrap: async () => { throw new Error('controlled snapshots cannot bootstrap the moving source'); },
    spawnProcess: input => {
      const child = { ...input, pid: process.pid, exitCode: null };
      spawned.push(child);
      if (input.command === 'ssh' && input.args.at(-1).includes('stack start')) {
        assert.equal(JSON.parse(readFileSync(authorityPath, 'utf8')).targetName, target.name);
        writeFileSync(join(paths.stackBaseDir, 'stack.runtime.json'), JSON.stringify({ runtimeSnapshotId: snapshot.snapshotId }));
      }
      return child;
    },
    stopProcess: async child => { child.exitCode = 0; },
    waitForProcess: async () => await new Promise(() => {}),
    waitForServerReady: async () => {}, waitForDaemonReady: async () => {},
  });
  try {
    await running;
    assert.equal(states.find(state => state.status === 'running')?.forwardPid, process.pid);
    assert.ok(states.some(state => state.status === 'running' && state.runtimeSnapshotId === snapshot.snapshotId));
    const pointer = JSON.parse(await readFile(join(paths.stackBaseDir, 'runtime/current.json'), 'utf8'));
    assert.equal(pointer.snapshotId, snapshot.snapshotId);
    assert.equal(await readFile(join(pointer.snapshotPath, 'cli/happier'), 'utf8'), 'daemon\n');
    const tunnel = spawned.find(child => child.command === 'ssh' && child.args.includes('-N'));
    assert.ok(tunnel.args.includes('-L'), 'the controller still reaches the co-located server');
    if (remoteServerPort === 3005) {
      assert.equal(tunnel.args.includes('-R'), false,
        'an already-canonical server listener must not collide with a reverse forward');
    } else {
      assert.ok(tunnel.args.includes('-R') && tunnel.args.includes('127.0.0.1:3005:127.0.0.1:3005'),
        'the co-located daemon also reaches its descriptor-declared Home origin');
    }
    const worker = spawned.find(child => child.command === 'ssh' && child.args.at(-1).includes('stack start'));
    assert.ok(worker);
    assert.doesNotMatch(worker.args.at(-1), /--watch|stack dev/);
  } finally { await controller.close(); }
  assert.ok(calls.some(input => input.command === 'ssh' && input.args.at(-1).includes('stack stop')));
  assert.ok(spawned.every(child => child.exitCode === 0));
});
}

test('controlled supervisor imports and verifies each separate server and daemon snapshot', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-controlled-mixed-' });
  const serverSnapshot = await writeManagedRuntimeSnapshotLayout({ stackDir: join(root, 'producer'), snapshotId: 'server-selected' });
  const daemonSnapshot = await writeManagedRuntimeSnapshotLayout({ stackDir: join(root, 'producer'), snapshotId: 'daemon-selected' });
  for (const [snapshot, component] of [[serverSnapshot, 'server'], [daemonSnapshot, 'daemon']]) {
    snapshot.manifest.components = { [component]: snapshot.manifest.components[component] };
    await writeFile(join(snapshot.snapshotPath, 'manifest.json'), JSON.stringify(snapshot.manifest));
  }
  const serverTarget = { name: 'server-host', platform: 'posix', ssh: 'server-ssh', repoDir, cliHomeDir: join(root, 'server-state') };
  const daemonTarget = { name: 'daemon-worker', platform: 'posix', ssh: 'daemon-ssh', repoDir, cliHomeDir: join(root, 'daemon-state') };
  const syncStackBaseDir = join(root, 'producer-sync');
  await mkdir(join(syncStackBaseDir, 'mutagen'), { recursive: true });
  await writeFile(join(syncStackBaseDir, 'mutagen/mutagen.yml'), renderMutagenProject({ sourceDir: repoDir, targets: [serverTarget, daemonTarget], ownerId: 'producer' }));
  const credentialPath = join(root, 'credential');
  await writeFile(credentialPath, '{}');
  const states = [];
  const calls = [];
  const spawned = [];
  const execFileAsync = promisify(execFile);
  let finishRunning;
  const running = new Promise(resolve => { finishRunning = resolve; });
  const controller = await startStackDevTargets({
    stackName: 'agent-qa', stackBaseDir: join(root, 'consumer'), syncStackBaseDir, sourceDir: repoDir,
    localServerPort: 3005, publicServerUrl: 'http://127.0.0.1:3005', credentialPath,
    runtimeSnapshot: serverSnapshot, runtimeTarget: serverSnapshot.manifest.target,
    remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
    targetPlans: [
      { target: serverTarget, services: { server: true, expo: false, daemon: false } },
      { target: daemonTarget, services: { server: false, expo: false, daemon: true }, runtimeSnapshot: daemonSnapshot, runtimeTarget: daemonSnapshot.manifest.target },
    ],
    onTargetStateChange: state => {
      states.push(state);
      if ([serverTarget, daemonTarget].every(target => states.some(value => value.name === target.name && value.status === 'running'))) finishRunning();
    }, env: {},
  }, {
    runProcess: async input => {
      calls.push(input);
      const command = input.args.at(-1);
      if (input.command === 'ssh' && !/stack (?:start|stop)/.test(command)
        && (/runtime_artifact_transfer\.mjs|mkdir -p|s\.runtimeSnapshotId/.test(command))) await execFileAsync('/bin/bash', ['-c', command]);
      return { code: 0, out: JSON.stringify([serverTarget, daemonTarget].map(value => JSON.parse(readySyncResult(value).out)[0])) };
    },
    runCommand: async () => ({ code: 0, out: JSON.stringify({ retainedRemoteData: false }) }),
    transferFile: async ({ localPath, remotePath }) => { await copyFile(localPath, remotePath); },
    runDependencyBootstrap: async () => { throw new Error('controlled snapshots cannot bootstrap source'); },
    spawnProcess: input => {
      const child = { ...input, exitCode: null }; spawned.push(child);
      if (input.command === 'ssh' && input.args.at(-1).includes('stack start')) {
        const daemon = input.args.includes(daemonTarget.ssh);
        const paths = resolveRemoteStackStatePaths(daemon ? daemonTarget : serverTarget, { stackName: 'agent-qa', runtimeMode: 'controlled' });
        writeFileSync(join(paths.stackBaseDir, 'stack.runtime.json'), JSON.stringify({ runtimeSnapshotId: (daemon ? daemonSnapshot : serverSnapshot).snapshotId }));
      }
      return child;
    },
    stopProcess: async child => { child.exitCode = 0; }, waitForProcess: async () => await new Promise(() => {}),
    waitForServerReady: async () => {}, waitForDaemonReady: async () => {},
  });
  try {
    await running;
    for (const [target, snapshot, component] of [[serverTarget, serverSnapshot, 'server'], [daemonTarget, daemonSnapshot, 'daemon']]) {
      assert.ok(states.some(state => state.name === target.name && state.status === 'running' && state.runtimeSnapshotId === snapshot.snapshotId));
      const paths = resolveRemoteStackStatePaths(target, { stackName: 'agent-qa', runtimeMode: 'controlled' });
      assert.equal(JSON.parse(await readFile(join(paths.stackBaseDir, 'runtime/current.json'), 'utf8')).snapshotId, snapshot.snapshotId);
      assert.ok(calls.some(input => input.command === 'ssh' && input.args.includes(target.ssh) && input.args.at(-1).includes(`--required-components=${component}`)));
      assert.ok(calls.some(input => input.command === 'ssh' && input.args.includes(target.ssh) && input.args.at(-1).includes('s.runtimeSnapshotId') && input.args.at(-1).includes(snapshot.snapshotId)));
    }
    const daemonTunnel = spawned.find(child => child.args?.includes(daemonTarget.ssh) && child.args.includes('-R'));
    assert.ok(daemonTunnel.args.some(arg => arg.endsWith(':127.0.0.1:3005')));
  } finally { await controller.close(); }
});

test('controlled pre-dispatch SSH unavailability is distinguishable from a rejected runtime or data contract', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-controlled-unavailable-' });
  const target = { name: 'linux', platform: 'posix', ssh: 'boundary-ssh', repoDir: '/remote/repo', cliHomeDir: join(root, 'remote') };
  await writeProducerSyncProject(root, repoDir, target);
  let unexpectedController;
  try {
    await assert.rejects(async () => {
      unexpectedController = await startStackDevTargets({ stackName: 'agent-qa', stackBaseDir: root, sourceDir: repoDir,
        localServerPort: 3005, publicServerUrl: 'http://127.0.0.1:3005',
        runtimeSnapshot: { snapshotId: 'qa' }, runtimeTarget: { platform: process.platform, arch: process.arch },
        targetPlans: [{ target, services: { server: true, expo: false, daemon: false } }], env: {},
      }, {
        runProcess: async input => input.command === 'ssh' ? { code: 255 } : readySyncResult(target),
        spawnProcess: input => ({ ...input, exitCode: null }),
        stopProcess: async child => { child.exitCode = 0; }, logger: { error() {} },
      });
    }, error => error.remotePreDispatchUnavailable === true);
    const snapshot = await writeManagedRuntimeSnapshotLayout({ stackDir: join(root, 'producer') });
    let partialArchive;
    const execFileAsync = promisify(execFile);
    await assert.rejects(async () => {
      unexpectedController = await startStackDevTargets({ stackName: 'agent-qa', stackBaseDir: root, sourceDir: repoDir,
        localServerPort: 3005, publicServerUrl: 'http://127.0.0.1:3005', runtimeSnapshot: snapshot, runtimeTarget: snapshot.manifest.target,
        targetPlans: [{ target, services: { server: true, expo: false, daemon: false } }], env: {},
      }, {
        runProcess: async () => readySyncResult(target), runCommand: async ({ commandArgs }) => {
          if (commandArgs?.[2]?.includes('rmSync')) await execFileAsync(process.execPath, commandArgs.slice(1));
          return { code: 0, out: JSON.stringify({ retainedRemoteData: false }) };
        },
        transferFile: async ({ remotePath }) => {
          partialArchive = remotePath;
          await mkdir(dirname(remotePath), { recursive: true });
          await writeFile(remotePath, 'partial upload');
          const error = new Error('SCP disconnected'); Object.assign(error, { name: 'OpenSshExecutionError', code: 'command_failed', status: 255 }); throw error;
        },
        spawnProcess: input => ({ ...input, exitCode: null }), stopProcess: async child => { child.exitCode = 0; }, logger: { error() {} },
      });
    }, error => error.remotePreDispatchUnavailable === true);
    await assert.rejects(stat(partialArchive), { code: 'ENOENT' });
  } finally { await unexpectedController?.close(); }
});

test('only remote daemon placement requires local CLI workspace preparation', () => {
  assert.equal(planRequiresRemoteCliWorkspacePreparation({
    services: { server: false, expo: true, daemon: false },
  }), false);
  assert.equal(planRequiresRemoteCliWorkspacePreparation({
    services: { server: false, expo: false, daemon: true },
  }), true);
});

test('remote daemon startup without an orchestrated auth flow still rejects missing credentials', async () => {
  await assert.rejects(startStackDevTargets({
    credentialPath: null,
    env: {},
    targetPlans: [{ target: { name: 'mac' }, services: { server: true, expo: true, daemon: true } }],
  }), /no daemon credential/);
});

test('remote daemon startup preserves enrollment and adopts controller Account changes', { skip: process.platform === 'win32' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-enrolled-remote-auth-' });
  const target = { name: 'linux', platform: 'posix', ssh: 'fixture-ssh', repoDir: repoDir, cliHomeDir: fixture.path('remote-cli') };
  const paths = resolveRemoteStackStatePaths(target, { stackName: 'agent-qa' });
  const remoteCredential = join(paths.cliHomeDir, 'servers', paths.activeServerId, 'access.key');
  const controllerCredential = fixture.path('controller-access.key');
  const token = (accountId, signature) => `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.${signature}`;
  const enrolled = { token: token('original-account', 'enrolled'), encryption: { publicKey: Buffer.alloc(32, 1).toString('base64'), machineKey: Buffer.alloc(32, 2).toString('base64') } };
  const replacement = { token: token('replacement-account', 'controller') };
  const replacementEnrollment = { token: token('replacement-account', 'remote-enrolled'), encryption: enrolled.encryption };
  await mkdir(dirname(remoteCredential), { recursive: true });
  await writeFile(remoteCredential, JSON.stringify(enrolled), { mode: 0o600 });
  await writeFile(controllerCredential, JSON.stringify({ token: token('original-account', 'older-controller'), secret: Buffer.alloc(32, 3).toString('base64') }));
  for (let start = 0; start < 3; start += 1) {
    if (start === 1) await writeFile(controllerCredential, JSON.stringify(replacement));
    if (start === 2) await writeFile(remoteCredential, JSON.stringify(replacementEnrollment));
    const expected = [enrolled, replacement, replacementEnrollment][start];
    let controller;
    let ready = false;
    let notifyRunning;
    const running = new Promise(resolve => { notifyRunning = resolve; });
    try {
      controller = await startStackDevTargets({
        stackName: 'agent-qa', stackBaseDir: fixture.path('stack'), sourceDir: repoDir,
        localServerPort: 3005, credentialPath: controllerCredential,
        targetPlans: [{ target, commands: true, services: { server: false, expo: false, daemon: true } }], env: {},
        onTargetStateChange: state => { if (state.status === 'running') notifyRunning(); },
      }, {
        runDependencyBootstrap: successfulDependencyBootstrap,
        // Only the transport/process boundary is replaced. The supervisor's
        // actual credential command runs against the real target fixture.
        runProcess: async ({ command, args }) => {
          if (command === 'scp') await copyFile(args.at(-2), args.at(-1).slice(`${target.ssh}:`.length));
          if (command === 'ssh' && String(args.at(-1)).includes('.access-key-agent-qa.tmp')) {
            const result = await promisify(execFile)('/bin/bash', ['-c', args.at(-1)]);
            return { code: 0, out: result.stdout };
          }
          return { code: 0 };
        },
        spawnProcess: input => ({ ...input, exitCode: null }),
        stopProcess: async child => { child.exitCode = 0; },
        waitForDaemonReady: async () => {
          ready = true;
        },
      });
      await running;
      assert.equal(ready, true);
      assert.deepEqual(JSON.parse(await readFile(remoteCredential, 'utf8')), expected,
        'the daemon must receive the controller Account change without overwriting same-Account enrollment');
    } finally { await controller?.close(); }
  }
});

test('attended remote services seed canonical-profile credentials after login without restarting services', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-auth-recovery-'));
  const cliHomeDir = join(root, 'cli');
  const processCalls = [];
  const targetStates = [];
  const spawned = [];
  const authLogs = [];
  const canonicalServerUrl = 'https://qa-home.example:3443';
  const profileId = 'qa-canonical-profile';
  const canonicalCredentialPath = join(cliHomeDir, 'servers', profileId, 'access.key');
  let controller;
  let daemonProbes = 0;
  const target = { name: 'mac', platform: 'posix', ssh: 'mac-ssh', repoDir: '/remote/repo', cliHomeDir: '/remote/cli' };
  try {
    await mkdir(join(cliHomeDir, 'servers', 'unrelated-profile'), { recursive: true });
    await writeFile(join(cliHomeDir, 'servers', 'unrelated-profile', 'access.key'), '{}');
    await writeFile(join(cliHomeDir, 'settings.json'), JSON.stringify({
      schemaVersion: 6,
      activeServerId: profileId,
      servers: {
        [profileId]: { id: profileId, serverUrl: canonicalServerUrl, webappUrl: canonicalServerUrl },
        'unrelated-profile': { id: 'unrelated-profile', serverUrl: 'https://other.example', webappUrl: 'https://other.example' },
      },
    }));
    controller = await startStackDevTargets({
      stackName: 'repo-test', stackBaseDir: join(root, 'stack'), sourceDir: repoDir,
      localServerPort: 3005, localExpoPort: 8081, cliHomeDir, credentialPath: null,
      publicServerUrl: 'http://127.0.0.1:3005',
      canonicalServerUrl,
      activeServerId: 'stack_repo-test__id_default', remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
      targetPlans: [{ target, services: { server: true, expo: true, daemon: true } }],
      onTargetStateChange: (state) => targetStates.push(state), env: { HAPPIER_STACK_TUI: '1' },
    }, {
      runProcess: async (input) => { processCalls.push(input); return { code: 0 }; },
      spawnProcess: (input) => { const child = { ...input, exitCode: null }; spawned.push(child); return child; },
      stopProcess: async (child) => { child.exitCode = 0; },
      waitForProcess: async () => await new Promise(() => {}),
      runDependencyBootstrap: successfulDependencyBootstrap,
      waitForServerReady: async () => {}, waitForExpoReady: async () => {},
      waitForDaemonReady: async () => { daemonProbes += 1; },
      logger: { error() {}, info(message) { authLogs.push(message); } },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(targetStates.some((state) => state.serviceStatus.server === 'running' && state.serviceStatus.expo === 'running'));
    assert.equal(daemonProbes, 0, 'remote daemon must not be probed as ready before credential transfer');
    assert.equal(processCalls.filter((call) => call.command === 'scp').length, 0);
    const workersBeforeLogin = spawned.length;
    await mkdir(dirname(canonicalCredentialPath), { recursive: true });
    await writeFile(canonicalCredentialPath, '{}');
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    assert.equal(daemonProbes, 1);
    assert.equal(processCalls.filter((call) => call.command === 'scp').length, 1);
    assert.ok(processCalls.find((call) => call.command === 'scp').args.includes(canonicalCredentialPath));
    const waitingLogs = authLogs.filter(message => message.includes('waiting for CLI sign-in'));
    assert.equal(waitingLogs.length, 1, 'missing auth must be visible without repeated log spam');
    assert.ok(waitingLogs[0].includes(canonicalServerUrl));
    assert.ok(waitingLogs[0].includes('stack auth repo-test login'));
    assert.ok(targetStates.some((state) => state.status === 'running' && state.serviceStatus.daemon === 'running'));
    assert.equal(spawned.length, workersBeforeLogin, 'login must not restart healthy remote services');
  } finally {
    await controller?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('background dev target startup never gates the local stack and remains closeable while preparing', async () => {
  let resolveStartup;
  let closeCalls = 0;
  const startupPending = new Promise((resolve) => {
    resolveStartup = resolve;
  });

  const controller = startStackDevTargetsInBackground(
    { stackName: 'repo-test', targets: [{ name: 'linux' }] },
    {
      startStackDevTargetsImpl: async () => await startupPending,
      logger: { error() {} },
    },
  );

  assert.ok(controller);
  let closeSettled = false;
  const closePromise = controller.close().then(() => {
    closeSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false, 'shutdown must wait for an in-flight target startup to clean up');

  resolveStartup({
    async close() {
      closeCalls += 1;
    },
  });
  await closePromise;
  assert.equal(closeCalls, 1);
});

test('background dev target failure is isolated from the local stack and retried', async () => {
  const errors = [];
  const targetStates = [];
  const retryWaits = [];
  let attempts = 0;
  let closeCalls = 0;
  const controller = startStackDevTargetsInBackground(
    {
      stackName: 'repo-test',
      targetPlans: [{
        target: { name: 'windows' },
        commands: true,
        services: { server: false, expo: false, daemon: false },
      }],
      onTargetStateChange: (state) => targetStates.push(state),
    },
    {
      startStackDevTargetsImpl: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('remote install failed');
        return {
          async close() {
            closeCalls += 1;
          },
        };
      },
      waitForRetry: async ({ attempt, delayMs }) => retryWaits.push({ attempt, delayMs }),
      logger: { error(message) { errors.push(message); } },
    },
  );

  assert.ok(await controller.ready);
  assert.equal(attempts, 2);
  assert.deepEqual(retryWaits, [{ attempt: 1, delayMs: 5_000 }]);
  assert.match(errors.join('\n'), /remote install failed/);
  assert.deepEqual(targetStates, [{
    name: 'windows',
    commands: true,
    services: { server: false, expo: false, daemon: false },
    status: 'retrying',
    phase: 'startup',
    error: 'remote install failed',
  }]);
  await controller.close();
  assert.equal(closeCalls, 1);
});

test('command-only target resumes continuous Mutagen sync without flushing a moving checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-commands-'));
  const calls = [];
  let dependencyBootstrapCalls = 0;
  const target = {
    name: 'mac',
    platform: 'posix',
    ssh: 'mac-ssh',
    repoDir: '/Users/test/happier',
    cliHomeDir: '/Users/test/.happier/mac',
  };
  try {
    const controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        activeServerId: 'stack_repo-test__id_default',
        credentialPath: null,
        targetPlans: [{
          target,
          commands: true,
          services: { server: false, expo: false, daemon: false },
        }],
        env: {},
      },
      {
        runDependencyBootstrap: async () => {
          dependencyBootstrapCalls += 1;
          return { code: 0 };
        },
        runProcess: async ({ label, command, args }) => {
          calls.push({ kind: 'run', label, command, args });
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args }) => {
          calls.push({ kind: 'spawn', label, command, args });
          return { label, command, args, exitCode: null };
        },
        stopProcess: async (child) => {
          calls.push({ kind: 'stop', label: child.label });
          child.exitCode = 0;
        },
      },
    );

    assert.deepEqual(controller.workers, []);
    assert.equal(calls.some((call) => call.command === 'mutagen' && call.args.includes('flush')), false);
    assert.equal(calls.some((call) => call.kind === 'spawn' && call.label === 'remote:mac'), false);
    assert.equal(calls.some((call) => call.command === 'scp'), false);
    assert.equal(
      dependencyBootstrapCalls,
      0,
      'a command-only target must rely on the independent command execution owner instead of installing during Stack startup',
    );

    await controller.close();
    assert.ok(calls.some((call) => call.kind === 'stop' && call.label === 'mutagen'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dependency bootstrap delegates to the cancellable remote execution owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-bootstrap-owner-'));
  const processCalls = [];
  const bootstrapCalls = [];
  const target = {
    name: 'mac',
    platform: 'posix',
    ssh: 'mac-ssh',
    repoDir: '/Users/test/happier',
    cliHomeDir: '/Users/test/.happier/mac',
  };
  try {
    const controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        publicServerUrl: 'http://127.0.0.1:3005',
        activeServerId: 'stack_repo-test__id_default',
        credentialPath: null,
        remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
        targetPlans: [{
          target,
          commands: true,
          services: { server: true, expo: false, daemon: false },
        }],
        env: {},
      },
      {
        runProcess: async ({ command, args }) => {
          processCalls.push({ command, args });
          return { code: 0 };
        },
        runDependencyBootstrap: async (options) => {
          bootstrapCalls.push(options);
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args }) => ({ label, command, args, exitCode: null }),
        stopProcess: async (child) => {
          child.exitCode = 0;
        },
      },
    );

    assert.equal(bootstrapCalls.length, 1);
    assert.equal(bootstrapCalls[0].target, target);
    assert.equal(bootstrapCalls[0].stackBaseDir, join(root, 'stack'));
    assert.equal(bootstrapCalls[0].syncAlreadyVerified, false);
    assert.equal(bootstrapCalls[0].flush, true);
    assert.equal(
      processCalls.some(({ command, args }) => (
        command === 'ssh'
        && args.some((arg) => String(arg).includes('remote_dependency_bootstrap.mjs'))
      )),
      false,
    );

    await controller.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('remote service startup retires the prior Stack in a visible finite phase before spawning its worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-retire-phase-'));
  const calls = [];
  const targetStates = [];
  const target = {
    name: 'mac',
    platform: 'posix',
    ssh: 'mac-ssh',
    repoDir: '/Users/test/happier',
    cliHomeDir: '/Users/test/.happier/mac',
  };
  let controller = null;

  try {
    controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        publicServerUrl: 'http://127.0.0.1:3005',
        activeServerId: 'stack_repo-test__id_default',
        credentialPath: null,
        remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
        targetPlans: [{
          target,
          commands: false,
          services: { server: true, expo: false, daemon: false },
        }],
        onTargetStateChange: (state) => targetStates.push(state),
        env: {},
      },
      {
        runDependencyBootstrap: successfulDependencyBootstrap,
        runProcess: async input => {
          calls.push({ kind: 'run', ...input });
          // Mock the OpenSSH process, retaining the real control transport's
          // refused-multiplex-session recovery instead of bypassing it.
          return runDevTargetControlProcess(input, { capture: async (_command, args) => {
            if (input.command === 'ssh' && !args.includes('ControlPath=none')) return {
              exitCode: 255, err: 'mux_client_request_session: session request failed: Session open refused by peer',
            };
            const remoteCommand = String(args.at(-1) ?? '');
            return { exitCode: input.command === 'ssh' && remoteCommand.includes('stack.runtime.json') ? 1 : 0 };
          } });
        },
        spawnProcess: ({ label, command, args, env, silent, persistOutput }) => {
          const child = { label, command, args, env, silent, persistOutput, exitCode: null };
          calls.push({ kind: 'spawn', label, command, args, env, silent, persistOutput, child });
          return child;
        },
        stopProcess: async (child) => {
          child.exitCode = 0;
        },
      },
    );

    const stopCallIndex = calls.findIndex((call) => (
      call.kind === 'run'
      && call.command === 'ssh'
      && call.args.at(-1)?.includes('stack stop')
    ));
    const probeCallIndex = calls.findIndex((call) => (
      call.kind === 'run'
      && call.command === 'ssh'
      && call.args.at(-1)?.includes('stack.runtime.json')
    ));
    const workerCallIndex = calls.findIndex((call) => (
      call.kind === 'spawn'
      && call.command === 'ssh'
      && !call.args.includes('-N')
    ));
    assert.ok(probeCallIndex >= 0, 'expected a canonical target-state probe before retirement');
    assert.ok(stopCallIndex > probeCallIndex, 'a present target runtime must be retired after its probe');
    assert.equal(
      calls[stopCallIndex].args.some((arg, index, args) => (
        arg === '-o' && args[index + 1] === 'ControlPath=none'
      )),
      true,
      'prior Stack retirement must use independent SSH control without disturbing the shared master',
    );
    assert.ok(workerCallIndex > stopCallIndex, 'the long-lived worker must start only after retirement completes');
    assert.doesNotMatch(calls[workerCallIndex].args.at(-1), /stack stop/);
    assert.match(
      calls[workerCallIndex].args.at(-1),
      /stack new .*--if-missing.*stack env .* set.*stack dev/,
      'the supervisor must launch the public remote command that initializes the target Stack before dev',
    );
    const tunnelCall = calls.find((call) => (
      call.kind === 'spawn'
      && call.command === 'ssh'
      && call.args.includes('-N')
    ));
    assert.equal(tunnelCall?.silent, true, 'forwarding transport noise must not replace remote service logs');
    assert.equal(tunnelCall?.persistOutput, false, 'expected forwarding refusals must not pollute the target log');
    assert.notEqual(calls[workerCallIndex].silent, true, 'remote worker and service logs must remain visible');
    assert.notEqual(calls[workerCallIndex].persistOutput, false, 'remote worker and service logs must remain persisted');
    assert.ok(
      targetStates.some((state) => state.status === 'starting' && state.phase === 'stop'),
      'runtime observers must distinguish prior Stack retirement from an unexplained worker stall',
    );
    assert.ok(
      targetStates.some((state) => state.status === 'starting' && state.phase === 'server-readiness'),
      'a remote server must enter readiness before it can be reported running',
    );

    await controller.close();
    controller = null;
  } finally {
    await controller?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an absent prior remote Stack skips its non-idempotent stop before spawning the replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-retire-absent-'));
  const calls = [];
  const targetStates = [];
  const target = {
    name: 'mac',
    platform: 'posix',
    ssh: 'mac-ssh',
    repoDir: '/Users/test/happier',
    cliHomeDir: '/Users/test/.happier/mac',
  };
  let controller = null;

  try {
    controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        publicServerUrl: 'http://127.0.0.1:3005',
        activeServerId: 'stack_repo-test__id_default',
        credentialPath: null,
        remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
        targetPlans: [{
          target,
          commands: false,
          services: { server: true, expo: false, daemon: false },
        }],
        onTargetStateChange: (state) => targetStates.push(state),
        env: {},
      },
      {
        runDependencyBootstrap: successfulDependencyBootstrap,
        runProcess: async ({ label, command, args, env }) => {
          calls.push({ kind: 'run', label, command, args, env });
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env, silent, persistOutput }) => {
          const child = { label, command, args, env, silent, persistOutput, exitCode: null };
          calls.push({ kind: 'spawn', label, command, args, env, silent, persistOutput, child });
          return child;
        },
        stopProcess: async (child) => {
          child.exitCode = 0;
        },
      },
    );

    const probeCallIndex = calls.findIndex((call) => (
      call.kind === 'run' && call.command === 'ssh' && String(call.args.at(-1)).includes('stack.runtime.json')
    ));
    const tunnelCallIndex = calls.findIndex((call) => (
      call.kind === 'spawn' && call.command === 'ssh' && call.args.includes('-N')
    ));
    const workerCallIndex = calls.findIndex((call) => (
      call.kind === 'spawn' && call.command === 'ssh' && !call.args.includes('-N')
    ));
    assert.ok(probeCallIndex >= 0, 'retirement must check canonical state before attempting a stop');
    assert.equal(
      calls.some((call) => call.kind === 'run' && call.command === 'ssh' && String(call.args.at(-1)).includes('stack stop')),
      false,
      'an absent target runtime must not run a non-idempotent remote Stack stop',
    );
    assert.ok(tunnelCallIndex > probeCallIndex, 'verified absence may create one replacement tunnel');
    assert.ok(workerCallIndex > tunnelCallIndex, 'verified absence may create one replacement worker');
    assert.equal(
      targetStates.some((state) => state.status === 'retrying' && state.phase === 'stop'),
      false,
      'an already-retired target must not remain retrying',
    );

    await controller.close();
    controller = null;
  } finally {
    await controller?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('SSH code 255 during prior remote Stack retirement proceeds only after a separate absence probe verifies cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-retire-ssh-255-'));
  const calls = [];
  const targetStates = [];
  const target = {
    name: 'mac',
    platform: 'posix',
    ssh: 'mac-ssh',
    repoDir: '/Users/test/happier',
    cliHomeDir: '/Users/test/.happier/mac',
  };
  let controller = null;
  let retirementProbeCount = 0;

  try {
    controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        publicServerUrl: 'http://127.0.0.1:3005',
        activeServerId: 'stack_repo-test__id_default',
        credentialPath: null,
        remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
        targetPlans: [{
          target,
          commands: false,
          services: { server: true, expo: false, daemon: false },
        }],
        onTargetStateChange: (state) => targetStates.push(state),
        env: {},
      },
      {
        runDependencyBootstrap: successfulDependencyBootstrap,
        runProcess: async ({ label, command, args, env }) => {
          calls.push({ kind: 'run', label, command, args, env });
          const remoteCommand = String(args?.at(-1) ?? '');
          if (command === 'ssh' && remoteCommand.includes('stack stop')) return { code: 255 };
          if (command === 'ssh' && remoteCommand.includes('stack.runtime.json')) {
            retirementProbeCount += 1;
            return { code: retirementProbeCount === 1 ? 1 : 0 };
          }
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env, silent, persistOutput }) => {
          const child = { label, command, args, env, silent, persistOutput, exitCode: null };
          calls.push({ kind: 'spawn', label, command, args, env, silent, persistOutput, child });
          return child;
        },
        stopProcess: async (child) => {
          child.exitCode = 0;
        },
      },
    );

    const stopCallIndex = calls.findIndex((call) => (
      call.kind === 'run' && call.command === 'ssh' && String(call.args.at(-1)).includes('stack stop')
    ));
    const probeCallIndexes = calls.flatMap((call, index) => (
      call.kind === 'run' && call.command === 'ssh' && String(call.args.at(-1)).includes('stack.runtime.json')
        ? [index]
        : []
    ));
    const tunnelCallIndex = calls.findIndex((call) => (
      call.kind === 'spawn' && call.command === 'ssh' && call.args.includes('-N')
    ));
    const workerCallIndex = calls.findIndex((call) => (
      call.kind === 'spawn' && call.command === 'ssh' && !call.args.includes('-N')
    ));
    assert.ok(stopCallIndex >= 0, 'expected a finite retirement command');
    assert.equal(probeCallIndexes.length, 2, 'a present target needs pre-stop and post-255 retirement probes');
    assert.ok(probeCallIndexes[0] < stopCallIndex, 'the prior target runtime must be checked before stopping');
    assert.ok(probeCallIndexes[1] > stopCallIndex, 'code 255 must be verified through a fresh read-only transport');
    assert.ok(tunnelCallIndex > probeCallIndexes[1], 'a verified retirement may create one replacement tunnel');
    assert.ok(workerCallIndex > tunnelCallIndex, 'a verified retirement may create one replacement worker');
    assert.equal(
      targetStates.some((state) => state.status === 'retrying' && state.phase === 'stop'),
      false,
      'a verified completed retirement must not leave the target retrying',
    );

    await controller.close();
    controller = null;
  } finally {
    await controller?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a nonzero retirement probe keeps the target retrying and starts no replacement transport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-retire-probe-failed-'));
  const calls = [];
  const targetStates = [];
  const target = {
    name: 'mac',
    platform: 'posix',
    ssh: 'mac-ssh',
    repoDir: '/Users/test/happier',
    cliHomeDir: '/Users/test/.happier/mac',
  };
  let controller = null;

  try {
    controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        publicServerUrl: 'http://127.0.0.1:3005',
        activeServerId: 'stack_repo-test__id_default',
        credentialPath: null,
        remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
        targetPlans: [{
          target,
          commands: false,
          services: { server: true, expo: false, daemon: false },
        }],
        onTargetStateChange: (state) => targetStates.push(state),
        env: {},
      },
      {
        runDependencyBootstrap: successfulDependencyBootstrap,
        runProcess: async ({ label, command, args, env }) => {
          calls.push({ kind: 'run', label, command, args, env });
          const remoteCommand = String(args?.at(-1) ?? '');
          if (command === 'ssh' && remoteCommand.includes('stack stop')) return { code: 255 };
          if (command === 'ssh' && remoteCommand.includes('stack.runtime.json')) return { code: 1 };
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env, silent, persistOutput }) => {
          const child = { label, command, args, env, silent, persistOutput, exitCode: null };
          calls.push({ kind: 'spawn', label, command, args, env, silent, persistOutput, child });
          return child;
        },
        stopProcess: async (child) => {
          child.exitCode = 0;
        },
      },
    );

    const probeCall = calls.find((call) => (
      call.kind === 'run' && call.command === 'ssh' && String(call.args.at(-1)).includes('stack.runtime.json')
    ));
    assert.ok(probeCall, 'code 255 must be checked rather than ignored');
    assert.equal(
      calls.some((call) => call.kind === 'spawn' && call.command === 'ssh'),
      false,
      'a failed probe must not create a replacement tunnel or worker',
    );
    assert.ok(
      targetStates.some((state) => state.status === 'retrying' && state.phase === 'stop'),
      'a failed probe must preserve the retirement failure',
    );

    await controller.close();
    controller = null;
  } finally {
    await controller?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary prior remote Stack retirement failures remain fatal after a nonzero pre-stop probe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-retire-ordinary-failure-'));
  const calls = [];
  const targetStates = [];
  const target = {
    name: 'mac',
    platform: 'posix',
    ssh: 'mac-ssh',
    repoDir: '/Users/test/happier',
    cliHomeDir: '/Users/test/.happier/mac',
  };
  let controller = null;

  try {
    controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        publicServerUrl: 'http://127.0.0.1:3005',
        activeServerId: 'stack_repo-test__id_default',
        credentialPath: null,
        remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
        targetPlans: [{
          target,
          commands: false,
          services: { server: true, expo: false, daemon: false },
        }],
        onTargetStateChange: (state) => targetStates.push(state),
        env: {},
      },
      {
        runDependencyBootstrap: successfulDependencyBootstrap,
        runProcess: async ({ label, command, args, env }) => {
          calls.push({ kind: 'run', label, command, args, env });
          const remoteCommand = String(args?.at(-1) ?? '');
          if (command === 'ssh' && remoteCommand.includes('stack.runtime.json')) return { code: 1 };
          if (command === 'ssh' && remoteCommand.includes('stack stop')) return { code: 1 };
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env, silent, persistOutput }) => {
          const child = { label, command, args, env, silent, persistOutput, exitCode: null };
          calls.push({ kind: 'spawn', label, command, args, env, silent, persistOutput, child });
          return child;
        },
        stopProcess: async (child) => {
          child.exitCode = 0;
        },
      },
    );

    const probeCallIndex = calls.findIndex((call) => (
      call.kind === 'run' && call.command === 'ssh' && String(call.args.at(-1)).includes('stack.runtime.json')
    ));
    const stopCallIndex = calls.findIndex((call) => (
      call.kind === 'run' && call.command === 'ssh' && String(call.args.at(-1)).includes('stack stop')
    ));
    assert.ok(probeCallIndex >= 0, 'every retirement must start with the canonical state probe');
    assert.ok(stopCallIndex > probeCallIndex, 'a nonzero pre-stop probe must not mask ordinary stop failures');
    assert.equal(
      calls.some((call) => call.kind === 'spawn' && call.command === 'ssh'),
      false,
      'an ordinary retirement failure must not create a replacement tunnel or worker',
    );
    assert.ok(targetStates.some((state) => state.status === 'retrying' && state.phase === 'stop'));

    await controller.close();
    controller = null;
  } finally {
    await controller?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('remote server placement is not reported running until its stable tunneled HTTP endpoint is ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-server-readiness-'));
  const targetStates = [];
  let resolveServerReady;
  const serverReady = new Promise((resolve) => {
    resolveServerReady = resolve;
  });
  let observedReadiness = null;
  const spawned = [];
  let notifyRunning;
  const running = new Promise((resolve) => {
    notifyRunning = resolve;
  });
  const target = {
    name: 'mac',
    platform: 'posix',
    ssh: 'mac-ssh',
    repoDir: '/Users/test/happier',
    cliHomeDir: '/Users/test/.happier/mac',
    remoteServerPort: 43005,
  };
  let controller = null;

  try {
    controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        publicServerUrl: 'http://127.0.0.1:3005',
        activeServerId: 'stack_repo-test__id_default',
        credentialPath: null,
        remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
        targetPlans: [{
          target,
          commands: false,
          services: { server: true, expo: false, daemon: false },
        }],
        onTargetStateChange: (state) => {
          targetStates.push(state);
          if (state.status === 'running') notifyRunning();
        },
        env: { HAPPIER_STACK_TUI: '1' },
      },
      {
        runDependencyBootstrap: successfulDependencyBootstrap,
        runProcess: async () => ({ code: 0 }),
        spawnProcess: ({ label, command, args, env }) => {
          const child = { label, command, args, env, exitCode: null };
          spawned.push(child);
          return child;
        },
        stopProcess: async (child) => {
          child.exitCode = 0;
        },
        waitForServerReady: async (options) => {
          observedReadiness = options;
          await serverReady;
        },
      },
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(observedReadiness?.url, 'http://127.0.0.1:3005');
    const worker = spawned.find((child) => child.command === 'ssh' && child.args.at(-1)?.includes('stack dev'));
    assert.match(worker?.args.at(-1) ?? '', /export HAPPIER_STACK_TUI=1/);
    assert.equal(
      targetStates.some((state) => state.status === 'running'),
      false,
      'a live remote worker is not evidence that the local tunnel reaches a ready server',
    );
    assert.equal(targetStates.at(-1)?.serviceStatus?.server, 'starting');
    assert.deepEqual(targetStates.at(-1)?.servicePorts, { server: 43005 });
    assert.equal(targetStates.at(-1)?.repoDir, '/Users/test/happier');

    resolveServerReady();
    assert.equal(await Promise.race([
      running.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ]), true);
    assert.equal(targetStates.at(-1)?.serviceStatus?.server, 'running');
    assert.deepEqual(targetStates.at(-1)?.servicePorts, { server: 43005 });

    await controller.close();
    controller = null;
  } finally {
    await controller?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('remote daemon placement is not reported running until the daemon readiness probe succeeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-daemon-readiness-'));
  const credentialPath = join(root, 'access.key');
  const targetStates = [];
  const processCalls = [];
  let daemonReadinessInput = null;
  let resolveDaemonReady;
  const daemonReady = new Promise((resolve) => {
    resolveDaemonReady = resolve;
  });
  let notifyRunning;
  const running = new Promise((resolve) => {
    notifyRunning = resolve;
  });
  const target = {
    name: 'mac',
    platform: 'posix',
    ssh: 'mac-ssh',
    repoDir: '/Users/test/happier',
    cliHomeDir: '/Users/test/.happier/mac',
  };
  await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });

  try {
    const controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        activeServerId: 'stack_repo-test__id_default',
        credentialPath,
        targetPlans: [{
          target,
          commands: true,
          services: { server: false, expo: false, daemon: true },
        }],
        onTargetStateChange: (state) => {
          targetStates.push(state);
          if (state.status === 'running') notifyRunning();
        },
        env: {},
      },
      {
        runDependencyBootstrap: successfulDependencyBootstrap,
        runProcess: async (input) => {
          processCalls.push(input);
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env }) => ({
          label,
          command,
          args,
          env,
          exitCode: null,
        }),
        stopProcess: async (child) => {
          child.exitCode = 0;
        },
        waitForDaemonReady: async (input) => {
          daemonReadinessInput = input;
          return await daemonReady;
        },
      },
    );

    await new Promise((resolve) => setImmediate(resolve));
    const targetActiveServerId = resolveRemoteStackStatePaths(target, {
      stackName: 'repo-test',
    }).activeServerId;
    const credentialInstallation = processCalls.find(({ command, args }) => (
      command === 'ssh'
      && args.some((arg) => String(arg).includes('/access.key'))
    ));
    assert.ok(credentialInstallation);
    assert.match(credentialInstallation.args.at(-1), new RegExp(`/servers/${targetActiveServerId}/access\\.key`));
    assert.doesNotMatch(
      credentialInstallation.args.at(-1),
      /\/servers\/stack_repo-test__id_default\/access\.key/,
    );
    assert.equal(daemonReadinessInput?.stackName, 'repo-test');
    assert.equal(
      targetStates.some((state) => state.status === 'running'),
      false,
      'a live SSH worker is not evidence that its daemon started',
    );
    assert.equal(
      targetStates.at(-1)?.serviceStatus?.daemon,
      'starting',
      'the target projection must expose daemon readiness independently',
    );

    resolveDaemonReady();
    assert.equal(await Promise.race([
      running.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ]), true);
    assert.equal(targetStates.at(-1)?.status, 'running');
    assert.equal(targetStates.at(-1)?.serviceStatus?.daemon, 'running');

    await controller.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const resolvePort of [resolveDefaultRemoteServerPort, resolveDefaultRemoteExpoPort]) {
test(`default remote ports are deterministic, instance-specific and outside ephemeral and local reserved ranges (${resolvePort.name})`, () => {
    const input = { localServerPort: 52753, localExpoPort: 19081, targetIndex: 0, instanceId: 100 };
    const first = resolvePort(input);
    assert.equal(resolvePort(input), first);
    assert.notEqual(resolvePort({ ...input, instanceId: 101 }), first);
    assert.notEqual(resolvePort({ ...input, targetIndex: 1 }), first);
    // Cover every residue of the former 20000-port pools, including wraparound.
    for (let instanceId = 0; instanceId < 20_000; instanceId++) {
      const port = resolvePort({ ...input, instanceId });
      assert.ok(port >= 1024 && port < 32768, `port ${port} overlaps a supported default ephemeral range`);
      assert.ok(port < 18081 || port > 20080, `port ${port} overlaps the controller's reserved Expo pool`);
      assert.ok(![5432, 6432, 9229].includes(port), `port ${port} is a fixed service port`);
    }
});
}

test('a colliding generated reverse port is replaced before any remote runtime is retained', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-reverse-port-collision-' });
  const target = { name: 'nl1', platform: 'posix', ssh: 'nl1-ssh', repoDir: '/remote/repo', cliHomeDir: '/remote/home' };
  const tunnels = [];
  const occupiedPort = resolveDefaultRemoteServerPort({ localServerPort: 3022, targetIndex: 0, instanceId: 2050849 });
  let replacement;
  const replaced = new Promise(resolve => { replacement = resolve; });
  let running;
  const ready = new Promise(resolve => { running = resolve; });
  let retries = 0;
  const controller = await startStackDevTargets({
    stackName: 'agent-qa-machine-resources', stackBaseDir: root, sourceDir: repoDir,
    localServerPort: 3022, instanceId: 2050849, sourceSnapshot: true,
    canonicalServerUrl: 'http://happier-agent-qa-machine-resources.localhost:3022',
    credentialPath: join(root, 'credential'),
    targetPlans: [{ target, services: { server: false, expo: false, daemon: true } }],
    onTargetStateChange: state => { if (state.status === 'running') running(state); }, env: {},
  }, {
    // SSH is the boundary: another Stack holds the first candidate, its probe still accepts
    // connections, and the failed worker has not published any native runtime.
    runProcess: async ({ command, args }) => {
      if (command === 'ssh' && String(args.at(-1)).includes('daemon.state.json')) {
        return { code: tunnels.at(-1).exitCode == null ? 0 : 1 };
      }
      if (command === 'ssh' && String(args.at(-1)).includes('sourceRuntimeIdentities')) return {
        code: 0, out: JSON.stringify({ sourceRuntimeIdentities: { daemon: { selected: 'current', loaded: 'current' } } }),
      };
      return { code: 0 };
    },
    spawnProcess: input => {
      let finish;
      const child = { ...input, exitCode: null, completion: new Promise(resolve => { finish = resolve; }),
        finish: result => { child.exitCode = result.code; finish(result); } };
      if (input.command === 'ssh' && input.args.includes('-N')) {
        tunnels.push(child);
        if (input.args.includes(`127.0.0.1:${occupiedPort}:127.0.0.1:3022`)) child.finish({ code: 255 });
        if (tunnels.length === 2) replacement(child);
      }
      return child;
    },
    stopProcess: async child => child.finish({ code: 0 }),
    waitForRetry: async () => { if (++retries > 1) await new Promise(() => {}); },
    logger: { error() {}, info() {} },
  });
  try {
    const tunnel = await replaced;
    assert.equal(tunnel.exitCode, null, 'a retry must escape the occupied port instead of repeating it forever');
    assert.ok(tunnel.args.includes('127.0.0.1:3022:127.0.0.1:3022'), 'the canonical Home route stays fixed');
    const state = await ready;
    assert.equal(state.serviceStatus.daemon, 'running');
    assert.notEqual(state.servicePorts.daemon, occupiedPort);
  } finally { await controller.close(); }
});

test('remote server readiness has no default cutoff and preserves an operator deadline', () => {
  assert.equal(resolveRemoteServerReadyTimeoutMs({}), Infinity);
  assert.equal(
    resolveRemoteServerReadyTimeoutMs({ HAPPIER_STACK_SERVER_READY_TIMEOUT_MS: '90000' }),
    90_000,
  );
});

for (const service of ['expo', 'daemon']) {
test(`remote ${service} startup may complete beyond the former default deadline`, { timeout: 15_000 }, async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-unbounded-readiness-' });
  const credentialPath = join(root, 'access.key');
  await writeFile(credentialPath, '{"token":"secret"}\n');
  const target = { name: 'linux', platform: 'posix', ssh: 'linux-ssh', repoDir: '/remote/repo', cliHomeDir: '/remote/cli' };
  let clock = Date.now();
  // Clock and network/process adapters are real boundaries. The readiness
  // owner and its probes stay real; a healthy listener starts two hours later.
  t.mock.method(Date, 'now', () => clock);
  let networkProbes = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (networkProbes++ === 0) {
      clock += 2 * 60 * 60_000;
      return new Response('', { status: 503 });
    }
    if (String(url).endsWith('/health')) {
      return Response.json({ status: 'ok', service: 'happier-server' });
    }
    return new Response('packager-status:running');
  });
  let daemonProbes = 0;
  let finish;
  const terminal = new Promise(resolve => { finish = resolve; });
  const controller = await startStackDevTargets({
    stackName: 'repo-test', stackBaseDir: root, sourceDir: repoDir,
    localServerPort: 3005, localExpoPort: 18081, credentialPath,
    targetPlans: [{ target, services: { server: service === 'server', expo: service === 'expo', daemon: service === 'daemon' } }],
    env: {},
    onTargetStateChange: state => {
      if (state.status === 'running' || state.status === 'degraded') finish(state);
    },
  }, {
    runDependencyBootstrap: successfulDependencyBootstrap,
    runProcess: async ({ command, args }) => {
      if (command === 'ssh' && String(args.at(-1)).includes('daemon.state.json')) {
        if (daemonProbes++ === 0) { clock += 2 * 60 * 60_000; return { code: 1 }; }
      }
      return { code: 0 };
    },
    spawnProcess: input => ({ ...input, exitCode: null }),
    stopProcess: async child => { child.exitCode = 0; },
    waitForProcess: async () => await new Promise(() => {}),
    waitForRetry: async () => await new Promise(() => {}),
    logger: { error() {} },
  });
  try {
    const state = await terminal;
    assert.equal(state.status, 'running', state.error);
    assert.equal(state.serviceStatus[service], 'running');
  } finally { await controller.close(); }
});
}

test('dev target supervisor borrows an existing producer project and leaves it running on close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-reuse-'));
  const credentialPath = join(root, 'access.key');
  const stackBaseDir = join(root, 'stack');
  const projectFile = join(stackBaseDir, 'mutagen', 'mutagen.yml');
  const sourceDir = repoDir;
  const target = {
    name: 'linux',
    platform: 'posix',
    ssh: 'linux-ssh',
    repoDir: '/home/dev/happier',
    cliHomeDir: '/home/dev/.happier/linux',
  };
  const calls = [];
  try {
    await mkdir(join(stackBaseDir, 'mutagen'), { recursive: true });
    await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });
    await writeFile(
      projectFile,
      renderMutagenProject({ sourceDir, targets: [target], ownerId: 101 }),
      'utf8',
    );

    const controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir,
        sourceDir,
        localServerPort: 3005,
        activeServerId: 'stack_repo-test__id_default',
        credentialPath,
        targets: [target],
        env: {},
        instanceId: 202,
      },
      {
        runDependencyBootstrap: successfulDependencyBootstrap,
        runProcess: async ({ command, args }) => {
          calls.push({ kind: 'run', command, args });
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env }) => {
          const worker = { label, command, args, env, exitCode: null };
          calls.push({ kind: 'spawn', command, args, worker });
          return worker;
        },
        stopProcess: async (worker) => {
          worker.exitCode = 0;
        },
      },
    );

    assert.deepEqual(
      calls
        .filter((call) => call.kind === 'run' && call.command === 'mutagen')
        .map((call) => call.args.find((arg) => ['version', 'terminate', 'start', 'resume', 'list', 'flush'].includes(arg))),
      ['list', 'list'],
    );
    const claimedProject = await readFile(projectFile, 'utf8');
    assert.match(claimedProject, /^# hstack-owner: "101"$/m);

    await controller.close();
    assert.equal(
      calls.some((call) => call.command === 'mutagen' && call.args.includes('terminate')),
      false,
    );
    assert.equal(
      calls.some((call) => call.command === 'mutagen' && call.args.includes('pause')),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dev target supervisor borrows independent synchronization without mutating its lifecycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-independent-sync-'));
  const stackBaseDir = join(root, 'stack');
  const projectFile = join(stackBaseDir, 'mutagen', 'mutagen.yml');
  const sourceDir = repoDir;
  const target = {
    name: 'linux',
    platform: 'posix',
    ssh: 'linux-ssh',
    repoDir: '/home/dev/happier',
    cliHomeDir: '/home/dev/.happier/linux',
  };
  const calls = [];
  try {
    await mkdir(join(stackBaseDir, 'mutagen'), { recursive: true });
    await writeFile(
      projectFile,
      renderMutagenProject({
        sourceDir,
        targets: [target],
        ownerId: 'dev-target-sync-service',
      }),
      'utf8',
    );

    const controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir,
        sourceDir,
        localServerPort: 3005,
        activeServerId: 'stack_repo-test__id_default',
        targetPlans: [{
          target,
          commands: true,
          services: { server: false, expo: false, daemon: false },
        }],
        env: {},
        instanceId: 202,
      },
      {
        runDependencyBootstrap: successfulDependencyBootstrap,
        runProcess: async ({ command, args }) => {
          calls.push({ kind: 'run', command, args });
          return {
            code: 0,
            ...(command === 'mutagen' && args[0] === 'sync' && args[1] === 'list'
              ? { out: JSON.stringify([{ name: 'happier-linux', paused: false, status: 'watching', successfulCycles: 1, alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }]) }
              : {}),
          };
        },
        spawnProcess: ({ label, command, args, env }) => {
          const child = { label, command, args, env, exitCode: null };
          calls.push({ kind: 'spawn', command, args, child });
          return child;
        },
        stopProcess: async (child) => { child.exitCode = 0; },
      },
    );

    const mutagenLifecycleActions = calls
      .filter((call) => call.kind === 'run' && call.command === 'mutagen')
      .flatMap((call) => call.args.filter((arg) => ['start', 'resume', 'pause', 'terminate'].includes(arg)));
    assert.deepEqual(mutagenLifecycleActions, []);
    await controller.close();
    assert.deepEqual(
      calls
        .filter((call) => call.kind === 'run' && call.command === 'mutagen')
        .flatMap((call) => call.args.filter((arg) => ['start', 'resume', 'pause', 'terminate'].includes(arg))),
      [],
    );
    assert.match(await readFile(projectFile, 'utf8'), /^# hstack-owner: "dev-target-sync-service"$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dev target supervisor borrows an all-target independent project when only a subset runs services', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-independent-sync-subset-'));
  const stackBaseDir = join(root, 'stack');
  const projectFile = join(stackBaseDir, 'mutagen', 'mutagen.yml');
  const sourceDir = repoDir;
  const commandTarget = {
    name: 'mac',
    platform: 'posix',
    ssh: 'mac-ssh',
    repoDir: '/Users/test/happier',
    cliHomeDir: '/Users/test/.happier/mac',
  };
  const syncOnlyTarget = {
    name: 'windows',
    platform: 'windows',
    ssh: 'windows-ssh',
    repoDir: 'C:\\Users\\test\\happier',
    cliHomeDir: 'C:\\Users\\test\\.happier\\windows',
  };
  const calls = [];
  try {
    await mkdir(join(stackBaseDir, 'mutagen'), { recursive: true });
    await writeFile(
      projectFile,
      renderMutagenProject({
        sourceDir,
        targets: [commandTarget, syncOnlyTarget],
        ownerId: 'dev-target-sync-service',
      }),
      'utf8',
    );

    const controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir,
        sourceDir,
        localServerPort: 3005,
        activeServerId: 'stack_repo-test__id_default',
        syncTargets: [commandTarget, syncOnlyTarget],
        targetPlans: [{
          target: commandTarget,
          commands: true,
          services: { server: false, expo: false, daemon: false },
        }],
        env: {},
        instanceId: 202,
      },
      {
        runDependencyBootstrap: successfulDependencyBootstrap,
        runProcess: async ({ command, args }) => {
          calls.push({ kind: 'run', command, args });
          const sessionName = args[2];
          return {
            code: 0,
            ...(command === 'mutagen' && args[0] === 'sync' && args[1] === 'list'
              ? { out: JSON.stringify([{ name: sessionName, paused: false, status: 'watching', successfulCycles: 1, alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }]) }
              : {}),
          };
        },
        spawnProcess: ({ label, command, args, env }) => {
          const child = { label, command, args, env, exitCode: null };
          calls.push({ kind: 'spawn', command, args, child });
          return child;
        },
        stopProcess: async (child) => { child.exitCode = 0; },
      },
    );

    const mutagenLifecycleActions = calls
      .filter((call) => call.kind === 'run' && call.command === 'mutagen')
      .flatMap((call) => call.args.filter((arg) => ['start', 'resume', 'pause', 'terminate'].includes(arg)));
    assert.deepEqual(mutagenLifecycleActions, []);
    assert.equal(
      calls.some((call) => (
        call.kind === 'run'
        && call.command === 'mutagen'
        && call.args[0] === 'sync'
        && call.args[1] === 'list'
        && call.args[2] === 'happier-windows'
      )),
      false,
      'an unrelated sync-only target must not gate Stack remote-service startup',
    );
    assert.equal(
      calls.some((call) => (
        call.kind === 'run'
        && call.command === 'mutagen'
        && call.args[0] === 'sync'
        && call.args[1] === 'list'
        && call.args[2] === 'happier-mac'
      )),
      true,
    );
    assert.match(await readFile(projectFile, 'utf8'), /happier-windows:/);
    assert.match(await readFile(projectFile, 'utf8'), /^# hstack-owner: "dev-target-sync-service"$/m);
    await controller.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unhealthy daemon target retries independently without gating a service assigned to another target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-independent-service-isolation-'));
  const stackBaseDir = join(root, 'stack');
  const credentialPath = join(root, 'access.key');
  const projectFile = join(stackBaseDir, 'mutagen', 'mutagen.yml');
  const sourceDir = repoDir;
  const serviceTarget = {
    name: 'mac',
    platform: 'posix',
    ssh: 'mac-ssh',
    repoDir: '/Users/test/happier',
    cliHomeDir: '/Users/test/.happier/mac',
  };
  const commandTarget = {
    name: 'mac2',
    platform: 'posix',
    ssh: 'mac2-ssh',
    repoDir: '/Users/test2/happier',
    cliHomeDir: '/Users/test2/.happier/mac2',
  };
  const calls = [];
  try {
    await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });
    await mkdir(join(stackBaseDir, 'mutagen'), { recursive: true });
    await writeFile(
      projectFile,
      renderMutagenProject({
        sourceDir,
        targets: [serviceTarget, commandTarget],
        ownerId: 'dev-target-sync-service',
      }),
      'utf8',
    );

    const controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir,
        sourceDir,
        localServerPort: 3005,
        publicServerUrl: 'http://127.0.0.1:3005',
        activeServerId: 'stack_repo-test__id_default',
        remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
        credentialPath,
        syncTargets: [serviceTarget, commandTarget],
        targetPlans: [
          {
            target: serviceTarget,
            commands: false,
            services: { server: true, expo: false, daemon: false },
          },
          {
            target: commandTarget,
            commands: true,
            services: { server: false, expo: false, daemon: true },
          },
        ],
        env: {},
        instanceId: 202,
      },
      {
        runDependencyBootstrap: successfulDependencyBootstrap,
        runProcess: async ({ command, args }) => {
          calls.push({ kind: 'run', command, args });
          if (command === 'mutagen' && args[0] === 'sync' && args[1] === 'list') {
            const sessionName = args[2];
            return {
              code: 0,
              out: JSON.stringify([{
                name: sessionName,
                status: sessionName === 'happier-mac2' ? 'disconnected' : 'watching',
                successfulCycles: sessionName === 'happier-mac2' ? 0 : 1,
              }]),
            };
          }
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env }) => {
          const child = { label, command, args, env, exitCode: null };
          calls.push({ kind: 'spawn', command, args, label, child });
          return child;
        },
        stopProcess: async (child) => { child.exitCode = 0; },
        inspectSync: async ({ target }) => ({
          state: target.name === 'mac2' ? 'unhealthy' : 'ready',
          sessionName: `happier-${target.name}`,
        }),
        waitForProcess: async (child) => (
          child.label === 'remote:mac2' && !child.args.includes('-N')
            ? { code: 1 }
            : await new Promise(() => {})
        ),
        waitForRetry: async () => await new Promise(() => {}),
      },
    );
    try {
      assert.equal(
        calls.some((call) => call.kind === 'spawn' && call.label === 'remote:mac' && !call.args.includes('-N')),
        true,
      );
      assert.equal(
        calls.some((call) => (
          call.kind === 'run'
          && call.command === 'mutagen'
          && call.args[0] === 'sync'
          && call.args[1] === 'list'
          && call.args[2] === 'happier-mac2'
        )),
        true,
      );
      assert.equal(
        calls.some((call) => call.kind === 'spawn' && call.label === 'remote:mac2' && !call.args.includes('-N')),
        false,
        'an unhealthy daemon replica must not start while its healthy sibling remains available',
      );
    } finally {
      await controller.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('superseded controller cannot terminate the replacement Mutagen project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-ownership-'));
  const credentialPath = join(root, 'access.key');
  const stackBaseDir = join(root, 'stack');
  const target = {
    name: 'linux',
    platform: 'posix',
    ssh: 'linux-ssh',
    repoDir: '/home/dev/happier',
    cliHomeDir: '/home/dev/.happier/linux',
  };
  await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });

  const createBoundary = () => {
    const calls = [];
    return {
      calls,
      dependencies: {
        runDependencyBootstrap: successfulDependencyBootstrap,
        runProcess: async ({ label, command, args, env }) => {
          calls.push({ kind: 'run', label, command, args, env });
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env, lineFilter }) => {
          const worker = { label, command, args, env, lineFilter, exitCode: null };
          calls.push({ kind: 'spawn', label, command, args, env, lineFilter, worker });
          return worker;
        },
        stopProcess: async (worker) => {
          calls.push({ kind: 'stop', worker });
          worker.exitCode = 0;
        },
      },
    };
  };
  const options = {
    stackName: 'repo-test',
    stackBaseDir,
    sourceDir: repoDir,
    localServerPort: 3005,
    activeServerId: 'stack_repo-test__id_default',
    credentialPath,
    targets: [target],
    env: {},
  };

  try {
    const incumbentBoundary = createBoundary();
    const incumbent = await startStackDevTargets(
      { ...options, instanceId: 101 },
      incumbentBoundary.dependencies,
    );
    const replacementBoundary = createBoundary();
    const replacement = await startStackDevTargets(
      { ...options, instanceId: 202 },
      replacementBoundary.dependencies,
    );

    const incumbentTerminatesBeforeClose = incumbentBoundary.calls.filter(
      (call) => call.command === 'mutagen' && call.args.includes('terminate'),
    ).length;
    await incumbent.close();
    const incumbentTerminatesAfterClose = incumbentBoundary.calls.filter(
      (call) => call.command === 'mutagen' && call.args.includes('terminate'),
    ).length;

    assert.equal(
      incumbentTerminatesAfterClose,
      incumbentTerminatesBeforeClose,
      'the superseded controller must not terminate the replacement project',
    );
    await replacement.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('supervisor streams Mutagen status for the lifetime of the controller', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-monitor-'));
  const credentialPath = join(root, 'access.key');
  const calls = [];
  await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });
  try {
    const controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        activeServerId: 'stack_repo-test__id_default',
        credentialPath,
        targets: [{
          name: 'linux',
          platform: 'posix',
          ssh: 'linux-ssh',
          repoDir: '/home/dev/happier',
          cliHomeDir: '/home/dev/.happier/linux',
        }],
        env: {},
      },
      {
        runDependencyBootstrap: successfulDependencyBootstrap,
        runProcess: async ({ label, command, args, env }) => {
          calls.push({ kind: 'run', label, command, args, env });
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env, lineFilter }) => {
          const worker = { label, command, args, env, lineFilter, exitCode: null };
          calls.push({ kind: 'spawn', label, command, args, env, lineFilter, worker });
          return worker;
        },
        stopProcess: async (worker) => {
          worker.exitCode = 0;
        },
      },
    );

    assert.ok(
      calls.some(
        (call) =>
          call.kind === 'spawn'
          && call.label === 'mutagen'
          && call.command === 'mutagen'
          && call.args.includes('--template')
          && call.args[3].includes('(eq .Name "happier-linux")')
          && typeof call.lineFilter === 'function',
      ),
    );
    const monitorCall = calls.find((call) => call.kind === 'spawn' && call.label === 'mutagen');
    assert.equal(monitorCall.lineFilter({ stream: 'stdout', line: 'happier-linux|Watching|1||false|0' }), true);
    assert.equal(monitorCall.lineFilter({ stream: 'stdout', line: 'happier-linux|Watching|1||false|0' }), false);
    assert.equal(monitorCall.lineFilter({ stream: 'stdout', line: 'happier-linux|Scanning|1||false|0' }), true);
    assert.equal(monitorCall.lineFilter({ stream: 'stderr', line: 'transport failed' }), true);
    await controller.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('supervisor keeps healthy targets and retries another target after its initial bootstrap fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-isolation-'));
  const calls = [];
  const bootstrapCallCounts = new Map();
  let notifyRetryScheduled;
  let releaseRetry;
  let notifyWindowsWorkerStarted;
  const retryScheduled = new Promise((resolve) => {
    notifyRetryScheduled = resolve;
  });
  const retryGate = new Promise((resolve) => {
    releaseRetry = resolve;
  });
  const windowsWorkerStarted = new Promise((resolve) => {
    notifyWindowsWorkerStarted = resolve;
  });
  const credentialPath = join(root, 'access.key');
  await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });
  try {
    const controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        activeServerId: 'stack_repo-test__id_default',
        credentialPath,
        targets: [
          {
            name: 'linux',
            platform: 'posix',
            ssh: 'linux-ssh',
            managedRuntime: {
              kind: 'lima',
              host: { kind: 'local' },
              instance: 'hslqa',
              limaHome: '/tmp/lima-happier',
              profile: 'worker-balanced',
            },
            repoDir: '/home/dev/happier',
            cliHomeDir: '/home/dev/.happier/linux',
          },
          {
            name: 'windows',
            platform: 'windows',
            ssh: 'windows-ssh',
            repoDir: 'C:/Users/dev/happier',
            cliHomeDir: 'C:/Users/dev/.happier/windows',
          },
        ],
        env: {},
      },
      {
        startManagedRuntime: async ({ target }) => {
          calls.push({ kind: 'managed-runtime-start', target });
          return { changed: true, status: 'Running' };
        },
        runDependencyBootstrap: async ({ target }) => {
          const count = (bootstrapCallCounts.get(target.name) ?? 0) + 1;
          bootstrapCallCounts.set(target.name, count);
          if (target.name === 'windows' && count === 1) return { code: 23 };
          return { code: 0 };
        },
        runProcess: async ({ label, command, args, env }) => {
          calls.push({ kind: 'run', label, command, args, env });
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env }) => {
          const worker = { label, command, args, env, exitCode: null };
          calls.push({ kind: 'spawn', ...worker });
          if (label === 'remote:windows' && !args.includes('-N')) notifyWindowsWorkerStarted();
          return worker;
        },
        stopProcess: async (worker) => {
          worker.exitCode = 0;
        },
        waitForDaemonReady: async () => {},
        waitForRetry: async () => {
          notifyRetryScheduled();
          await retryGate;
        },
        logger: { error() {} },
      },
    );

    const limaStart = calls.find((call) => call.kind === 'managed-runtime-start');
    assert.equal(limaStart?.target.name, 'linux');
    assert.equal(calls.some((call) => call.command === 'limactl'), false);
    assert.deepEqual(controller.workers.map((worker) => worker.label), ['remote:linux']);
    assert.deepEqual(controller.targetFailures.map(({ name }) => name), ['windows']);

    const retryWasScheduled = await Promise.race([
      retryScheduled.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(retryWasScheduled, true, 'expected the failed target to remain supervised');
    releaseRetry();
    await windowsWorkerStarted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      controller.workers.map((worker) => worker.label).sort(),
      ['remote:linux', 'remote:windows'],
    );
    assert.deepEqual(controller.targetFailures, []);
    await controller.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('supervisor retries when the only target bootstrap fails after its initial sync', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-initial-sync-race-'));
  const credentialPath = join(root, 'access.key');
  const target = {
    name: 'linux',
    platform: 'posix',
    ssh: 'linux-ssh',
    repoDir: '/home/dev/happier',
    cliHomeDir: '/home/dev/.happier/linux',
  };
  let bootstrapAttempts = 0;
  let notifyWorkerStarted;
  const workerStarted = new Promise((resolve) => {
    notifyWorkerStarted = resolve;
  });
  await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });
  try {
    const controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        activeServerId: 'stack_repo-test__id_default',
        credentialPath,
        targets: [target],
        env: {},
      },
      {
        runDependencyBootstrap: async () => {
          bootstrapAttempts += 1;
          return { code: bootstrapAttempts === 1 ? 1 : 0 };
        },
        runProcess: async ({ command, args }) => {
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env }) => {
          const worker = { label, command, args, env, exitCode: null };
          if (label === 'remote:linux' && !args.includes('-N')) notifyWorkerStarted();
          return worker;
        },
        stopProcess: async (worker) => {
          worker.exitCode = 0;
        },
        waitForRetry: async () => {},
        logger: { error() {} },
      },
    );

    await workerStarted;
    assert.equal(bootstrapAttempts, 2);
    assert.deepEqual(controller.workers.map((worker) => worker.label), ['remote:linux']);
    await controller.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('supervisor increases retry delay across repeated target lifecycle failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-retry-backoff-'));
  const credentialPath = join(root, 'access.key');
  const retryDelays = [];
  let notifyThirdRetry;
  let releaseThirdRetry;
  const thirdRetryObserved = new Promise((resolve) => {
    notifyThirdRetry = resolve;
  });
  const thirdRetryGate = new Promise((resolve) => {
    releaseThirdRetry = resolve;
  });
  await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });

  try {
    const controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        activeServerId: 'stack_repo-test__id_default',
        credentialPath,
        targets: [{
          name: 'linux',
          platform: 'posix',
          ssh: 'linux-ssh',
          repoDir: '/home/dev/happier',
          cliHomeDir: '/home/dev/.happier/linux',
        }],
        env: {},
      },
      {
        runDependencyBootstrap: successfulDependencyBootstrap,
        runProcess: async ({ command }) => {
          if (command === 'mutagen') return { code: 0 };
          return { code: 1 };
        },
        spawnProcess: ({ label }) => {
          if (label === 'mutagen') return { label, exitCode: null };
          throw new Error(`unexpected spawnProcess call: ${label}`);
        },
        stopProcess: async (worker) => {
          worker.exitCode = 0;
        },
        waitForRetry: async ({ delayMs }) => {
          retryDelays.push(delayMs);
          if (retryDelays.length === 3) {
            notifyThirdRetry();
            await thirdRetryGate;
          }
        },
        logger: { error() {} },
      },
    );

    await thirdRetryObserved;
    assert.deepEqual(retryDelays.slice(0, 3), [5_000, 10_000, 20_000]);

    releaseThirdRetry();
    await controller.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('remote worker exit restarts its configured target lifecycle without restarting the local Stack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-reconnect-'));
  const credentialPath = join(root, 'access.key');
  const calls = [];
  let bootstrapCalls = 0;
  const targetStates = [];
  let resolveFirstWorker;
  let notifySecondWorkerStart;
  const secondWorkerStart = new Promise((resolve) => {
    notifySecondWorkerStart = resolve;
  });
  await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });

  try {
    const controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        activeServerId: 'stack_repo-test__id_default',
        credentialPath,
        onTargetStateChange: (state) => targetStates.push(state),
        targets: [{
          name: 'linux',
          platform: 'posix',
          ssh: 'linux-ssh',
          limaInstance: 'hslqa',
          limaHome: '/tmp/lima-happier',
          repoDir: '/home/dev/happier',
          cliHomeDir: '/home/dev/.happier/linux',
        }],
        env: {},
      },
      {
        startManagedRuntime: async ({ target }) => {
          calls.push({ kind: 'runtime-start', target: target.name });
          return { changed: true, status: 'Running' };
        },
        runDependencyBootstrap: async () => {
          bootstrapCalls += 1;
          return { code: 0 };
        },
        runProcess: async ({ label, command, args, env }) => {
          calls.push({ kind: 'run', label, command, args, env });
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env }) => {
          if (label === 'mutagen') {
            return { label, command, args, env, exitCode: null };
          }
          let resolveCompletion;
          const completion = new Promise((resolve) => {
            resolveCompletion = resolve;
          });
          const worker = { label, command, args, env, exitCode: null, completion, resolveCompletion };
          calls.push({ kind: 'spawn', label, command, args, env, worker });
          if (!args.includes('-N')) {
            if (!resolveFirstWorker) {
              resolveFirstWorker = resolveCompletion;
            } else {
              notifySecondWorkerStart();
            }
          }
          return worker;
        },
        stopProcess: async (worker) => {
          worker.exitCode = 0;
          worker.resolveCompletion?.({ code: 0, signal: 'SIGINT' });
        },
        waitForDaemonReady: async () => {},
        waitForRetry: async () => {},
        logger: { error() {} },
      },
    );

    resolveFirstWorker({ code: 255, signal: null });
    const restarted = await Promise.race([
      secondWorkerStart.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(restarted, true, 'expected the target lifecycle to restart after its SSH worker exited');
    await new Promise((resolve) => setImmediate(resolve));
    const terminalStates = targetStates.filter((state) => state.status !== 'starting');
    assert.deepEqual(
      terminalStates.map((state) => state.status),
      ['running', 'retrying', 'running'],
      'runtime observers must see post-start worker failures and recovery',
    );
    assert.equal(terminalStates[1].phase, 'worker');
    assert.equal(
      bootstrapCalls,
      1,
      'a worker-only restart must reuse the already-provisioned checkout',
    );
    assert.equal(
      calls.filter((call) => call.kind === 'runtime-start').length,
      1,
      'a worker-only restart must not restart an already-provisioned Lima target',
    );
    await controller.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('remote Expo replaces a tunnel that dies during worker recovery backoff', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-expo-dead-tunnel-' });
  const target = { name: 'linux', platform: 'posix', ssh: 'linux-ssh', repoDir: '/remote/repo', cliHomeDir: '/remote/cli' };
  const tunnels = [];
  const workers = [];
  let restarted;
  const secondWorker = new Promise(resolve => { restarted = resolve; });
  let retries = 0;
  const controller = await startStackDevTargets({
    stackName: 'repo-test', stackBaseDir: root, sourceDir: repoDir,
    localServerPort: 3005, localExpoPort: 18081,
    targetPlans: [{ target, services: { server: false, expo: true, daemon: false } }], env: {},
  }, {
    runDependencyBootstrap: successfulDependencyBootstrap,
    runProcess: async () => ({ code: 0 }),
    spawnProcess: input => {
      let finish;
      const completion = new Promise(resolve => { finish = resolve; });
      const child = { ...input, exitCode: null, completion, finish };
      if (input.command === 'ssh') {
        if (input.args.includes('-N')) tunnels.push(child);
        else {
          workers.push(child);
          if (workers.length === 2) restarted({ tunnel: tunnels.at(-1), worker: child });
        }
      }
      return child;
    },
    stopProcess: async child => { child.exitCode = 0; child.finish({ code: 0, signal: 'SIGINT' }); },
    waitForExpoReady: async () => {},
    waitForRetry: async () => {
      if (++retries !== 1) return await new Promise(() => {});
      // The genuine SSH boundary can die after worker-exit won the race.
      tunnels[0].exitCode = 255;
      tunnels[0].finish({ code: 255, signal: null });
    },
    logger: { error() {} },
  });
  try {
    workers[0].exitCode = 1;
    workers[0].finish({ code: 1, signal: null });
    const replacement = await secondWorker;
    assert.equal(replacement.tunnel.exitCode, null, 'the replacement worker needs a live tunnel');
    assert.equal(tunnels.length, 2);
    assert.equal(tunnels[1].args[tunnels[1].args.indexOf('-L') + 1], tunnels[0].args[tunnels[0].args.indexOf('-L') + 1]);
  } finally { await controller.close(); }
});

test('remote Expo readiness reports its owning deadline even in an attended TUI', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-expo-readiness-deadline-' });
  const target = { name: 'linux', platform: 'posix', ssh: 'linux-ssh', repoDir: '/remote/repo', cliHomeDir: '/remote/cli' };
  const originalFetch = globalThis.fetch;
  // Network is a genuine boundary; retain the real Metro polling and supervisor.
  globalThis.fetch = async () => new Response('', { status: 503 });
  let degraded;
  const failure = new Promise(resolve => { degraded = resolve; });
  const controller = await startStackDevTargets({
    stackName: 'repo-test', stackBaseDir: root, sourceDir: repoDir,
    localServerPort: 3005, localExpoPort: 18081,
    targetPlans: [{ target, services: { server: false, expo: true, daemon: false } }],
    env: { HAPPIER_STACK_TUI: '1', HAPPIER_DEV_TARGET_EXPO_READY_TIMEOUT_MS: '1' },
    onTargetStateChange: state => { if (state.status === 'degraded') degraded(state); },
  }, {
    runDependencyBootstrap: successfulDependencyBootstrap,
    runProcess: async () => ({ code: 0 }),
    spawnProcess: input => ({ ...input, exitCode: null }),
    stopProcess: async child => { child.exitCode = 0; },
    waitForProcess: async () => await new Promise(() => {}),
    waitForRetry: async () => await new Promise(() => {}),
    logger: { error() {} },
  });
  let timer;
  try {
    const state = await Promise.race([failure, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('no readiness failure was surfaced')), 1500);
    })]);
    assert.equal(state.phase, 'expo-readiness');
    assert.equal(state.serviceStatus.expo, 'degraded');
    assert.match(state.error, /timed out.*after 1ms/);
  } finally {
    clearTimeout(timer);
    await controller.close();
    globalThis.fetch = originalFetch;
  }
});

test('remote Expo ownership does not launch a competing local workspace publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-expo-readiness-'));
  const targetStates = [];
  const spawnedProcesses = [];
  const startupEvents = [];
  let releaseExpoReadiness;
  const expoReadiness = new Promise((resolve) => {
    releaseExpoReadiness = resolve;
  });
  const target = {
    name: 'mac',
    platform: 'posix',
    ssh: 'mac-ssh',
    repoDir: '/Users/test/happier',
    cliHomeDir: '/Users/test/.happier/mac',
  };
  let controller;
  try {
    const startup = startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        localExpoPort: 18081,
        expoPublicUrl: 'http://192.168.5.15:18081',
        resolveMobilePublicUrlsOnTarget: true,
        expoListenHost: '0.0.0.0',
        startMobile: true,
        activeServerId: 'stack_repo-test__id_default',
        credentialPath: null,
        targetPlans: [{
          target,
          commands: false,
          services: { server: false, expo: true, daemon: false },
        }],
        onTargetStateChange: (state) => targetStates.push(state),
        env: {},
      },
      {
        runDependencyBootstrap: successfulDependencyBootstrap,
        runProcess: async ({ command }) => {
          startupEvents.push(`run:${command}`);
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env }) => {
          const child = { label, command, args, env, exitCode: null };
          spawnedProcesses.push(child);
          return child;
        },
        stopProcess: async (child) => {
          child.exitCode = 0;
        },
        waitForExpoReady: async ({ port }) => {
          assert.equal(port, 18081);
          await expoReadiness;
        },
      },
    );

    controller = await startup;
    assert.equal(startupEvents[0], 'run:mutagen');
    const tunnel = spawnedProcesses.find((child) => child.command === 'ssh' && child.args.includes('-L'));
    const worker = spawnedProcesses.find((child) => child.command === 'ssh' && !child.args.includes('-N'));
    assert.ok(tunnel, 'expected the target supervisor to own an Expo tunnel');
    assert.equal(
      worker?.env?.HAPPIER_STACK_LOG_TEE_DIR,
      join(root, 'stack', 'logs'),
      'remote service output must be retained locally for borrowed-stack TUI panes',
    );
    assert.equal(worker?.env?.HAPPIER_STACK_LOG_TEE_TIMESTAMPS, '1');
    assert.match(
      worker?.args.at(-1) ?? '',
      /HAPPIER_STACK_EXPO_PUBLIC_PORT=18081/,
      'the target must publish the stable outer port while resolving its own reachable host',
    );
    assert.doesNotMatch(
      worker?.args.at(-1) ?? '',
      /EXPO_PACKAGER_PROXY_URL=|192\.168\.5\.15/,
      'automatic guest addresses must not override the Expo target\'s own host resolution',
    );
    assert.ok(
      tunnel.args.some((arg) => /^\*:18081:localhost:\d+$/.test(arg)),
      'the tunnel must listen on both IPv4 and IPv6 while resolving remote localhost for Metro',
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      targetStates.some((state) => state.status === 'running'),
      false,
      'a live SSH worker is not sufficient evidence that tunneled Metro is ready',
    );

    releaseExpoReadiness();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(targetStates.at(-1)?.status, 'running');
    assert.equal(targetStates.at(-1)?.repoDir, '/Users/test/happier');
    assert.equal(Number.isInteger(targetStates.at(-1)?.servicePorts?.expo), true);
    assert.ok(
      tunnel.args.includes(`*:18081:localhost:${targetStates.at(-1).servicePorts.expo}`),
      'the published Expo endpoint must be the target-local listener reached by the owned tunnel',
    );
  } finally {
    releaseExpoReadiness?.();
    await controller?.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

for (const failedProbes of [1, 2]) {
test(`remote Expo retains a new forward once and replaces a repeatedly missing listener (${failedProbes} failed probes)`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-tunnel-readiness-'));
  const spawnedProcesses = [];
  let forwardProbeAttempts = 0;
  let notifyRunning;
  const running = new Promise((resolve) => {
    notifyRunning = resolve;
  });
  const target = {
    name: 'mac',
    platform: 'posix',
    ssh: 'mac-ssh',
    repoDir: '/Users/test/happier',
    cliHomeDir: '/Users/test/.happier/mac',
  };
  let controller;
  try {
    controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        localExpoPort: 18081,
        expoListenHost: '0.0.0.0',
        startMobile: true,
        activeServerId: 'stack_repo-test__id_default',
        credentialPath: null,
        targetPlans: [{
          target,
          commands: false,
          services: { server: false, expo: true, daemon: false },
        }],
        onTargetStateChange: (state) => {
          if (state.status === 'running') notifyRunning();
        },
        env: {},
      },
      {
        runDependencyBootstrap: successfulDependencyBootstrap,
        runProcess: async ({ command, args }) => {
          if (command === 'ssh' && String(args.at(-1)).includes('/dev/tcp/')) {
            forwardProbeAttempts += 1;
            return { code: forwardProbeAttempts <= failedProbes ? 1 : 0 };
          }
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env }) => {
          const child = { label, command, args, env, exitCode: null };
          spawnedProcesses.push(child);
          return child;
        },
        stopProcess: async (child) => {
          child.exitCode = 0;
        },
        waitForProcess: async () => await new Promise(() => {}),
        waitForExpoReady: async () => {},
        waitForRetry: async () => {},
        logger: { error() {} },
      },
    );

    await Promise.race([
      running,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('timed out waiting for remote Expo recovery')),
        500,
      )),
    ]);
    const tunnels = spawnedProcesses.filter(
      (child) => child.command === 'ssh' && child.args.includes('-N'),
    );
    assert.equal(forwardProbeAttempts, failedProbes + 1);
    assert.equal(tunnels.length, failedProbes, 'a repeated missing listener must replace its live SSH process');
    assert.equal(tunnels.at(-1).exitCode, null);
    if (failedProbes === 2) assert.equal(tunnels[0].exitCode, 0, 'replacement follows retirement of the failed forward');
  } finally {
    await controller?.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
}

for (const platform of ['posix', 'windows']) {
test(`daemon recovery replaces a live SSH process whose reverse listener disappeared (${platform})`, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-daemon-forward-recovery-' });
  const target = { name: 'daemon', platform, ssh: 'daemon-ssh',
    repoDir: platform === 'windows' ? 'C:/happier' : '/remote/repo',
    cliHomeDir: platform === 'windows' ? 'C:/home/happier' : '/remote/home' };
  const workers = [];
  const tunnels = [];
  const delays = [];
  let transportDropped = false;
  let observeRunning;
  const running = new Promise(resolve => { observeRunning = resolve; });
  let observeRecovery;
  const recovery = new Promise(resolve => { observeRecovery = resolve; });
  const controller = await startStackDevTargets({
    stackName: 'agent-qa', stackBaseDir: root, sourceDir: repoDir, sourceSnapshot: true,
    credentialPath: join(root, 'credential'), localServerPort: 3005,
    targetPlans: [{ target, services: { server: false, expo: false, daemon: true } }],
    onTargetStateChange: state => {
      if (state.status !== 'running') return;
      if (workers.length === 1) observeRunning();
      else observeRecovery(state);
    }, env: {},
  }, {
    // SSH listener/process state is the system boundary; source selection,
    // recovery backoff, forward construction and daemon admission stay real.
    runProcess: async ({ command, args }) => {
      const encoded = String(args.at(-1));
      const remote = platform === 'windows'
        ? Buffer.from(encoded.split(' -EncodedCommand ').at(-1), 'base64').toString('utf16le')
        : encoded;
      if (command === 'ssh' && remote.includes('sourceRuntimeIdentities')) return { code: 0,
        out: JSON.stringify({ sourceRuntimeIdentities: { daemon: { selected: 'retained', loaded: 'retained' } } }) };
      if (command === 'ssh' && (remote.includes('/dev/tcp/') || remote.includes('TcpClient'))) {
        return { code: transportDropped && tunnels.length === 1 ? 1 : 0 };
      }
      return { code: 0 };
    },
    spawnProcess: input => {
      let finish;
      const child = { ...input, exitCode: null, completion: new Promise(resolve => { finish = resolve; }),
        finish: result => { child.exitCode = result.code; finish(result); } };
      if (input.command === 'ssh') (input.args.includes('-N') ? tunnels : workers).push(child);
      return child;
    },
    stopProcess: async child => child.finish({ code: 0 }),
    waitForDaemonReady: async () => {},
    waitForRetry: async ({ delayMs }) => {
      delays.push(delayMs);
      if (delays.length === 3) { observeRecovery(null); await new Promise(() => {}); }
    }, logger: { error() {}, info() {} },
  });
  try {
    await running;
    transportDropped = true;
    workers[0].finish({ code: 255 });
    const recovered = await recovery;
    assert.ok(recovered, 'an alive SSH process cannot prove a failed reverse listener is usable');
    assert.equal(recovered.serviceStatus.daemon, 'running');
    assert.equal(tunnels.length, 2);
    assert.deepEqual(tunnels[1].args, tunnels[0].args, 'recovery preserves the existing port and Home bindings');
    assert.equal(tunnels[0].exitCode, 0, 'the failed forward must be retired before replacement');
    assert.deepEqual(delays, [5_000, 10_000], 'the target lifecycle remains the only recovery backoff owner');
    const replacementCommand = platform === 'windows'
      ? Buffer.from(workers[1].args.at(-1).split(' -EncodedCommand ').at(-1), 'base64').toString('utf16le')
      : workers[1].args.at(-1);
    assert.match(replacementCommand, /--reuse-source-runtime/);
    assert.match(replacementCommand, /--restart/);
    assert.deepEqual(recovered.sourceRuntimeIdentities.daemon, { selected: 'retained', loaded: 'retained' });
  } finally { await controller.close(); }
});
}

test('remote Expo readiness failure keeps the worker and tunnel while retrying readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-expo-readiness-retry-'));
  const targetStates = [];
  const spawnedProcesses = [];
  let readinessAttempts = 0;
  let notifyRunning;
  const running = new Promise((resolve) => {
    notifyRunning = resolve;
  });
  const target = {
    name: 'mac',
    platform: 'posix',
    ssh: 'mac-ssh',
    repoDir: '/Users/test/happier',
    cliHomeDir: '/Users/test/.happier/mac',
  };
  let controller;
  try {
    controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        localExpoPort: 18081,
        expoListenHost: '0.0.0.0',
        startMobile: true,
        activeServerId: 'stack_repo-test__id_default',
        credentialPath: null,
        targetPlans: [{
          target,
          commands: false,
          services: { server: false, expo: true, daemon: false },
        }],
        onTargetStateChange: (state) => {
          targetStates.push(state);
          if (state.status === 'running') notifyRunning();
        },
        env: {},
      },
      {
        runDependencyBootstrap: successfulDependencyBootstrap,
        runProcess: async () => ({ code: 0 }),
        spawnProcess: ({ label, command, args, env }) => {
          const child = { label, command, args, env, exitCode: null };
          spawnedProcesses.push(child);
          return child;
        },
        stopProcess: async (child) => {
          child.exitCode = 0;
        },
        waitForRetry: async () => {},
        waitForExpoReady: async () => {
          readinessAttempts += 1;
          if (readinessAttempts === 1) throw new Error('Metro did not answer');
        },
        logger: { error() {} },
      },
    );

    const recovered = await Promise.race([
      running.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(recovered, true, 'expected the remote Expo worker to be retried');
    assert.deepEqual(
      targetStates
        .filter(({ status }) => status !== 'starting')
        .map(({ status, phase }) => ({ status, phase })),
      [
        { status: 'degraded', phase: 'expo-readiness' },
        { status: 'running', phase: null },
      ],
    );
    assert.ok(targetStates.every((state) => state.services.expo === true));
    assert.equal(
      spawnedProcesses.filter((child) => child.command === 'ssh' && !child.args.includes('-N')).length,
      1,
      'readiness recovery must preserve the remote worker',
    );
    assert.equal(
      spawnedProcesses.filter((child) => child.command === 'ssh' && child.args.includes('-N')).length,
      1,
      'readiness recovery must preserve the still-healthy Expo tunnel',
    );
  } finally {
    await controller?.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('dev target processes are tagged as Stack-owned infrastructure for owner-death cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-infra-ownership-'));
  const credentialPath = join(root, 'access.key');
  const spawned = [];
  const mutagenControlEnvs = [];
  await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });
  try {
    const controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        activeServerId: 'stack_repo-test__id_default',
        credentialPath,
        targets: [{ name: 'windows', platform: 'windows', ssh: 'windows-ssh', repoDir: 'C:/happier', cliHomeDir: 'C:/Users/test/.happier/windows' }],
        env: { HAPPIER_STACK_STACK: 'repo-test' },
      },
      {
        runDependencyBootstrap: successfulDependencyBootstrap,
        runProcess: async ({ command, env }) => {
          if (command === 'mutagen') mutagenControlEnvs.push(env);
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env }) => {
          const child = { label, command, args, env, exitCode: null };
          spawned.push(child);
          return child;
        },
        stopProcess: async (child) => { child.exitCode = 0; },
      },
    );
    assert.ok(spawned.length >= 3, 'expected Mutagen monitor, reverse tunnel, and remote worker');
    for (const child of spawned) {
      assert.equal(child.env.HAPPIER_STACK_PROCESS_KIND, 'infra', `${child.label} must be owner-death sweepable`);
    }
    assert.ok(mutagenControlEnvs.length > 0, 'expected Mutagen control commands');
    for (const controlEnv of mutagenControlEnvs) {
      assert.notEqual(
        controlEnv.HAPPIER_STACK_PROCESS_KIND,
        'infra',
        'Mutagen control commands may auto-start the persistent per-stack daemon',
      );
    }
    await controller.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('remote worker exit reuses its independent healthy reverse tunnel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-worker-tunnel-'));
  const credentialPath = join(root, 'access.key');
  const tunnels = [];
  const workers = [];
  let controller = null;
  await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });

  try {
    controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        activeServerId: 'stack_repo-test__id_default',
        credentialPath,
        targets: [{
          name: 'linux',
          platform: 'posix',
          ssh: 'linux-ssh',
          repoDir: '/home/dev/happier',
          cliHomeDir: '/home/dev/.happier/linux',
        }],
        env: {},
      },
      {
        runDependencyBootstrap: successfulDependencyBootstrap,
        runProcess: async () => ({ code: 0 }),
        spawnProcess: ({ label, command, args, env }) => {
          if (label === 'mutagen') {
            return { label, command, args, env, exitCode: null };
          }
          let resolveCompletion;
          const completion = new Promise((resolve) => {
            resolveCompletion = resolve;
          });
          const child = {
            label,
            command,
            args,
            env,
            exitCode: null,
            completion,
            resolveCompletion,
          };
          if (args.includes('-N')) tunnels.push(child);
          else workers.push(child);
          return child;
        },
        stopProcess: async (child) => {
          if (!child || child.exitCode != null) return;
          child.exitCode = 0;
          child.resolveCompletion?.({ code: 0, signal: 'SIGINT' });
        },
        waitForRetry: async () => {},
        logger: { error() {} },
      },
    );

    assert.equal(tunnels.length, 1, 'reverse forwarding must have its own SSH lifetime');
    assert.equal(workers.length, 1, 'the remote hstack command must have its own monitored SSH lifetime');
    workers[0].exitCode = 1;
    workers[0].resolveCompletion({ code: 1, signal: null });

    const retried = await Promise.race([
      new Promise((resolve) => {
        const poll = () => {
          if (workers.length >= 2) resolve(true);
          else setTimeout(poll, 1);
        };
        poll();
      }),
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(retried, true);
    assert.equal(tunnels.length, 1, 'worker recovery should not replace a healthy reverse tunnel');
    assert.equal(tunnels[0].exitCode, null, 'the healthy reverse tunnel should remain active');

    tunnels[0].exitCode = 1;
    tunnels[0].resolveCompletion({ code: 1, signal: null });
    const tunnelReplaced = await Promise.race([
      new Promise((resolve) => {
        const poll = () => {
          if (workers.length >= 3 && tunnels.length >= 2) resolve(true);
          else setTimeout(poll, 1);
        };
        poll();
      }),
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(tunnelReplaced, true, 'a failed reverse tunnel should restart the full transport');
  } finally {
    await controller?.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('server and Expo targets bypass shared daemon workspace preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-scoped-workspace-preparation-'));
  const calls = [];
  const spawned = [];
  const stopped = [];
  let resolveWorkspacePreparation;
  let markServerReady;
  let startup = null;
  let controller = null;
  const workspacePreparation = new Promise((resolve) => {
    resolveWorkspacePreparation = resolve;
  });
  const serverReady = new Promise((resolve) => {
    markServerReady = resolve;
  });
  const serverTarget = {
    name: 'mac-server',
    platform: 'posix',
    ssh: 'mac-server-ssh',
    repoDir: '/Users/test/happier',
    cliHomeDir: '/Users/test/.happier/mac-server',
  };
  const expoTarget = {
    name: 'guest-expo',
    platform: 'posix',
    ssh: 'guest-expo-ssh',
    repoDir: '/home/test/happier',
    cliHomeDir: '/home/test/.happier/guest-expo',
  };

  try {
    startup = startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        localExpoPort: 8081,
        publicServerUrl: 'http://127.0.0.1:3005',
        activeServerId: 'stack_repo-test__id_default',
        credentialPath: null,
        remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
        remoteWorkspacePreparation: workspacePreparation,
        targetPlans: [
          {
            target: serverTarget,
            commands: false,
            services: { server: true, expo: false, daemon: false },
          },
          {
            target: expoTarget,
            commands: false,
            services: { server: false, expo: true, daemon: false },
          },
        ],
        env: {},
      },
      {
        runDependencyBootstrap: async ({ target }) => {
          calls.push({ kind: 'bootstrap', target: target.name });
          return { code: 0 };
        },
        runProcess: async ({ label, command, args, env }) => {
          calls.push({ kind: 'run', label, command, args, env });
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env }) => {
          const child = { label, command, args, env, exitCode: null };
          calls.push({ kind: 'spawn', ...child });
          spawned.push(child);
          return child;
        },
        stopProcess: async (child) => {
          stopped.push(child);
          child.exitCode = 0;
        },
        waitForServerReady: async ({ target }) => {
          calls.push({ kind: 'server-ready', target: target.name });
          markServerReady();
        },
        waitForExpoReady: async () => {},
      },
    );

    await serverReady;
    assert.ok(calls.some((call) => call.kind === 'bootstrap' && call.target === serverTarget.name));
    assert.ok(calls.some((call) => (
      call.kind === 'spawn'
      && call.label === `remote:${serverTarget.name}`
      && call.args.includes('-N')
    )));
    assert.ok(calls.some((call) => (
      call.kind === 'spawn'
      && call.label === `remote:${serverTarget.name}`
      && !call.args.includes('-N')
    )));
    assert.ok(calls.some((call) => call.kind === 'server-ready' && call.target === serverTarget.name));
    assert.equal(
      calls.some((call) => call.kind === 'bootstrap' && call.target === expoTarget.name),
      true,
      'an Expo plan must use its remote UI preflight instead of waiting for local CLI preparation',
    );
    assert.equal(
      calls.some((call) => call.kind === 'spawn' && call.label === `remote:${expoTarget.name}`),
      true,
      'an Expo plan must start its tunnel and worker independently of local CLI preparation',
    );

    resolveWorkspacePreparation();
    controller = await startup;
    assert.ok(calls.some((call) => call.kind === 'bootstrap' && call.target === expoTarget.name));
    assert.ok(calls.some((call) => (
      call.kind === 'spawn'
      && call.label === `remote:${expoTarget.name}`
      && !call.args.includes('-N')
    )));

    await controller.close();
    controller = null;
    assert.equal(stopped.length, spawned.length, 'one close must reclaim every supervisor-owned worker and tunnel');
    assert.ok(spawned.every((child) => child.exitCode === 0));
  } finally {
    resolveWorkspacePreparation?.();
    controller ??= await startup?.catch(() => null);
    await controller?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('failed deferred workspace preparation is typed and never launches a last-green worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-companion-refusal-'));
  let releaseRetry;
  const retryGate = new Promise(resolve => { releaseRetry = resolve; });
  let controller = null;
  try {
    const credentialPath = join(root, 'access.key');
    await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });
    const target = { name: 'mac-refusal', platform: 'posix', ssh: 'mac-refusal-ssh',
      repoDir: '/Users/test/happier', cliHomeDir: '/Users/test/.happier/mac-refusal' };
    const states = [];
    controller = await startStackDevTargets({
      stackName: 'repo-test-refusal', stackBaseDir: join(root, 'stack'), sourceDir: repoDir,
      localServerPort: 3005, localExpoPort: 8081, publicServerUrl: 'http://127.0.0.1:3005',
      activeServerId: 'stack_repo-test-refusal__id_default', credentialPath,
      remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
      remoteWorkspacePreparation: async () => { throw new Error('current companion build failed'); },
      targetPlans: [{ target, commands: false, services: { server: true, expo: false, daemon: true } }],
      onTargetStateChange: state => states.push(state), env: {},
    }, {
      runProcess: async () => ({ code: 0 }),
      spawnProcess: ({ label, command, args, env }) => ({ label, command, args, env, exitCode: null }),
      stopProcess: async child => { child.exitCode = 0; },
      waitForRetry: async () => await retryGate,
      logger: { error() {} },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(controller.workers.length, 0, 'failed companion preparation must not launch a last-green Stack worker');
    assert.equal(controller.targetFailures.at(-1)?.error?.code, 'source_companion_preparation_failed');
    assert.ok(states.some(state => state.status === 'retrying' && state.phase === 'bootstrap'));
    assert.equal(states.some(state => state.status === 'running'), false);
  } finally {
    const close = controller?.close();
    releaseRetry?.();
    await close;
    await rm(root, { recursive: true, force: true });
  }
});

test('a co-located server stays available without opening the daemon gate when later companion preparation fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-server-first-preparation-'));
  try {
    for (const [index, scenario] of [
      {
        name: 'dependency bootstrap',
        createWorkspacePreparation: () => Promise.resolve(),
        bootstrapResult: { code: 1 },
        expectedBootstrapCalls: 1,
        expectedCredentialTransfers: 0,
      },
      {
        name: 'credential transfer',
        createWorkspacePreparation: () => Promise.resolve(),
        bootstrapResult: { code: 0 },
        expectedBootstrapCalls: 1,
        expectedCredentialTransfers: 1,
        processResult: ({ command }) => (command === 'scp' ? { code: 1 } : { code: 0 }),
      },
    ].entries()) {
      const spawned = [];
      const targetStates = [];
      const processCalls = [];
      const workspacePreparation = scenario.createWorkspacePreparation();
      let releaseRetry;
      const retryGate = new Promise((resolve) => {
        releaseRetry = resolve;
      });
      let serverReadinessCalls = 0;
      let dependencyBootstrapCalls = 0;
      let controller = null;
      const credentialPath = join(root, `${index}.access.key`);
      const target = {
        name: `mac-${index}`,
        platform: 'posix',
        ssh: `mac-${index}-ssh`,
        repoDir: '/Users/test/happier',
        cliHomeDir: `/Users/test/.happier/mac-${index}`,
      };

      // The caller owns diagnostic reporting for this shared promise. Keep the
      // test focused on whether its rejection can still gate the server worker.
      void workspacePreparation.catch(() => {});

      try {
        await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });
        controller = await startStackDevTargets(
          {
            stackName: `repo-test-${index}`,
            stackBaseDir: join(root, `stack-${index}`),
            sourceDir: repoDir,
            localServerPort: 3005 + index,
            localExpoPort: 8081 + index,
            publicServerUrl: `http://127.0.0.1:${3005 + index}`,
            activeServerId: `stack_repo-test-${index}__id_default`,
            credentialPath,
            remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
            remoteWorkspacePreparation: workspacePreparation,
            targetPlans: [{
              target,
              commands: false,
              services: { server: true, expo: true, daemon: true },
            }],
            onTargetStateChange: (state) => targetStates.push(state),
            env: {},
          },
          {
            runDependencyBootstrap: async () => {
              dependencyBootstrapCalls += 1;
              processCalls.push({ command: 'dependency-bootstrap' });
              return scenario.bootstrapResult;
            },
            runProcess: async (input) => {
              processCalls.push(input);
              return scenario.processResult?.(input) ?? { code: 0 };
            },
            spawnProcess: ({ label, command, args, env }) => {
              const child = { label, command, args, env, exitCode: null };
              spawned.push(child);
              return child;
            },
            stopProcess: async (child) => {
              child.exitCode = 0;
            },
            waitForServerReady: async () => {
              serverReadinessCalls += 1;
            },
            waitForRetry: async () => await retryGate,
            logger: { error() {} },
          },
        );

        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(
          spawned.filter((child) => child.label === `remote:${target.name}` && !child.args.includes('-N')).length,
          1,
          `${scenario.name}: the single remote Stack worker must start before deferred companion preparation can fail`,
        );
        assert.equal(serverReadinessCalls, 1, `${scenario.name}: the server must reach its tunneled readiness path first`);
        assert.equal(dependencyBootstrapCalls, scenario.expectedBootstrapCalls);
        assert.equal(
          processCalls.filter(({ command }) => command === 'scp').length,
          scenario.expectedCredentialTransfers,
        );
        const credentialTransferIndex = processCalls.findIndex(({ command }) => command === 'scp');
        if (credentialTransferIndex >= 0 && dependencyBootstrapCalls > 0) {
          const dependencyBootstrapIndex = processCalls.findIndex(({ command }) => command === 'dependency-bootstrap');
          assert.ok(
            dependencyBootstrapIndex < credentialTransferIndex,
            `${scenario.name}: daemon credentials must remain unavailable until companion preparation succeeds`,
          );
        }
        assert.ok(
          targetStates.some((state) => (
            state.status === 'degraded'
            && state.serviceStatus?.server === 'running'
            && state.serviceStatus?.expo === 'degraded'
            && state.serviceStatus?.daemon === 'degraded'
          )),
          `${scenario.name}: preparation failure must degrade only companion services after the server is available`,
        );
        assert.equal(
          controller.targetFailures.at(-1)?.error?.code,
          'source_companion_preparation_failed',
          `${scenario.name}: companion preparation failure must remain typed`,
        );
        assert.equal(
          targetStates.some((state) => state.status === 'running' || state.serviceStatus?.daemon === 'running'),
          false,
          `${scenario.name}: a failed companion preparation must not declare the stale daemon running`,
        );
      } finally {
        const close = controller?.close();
        releaseRetry?.();
        await close;
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a co-located worker launches only after current workspace bytes reach its target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-worker-workspace-order-'));
  const events = [];
  let releaseWorkspacePreparation;
  const workspacePreparationRelease = new Promise((resolve) => {
    releaseWorkspacePreparation = resolve;
  });
  let markWorkspacePreparationEntered;
  const workspacePreparationEntered = new Promise((resolve) => {
    markWorkspacePreparationEntered = resolve;
  });
  let controller = null;
  try {
    const credentialPath = join(root, 'access.key');
    await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });
    const target = {
      name: 'mac-current-workspace',
      platform: 'posix',
      ssh: 'mac-current-workspace-ssh',
      repoDir: '/Users/test/happier',
      cliHomeDir: '/Users/test/.happier/mac-current-workspace',
    };
    const startup = startStackDevTargets({
      stackName: 'repo-test-current-workspace',
      stackBaseDir: join(root, 'stack'),
      sourceDir: repoDir,
      localServerPort: 3005,
      localExpoPort: 8081,
      publicServerUrl: 'http://127.0.0.1:3005',
      activeServerId: 'stack_repo-test-current-workspace__id_default',
      credentialPath,
      remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
      remoteWorkspacePreparation: async () => {
        events.push('workspace:begin');
        markWorkspacePreparationEntered();
        await workspacePreparationRelease;
        events.push('workspace:ready');
      },
      targetPlans: [{
        target,
        commands: false,
        services: { server: true, expo: true, daemon: true },
      }],
      env: {},
    }, {
      runProcess: async () => ({ code: 0 }),
      flushSync: async () => { events.push('sync:flush'); },
      runDependencyBootstrap: async () => ({ code: 0 }),
      spawnProcess: ({ label, command, args, env }) => {
        const worker = { label, command, args, env, exitCode: null };
        if (label === `remote:${target.name}`) {
          events.push(args.includes('-N') ? 'tunnel:spawn' : 'worker:spawn');
        }
        return worker;
      },
      stopProcess: async (worker) => { worker.exitCode = 0; },
      waitForProcess: async () => await new Promise(() => {}),
      waitForServerReady: async () => {},
      waitForExpoReady: async () => {},
      waitForRetry: async () => await new Promise(() => {}),
      logger: { error() {}, warn() {} },
    });

    await workspacePreparationEntered;
    assert.equal(events.includes('worker:spawn'), false);
    releaseWorkspacePreparation();
    controller = await startup;
    const deadline = Date.now() + 1_000;
    while (!events.includes('worker:spawn') && Date.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(events.indexOf('workspace:ready') < events.indexOf('sync:flush'));
    assert.ok(events.indexOf('sync:flush') < events.indexOf('worker:spawn'));
  } finally {
    releaseWorkspacePreparation?.();
    await controller?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('deferred companion preparation recreates failed workspace work on retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-workspace-preparation-retry-'));
  const targetStates = [];
  const spawned = [];
  let preparationCalls = 0;
  let controller = null;
  try {
    const credentialPath = join(root, 'access.key');
    await writeFile(credentialPath, '{"token":"test-token"}\n', 'utf8');
    const target = {
      name: 'mac-retry',
      platform: 'posix',
      ssh: 'mac-retry-ssh',
      repoDir: '/Users/test/happier',
      cliHomeDir: '/Users/test/.happier/mac-retry',
    };
    controller = await startStackDevTargets({
      stackName: 'repo-test-retry',
      stackBaseDir: join(root, 'stack'),
      sourceDir: repoDir,
      localServerPort: 3005,
      localExpoPort: 8081,
      publicServerUrl: 'http://127.0.0.1:3005',
      activeServerId: 'stack_repo-test-retry__id_default',
      credentialPath,
      remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
      remoteWorkspacePreparation: async () => {
        preparationCalls += 1;
        if (preparationCalls === 1) throw new Error('first generated-input publication failed');
      },
      targetPlans: [{
        target,
        commands: false,
        services: { server: true, expo: true, daemon: true },
      }],
      onTargetStateChange: (state) => targetStates.push(state),
      env: {},
    }, {
      runDependencyBootstrap: async () => ({ code: 0 }),
      runProcess: async () => ({ code: 0 }),
      spawnProcess: ({ label, command, args, env }) => {
        const child = { label, command, args, env, exitCode: null };
        spawned.push(child);
        return child;
      },
      stopProcess: async (child) => {
        child.exitCode = 0;
      },
      waitForProcess: async () => await new Promise(() => {}),
      waitForServerReady: async () => {},
      waitForExpoReady: async () => {},
      waitForRetry: async () => {},
      logger: { error() {} },
    });

    const recovered = await Promise.race([
      new Promise((resolve) => {
        const poll = () => {
          if (targetStates.some((state) => state.status === 'running')) resolve(true);
          else setTimeout(poll, 1);
        };
        poll();
      }),
      new Promise((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    assert.equal(recovered, true);
    assert.equal(preparationCalls, 2);
    assert.equal(targetStates.some((state) => state.status === 'degraded'), false);
  } finally {
    await controller?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a co-located target keeps credentials unavailable while companion publication is pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-credential-first-'));
  const spawned = [];
  const processCalls = [];
  let dependencyBootstrapCalls = 0;
  let releaseWorkspacePreparation;
  const workspacePreparationPending = new Promise((resolve) => {
    releaseWorkspacePreparation = resolve;
  });
  let controller = null;
  try {
    const credentialPath = join(root, 'access.key');
    await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });
    const target = {
      name: 'mac',
      platform: 'posix',
      ssh: 'mac-ssh',
      repoDir: '/Users/test/happier',
      cliHomeDir: '/Users/test/.happier/mac',
    };

    const startup = startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        localExpoPort: 8081,
        publicServerUrl: 'http://127.0.0.1:3005',
        activeServerId: 'stack_repo-test__id_default',
        credentialPath,
        remoteServerRuntimeConfig: remoteLightSqliteRuntimeConfig,
        remoteWorkspacePreparation: workspacePreparationPending,
        targetPlans: [{
          target,
          commands: false,
          services: { server: true, expo: true, daemon: true },
        }],
        env: {},
      },
      {
        runDependencyBootstrap: async () => {
          dependencyBootstrapCalls += 1;
          return { code: 0 };
        },
        runProcess: async (input) => {
          processCalls.push(input);
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env }) => {
          const child = { label, command, args, env, exitCode: null };
          spawned.push(child);
          return child;
        },
        stopProcess: async (child) => {
          child.exitCode = 0;
        },
        waitForProcess: async () => await new Promise(() => {}),
        waitForServerReady: async () => await new Promise(() => {}),
      },
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      spawned.filter((child) => child.label === 'remote:mac' && !child.args.includes('-N')).length,
      0,
      'the remote Stack worker must wait for the current workspace publication',
    );
    assert.equal(
      processCalls.filter(({ command }) => command === 'scp').length,
      0,
      'daemon credentials must remain unavailable while companion publication is pending',
    );
    assert.equal(
      dependencyBootstrapCalls,
      0,
      'workspace and dependency preparation must remain deferred until the server is ready',
    );
    releaseWorkspacePreparation();
    controller = await startup;
    assert.equal(
      spawned.filter((child) => child.label === 'remote:mac' && !child.args.includes('-N')).length,
      1,
      'the remote Stack worker starts once current workspace bytes have been flushed',
    );
    assert.equal(
      processCalls.filter(({ command }) => command === 'scp').length,
      0,
      'the daemon gate remains closed until post-server companion bootstrap succeeds',
    );
  } finally {
    releaseWorkspacePreparation?.();
    await controller?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a slow target preparation does not delay another target worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-parallel-'));
  const calls = [];
  let releaseWindowsPreparation;
  let markWindowsPreparationStarted;
  const windowsPreparationPending = new Promise((resolve) => {
    releaseWindowsPreparation = resolve;
  });
  const windowsPreparationStarted = new Promise((resolve) => {
    markWindowsPreparationStarted = resolve;
  });
  const credentialPath = join(root, 'access.key');
  await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });
  try {
    const startup = startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        activeServerId: 'stack_repo-test__id_default',
        credentialPath,
        targets: [
          {
            name: 'windows',
            platform: 'windows',
            ssh: 'windows-ssh',
            repoDir: 'C:/Users/dev/happier',
            cliHomeDir: 'C:/Users/dev/.happier/windows',
          },
          {
            name: 'linux',
            platform: 'posix',
            ssh: 'linux-ssh',
            repoDir: '/home/dev/happier',
            cliHomeDir: '/home/dev/.happier/linux',
          },
        ],
        env: {},
      },
      {
        runDependencyBootstrap: successfulDependencyBootstrap,
        runProcess: async ({ label, command, args, env }) => {
          calls.push({ kind: 'run', label, command, args, env });
          if (
            command === 'ssh' &&
            args.includes('windows-ssh')
          ) {
            markWindowsPreparationStarted();
            return await windowsPreparationPending;
          }
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env }) => {
          const worker = { label, command, args, env, exitCode: null };
          calls.push({ kind: 'spawn', ...worker });
          return worker;
        },
        stopProcess: async (worker) => {
          worker.exitCode = 0;
        },
      },
    );

    await windowsPreparationStarted;
    await new Promise((resolve) => setImmediate(resolve));
    const linuxStartedWhileWindowsPreparationWasPending = calls.some(
      (call) => call.kind === 'spawn' && call.label === 'remote:linux',
    );
    releaseWindowsPreparation({ code: 0 });
    const controller = await startup;
    assert.equal(linuxStartedWhileWindowsPreparationWasPending, true);
    await controller.close();
  } finally {
    releaseWindowsPreparation?.({ code: 0 });
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed target retries while another target is still preparing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-parallel-retry-'));
  let releaseWindowsPreparation;
  let markWindowsPreparationStarted;
  let markLinuxWorkerStarted;
  let linuxProbeAttempts = 0;
  const windowsPreparationPending = new Promise((resolve) => {
    releaseWindowsPreparation = resolve;
  });
  const windowsPreparationStarted = new Promise((resolve) => {
    markWindowsPreparationStarted = resolve;
  });
  const linuxWorkerStarted = new Promise((resolve) => {
    markLinuxWorkerStarted = resolve;
  });
  const credentialPath = join(root, 'access.key');
  await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });
  let controller;
  try {
    const startup = startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        activeServerId: 'stack_repo-test__id_default',
        credentialPath,
        targets: [
          {
            name: 'windows',
            platform: 'windows',
            ssh: 'windows-ssh',
            repoDir: 'C:/Users/dev/happier',
            cliHomeDir: 'C:/Users/dev/.happier/windows',
          },
          {
            name: 'linux',
            platform: 'posix',
            ssh: 'linux-ssh',
            repoDir: '/home/dev/happier',
            cliHomeDir: '/home/dev/.happier/linux',
          },
        ],
        env: {},
      },
      {
        runDependencyBootstrap: successfulDependencyBootstrap,
        runProcess: async ({ command, args }) => {
          if (command === 'ssh' && args.includes('windows-ssh')) {
            markWindowsPreparationStarted();
            return await windowsPreparationPending;
          }
          if (
            command === 'ssh'
            && args.some((arg) => String(arg).includes('/dev/tcp/127.0.0.1/'))
          ) {
            linuxProbeAttempts += 1;
            if (linuxProbeAttempts === 1) return { code: 1 };
          }
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env }) => {
          const worker = { label, command, args, env, exitCode: null };
          if (label === 'remote:linux' && !args.includes('-N')) markLinuxWorkerStarted();
          return worker;
        },
        stopProcess: async (worker) => {
          worker.exitCode = 0;
        },
        waitForRetry: async () => {},
        logger: { error() {} },
      },
    );

    await windowsPreparationStarted;
    const retriedBeforeWindowsFinished = await Promise.race([
      linuxWorkerStarted.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    releaseWindowsPreparation({ code: 0 });
    controller = await startup;
    assert.equal(
      retriedBeforeWindowsFinished,
      true,
      'the failed Linux target should not wait for the unrelated Windows preparation',
    );
  } finally {
    releaseWindowsPreparation?.({ code: 0 });
    await controller?.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('dev target supervisor borrows producer synchronization before remote bootstrap and cleans up only its consumers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-targets-'));
  const calls = [];
  let nextWorkerPid = 1234;
  const target = {
    name: 'linux',
    platform: 'posix',
    ssh: 'linux-ssh',
    repoDir: '/home/dev/happier',
    cliHomeDir: '/home/dev/.happier/linux',
    remoteServerPort: 43005,
  };
  try {
    const credentialPath = join(root, 'access.key');
    target.sshConfigFile = join(root, 'lima.ssh.config');
    await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });
    await writeFile(target.sshConfigFile, 'Host linux-ssh\n  Hostname 127.0.0.1\n');
    await mkdir(join(root, 'stack'), { recursive: true });

    const controller = await startStackDevTargets(
      {
        stackName: 'repo-test',
        stackBaseDir: join(root, 'stack'),
        sourceDir: repoDir,
        localServerPort: 3005,
        activeServerId: 'stack_repo-test__id_default',
        credentialPath,
        targets: [target],
        env: {},
      },
      {
        runDependencyBootstrap: async () => {
          calls.push({ kind: 'bootstrap', label: 'remote:linux' });
          return { code: 0 };
        },
        runProcess: async ({ label, command, args, env }) => {
          calls.push({ kind: 'run', label, command, args, env });
          if (command === 'mutagen' && args.includes('terminate')) {
            return { code: 1 };
          }
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env }) => {
          calls.push({ kind: 'spawn', label, command, args, env });
          return { pid: nextWorkerPid++, label, exitCode: null };
        },
        stopProcess: async (child) => {
          calls.push({ kind: 'stop', label: child.label, child });
          child.exitCode = 0;
        },
        waitForDaemonReady: async () => {},
      },
    );

    const runtime = resolveDevTargetMutagenRuntime({stackBaseDir: join(root, 'stack'), sourceDir: repoDir, env: {HAPPIER_STACK_STORAGE_DIR: join(root, 'stack')}});
    const project = await readFile(runtime.projectFile, 'utf8');
    assert.match(project, /linux-ssh:\/home\/dev\/happier/);
    const generatedSshConfig = await readFile(
      join(runtime.opensshDir, 'config'),
      'utf8',
    );
    assert.ok(
      generatedSshConfig.indexOf(target.sshConfigFile)
        < generatedSshConfig.indexOf(join(homedir(), '.ssh', 'config')),
      'target-specific SSH values must precede broad user config defaults',
    );
    assert.ok(calls.filter(call => call.command === 'mutagen').every(call => !call.args.some(arg => ['start','resume','pause','terminate'].includes(arg))));
    const tunnelSpawn = calls.find(
      (call) => call.kind === 'spawn' && call.label === 'remote:linux' && call.args.includes('-N'),
    );
    const workerSpawn = calls.find(
      (call) => call.kind === 'spawn' && call.label === 'remote:linux' && !call.args.includes('-N'),
    );
    assert.match(tunnelSpawn.args.join(' '), /-R 127\.0\.0\.1:43005:127\.0\.0\.1:3005/);
    assert.doesNotMatch(workerSpawn.args.join(' '), /-R /);
    assert.ok(
      calls.filter((call) => call.command === 'ssh' || call.command === 'scp')
        .every((call) => call.args.includes('-F')),
    );
    assert.ok(tunnelSpawn.args.includes('ControlPath=none'), 'the forward retains its own stop custody');
    assert.equal(workerSpawn.args.includes('ControlMaster=no'), false, 'runtime workers reuse the configured master without owning its lifetime');
    assert.equal(calls.filter(call => call.kind === 'run' && call.command === 'ssh'
      && !String(call.args.at(-1)).includes('stack stop')
      && !String(call.args.at(-1)).includes('stack.runtime.json'))
      .some(call => call.args.includes('ControlPath=none')), false, 'ordinary readiness and bootstrap commands reuse the configured master');
    assert.equal(
      calls.some((call) => call.command === 'mutagen' && call.args.includes('flush')),
      false,
    );

    await controller.close();
    assert.deepEqual(
      calls.filter(call => call.kind === 'stop').map(call => call.label).sort(),
      ['mutagen', 'remote:linux', 'remote:linux'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a cold supervisor fails closed without creating or terminating producer synchronization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-cleanup-'));
  const calls = [];
  const target = {
    name: 'linux',
    platform: 'posix',
    ssh: 'linux-ssh',
    repoDir: '/home/dev/happier',
    cliHomeDir: '/home/dev/.happier/linux',
    remoteServerPort: null,
  };
  try {
    const credentialPath = join(root, 'access.key');
    await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });
    await assert.rejects(
      startStackDevTargetsImpl(
        {
          stackName: 'repo-test',
          stackBaseDir: join(root, 'stack'),
          sourceDir: repoDir,
          localServerPort: 3005,
          activeServerId: 'stack_repo-test__id_default',
          credentialPath,
          targets: [target],
          env: { HAPPIER_STACK_STORAGE_DIR: root },
        },
        {
          runDependencyBootstrap: successfulDependencyBootstrap,
          runProcess: async ({ command, args }) => {
            calls.push({ command, args });
            if (command === 'mutagen' && args[0] === 'sync' && args.includes('resume')) return { code: 1 };
            return { code: 0 };
          },
          spawnProcess: ({ label, command, args, env }) => ({
            label,
            command,
            args,
            env,
            exitCode: null,
          }),
          stopProcess: async (worker) => {
            worker.exitCode = 0;
          },
        },
      ),
      /requires the producer synchronization/,
    );

    const mutagenCommands = calls
      .filter((call) => call.command === 'mutagen')
      .map((call) => call.args.find((arg) => ['version', 'terminate', 'start', 'list', 'resume', 'flush'].includes(arg)));
    assert.deepEqual(mutagenCommands, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
