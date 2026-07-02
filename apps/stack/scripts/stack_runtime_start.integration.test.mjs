import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, rm, writeFile } from 'node:fs/promises';

import {
  createStartableRuntimeSnapshotFixture,
  runNode,
  waitForHealth,
} from './testkit/runtime_snapshot_start_testkit.mjs';

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition, { timeoutMs = 10_000, intervalMs = 100, label = 'condition' } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForStackDaemonRunning({ rootDir, fixture, env, timeoutMs = 10_000 }) {
  const startedAt = Date.now();
  let daemonStatus = null;

  while (Date.now() - startedAt < timeoutMs) {
    const statusRes = await runNode(
      [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'daemon', fixture.stackName, 'status', '--json'],
      { cwd: rootDir, env },
    );
    assert.equal(statusRes.code, 0, `stdout:\n${statusRes.stdout}\nstderr:\n${statusRes.stderr}`);
    daemonStatus = JSON.parse(statusRes.stdout.trim());
    if (/running/i.test(String(daemonStatus?.status ?? ''))) {
      return daemonStatus;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  assert.match(String(daemonStatus?.status ?? ''), /running/i);
  return daemonStatus;
}

test('hstack stack start --runtime --background launches the active runtime snapshot', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createStartableRuntimeSnapshotFixture(t, { stackName: 'runtime-prod' });

  const env = {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
  };

  const startRes = await runNode(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'start', fixture.stackName, '--background', '--runtime', '--no-browser'],
    { cwd: rootDir, env },
  );
  assert.equal(startRes.code, 0, `stdout:\n${startRes.stdout}\nstderr:\n${startRes.stderr}`);

  try {
    await waitForHealth(fixture.baseUrl, { timeoutMs: 30_000 });
    const indexRes = await fetch(fixture.baseUrl);
    const indexHtml = await indexRes.text();
    assert.equal(indexRes.status, 200);
    assert.match(indexHtml, /RUNTIME SNAPSHOT UI/);

    const runtimeState = JSON.parse(await readFile(join(fixture.stackDir, 'stack.runtime.json'), 'utf8'));
    assert.equal(runtimeState.runtimeSnapshotId, 'snap-startable');

    const serverRuntimeEnv = JSON.parse(await readFile(fixture.serverEnvCapturePath, 'utf8'));
    assert.equal(serverRuntimeEnv.HAPPIER_SQLITE_AUTO_MIGRATE, '1');
    assert.equal(serverRuntimeEnv.HAPPIER_PUBLIC_SERVER_URL, serverRuntimeEnv.PUBLIC_URL);
    assert.equal(
      serverRuntimeEnv.HAPPIER_SQLITE_MIGRATIONS_DIR,
      join(fixture.stackDir, 'runtime', 'current', 'server', 'prisma', 'sqlite', 'migrations'),
    );
    assert.equal(
      serverRuntimeEnv.DATABASE_URL,
      `${pathToFileURL(join(fixture.stackDir, 'server-light', 'happier-server-light.sqlite')).href}?socket_timeout=30`,
    );
    assert.equal(serverRuntimeEnv.HAPPIER_SERVER_LIGHT_DATA_DIR, join(fixture.stackDir, 'server-light'));

    await waitForStackDaemonRunning({ rootDir, fixture, env });
  } finally {
    await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'stop', fixture.stackName, '--yes'], {
      cwd: rootDir,
      env,
    });
  }
});

