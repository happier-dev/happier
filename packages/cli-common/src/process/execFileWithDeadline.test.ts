import { describe, expect, it } from 'vitest';

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
  it('delivers the output a finished child already produced when the deadline expires late on a stalled event loop', async () => {
    // The child writes and exits in milliseconds; the loop then stalls far past the budget, so
    // the deadline can only fire after the child is already gone. Node's own `execFile` timeout
    // destroys the child's stdout stream from the timers phase — which runs BEFORE poll — and
    // then reports `code 0, signal null` as a SUCCESS with empty stdout. The caller cannot tell
    // that apart from "there is nothing to report", and the local-services pane rendered a
    // terminal "No local services detected" while the ports were provably up.
    const pending = execFileWithDeadline(echoCommand, echoArgs, {
      timeout: 200,
      maxBuffer: 1024 * 1024,
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
