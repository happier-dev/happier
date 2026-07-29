import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WriteStream } from 'node:fs';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withCliDistBuildLock } from './cliDistBuildLock.mjs';
import { killProcessTree, markSpawnedProcessPlannedExit, run, runCapture, runCaptureResult, spawnProc } from './proc.mjs';
import { resolveCommandInvocation } from '../process/resolveCommandInvocation.mjs';
import { isPidAlive } from './pids.mjs';

test('killProcessTree delegates Windows cleanup to the bounded async tree-termination owner', async () => {
  let leaderAlive = true;
  let directLeaderSignalCount = 0;
  let taskkillChildKillCount = 0;
  const calls = [];
  const child = { pid: 4242, kill: () => { directLeaderSignalCount += 1; } };
  const boundary = {
    platform: 'win32',
    isPidAlive: () => leaderAlive,
    kill: () => {
      directLeaderSignalCount += 1;
      leaderAlive = false;
    },
    readProcessInstanceFingerprint: () => leaderAlive ? 'win32-cim:original' : null,
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      const taskkill = new EventEmitter();
      taskkill.kill = () => {
        taskkillChildKillCount += 1;
        return true;
      };
      return taskkill;
    },
  };

  const pending = killProcessTree(child, 'SIGTERM', { graceMs: 50, boundary });

  assert.equal(typeof pending?.then, 'function', 'cleanup must be asynchronous');
  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
    { command: 'taskkill', args: ['/PID', '4242', '/T', '/F'] },
  ]);
  assert.equal(directLeaderSignalCount, 0, 'tree traversal must start before any leader-only signal');
  assert.deepEqual(await pending, { ok: false, signal: 'SIGKILL', reason: 'kill_timeout' });
  assert.equal(taskkillChildKillCount, 1, 'hung taskkill must be terminated at the bound');
});

test('killProcessTree does not claim Windows tree cleanup after the tracked child exited', async () => {
  let boundaryCallCount = 0;
  const result = await killProcessTree({ pid: 4243, exitCode: 0 }, 'SIGTERM', {
    boundary: {
      platform: 'win32',
      isPidAlive: () => {
        boundaryCallCount += 1;
        return true;
      },
    },
  });

  assert.deepEqual(result, { ok: false, reason: 'leader_absent_without_tree_proof' });
  assert.equal(boundaryCallCount, 0, 'the exited child pid may already have been reused');
});

test('killProcessTree still terminates a POSIX process group after its tracked leader exits', async () => {
  let groupAlive = true;
  const signals = [];
  const result = await killProcessTree({ pid: 4244, exitCode: 0 }, 'SIGTERM', {
    boundary: {
      platform: 'linux',
      kill: (pid, signal) => {
        if (signal === 0) {
          if (groupAlive) return;
          const error = new Error('ESRCH');
          error.code = 'ESRCH';
          throw error;
        }
        signals.push({ pid, signal });
        groupAlive = false;
      },
      readProcessInstanceFingerprint: () => 'linux-proc:original',
    },
  });

  assert.deepEqual(result, { ok: true, signal: 'SIGTERM' });
  assert.deepEqual(signals, [{ pid: -4244, signal: 'SIGTERM' }]);
});

async function withTempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'happy-proc-test-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function delayWriteStreamEnd(t) {
  const originalEnd = WriteStream.prototype.end;
  let releaseEnd = null;
  let endCalledResolve;
  const endCalled = new Promise((resolve) => {
    endCalledResolve = resolve;
  });
  t.mock.method(WriteStream.prototype, 'end', function (...args) {
    endCalledResolve();
    releaseEnd = () => originalEnd.apply(this, args);
    return this;
  });
  return {
    endCalled,
    release() {
      releaseEnd?.();
    },
  };
}

