import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';

import { resolveNpmCommandInvocation, resolveYarnCommandInvocation, type CommandInvocation } from './commands';
import { collectDescendantPids, terminateProcessTreeByPid } from './processTree';

export type SpawnedProcess = {
  child: ChildProcess;
  stdoutPath: string;
  stderrPath: string;
  stop: (signal?: NodeJS.Signals) => Promise<void>;
};

export type LoggedCommandProcessOutcome = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}>;

class LoggedCommandProcessError extends Error {
  readonly process: LoggedCommandProcessOutcome;

  constructor(message: string, processOutcome: LoggedCommandProcessOutcome) {
    super(message);
    this.name = 'LoggedCommandProcessError';
    this.process = processOutcome;
  }
}

export function readLoggedCommandProcessOutcome(error: unknown): LoggedCommandProcessOutcome | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = (error as { process?: unknown }).process;
  if (!candidate || typeof candidate !== 'object') return null;
  const { exitCode, signal } = candidate as { exitCode?: unknown; signal?: unknown };
  if (!(exitCode === null || (typeof exitCode === 'number' && Number.isInteger(exitCode)))) return null;
  if (!(signal === null || typeof signal === 'string')) return null;
  return Object.freeze({
    exitCode,
    signal: signal as NodeJS.Signals | null,
  });
}

function attachExitCleanup(
  child: ChildProcess,
  getAdditionalPids: () => number[] = () => [],
): () => void {
  const cleanup = () => {
    if (typeof child.pid !== 'number' || child.pid <= 0) return;
    void terminateProcessTreeByPid(child.pid, {
      graceMs: 0,
      pollMs: 25,
      skipAliveCheck: true,
      additionalPids: getAdditionalPids(),
    }).catch(() => {});
  };

  const onExit = () => {
    cleanup();
  };
  const onSignal = () => {
    cleanup();
  };

  process.once('exit', onExit);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('SIGHUP', onSignal);

  return () => {
    process.off('exit', onExit);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
  };
}

