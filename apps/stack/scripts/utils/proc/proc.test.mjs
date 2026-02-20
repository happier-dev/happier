import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCaptureResult, spawnProc } from './proc.mjs';

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