function inheritedStdioDescendantScript(eventsPath, exitCode) {
  const descendantScript = [
    "const { appendFileSync } = require('node:fs');",
    `setTimeout(() => appendFileSync(${JSON.stringify(eventsPath)}, 'descendant\\n'), 200);`,
  ].join('\n');
  return [
    "const { spawn } = require('node:child_process');",
    `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { detached: true, stdio: 'inherit' });`,
    'descendant.unref();',
    `setImmediate(() => process.exit(${exitCode}));`,
  ].join('\n');
}

async function waitForEventLines(eventsPath, expectedCount) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const lines = (await readFile(eventsPath, 'utf8')).trim().split('\n').filter(Boolean);
      if (lines.length >= expectedCount) return lines;
    } catch {
      // The detached descendant has not written the event file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${expectedCount} events in ${eventsPath}`);
}

function inheritedPipeHolderScript(descendantPidPath) {
  const descendantScript = 'setTimeout(() => process.exit(0), 900);';
  return [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'inherit' });`,
    `writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
    "process.stdout.write('leader-started\\n');",
    'setInterval(() => {}, 1_000);',
  ].join('\n');
}

async function readDescendantPid(path) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt((await readFile(path, 'utf8')).trim(), 10);
      if (Number.isFinite(pid) && pid > 1) return pid;
    } catch {
      // The leader has not spawned its pipe-holding descendant yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for descendant pid at ${path}`);
}

async function waitForPidToExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isPidAlive(pid);
}

test('runCaptureResult captures stdout/stderr', async () => {
  const res = await runCaptureResult(process.execPath, ['-e', 'console.log("hello"); console.error("oops")'], {
    env: process.env,
  });
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.match(res.out, /hello/);
  assert.match(res.err, /oops/);
});

test('runCaptureResult streams output when streamLabel is set (without affecting captured output)', async (t) => {
  const stdoutWrites = [];
  const stderrWrites = [];
  t.mock.method(process.stdout, 'write', (chunk) => {
    stdoutWrites.push(String(chunk));
    return true;
  });
  t.mock.method(process.stderr, 'write', (chunk) => {
    stderrWrites.push(String(chunk));
    return true;
  });

  const res = await runCaptureResult(process.execPath, ['-e', 'console.log("hello"); console.error("oops")'], {
    env: process.env,
    streamLabel: 'proc-test',
  });
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.match(res.out, /hello/);
  assert.match(res.err, /oops/);

  const streamedOut = stdoutWrites.join('');
  const streamedErr = stderrWrites.join('');
  assert.match(streamedOut, /\[proc-test\] hello/);
  assert.match(streamedErr, /\[proc-test\] oops/);
});

test('runCaptureResult can tee streamed output to a file', async (t) => {
  const root = await withTempRoot(t);
  const teeFile = join(root, 'tee.log');
  const res = await runCaptureResult(process.execPath, ['-e', 'console.log("hello"); console.error("oops")'], {
    env: process.env,
    teeFile,
    teeLabel: 'tee-test',
  });
  assert.equal(res.ok, true);
  const raw = await readFile(teeFile, 'utf-8');
  assert.match(raw, /\[tee-test\] hello/);
  assert.match(raw, /\[tee-test\] oops/);
});

test('runCaptureResult does not resolve until delayed tee completion finishes', async (t) => {
  const root = await withTempRoot(t);
  const teeFile = join(root, 'delayed-capture.log');
  const delayedEnd = delayWriteStreamEnd(t);
  let settled = false;
  const pending = runCaptureResult(process.execPath, ['-e', 'console.log("hello"); console.error("oops")'], {
    env: process.env,
    teeFile,
    teeLabel: 'capture-finish',
  }).then((result) => {
    settled = true;
    return result;
  });

  try {
    await delayedEnd.endCalled;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'capture completion must wait for the tee writable finish boundary');
  } finally {
    delayedEnd.release();
  }

  const result = await pending;
  assert.equal(result.ok, true);
  const raw = await readFile(teeFile, 'utf-8');
  assert.match(raw, /\[capture-finish\] hello/);
  assert.match(raw, /\[capture-finish\] oops/);
});

