import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  resolveDefaultRemoteServerPort,
  startStackDevTargets,
  startStackDevTargetsInBackground,
} from './supervisor.mjs';
import { renderMutagenProject } from './mutagen_project.mjs';
import { resolveRemoteStackStatePaths } from './remote_commands.mjs';

const successfulDependencyBootstrap = async () => ({ code: 0 });

const remoteLightSqliteRuntimeConfig = Object.freeze({
  serverComponentName: 'happier-server-light',
  dbProvider: 'sqlite',
  environment: {},
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

    resolveServerReady();
    assert.equal(await Promise.race([
      running.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ]), true);
    assert.equal(targetStates.at(-1)?.serviceStatus?.server, 'running');

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
              ? { out: JSON.stringify([{ name: 'happier-linux', status: 'watching', successfulCycles: 1 }]) }
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
              ? { out: JSON.stringify([{ name: sessionName, status: 'watching', successfulCycles: 1 }]) }
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

test('an unhealthy command-only independent target does not gate a service assigned to another target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-independent-service-isolation-'));
  const stackBaseDir = join(root, 'stack');
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
            services: { server: false, expo: false, daemon: false },
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
      },
    );

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
      false,
    );
    await controller.close();
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
  } finally {
    releaseExpoReadiness?.();
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

test('server-only targets bypass shared daemon or Expo workspace preparation', async () => {
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
      false,
      'an Expo plan must wait for the shared local workspace preparation before its flush/bootstrap',
    );
    assert.equal(
      calls.some((call) => call.kind === 'spawn' && call.label === `remote:${expoTarget.name}`),
      false,
      'an Expo plan must not start its tunnel or worker before workspace preparation resolves',
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

test('a co-located target begins credential seeding before server readiness without starting dependency bootstrap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-credential-first-'));
  const spawned = [];
  const processCalls = [];
  let dependencyBootstrapCalls = 0;
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

    controller = await startStackDevTargets(
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
        remoteWorkspacePreparation: new Promise(() => {}),
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
      1,
      'the remote Stack worker must start while readiness remains pending',
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
  } finally {
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
