import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCaptureResult, spawnProc } from './proc.mjs';
import { resolveDefaultShellForCommand } from './proc.mjs';

async function withTempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'happy-proc-test-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
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
  await new Promise((resolve) => child.on('exit', resolve));

  const raw = await readFile(join(teeDir, 'server.log'), 'utf-8');
  assert.match(raw, /\[server\] hello/);
  assert.match(raw, /\[server\] oops/);
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

  await new Promise((resolve, reject) => {
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
    child.on('error', reject);
  });

  assert.deepEqual(observed, [
    { stream: 'stdout', line: 'one' },
    { stream: 'stdout', line: 'part' },
    { stream: 'stderr', line: 'err' },
  ]);
});

test('resolveDefaultShellForCommand enables a shell for Yarn shims on Windows', () => {
  assert.equal(resolveDefaultShellForCommand('yarn', { platform: 'win32' }), true);
  assert.equal(resolveDefaultShellForCommand('yarn.cmd', { platform: 'win32' }), true);
  assert.equal(resolveDefaultShellForCommand('git', { platform: 'win32' }), false);
  assert.equal(resolveDefaultShellForCommand('yarn', { platform: 'linux' }), false);
});
