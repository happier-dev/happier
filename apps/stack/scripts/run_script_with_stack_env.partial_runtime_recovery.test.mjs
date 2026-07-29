import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

import {
  cleanupFailedRestartAttempt,
  inspectExistingStartLikeRuntime,
  runStackScriptWithStackEnv,
  shouldAdoptOccupiedRuntimePortsForRecovery,
  waitForBackgroundStackReadiness,
} from './stack/run_script_with_stack_env.mjs';
import { withPatchedProcessEnv } from './testkit/core/env_scope.mjs';
import { getComponentDir } from './utils/paths/paths.mjs';
import {
  isCliDistBuildLockActive,
  resolveCliDistBuildLockPath,
  withCliDistBuildLock,
} from './utils/proc/cliDistBuildLock.mjs';

async function withListeningServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/ready') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
      return;
    }
    res.statusCode = 204;
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? Number(address.port) : 0;
  return {
    port,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function reserveUnusedPort() {
  const listener = await withListeningServer();
  const port = listener.port;
  await listener.close();
  return port;
}

test('background readiness leaves deferred-auth daemon startup to the inner runner', async () => {
  for (const env of [
    { HAPPIER_STACK_AUTH_FLOW: '1' },
    { HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH: '1' },
    { HAPPIER_STACK_AUTH_FLOW: 'true' },
    { HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH: 'true' },
  ]) {
    const server = await withListeningServer();
    try {
      await waitForBackgroundStackReadiness({
        stackName: 'deferred-auth', scriptPath: 'run.mjs', env,
        runtimeStatePath: '/missing/stack.runtime.json',
        internalServerUrl: `http://127.0.0.1:${server.port}`, timeoutMs: 1_000,
        checkDaemonStateImpl: async () => null, isRunnerAlive: () => false,
      });
    } finally {
      await server.close();
    }
  }
});

test('background readiness still awaits an ordinarily requested daemon', async () => {
  const server = await withListeningServer();
  try {
    await assert.rejects(waitForBackgroundStackReadiness({
      stackName: 'ordinary-start', scriptPath: 'run.mjs', env: {},
      runtimeStatePath: '/missing/stack.runtime.json',
      internalServerUrl: `http://127.0.0.1:${server.port}`, timeoutMs: 1_000,
      checkDaemonStateImpl: async () => null, isRunnerAlive: () => false,
    }), /runner exited before requested daemon readiness was published/);
  } finally {
    await server.close();
  }
});

test('source background restart readiness rejects the incumbent daemon before the launch generation is published', async () => {
  const temp = await withTempDir();
  const runtimeStatePath = join(temp.dir, 'stack.runtime.json');
  const launchOwnerPid = 4101;
  const launchOwnerStartedAt = '2026-07-27T08:00:00.000Z';
  const launchOwnerFingerprint = 'owner-launch-incarnation';
  const incumbentDaemonPid = 4102;
  const incumbentProcessFingerprint = 'daemon-incumbent-incarnation';
  const replacementDaemonPid = 4103;
  const replacementProcessFingerprint = 'daemon-replacement-incarnation';
  const writeRuntimeDaemon = async ({
    daemonPid,
    daemonProcessFingerprint,
    daemonDistFingerprint,
  }) => {
    await writeFile(runtimeStatePath, `${JSON.stringify({
      ownerPid: launchOwnerPid,
      startedAt: launchOwnerStartedAt,
      processes: { daemonPid },
      daemon: { distClosureFingerprint: daemonDistFingerprint },
      processInstances: {
        owner: { pid: launchOwnerPid, fingerprint: launchOwnerFingerprint },
        processes: {
          daemonPid: { pid: daemonPid, fingerprint: daemonProcessFingerprint },
        },
      },
    })}\n`, 'utf8');
  };
  await writeRuntimeDaemon({
    daemonPid: incumbentDaemonPid,
    daemonProcessFingerprint: incumbentProcessFingerprint,
    daemonDistFingerprint: 'aaaaaaaaaaaaaaaa',
  });

  let daemonObservations = 0;
  try {
    await waitForBackgroundStackReadiness({
      stackName: 'source-restart-generation-admission',
      scriptPath: 'dev.mjs',
      args: ['--restart'],
      env: {},
      runtimeStatePath,
      internalServerUrl: 'http://127.0.0.1:1',
      timeoutMs: 1_000,
      waitForServerReadyImpl: async () => {},
      isDaemonPreparationActiveImpl: () => ({ active: false, ownerId: null }),
      checkDaemonStateImpl: async () => {
        daemonObservations += 1;
        if (daemonObservations === 1) {
          return {
            status: 'running',
            pid: incumbentDaemonPid,
            processInstanceFingerprint: incumbentProcessFingerprint,
            distClosureFingerprint: 'aaaaaaaaaaaaaaaa',
          };
        }
        await writeRuntimeDaemon({
          daemonPid: replacementDaemonPid,
          daemonProcessFingerprint: replacementProcessFingerprint,
          daemonDistFingerprint: 'aaaaaaaaaaaaaaaa',
        });
        return {
          status: 'running',
          pid: replacementDaemonPid,
          processInstanceFingerprint: replacementProcessFingerprint,
          distClosureFingerprint: 'aaaaaaaaaaaaaaaa',
        };
      },
      isRunnerAlive: () => true,
      sourceDaemonLaunchAttempt: {
        ownerPid: launchOwnerPid,
        ownerStartedAt: launchOwnerStartedAt,
        incumbentDaemonPid,
        incumbentDaemonProcessInstanceFingerprint: incumbentProcessFingerprint,
      },
    });

    assert.equal(daemonObservations, 2);
  } finally {
    await temp.cleanup();
  }
});

test('background readiness gives daemon publication a full bounded budget after slow server health', async () => {
  const temp = await withTempDir();
  const runtimeStatePath = join(temp.dir, 'stack.runtime.json');
  const daemonPid = 4321;
  await writeFile(runtimeStatePath, `${JSON.stringify({ processes: { daemonPid } })}\n`, 'utf8');

  let daemonObservations = 0;
  try {
    await waitForBackgroundStackReadiness({
      stackName: 'slow-server-then-daemon',
      scriptPath: 'run.mjs',
      env: {},
      runtimeStatePath,
      internalServerUrl: 'http://127.0.0.1:1',
      timeoutMs: 500,
      waitForServerReadyImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
      },
      checkDaemonStateImpl: async () => {
        daemonObservations += 1;
        return daemonObservations === 1
          ? { status: 'stopped', pid: null }
          : { status: 'running', pid: daemonPid };
      },
      isRunnerAlive: () => true,
    });
    assert.equal(daemonObservations, 2);
  } finally {
    await temp.cleanup();
  }
});

