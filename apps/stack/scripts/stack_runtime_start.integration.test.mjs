import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';

import {
  createStartableRuntimeSnapshotFixture,
  runNode,
  waitForHealth,
} from './testkit/runtime_snapshot_start_testkit.mjs';
import { checkDaemonStatePingAware } from './daemon.mjs';

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

async function waitForStackDaemonRunning({ fixture, env, timeoutMs = 60_000, previousPid = null }) {
  const startedAt = Date.now();
  let daemonStatus = null;

  while (Date.now() - startedAt < timeoutMs) {
    daemonStatus = await checkDaemonStatePingAware(fixture.cliHomeDir, {
      serverUrl: fixture.baseUrl,
      env,
    });
    const runtimeDaemonPid = await readFile(join(fixture.stackDir, 'stack.runtime.json'), 'utf8')
      .then((raw) => Number(JSON.parse(raw)?.processes?.daemonPid), () => null);
    if (
      /running/i.test(String(daemonStatus?.status ?? ''))
      && Number(runtimeDaemonPid) === Number(daemonStatus?.pid)
      && daemonStatus?.distClosureFingerprint === fixture.daemonDistClosureFingerprint
      && (!Number.isFinite(Number(previousPid)) || Number(daemonStatus?.pid) !== Number(previousPid))
    ) {
      return daemonStatus;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  assert.match(String(daemonStatus?.status ?? ''), /running/i);
  return daemonStatus;
}

async function waitForRuntimeRestartPublication({ fixture, previousOwnerPid, expectedDaemonPid, timeoutMs = 60_000 }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const runtime = await readFile(join(fixture.stackDir, 'stack.runtime.json'), 'utf8')
      .then((raw) => JSON.parse(raw), () => null);
    if (
      Number(runtime?.ownerPid) > 1
      && Number(runtime.ownerPid) !== Number(previousOwnerPid)
      && Number(runtime?.processes?.serverPid) > 1
      && Number(runtime?.processes?.daemonPid) === Number(expectedDaemonPid)
    ) {
      return runtime;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('timed out waiting for restarted runtime owner publication');
}

function terminateExecutorProcessGroup(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      child.kill('SIGTERM');
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    // The executor may already have exited.
  }
}

test('background start returns before readiness and survives its invoking executor termination', { timeout: 45_000 }, async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createStartableRuntimeSnapshotFixture(t, {
    stackName: 'runtime-detached-owner',
    serverReadyDelayMs: 4_000,
  });
  const executorResultPath = join(fixture.stackDir, 'executor-result.json');
  const executorPath = join(fixture.root, 'background-start-executor.mjs');
  const startArgs = [
    join(rootDir, 'bin', 'hstack.mjs'),
    'stack',
    'start',
    fixture.stackName,
    '--background',
    '--runtime',
    '--no-daemon',
    '--no-ui',
    '--no-browser',
  ];
  const env = {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_TEST_BACKGROUND_START_ARGS: JSON.stringify(startArgs),
    HAPPIER_TEST_BACKGROUND_START_RESULT: executorResultPath,
  };
  await writeFile(executorPath, `
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const startedAt = Date.now();
const result = spawnSync(process.execPath, JSON.parse(process.env.HAPPIER_TEST_BACKGROUND_START_ARGS), {
  cwd: ${JSON.stringify(rootDir)},
  env: process.env,
  stdio: 'ignore',
});
writeFileSync(process.env.HAPPIER_TEST_BACKGROUND_START_RESULT, JSON.stringify({
  status: result.status,
  signal: result.signal,
  elapsedMs: Date.now() - startedAt,
}) + '\\n');
setInterval(() => {}, 1_000);
`, 'utf8');

  const executor = spawn(process.execPath, [executorPath], {
    cwd: rootDir,
    env,
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });

  try {
    await waitFor(
      async () => await readFile(executorResultPath, 'utf8').then(() => true, () => false),
      { timeoutMs: 2_000, intervalMs: 25, label: 'prompt background command return' },
    );
    const executorResult = JSON.parse(await readFile(executorResultPath, 'utf8'));
    assert.equal(executorResult.status, 0, JSON.stringify(executorResult));
    assert.ok(
      executorResult.elapsedMs < 2_000,
      `background command waited ${executorResult.elapsedMs}ms for a server delayed by 4000ms`,
    );

    terminateExecutorProcessGroup(executor);
    await waitForHealth(fixture.baseUrl, { timeoutMs: 15_000 });

    const runtimeState = JSON.parse(await readFile(join(fixture.stackDir, 'stack.runtime.json'), 'utf8'));
    assert.ok(Number(runtimeState.ownerPid) > 1, `missing background owner: ${JSON.stringify(runtimeState)}`);
    assert.ok(isPidAlive(Number(runtimeState.ownerPid)), `background owner ${runtimeState.ownerPid} exited with its executor`);
  } finally {
    terminateExecutorProcessGroup(executor);
    await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'stop', fixture.stackName, '--yes'], {
      cwd: rootDir,
      env,
    });
  }
});

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
      join(fixture.snapshotDir, 'server', 'prisma', 'sqlite', 'migrations'),
    );
    assert.notEqual(
      serverRuntimeEnv.HAPPIER_SQLITE_MIGRATIONS_DIR,
      join(fixture.stackDir, 'runtime', 'current', 'server', 'prisma', 'sqlite', 'migrations'),
    );
    assert.equal(
      serverRuntimeEnv.DATABASE_URL,
      `${pathToFileURL(join(fixture.stackDir, 'server-light', 'happier-server-light.sqlite')).href}?socket_timeout=30&connection_limit=4`,
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

test('runtime stack projects the advertised web hostname as the signed auth audience', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createStartableRuntimeSnapshotFixture(t, { stackName: 'runtime-auth-audience' });
  const env = {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
  };

  const startRes = await runNode(
    [
      join(rootDir, 'bin', 'hstack.mjs'),
      'stack', 'start', fixture.stackName,
      '--background', '--runtime', '--no-daemon', '--no-browser',
    ],
    { cwd: rootDir, env },
  );
  assert.equal(startRes.code, 0, `stdout:\n${startRes.stdout}\nstderr:\n${startRes.stderr}`);

  try {
    await waitForHealth(fixture.baseUrl, { timeoutMs: 30_000 });
    const serverRuntimeEnv = JSON.parse(await readFile(fixture.serverEnvCapturePath, 'utf8'));
    assert.equal(
      serverRuntimeEnv.HAPPIER_PUBLIC_SERVER_URL,
      `http://happier-${fixture.stackName}.localhost:${fixture.serverPort}`,
    );
    assert.equal(serverRuntimeEnv.PUBLIC_URL, serverRuntimeEnv.HAPPIER_PUBLIC_SERVER_URL);
  } finally {
    await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'stop', fixture.stackName, '--yes'], {
      cwd: rootDir,
      env,
    });
  }
});

