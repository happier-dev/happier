import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import {
  createStartableRuntimeSnapshotFixture,
  runNode,
  waitForHealth,
} from './testkit/runtime_snapshot_start_testkit.mjs';

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
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
    assert.equal(
      serverRuntimeEnv.HAPPIER_SQLITE_MIGRATIONS_DIR,
      join(fixture.stackDir, 'runtime', 'current', 'server', 'prisma', 'sqlite', 'migrations'),
    );
    assert.equal(
      serverRuntimeEnv.DATABASE_URL,
      `file:${join(fixture.stackDir, 'server-light', 'happier-server-light.sqlite')}`,
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