test('runCaptureResult preserves non-tee nonzero output after child close', async () => {
  const result = await runCaptureResult(
    process.execPath,
    ['-e', 'process.stdout.write("partial-out"); process.stderr.write("partial-err"); process.exit(7)'],
    { env: process.env },
  );

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
  assert.equal(result.out, 'partial-out');
  assert.equal(result.err, 'partial-err');
});

test('run keeps quiet child output bounded, failure-only, and redacted', async () => {
  const env = { ...process.env, HAPPIER_TEST_SECRET: 'must-not-escape' };
  await run(
    process.execPath,
    ['-e', 'console.log("successful output stays quiet")'],
    {
      env,
      stdio: 'ignore',
      captureFailureDiagnostic: { env, maxChars: 200 },
    },
  );

  let failure;
  try {
    await run(
      process.execPath,
      [
        '-e',
        'console.error("x".repeat(1_000) + " diagnostic-tail HAPPIER_TEST_SECRET=" + process.env.HAPPIER_TEST_SECRET); process.exit(7)',
      ],
      {
        env,
        stdio: 'ignore',
        captureFailureDiagnostic: { env, maxChars: 200 },
      },
    );
    assert.fail('expected child failure');
  } catch (error) {
    failure = error;
  }

  assert.match(failure.message, /Child output \(tail; earlier output omitted\)/);
  assert.match(failure.message, /diagnostic-tail/);
  assert.match(failure.message, /HAPPIER_TEST_SECRET=<redacted>/);
  assert.doesNotMatch(failure.message, /must-not-escape/);
  assert.ok(failure.message.length < 500, `expected bounded diagnostic, got ${failure.message.length} characters`);
});

async function assertRunSettlesAfterInheritedStdio(t, exitCode) {
  const root = await withTempRoot(t);
  const eventsPath = join(root, `run-close-${exitCode}.log`);
  let failure = null;
  try {
    await run(process.execPath, ['-e', inheritedStdioDescendantScript(eventsPath, exitCode)], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    failure = error;
  }
  await appendFile(eventsPath, 'settled\n');

  assert.deepEqual(await waitForEventLines(eventsPath, 2), ['descendant', 'settled']);
  if (exitCode === 0) {
    assert.equal(failure, null);
  } else {
    assert.equal(failure?.code, 'EEXIT');
    assert.equal(failure?.exitCode, exitCode);
    assert.equal(failure?.signal, null);
  }
}

test('run settles success only after inherited stdio closes', async (t) => {
  await assertRunSettlesAfterInheritedStdio(t, 0);
});

test('run settles non-timeout failure only after inherited stdio closes', async (t) => {
  await assertRunSettlesAfterInheritedStdio(t, 7);
});

test('run completion keeps a workspace build lock held until inherited stdio closes', async (t) => {
  const root = await withTempRoot(t);
  const eventsPath = join(root, 'workspace-lock-events.log');
  const lockPath = join(root, 'workspace-build.lock');

  await withCliDistBuildLock(async () => {
    await run(process.execPath, ['-e', inheritedStdioDescendantScript(eventsPath, 0)], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }, {
    lockPath,
    timeoutMs: 5_000,
    pollIntervalMs: 20,
    staleAfterMs: 5_000,
  });
  await appendFile(eventsPath, 'released\n');

  assert.deepEqual(await waitForEventLines(eventsPath, 2), ['descendant', 'released']);
});

test('run clears its timeout immediately when the executable is missing', async (t) => {
  const root = await withTempRoot(t);
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let runTimeout = null;
  let runTimeoutCleared = false;

  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    const timer = originalSetTimeout(callback, delay, ...args);
    if (delay === 60_000) runTimeout = timer;
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer) => {
    if (timer === runTimeout) runTimeoutCleared = true;
    return originalClearTimeout(timer);
  });
  t.after(() => {
    if (runTimeout) originalClearTimeout(runTimeout);
  });

  await assert.rejects(
    run(join(root, 'definitely-missing-command'), [], {
      env: process.env,
      stdio: 'ignore',
      timeoutMs: 60_000,
    }),
    (error) => error?.code === 'ENOENT',
  );

  assert.ok(runTimeout, 'expected run to create its timeout resource');
  assert.equal(runTimeoutCleared, true, 'spawn errors must release the timeout resource immediately');
});

