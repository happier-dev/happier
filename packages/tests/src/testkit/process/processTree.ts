import { spawnSync } from 'node:child_process';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

function tryKillPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error: any) {
    if (error?.code === 'ESRCH') return true;
    return false;
  }
}

function tryKillGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error: any) {
    if (error?.code === 'ESRCH') return true;
    return false;
  }
}

function taskkillTree(pid: number): boolean {
  const command = process.env.COMSPEC || 'cmd.exe';
  const result = spawnSync(command, ['/d', '/s', '/c', `taskkill /PID ${pid} /T /F`], {
    stdio: 'ignore',
  });
  return (result.status ?? 1) === 0;
}

export async function terminateProcessTreeByPid(
  pid: number,
  options: { graceMs?: number; pollMs?: number } = {},
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (!isProcessAlive(pid)) return;

  const graceMsRaw = options.graceMs;
  const pollMsRaw = options.pollMs;
  const graceMs = typeof graceMsRaw === 'number' && Number.isInteger(graceMsRaw) && graceMsRaw >= 0 ? graceMsRaw : 10_000;
  const pollMs = typeof pollMsRaw === 'number' && Number.isInteger(pollMsRaw) && pollMsRaw > 0 ? pollMsRaw : 100;

  if (process.platform === 'win32') {
    taskkillTree(pid);
    return;
  }

  if (!tryKillGroup(pid, 'SIGTERM')) {
    tryKillPid(pid, 'SIGTERM');
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < graceMs) {
    if (!isProcessAlive(pid)) return;
    await sleep(pollMs);
  }

  if (!tryKillGroup(pid, 'SIGKILL')) {
    tryKillPid(pid, 'SIGKILL');
  }
}