test('unmanaged full runtime migrates from the admitted immutable server directory before server spawn', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createStartableRuntimeSnapshotFixture(t, {
    stackName: 'runtime-full-migration',
    serverComponent: 'happier-server',
  });
  const env = {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
  };
  const startRes = await runNode([
    join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'start', fixture.stackName,
    '--background', '--runtime', '--no-daemon', '--no-ui', '--no-browser',
  ], { cwd: rootDir, env });

  try {
    assert.equal(startRes.code, 0, `stdout:\n${startRes.stdout}\nstderr:\n${startRes.stderr}`);
    await waitForHealth(fixture.baseUrl, { timeoutMs: 30_000 });
    const events = (await readFile(fixture.runtimeServerEventLogPath, 'utf8')).trim().split('\n');
    assert.equal(events.length, 2);
    assert.equal(events[1], 'server');
    assert.equal(
      events[0],
      `migration:${await realpath(join(fixture.snapshotDir, 'server'))}:postgres:postgresql://runtime-fixture.invalid/happier`,
    );
  } finally {
    await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'stop', fixture.stackName, '--yes'], { cwd: rootDir, env });
  }
});

test('unmanaged full runtime with no artifact migration command fails before normal server spawn', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createStartableRuntimeSnapshotFixture(t, {
    stackName: 'runtime-full-migration-missing',
    serverComponent: 'happier-server',
    runtimeMigration: 'missing',
  });
  const env = {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
  };
  const startRes = await runNode([
    join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'start', fixture.stackName,
    '--background', '--runtime', '--no-daemon', '--no-ui', '--no-browser',
  ], { cwd: rootDir, env });

  assert.notEqual(startRes.code, 0, `stdout:\n${startRes.stdout}\nstderr:\n${startRes.stderr}`);
  assert.match(`${startRes.stdout}\n${startRes.stderr}`, /runtime server migration unusable artifact migration command/i);
  assert.equal(await readFile(fixture.runtimeServerEventLogPath, 'utf8').catch(() => ''), '');
  const runtimeState = await readFile(join(fixture.stackDir, 'stack.runtime.json'), 'utf8')
    .then((raw) => JSON.parse(raw), () => null);
  assert.ok(!Number(runtimeState?.processes?.serverPid));
  assert.ok(!Number(runtimeState?.processes?.happierServerBackendPid));
  assert.ok(!Number(runtimeState?.processes?.uiGatewayPid));
  assert.ok(!Number(runtimeState?.processes?.daemonPid));
});

