import { spawn } from 'node:child_process';

export function shouldRunDaemonReattachIntegration(): boolean {
  return process.env.HAPPIER_CLI_DAEMON_REATTACH_INTEGRATION === '1';
}

export function spawnHappyLookingProcess(): { pid: number; kill: () => void } {
  const child = spawn(
    process.execPath,
    ['-e', '/* bin/happier.mjs --started-by daemon */ setInterval(() => {}, 1_000_000)'],
    { stdio: 'ignore' },
  );
  if (!child.pid) throw new Error('Failed to spawn test process');
  return {
    pid: child.pid,
    kill: () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    },
  };
}

export async function waitForPidInspection<T>(
  inspectPid: (pid: number) => Promise<T | null>,
  pid: number,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T | null> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 100;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const inspected = await inspectPid(pid);
    if (inspected !== null) return inspected;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}
