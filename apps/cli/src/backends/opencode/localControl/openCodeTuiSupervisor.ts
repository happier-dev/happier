import { spawn } from 'node:child_process';

import { createOpenCodeAttachArgs } from './createOpenCodeAttachArgs';
import { resolveOpenCodeCliCommand } from '../utils/resolveOpenCodeCliCommand';

type SpawnedProcess = Readonly<{
  pid?: number;
  exitCode?: number | null;
  killed?: boolean;
  once: {
    (event: 'exit', handler: (code: number | null, signal: NodeJS.Signals | null) => void): void;
    (event: 'error', handler: (error: Error) => void): void;
  };
  kill: (signal?: NodeJS.Signals | number) => boolean;
}>;

async function waitForStartup(proc: SpawnedProcess): Promise<boolean> {
  if (proc.exitCode !== null && proc.exitCode !== undefined) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    proc.once('exit', () => finish(false));
    proc.once('error', () => finish(false));
    setImmediate(() => finish(true));
  });
}

function resolveDetachTimeoutMs(): number {
  const raw = Number.parseInt(String(process.env.HAPPIER_OPENCODE_LOCAL_DETACH_TIMEOUT_MS ?? ''), 10);
  const value = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 3_000;
  return Math.max(100, Math.min(60_000, value));
}

async function waitForExit(proc: SpawnedProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null && proc.exitCode !== undefined) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    proc.once('exit', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export type OpenCodeTuiSupervisor = Readonly<{
  isAttached: () => boolean;
  attach: (params: { baseUrl: string; directory: string; sessionId: string }) => Promise<boolean>;
  detach: () => Promise<void>;
  dispose: () => Promise<void>;
}>;

export function createOpenCodeTuiSupervisor(params?: Readonly<{
  spawnProcess?: typeof spawn;
  command?: string;
  env?: NodeJS.ProcessEnv;
  onExit?: () => void | Promise<void>;
}>): OpenCodeTuiSupervisor {
  const spawnProcess = params?.spawnProcess ?? spawn;
  const env = params?.env ?? process.env;
  const command = params?.command ?? resolveOpenCodeCliCommand(env);
  let proc: SpawnedProcess | null = null;

  const clearProc = (): void => {
    proc = null;
  };

  const detach = async (): Promise<void> => {
    const child = proc;
    if (!child) return;
    child.kill('SIGINT');
    const exitedGracefully = await waitForExit(child, resolveDetachTimeoutMs());
    if (!exitedGracefully) {
      child.kill('SIGKILL');
      await waitForExit(child, resolveDetachTimeoutMs());
    }
    clearProc();
  };

  return {
    isAttached: () => proc !== null,
    attach: async ({ baseUrl, directory, sessionId }) => {
      if (proc) return true;
      const child = spawnProcess(command, createOpenCodeAttachArgs({ baseUrl, directory, sessionId }), {
        stdio: 'inherit',
        env,
      }) as unknown as SpawnedProcess;
      proc = child;
      let startupCompleted = false;
      const handleClosed = (): void => {
        clearProc();
        if (startupCompleted) {
          void params?.onExit?.();
        }
      };
      child.once('exit', handleClosed);
      child.once('error', handleClosed);
      const started = await waitForStartup(child);
      if (!started) {
        clearProc();
        return false;
      }
      startupCompleted = true;
      return true;
    },
    detach,
    dispose: detach,
  };
}