test('background readiness waits for canonical server health after a maintenance response', async () => {
  const temp = await withTempDir();
  const runtimeStatePath = join(temp.dir, 'stack.runtime.json');
  const daemonPid = 4876;
  await writeFile(runtimeStatePath, `${JSON.stringify({ processes: { daemonPid } })}\n`, 'utf8');

  let healthRequests = 0;
  let daemonObservations = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      healthRequests += 1;
      res.setHeader('content-type', 'application/json');
      if (healthRequests === 1) {
        res.statusCode = 503;
        res.end(JSON.stringify({ status: 'maintenance' }));
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? Number(address.port) : 0;

  try {
    await waitForBackgroundStackReadiness({
      stackName: 'maintenance-then-healthy',
      scriptPath: 'run.mjs',
      env: {},
      runtimeStatePath,
      internalServerUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 1_000,
      checkDaemonStateImpl: async () => {
        daemonObservations += 1;
        return { status: 'running', pid: daemonPid };
      },
      isRunnerAlive: () => true,
    });

    assert.equal(healthRequests, 2);
    assert.equal(daemonObservations, 1);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    await temp.cleanup();
  }
});

test('background readiness gives a late-observed CLI preparation its bounded phase before daemon publication', async () => {
  const temp = await withTempDir();
  const runtimeStatePath = join(temp.dir, 'stack.runtime.json');
  const daemonPid = 5432;
  await writeFile(runtimeStatePath, `${JSON.stringify({ processes: { daemonPid } })}\n`, 'utf8');

  let preparationObservations = 0;
  let daemonObservations = 0;
  try {
    await waitForBackgroundStackReadiness({
      stackName: 'late-cli-preparation',
      scriptPath: 'dev.mjs',
      env: {},
      runtimeStatePath,
      internalServerUrl: 'http://127.0.0.1:1',
      timeoutMs: 500,
      preparationTimeoutMs: 500,
      waitForServerReadyImpl: async () => {},
      isDaemonPreparationActiveImpl: () => {
        preparationObservations += 1;
        return preparationObservations === 2 || preparationObservations === 3;
      },
      checkDaemonStateImpl: async () => {
        daemonObservations += 1;
        return daemonObservations < 4
          ? { status: 'stopped', pid: null }
          : { status: 'running', pid: daemonPid };
      },
      isRunnerAlive: () => true,
    });

    assert.equal(preparationObservations, 4);
    assert.equal(daemonObservations, 4);
  } finally {
    await temp.cleanup();
  }
});

test('background readiness gives each real CLI build-lock owner a bounded preparation phase', async () => {
  const temp = await withTempDir();
  const runtimeStatePath = join(temp.dir, 'stack.runtime.json');
  const lockPath = resolveCliDistBuildLockPath(temp.dir);
  const daemonPid = 5687;
  await writeFile(runtimeStatePath, `${JSON.stringify({ processes: { daemonPid } })}\n`, 'utf8');

  let successorBuildCompleted = false;
  const predecessorBuild = withCliDistBuildLock(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    },
    { lockPath, timeoutMs: 2_000, pollIntervalMs: 5 },
  );
  while (!isCliDistBuildLockActive(lockPath)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const successorBuild = withCliDistBuildLock(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      successorBuildCompleted = true;
    },
    { lockPath, timeoutMs: 2_000, pollIntervalMs: 5 },
  );

  try {
    await waitForBackgroundStackReadiness({
      stackName: 'successive-cli-preparation-owners',
      scriptPath: 'dev.mjs',
      env: { HAPPIER_STACK_REPO_DIR: temp.dir },
      runtimeStatePath,
      internalServerUrl: 'http://127.0.0.1:1',
      timeoutMs: 500,
      preparationTimeoutMs: 500,
      waitForServerReadyImpl: async () => {},
      checkDaemonStateImpl: async () =>
        successorBuildCompleted
          ? { status: 'running', pid: daemonPid }
          : { status: 'stopped', pid: null },
      isRunnerAlive: () => true,
    });
  } finally {
    await Promise.allSettled([predecessorBuild, successorBuild]);
    await temp.cleanup();
  }
});

