import { execFile, spawn, type ChildProcess, type ExecFileOptions } from 'node:child_process';

import { closeStdioWhenCommandExits } from './closeStdioWhenCommandExits.js';

export type ExecFileWithDeadlineOptions =
  & Readonly<Omit<ExecFileOptions, 'timeout' | 'killSignal'>>
  & Readonly<{
    encoding?: BufferEncoding | null;
    /** Optional wall-clock budget. Omit when caller cancellation owns the lifetime. This boundary owns it; `child_process` is never told about it. */
    timeout?: number;
    /** A containing host may own stronger process containment for cancellation and this boundary's deadline. */
    terminateOnAbort?: (child: ChildProcess) => Promise<void>;
    /** Caller-owned resource ceiling for each UTF-8 output suffix; omitted preserves execFile capture. */
    outputTailMaxBytes?: number;
  }>;

export class ExecFileTerminationError extends Error {
  constructor(cause: unknown) {
    super('Process termination failed', { cause });
    this.name = 'ExecFileTerminationError';
  }
}

export type ExecFileWithDeadlineResult = Readonly<{
  stdout: string | Buffer;
  stderr: string | Buffer;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
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
  const { timeout, terminateOnAbort, outputTailMaxBytes, ...commandOptions } = options;
  if (outputTailMaxBytes !== undefined && (!Number.isSafeInteger(outputTailMaxBytes) || outputTailMaxBytes < 0)) {
    throw new TypeError('outputTailMaxBytes must be a nonnegative safe integer');
  }
  if (outputTailMaxBytes !== undefined && commandOptions.encoding !== undefined && commandOptions.encoding !== 'utf8' && commandOptions.encoding !== 'utf-8') {
    throw new TypeError('Output suffix capture requires UTF-8 encoding');
  }
  const spawnOptions = { ...commandOptions, windowsHide: commandOptions.windowsHide !== false };
  return new Promise<ExecFileWithDeadlineResult>((resolve, reject) => {
    const signal = spawnOptions.signal;
    if (terminateOnAbort) signal?.throwIfAborted();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let closed = false;
    let terminating = false;
    let terminationStarted = false;
    let deadlineTermination = false;
    let terminationError: ExecFileTerminationError | undefined;
    let complete: (() => void) | undefined;
    const finish = () => { if (closed && !terminating) complete?.(); };
    const captureEvidence: { stdoutTruncated?: boolean; stderrTruncated?: boolean } = {};
    const onCommandResult = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
      settled = true;
      if (deadline) clearTimeout(deadline);
      complete = () => {
        if (terminationError) { reject(terminationError); return; }
        if (terminateOnAbort && signal?.aborted) { reject(signal.reason); return; }
        if (error) {
          reject(Object.assign(error, { stdout, stderr }, captureEvidence, deadlineTermination ? { killed: true } : {}));
          return;
        }
        if (deadlineTermination) {
          reject(Object.assign(new Error(`Command timed out: ${command}`), {
            killed: true, code: child.exitCode, signal: child.signalCode, stdout, stderr, ...captureEvidence,
          }));
          return;
        }
        resolve({ stdout, stderr, ...captureEvidence });
      };
      finish();
    };
    const effectiveOptions = terminateOnAbort ? { ...spawnOptions, signal: undefined } : spawnOptions;
    const child = outputTailMaxBytes === undefined
      ? execFile(command, [...args], effectiveOptions, onCommandResult)
      : spawn(command, [...args], effectiveOptions);
    if (outputTailMaxBytes !== undefined) {
      let stdout = '';
      let stderr = '';
      let processError: Error | null = null;
      const append = (previous: string, chunk: string, key: 'stdoutTruncated' | 'stderrTruncated') => {
        const combined = previous + chunk;
        if (Buffer.byteLength(combined, 'utf8') <= outputTailMaxBytes) return combined;
        captureEvidence[key] = true;
        // Search by UTF-16 index, then skip a split surrogate pair. Stream decoding
        // already joins UTF-8 characters split across OS chunks.
        let low = 0;
        let high = combined.length;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (Buffer.byteLength(combined.slice(middle), 'utf8') <= outputTailMaxBytes) high = middle;
          else low = middle + 1;
        }
        if (low > 0 && combined.charCodeAt(low) >= 0xdc00 && combined.charCodeAt(low) <= 0xdfff
          && combined.charCodeAt(low - 1) >= 0xd800 && combined.charCodeAt(low - 1) <= 0xdbff) low += 1;
        return combined.slice(low);
      };
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => { stdout = append(stdout, chunk, 'stdoutTruncated'); });
      child.stderr?.on('data', (chunk: string) => { stderr = append(stderr, chunk, 'stderrTruncated'); });
      child.once('error', (error) => { processError = error; });
      child.once('close', (code, signalCode) => {
        const error = processError ?? (code !== 0 || signalCode !== null
          ? Object.assign(new Error(`Command failed: ${command}`), { code, signal: signalCode, killed: child.killed }) : null);
        onCommandResult(error, stdout, stderr);
      });
    }
    const terminate = () => {
      if (!terminateOnAbort || terminationStarted || closed) return;
      terminationStarted = true;
      terminating = true;
      void Promise.resolve().then(() => terminateOnAbort(child)).then(() => {
        terminating = false;
        finish();
      }, (error: unknown) => {
        terminating = false;
        terminationError = new ExecFileTerminationError(error);
        // A failed terminator may leave the child alive; make that failure observable.
        reject(terminationError);
      });
    };
    const abort = () => terminate();
    // Node reports AbortError from its error event immediately after signalling the child.
    // Waiting for close keeps caller cleanup from racing the still-running command.
    child.once('close', () => {
      closed = true;
      signal?.removeEventListener('abort', abort);
      finish();
    });
    closeStdioWhenCommandExits(child);
    if (terminateOnAbort && signal) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
    if (!settled && timeout !== undefined) {
      deadline = setTimeout(() => {
        // A stalled timers phase can run before a finished child's exit notification.
        // Check phase follows poll: let that notification arrive before deciding whether
        // termination is interrupting a running command, including one that traps SIGTERM.
        setImmediate(() => {
          if (closed || child.exitCode !== null || child.signalCode !== null) return;
          if (terminateOnAbort) {
            deadlineTermination = true;
            terminate();
          } else {
            // A successful signal is a deadline interruption even if its handler exits zero.
            // ESRCH can race the exit notification; a dead command keeps its real outcome.
            deadlineTermination = child.kill();
          }
        });
      }, timeout);
    }
  });
}
