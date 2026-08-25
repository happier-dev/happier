import { execFile, type ExecFileOptions } from 'node:child_process';

import { closeStdioWhenCommandExits } from './closeStdioWhenCommandExits.js';

export type ExecFileWithDeadlineOptions =
  & Readonly<Omit<ExecFileOptions, 'timeout' | 'killSignal'>>
  & Readonly<{
    encoding?: BufferEncoding | null;
    /** Wall-clock budget. This boundary owns it; `child_process` is never told about it. */
    timeout: number;
  }>;

export type ExecFileWithDeadlineResult = Readonly<{
  stdout: string | Buffer;
  stderr: string | Buffer;
}>;

/**
 * Run a command under a deadline THIS boundary owns, and read its output.
 *
 * `child_process.execFile`'s own `timeout` option cannot be used for anything whose output is
 * read, because its kill path destroys the child's stdout/stderr streams and the timers phase
 * runs BEFORE the poll phase. On an event loop that stalled past the budget, a child that already
 * exited `0` with its output buffered in the pipe has that output destroyed, and the callback
 * still reports `code 0, signal null` — a SUCCESS carrying empty stdout. No caller can tell that
 * apart from a genuinely empty result, so every consumer that reads "nothing" as a fact silently
 * inherits a lie: no listeners on this machine, no descendants of this pid, no process row for
 * this pid, no version for this CLI, no serve config for this tailnet.
 *
 * That is not theoretical. It was reproduced on this host with the real `lsof` the local-service
 * scan runs (75 listeners → 0, reported as success) and the daemon here measures event-loop stalls
 * with p50 21 s against budgets of 400–5000 ms, so the precondition is routinely met.
 *
 * Owning the deadline keeps both facts intact:
 * - a child that has already finished still delivers its output, however late the deadline fires,
 *   because signalling a dead pid is a no-op and nothing discards what it wrote;
 * - a child that is genuinely still running is terminated and surfaces as a REJECTION, so work we
 *   cut short is reported as failed and never as empty.
 *
 * The rejection keeps `child_process`'s own contract verbatim — `error.stdout` / `error.stderr`
 * carry whatever the child had already printed, and `killed`/`signal` are set exactly as Node sets
 * them — so consumers that classify a timeout off the error object are unaffected.
 *
 * Two different waits are bounded here, and conflating them is what made Node's option unusable:
 * - the wait for the COMMAND is bounded by `timeout`, which kills it and rejects;
 * - the wait for its OUTPUT PIPE is bounded by the command's own exit, because that pipe is
 *   inherited by everything the command spawned and can outlive it by any amount. See
 *   `closeStdioWhenCommandExits`. Without that second bound a backgrounded process held the result
 *   for as long as it ran, and a killed command whose survivor held the pipe never settled at all.
 */
export function execFileWithDeadline(
  command: string,
  args: readonly string[],
  options: ExecFileWithDeadlineOptions,
): Promise<ExecFileWithDeadlineResult> {
  const { timeout, ...spawnOptions } = options;
  return new Promise<ExecFileWithDeadlineResult>((resolve, reject) => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const child = execFile(command, [...args], spawnOptions, (error, stdout, stderr) => {
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
    closeStdioWhenCommandExits(child);
    if (!settled) {
      deadline = setTimeout(() => {
        child.kill();
      }, timeout);
    }
  });
}
