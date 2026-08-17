import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
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
import { withJsonOwnerFileLock } from './utils/proc/jsonOwnerFileLock.mjs';
import { spawnStackOwnerDeathWatchdog } from './utils/stack/owner_death_watchdog.mjs';
import { recordStackRuntimeStart } from './utils/stack/runtime_state.mjs';

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

async function waitForLogMatch(path, pattern, { timeoutMs = 15_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastLog = '';
  let lastReadError = null;
  while (Date.now() < deadline) {
    try {
      lastLog = await readFile(path, 'utf-8');
      lastReadError = null;
      pattern.lastIndex = 0;
      if (pattern.test(lastLog)) {
        return lastLog;
      }
    } catch (error) {
      lastReadError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const readFailure = lastReadError instanceof Error ? `\nlast read error: ${lastReadError.message}` : '';
  throw new Error(
    `timeout waiting for watchdog log pattern ${String(pattern)} at ${path}${readFailure}\nlast log:\n${lastLog}`,
  );
}

test('stack owner-death watchdog spawn fails closed without owner startedAt', () => {
  const input = {
    rootDir: '/tmp/root',
    stackName: 'missing-incarnation',
    baseDir: '/tmp/base',
    runtimeStatePath: '/tmp/base/stack.runtime.json',
    ownerPid: process.pid,
  };
  assert.equal(spawnStackOwnerDeathWatchdog(input), null);
  assert.equal(spawnStackOwnerDeathWatchdog({ ...input, ownerStartedAt: 'not-a-timestamp' }), null);
  assert.equal(spawnStackOwnerDeathWatchdog({ ...input, ownerStartedAt: '2026-07-17T08:04:00Z' }), null);
});

test('stack owner-death watchdog uses the shared bounded log owner', async (t) => {
  const fixture = await setupStackStopSweepFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'hstack-owner-death-watchdog-bounded-log-',
  });
  const runtimeStatePath = join(fixture.baseDir, 'stack.runtime.json');
  const watchdogLogPath = join(fixture.baseDir, 'logs', 'owner-death-watchdog.log');
  const owner = fixture.trackChild(spawnOwnedSleep({ env: fixture.baseEnv }));
  await waitForProcessAlive({ pid: owner.pid, timeoutMs: 2_000, intervalMs: 25, label: 'bounded-log owner' });
  const runtime = await recordStackRuntimeStart(runtimeStatePath, {
    stackName: fixture.stackName,
    script: 'owner-watchdog-bounded-log-test',
    ephemeral: true,
    ownerPid: owner.pid,
    processes: {},
    ports: {},
  });
  await mkdir(join(fixture.baseDir, 'logs'), { recursive: true });
  await writeFile(watchdogLogPath, 'legacy-watchdog-line\n'.repeat(80), 'utf8');

  fixture.trackChild(spawnStackOwnerDeathWatchdog({
    rootDir: fixture.rootDir,
    stackName: fixture.stackName,
    baseDir: fixture.baseDir,
    envPath: fixture.envPath,
    runtimeStatePath,
    ownerPid: owner.pid,
    ownerStartedAt: runtime.startedAt,
    env: fixture.baseEnv,
    pollMs: 25,
    logFile: watchdogLogPath,
    logMaxBytes: 256,
  }));

  await waitForLogMatch(watchdogLogPath, /watching owner pid=/i);
  assert.ok((await stat(watchdogLogPath)).size <= 256);
  assert.ok((await stat(`${watchdogLogPath}.1`)).size <= 256);
});

test('owner-death sweep no-ops when a successor publishes after the watched owner was observed', async (t) => {
  const fixture = await setupStackStopSweepFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'hstack-owner-death-watchdog-successor-race-',
  });
  const runtimeStatePath = join(fixture.baseDir, 'stack.runtime.json');
  const watchdogLogPath = join(fixture.baseDir, 'logs', 'owner-death-watchdog.log');
  const ownedEnv = {
    ...process.env,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: fixture.envPath,
    HAPPIER_STACK_PROCESS_KIND: 'infra',
  };
  const oldOwner = fixture.trackChild(spawnOwnedSleep({ env: ownedEnv }));
  let successor = null;

  await waitForProcessAlive({ pid: oldOwner.pid, timeoutMs: 2_000, intervalMs: 25, label: 'old lifecycle owner' });
  const watchedRuntime = await recordStackRuntimeStart(runtimeStatePath, {
    stackName: fixture.stackName,
    script: 'owner-watchdog-successor-race-test',
    ephemeral: true,
    ownerPid: oldOwner.pid,
    processes: { serverPid: oldOwner.pid },
    ports: {},
  });
  fixture.trackChild(spawnStackOwnerDeathWatchdog({
    rootDir: fixture.rootDir,
    stackName: fixture.stackName,
    baseDir: fixture.baseDir,
    envPath: fixture.envPath,
    runtimeStatePath,
    ownerPid: oldOwner.pid,
    ownerStartedAt: watchedRuntime.startedAt,
    env: fixture.baseEnv,
    pollMs: 25,
    logFile: watchdogLogPath,
  }));

  await withJsonOwnerFileLock(async () => {
    terminateProcessTree(oldOwner.pid);
    await waitForProcessExit({ pid: oldOwner.pid, timeoutMs: 2_000, intervalMs: 25, label: 'old lifecycle owner' });
    await waitForLogMatch(watchdogLogPath, /owner pid .* is gone; sweeping stack-owned runtime/i);

    successor = fixture.trackChild(spawnOwnedSleep({ env: ownedEnv }));
    await waitForProcessAlive({ pid: successor.pid, timeoutMs: 2_000, intervalMs: 25, label: 'successor lifecycle owner' });
    const observed = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
    await writeFile(runtimeStatePath, `${JSON.stringify({
      ...observed,
      ownerPid: successor.pid,
      processes: { serverPid: successor.pid },
      stopRequest: null,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf-8');
  }, {
    lockPath: `${runtimeStatePath}.lock`,
    timeoutMs: 5_000,
    pollIntervalMs: 5,
    staleAfterMs: 10_000,
    errorLabel: 'test runtime-state mutation lock',
  });

  const watchdogLog = await waitForLogMatch(watchdogLogPath, /successor runtime detected; no-op/i, { timeoutMs: 10_000 });
  assert.ok(isAlive(successor.pid), `expected successor owner ${successor.pid} to remain alive`);
  const current = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(current.ownerPid, successor.pid);
  assert.deepEqual(current.processes, { serverPid: successor.pid });
  assert.equal(current.stopRequest, null);
  const structuredLine = watchdogLog.split('\n').find((line) => line.startsWith('[owner-watchdog-json] '));
  assert.ok(structuredLine, `expected structured watchdog no-op line:\n${watchdogLog}`);
  const structured = JSON.parse(structuredLine.slice('[owner-watchdog-json] '.length));
  assert.equal(structured.event, 'owner_death_sweep_noop');
  assert.equal(structured.actions?.stopAuthorization?.reason, 'successor_owner');
  assert.equal(structured.killedCount, 0);
});

test('owner-death sweep no-ops when a successor reuses the watched pid with a new startedAt', async (t) => {
  const fixture = await setupStackStopSweepFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'hstack-owner-death-watchdog-pid-reuse-',
  });
  const runtimeStatePath = join(fixture.baseDir, 'stack.runtime.json');
  const watchdogLogPath = join(fixture.baseDir, 'logs', 'owner-death-watchdog.log');
  const ownedEnv = {
    ...process.env,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_ENV_FILE: fixture.envPath,
    HAPPIER_STACK_PROCESS_KIND: 'infra',
  };
  const oldOwner = fixture.trackChild(spawnOwnedSleep({ env: ownedEnv }));
  let successor = null;

  await waitForProcessAlive({ pid: oldOwner.pid, timeoutMs: 2_000, intervalMs: 25, label: 'old lifecycle owner' });
  const watchedRuntime = await recordStackRuntimeStart(runtimeStatePath, {
    stackName: fixture.stackName,
    script: 'owner-watchdog-pid-reuse-test',
    ephemeral: true,
    ownerPid: oldOwner.pid,
    processes: { serverPid: oldOwner.pid },
    ports: {},
  });
  fixture.trackChild(spawnStackOwnerDeathWatchdog({
    rootDir: fixture.rootDir,
    stackName: fixture.stackName,
    baseDir: fixture.baseDir,
    envPath: fixture.envPath,
    runtimeStatePath,
    ownerPid: oldOwner.pid,
    ownerStartedAt: watchedRuntime.startedAt,
    env: fixture.baseEnv,
    pollMs: 25,
    logFile: watchdogLogPath,
  }));

  const successorStartedAt = '2026-07-17T08:03:00.000Z';
  await withJsonOwnerFileLock(async () => {
    terminateProcessTree(oldOwner.pid);
    await waitForProcessExit({ pid: oldOwner.pid, timeoutMs: 2_000, intervalMs: 25, label: 'old lifecycle owner' });
    await waitForLogMatch(watchdogLogPath, /owner pid .* is gone; sweeping stack-owned runtime/i);

    successor = fixture.trackChild(spawnOwnedSleep({ env: ownedEnv }));
    await waitForProcessAlive({ pid: successor.pid, timeoutMs: 2_000, intervalMs: 25, label: 'successor infra' });
    const observed = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
    await writeFile(runtimeStatePath, `${JSON.stringify({
      ...observed,
      ownerPid: oldOwner.pid,
      startedAt: successorStartedAt,
      processes: { serverPid: successor.pid },
      serverProxy: { reloadGeneration: 2 },
      stopRequest: null,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf-8');
  }, {
    lockPath: `${runtimeStatePath}.lock`,
    timeoutMs: 5_000,
    pollIntervalMs: 5,
    staleAfterMs: 10_000,
    errorLabel: 'test runtime-state mutation lock',
  });

  const watchdogLog = await waitForLogMatch(
    watchdogLogPath,
    /runtime stop not authorized \(successor_owner_incarnation\); no-op/i,
    { timeoutMs: 10_000 },
  );
  assert.ok(isAlive(successor.pid), `expected successor infra ${successor.pid} to remain alive`);
  const current = JSON.parse(await readFile(runtimeStatePath, 'utf-8'));
  assert.equal(current.ownerPid, oldOwner.pid);
  assert.equal(current.startedAt, successorStartedAt);
  assert.deepEqual(current.processes, { serverPid: successor.pid });
  assert.equal(current.serverProxy.reloadGeneration, 2);
  assert.equal(current.stopRequest, null);
  const structuredLine = watchdogLog.split('\n').find((line) => line.startsWith('[owner-watchdog-json] '));
  assert.ok(structuredLine, `expected structured watchdog no-op line:\n${watchdogLog}`);
  const structured = JSON.parse(structuredLine.slice('[owner-watchdog-json] '.length));
  assert.equal(structured.event, 'owner_death_sweep_noop');
  assert.equal(structured.actions?.stopAuthorization?.reason, 'successor_owner_incarnation');
  assert.deepEqual(structured.actions?.stopAttribution, {
    requestedBy: 'owner death watchdog',
    reason: 'lifecycle owner exited; sweeping stack-owned runtime',
  });
  assert.equal(structured.killedCount, 0);
});

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
      `const runtime = await recordStackRuntimeStart(${JSON.stringify(runtimeStatePath)}, {`,
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
      `  ownerStartedAt: runtime.startedAt,`,
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

test('stack owner-death watchdog sweeps live infra children after owner death', async (t) => {
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
      `const runtime = await recordStackRuntimeStart(${JSON.stringify(runtimeStatePath)}, {`,
      `  stackName: ${JSON.stringify(fixture.stackName)},`,
      `  script: 'owner-watchdog-test',`,
      `  ephemeral: true,`,
      `  ownerPid: process.pid,`,
      `  ports: {},`,
      `});`,
      `await recordStackRuntimeUpdate(${JSON.stringify(runtimeStatePath)}, { processes: { serverPid: child.pid } });`,
      `spawnStackOwnerDeathWatchdog({`,
      `  rootDir: ${JSON.stringify(fixture.rootDir)},`,
      `  stackName: ${JSON.stringify(fixture.stackName)},`,
      `  baseDir: ${JSON.stringify(fixture.baseDir)},`,
      `  envPath: ${JSON.stringify(fixture.envPath)},`,
      `  runtimeStatePath: ${JSON.stringify(runtimeStatePath)},`,
      `  ownerPid: process.pid,`,
      `  ownerStartedAt: runtime.startedAt,`,
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

  let infraPid = null;
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

    infraPid = Number(res.stdout.trim().split('\n')[0]);
    assert.ok(Number.isFinite(infraPid) && infraPid > 1, `expected infra pid in stdout, got: ${res.stdout}`);
    await waitForProcessAlive({ pid: infraPid, timeoutMs: 2_000, intervalMs: 25, label: 'infra process (pre-watchdog)' });

    await waitForProcessExit({ pid: infraPid, timeoutMs: 10_000, intervalMs: 50, label: 'infra process (owner watchdog)' });
    assert.ok(!isAlive(infraPid), `expected infra pid ${infraPid} to be stopped`);

    const sweepLog = await waitForLogMatch(watchdogLogPath, /sweep complete \(killed=\d+, errors=0\)/i);
    assert.match(sweepLog, /owner pid .* is gone; sweeping stack-owned runtime/i);
    assert.match(sweepLog, /sweep complete \(killed=\d+, errors=0\)/i);
    const structuredLine = sweepLog
      .split('\n')
      .find((line) => line.startsWith('[owner-watchdog-json] '));
    assert.ok(structuredLine, `expected structured owner-watchdog-json line in log:\n${sweepLog}`);
    const structured = JSON.parse(structuredLine.slice('[owner-watchdog-json] '.length));
    assert.equal(structured.event, 'owner_death_sweep_complete');
    assert.equal(structured.stackName, fixture.stackName);
    assert.deepEqual(structured.actions?.stopAttribution, {
      requestedBy: 'owner death watchdog',
      reason: 'lifecycle owner exited; sweeping stack-owned runtime',
    });
    assert.equal(structured.errorCount, 0);
    assert.ok(structured.killedCount >= 1, `expected at least one killed process, got ${structured.killedCount}`);
    const directlyKilledPids = structured.actions?.processes?.killed?.map((entry) => entry.pid) ?? [];
    const sweptPids = structured.actions?.sweep?.pids?.map((entry) => entry.pid) ?? [];
    assert.ok(
      [...directlyKilledPids, ...sweptPids].includes(infraPid),
      `expected structured log to include infra pid ${infraPid}: ${structuredLine}`,
    );
  } finally {
    terminateProcessTree(infraPid);
    await fixture.cleanup();
  }
});

test('stack owner-death watchdog preserves daemonPid when runtime stopRequest sets preserveDaemon', async (t) => {
  const fixture = await setupStackStopSweepFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'hstack-owner-death-watchdog-preserve-daemon-',
  });

  const parentPath = join(fixture.tmp, 'owner-watchdog-preserve-daemon-parent.mjs');
  const runtimeStatePath = join(fixture.baseDir, 'stack.runtime.json');
  const watchdogLogPath = join(fixture.baseDir, 'logs', 'owner-death-watchdog.log');
  const ownerWatchdogUrl = pathToFileURL(join(fixture.rootDir, 'scripts', 'utils', 'stack', 'owner_death_watchdog.mjs')).toString();
  const runtimeStateUrl = pathToFileURL(join(fixture.rootDir, 'scripts', 'utils', 'stack', 'runtime_state.mjs')).toString();

  await writeFile(
    parentPath,
    [
      `import { spawn } from 'node:child_process';`,
      `import { recordStackRuntimeStart, recordStackRuntimeStopRequest, recordStackRuntimeUpdate } from ${JSON.stringify(runtimeStateUrl)};`,
      `import { spawnStackOwnerDeathWatchdog } from ${JSON.stringify(ownerWatchdogUrl)};`,
      `const spawnOwned = (kind) => {`,
      `  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {`,
      `    detached: true,`,
      `    stdio: 'ignore',`,
      `    env: {`,
      `      ...process.env,`,
      `      HAPPIER_STACK_STACK: ${JSON.stringify(fixture.stackName)},`,
      `      HAPPIER_STACK_ENV_FILE: ${JSON.stringify(fixture.envPath)},`,
      `      HAPPIER_STACK_PROCESS_KIND: kind,`,
      `    },`,
      `  });`,
      `  child.unref();`,
      `  return child;`,
      `};`,
      `const daemonChild = spawnOwned('infra');`,
      `const serverChild = spawnOwned('infra');`,
      `const runtime = await recordStackRuntimeStart(${JSON.stringify(runtimeStatePath)}, {`,
      `  stackName: ${JSON.stringify(fixture.stackName)},`,
      `  script: 'owner-watchdog-preserve-daemon-test',`,
      `  ephemeral: true,`,
      `  ownerPid: process.pid,`,
      `  ports: {},`,
      `});`,
      `await recordStackRuntimeUpdate(${JSON.stringify(runtimeStatePath)}, {`,
      `  processes: { daemonPid: daemonChild.pid, serverPid: serverChild.pid },`,
      `});`,
      `await recordStackRuntimeStopRequest(${JSON.stringify(runtimeStatePath)}, {`,
      `  requestedBy: 'test',`,
      `  reason: 'preserve daemon during owner-death sweep',`,
      `  preserveDaemon: true,`,
      `});`,
      `spawnStackOwnerDeathWatchdog({`,
      `  rootDir: ${JSON.stringify(fixture.rootDir)},`,
      `  stackName: ${JSON.stringify(fixture.stackName)},`,
      `  baseDir: ${JSON.stringify(fixture.baseDir)},`,
      `  envPath: ${JSON.stringify(fixture.envPath)},`,
      `  runtimeStatePath: ${JSON.stringify(runtimeStatePath)},`,
      `  ownerPid: process.pid,`,
      `  ownerStartedAt: runtime.startedAt,`,
      `  env: process.env,`,
      `  pollMs: 25,`,
      `  logFile: ${JSON.stringify(watchdogLogPath)},`,
      `});`,
      `console.log(JSON.stringify({ daemonPid: daemonChild.pid, serverPid: serverChild.pid }));`,
      `setTimeout(() => process.exit(0), 100);`,
      `setInterval(() => {}, 1000);`,
      ``,
    ].join('\n'),
    'utf-8',
  );

  let daemonPid = null;
  let serverPid = null;
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

    const parsed = JSON.parse(res.stdout.trim().split('\n')[0]);
    daemonPid = Number(parsed?.daemonPid);
    serverPid = Number(parsed?.serverPid);
    assert.ok(Number.isFinite(daemonPid) && daemonPid > 1, `expected daemon pid in stdout, got: ${res.stdout}`);
    assert.ok(Number.isFinite(serverPid) && serverPid > 1, `expected server pid in stdout, got: ${res.stdout}`);
    await waitForProcessAlive({ pid: daemonPid, timeoutMs: 2_000, intervalMs: 25, label: 'daemon process (pre-watchdog)' });
    await waitForProcessAlive({ pid: serverPid, timeoutMs: 2_000, intervalMs: 25, label: 'server process (pre-watchdog)' });

    await waitForProcessExit({ pid: serverPid, timeoutMs: 10_000, intervalMs: 50, label: 'server process (owner watchdog)' });
    assert.ok(isAlive(daemonPid), `expected daemon pid ${daemonPid} to remain alive`);

    const sweepLog = await waitForLogMatch(watchdogLogPath, /sweep complete \(killed=\d+, errors=0\)/i);
    assert.match(sweepLog, /owner pid .* is gone; sweeping stack-owned runtime/i);

    const runtimeStateExists = await readFile(runtimeStatePath, 'utf-8').then(() => true, () => false);
    assert.equal(runtimeStateExists, true, 'expected runtime state to remain while preserved daemon is still alive');
  } finally {
    terminateProcessTree(serverPid);
    terminateProcessTree(daemonPid);
    await fixture.cleanup();
  }
});
