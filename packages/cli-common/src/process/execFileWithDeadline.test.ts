import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileWithDeadline } from './execFileWithDeadline.js';

const OUTPUT_MARKER = 'nTCP 127.0.0.1:5199 (LISTEN)';

/**
 * The saturated-daemon condition, made deterministic. Measured on this corridor: the daemon ran
 * with event-loop stalls of 24–65 s while the scan's own `lsof` completed in 0.17 s.
 */
function stallEventLoop(durationMs: number): void {
  const until = Date.now() + durationMs;
  while (Date.now() < until) {
    // Intentionally synchronous: nothing may be serviced while the loop is blocked.
  }
}

const echoCommand = process.platform === 'win32' ? 'cmd.exe' : '/bin/echo';
const echoArgs = process.platform === 'win32'
  ? ['/c', 'echo', OUTPUT_MARKER]
  : [OUTPUT_MARKER];

const sleeperArgs = (prelude: string): readonly string[] => ([
  '-e',
  `${prelude}setTimeout(() => {}, 30_000);`,
]);

/**
 * Settle-or-give-up, so a boundary that never settles fails with a readable assertion instead of
 * a bare vitest timeout (which under this machine's load is indistinguishable from a slow box).
 */
async function settleWithin<T>(
  pending: Promise<T>,
  capMs: number,
): Promise<{ kind: 'resolved'; value: T } | { kind: 'rejected'; reason: unknown } | { kind: 'still-waiting' }> {
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<{ kind: 'still-waiting' }>((resolve) => {
    capTimer = setTimeout(() => resolve({ kind: 'still-waiting' }), capMs);
  });
  try {
    return await Promise.race([
      pending.then(
        (value) => ({ kind: 'resolved' as const, value }),
        (reason: unknown) => ({ kind: 'rejected' as const, reason }),
      ),
      cap,
    ]);
  } finally {
    if (capTimer) clearTimeout(capTimer);
  }
}

/** Shell-safe marker: `OUTPUT_MARKER` carries spaces and parentheses that `sh` would parse. */
const SHELL_MARKER = 'FOREGROUND-5199';

/** A command that leaves a process running which inherited its stdout pipe. */
const survivorShellArgs = (foreground: string): readonly string[] => ([
  '-c',
  `echo ${SHELL_MARKER}; sleep 20 & ${foreground}`,
]);