test('runCaptureResult finishes tee output on timeout', async (t) => {
  const root = await withTempRoot(t);
  const teeFile = join(root, 'timeout.log');
  const result = await runCaptureResult(
    process.execPath,
    ['-e', 'process.stdout.write("before-timeout"); setInterval(() => {}, 1000)'],
    // This test owns tee completion after a timeout, not sub-200ms Node startup scheduling.
    { env: process.env, timeoutMs: 5_000, teeFile, teeLabel: 'timeout' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.match(await readFile(teeFile, 'utf-8'), /\[timeout\] before-timeout/);
});

test('runCaptureResult timeout cleans up a descendant holding capture pipes before bounded settlement', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process-group cleanup contract; Windows uses taskkill and needs a live host');
    return;
  }
  const root = await withTempRoot(t);
  const descendantPidPath = join(root, 'capture-result-descendant.pid');
  const teeFile = join(root, 'capture-result-timeout.log');
  let descendantPid = null;
  t.after(() => {
    if (descendantPid && isPidAlive(descendantPid)) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {
        // best-effort cleanup for the RED implementation
      }
    }
  });

  const startedAt = Date.now();
  const pending = runCaptureResult(
    process.execPath,
    ['-e', inheritedPipeHolderScript(descendantPidPath)],
    { env: process.env, timeoutMs: 150, teeFile, teeLabel: 'capture-timeout' },
  );
  descendantPid = await readDescendantPid(descendantPidPath);
  const result = await pending;
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.timedOut, true);
  assert.match(result.out, /leader-started/);
  assert.match(await readFile(teeFile, 'utf8'), /\[capture-timeout\] leader-started/);
  assert.ok(elapsedMs < 650, `timeout settlement must be bounded by tree cleanup, got ${elapsedMs}ms`);
  assert.equal(
    await waitForPidToExit(descendantPid, 500),
    true,
    `descendant ${descendantPid} must be gone before timeout settlement`,
  );
});

test('runCapture timeout cleans up a descendant holding capture pipes before rejection', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process-group cleanup contract; Windows uses taskkill and needs a live host');
    return;
  }
  const root = await withTempRoot(t);
  const descendantPidPath = join(root, 'capture-descendant.pid');
  let descendantPid = null;
  t.after(() => {
    if (descendantPid && isPidAlive(descendantPid)) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {
        // best-effort cleanup for the RED implementation
      }
    }
  });

  const pending = runCapture(
    process.execPath,
    ['-e', inheritedPipeHolderScript(descendantPidPath)],
    { env: process.env, timeoutMs: 150 },
  );
  descendantPid = await readDescendantPid(descendantPidPath);

  await assert.rejects(pending, (error) => error?.code === 'ETIMEDOUT');
  assert.equal(
    await waitForPidToExit(descendantPid, 500),
    true,
    `descendant ${descendantPid} must be gone before timeout rejection`,
  );
});

