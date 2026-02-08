import { spawnSync } from 'node:child_process';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

function tryKillPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return true;
    return false;
  }
}

function tryKillGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return true;
    return false;
  }
}

function taskkillTree(pid) {
  const command = process.env.COMSPEC || 'cmd.exe';
  const result = spawnSync(command, ['/d', '/s', '/c', `taskkill /PID ${pid} /T /F`], {
    stdio: 'ignore',
  });
  return (result.status ?? 1) === 0;
}

export async function terminateProcessTreeByPid(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return;

  const graceMs = Number.isInteger(options.graceMs) && options.graceMs >= 0 ? options.graceMs : 10_000;
  const pollMs = Number.isInteger(options.pollMs) && options.pollMs > 0 ? options.pollMs : 100;

  if (!isProcessAlive(pid)) return;

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

