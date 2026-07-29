import { spawn } from 'node:child_process';

import { parsePowerShellStartProcessPid } from './visibleConsoleSpawn';
import { buildPowerShellStartWindowsTerminalInvocation } from './windowsTerminalSpawn';

export async function startHappySessionInWindowsTerminal(params: {
  filePath: string;
  args: string[];
  workingDirectory: string;
  env: NodeJS.ProcessEnv;
  windowId: string;
  title: string;
  onDispatcherSpawned?: (
    pid: number,
    stopDispatcher: () => void,
  ) => void;
}): Promise<
  | { ok: true; pid: number; custodyPid: number }
  | {
      ok: false;
      dispatch: 'not_started';
      errorMessage: string;
    }
  | {
      ok: false;
      dispatch: 'uncertain';
      custodyPid: number;
      errorMessage: string;
    }
> {
  const invocation = buildPowerShellStartWindowsTerminalInvocation(params);

  return await new Promise((resolve) => {
    let settled = false;
    const safeResolve = (result:
      | { ok: true; pid: number; custodyPid: number }
      | {
          ok: false;
          dispatch: 'not_started';
          errorMessage: string;
        }
      | {
          ok: false;
          dispatch: 'uncertain';
          custodyPid: number;
          errorMessage: string;
        }
    ) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn(invocation.command, invocation.args, {
      cwd: params.workingDirectory,
      env: params.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const custodyPid =
      Number.isInteger(child.pid) && (child.pid ?? 0) > 0
        ? child.pid!
        : null;
    if (custodyPid !== null) {
      params.onDispatcherSpawned?.(
        custodyPid,
        () => {
          if (!child.killed) child.kill();
        },
      );
    }

    let stdout = '';
    const appendBoundedOutput = (
      current: string,
      data: unknown,
    ): string =>
      (
        current
        + (Buffer.isBuffer(data)
          ? data.toString('utf8')
          : String(data))
      ).slice(-16_384);

    child.stdout?.on('data', (data) => {
      stdout = appendBoundedOutput(stdout, data);
    });
    child.stderr?.on('data', (data) => {
      // Drain the pipe, but never retain child argv or diagnostics from it.
      void data;
    });

    child.once('error', () => {
      safeResolve(
        custodyPid === null
          ? {
              ok: false,
              dispatch: 'not_started',
              errorMessage:
                'Windows Terminal dispatcher could not be started',
            }
          : {
              ok: false,
              dispatch: 'uncertain',
              custodyPid,
              errorMessage:
                'Windows Terminal dispatcher failed after launch may have committed',
            },
      );
    });

    child.once('close', (code) => {
      if (custodyPid === null) {
        safeResolve({
          ok: false,
          dispatch: 'not_started',
          errorMessage:
            'Windows Terminal dispatcher could not be started',
        });
        return;
      }
      if (code !== 0) {
        safeResolve({
          ok: false,
          dispatch: 'uncertain',
          custodyPid,
          errorMessage:
            `Windows Terminal dispatcher exited with code ${
              typeof code === 'number' ? code : 'unknown'
            } after launch may have committed`,
        });
        return;
      }

      const pid = parsePowerShellStartProcessPid(stdout);
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        safeResolve({
          ok: false,
          dispatch: 'uncertain',
          custodyPid,
          errorMessage:
            'Windows Terminal dispatch completed without a usable dispatcher PID',
        });
        return;
      }
      safeResolve({ ok: true, pid, custodyPid });
    });
  });
}