function waitForStreamDrain(stream: NodeJS.WritableStream, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const writable = stream as NodeJS.WritableStream & {
      writableFinished?: boolean;
      destroyed?: boolean;
    };

    if (writable.writableFinished || writable.destroyed) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for log stream drain after ${timeoutMs}ms`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      stream.off('finish', onFinish);
      stream.off('close', onFinish);
      stream.off('error', onError);
    };

    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    stream.once('finish', onFinish);
    stream.once('close', onFinish);
    stream.once('error', onError);
  });
}

function resolveSpawnCommandInvocation(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): CommandInvocation {
  const normalized = command.trim().toLowerCase();
  if (normalized === 'yarn' || normalized === 'yarn.cmd') {
    return resolveYarnCommandInvocation(args, { npmExecPath: env?.npm_execpath });
  }
  if (normalized === 'npm' || normalized === 'npm.cmd') {
    return resolveNpmCommandInvocation(args, { npmExecPath: env?.npm_execpath });
  }
  return { command, args: [...args] };
}

type RunLoggedCommandParams = {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
};

export async function runLoggedCommandWithOutcome(
  params: RunLoggedCommandParams,
): Promise<LoggedCommandProcessOutcome> {
  const invocation = resolveSpawnCommandInvocation(params.command, params.args, params.env);
  const child = spawn(invocation.command, invocation.args, {
    cwd: params.cwd,
    env: params.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    ...(invocation.windowsVerbatimArguments
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  });

  const stdout = createWriteStream(params.stdoutPath, { flags: 'w' });
  const stderr = createWriteStream(params.stderrPath, { flags: 'w' });
  const detachCleanup = attachExitCleanup(child);

  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);

  const timeoutMs = params.timeoutMs ?? 120_000;
  const streamDrainTimeoutMs = Math.max(10_000, Math.min(timeoutMs, 120_000));
  const closeLogStreams = () => {
    try {
      child.stdout?.unpipe(stdout);
    } catch {
      // ignore
    }
    try {
      child.stderr?.unpipe(stderr);
    } catch {
      // ignore
    }
    try {
      stdout.end();
    } catch {
      // ignore
    }
    try {
      stderr.end();
    } catch {
      // ignore
    }
  };
  const normalizeAbortError = (reason: unknown): Error => {
    if (reason instanceof Error) return reason;
    if (typeof reason === 'string' && reason.trim()) return new Error(reason);
    return new Error(`${params.command} ${params.args.join(' ')} aborted`);
  };

  const outcome = await new Promise<
    | { ok: true; process: LoggedCommandProcessOutcome }
    | { ok: false; error: Error }
  >((resolve) => {
    let settled = false;
    const settle = (result:
      | { ok: true; process: LoggedCommandProcessOutcome }
      | { ok: false; error: Error }) => {
      if (settled) return;
      settled = true;
      if (params.abortSignal && abortHandler) {
        params.abortSignal.removeEventListener('abort', abortHandler);
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (typeof child.pid === 'number' && child.pid > 0) {
        void terminateProcessTreeByPid(child.pid, { graceMs: 0, pollMs: 25 });
      }
      closeLogStreams();
      settle({ ok: false, error: new Error(`${params.command} ${params.args.join(' ')} timed out after ${timeoutMs}ms`) });
    }, timeoutMs);

    const abortHandler = () => {
      clearTimeout(timer);
      detachCleanup();
      if (typeof child.pid === 'number' && child.pid > 0) {
        void terminateProcessTreeByPid(child.pid, { graceMs: 0, pollMs: 25 });
      }
      closeLogStreams();
      settle({ ok: false, error: normalizeAbortError(params.abortSignal?.reason) });
    };

    if (params.abortSignal?.aborted) {
      abortHandler();
      return;
    }
    params.abortSignal?.addEventListener('abort', abortHandler, { once: true });

    child.on('error', (err) => {
      clearTimeout(timer);
      detachCleanup();
      closeLogStreams();
      settle({ ok: false, error: err instanceof Error ? err : new Error(String(err)) });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      detachCleanup();
      const processOutcome = Object.freeze({ exitCode: code, signal });
      if (code === 0) {
        settle({ ok: true, process: processOutcome });
        return;
      }

      const detail = signal ? `signal ${signal}` : `code ${code}`;
      settle({
        ok: false,
        error: new LoggedCommandProcessError(
          `${params.command} exited with ${detail}`,
          processOutcome,
        ),
      });
    });
  });

  let drainError: Error | null = null;
  try {
    await Promise.all([waitForStreamDrain(stdout, streamDrainTimeoutMs), waitForStreamDrain(stderr, streamDrainTimeoutMs)]);
  } catch (error: unknown) {
    drainError = error instanceof Error ? error : new Error(String(error));
  }

  if (drainError) {
    if (!outcome.ok) {
      const processOutcome = readLoggedCommandProcessOutcome(outcome.error);
      if (processOutcome) {
        throw new LoggedCommandProcessError(
          `${outcome.error.message}; ${drainError.message}`,
          processOutcome,
        );
      }
      throw new Error(`${outcome.error.message}; ${drainError.message}`);
    }
    throw new LoggedCommandProcessError(drainError.message, outcome.process);
  }

  if (!outcome.ok) throw outcome.error;
  return outcome.process;
}

export async function runLoggedCommand(params: RunLoggedCommandParams): Promise<void> {
  await runLoggedCommandWithOutcome(params);
}

export function spawnLoggedProcess(params: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
  cleanupDescendantsOnExit?: boolean;
  cleanup?: () => void | Promise<void>;
  onDescendantObserved?: (pid: number) => void;
  collectDescendants?: typeof collectDescendantPids;
  terminateProcessTree?: typeof terminateProcessTreeByPid;
}): SpawnedProcess {
  type TimeoutHandle = ReturnType<typeof setTimeout>;
  const unrefTimeout = (handle: TimeoutHandle | null) => {
    if (!handle) return;
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      const candidate = handle as unknown as { unref?: () => void };
      candidate.unref?.();
    }
  };

  const invocation = resolveSpawnCommandInvocation(params.command, params.args, params.env);
  const child = spawn(invocation.command, invocation.args, {
    cwd: params.cwd,
    env: params.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    ...(invocation.windowsVerbatimArguments
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  });

  const stdout = createWriteStream(params.stdoutPath, { flags: 'w' });
  const stderr = createWriteStream(params.stderrPath, { flags: 'w' });
  const collectDescendants = params.collectDescendants ?? collectDescendantPids;
  const terminateProcessTree = params.terminateProcessTree ?? terminateProcessTreeByPid;
  const observedDescendantPids = new Set<number>();
  const detachCleanup = attachExitCleanup(child, () => [...observedDescendantPids]);
  let descendantObservationError: unknown = null;
  const observeDescendants = () => {
    if (typeof child.pid !== 'number' || child.pid <= 0) return;
    try {
      for (const pid of collectDescendants(child.pid)) {
        const firstObservation = !observedDescendantPids.has(pid);
        observedDescendantPids.add(pid);
        if (firstObservation) params.onDescendantObserved?.(pid);
      }
      descendantObservationError = null;
    } catch (error) {
      descendantObservationError = error;
    }
  };
  let ownedCleanupPromise: Promise<void> | null = null;
  const cleanupOwnedResources = (): Promise<void> => {
    if (!params.cleanup) return Promise.resolve();
    if (!ownedCleanupPromise) {
      try {
        ownedCleanupPromise = Promise.resolve(params.cleanup());
      } catch (error) {
        ownedCleanupPromise = Promise.reject(error);
      }
    }
    return ownedCleanupPromise;
  };
  let descendantPoller: TimeoutHandle | null = null;
  let descendantPollerActive = process.platform !== 'win32';
  const pollStartedAtMs = Date.now();
  const fastPollWindowMs = 1_000;
  const fastPollMs = 25;
  const slowPollMs = 250;

  const pollDescendants = () => {
    if (!descendantPollerActive) return;
    observeDescendants();
    const nextDelay = Date.now() - pollStartedAtMs < fastPollWindowMs ? fastPollMs : slowPollMs;
    descendantPoller = setTimeout(pollDescendants, nextDelay);
    unrefTimeout(descendantPoller);
  };

  if (descendantPollerActive) {
    pollDescendants();
  }

  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);

  const stopDescendantPolling = () => {
    descendantPollerActive = false;
    if (descendantPoller) clearTimeout(descendantPoller);
    descendantPoller = null;
  };

  const settleCleanupPhases = async (
    phases: readonly Promise<void>[],
    context: string,
  ): Promise<void> => {
    const results = await Promise.allSettled(phases);
    const collectErrors = (reason: unknown): Error[] => {
      if (reason instanceof AggregateError) {
        return reason.errors.flatMap(collectErrors);
      }
      return [reason instanceof Error ? reason : new Error(String(reason))];
    };
    const errors = results.flatMap((result) => result.status === 'rejected'
      ? collectErrors(result.reason)
      : []);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, context);
  };

  let descendantCleanupPromise: Promise<void> | null = null;
  let explicitStopStarted = false;
  const cleanupDescendants = (
    signal: NodeJS.Signals = 'SIGTERM',
    options: Readonly<{ automaticExit?: boolean }> = {},
  ): Promise<void> => {
    if (descendantCleanupPromise) return descendantCleanupPromise;
    descendantCleanupPromise = (async () => {
      const errors: Error[] = [];
      observeDescendants();
      if (descendantObservationError) {
        errors.push(
          descendantObservationError instanceof Error
            ? descendantObservationError
            : new Error(String(descendantObservationError)),
        );
      }

      if (typeof child.pid !== 'number' || child.pid <= 0) {
        try {
          child.kill(signal);
        } catch {
          // ignore
        }
      } else {
        if (process.platform !== 'win32' && signal !== 'SIGTERM' && child.exitCode === null && !child.killed) {
          try {
            process.kill(child.pid, signal);
          } catch {
            // ignore
          }
        }

        if (options.automaticExit !== true || observedDescendantPids.size > 0 || descendantObservationError) {
          try {
            await terminateProcessTree(child.pid, {
              graceMs: options.automaticExit === true ? 0 : 10_000,
              pollMs: 25,
              skipAliveCheck: true,
              additionalPids: [...observedDescendantPids],
            });
          } catch (error) {
            errors.push(error instanceof Error ? error : new Error(String(error)));
          }
        }
      }

      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, 'Test process descendant cleanup failed');
      }
    })();
    return descendantCleanupPromise;
  };

  const stop = async (signal: NodeJS.Signals = 'SIGTERM') => {
    explicitStopStarted = true;
    stopDescendantPolling();

    await settleCleanupPhases(
      [cleanupDescendants(signal), cleanupOwnedResources()],
      'Test process descendant and owned cleanup failed',
    );
  };

  child.once('exit', () => {
    stopDescendantPolling();
    detachCleanup();
    if (!explicitStopStarted && params.cleanupDescendantsOnExit !== false) {
      void settleCleanupPhases(
        [cleanupDescendants('SIGTERM', { automaticExit: true }), cleanupOwnedResources()],
        'Automatic test process descendant and owned cleanup failed',
      ).catch(() => {
        process.emitWarning(
          'Automatic test process cleanup failed (phase=automatic-exit)',
          {
            code: 'HAPPIER_TEST_PROCESS_AUTO_CLEANUP_FAILED',
            type: 'HappierTestProcessCleanupWarning',
          },
        );
      });
    }
  });

  return { child, stdoutPath: params.stdoutPath, stderrPath: params.stderrPath, stop };
}