test('hstack stack start --runtime --restart reuses persisted direct-peer topology env', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createStartableRuntimeSnapshotFixture(t, { stackName: 'runtime-direct-peer' });

  const baseEnv = {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
  };
  const topologyEnv = {
    ...baseEnv,
    HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS: 'host.lima.internal',
    HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT: '13378',
    HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED: 'true',
    HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED: 'true',
  };

  const startArgs = [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'start', fixture.stackName, '--background', '--runtime', '--no-browser'];
  const restartArgs = [...startArgs, '--restart'];

  const startRes = await runNode(startArgs, { cwd: rootDir, env: topologyEnv });
  assert.equal(startRes.code, 0, `stdout:\n${startRes.stdout}\nstderr:\n${startRes.stderr}`);

  try {
    await waitForHealth(fixture.baseUrl, { timeoutMs: 30_000 });
    await waitForStackDaemonRunning({ rootDir, fixture, env: topologyEnv });

    const envTextAfterStart = await readFile(join(fixture.stackDir, 'env'), 'utf8');
    assert.match(envTextAfterStart, /HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS=host\.lima\.internal/);
    assert.match(envTextAfterStart, /HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT=13378/);
    assert.match(envTextAfterStart, /HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED=true/);
    assert.match(envTextAfterStart, /HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED=true/);

    const daemonLogPath = join(fixture.cliHomeDir, 'runtime-daemon.log');
    const daemonLogAfterStart = await readFile(daemonLogPath, 'utf8');
    assert.match(daemonLogAfterStart, /direct_peer_bind_port=13378/);
    assert.match(daemonLogAfterStart, /direct_peer_advertised_hosts=host\.lima\.internal/);
    assert.match(daemonLogAfterStart, /direct_peer_feature_enabled=true/);
    assert.match(daemonLogAfterStart, /direct_peer_server_enabled=true/);

    const restartRes = await runNode(restartArgs, { cwd: rootDir, env: baseEnv });
    assert.equal(restartRes.code, 0, `stdout:\n${restartRes.stdout}\nstderr:\n${restartRes.stderr}`);
    await waitForHealth(fixture.baseUrl, { timeoutMs: 30_000 });
    await waitForStackDaemonRunning({ rootDir, fixture, env: baseEnv });

    const restartedDaemonLog = await readFile(daemonLogPath, 'utf8');
    const appendedLog = restartedDaemonLog.slice(daemonLogAfterStart.length);
    assert.match(appendedLog, /direct_peer_bind_port=13378/);
    assert.match(appendedLog, /direct_peer_advertised_hosts=host\.lima\.internal/);
    assert.match(appendedLog, /direct_peer_feature_enabled=true/);
    assert.match(appendedLog, /direct_peer_server_enabled=true/);
  } finally {
    await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'stop', fixture.stackName, '--yes'], {
      cwd: rootDir,
      env: baseEnv,
    });
  }
});

test('hstack stack start --runtime --restart restarts the daemon in service mode when credentials are available', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createStartableRuntimeSnapshotFixture(t, { stackName: 'runtime-daemon-restart' });

  const baseEnv = {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_SERVICE_MODE: '1',
  };

  const startArgs = [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'start', fixture.stackName, '--background', '--runtime', '--no-browser'];
  const restartArgs = [...startArgs, '--restart'];

  const startRes = await runNode(startArgs, { cwd: rootDir, env: baseEnv });
  assert.equal(startRes.code, 0, `stdout:\n${startRes.stdout}\nstderr:\n${startRes.stderr}`);

  try {
    await waitForHealth(fixture.baseUrl, { timeoutMs: 30_000 });
    await waitForStackDaemonRunning({ rootDir, fixture, env: baseEnv });

    const runtimeBefore = JSON.parse(await readFile(join(fixture.stackDir, 'stack.runtime.json'), 'utf8'));
    const daemonPidBefore = Number(runtimeBefore?.processes?.daemonPid);
    assert.ok(daemonPidBefore > 1, `expected daemon pid before restart, got ${String(runtimeBefore?.processes?.daemonPid)}`);

    const restartRes = await runNode(restartArgs, { cwd: rootDir, env: baseEnv });
    assert.equal(restartRes.code, 0, `stdout:\n${restartRes.stdout}\nstderr:\n${restartRes.stderr}`);
    await waitForHealth(fixture.baseUrl, { timeoutMs: 30_000 });
    await waitForStackDaemonRunning({ rootDir, fixture, env: baseEnv });

    const runtimeAfter = JSON.parse(await readFile(join(fixture.stackDir, 'stack.runtime.json'), 'utf8'));
    const daemonPidAfter = Number(runtimeAfter?.processes?.daemonPid);
    assert.ok(daemonPidAfter > 1, `expected daemon pid after restart, got ${String(runtimeAfter?.processes?.daemonPid)}`);
    assert.notEqual(daemonPidAfter, daemonPidBefore, 'expected --restart to restart the daemon when credentials are available');
  } finally {
    await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'stop', fixture.stackName, '--yes'], {
      cwd: rootDir,
      env: baseEnv,
    });
  }
});

