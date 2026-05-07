import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';

import { resolveYarnCommandInvocation, type CommandInvocation } from './commands';
import { collectDescendantPids, terminateProcessTreeByPid } from './processTree';

export type SpawnedProcess = {
  child: ChildProcess;
  stdoutPath: string;
  stderrPath: string;
  stop: (signal?: NodeJS.Signals) => Promise<void>;
};

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
  return { command, args: [...args] };
}

export async function runLoggedCommand(params: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs?: number;
}): Promise<void> {
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

  const outcome = await new Promise<{ ok: true } | { ok: false; error: Error }>((resolve) => {
    const timer = setTimeout(() => {
      if (typeof child.pid === 'number' && child.pid > 0) {
        void terminateProcessTreeByPid(child.pid, { graceMs: 0, pollMs: 25 });
      }
      resolve({ ok: false, error: new Error(`${params.command} ${params.args.join(' ')} timed out after ${timeoutMs}ms`) });
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      detachCleanup();
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
      resolve({ ok: false, error: err instanceof Error ? err : new Error(String(err)) });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      detachCleanup();
      if (code === 0) {
        resolve({ ok: true });
        return;
      }

      const detail = signal ? `signal ${signal}` : `code ${code}`;
      resolve({ ok: false, error: new Error(`${params.command} exited with ${detail}`) });
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
      throw new Error(`${outcome.error.message}; ${drainError.message}`);
    }
    throw drainError;
  }

  if (!outcome.ok) throw outcome.error;
}

export function spawnLoggedProcess(params: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
  cleanupDescendantsOnExit?: boolean;
}): SpawnedProcess {
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
  const observedDescendantPids = new Set<number>();
  const detachCleanup = attachExitCleanup(child, () => [...observedDescendantPids]);
  const descendantPoller = process.platform === 'win32'
    ? null
    : setInterval(() => {
      if (typeof child.pid !== 'number' || child.pid <= 0) return;
      for (const pid of collectDescendantPids(child.pid)) {
        observedDescendantPids.add(pid);
      }
    }, 1);

  descendantPoller?.unref?.();

  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);

  const stop = async (signal: NodeJS.Signals = 'SIGTERM') => {
    descendantPoller?.unref?.();
    descendantPoller && clearInterval(descendantPoller);

    if (typeof child.pid === 'number' && child.pid > 0) {
      for (const pid of collectDescendantPids(child.pid)) {
        observedDescendantPids.add(pid);
      }
    }

    if (typeof child.pid !== 'number' || child.pid <= 0) {
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
      return;
    }

    if (process.platform === 'win32') {
      await terminateProcessTreeByPid(child.pid, {
        graceMs: 10_000,
        pollMs: 25,
        skipAliveCheck: true,
        additionalPids: [...observedDescendantPids],
      });
      return;
    }

    if (signal !== 'SIGTERM' && child.exitCode === null && !child.killed) {
      try {
        process.kill(child.pid, signal);
      } catch {
        // ignore
      }
    }

    await terminateProcessTreeByPid(child.pid, {
      graceMs: 10_000,
      pollMs: 25,
      skipAliveCheck: true,
      additionalPids: [...observedDescendantPids],
    });
  };

  child.once('exit', () => {
    if (descendantPoller) clearInterval(descendantPoller);
    if (params.cleanupDescendantsOnExit !== false && observedDescendantPids.size > 0) {
      void terminateProcessTreeByPid(child.pid ?? 0, {
        graceMs: 0,
        pollMs: 25,
        skipAliveCheck: true,
        additionalPids: [...observedDescendantPids],
      }).catch(() => {});
    }
    detachCleanup();
  });

  return { child, stdoutPath: params.stdoutPath, stderrPath: params.stderrPath, stop };
}