test('background readiness does not await a daemon disabled by --no-daemon', async () => {
  const server = await withListeningServer();
  try {
    await waitForBackgroundStackReadiness({
      stackName: 'server-only', scriptPath: 'run.mjs', args: ['--no-daemon'], env: {},
      runtimeStatePath: '/missing/stack.runtime.json',
      internalServerUrl: `http://127.0.0.1:${server.port}`, timeoutMs: 1_000,
      checkDaemonStateImpl: async () => null, isRunnerAlive: () => false,
    });
  } finally {
    await server.close();
  }
});

async function withTempDir() {
  const dir = await mkdtemp(join(os.tmpdir(), 'hstack-test-'));
  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function spawnMetroLikeServer({ includeNeedle = '' } = {}) {
  const needle = String(includeNeedle ?? '').trim();
  const script = `
    const http = require('http');
    const needle = process.argv[2] || '';
    const srv = http.createServer((req, res) => {
      if (req.url === '/status') {
        res.statusCode = 200;
        res.end('packager-status:running');
        return;
      }
      res.statusCode = 200;
      res.end('ok');
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      console.log(JSON.stringify({ port, pid: process.pid, needle }));
    });
    setInterval(() => {}, 1000);
  `.trim();
  const args = ['-e', script, ...(needle ? [needle] : [])];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const line = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const idx = buf.indexOf('\n');
      if (idx >= 0) resolve(buf.slice(0, idx));
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`[test] metro-like child exited unexpectedly (code=${code ?? 'unknown'})`)));
  });
  const meta = JSON.parse(String(line ?? '').trim());
  return {
    child,
    port: Number(meta.port),
    needle: String(meta.needle ?? ''),
    async kill() {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    },
  };
}

