import type { SpawnSyncReturns } from 'node:child_process';

import { spawnBackgroundSync } from '../process/index.js';

/** An operator can bound queries; otherwise the containing operation owns its deadline. */
export function runWindowsScheduledTaskQuery(
  command: 'powershell.exe' | 'schtasks',
  args: readonly string[],
): SpawnSyncReturns<string> {
  const configuredTimeout = Number(String(process.env.HAPPIER_WINDOWS_SCHTASKS_TIMEOUT_MS ?? '').trim());
  const timeout = Number.isFinite(configuredTimeout) && Number.isInteger(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : undefined;
  return spawnBackgroundSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  });
}
