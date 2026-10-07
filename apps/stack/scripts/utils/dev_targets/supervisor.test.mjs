import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  planRequiresRemoteCliWorkspacePreparation,
  resolveDefaultRemoteServerPort,
  resolveRemoteServerReadyTimeoutMs,
  startStackDevTargets,
  startStackDevTargetsInBackground,
} from './supervisor.mjs';
import { renderMutagenProject, resolveMutagenSessionName } from './mutagen_project.mjs';
import { resolveRemoteStackStatePaths } from './remote_commands.mjs';
import { writeManagedRuntimeSnapshotLayout } from '../../testkit/core/runtime_snapshot_layout.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

const successfulDependencyBootstrap = async () => ({ code: 0 });

const remoteLightSqliteRuntimeConfig = Object.freeze({
  serverComponentName: 'happier-server-light',
  dbProvider: 'sqlite',
  environment: {},
});

async function writeProducerSyncProject(stackBaseDir, sourceDir, target) {
  await mkdir(join(stackBaseDir, 'mutagen'), { recursive: true });
  await writeFile(join(stackBaseDir, 'mutagen/mutagen.yml'), renderMutagenProject({ sourceDir, targets: [target], ownerId: 'producer' }));
}

function readySyncResult(target) {
  return { code: 0, out: JSON.stringify([{ name: resolveMutagenSessionName(target.name), paused: false, status: 'watching', conflicts: [], excludedConflicts: 0,
    successfulCycles: 1, alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }]) };
}