describe('execFileWithDeadline', () => {
  it.each([0, 7])('retains caller-budgeted Unicode-safe output suffixes without stopping a noisy command (exit %s)', async exitCode => {
    const outputTailMaxBytes = 128;
    const pending = execFileWithDeadline(process.execPath, ['-e', `
      process.stdout.write('old-out:' + '😀'.repeat(1024) + ':stdout-end😀');
      process.stderr.write('old-error:' + 'é'.repeat(1024) + ':stderr-end😀');
      process.exitCode = ${exitCode};
    `], { outputTailMaxBytes, maxBuffer: Infinity });
    const output = exitCode === 0 ? await pending : await pending.catch((error: unknown) => {
      expect(error).toMatchObject({ code: exitCode });
      return error as { stdout: string; stderr: string; stdoutTruncated?: true; stderrTruncated?: true };
    });
    const stdout = String(output.stdout);
    const stderr = String(output.stderr);
    expect(stdout.endsWith(':stdout-end😀')).toBe(true);
    expect(stderr.endsWith(':stderr-end😀')).toBe(true);
    expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(outputTailMaxBytes);
    expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(outputTailMaxBytes);
    expect(stdout.charCodeAt(0) >= 0xdc00 && stdout.charCodeAt(0) <= 0xdfff).toBe(false);
    expect(output).toMatchObject({ stdoutTruncated: true, stderrTruncated: true });
  });

  it.skipIf(process.platform === 'win32')('keeps the existing deadline owner for caller-budgeted suffix capture when a trap exits zero', async () => {
    await expect(execFileWithDeadline('/bin/sh', ['-c', 'trap "exit 0" TERM; echo started; while :; do sleep 0.1; done'],
      { timeout: 250, outputTailMaxBytes: 128 })).rejects.toMatchObject({ killed: true, code: 0, stdout: expect.stringContaining('started') });
  });
  it.skipIf(process.platform === 'win32').each([false, true])('reports an owned deadline even when the terminated command handles SIGTERM and exits zero (supplied terminator: %s)', async (suppliedTerminator) => {
    let terminatorCalled = false;
    const pending = execFileWithDeadline('/bin/sh', ['-c', 'trap "exit 0" TERM; echo started; while :; do sleep 0.1; done'], {
      timeout: 250,
      ...(suppliedTerminator ? { terminateOnAbort: async (child: import('node:child_process').ChildProcess) => { terminatorCalled = true; child.kill(); } } : {}),
    });
    await expect(pending).rejects.toMatchObject({ killed: true, stdout: expect.stringContaining('started') });
    expect(terminatorCalled).toBe(suppliedTerminator);
  });
  it('preserves an injected cancellation failure instead of reporting cancellation success', async () => {
    const controller = new AbortController();
    const failure = new Error('fixture termination failed');
    const server = createServer((_req, res) => { res.end(); controller.abort(); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture address');
      const pending = execFileWithDeadline(process.execPath, ['-e', `
        require('node:http').get('http://127.0.0.1:${address.port}', res => res.resume());
        setTimeout(() => {}, 1000);
      `], {
        signal: controller.signal,
        terminateOnAbort: async (child) => { child.kill(); throw failure; },
      });
      await expect(pending).rejects.toMatchObject({ name: 'ExecFileTerminationError', cause: failure });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.skipIf(process.platform === 'win32').each(['abort', 'deadline'] as const)('awaits the supplied termination owner and prevents a descendant from writing after %s', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'exec-tree-cancel-'));
    const marker = join(root, 'late-write');
    const controller = new AbortController();
    let terminationFinished = false;
    let descendantPid: number | undefined;
    let observeDescendant: () => void = () => {};
    const descendantReady = new Promise<void>((resolve) => { observeDescendant = resolve; });
    const server = createServer((req, res) => {
      descendantPid = Number(new URL(req.url ?? '/', 'http://fixture').searchParams.get('pid'));
      observeDescendant();
      res.end();
      if (mode === 'abort') controller.abort();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture address');
      const descendant = `
        require('node:http').get('http://127.0.0.1:${address.port}/?pid=' + process.pid, res => res.resume());
        setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'written'); process.exit(0); }, ${mode === 'deadline' ? 1000 : 300});
      `;
      const pending = execFileWithDeadline(process.execPath, ['-e', `
        require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });
        setTimeout(() => {}, 2000);
      `], {
        signal: controller.signal,
        ...(mode === 'deadline' ? { timeout: 500 } : {}),
        // The owning host supplies its real platform tree terminator at this OS boundary.
        terminateOnAbort: async (child) => {
          // Child startup may outlast the fixture's deadline on a saturated host. The
          // injected OS terminator waits for its exact descendant identity before signalling.
          await descendantReady;
          if (!descendantPid || descendantPid <= 1) throw new Error('Missing descendant pid');
          process.kill(descendantPid, 'SIGTERM');
          child.kill();
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          terminationFinished = true;
        },
      });
      await expect(pending).rejects.toMatchObject(mode === 'abort' ? { name: 'AbortError' } : { killed: true });
      expect(terminationFinished).toBe(true);
      await new Promise<void>((resolve) => setTimeout(resolve, mode === 'deadline' ? 600 : 400));
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      // The finite descendant can exit even on RED before its fixture home is removed.
      await new Promise<void>((resolve) => setTimeout(resolve, mode === 'deadline' ? 600 : 400));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('waits for the cancelled command to exit before rejecting', async () => {
    const controller = new AbortController();
    let cleanupObserved = false;
    let observeCleanup: () => void = () => {};
    const cleanup = new Promise<void>((resolve) => { observeCleanup = resolve; });
    const server = createServer((req, res) => {
      res.end();
      if (req.url === '/ready') controller.abort();
      else { cleanupObserved = true; observeCleanup(); }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture address');
      const url = `http://127.0.0.1:${address.port}`;
      const pending = execFileWithDeadline(process.execPath, ['-e', `
        const http = require('node:http');
        process.on('SIGTERM', () => setTimeout(() => {
          http.get(${JSON.stringify(url)} + '/cleaned', res => { res.resume(); res.on('end', () => process.exit(0)); });
        }, 100));
        http.get(${JSON.stringify(url)} + '/ready', res => res.resume());
        setInterval(() => {}, 1000);
      `], { signal: controller.signal });
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(cleanupObserved).toBe(true);
    } finally {
      // Even an early rejection must let the signalled fixture finish cancellation cleanup.
      await cleanup;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([undefined, 128])('supports caller cancellation without imposing a command deadline (suffix budget %s)', async outputTailMaxBytes => {
    const result = await execFileWithDeadline(process.execPath, [
      '-e', 'setTimeout(() => process.stdout.write("finished"), 50)',
    ], { ...(outputTailMaxBytes === undefined ? {} : { outputTailMaxBytes }) });
    expect(String(result.stdout)).toBe('finished');
    const controller = new AbortController();
    const pending = execFileWithDeadline(process.execPath, sleeperArgs(''), { signal: controller.signal,
      ...(outputTailMaxBytes === undefined ? {} : { outputTailMaxBytes }) });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
  });

  it.each([false, true])('delivers the output a finished child already produced when the deadline expires late on a stalled event loop (supplied terminator: %s)', async (suppliedTerminator) => {
    // The child writes and exits in milliseconds; the loop then stalls far past the budget, so
    // the deadline can only fire after the child is already gone. Node's own `execFile` timeout
    // destroys the child's stdout stream from the timers phase — which runs BEFORE poll — and
    // then reports `code 0, signal null` as a SUCCESS with empty stdout. The caller cannot tell
    // that apart from "there is nothing to report", and the local-services pane rendered a
    // terminal "No local services detected" while the ports were provably up.
    const pending = execFileWithDeadline(echoCommand, echoArgs, {
      timeout: 200,
      maxBuffer: 1024 * 1024,
      ...(suppliedTerminator ? { terminateOnAbort: async (child: import('node:child_process').ChildProcess) => { child.kill(); } } : {}),
    });

    stallEventLoop(1_500);

    const result = await pending;
    expect(String(result.stdout)).toContain(OUTPUT_MARKER);
  });

  it('delivers stderr the same way, so consumers that read a version banner off stderr survive a stall', async () => {
    const pending = execFileWithDeadline(
      process.execPath,
      ['-e', `process.stderr.write(${JSON.stringify(OUTPUT_MARKER)});`],
      { timeout: 200, maxBuffer: 1024 * 1024 },
    );

    stallEventLoop(1_500);

    const result = await pending;
    expect(String(result.stderr)).toContain(OUTPUT_MARKER);
  });

  it('reports a child still running at the deadline as a failure, keeping the output it had already printed', async () => {
    const pending = execFileWithDeadline(
      process.execPath,
      sleeperArgs(`process.stdout.write(${JSON.stringify(`${OUTPUT_MARKER}\n`)});`),
      { timeout: 750, maxBuffer: 1024 * 1024 },
    );

    const error = await pending.then(
      (result) => ({ resolvedStdout: String(result.stdout) }),
      (reason: unknown) => reason,
    );

    // Work we cut short is failed work, never a successful empty result: the local-service
    // scanners read this rejection as `degraded`, and terminate reads it as a process table it
    // must refuse to act on.
    expect(error).toBeInstanceOf(Error);
    expect(String((error as { stdout?: unknown }).stdout ?? '')).toContain(OUTPUT_MARKER);
    // `killed`/`signal` are whatever Node sets for a terminated child, so consumers that classify
    // a timeout off the error object (the simulator tool runner does) keep working unchanged.
    expect((error as { killed?: unknown }).killed).toBe(true);
  });

  it('passes spawn options through, so an env-scoped probe stays env-scoped', async () => {
    const result = await execFileWithDeadline(
      process.execPath,
      ['-e', 'process.stdout.write(String(process.env.HAPPIER_EXEC_DEADLINE_PROBE ?? ""));'],
      { timeout: 5_000, env: { ...process.env, HAPPIER_EXEC_DEADLINE_PROBE: OUTPUT_MARKER } },
    );

    expect(String(result.stdout)).toContain(OUTPUT_MARKER);
  });

  // A command that backgrounds a process is normal, expected use of a shell, and `sh` forks for
  // anything that is not a single exec-replaceable command — so the survivor holding the stdout
  // pipe is the common case, not an exotic one. `execFile` reports through the child's 'close'
  // event, which needs every stdio stream closed as well as the process gone, so without a bound
  // on the pipe wait this settles only when the *survivor* exits: measured 5,015 ms for a
  // `sleep 5`, and never for a `sleep 60`.
  it.skipIf(process.platform === 'win32')(
    'settles when the command itself exits, even though a process it left running still holds its stdout pipe',
    async () => {
      const startedAt = Date.now();
      const outcome = await settleWithin(
        execFileWithDeadline('/bin/sh', survivorShellArgs('exit 0'), {
          timeout: 5_000,
          maxBuffer: 1024 * 1024,
        }),
        3_000,
      );

      expect(outcome.kind).toBe('resolved');
      expect(String((outcome as { value: { stdout: unknown } }).value.stdout)).toContain(SHELL_MARKER);
      // The command exited in milliseconds; waiting on the survivor's pipe would take 20 s.
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    },
  );

  // The risk the bound introduces is truncation: giving up on the pipe before the command's own
  // output has been read would hand back a short answer that looks complete. This is the case that
  // would show it — far more output than a pipe buffer holds, with a survivor keeping the pipe open
  // so nothing but the bound can end the wait.
  it.skipIf(process.platform === 'win32')(
    'delivers every byte the command wrote, past the size of a pipe buffer, with a survivor holding the pipe',
    async () => {
      const lineCount = 50_000;
      const expectedBytes = Array.from({ length: lineCount }, (_, index) => `${index + 1}\n`).join('').length;

      const outcome = await settleWithin(
        execFileWithDeadline('/bin/sh', ['-c', `seq 1 ${lineCount}; sleep 20 & exit 0`], {
          timeout: 5_000,
          maxBuffer: 8 * 1024 * 1024,
        }),
        3_000,
      );

      expect(outcome.kind).toBe('resolved');
      expect(String((outcome as { value: { stdout: unknown } }).value.stdout)).toHaveLength(expectedBytes);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reports a command we cut short as failed instead of waiting forever on the pipe its survivor holds',
    async () => {
      const startedAt = Date.now();
      const outcome = await settleWithin(
        execFileWithDeadline('/bin/sh', survivorShellArgs('sleep 20'), {
          timeout: 500,
          maxBuffer: 1024 * 1024,
        }),
        3_000,
      );

      // `child.kill()` reaches the direct child only: the backgrounded `sleep` keeps the write end
      // of the pipe open, so the 'close' event this boundary reports through never arrives and the
      // caller — for `rpc/handlers/bash.ts`, a remote shell request — is answered never rather than
      // late.
      expect(outcome.kind).toBe('rejected');
      const reason = (outcome as { reason: unknown }).reason;
      expect(reason).toBeInstanceOf(Error);
      expect((reason as { killed?: unknown }).killed).toBe(true);
      expect(String((reason as { stdout?: unknown }).stdout ?? '')).toContain(SHELL_MARKER);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    },
  );
});
