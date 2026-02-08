import { spawn } from 'node:child_process';
import { buildPowerShellStartProcessInvocation, parsePowerShellStartProcessPid } from './visibleConsoleSpawn';

export async function startHappySessionInVisibleWindowsConsole(params: {
  filePath: string;
  args: string[];
  workingDirectory: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ ok: true; pid: number } | { ok: false; errorMessage: string }> {
  const invocation = buildPowerShellStartProcessInvocation({
    filePath: params.filePath,
    args: params.args,
    workingDirectory: params.workingDirectory,
  });

  return await new Promise((resolve) => {
    let settled = false;
    const safeResolve = (result: { ok: true; pid: number } | { ok: false; errorMessage: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn(invocation.command, invocation.args, {
      cwd: params.workingDirectory,
      env: { ...process.env, ...params.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    });
    child.stderr?.on('data', (data) => {
      stderr += Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    });

    child.once('error', (error) => {
      safeResolve({ ok: false, errorMessage: error instanceof Error ? error.message : 'Failed to spawn PowerShell' });
    });

    child.once('close', (code) => {
      if (code !== 0) {
        safeResolve({ ok: false, errorMessage: `PowerShell exit ${code}. ${stderr.trim() || stdout.trim()}`.trim() });
        return;
      }

      const pid = parsePowerShellStartProcessPid(stdout);
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        safeResolve({ ok: false, errorMessage: `Failed to parse PID from PowerShell output: ${stdout.trim()}` });
        return;
      }
      safeResolve({ ok: true, pid });
    });
  });
}