test('runCaptureResult settles tee output after a spawn error', async (t) => {
  const root = await withTempRoot(t);
  const teeFile = join(root, 'spawn-error.log');
  const result = await runCaptureResult(join(root, 'missing-command'), [], {
    env: process.env,
    teeFile,
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);
  assert.match(result.err, /ENOENT|missing-command/);
  assert.equal(await readFile(teeFile, 'utf-8'), '');
});

test('runCaptureResult emits periodic keepalive logs while process is running', async (t) => {
  const root = await withTempRoot(t);
  const teeFile = join(root, 'keepalive.log');
  const res = await runCaptureResult(
    process.execPath,
    ['-e', 'setTimeout(() => { process.exit(0); }, 220);'],
    {
      env: process.env,
      teeFile,
      teeLabel: 'keepalive-test',
      heartbeatMs: 50,
    }
  );
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  const raw = await readFile(teeFile, 'utf-8');
  assert.match(raw, /\[keepalive-test\] still running \(elapsed \d+s, pid=\d+\)/);
});

test('spawnProc can tee output to an env-scoped tee dir when no explicit teeFile is provided', async (t) => {
  const root = await withTempRoot(t);
  const teeDir = join(root, 'tee');
  const env = { ...process.env, HAPPIER_STACK_LOG_TEE_DIR: teeDir };

  const child = spawnProc('server', process.execPath, ['-e', 'console.log("hello"); console.error("oops")'], env, {
    silent: true,
  });
  await child.completion;

  const raw = await readFile(join(teeDir, 'server.log'), 'utf-8');
  assert.match(raw, /\[server\] hello/);
  assert.match(raw, /\[server\] oops/);
});

test('spawnProc completion waits for child close, pipe drainage, and delayed tee finish', async (t) => {
  const root = await withTempRoot(t);
  const teeFile = join(root, 'delayed-spawn.log');
  const delayedEnd = delayWriteStreamEnd(t);
  const child = spawnProc(
    'spawn-finish',
    process.execPath,
    ['-e', 'process.stdout.write("hello"); process.stderr.write("oops")'],
    process.env,
    { silent: true, teeFile },
  );

  assert.equal(typeof child.completion?.then, 'function', 'spawnProc must expose its complete drain/flush boundary');
  let settled = false;
  const completion = child.completion.then((outcome) => {
    settled = true;
    return outcome;
  });

  try {
    await delayedEnd.endCalled;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'spawn completion must wait for the tee writable finish boundary');
  } finally {
    delayedEnd.release();
  }

  const outcome = await completion;
  assert.equal(outcome.code, 0);
  const raw = await readFile(teeFile, 'utf-8');
  assert.match(raw, /\[spawn-finish\] hello/);
  assert.match(raw, /\[spawn-finish\] oops/);
});

test('spawnProc unavailable executable settles truthful completion without crashing its parent, with and without tee', async (t) => {
  const root = await withTempRoot(t);
  const procModuleUrl = new URL('./proc.mjs', import.meta.url).href;

  for (const teeEnabled of [false, true]) {
    const teeFile = teeEnabled ? join(root, 'missing-command.log') : null;
    const probe = [
      `const { spawnProc } = await import(${JSON.stringify(procModuleUrl)});`,
      `const child = spawnProc('missing-command', ${JSON.stringify(join(root, 'definitely-missing-command'))}, [], process.env, { silent: true${teeFile ? `, teeFile: ${JSON.stringify(teeFile)}, teeLabel: 'missing-command'` : ''} });`,
      'let settlements = 0;',
      'const outcome = await child.completion.then((value) => { settlements += 1; return value; });',
      "await new Promise((resolve) => setImmediate(resolve));",
      "console.log(JSON.stringify({ code: outcome.code, signal: outcome.signal, errorCode: outcome.error?.code, settlements }));",
    ].filter(Boolean).join('\n');
    const result = await runCaptureResult(process.execPath, ['--input-type=module', '-e', probe], { env: process.env });

    assert.equal(result.ok, true, result.err);
    assert.deepEqual(JSON.parse(result.out.trim()), {
      code: null,
      signal: null,
      errorCode: 'ENOENT',
      settlements: 1,
    });
    if (teeFile) assert.equal(await readFile(teeFile, 'utf-8'), '');
  }
});

test('spawnProc keeps spawn errors observable to external ChildProcess listeners', async (t) => {
  const root = await withTempRoot(t);
  const child = spawnProc('missing-command-listener', join(root, 'missing-listener-command'), [], process.env, {
    silent: true,
  });
  let observedCode = null;
  child.once('error', (error) => {
    observedCode = error?.code ?? null;
  });

  const outcome = await child.completion;
  assert.equal(observedCode, 'ENOENT');
  assert.equal(outcome.code, null);
  assert.equal(outcome.error?.code, 'ENOENT');
});

