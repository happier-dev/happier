import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runNodeCapture as runNode } from './testkit/core/run_node_capture.mjs';
import {
  isAlive,
  setupStackStopSweepFixture,
  spawnOwnedSleep,
  waitForProcessAlive,
  waitForProcessExit,
} from './testkit/stack_stop_sweeps_testkit.mjs';

function terminateProcessTree(pid) {
  if (!Number.isFinite(pid) || pid <= 1) return;
  try {
    process.kill(-pid, 'SIGKILL');
    return;
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }
}

async function waitForLogMatch(path, pattern, { timeoutMs = 5_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(path, 'utf-8');
      if (pattern.test(raw)) {
        return raw;
      }
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return await readFile(path, 'utf-8');
}

test('stack owner-death watchdog reaps stale infra and preserves session processes', async (t) => {
  const fixture = await setupStackStopSweepFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'hstack-owner-death-watchdog-',
  });

  const sessionLike = fixture.trackChild(
    spawnOwnedSleep({
      env: {
        ...process.env,
        HAPPIER_STACK_STACK: fixture.stackName,
        HAPPIER_STACK_ENV_FILE: fixture.envPath,
        HAPPIER_STACK_PROCESS_KIND: 'session',
      },
    }),
  );
  assert.ok(Number(sessionLike.pid) > 1, 'expected session-like child pid');
  await waitForProcessAlive({ pid: sessionLike.pid, timeoutMs: 2_000, intervalMs: 25, label: 'session-like process' });

  const parentPath = join(fixture.tmp, 'owner-watchdog-parent.mjs');
  const runtimeStatePath = join(fixture.baseDir, 'stack.runtime.json');
  const watchdogLogPath = join(fixture.baseDir, 'logs', 'owner-death-watchdog.log');
  const ownerWatchdogUrl = pathToFileURL(join(fixture.rootDir, 'scripts', 'utils', 'stack', 'owner_death_watchdog.mjs')).toString();
  const runtimeStateUrl = pathToFileURL(join(fixture.rootDir, 'scripts', 'utils', 'stack', 'runtime_state.mjs')).toString();
  const staleInfraPid = 999_999_998;

  await writeFile(
    parentPath,
    [
      `import { recordStackRuntimeStart, recordStackRuntimeUpdate } from ${JSON.stringify(runtimeStateUrl)};`,
      `import { spawnStackOwnerDeathWatchdog } from ${JSON.stringify(ownerWatchdogUrl)};`,
      `await recordStackRuntimeStart(${JSON.stringify(runtimeStatePath)}, {`,
      `  stackName: ${JSON.stringify(fixture.stackName)},`,
      `  script: 'owner-watchdog-test',`,
      `  ephemeral: true,`,
      `  ownerPid: process.pid,`,
      `  ports: {},`,
      `});`,
      `await recordStackRuntimeUpdate(${JSON.stringify(runtimeStatePath)}, { processes: { serverPid: ${staleInfraPid} } });`,
      `spawnStackOwnerDeathWatchdog({`,
      `  rootDir: ${JSON.stringify(fixture.rootDir)},`,
      `  stackName: ${JSON.stringify(fixture.stackName)},`,
      `  baseDir: ${JSON.stringify(fixture.baseDir)},`,
      `  envPath: ${JSON.stringify(fixture.envPath)},`,
      `  runtimeStatePath: ${JSON.stringify(runtimeStatePath)},`,
      `  ownerPid: process.pid,`,
      `  env: process.env,`,
      `  pollMs: 25,`,
      `  logFile: ${JSON.stringify(watchdogLogPath)},`,
      `});`,
      `setTimeout(() => process.exit(0), 100);`,
      `setInterval(() => {}, 1000);`,
      ``,
    ].join('\n'),
    'utf-8',
  );

  try {
    const res = await runNode([parentPath], {
      cwd: fixture.rootDir,
      env: {
        ...fixture.baseEnv,
        HAPPIER_STACK_STACK: fixture.stackName,
        HAPPIER_STACK_ENV_FILE: fixture.envPath,
      },
    });
    assert.equal(res.code, 0, `expected clean parent exit\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

    assert.ok(isAlive(sessionLike.pid), `expected session-like pid ${sessionLike.pid} to still be alive`);

    const watchdogLog = await waitForLogMatch(watchdogLogPath, /sweep complete \(killed=\d+, errors=0\)/i);
    assert.match(watchdogLog, /owner pid .* is gone; sweeping stack-owned runtime/i);
    assert.match(watchdogLog, /sweep complete \(killed=\d+, errors=0\)/i);
    assert.ok(isAlive(sessionLike.pid), `expected session-like pid ${sessionLike.pid} to remain alive after sweep`);

    const runtimeStateExists = await readFile(runtimeStatePath, 'utf-8').then(() => true, () => false);
    assert.equal(runtimeStateExists, false, 'expected runtime state file to be removed after sweeping stale runtime');
  } finally {
    await fixture.cleanup();
  }
});

test('stack owner-death watchdog does not sweep while runtime child processes are still alive', async (t) => {
  const fixture = await setupStackStopSweepFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'hstack-owner-death-watchdog-live-child-',
  });

  const parentPath = join(fixture.tmp, 'owner-watchdog-live-parent.mjs');
  const runtimeStatePath = join(fixture.baseDir, 'stack.runtime.json');
  const watchdogLogPath = join(fixture.baseDir, 'logs', 'owner-death-watchdog.log');
  const ownerWatchdogUrl = pathToFileURL(join(fixture.rootDir, 'scripts', 'utils', 'stack', 'owner_death_watchdog.mjs')).toString();
  const runtimeStateUrl = pathToFileURL(join(fixture.rootDir, 'scripts', 'utils', 'stack', 'runtime_state.mjs')).toString();

  await writeFile(
    parentPath,
    [
      `import { spawn } from 'node:child_process';`,
      `import { recordStackRuntimeStart, recordStackRuntimeUpdate } from ${JSON.stringify(runtimeStateUrl)};`,
      `import { spawnStackOwnerDeathWatchdog } from ${JSON.stringify(ownerWatchdogUrl)};`,
      `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {`,
      `  detached: true,`,
      `  stdio: 'ignore',`,
      `  env: {`,
      `    ...process.env,`,
      `    HAPPIER_STACK_STACK: ${JSON.stringify(fixture.stackName)},`,
      `    HAPPIER_STACK_ENV_FILE: ${JSON.stringify(fixture.envPath)},`,
      `    HAPPIER_STACK_PROCESS_KIND: 'infra',`,
      `  },`,
      `});`,
      `child.unref();`,
      `await recordStackRuntimeStart(${JSON.stringify(runtimeStatePath)}, {`,
      `  stackName: ${JSON.stringify(fixture.stackName)},`,
      `  script: 'owner-watchdog-live-child-test',`,
      `  ephemeral: true,`,
      `  ownerPid: process.pid,`,
      `  ports: {},`,
      `});`,
      `await recordStackRuntimeUpdate(${JSON.stringify(runtimeStatePath)}, { processes: { daemonPid: child.pid } });`,
      `spawnStackOwnerDeathWatchdog({`,
      `  rootDir: ${JSON.stringify(fixture.rootDir)},`,
      `  stackName: ${JSON.stringify(fixture.stackName)},`,
      `  baseDir: ${JSON.stringify(fixture.baseDir)},`,
      `  envPath: ${JSON.stringify(fixture.envPath)},`,
      `  runtimeStatePath: ${JSON.stringify(runtimeStatePath)},`,
      `  ownerPid: process.pid,`,
      `  env: process.env,`,
      `  pollMs: 25,`,
      `  logFile: ${JSON.stringify(watchdogLogPath)},`,
      `});`,
      `console.log(String(child.pid));`,
      `setTimeout(() => process.exit(0), 100);`,
      `setInterval(() => {}, 1000);`,
      ``,
    ].join('\n'),
    'utf-8',
  );

  let runtimePid = null;
  try {
    const res = await runNode([parentPath], {
      cwd: fixture.rootDir,
      env: {
        ...fixture.baseEnv,
        HAPPIER_STACK_STACK: fixture.stackName,
        HAPPIER_STACK_ENV_FILE: fixture.envPath,
      },
    });
    assert.equal(res.code, 0, `expected clean parent exit\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

    runtimePid = Number(res.stdout.trim().split('\n')[0]);
    assert.ok(Number.isFinite(runtimePid) && runtimePid > 1, `expected runtime pid in stdout, got: ${res.stdout}`);
    await waitForProcessAlive({ pid: runtimePid, timeoutMs: 2_000, intervalMs: 25, label: 'runtime child process' });

    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.ok(isAlive(runtimePid), `expected runtime child pid ${runtimePid} to remain alive while watchdog observes it`);
    assert.equal(
      await readFile(runtimeStatePath, 'utf-8').then(() => true, () => false),
      true,
      'expected runtime state to remain present while runtime child is still alive',
    );

    const watchdogLog = await waitForLogMatch(watchdogLogPath, /owner pid .* is gone/i);
    assert.doesNotMatch(watchdogLog, /sweep complete \(killed=\d+, errors=0\)/i);

    terminateProcessTree(runtimePid);
    await waitForProcessExit({ pid: runtimePid, timeoutMs: 5_000, intervalMs: 25, label: 'runtime child process' });

    const sweepLog = await waitForLogMatch(watchdogLogPath, /sweep complete \(killed=\d+, errors=0\)/i);
    assert.match(sweepLog, /owner pid .* is gone; sweeping stack-owned runtime/i);
    assert.match(sweepLog, /sweep complete \(killed=\d+, errors=0\)/i);
    await waitForProcessExit({ pid: runtimePid, timeoutMs: 1_000, intervalMs: 25, label: 'runtime child process' });
  } finally {
    terminateProcessTree(runtimePid);
    await fixture.cleanup();
  }
});
