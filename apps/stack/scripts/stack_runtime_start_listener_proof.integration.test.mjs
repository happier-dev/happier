import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import { isTcpPortListening } from './utils/net/ports.mjs';
import {
  createStartableRuntimeSnapshotFixture,
  runNode,
  waitForHealth,
} from './testkit/runtime_snapshot_start_testkit.mjs';

function stackRootDirFromMeta(metaUrl) {
  return dirname(dirname(fileURLToPath(metaUrl)));
}

async function waitForPidExit(pid, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`pid ${pid} remained alive after ${timeoutMs}ms`);
}

async function waitForRecordedServerPids(statePath, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await readFile(statePath, 'utf8').then(JSON.parse, () => null);
    if (Number(state?.processes?.serverPid) > 1 && Number(state?.processes?.serverWrapperPid) > 1) return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`server pids were not recorded in ${statePath}`);
}

async function waitForRecordedServerWrapperPid(statePath, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await readFile(statePath, 'utf8').then(JSON.parse, () => null);
    if (Number(state?.processes?.serverWrapperPid) > 1) return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`server wrapper pid was not recorded in ${statePath}`);
}

async function waitForLogMatch(path, pattern, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const content = await readFile(path, 'utf8').catch(() => '');
    if (pattern.test(content)) return content;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`log ${path} did not match ${pattern}`);
}

test('runtime start proves its spawned listener after a loaded group-filtered discovery', async (t) => {
  if (process.platform === 'win32') return t.skip('process-group listener proof is POSIX-specific');
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createStartableRuntimeSnapshotFixture(t, {
    stackName: 'runtime-spawned-listener-proof',
    listenerDiscoveryMode: 'delayed-group-proof',
  });
  const env = {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    ...fixture.listenerDiscoveryEnv,
  };
  const args = [
    join(rootDir, 'bin', 'hstack.mjs'),
    'stack', 'start', fixture.stackName, '--background', '--runtime', '--no-browser',
  ];

  const startRes = await runNode(args, { cwd: rootDir, env });
  assert.equal(startRes.code, 0, `stdout:\n${startRes.stdout}\nstderr:\n${startRes.stderr}`);
  try {
    await waitForHealth(fixture.baseUrl);
    const runtimeState = await waitForRecordedServerPids(join(fixture.stackDir, 'stack.runtime.json'));
    assert.ok(Number(runtimeState?.processes?.serverPid) > 1);
    assert.equal(runtimeState.processes.serverPid, runtimeState.processes.serverWrapperPid);
    const discoveryLog = await readFile(fixture.listenerDiscoveryLogPath, 'utf8');
    assert.match(discoveryLog, /group:\d+/);
  } finally {
    await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'stop', fixture.stackName, '--yes'], {
      cwd: rootDir,
      env: { ...env, PATH: process.env.PATH },
    });
  }
});

test('runtime start retries a transient empty spawned-group listener observation', async (t) => {
  if (process.platform === 'win32') return t.skip('process-group listener proof is POSIX-specific');
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createStartableRuntimeSnapshotFixture(t, {
    stackName: 'runtime-spawned-listener-transient-empty',
    listenerDiscoveryMode: 'transient-empty-then-group-proof',
  });
  const env = {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    ...fixture.listenerDiscoveryEnv,
  };
  const args = [
    join(rootDir, 'bin', 'hstack.mjs'),
    'stack', 'start', fixture.stackName, '--background', '--runtime', '--no-browser',
  ];

  const startRes = await runNode(args, { cwd: rootDir, env });
  assert.equal(startRes.code, 0, `stdout:\n${startRes.stdout}\nstderr:\n${startRes.stderr}`);
  try {
    await waitForHealth(fixture.baseUrl);
    const runtimeState = await waitForRecordedServerPids(join(fixture.stackDir, 'stack.runtime.json'));
    assert.ok(Number(runtimeState?.processes?.serverPid) > 1);
    const discoveryLog = await readFile(fixture.listenerDiscoveryLogPath, 'utf8');
    assert.match(discoveryLog, /empty-group:\d+/);
    assert.match(discoveryLog, /group:\d+/);
  } finally {
    await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'stop', fixture.stackName, '--yes'], {
      cwd: rootDir,
      env: { ...env, PATH: process.env.PATH },
    });
  }
});

test('runtime start keeps a ready server when spawned and broad listener discovery stay inconclusive', async (t) => {
  if (process.platform === 'win32') return t.skip('process-group listener proof is POSIX-specific');
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createStartableRuntimeSnapshotFixture(t, {
    stackName: 'runtime-spawned-listener-inconclusive',
    listenerDiscoveryMode: 'all-inconclusive-after-ready',
  });
  const env = {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    ...fixture.listenerDiscoveryEnv,
  };
  const args = [
    join(rootDir, 'bin', 'hstack.mjs'),
    'stack', 'start', fixture.stackName, '--background', '--runtime', '--no-browser', '--no-daemon',
  ];

  const startRes = await runNode(args, { cwd: rootDir, env });
  assert.equal(startRes.code, 0, `stdout:\n${startRes.stdout}\nstderr:\n${startRes.stderr}`);
  const logPath = startRes.stdout.match(/logs:\s*(.+)\s*$/m)?.[1]?.trim();
  assert.ok(logPath, `missing background run log path in stdout:\n${startRes.stdout}`);
  try {
    await waitForHealth(fixture.baseUrl);
    await waitForLogMatch(logPath, /listener ownership on port \d+ could not be proven/i);
    const spawnedPid = Number(await readFile(fixture.serverPidCapturePath, 'utf8'));
    assert.ok(spawnedPid > 1);
    // A diagnostic that learned nothing must not destroy the server it already proved ready.
    process.kill(spawnedPid, 0);
    assert.equal(await isTcpPortListening(fixture.serverPort), true);
    const runtimeState = await waitForRecordedServerWrapperPid(join(fixture.stackDir, 'stack.runtime.json'));
    assert.equal(
      runtimeState.processes.serverPid ?? null,
      null,
      'an unproven listener PID must never be recorded as a kill target',
    );
  } finally {
    await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'stack', 'stop', fixture.stackName, '--yes'], {
      cwd: rootDir,
      env: { ...env, PATH: process.env.PATH },
    });
  }
  // The wrapper PID we actually spawned stays recorded, so stop still terminates the whole stack.
  const spawnedPid = Number(await readFile(fixture.serverPidCapturePath, 'utf8'));
  await waitForPidExit(spawnedPid);
  assert.equal(await isTcpPortListening(fixture.serverPort), false);
});
