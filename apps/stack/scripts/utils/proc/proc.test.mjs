import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

import { killProcessTree, markSpawnedProcessPlannedExit, run, runCapture, runCaptureResult, spawnProc } from './proc.mjs';
import { resolveDefaultShellForCommand } from './proc.mjs';

for (const [name, invoke] of [
  ['run', () => run(process.execPath, ['-e', ''], { stdio: 'ignore' })],
  ['runCapture', () => runCapture(process.execPath, ['-e', ''])],
  ['runCaptureResult', () => runCaptureResult(process.execPath, ['-e', ''])],
  ['spawnProc', () => spawnProc('hidden-console', process.execPath, ['-e', ''], process.env, { silent: true }).completion],
]) {
  test(`${name} suppresses creation of a Windows console at the process boundary`, async (t) => {
    const originalSpawn = childProcess.spawn;
    t.mock.method(childProcess, 'spawn', (command, args, options) => {
      assert.equal(options.windowsHide, true);
      return originalSpawn(command, args, options);
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    await invoke();
  });
}

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

  const pending = killProcessTree(child, 'SIGTERM', {
    graceMs: 50,
    boundary,
  });

  assert.equal(typeof pending?.then, 'function', 'cleanup must be asynchronous');
  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
    { command: 'taskkill', args: ['/PID', '4242', '/T', '/F'] },
  ]);
  assert.equal(directLeaderSignalCount, 0, 'tree traversal must start before any leader-only signal');
  assert.deepEqual(await pending, { ok: false, signal: 'SIGKILL' });
  assert.equal(taskkillChildKillCount, 1, 'hung taskkill must be terminated at the bound');
});

test('killProcessTree does not claim Windows tree cleanup after the tracked process has exited', async () => {
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
  assert.equal(boundaryCallCount, 0, 'an exited child pid may already have been reused');
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

test('runCapture abort terminates the spawned boundary process', async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = runCapture(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 25);

  await assert.rejects(pending, (error) => error?.code === 'ABORT_ERR');
  assert.ok(Date.now() - startedAt < 250);
});

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

test('spawnProc bounds long-lived tee logs with one rotated predecessor', async (t) => {
  const root = await withTempRoot(t);
  const teeFile = join(root, 'bounded.log');
  const teeMaxBytes = 256;
  await writeFile(teeFile, 'legacy-log-line\n'.repeat(80));

  const child = spawnProc(
    'bounded',
    process.execPath,
    ['-e', 'for (let i = 0; i < 4; i += 1) console.log(String(i).padStart(3, "0") + "-abcdefghij")'],
    process.env,
    { silent: true, teeFile, teeMaxBytes },
  );
  await child.completion;

  assert.ok((await stat(teeFile)).size <= teeMaxBytes);
  assert.ok((await stat(`${teeFile}.1`)).size <= teeMaxBytes);
  assert.match(await readFile(teeFile, 'utf-8'), /\[bounded\] 003-abcdefghij/);
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

test('run settles when a child exits while a large stdin payload is still being written', async () => {
  const procModuleUrl = new URL('./proc.mjs', import.meta.url).href;
  const probe = [
    `const { run } = await import(${JSON.stringify(procModuleUrl)});`,
    `await run(process.execPath, ['-e', 'process.stdin.destroy(); process.exit(0)'], { input: 'x'.repeat(16 * 1024 * 1024), stdio: ['pipe', 'ignore', 'ignore'] });`,
    "console.log('settled');",
  ].join('\n');

  const result = await runCaptureResult(process.execPath, ['--input-type=module', '-e', probe], { env: process.env });
  assert.equal(result.ok, true, result.err);
  assert.equal(result.out.trim(), 'settled');
});

test('runCaptureResult settles when a child exits while a large stdin payload is still being written', async () => {
  const procModuleUrl = new URL('./proc.mjs', import.meta.url).href;
  const probe = [
    `const { runCaptureResult } = await import(${JSON.stringify(procModuleUrl)});`,
    `const result = await runCaptureResult(process.execPath, ['-e', 'process.stdin.destroy(); process.exit(0)'], { input: 'x'.repeat(16 * 1024 * 1024) });`,
    "console.log(JSON.stringify({ ok: result.ok, exitCode: result.exitCode, timedOut: result.timedOut }));",
  ].join('\n');

  const result = await runCaptureResult(process.execPath, ['--input-type=module', '-e', probe], { env: process.env });
  assert.equal(result.ok, true, result.err);
  assert.deepEqual(JSON.parse(result.out.trim()), { ok: true, exitCode: 0, timedOut: false });
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

test('resolveDefaultShellForCommand enables a shell for Yarn shims on Windows', () => {
  assert.equal(resolveDefaultShellForCommand('yarn', { platform: 'win32' }), true);
  assert.equal(resolveDefaultShellForCommand('yarn.cmd', { platform: 'win32' }), true);
  assert.equal(resolveDefaultShellForCommand('git', { platform: 'win32' }), false);
  assert.equal(resolveDefaultShellForCommand('yarn', { platform: 'linux' }), false);
});
