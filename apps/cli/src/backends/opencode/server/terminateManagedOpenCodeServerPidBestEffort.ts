import { isOpenCodeServerPidAlive } from './openCodeServerProcessState';

function readPositiveIntEnv(name: string): number | null {
  const raw = typeof process.env[name] === 'string' ? process.env[name]!.trim() : '';
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  if (n <= 0) return null;
  return n;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

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
    await sleep(pollMs);
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
