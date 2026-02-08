import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';

import { terminateProcessTreeByPid } from './processTree';

export type SpawnedProcess = {
  child: ChildProcess;
  stdoutPath: string;
  stderrPath: string;
  stop: (signal?: NodeJS.Signals) => Promise<void>;
};

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

export async function runLoggedCommand(params: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs?: number;
}): Promise<void> {
  const child = spawn(params.command, params.args, {
    cwd: params.cwd,
    env: params.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  const stdout = createWriteStream(params.stdoutPath, { flags: 'a' });
  const stderr = createWriteStream(params.stderrPath, { flags: 'a' });

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
}): SpawnedProcess {
  const child = spawn(params.command, params.args, {
    cwd: params.cwd,
    env: params.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  const stdout = createWriteStream(params.stdoutPath, { flags: 'a' });
  const stderr = createWriteStream(params.stderrPath, { flags: 'a' });

  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);

  const stop = async (signal: NodeJS.Signals = 'SIGTERM') => {
    if (child.exitCode !== null || child.killed) return;
    if (typeof child.pid === 'number' && child.pid > 0) {
      if (signal !== 'SIGTERM') {
        try {
          process.kill(child.pid, signal);
        } catch {
          // ignore
        }
      }
      await terminateProcessTreeByPid(child.pid, { graceMs: 10_000, pollMs: 100 });
      return;
    }
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  };

  return { child, stdoutPath: params.stdoutPath, stderrPath: params.stderrPath, stop };
}
