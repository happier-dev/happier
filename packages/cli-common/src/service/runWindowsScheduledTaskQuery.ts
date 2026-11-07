import type { SpawnSyncReturns } from 'node:child_process';

import { spawnBackgroundSync } from '../process/index.js';

/** The existing Scheduled Task inspection budget also bounds verification and diagnostics. */
export function runWindowsScheduledTaskQuery(
  command: 'powershell.exe' | 'schtasks',
  args: readonly string[],
  deadlineMs?: number,
): SpawnSyncReturns<string> {
  const configuredTimeout = Number(String(process.env.HAPPIER_WINDOWS_SCHTASKS_TIMEOUT_MS ?? '').trim());
  const queryTimeout = Number.isFinite(configuredTimeout) && Number.isInteger(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : 15_000;
  const timeout = deadlineMs === undefined ? queryTimeout : Math.min(queryTimeout, deadlineMs - Date.now());
  if (timeout <= 0) {
    return { pid: 0, status: null, signal: null, output: [null, '', ''], stdout: '', stderr: '',
      error: Object.assign(new Error('Scheduled Task query deadline elapsed'), { code: 'ETIMEDOUT' }) };
  }
  return spawnBackgroundSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  });
}
