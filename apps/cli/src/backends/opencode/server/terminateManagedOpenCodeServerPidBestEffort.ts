import { isOpenCodeServerPidAlive } from './openCodeServerProcessState';
import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';
import { delayUnref } from '@/utils/time';

function trySignalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error: any) {
    if (error?.code === 'ESRCH') return true;
    return false;
  }
}

function trySignalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error: any) {
    if (error?.code === 'ESRCH') return true;
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number, pollMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isOpenCodeServerPidAlive(pid)) return true;
    await delayUnref(pollMs);
  }
  return !isOpenCodeServerPidAlive(pid);
}

export async function terminateManagedOpenCodeServerPidBestEffort(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!isOpenCodeServerPidAlive(pid)) return true;

  const pollMs = readPositiveIntEnv('HAPPIER_OPENCODE_SERVER_STOP_POLL_MS') ?? 100;
  const graceMs = readPositiveIntEnv('HAPPIER_OPENCODE_SERVER_STOP_GRACE_MS') ?? 1_500;
  const killWaitMs = readPositiveIntEnv('HAPPIER_OPENCODE_SERVER_STOP_KILL_WAIT_MS') ?? 500;

  if (!trySignalProcessGroup(pid, 'SIGTERM')) {
    trySignalProcess(pid, 'SIGTERM');
  }

  if (await waitForPidExit(pid, graceMs, pollMs)) {
    return true;
  }

  if (!trySignalProcessGroup(pid, 'SIGKILL')) {
    trySignalProcess(pid, 'SIGKILL');
  }

  return await waitForPidExit(pid, killWaitMs, pollMs);
}
