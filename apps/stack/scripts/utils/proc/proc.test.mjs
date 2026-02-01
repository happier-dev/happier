import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCaptureResult } from './proc.mjs';

test('runCaptureResult captures stdout/stderr', async () => {
  const res = await runCaptureResult(process.execPath, ['-e', 'console.log("hello"); console.error("oops")'], {
    env: process.env,
  });
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.match(res.out, /hello/);
  assert.match(res.err, /oops/);
});

test('runCaptureResult streams output when streamLabel is set (without affecting captured output)', async () => {
  const stdoutWrites = [];
  const stderrWrites = [];

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  // Capture streaming output without polluting the test runner output.
  // eslint-disable-next-line no-console
  process.stdout.write = (chunk) => {
    stdoutWrites.push(String(chunk));
    return true;
  };
  // eslint-disable-next-line no-console
  process.stderr.write = (chunk) => {
    stderrWrites.push(String(chunk));
    return true;
  };

  try {
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
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  }
});

test('runCaptureResult can tee streamed output to a file', async () => {
  const teeFile = join(tmpdir(), `happy-proc-tee-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  try {
    const res = await runCaptureResult(process.execPath, ['-e', 'console.log("hello"); console.error("oops")'], {
      env: process.env,
      teeFile,
      teeLabel: 'tee-test',
    });
    assert.equal(res.ok, true);
    const raw = readFileSync(teeFile, 'utf-8');
    assert.match(raw, /\[tee-test\] hello/);
    assert.match(raw, /\[tee-test\] oops/);
  } finally {
    try {
      rmSync(teeFile, { force: true });
    } catch {
      // ignore
    }
  }
});