test('spawnProc reports complete stdout and stderr lines to onLine', async () => {
  const observed = [];
  const child = spawnProc(
    'line-test',
    process.execPath,
    [
      '-e',
      [
        "process.stdout.write('one\\npa');",
        "setTimeout(() => { process.stdout.write('rt\\n'); process.stderr.write('err\\n'); }, 25);",
      ].join(''),
    ],
    process.env,
    {
      silent: true,
      onLine: (event) => observed.push(event),
    }
  );

  const outcome = await child.completion;
  assert.equal(outcome.code, 0);

  assert.deepEqual(observed, [
    { stream: 'stdout', line: 'one' },
    { stream: 'stdout', line: 'part' },
    { stream: 'stderr', line: 'err' },
  ]);
});

test('spawnProc labels planned dev-reload exits without hiding the exit code', async (t) => {
  const stderrWrites = [];
  t.mock.method(process.stderr, 'write', (chunk) => {
    stderrWrites.push(String(chunk));
    return true;
  });

  const child = spawnProc(
    'server',
    process.execPath,
    ['-e', 'setTimeout(() => process.exit(1), 20);'],
    process.env,
  );
  markSpawnedProcessPlannedExit(child, 'dev-reload');

  await child.completion;

  const streamedErr = stderrWrites.join('');
  assert.match(streamedErr, /\[server\] planned dev-reload exit \(code=1, sig=null\)/);
  assert.doesNotMatch(streamedErr, /\[server\] exited \(code=1, sig=null\)/);
});

test('runCapture resolves command-only npm through the canonical Windows command invocation', async (t) => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(originalPlatformDescriptor, 'expected process.platform descriptor');
  const root = await withTempRoot(t);
  const npmShim = join(root, 'npm.CMD');
  const commandInterpreter = join(root, 'cmd.exe');
  await writeFile(npmShim, '@echo off\r\necho unreachable\r\n', 'utf8');
  await writeFile(commandInterpreter, '#!/bin/sh\nprintf \"wrapped-npm\\\\n\"\n', 'utf8');
  await chmod(commandInterpreter, 0o755);

  Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
  t.after(() => {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  });

  const output = await runCapture('npm', ['--version'], {
    env: {
      PATH: root,
      PATHEXT: '.CMD;.EXE',
      ComSpec: commandInterpreter,
    },
  });

  assert.equal(output, 'wrapped-npm\n');
});

test('runCapture routes Windows Yarn shims with spaces and metacharacters through canonical cmd.exe args without a shell', async (t) => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(originalPlatformDescriptor, 'expected process.platform descriptor');
  const root = await withTempRoot(t);
  const shimDir = join(root, 'shim dir & tools');
  const yarnShim = join(shimDir, 'yarn.CMD');
  const commandInterpreter = join(root, 'command & interpreter', 'cmd.exe');
  await mkdir(join(root, 'command & interpreter'), { recursive: true });
  await mkdir(shimDir, { recursive: true });
  await writeFile(yarnShim, '@echo off\r\necho unreachable\r\n', 'utf8');
  await writeFile(
    commandInterpreter,
    `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,
    'utf8',
  );
  await chmod(commandInterpreter, 0o755);

  Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
  t.after(() => {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  });

  const args = ['run', 'script with spaces', 'value&next', '100%'];
  const env = {
    PATH: shimDir,
    PATHEXT: '.CMD;.EXE',
    ComSpec: commandInterpreter,
  };
  const expected = resolveCommandInvocation({ command: 'yarn', args, env });
  const output = await runCapture('yarn', args, { env });

  assert.equal(expected.command, commandInterpreter);
  assert.deepEqual(expected.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(expected.windowsVerbatimArguments, true);
  assert.deepEqual(JSON.parse(output), expected.args);
});

test('run tolerates a child closing stdin before all input is written', async () => {
  await assert.doesNotReject(() =>
    run(
      process.execPath,
      ['-e', 'process.stdin.destroy(); process.exit(0);'],
      {
        env: process.env,
        input: 'x'.repeat(8 * 1024 * 1024),
        stdio: ['pipe', 'ignore', 'ignore'],
      },
    ),
  );
});