test('dev restart preflight follows the canonical local-versus-external server topology', async (t) => {
  const temp = await withTempDir();
  const storageDir = join(temp.dir, 'storage');
  const rootDir = join(temp.dir, 'repo');
  const serverDir = join(rootDir, 'apps', 'server');
  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });

  try {
    await mkdir(join(rootDir, 'scripts'), { recursive: true });
    await mkdir(serverDir, { recursive: true });
    await mkdir(join(rootDir, 'apps', 'cli'), { recursive: true });
    await mkdir(join(rootDir, 'apps', 'ui'), { recursive: true });
    await writeFile(join(rootDir, 'package.json'), '{"private":true}\n', 'utf8');
    await writeFile(join(rootDir, 'scripts', 'dev.mjs'), 'process.exit(17);\n', 'utf8');
    await writeFile(join(serverDir, 'preflight.mjs'), "await import('node:fs/promises').then(({ writeFile }) => writeFile(process.env.PREFLIGHT_MARKER, 'ran\\n'));\n", 'utf8');
    await writeFile(join(serverDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/server',
      private: true,
      scripts: { 'typecheck:runtime': 'node ./preflight.mjs' },
    }) + '\n', 'utf8');
    await writeFile(join(rootDir, 'apps', 'cli', 'package.json'), '{"name":"@happier-dev/cli","private":true}\n', 'utf8');
    await writeFile(join(rootDir, 'apps', 'ui', 'package.json'), '{"name":"@happier-dev/app","private":true}\n', 'utf8');

    const cases = [
      {
        name: 'no-server-env',
        args: ['--no-server'],
        env: ['HAPPIER_SERVER_URL=https://external.example.test'],
        expectsPreflight: false,
      },
      {
        name: 'explicit-server-url',
        args: ['--server-url=https://external.example.test'],
        env: [],
        expectsPreflight: false,
      },
      {
        name: 'local-server',
        args: [],
        env: [],
        expectsPreflight: true,
      },
    ];
    for (const scenario of cases) {
      const stackName = `external-${scenario.name}`;
      const stackDir = join(storageDir, stackName);
      const markerPath = join(temp.dir, `${scenario.name}.preflight`);
      await mkdir(stackDir, { recursive: true });
      await writeFile(
        join(stackDir, 'env'),
        [
          `HAPPIER_STACK_REPO_DIR=${rootDir}`,
          'HAPPIER_STACK_SERVER_COMPONENT=happier-server',
          'HAPPIER_STACK_MANAGED_INFRA=0',
          `PREFLIGHT_MARKER=${markerPath}`,
          ...scenario.env,
        ].join('\n') + '\n',
        'utf8',
      );

      await assert.rejects(
        runStackScriptWithStackEnv({
          rootDir,
          stackName,
          scriptPath: 'dev.mjs',
          args: [...scenario.args, '--no-ui', '--no-browser', '--no-daemon', '--no-dev-targets', '--restart'],
        }),
        /exited \(code=17/,
      );
      if (scenario.expectsPreflight) {
        assert.equal(await readFile(markerPath, 'utf8'), 'ran\n');
      } else {
        await assert.rejects(readFile(markerPath, 'utf8'), { code: 'ENOENT' });
      }
    }
  } finally {
    restore();
    await temp.cleanup();
  }
});

test('background dev readiness follows the selected external server for ephemeral and pinned stacks', async (t) => {
  const temp = await withTempDir();
  const storageDir = join(temp.dir, 'storage');
  const rootDir = join(temp.dir, 'repo');
  const externalServer = await withListeningServer();
  const restore = withPatchedProcessEnv(t, {
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_STACK_BACKGROUND_READY_TIMEOUT_MS: '300',
  });

  try {
    await mkdir(join(rootDir, 'scripts'), { recursive: true });
    await mkdir(join(rootDir, 'apps', 'server'), { recursive: true });
    await mkdir(join(rootDir, 'apps', 'cli'), { recursive: true });
    await mkdir(join(rootDir, 'apps', 'ui'), { recursive: true });
    await writeFile(join(rootDir, 'package.json'), '{"private":true}\n', 'utf8');
    await writeFile(
      join(rootDir, 'scripts', 'dev.mjs'),
      "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);\n",
      'utf8',
    );

    const externalServerUrl = `http://127.0.0.1:${externalServer.port}`;
    const cases = [
      { name: 'ephemeral-explicit', pinned: false, args: [`--server-url=${externalServerUrl}`], env: [] },
      { name: 'ephemeral-env', pinned: false, args: ['--no-server'], env: [`HAPPIER_SERVER_URL=${externalServerUrl}`] },
      { name: 'pinned-explicit', pinned: true, args: [`--server-url=${externalServerUrl}`], env: [] },
      { name: 'pinned-env', pinned: true, args: ['--no-server'], env: [`HAPPIER_SERVER_URL=${externalServerUrl}`] },
    ];

    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        const stackName = `background-external-${scenario.name}`;
        const stackDir = join(storageDir, stackName);
        const pinnedPort = scenario.pinned ? await reserveUnusedPort() : null;
        await mkdir(stackDir, { recursive: true });
        await writeFile(
          join(stackDir, 'env'),
          [
            `HAPPIER_STACK_REPO_DIR=${rootDir}`,
            'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
            'HAPPIER_STACK_MANAGED_INFRA=0',
            ...(pinnedPort ? [`HAPPIER_STACK_SERVER_PORT=${pinnedPort}`] : []),
            ...scenario.env,
          ].join('\n') + '\n',
          'utf8',
        );

        try {
          await runStackScriptWithStackEnv({
            rootDir,
            stackName,
            scriptPath: 'dev.mjs',
            args: [...scenario.args, '--no-ui', '--no-browser', '--no-daemon', '--no-dev-targets'],
            background: true,
          });
        } finally {
          const runtimeState = await readFile(join(stackDir, 'stack.runtime.json'), 'utf8')
            .then((value) => JSON.parse(value))
            .catch(() => null);
          const ownerPid = Number(runtimeState?.ownerPid);
          if (Number.isFinite(ownerPid) && ownerPid > 1) {
            try {
              process.kill(process.platform === 'win32' ? ownerPid : -ownerPid, 'SIGTERM');
            } catch {
              // The failed readiness path already terminates its runner.
            }
          }
        }
      });
    }
  } finally {
    restore();
    await externalServer.close();
    await temp.cleanup();
  }
});