test('hstack stack start --runtime --no-ui publishes the effective disabled UI decision', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createStartableRuntimeSnapshotFixture(t, { stackName: 'runtime-no-ui' });
  const env = {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
  };

  const startRes = await runNode(
    [
      join(rootDir, 'bin', 'hstack.mjs'),
      'stack',
      'start',
      fixture.stackName,
      '--background',
      '--runtime',
      '--no-ui',
      '--no-daemon',
      '--no-browser',
    ],
    { cwd: rootDir, env },
  );
  assert.equal(startRes.code, 0, `stdout:\n${startRes.stdout}\nstderr:\n${startRes.stderr}`);

  try {
    await waitForHealth(fixture.baseUrl, { timeoutMs: 30_000 });
    const runtimeState = JSON.parse(await readFile(join(fixture.stackDir, 'stack.runtime.json'), 'utf8'));
    assert.equal(runtimeState.runtimeSnapshotId, 'snap-startable');
    assert.equal(runtimeState.serveUi, false);
  } finally {
    await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'stop', fixture.stackName, '--yes'], {
      cwd: rootDir,
      env,
    });
  }
});

test('hstack stack start --runtime --background fails when the requested daemon fails after server health', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createStartableRuntimeSnapshotFixture(t, { stackName: 'runtime-daemon-start-fails' });
  await writeFile(
    join(fixture.snapshotDir, 'cli', 'package-dist', 'index.mjs'),
    [
      "if (process.argv[2] === 'start') {",
      '  await new Promise((resolve) => setTimeout(resolve, 3000));',
      "  console.error('fixture daemon start failed after server health');",
      '  process.exit(23);',
      '}',
      'process.exit(0);',
      '',
    ].join('\n'),
    'utf8',
  );

  const env = {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_STACK_BACKGROUND_READY_TIMEOUT_MS: '15000',
  };
  const startRes = await runNode(
    [join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'start', fixture.stackName, '--background', '--runtime', '--no-browser'],
    { cwd: rootDir, env },
  );

  try {
    assert.notEqual(startRes.code, 0, `background start reported false success:\n${startRes.stdout}\n${startRes.stderr}`);
    assert.match(`${startRes.stdout}\n${startRes.stderr}`, /daemon|runner exited before becoming ready/i);
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
    const daemonBeforeRestart = await waitForStackDaemonRunning({ rootDir, fixture, env: topologyEnv });

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
    await waitForStackDaemonRunning({
      rootDir,
      fixture,
      env: baseEnv,
      previousPid: daemonBeforeRestart.pid,
    });

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
    await waitForStackDaemonRunning({
      rootDir,
      fixture,
      env: baseEnv,
      previousPid: daemonPidBefore,
    });

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
    await waitForRuntimeRestartPublication({
      fixture,
      previousOwnerPid: runtimeBefore.ownerPid,
      expectedDaemonPid: runtimeBefore.processes.daemonPid,
    });

    const infoRes = await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'info', fixture.stackName, '--json'], {
      cwd: rootDir,
      env: baseEnv,
    });
    assert.equal(infoRes.code, 0, `stdout:\n${infoRes.stdout}\nstderr:\n${infoRes.stderr}`);
    const snapshot = JSON.parse(infoRes.stdout.trim());
    assert.ok(!snapshot.runtime.health.issues.includes('daemon_down'));
    assert.equal(snapshot.runtime.components.daemon.running, true, JSON.stringify(snapshot.runtime.components.daemon));
    assert.equal(snapshot.runtime.components.daemon.pid, runtimeBefore.processes.daemonPid);
    assert.equal(snapshot.runtime.components.daemon.source, 'daemon_state');

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
    const daemonBeforeRestart = await waitForStackDaemonRunning({ rootDir, fixture, env: baseEnv });

    const restartRes = await runNode(restartArgs, { cwd: rootDir, env: baseEnv });
    assert.equal(restartRes.code, 0, `stdout:\n${restartRes.stdout}\nstderr:\n${restartRes.stderr}`);

    await waitForHealth(fixture.baseUrl, { timeoutMs: 30_000 });
    const daemonAfterRestart = await waitForStackDaemonRunning({
      rootDir,
      fixture,
      env: baseEnv,
      previousPid: daemonBeforeRestart.pid,
    });

    const infoRes = await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'info', fixture.stackName, '--json'], {
      cwd: rootDir,
      env: baseEnv,
    });
    assert.equal(infoRes.code, 0, `stdout:\n${infoRes.stdout}\nstderr:\n${infoRes.stderr}`);
    const snapshot = JSON.parse(infoRes.stdout.trim());
    assert.ok(!snapshot.runtime.health.issues.includes('daemon_down'));
    assert.equal(snapshot.runtime.components.daemon.running, true, JSON.stringify(snapshot.runtime.components.daemon));
    assert.equal(snapshot.runtime.components.daemon.pid, daemonAfterRestart.pid);
    assert.equal(snapshot.runtime.components.daemon.source, 'daemon_state');
  } finally {
    await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'stop', fixture.stackName, '--yes'], {
      cwd: rootDir,
      env: baseEnv,
    });
  }
});