test('controlled lifecycle fails closed before a worker starts when retained-data admission fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-controlled-admission-'));
  const target = { name: 'linux', platform: 'posix', ssh: 'linux-ssh', repoDir: '/remote/repo', cliHomeDir: '/remote/cli' };
  const spawned = [];
  let controller;
  try {
    await writeProducerSyncProject(root, '/source/repo', target);
    await assert.rejects(async () => {
      controller = await startStackDevTargets({
        stackName: 'agent-qa', stackBaseDir: root, sourceDir: '/source/repo',
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

test('controlled supervisor transfers admitted bytes, waits for loaded identity and stops only its remote stack and forwards', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-controlled-lifecycle-' });
  const snapshot = await writeManagedRuntimeSnapshotLayout({ stackDir: join(root, 'producer') });
  const target = { name: 'linux', platform: 'posix', ssh: 'boundary-ssh', repoDir: process.cwd(), cliHomeDir: join(root, 'remote') };
  const paths = resolveRemoteStackStatePaths(target, { stackName: 'agent-qa', runtimeMode: 'controlled' });
  const syncStackBaseDir = join(root, 'producer-sync');
  await writeProducerSyncProject(syncStackBaseDir, process.cwd(), target);
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
    stackName: 'agent-qa', stackBaseDir: join(root, 'consumer'), sourceDir: process.cwd(),
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
    const worker = spawned.find(child => child.command === 'ssh' && child.args.at(-1).includes('stack start'));
    assert.ok(worker);
    assert.doesNotMatch(worker.args.at(-1), /--watch|stack dev/);
  } finally { await controller.close(); }
  assert.ok(calls.some(input => input.command === 'ssh' && input.args.at(-1).includes('stack stop')));
  assert.ok(spawned.every(child => child.exitCode === 0));
});

test('controlled supervisor imports and verifies each separate server and daemon snapshot', async (t) => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-controlled-mixed-' });
  const serverSnapshot = await writeManagedRuntimeSnapshotLayout({ stackDir: join(root, 'producer'), snapshotId: 'server-selected' });
  const daemonSnapshot = await writeManagedRuntimeSnapshotLayout({ stackDir: join(root, 'producer'), snapshotId: 'daemon-selected' });
  for (const [snapshot, component] of [[serverSnapshot, 'server'], [daemonSnapshot, 'daemon']]) {
    snapshot.manifest.components = { [component]: snapshot.manifest.components[component] };
    await writeFile(join(snapshot.snapshotPath, 'manifest.json'), JSON.stringify(snapshot.manifest));
  }
  const serverTarget = { name: 'server-host', platform: 'posix', ssh: 'server-ssh', repoDir: process.cwd(), cliHomeDir: join(root, 'server-state') };
  const daemonTarget = { name: 'daemon-worker', platform: 'posix', ssh: 'daemon-ssh', repoDir: process.cwd(), cliHomeDir: join(root, 'daemon-state') };
  const syncStackBaseDir = join(root, 'producer-sync');
  await mkdir(join(syncStackBaseDir, 'mutagen'), { recursive: true });
  await writeFile(join(syncStackBaseDir, 'mutagen/mutagen.yml'), renderMutagenProject({ sourceDir: process.cwd(), targets: [serverTarget, daemonTarget], ownerId: 'producer' }));
  const credentialPath = join(root, 'credential');
  await writeFile(credentialPath, '{}');
  const states = [];
  const calls = [];
  const spawned = [];
  const execFileAsync = promisify(execFile);
  let finishRunning;
  const running = new Promise(resolve => { finishRunning = resolve; });
  const controller = await startStackDevTargets({
    stackName: 'agent-qa', stackBaseDir: join(root, 'consumer'), syncStackBaseDir, sourceDir: process.cwd(),
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
  await writeProducerSyncProject(root, process.cwd(), target);
  await assert.rejects(startStackDevTargets({ stackName: 'agent-qa', stackBaseDir: root, sourceDir: process.cwd(),
    localServerPort: 3005, publicServerUrl: 'http://127.0.0.1:3005',
    runtimeSnapshot: { snapshotId: 'qa' }, runtimeTarget: { platform: process.platform, arch: process.arch },
    targetPlans: [{ target, services: { server: true, expo: false, daemon: false } }], env: {},
  }, {
    runProcess: async input => input.command === 'ssh' ? { code: 255 } : readySyncResult(target),
    spawnProcess: input => ({ ...input, exitCode: null }),
    stopProcess: async child => { child.exitCode = 0; }, logger: { error() {} },
  }), error => error.remotePreDispatchUnavailable === true);
  const snapshot = await writeManagedRuntimeSnapshotLayout({ stackDir: join(root, 'producer') });
  let partialArchive;
  const execFileAsync = promisify(execFile);
  await assert.rejects(startStackDevTargets({ stackName: 'agent-qa', stackBaseDir: root, sourceDir: process.cwd(),
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
  }), error => error.remotePreDispatchUnavailable === true);
  await assert.rejects(stat(partialArchive), { code: 'ENOENT' });
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

test('attended remote services become ready before login and seed the daemon after credentials appear', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-auth-recovery-'));
  const cliHomeDir = join(root, 'cli');
  const processCalls = [];
  const targetStates = [];
  const spawned = [];
  let controller;
  let daemonProbes = 0;
  const target = { name: 'mac', platform: 'posix', ssh: 'mac-ssh', repoDir: '/remote/repo', cliHomeDir: '/remote/cli' };
  try {
    controller = await startStackDevTargets({
      stackName: 'repo-test', stackBaseDir: join(root, 'stack'), sourceDir: '/source/repo',
      localServerPort: 3005, localExpoPort: 8081, cliHomeDir, credentialPath: null,
      publicServerUrl: 'http://127.0.0.1:3005',
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
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(targetStates.some((state) => state.serviceStatus.server === 'running' && state.serviceStatus.expo === 'running'));
    assert.equal(daemonProbes, 0, 'remote daemon must not be probed as ready before credential transfer');
    assert.equal(processCalls.filter((call) => call.command === 'scp').length, 0);
    const workersBeforeLogin = spawned.length;
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(join(cliHomeDir, 'access.key'), '{"token":"test-credential"}\n');
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    assert.equal(daemonProbes, 1);
    assert.equal(processCalls.filter((call) => call.command === 'scp').length, 1);
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
        sourceDir: '/source/happier',
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
        sourceDir: '/source/happier',
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
        sourceDir: '/source/happier',
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
      false,
      'prior Stack retirement must retain the target SSH control configuration',
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
        sourceDir: '/source/happier',
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
        sourceDir: '/source/happier',
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
        sourceDir: '/source/happier',
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
        sourceDir: '/source/happier',
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
        sourceDir: '/source/happier',
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
        sourceDir: '/source/happier',
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

test('default remote tunnel port varies by Stack process instance', () => {
  const first = resolveDefaultRemoteServerPort({
    localServerPort: 52753,
    targetIndex: 0,
    instanceId: 100,
  });
  const replacement = resolveDefaultRemoteServerPort({
    localServerPort: 52753,
    targetIndex: 0,
    instanceId: 101,
  });

  assert.notEqual(first, replacement);
  assert.ok(first >= 40_000 && first <= 59_999);
  assert.ok(replacement >= 40_000 && replacement <= 59_999);
});

test('remote server readiness covers the remote package-roll startup budget', () => {
  assert.equal(resolveRemoteServerReadyTimeoutMs({}), 1_800_000);
  assert.equal(
    resolveRemoteServerReadyTimeoutMs({ HAPPIER_STACK_SERVER_READY_TIMEOUT_MS: '90000' }),
    90_000,
  );
});

test('dev target supervisor resumes an equivalent Mutagen project and pauses it on close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-reuse-'));
  const credentialPath = join(root, 'access.key');
  const stackBaseDir = join(root, 'stack');
  const projectFile = join(stackBaseDir, 'mutagen', 'mutagen.yml');
  const sourceDir = '/source/happier';
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
      ['version', 'resume', 'list', 'resume'],
    );
    const claimedProject = await readFile(projectFile, 'utf8');
    assert.match(claimedProject, /^# hstack-owner: "202"$/m);

    await controller.close();
    assert.equal(
      calls.some((call) => call.command === 'mutagen' && call.args.includes('terminate')),
      false,
    );
    assert.equal(
      calls.some((call) => call.command === 'mutagen' && call.args.includes('pause')),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dev target supervisor borrows independent synchronization without mutating its lifecycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-independent-sync-'));
  const stackBaseDir = join(root, 'stack');
  const projectFile = join(stackBaseDir, 'mutagen', 'mutagen.yml');
  const sourceDir = '/source/happier';
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
  const sourceDir = '/source/happier';
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
  const sourceDir = '/source/happier';
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
    sourceDir: '/source/happier',
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
        sourceDir: '/source/happier',
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
          && call.args.at(-1) === 'happier-linux'
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
        sourceDir: '/source/happier',
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
        sourceDir: '/source/happier',
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
        sourceDir: '/source/happier',
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
        sourceDir: '/source/happier',
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
    stackName: 'repo-test', stackBaseDir: root, sourceDir: '/source/repo',
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
    stackName: 'repo-test', stackBaseDir: root, sourceDir: '/source/repo',
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
        sourceDir: '/source/happier',
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

test('remote Expo keeps a newly started tunnel while its reverse forward becomes ready', async () => {
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
        sourceDir: '/source/happier',
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
            return { code: forwardProbeAttempts === 1 ? 1 : 0 };
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
    assert.equal(forwardProbeAttempts, 2);
    assert.equal(tunnels.length, 1, 'readiness retries must retain the live tunnel');
    assert.equal(tunnels[0].exitCode, null);
  } finally {
    await controller?.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

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
        sourceDir: '/source/happier',
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
        sourceDir: '/source/happier',
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
        sourceDir: '/source/happier',
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
        sourceDir: '/source/happier',
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

test('a co-located server stays available when deferred daemon or Expo preparation fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-server-first-preparation-'));
  try {
    for (const [index, scenario] of [
      {
        name: 'workspace rebuild',
        createWorkspacePreparation: () => Promise.reject(new Error('remote workspace rebuild failed')),
        bootstrapResult: { code: 0 },
        expectedBootstrapCalls: 0,
        expectedCredentialTransfers: 1,
      },
      {
        name: 'dependency bootstrap',
        createWorkspacePreparation: () => Promise.resolve(),
        bootstrapResult: { code: 1 },
        expectedBootstrapCalls: 1,
        expectedCredentialTransfers: 1,
      },
      {
        name: 'credential transfer',
        createWorkspacePreparation: () => Promise.resolve(),
        bootstrapResult: { code: 0 },
        expectedBootstrapCalls: 0,
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
            sourceDir: '/source/happier',
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
            credentialTransferIndex < dependencyBootstrapIndex,
            `${scenario.name}: daemon authentication must not wait for dependency refresh`,
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
      sourceDir: '/source/happier',
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
      sourceDir: '/source/happier',
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

test('a co-located target seeds credentials while publication is pending but does not launch stale workspace bytes', async () => {
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
        sourceDir: '/source/happier',
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

    const credentialDeadline = Date.now() + 1_000;
    while (
      processCalls.filter(({ command }) => command === 'scp').length === 0
      && Date.now() < credentialDeadline
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(
      spawned.filter((child) => child.label === 'remote:mac' && !child.args.includes('-N')).length,
      0,
      'the remote Stack worker must wait for the current workspace publication',
    );
    assert.equal(
      processCalls.filter(({ command }) => command === 'scp').length,
      1,
      'credential transfer must begin independently of server readiness',
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
        sourceDir: '/source/happier',
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
        sourceDir: '/source/happier',
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

test('dev target supervisor owns Mutagen publication, remote bootstrap, auth seed, worker, and teardown order', async () => {
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
        sourceDir: '/source/happier',
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

    const project = await readFile(join(root, 'stack', 'mutagen', 'mutagen.yml'), 'utf8');
    assert.match(project, /linux-ssh:\/home\/dev\/happier/);
    const generatedSshConfig = await readFile(
      join(root, 'stack', 'mutagen', 'openssh', 'config'),
      'utf8',
    );
    assert.ok(
      generatedSshConfig.indexOf(target.sshConfigFile)
        < generatedSshConfig.indexOf(join(homedir(), '.ssh', 'config')),
      'target-specific SSH values must precede broad user config defaults',
    );
    assert.deepEqual(
      calls.map((call) => `${call.kind}:${call.label}`),
      [
        'run:mutagen',
        'run:mutagen',
        'run:mutagen',
        'run:mutagen',
        'spawn:mutagen',
        'run:remote:linux',
        'run:remote:linux',
        'run:remote:linux',
        'run:remote:linux',
        'bootstrap:remote:linux',
        'run:remote:linux',
        'spawn:remote:linux',
        'run:remote:linux',
        'spawn:remote:linux',
      ],
    );
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
        .every((call) => call.args.includes('-F') && call.args.includes('ControlMaster=no')),
    );
    assert.match(
      calls.find((call) => call.command === 'mutagen' && call.args.includes('start')).env.MUTAGEN_SSH_PATH,
      /mutagen\/openssh$/,
    );
    assert.equal(
      calls.some((call) => call.command === 'mutagen' && call.args.includes('flush')),
      false,
    );

    await controller.close();
    assert.deepEqual(
      calls.slice(-4).map((call) => `${call.kind}:${call.label}`),
      ['stop:remote:linux', 'stop:remote:linux', 'stop:mutagen', 'run:mutagen'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dev target supervisor terminates a started Mutagen project when every target resume fails', async () => {
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
      startStackDevTargets(
        {
          stackName: 'repo-test',
          stackBaseDir: join(root, 'stack'),
          sourceDir: '/source/happier',
          localServerPort: 3005,
          activeServerId: 'stack_repo-test__id_default',
          credentialPath,
          targets: [target],
          env: {},
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
      /linux Mutagen resume failed/,
    );

    const mutagenCommands = calls
      .filter((call) => call.command === 'mutagen')
      .map((call) => call.args.find((arg) => ['version', 'terminate', 'start', 'list', 'resume', 'flush'].includes(arg)));
    assert.deepEqual(mutagenCommands, ['version', 'terminate', 'start', 'list', 'resume', 'terminate']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