test('failed restart cleanup preserves a same-pid successor with a new lifecycle incarnation', async () => {
  const temp = await withTempDir();
  try {
    const stackName = 'restart-cleanup-incarnation-race';
    const baseDir = join(temp.dir, 'stack');
    const cliHomeDir = join(baseDir, 'cli');
    const envPath = join(baseDir, 'env');
    const runtimeStatePath = join(baseDir, 'stack.runtime.json');
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(envPath, `HAPPIER_STACK_STACK=${stackName}\n`, 'utf8');
    const predecessor = {
      version: 1,
      stackName,
      ownerPid: 999_999,
      startedAt: '2026-07-17T08:00:00.000Z',
      processes: {},
    };
    const successor = {
      ...predecessor,
      startedAt: '2026-07-17T08:00:00.001Z',
      sentinel: 'successor',
    };
    await writeFile(runtimeStatePath, `${JSON.stringify(successor)}\n`, 'utf8');

    await cleanupFailedRestartAttempt({
      rootDir: temp.dir,
      stackName,
      baseDir,
      env: {
        ...process.env,
        HAPPIER_STACK_STACK: stackName,
        HAPPIER_STACK_ENV_FILE: envPath,
        HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
        HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light',
      },
      runtimeStatePath,
      expectedRuntimeState: predecessor,
      wantsJson: true,
    });

    assert.deepEqual(JSON.parse(await readFile(runtimeStatePath, 'utf8')), successor);
  } finally {
    await temp.cleanup();
  }
});

test('failed restart cleanup finalizes a definitively unowned reused runner without signaling it', { timeout: 15_000 }, async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process-group signal observation');
    return;
  }

  const temp = await withTempDir();
  const stackName = 'restart-cleanup-process-tree-owner';
  const baseDir = join(temp.dir, 'stack');
  const cliHomeDir = join(baseDir, 'cli');
  const envPath = join(baseDir, 'env');
  const runtimeStatePath = join(baseDir, 'stack.runtime.json');
  const leaderSignalPath = join(temp.dir, 'leader-signal.txt');
  const listenerSignalPath = join(temp.dir, 'listener-signal.txt');
  await mkdir(cliHomeDir, { recursive: true });
  await writeFile(envPath, `HAPPIER_STACK_STACK=${stackName}\n`, 'utf8');

  const listenerSource = `
    const fs = require('fs');
    const net = require('net');
    const signalPath = process.argv[1];
    process.on('SIGTERM', () => {});
    process.on('SIGINT', () => {
      fs.writeFileSync(signalPath, 'SIGINT');
      process.exit(0);
    });
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write(JSON.stringify({ listenerPid: process.pid, port: server.address().port }) + '\\n');
    });
  `;
  const leaderSource = `
    const fs = require('fs');
    const { spawn } = require('child_process');
    const leaderSignalPath = process.argv[1];
    const listenerSignalPath = process.argv[2];
    const listenerSource = process.argv[3];
    process.on('SIGTERM', () => {});
    process.on('SIGINT', () => {
      fs.writeFileSync(leaderSignalPath, 'SIGINT');
      process.exit(0);
    });
    spawn(process.execPath, ['-e', listenerSource, listenerSignalPath], {
      stdio: ['ignore', 'inherit', 'ignore'],
      env: { PATH: process.env.PATH },
    });
    setInterval(() => {}, 1000);
  `;
  const owner = spawn(
    process.execPath,
    ['-e', leaderSource, leaderSignalPath, listenerSignalPath, listenerSource],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH },
    },
  );
  const listenerMeta = await new Promise((resolve, reject) => {
    let output = '';
    owner.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const newline = output.indexOf('\n');
      if (newline >= 0) resolve(JSON.parse(output.slice(0, newline)));
    });
    owner.once('error', reject);
    owner.once('exit', (code) => reject(new Error(`fixture owner exited early (${code ?? 'unknown'})`)));
  });
  owner.unref();

  t.after(async () => {
    try {
      process.kill(-owner.pid, 'SIGKILL');
    } catch {
      // already stopped
    }
    await temp.cleanup();
  });

  const expectedRuntimeState = {
    version: 1,
    stackName,
    ownerPid: owner.pid,
    startedAt: '2026-07-20T09:30:00.000Z',
    processes: {},
  };
  await writeFile(runtimeStatePath, `${JSON.stringify(expectedRuntimeState)}\n`, 'utf8');

  const result = await cleanupFailedRestartAttempt({
    rootDir: temp.dir,
    stackName,
    baseDir,
    env: {
      ...process.env,
      HAPPIER_STACK_STACK: stackName,
      HAPPIER_STACK_ENV_FILE: envPath,
      HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir,
      HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light',
      HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: '100',
    },
    runtimeStatePath,
    expectedRuntimeState,
    wantsJson: true,
  });

  assert.equal(result.cleaned, true);
  assert.equal(result.reason, 'deleted');
  await assert.rejects(() => readFile(leaderSignalPath, 'utf8'), (error) => error?.code === 'ENOENT');
  await assert.rejects(() => readFile(listenerSignalPath, 'utf8'), (error) => error?.code === 'ENOENT');
  await assert.rejects(() => readFile(runtimeStatePath, 'utf8'), (error) => error?.code === 'ENOENT');
  assert.equal(Number(listenerMeta.listenerPid) > 1, true);
});

