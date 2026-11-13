import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { captureStackRuntimeStopSnapshot } from '../utils/stack/runtime_state.mjs';
import { withStackEnv } from './stack_environment.mjs';
import {
  killDetachedProcessGroup,
  spawnDaemonLikeProcess,
} from '../testkit/core/spawn_daemon_like_process.mjs';

async function withHealthyStackServer(run, { dropConnection = false } = {}) {
  const server = createServer((_request, response) => {
    if (dropConnection) {
      response.destroy();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('background readiness leaves deferred-auth daemon startup to the inner runner', async () => {
  const mod = await import('./run_script_with_stack_env.mjs');
  for (const env of [
    { HAPPIER_STACK_AUTH_FLOW: '1' },
    { HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH: '1' },
    { HAPPIER_STACK_AUTH_FLOW: 'true' },
    { HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH: 'true' },
  ]) {
    await withHealthyStackServer(async (internalServerUrl) => {
      await mod.waitForBackgroundStackReadiness({
        stackName: 'deferred-auth', scriptPath: 'run.mjs', env,
        runtimeStatePath: '/missing/stack.runtime.json', internalServerUrl, timeoutMs: 1_000,
        checkDaemonStateImpl: async () => null, isRunnerAlive: () => false,
      });
    });
  }
});

test('background readiness still awaits an ordinarily requested daemon', async () => {
  const mod = await import('./run_script_with_stack_env.mjs');
  await withHealthyStackServer(async (internalServerUrl) => {
    await assert.rejects(mod.waitForBackgroundStackReadiness({
      stackName: 'ordinary-start', scriptPath: 'run.mjs', env: {},
      runtimeStatePath: '/missing/stack.runtime.json', internalServerUrl, timeoutMs: 1_000,
      checkDaemonStateImpl: async () => null, isRunnerAlive: () => false,
    }), /runner exited before requested daemon readiness was published/);
  });
});

test('background readiness does not await a daemon disabled by --no-daemon', async () => {
  const mod = await import('./run_script_with_stack_env.mjs');
  await withHealthyStackServer(async (internalServerUrl) => {
    await mod.waitForBackgroundStackReadiness({
      stackName: 'server-only', scriptPath: 'run.mjs', args: ['--no-daemon'], env: {},
      runtimeStatePath: '/missing/stack.runtime.json', internalServerUrl, timeoutMs: 1_000,
      checkDaemonStateImpl: async () => null, isRunnerAlive: () => false,
    });
  });
});

test('background dev readiness uses the selected external relay instead of an allocated local port', async () => {
  const mod = await import('./run_script_with_stack_env.mjs');
  await withHealthyStackServer(async (internalServerUrl) => {
    await withHealthyStackServer(async (externalServerUrl) => {
      for (const selection of [
        { args: ['--no-server', `--server-url=${externalServerUrl}`], env: {} },
        { args: [`--server-url=${externalServerUrl}`], env: {} },
        { args: ['--no-server'], env: { HAPPIER_SERVER_URL: externalServerUrl } },
      ]) {
        await mod.waitForBackgroundStackReadiness({
          stackName: 'external-relay', scriptPath: 'dev.mjs',
          args: [...selection.args, '--no-daemon'], env: selection.env,
          runtimeStatePath: '/missing/stack.runtime.json', internalServerUrl, timeoutMs: 1_000,
        });
      }
    });
  }, { dropConnection: true });
});

test('boot-failure cleanup awaits the canonical process-tree owner', async () => {
  const mod = await import('./run_script_with_stack_env.mjs');
  const calls = [];
  const child = { pid: 4242, kill(signal) { calls.push(['leader-kill', signal]); } };
  const expectedRuntimeState = {
    ownerPid: 4242,
    startedAt: '2026-07-17T08:00:00.000Z',
  };

  const result = await mod.terminateSpawnedRunnerForBootFailure(child, {
    runtimeStatePath: '/tmp/stack.runtime.json',
    expectedRuntimeState,
    killProcessTreeImpl: async (target, signal) => {
      calls.push(['tree-kill', target.pid, signal]);
      return { ok: true, signal };
    },
    deleteStackRuntimeStateIfOwnedByImpl: async (_path, expected) => {
      calls.push(['state-delete', expected]);
      return { deleted: true };
    },
  });

  assert.deepEqual(result, { ok: true, signal: 'SIGTERM' });
  assert.deepEqual(calls, [['tree-kill', 4242, 'SIGTERM'], ['state-delete', expectedRuntimeState]]);

  calls.length = 0;
  await mod.terminateSpawnedRunnerForBootFailure(child, {
    runtimeStatePath: '/tmp/stack.runtime.json',
    killProcessTreeImpl: async () => ({ ok: true }),
    deleteStackRuntimeStateIfOwnedByImpl: async () => { calls.push(['state-delete']); },
  });
  assert.deepEqual(calls, [], 'missing pre-existing identity must not delete runtime state');

  calls.length = 0;
  const unconfirmed = await mod.terminateSpawnedRunnerForBootFailure(child, {
    runtimeStatePath: '/tmp/stack.runtime.json',
    killProcessTreeImpl: async () => ({ ok: false, reason: 'tree_unconfirmed' }),
    deleteStackRuntimeStateIfOwnedByImpl: async () => { calls.push(['state-delete']); },
  });
  assert.deepEqual(unconfirmed, { ok: false, reason: 'tree_unconfirmed' });
  assert.deepEqual(calls, []);
});

test('buildAlreadyRunningMobileMetroArgs preserves Expo Tailscale mode', async () => {
  const mod = await import('./run_script_with_stack_env.mjs');

  assert.equal(typeof mod.buildAlreadyRunningMobileMetroArgs, 'function');
  assert.deepEqual(
    mod.buildAlreadyRunningMobileMetroArgs(['--mobile', '--expo-tailscale']),
    ['--metro', '--expo-tailscale']
  );
});

test('createStackRunnerLogPath prunes only the matching runner log family and keeps the current path', async () => {
  const mod = await import('./run_script_with_stack_env.mjs');
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stack-runner-log-prune-'));
  try {
    const logsDir = join(tmp, 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, 'dev.1000.log'), 'old dev 1\n', 'utf-8');
    await writeFile(join(logsDir, 'dev.2000.log'), 'old dev 2\n', 'utf-8');
    await writeFile(join(logsDir, 'dev.3000.log'), 'old dev 3\n', 'utf-8');
    await writeFile(join(logsDir, 'run.1500.log'), 'old run\n', 'utf-8');

    const logPath = await mod.createStackRunnerLogPath({
      logsDir,
      scriptPath: 'dev.mjs',
      nowMs: 4000,
      keepCount: 2,
    });

    assert.equal(logPath, join(logsDir, 'dev.4000.log'));
    assert.deepEqual((await readdir(logsDir)).sort(), [
      'dev.3000.log',
      'dev.4000.log',
      'run.1500.log',
    ]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('cleanupExitedStackRuntimeOwner preserves a successor that claims during cleanup observation', async () => {
  const mod = await import('./run_script_with_stack_env.mjs');
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stack-runner-cleanup-race-'));
  try {
    const statePath = join(tmp, 'stack.runtime.json');
    const predecessorPid = 81001;
    const predecessorStartedAt = '2026-07-17T08:00:00.000Z';
    const successor = {
      version: 1,
      stackName: 'race',
      ownerPid: predecessorPid,
      startedAt: '2026-07-17T08:00:00.001Z',
      ports: { server: 4101 },
      processes: {},
      sentinel: 'successor',
    };
    await writeFile(statePath, JSON.stringify({
      version: 1,
      stackName: 'race',
      ownerPid: predecessorPid,
      startedAt: predecessorStartedAt,
      ports: { server: 4101 },
      processes: {},
    }), 'utf-8');
    const expectedRuntimeState = await captureStackRuntimeStopSnapshot(statePath);

    const result = await mod.cleanupExitedStackRuntimeOwner({
      runtimeStatePath: statePath,
      expectedRuntimeState,
      isTcpPortFreeImpl: async () => {
        await writeFile(statePath, JSON.stringify(successor), 'utf-8');
        return true;
      },
    });

    assert.equal(result.deleted, false);
    assert.equal(result.reason, 'owner_changed');
    assert.deepEqual(JSON.parse(await (await import('node:fs/promises')).readFile(statePath, 'utf-8')), successor);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runStackScriptWithStackEnv delegates start-like restart JSON without outer restart side effects', async (t) => {
  const mod = await import('./run_script_with_stack_env.mjs');
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'hstack-restart-json-dry-run-'));
  const storageDir = join(fixtureRoot, 'stacks');
  const stackName = 'restart-json';
  const stackDir = join(storageDir, stackName);
  const rootDir = join(fixtureRoot, 'repo-without-buildable-components');
  const previousStorageDir = process.env.HAPPIER_STACK_STORAGE_DIR;
  const incumbent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  t.after(async () => {
    incumbent.kill('SIGTERM');
    if (previousStorageDir == null) delete process.env.HAPPIER_STACK_STORAGE_DIR;
    else process.env.HAPPIER_STACK_STORAGE_DIR = previousStorageDir;
    await rm(fixtureRoot, { recursive: true, force: true });
  });
  process.env.HAPPIER_STACK_STORAGE_DIR = storageDir;
  await mkdir(join(rootDir, 'scripts'), { recursive: true });
  await mkdir(stackDir, { recursive: true });
  await writeFile(join(stackDir, 'env'), 'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light\n', 'utf-8');
  const runtimeStatePath = join(stackDir, 'stack.runtime.json');
  const runtimeState = JSON.stringify({
    version: 1,
    stackName,
    ownerPid: incumbent.pid,
    startedAt: '2026-07-21T08:00:00.000Z',
    ports: { server: 43123 },
    processes: { daemonPid: 999_999_999, daemonPids: [999_999_999] },
    daemon: { distClosureFingerprint: 'aaaaaaaaaaaaaaaa' },
  }) + '\n';
  await writeFile(runtimeStatePath, runtimeState, 'utf-8');
  await writeFile(
    join(rootDir, 'scripts', 'dev.mjs'),
    'if (process.env.HAPPIER_STACK_SERVER_PORT !== "43123") throw new Error("missing runtime port overlay");\n' +
      'console.log(JSON.stringify({ mode: "dev", dryRun: true }));\n',
    'utf-8',
  );
  await writeFile(
    join(rootDir, 'scripts', 'run.mjs'),
    'if (process.env.HAPPIER_STACK_SERVER_PORT !== "43123") throw new Error("missing runtime port overlay");\n' +
      'console.log(JSON.stringify({ mode: "start", dryRun: true }));\n',
    'utf-8',
  );

  const runDryRunAndAssertUnchanged = async ({ scriptPath, expectedRuntimeState }) => {
    await mod.runStackScriptWithStackEnv({
      rootDir,
      stackName,
      scriptPath,
      args: ['--restart', '--json'],
    });

    process.kill(incumbent.pid, 0);
    assert.equal(
      await readFile(runtimeStatePath, 'utf-8'),
      expectedRuntimeState,
      `${scriptPath} JSON restart must not stop or rewrite the incumbent`,
    );
  };

  await runDryRunAndAssertUnchanged({ scriptPath: 'dev.mjs', expectedRuntimeState: runtimeState });

  const observedRuntimeState = JSON.stringify({
    version: 1,
    stackName,
    ownerPid: incumbent.pid,
    startedAt: '2026-07-21T08:00:00.000Z',
    ports: { server: 43123 },
    processes: {},
  }) + '\n';
  await writeFile(runtimeStatePath, observedRuntimeState, 'utf-8');
  const cliHomeDir = join(stackDir, 'cli');
  const daemonStatePath = join(
    cliHomeDir,
    'servers',
    `stack_${stackName}__id_default`,
    'daemon.state.json',
  );
  const observedDaemon = spawnDaemonLikeProcess({
    cliHomeDir,
    statePaths: [daemonStatePath],
    env: {
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: join(stackDir, 'env'),
      HAPPIER_STACK_PROCESS_KIND: 'daemon',
    },
  });
  t.after(() => killDetachedProcessGroup(observedDaemon.pid));
  const daemonStateDeadline = Date.now() + 5_000;
  while (Date.now() < daemonStateDeadline) {
    try {
      await readFile(daemonStatePath, 'utf-8');
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  await readFile(daemonStatePath, 'utf-8');

  await runDryRunAndAssertUnchanged({ scriptPath: 'run.mjs', expectedRuntimeState: observedRuntimeState });

  let reconciledDaemonPid = null;
  const reconciliationDeadline = Date.now() + 5_000;
  while (Date.now() < reconciliationDeadline && reconciledDaemonPid !== observedDaemon.pid) {
    await withStackEnv({
      stackName,
      fn: async ({ runtimeState: reconciledRuntimeState }) => {
        reconciledDaemonPid = reconciledRuntimeState?.processes?.daemonPid ?? null;
      },
    });
    if (reconciledDaemonPid !== observedDaemon.pid) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.equal(
    reconciledDaemonPid,
    observedDaemon.pid,
    'the fixture must prove ordinary callers still reconcile the newly observed daemon',
  );
});

test('outer dev restart preflight delegates local/external selection to the canonical connection resolver', async () => {
  const mod = await import('./run_script_with_stack_env.mjs');
  assert.equal(mod.shouldPreflightLocalDevServerRestart({ scriptPath: 'dev.mjs', args: ['--restart'], env: {} }), true);
  assert.equal(
    mod.shouldPreflightLocalDevServerRestart({
      scriptPath: 'dev.mjs',
      args: ['--restart', '--no-server'],
      env: { HAPPIER_SERVER_URL: 'https://api.example.com' },
    }),
    false,
  );
  assert.equal(
    mod.shouldPreflightLocalDevServerRestart({
      scriptPath: 'dev.mjs',
      args: ['--restart', '--server-url=https://api.example.com'],
      env: {},
    }),
    false,
  );
  assert.equal(
    mod.shouldPreflightLocalDevServerRestart({
      scriptPath: 'run.mjs',
      args: ['--restart'],
      env: {},
    }),
    false,
  );
});

test('runStackScriptWithStackEnv limits the restart control guard to start-like restart requests', async () => {
  const mod = await import('./run_script_with_stack_env.mjs');
  const rootDir = join(tmpdir(), 'hstack-missing-root-for-restart-guard-neighbor');

  for (const request of [
    { scriptPath: 'dev.mjs', args: ['--json'] },
    { scriptPath: 'mobile_dev_client.mjs', args: ['--restart', '--json'] },
  ]) {
    await assert.rejects(
      mod.runStackScriptWithStackEnv({
        rootDir,
        stackName: 'missing-stack-that-should-be-resolved',
        ...request,
      }),
      (error) => error?.code !== 'ESTACKRESTARTCONTROLARG' && /does not exist yet/.test(String(error?.message ?? '')),
    );
  }

});

async function createReadinessRuntimeState(t, daemonPid) {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-background-readiness-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtimeStatePath = join(dir, 'stack.runtime.json');
  await writeFile(runtimeStatePath, JSON.stringify({ version: 1, processes: { daemonPid } }));
  return runtimeStatePath;
}

const READY_CLOSURE = 'abcdef1234567890';

function runningDaemon(daemonPid, serverConnected) {
  return { status: 'running', pid: daemonPid, distClosureFingerprint: READY_CLOSURE, serverConnected };
}

test('background readiness waits for the daemon to reach the server, not just its control port', async (t) => {
  const mod = await import('./run_script_with_stack_env.mjs');
  const runtimeStatePath = await createReadinessRuntimeState(t, 4242);
  const observations = [false, false, true];
  let reads = 0;

  await withHealthyStackServer(async (internalServerUrl) => {
    await mod.waitForBackgroundStackReadiness({
      stackName: 'connecting', scriptPath: 'run.mjs', env: {}, runtimeStatePath, internalServerUrl,
      expectedDaemonDistClosureFingerprint: READY_CLOSURE, timeoutMs: 5_000,
      checkDaemonStateImpl: async () => {
        reads += 1;
        return runningDaemon(4242, observations.shift() ?? true);
      },
    });
  });

  assert.equal(reads, 3);
});

test('background readiness fails visibly when the daemon never reaches the server', async (t) => {
  const mod = await import('./run_script_with_stack_env.mjs');
  const runtimeStatePath = await createReadinessRuntimeState(t, 4242);

  await withHealthyStackServer(async (internalServerUrl) => {
    await assert.rejects(mod.waitForBackgroundStackReadiness({
      stackName: 'never-connects', scriptPath: 'run.mjs', env: {}, runtimeStatePath, internalServerUrl,
      expectedDaemonDistClosureFingerprint: READY_CLOSURE, timeoutMs: 400,
      checkDaemonStateImpl: async () => runningDaemon(4242, false),
    }), /"serverConnected":false/);
  });
});

test('background readiness still rejects a connected daemon from another closure or PID', async (t) => {
  const mod = await import('./run_script_with_stack_env.mjs');
  const runtimeStatePath = await createReadinessRuntimeState(t, 4242);
  const wrongDaemons = [
    { ...runningDaemon(4242, true), distClosureFingerprint: '1111111111111111' },
    runningDaemon(5252, true),
  ];

  for (const daemonState of wrongDaemons) {
    await withHealthyStackServer(async (internalServerUrl) => {
      await assert.rejects(mod.waitForBackgroundStackReadiness({
        stackName: 'wrong-daemon', scriptPath: 'run.mjs', env: {}, runtimeStatePath, internalServerUrl,
        expectedDaemonDistClosureFingerprint: READY_CLOSURE, timeoutMs: 300,
        checkDaemonStateImpl: async () => daemonState,
      }), /requested daemon readiness/);
    });
  }
});

test('a daemon too old to report its connection is accepted on control proof and says so', async (t) => {
  const mod = await import('./run_script_with_stack_env.mjs');
  const runtimeStatePath = await createReadinessRuntimeState(t, 4242);
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(String(message)));

  await withHealthyStackServer(async (internalServerUrl) => {
    await mod.waitForBackgroundStackReadiness({
      stackName: 'older-daemon', scriptPath: 'run.mjs', env: {}, runtimeStatePath, internalServerUrl,
      expectedDaemonDistClosureFingerprint: READY_CLOSURE, timeoutMs: 1_000,
      checkDaemonStateImpl: async () => runningDaemon(4242, null),
    });
  });

  assert.equal(warnings.filter((message) => message.includes('does not report its server connection')).length, 1);
});
