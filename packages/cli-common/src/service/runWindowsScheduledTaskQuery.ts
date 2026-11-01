import type { SpawnSyncReturns } from 'node:child_process';

import { spawnBackgroundSync } from '../process/index.js';

/** The existing Scheduled Task inspection budget also bounds verification and diagnostics. */
export function runWindowsScheduledTaskQuery(
  command: 'powershell.exe' | 'schtasks',
  args: readonly string[],
): SpawnSyncReturns<string> {
  const configuredTimeout = Number(String(process.env.HAPPIER_WINDOWS_SCHTASKS_TIMEOUT_MS ?? '').trim());
  const timeout = Number.isFinite(configuredTimeout) && Number.isInteger(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : 15_000;
  return spawnBackgroundSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  });
}