test('inspectExistingStartLikeRuntime does not short-circuit dev when server is up but Expo UI is down', async () => {
  const server = await withListeningServer();
  const staleUiPort = await reserveUnusedPort();
  try {
    const runtimeState = {
      ownerPid: 999_999_999,
      ports: { server: server.port },
      processes: {
        serverPid: 999_999_998,
        expoPid: 999_999_997,
      },
      expo: {
        webPort: staleUiPort,
        port: staleUiPort,
        webEnabled: true,
      },
    };

    const status = await inspectExistingStartLikeRuntime({
      scriptPath: 'dev.mjs',
      args: [],
      runtimeState,
    });

    assert.equal(status.serverRunning, true);
    assert.equal(status.uiRunning, false);
    assert.equal(status.canShortCircuit, false);
    assert.equal(status.wasRunning, true);
    assert.equal(shouldAdoptOccupiedRuntimePortsForRecovery(status), true);
  } finally {
    await server.close();
  }
});

test('inspectExistingStartLikeRuntime does not short-circuit run when only Expo-side processes are alive', async () => {
  const status = await inspectExistingStartLikeRuntime({
    scriptPath: 'run.mjs',
    args: [],
    runtimeState: {
      processes: {
        expoPid: process.pid,
        expoTailscaleForwarderPid: process.pid,
      },
    },
  });

  assert.equal(status.serverRunning, false);
  assert.equal(status.uiRunning, false);
  assert.equal(status.wasRunning, true);
  assert.equal(status.canShortCircuit, false);
});

test('inspectExistingStartLikeRuntime does not short-circuit run for an untrusted live server pid', async () => {
  const staleServerPort = await reserveUnusedPort();
  const status = await inspectExistingStartLikeRuntime({
    stackName: 'test-stack',
    envPath: join(os.tmpdir(), 'hstack-untrusted-server-env'),
    scriptPath: 'run.mjs',
    args: [],
    runtimeState: {
      ports: { server: staleServerPort },
      processes: {
        serverPid: process.pid,
      },
    },
  });

  assert.equal(status.serverRunning, false);
  assert.equal(status.wasRunning, false);
  assert.equal(status.canShortCircuit, false);
});

test('inspectExistingStartLikeRuntime allows dev short-circuit when stack Expo state is running', async () => {
  const stackName = 'test-stack';
  const server = await withListeningServer();
  const metroNeedle = join(os.tmpdir(), 'hstack-metro-needle');
  const metro = await spawnMetroLikeServer({ includeNeedle: metroNeedle });
  const temp = await withTempDir();
  const envPath = join(temp.dir, 'env');
  await writeFile(envPath, 'DUMMY=1\n', 'utf8');
  try {
    const expoDevRoot = join(temp.dir, 'expo-dev', 'abc123');
    await mkdir(expoDevRoot, { recursive: true });
    await writeFile(
      join(expoDevRoot, 'expo.state.json'),
      JSON.stringify({ pid: 999999, port: metro.port, projectDir: metroNeedle, webEnabled: true }, null, 2) + '\n',
      'utf8'
    );

    const staleUiPort = await reserveUnusedPort();
    const runtimeState = {
      ownerPid: 999_999_999,
      ports: { server: server.port },
      processes: {
        serverPid: 999_999_998,
        expoPid: 999_999_997,
      },
      expo: {
        webPort: staleUiPort,
        port: staleUiPort,
        webEnabled: true,
      },
    };

    const status = await inspectExistingStartLikeRuntime({
      stackName,
      envPath,
      baseDir: temp.dir,
      scriptPath: 'dev.mjs',
      args: [],
      runtimeState,
    });

    assert.equal(status.serverRunning, true);
    assert.equal(status.uiRunning, true);
    assert.equal(status.canShortCircuit, true);
    assert.equal(shouldAdoptOccupiedRuntimePortsForRecovery(status), false);
  } finally {
    await server.close();
    await metro.kill();
    await temp.cleanup();
  }
});