test('hstack stack start --runtime --restart keeps a service-owned daemon alive across restart when credentials are absent', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createStartableRuntimeSnapshotFixture(t, { stackName: 'runtime-service-restart' });

  const baseEnv = {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
  };

  await writeFile(
    join(fixture.stackDir, 'env'),
    [
      `HAPPIER_STACK_STACK=${fixture.stackName}`,
      `HAPPIER_STACK_REPO_DIR=${rootDir}`,
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      `HAPPIER_STACK_SERVER_PORT=${fixture.serverPort}`,
      `HAPPIER_STACK_CLI_HOME_DIR=${fixture.cliHomeDir}`,
      'HAPPIER_STACK_RUNTIME_MODE=require',
      'HAPPIER_STACK_TAILSCALE_SERVE=0',
      'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
      'HAPPIER_STACK_SERVICE_MODE=1',
      'HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH=1',
      'HAPPIER_RUNTIME_SNAPSHOT_MARKER=snap-startable',
      `HAPPIER_RUNTIME_SERVER_ENV_CAPTURE_PATH=${fixture.serverEnvCapturePath}`,
      '',
    ].join('\n'),
    'utf8',
  );

  const startArgs = [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'start', fixture.stackName, '--background', '--runtime', '--no-browser'];
  const restartArgs = [...startArgs, '--restart'];

  const startRes = await runNode(startArgs, { cwd: rootDir, env: baseEnv });
  assert.equal(startRes.code, 0, `stdout:\n${startRes.stdout}\nstderr:\n${startRes.stderr}`);

  try {
    await waitForHealth(fixture.baseUrl, { timeoutMs: 30_000 });
    await waitForStackDaemonRunning({ rootDir, fixture, env: baseEnv });

    const runtimeBefore = JSON.parse(await readFile(join(fixture.stackDir, 'stack.runtime.json'), 'utf8'));
    assert.ok(Number(runtimeBefore?.processes?.daemonPid) > 1, 'expected daemon pid to be recorded before restart');

    await rm(join(fixture.cliHomeDir, 'servers'), { recursive: true, force: true });
    await rm(join(fixture.cliHomeDir, 'access.key'), { force: true });

    const restartRes = await runNode(restartArgs, { cwd: rootDir, env: baseEnv });
    assert.equal(restartRes.code, 0, `stdout:\n${restartRes.stdout}\nstderr:\n${restartRes.stderr}`);

    await waitForHealth(fixture.baseUrl, { timeoutMs: 30_000 });

    const infoRes = await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'info', fixture.stackName, '--json'], {
      cwd: rootDir,
      env: baseEnv,
    });
    assert.equal(infoRes.code, 0, `stdout:\n${infoRes.stdout}\nstderr:\n${infoRes.stderr}`);
    const snapshot = JSON.parse(infoRes.stdout.trim());
    assert.equal(snapshot.runtime.health.status, 'healthy');
    assert.deepEqual(snapshot.runtime.health.issues, []);

    const runtimeAfter = JSON.parse(await readFile(join(fixture.stackDir, 'stack.runtime.json'), 'utf8'));
    assert.ok(Number(runtimeAfter?.processes?.daemonPid) > 1, 'expected daemon pid to survive restart');
    assert.equal(runtimeAfter?.processes?.daemonPid, runtimeBefore?.processes?.daemonPid);
  } finally {
    await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'stop', fixture.stackName, '--yes'], {
      cwd: rootDir,
      env: baseEnv,
    });
  }
});

