import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  resolveDefaultRemoteServerPort,
  startStackDevTargets,
  startStackDevTargetsInBackground,
} from './supervisor.mjs';
import { renderMutagenProject } from './mutagen_project.mjs';

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

test('background dev target failure is isolated from the local stack', async () => {
  const errors = [];
  const controller = startStackDevTargetsInBackground(
    { stackName: 'repo-test', targets: [{ name: 'windows' }] },
    {
      startStackDevTargetsImpl: async () => {
        throw new Error('remote install failed');
      },
      logger: { error(message) { errors.push(message); } },
    },
  );

  assert.equal(await controller.ready, null);
  assert.match(errors.join('\n'), /remote install failed/);
  await controller.close();
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

test('authoritative remote server retires the prior target owner and becomes running only after stable-tunnel readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-server-ready-'));
  const credentialPath = join(root, 'access.key');
  await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });
  const target = {
    name: 'mac-host',
    platform: 'posix',
    ssh: 'mac-ssh',
    repoDir: '/Users/test/happier',
    cliHomeDir: '/Users/test/.happier/mac',
  };
  const calls = [];
  const states = [];
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  let resolveRunningState;
  const runningState = new Promise((resolve) => {
    resolveRunningState = resolve;
  });
  let resolveReadinessStarted;
  const readinessStarted = new Promise((resolve) => {
    resolveReadinessStarted = resolve;
  });
  let controller = null;
  try {
    const controllerPromise = startStackDevTargets({
      stackName: 'repo-test',
      stackBaseDir: join(root, 'stack'),
      sourceDir: '/source/happier',
      localServerPort: 52753,
      publicServerUrl: 'http://127.0.0.1:52753',
      activeServerId: 'stack_repo-test__id_default',
      credentialPath,
      targets: [target],
      targetPlans: [{
        target,
        services: { server: true, expo: false, daemon: true },
      }],
      remoteServerRuntimeConfig: {
        serverComponentName: 'happier-server-light',
        dbProvider: 'sqlite',
        environment: {
          HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
          HAPPIER_SQLITE_CONNECTION_LIMIT: '1',
        },
      },
      onTargetStateChange: (state) => {
        states.push(state);
        if (state.status === 'running') resolveRunningState();
      },
      env: {},
      instanceId: 100,
    }, {
      runProcess: async ({ label, command, args, env }) => {
        calls.push({ kind: 'run', label, command, args, env });
        return { code: 0 };
      },
      spawnProcess: ({ label, command, args, env }) => {
        const child = { label, command, args, env, exitCode: null };
        calls.push({ kind: 'spawn', label, command, args, env, child });
        return child;
      },
      stopProcess: async (child) => {
        child.exitCode = 0;
      },
      waitForServerReady: async ({ url }) => {
        calls.push({ kind: 'server-ready', url });
        resolveReadinessStarted();
        await ready;
      },
    });

    await readinessStarted;
    assert.ok(
      calls.some((call) => call.kind === 'run' && call.command === 'ssh' && call.args.at(-1)?.includes('stack stop')),
      'prior target retirement must finish before the replacement worker starts',
    );
    const tunnel = calls.find((call) => call.kind === 'spawn' && call.command === 'ssh' && call.args.includes('-N'));
    assert.ok(tunnel?.args.includes('-L'));
    assert.equal(tunnel?.args.includes('-R'), false);
    assert.deepEqual(calls.find((call) => call.kind === 'server-ready'), {
      kind: 'server-ready',
      url: 'http://127.0.0.1:52753',
    });
    assert.equal(states.some((state) => state.status === 'running'), false);

    resolveReady();
    controller = await controllerPromise;
    await runningState;
    assert.equal(states.at(-1)?.status, 'running');
    assert.equal(states.at(-1)?.serviceStatus?.server, 'running');
  } finally {
    await controller?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('authoritative Mac server forwards its target-owned Expo through the guest Metro endpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-server-expo-'));
  const credentialPath = join(root, 'access.key');
  const target = {
    name: 'mac-host',
    platform: 'posix',
    ssh: 'mac-ssh',
    repoDir: '/Users/test/happier',
    cliHomeDir: '/Users/test/.happier/mac',
  };
  const calls = [];
  let releaseReady;
  const ready = new Promise((resolve) => {
    releaseReady = resolve;
  });
  let controller = null;
  try {
    await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });
    const controllerPromise = startStackDevTargets({
      stackName: 'repo-test',
      stackBaseDir: join(root, 'stack'),
      sourceDir: '/source/happier',
      localServerPort: 52753,
      localExpoPort: 18081,
      expoListenHost: '0.0.0.0',
      expoPublicUrl: 'http://192.168.1.20:18081',
      resolveMobilePublicUrlsOnTarget: true,
      startMobile: true,
      publicServerUrl: 'http://192.168.1.20:52753',
      activeServerId: 'stack_repo-test__id_default',
      credentialPath,
      targetPlans: [{
        target,
        services: { server: true, expo: true, daemon: true },
      }],
      remoteServerRuntimeConfig: {
        serverComponentName: 'happier-server-light',
        dbProvider: 'sqlite',
        environment: {
          HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
          HAPPIER_SQLITE_CONNECTION_LIMIT: '1',
        },
      },
      env: {},
      instanceId: 100,
    }, {
      runProcess: async ({ label, command, args, env }) => {
        calls.push({ kind: 'run', label, command, args, env });
        return { code: 0 };
      },
      spawnProcess: ({ label, command, args, env }) => {
        const child = { label, command, args, env, exitCode: null };
        calls.push({ kind: 'spawn', label, command, args, env, child });
        return child;
      },
      stopProcess: async (child) => {
        child.exitCode = 0;
      },
      waitForServerReady: async () => await ready,
    });

    releaseReady();
    controller = await controllerPromise;
    const tunnel = calls.find((call) => call.kind === 'spawn' && call.command === 'ssh' && call.args.includes('-N'));
    assert.deepEqual(
      tunnel?.args.filter((arg) => arg === '-L').length,
      2,
      'one local forward must expose the target server and one the target Metro listener',
    );
    assert.ok(tunnel?.args.some((arg) => String(arg).startsWith('*:18081:localhost:')));
    const worker = calls.find((call) => call.kind === 'spawn' && call.command === 'ssh' && !call.args.includes('-N'));
    assert.match(worker?.args.at(-1) ?? '', /HAPPIER_STACK_EXPO_DEV_PORT=/);
    assert.doesNotMatch(
      worker?.args.at(-1) ?? '',
      /EXPO_PACKAGER_PROXY_URL=|--server-public-url=|192\.168\.1\.20/,
      'automatic guest addresses must not override the target\'s own public-host resolution',
    );
  } finally {
    releaseReady?.();
    await controller?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a co-located server stays available when deferred Expo or daemon preparation fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-companion-preparation-'));
  const credentialPath = join(root, 'access.key');
  const target = {
    name: 'mac-host',
    platform: 'posix',
    ssh: 'mac-ssh',
    repoDir: '/Users/test/happier',
    cliHomeDir: '/Users/test/.happier/mac',
  };
  await writeFile(credentialPath, '{"token":"secret"}\n', { mode: 0o600 });
  try {
    for (const failure of ['bootstrap', 'credentials']) {
      const calls = [];
      const states = [];
      let markCompanionRetry;
      const companionRetry = new Promise((resolve) => {
        markCompanionRetry = resolve;
      });
      const retryGate = new Promise(() => {});
      let controller = null;
      try {
        controller = await startStackDevTargets({
          stackName: 'repo-test',
          stackBaseDir: join(root, `stack-${failure}`),
          sourceDir: '/source/happier',
          localServerPort: 52753,
          localExpoPort: 18081,
          publicServerUrl: 'http://192.168.1.20:52753',
          activeServerId: 'stack_repo-test__id_default',
          credentialPath,
          targetPlans: [{
            target,
            services: { server: true, expo: true, daemon: true },
          }],
          remoteServerRuntimeConfig: {
            serverComponentName: 'happier-server-light',
            dbProvider: 'sqlite',
            environment: {
              HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
              HAPPIER_SQLITE_CONNECTION_LIMIT: '1',
            },
          },
          onTargetStateChange: (state) => states.push(state),
          env: {},
          instanceId: 100,
        }, {
          runProcess: async ({ label, command, args, env }) => {
            const remoteCommand = String(args.at(-1) ?? '');
            calls.push({ kind: 'run', label, command, args, env });
            if (failure === 'bootstrap' && remoteCommand.includes('remote_dependency_bootstrap.mjs')) {
              return { code: 1 };
            }
            if (failure === 'credentials' && command === 'scp') {
              return { code: 1 };
            }
            return { code: 0 };
          },
          spawnProcess: ({ label, command, args, env }) => {
            const child = { label, command, args, env, exitCode: null };
            calls.push({ kind: 'spawn', label, command, args, env, child });
            return child;
          },
          stopProcess: async (child) => {
            calls.push({ kind: 'stop', child });
            child.exitCode = 0;
          },
          waitForServerReady: async () => {
            calls.push({ kind: 'server-ready' });
          },
          waitForRetry: async () => {
            markCompanionRetry();
            await retryGate;
          },
          logger: { error() {} },
        });

        await companionRetry;
        const serverReadinessIndex = calls.findIndex((call) => call.kind === 'server-ready');
        const failedPreparationIndex = calls.findIndex((call) => (
          (failure === 'bootstrap' && String(call.args?.at(-1) ?? '').includes('remote_dependency_bootstrap.mjs'))
          || (failure === 'credentials' && call.command === 'scp')
        ));
        assert.ok(serverReadinessIndex >= 0, `${failure} failure must follow server readiness`);
        assert.ok(failedPreparationIndex > serverReadinessIndex, `${failure} preparation must not gate server readiness`);
        assert.equal(
          calls.filter((call) => call.kind === 'spawn' && call.command === 'ssh' && !call.args.includes('-N')).length,
          1,
          'companion preparation retries must retain the existing target worker',
        );
        const worker = calls.find((call) => call.kind === 'spawn' && call.command === 'ssh' && !call.args.includes('-N'));
        assert.match(worker?.args.at(-1) ?? '', /HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH=1/);
        assert.equal(
          calls.some((call) => call.kind === 'stop' && call.child === worker.child),
          false,
          'companion failure must not stop the ready server worker',
        );
        assert.deepEqual(states.at(-1)?.serviceStatus, {
          server: 'running',
          expo: 'degraded',
          daemon: 'degraded',
        });
        assert.equal(states.at(-1)?.status, 'degraded');
      } finally {
        await controller?.close();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
      ['version', 'resume', 'list', 'resume', 'flush'],
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
        runProcess: async ({ label, command, args, env }) => {
          calls.push({ kind: 'run', label, command, args, env });
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env }) => {
          const worker = { label, command, args, env, exitCode: null };
          calls.push({ kind: 'spawn', label, command, args, env, worker });
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
        runProcess: async ({ label, command, args, env }) => {
          calls.push({ kind: 'run', label, command, args, env });
          return { code: 0 };
        },
        spawnProcess: ({ label, command, args, env }) => {
          const worker = { label, command, args, env, exitCode: null };
          calls.push({ kind: 'spawn', label, command, args, env, worker });
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
          && call.args.join(' ') === 'sync monitor --long happier-linux',
      ),
    );
    await controller.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('supervisor keeps healthy targets and retries another target after its initial bootstrap fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-target-isolation-'));
  const calls = [];
  const remoteCallCounts = new Map();
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
            limaInstance: 'hslqa',
            limaHome: '/tmp/lima-happier',
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
        runProcess: async ({ label, command, args, env }) => {
          calls.push({ kind: 'run', label, command, args, env });
          if (label.startsWith('remote:')) {
            const count = (remoteCallCounts.get(label) ?? 0) + 1;
            remoteCallCounts.set(label, count);
            if (label === 'remote:windows' && count === 2) return { code: 23 };
          }
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
        waitForRetry: async () => {
          notifyRetryScheduled();
          await retryGate;
        },
        logger: { error() {} },
      },
    );

    const limaStart = calls.find((call) => call.command === 'limactl');
    assert.deepEqual(limaStart?.args, ['start', 'hslqa']);
    assert.equal(limaStart?.env?.LIMA_HOME, '/tmp/lima-happier');
    assert.deepEqual(controller.workers.map((worker) => worker.label), ['remote:linux']);
    assert.deepEqual(controller.targetFailures.map(({ name }) => name), ['windows']);

    const retryWasScheduled = await Promise.race([
      retryScheduled.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(retryWasScheduled, true, 'expected the failed target to remain supervised');
    releaseRetry();
    await windowsWorkerStarted;
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
        runProcess: async ({ command, args }) => {
          if (
            command === 'ssh'
            && args.some((arg) => String(arg).includes('remote_dependency_bootstrap.mjs'))
          ) {
            bootstrapAttempts += 1;
            if (bootstrapAttempts === 1) return { code: 1 };
          }
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
    assert.equal(
      calls.filter((call) => call.kind === 'run' && call.command === 'ssh' && call.args.some((arg) => String(arg).includes('remote_dependency_bootstrap'))).length,
      1,
      'a worker-only restart must reuse the already-provisioned checkout',
    );
    assert.equal(
      calls.filter((call) => call.kind === 'run' && call.command === 'limactl').length,
      1,
      'a worker-only restart must not restart an already-provisioned Lima target',
    );
    await controller.close();
  } finally {
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
        targets: [{
          name: 'windows',
          platform: 'windows',
          ssh: 'windows-ssh',
          repoDir: 'C:/happier',
          cliHomeDir: 'C:/Users/test/.happier/windows',
        }],
        env: { HAPPIER_STACK_STACK: 'repo-test' },
      },
      {
        runProcess: async ({ command, env }) => {
          if (command === 'mutagen') mutagenControlEnvs.push(env);
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
      },
    );

    const project = await readFile(join(root, 'stack', 'mutagen', 'mutagen.yml'), 'utf8');
    assert.match(project, /linux-ssh:\/home\/dev\/happier/);
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
        'run:remote:linux',
        'run:remote:linux',
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
    assert.deepEqual(
      calls.find((call) => call.command === 'mutagen' && call.args.includes('flush')).args,
      ['sync', 'flush', 'happier-linux'],
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

test('dev target supervisor terminates a started Mutagen project when every target flush fails', async () => {
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
          runProcess: async ({ command, args }) => {
            calls.push({ command, args });
            if (command === 'mutagen' && args.includes('flush')) return { code: 1 };
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
      /linux Mutagen initial flush failed/,
    );

    const mutagenCommands = calls
      .filter((call) => call.command === 'mutagen')
      .map((call) => call.args.find((arg) => ['version', 'terminate', 'start', 'list', 'resume', 'flush'].includes(arg)));
    assert.deepEqual(mutagenCommands, ['version', 'terminate', 'start', 'list', 'resume', 'flush', 'terminate']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