test('inspectExistingStartLikeRuntime allows mobile-only dev short-circuit when Expo state is running without web', async () => {
  const stackName = 'test-stack';
  const server = await withListeningServer();
  const metroNeedle = join(os.tmpdir(), 'hstack-mobile-metro-needle');
  const metro = await spawnMetroLikeServer({ includeNeedle: metroNeedle });
  const temp = await withTempDir();
  const envPath = join(temp.dir, 'env');
  await writeFile(envPath, 'DUMMY=1\n', 'utf8');
  try {
    const expoDevRoot = join(temp.dir, 'expo-dev', 'abc123');
    await mkdir(expoDevRoot, { recursive: true });
    await writeFile(
      join(expoDevRoot, 'expo.state.json'),
      JSON.stringify({ pid: 999999, port: metro.port, projectDir: metroNeedle, webEnabled: false }, null, 2) + '\n',
      'utf8',
    );

    const runtimeState = {
      ownerPid: 999_999_999,
      ports: { server: server.port },
      processes: {
        serverPid: 999_999_998,
        expoPid: 999_999_997,
      },
      expo: {
        port: metro.port,
        webEnabled: false,
      },
    };

    const status = await inspectExistingStartLikeRuntime({
      stackName,
      envPath,
      baseDir: temp.dir,
      scriptPath: 'dev.mjs',
      args: ['--no-ui', '--mobile'],
      runtimeState,
    });

    assert.equal(status.serverRunning, true);
    assert.equal(status.uiRunning, true);
    assert.equal(status.canShortCircuit, true);
    assert.equal(shouldAdoptOccupiedRuntimePortsForRecovery(status), false);
  } finally {
    await server.close();
    await metro.kill();
    await temp.cleanup();
  }
});

test('runStackScriptWithStackEnv reports the verified running Expo port instead of stale runtime UI metadata', async (t) => {
  const stackName = 'test-stack';
  const server = await withListeningServer();
  const metroNeedle = getComponentDir(process.cwd(), 'happier-ui', {
    ...process.env,
    HAPPIER_STACK_REPO_DIR: process.cwd(),
  });
  const metro = await spawnMetroLikeServer({ includeNeedle: metroNeedle });
  const staleUiPort = await reserveUnusedPort();
  const temp = await withTempDir();
  const storageDir = join(temp.dir, 'storage');
  const baseDir = join(storageDir, stackName);
  const logs = [];
  const originalLog = console.log;
  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });

  try {
    await mkdir(join(baseDir, 'expo-dev', 'abc123'), { recursive: true });
    await writeFile(
      join(baseDir, 'env'),
      [
        `HAPPIER_STACK_REPO_DIR=${process.cwd()}`,
        `HAPPIER_STACK_SERVER_PORT=${server.port}`,
      ].join('\n') + '\n',
      'utf8',
    );
    await writeFile(
      join(baseDir, 'stack.runtime.json'),
      JSON.stringify({
        version: 1,
        stackName,
        ownerPid: 999_999_999,
        ports: { server: server.port },
        processes: {
          serverPid: 999_999_998,
          expoPid: 999_999_997,
        },
        expo: {
          webPort: staleUiPort,
          port: staleUiPort,
          webEnabled: true,
        },
      }) + '\n',
      'utf8',
    );
    await writeFile(
      join(baseDir, 'expo-dev', 'abc123', 'expo.state.json'),
      JSON.stringify({ pid: 999_999, port: metro.port, projectDir: metroNeedle, webEnabled: true }, null, 2) + '\n',
      'utf8',
    );

    console.log = (...args) => {
      logs.push(args.join(' '));
    };

    await runStackScriptWithStackEnv({
      rootDir: process.cwd(),
      stackName,
      scriptPath: 'dev.mjs',
      args: ['--no-browser'],
    });

    const output = logs.join('\n');
    assert.match(output, new RegExp(`:${metro.port}\\b`));
    assert.doesNotMatch(output, new RegExp(`:${staleUiPort}\\b`));
  } finally {
    console.log = originalLog;
    restore();
    await metro.kill();
    await server.close();
    await temp.cleanup();
  }
});