test('hstack stack start --runtime --restart cleans preserved daemon state when the restart fails', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createStartableRuntimeSnapshotFixture(t, { stackName: 'runtime-restart-failure-cleanup' });

  const baseEnv = {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
  };

  const startArgs = [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'start', fixture.stackName, '--background', '--runtime', '--no-browser'];
  const restartArgs = [...startArgs, '--restart'];
  const runtimeStatePath = join(fixture.stackDir, 'stack.runtime.json');
  const runtimeServerEntrypointPaths = [
    join(fixture.snapshotDir, 'server', 'happier-server'),
    join(fixture.stackDir, 'runtime', 'current', 'server', 'happier-server'),
  ];

  const startRes = await runNode(startArgs, { cwd: rootDir, env: baseEnv });
  assert.equal(startRes.code, 0, `stdout:\n${startRes.stdout}\nstderr:\n${startRes.stderr}`);

  try {
    await waitForHealth(fixture.baseUrl, { timeoutMs: 30_000 });
    await waitForStackDaemonRunning({ rootDir, fixture, env: baseEnv });

    const runtimeBefore = JSON.parse(await readFile(runtimeStatePath, 'utf8'));
    const daemonPidBefore = Number(runtimeBefore?.processes?.daemonPid);
    assert.ok(daemonPidBefore > 1, `expected daemon pid before restart, got ${String(runtimeBefore?.processes?.daemonPid)}`);

    for (const runtimeServerEntrypointPath of runtimeServerEntrypointPaths) {
      await writeFile(
        runtimeServerEntrypointPath,
        '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\nsetTimeout(() => process.exit(41), 5000);\n',
        'utf8',
      );
    }

    const restartRes = await runNode(restartArgs, {
      cwd: rootDir,
      env: {
        ...baseEnv,
        HAPPIER_STACK_STACK_BACKGROUND_READY_TIMEOUT_MS: '200',
      },
    });
    assert.notEqual(restartRes.code, 0, 'expected restart to fail after forcing the runtime server entrypoint to miss the ready timeout');

    let lastObserved = null;
    try {
      await waitFor(
        async () => {
        const runtimeExists = await readFile(runtimeStatePath, 'utf8').then(() => true, () => false);
        const statusRes = await runNode(
          [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'daemon', fixture.stackName, 'status', '--json'],
          { cwd: rootDir, env: baseEnv },
        );
        lastObserved = {
          runtimeExists,
          daemonAlive: isPidAlive(daemonPidBefore),
          statusExitCode: statusRes.code,
          statusStdout: statusRes.stdout.trim(),
          statusStderr: statusRes.stderr.trim(),
          daemonStatus: null,
        };
        if (statusRes.code !== 0) {
          return false;
        }

        let daemonStatus = null;
        try {
          daemonStatus = JSON.parse(statusRes.stdout.trim());
        } catch {
          return false;
        }

        lastObserved.daemonStatus = daemonStatus?.status ?? null;

        return !runtimeExists && !lastObserved.daemonAlive && !/running/i.test(String(daemonStatus?.status ?? ''));
        },
        { timeoutMs: 15_000, intervalMs: 150, label: 'restart failure cleanup' },
      );
    } catch (error) {
      assert.fail(
        `${error instanceof Error ? error.message : String(error)}\nlast observed: ${JSON.stringify(lastObserved, null, 2)}`
      );
    }
  } finally {
    await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'stop', fixture.stackName, '--yes'], {
      cwd: rootDir,
      env: baseEnv,
    }).catch(() => {});
  }
});

test('hstack stack start --runtime --restart keeps a service-mode stack healthy', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createStartableRuntimeSnapshotFixture(t, { stackName: 'runtime-service-mode-restart' });

  const baseEnv = {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_SERVICE_MODE: '1',
  };

  const startArgs = [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'start', fixture.stackName, '--background', '--runtime', '--no-browser'];
  const restartArgs = [...startArgs, '--restart'];

  const startRes = await runNode(startArgs, { cwd: rootDir, env: baseEnv });
  assert.equal(startRes.code, 0, `stdout:\n${startRes.stdout}\nstderr:\n${startRes.stderr}`);

  try {
    await waitForHealth(fixture.baseUrl, { timeoutMs: 30_000 });
    await waitForStackDaemonRunning({ rootDir, fixture, env: baseEnv });

    const restartRes = await runNode(restartArgs, { cwd: rootDir, env: baseEnv });
    assert.equal(restartRes.code, 0, `stdout:\n${restartRes.stdout}\nstderr:\n${restartRes.stderr}`);

    await waitForHealth(fixture.baseUrl, { timeoutMs: 30_000 });
    await waitForStackDaemonRunning({ rootDir, fixture, env: baseEnv });

    const infoRes = await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'info', fixture.stackName, '--json'], {
      cwd: rootDir,
      env: baseEnv,
    });
    assert.equal(infoRes.code, 0, `stdout:\n${infoRes.stdout}\nstderr:\n${infoRes.stderr}`);
    const snapshot = JSON.parse(infoRes.stdout.trim());
    assert.equal(snapshot.runtime.health.status, 'healthy');
    assert.deepEqual(snapshot.runtime.health.issues, []);
  } finally {
    await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'stop', fixture.stackName, '--yes'], {
      cwd: rootDir,
      env: baseEnv,
    });
  }
});
