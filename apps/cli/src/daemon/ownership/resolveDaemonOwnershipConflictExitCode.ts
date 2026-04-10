import type { DaemonStartupSource } from '@/daemon/ownership/daemonOwnershipMetadata';

export function resolveDaemonOwnershipConflictExitCode(
  startupSource: DaemonStartupSource,
): 0 | 1 {
  return startupSource === 'background-service' ? 0 : 1;
}