test('runStackScriptWithStackEnv does not report stale UI metadata when dev short-circuits without UI requested', async (t) => {
  const stackName = 'test-stack';
  const server = await withListeningServer();
  const staleUiPort = await reserveUnusedPort();
  const temp = await withTempDir();
  const storageDir = join(temp.dir, 'storage');
  const baseDir = join(storageDir, stackName);
  const logs = [];
  const originalLog = console.log;
  const restore = withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });

  try {
    await mkdir(baseDir, { recursive: true });
    await writeFile(
      join(baseDir, 'env'),
      [
        `HAPPIER_STACK_REPO_DIR=${process.cwd()}`,
        `HAPPIER_STACK_SERVER_PORT=${server.port}`,
      ].join('\n') + '\n',
      'utf8',
    );
    await writeFile(
      join(baseDir, 'stack.runtime.json'),
      JSON.stringify({
        version: 1,
        stackName,
        ownerPid: 999_999_999,
        ports: { server: server.port },
        processes: {
          serverPid: 999_999_998,
          expoPid: 999_999_997,
        },
        expo: {
          webPort: staleUiPort,
          port: staleUiPort,
          webEnabled: true,
        },
      }) + '\n',
      'utf8',
    );

    console.log = (...args) => {
      logs.push(args.join(' '));
    };

    await runStackScriptWithStackEnv({
      rootDir: process.cwd(),
      stackName,
      scriptPath: 'dev.mjs',
      args: ['--no-ui', '--no-browser'],
    });

    const output = logs.join('\n');
    assert.match(output, new RegExp(`server=${server.port}\\b`));
    assert.doesNotMatch(output, new RegExp(`:${staleUiPort}\\b`));
    assert.doesNotMatch(output, new RegExp(`ui=${staleUiPort}\\b`));
  } finally {
    console.log = originalLog;
    restore();
    await server.close();
    await temp.cleanup();
  }
});

test('inspectExistingStartLikeRuntime does not treat an unrelated Metro as stack UI', async () => {
  const stackName = 'test-stack';
  const envPath = join(os.tmpdir(), 'hstack-env-file-does-not-exist');
  const temp = await withTempDir();
  const server = await withListeningServer();
  const metro = await spawnMetroLikeServer();
  try {
    const runtimeState = {
      ownerPid: 999_999_999,
      ports: { server: server.port },
      processes: {
        serverPid: 999_999_998,
        expoPid: 999_999_997,
      },
      expo: {
        webPort: metro.port,
        port: metro.port,
        webEnabled: true,
      },
    };

    const status = await inspectExistingStartLikeRuntime({
      stackName,
      envPath,
      baseDir: temp.dir,
      scriptPath: 'dev.mjs',
      args: [],
      runtimeState,
    });

    assert.equal(status.serverRunning, true);
    assert.equal(status.uiRunning, false);
    assert.equal(status.canShortCircuit, false);
    assert.equal(shouldAdoptOccupiedRuntimePortsForRecovery(status), true);
  } finally {
    await metro.kill();
    await server.close();
    await temp.cleanup();
  }
});

test('inspectExistingStartLikeRuntime does not short-circuit dev when Expo state is for a different UI dir', async () => {
  const stackName = 'test-stack';
  const server = await withListeningServer();
  const temp = await withTempDir();
  const envPath = join(temp.dir, 'env');
  await writeFile(envPath, 'DUMMY=1\n', 'utf8');

  const stateProjectDir = join(os.tmpdir(), 'hstack-metro-project-a');
  const expectedUiDir = join(os.tmpdir(), 'hstack-metro-project-b');
  const metro = await spawnMetroLikeServer({ includeNeedle: stateProjectDir });
  try {
    const expoDevRoot = join(temp.dir, 'expo-dev', 'abc123');
    await mkdir(expoDevRoot, { recursive: true });
    await writeFile(
      join(expoDevRoot, 'expo.state.json'),
      JSON.stringify({ pid: 999999, port: metro.port, projectDir: stateProjectDir, webEnabled: true }, null, 2) + '\n',
      'utf8'
    );

    const runtimeState = {
      ownerPid: 999_999_999,
      ports: { server: server.port },
      processes: { serverPid: 999_999_998, expoPid: 999_999_997 },
      expo: { webPort: metro.port, port: metro.port, webEnabled: true },
    };

    const status = await inspectExistingStartLikeRuntime({
      stackName,
      envPath,
      baseDir: temp.dir,
      expectedUiDir,
      scriptPath: 'dev.mjs',
      args: [],
      runtimeState,
    });

    assert.equal(status.serverRunning, true);
    assert.equal(status.uiRunning, false);
    assert.equal(status.canShortCircuit, false);
  } finally {
    await metro.kill();
    await server.close();
    await temp.cleanup();
  }
});
