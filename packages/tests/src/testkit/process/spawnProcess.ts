import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';

export type SpawnedProcess = {
  child: ChildProcess;
  stdoutPath: string;
  stderrPath: string;
  stop: (signal?: NodeJS.Signals) => Promise<void>;
};

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
  });

  const stdout = createWriteStream(params.stdoutPath, { flags: 'a' });
  const stderr = createWriteStream(params.stderrPath, { flags: 'a' });

  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);

  const timeoutMs = params.timeoutMs ?? 120_000;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(new Error(`${params.command} ${params.args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${params.command} exited with code ${code}`));
    });
  });
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
  });

  const stdout = createWriteStream(params.stdoutPath, { flags: 'a' });
  const stderr = createWriteStream(params.stderrPath, { flags: 'a' });

  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);

  const stop = async (signal: NodeJS.Signals = 'SIGTERM') => {
    if (child.exitCode !== null || child.killed) return;
    child.kill(signal);
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 10_000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  };

  return { child, stdoutPath: params.stdoutPath, stderrPath: params.stderrPath, stop };
}
