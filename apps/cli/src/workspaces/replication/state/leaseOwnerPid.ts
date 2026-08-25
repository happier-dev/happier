import { isPidProvablyAbsent, type ProcessSignalProbe } from '@happier-dev/cli-common/process';

const CLI_DAEMON_OWNER_ID_REGEX = /^cli-daemon:(\d+)(?::|$)/u;

/**
 * The one place that reads a pid out of a replication lease owner id.
 *
 * Returns `null` when the owner is not a CLI daemon at all — an owner we cannot identify is not an
 * owner we may make liveness claims about.
 */
export function parseCliDaemonPidFromOwnerId(ownerId: string): number | null {
  const match = CLI_DAEMON_OWNER_ID_REGEX.exec(ownerId);
  if (!match) return null;
  const parsed = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * Used to avoid TTL stalls after daemon restarts/crashes: if the lease owner pid is gone, treat
 * the lease as stealable even if unexpired.
 *
 * Stealing needs **proof of absence**. A holder we may not signal — EPERM on POSIX, EACCES for the
 * Windows `OpenProcess` denial — is still running, and reading that as dead is how two replication
 * paths took a live daemon's lease.
 */
export function isCliDaemonOwnedLeaseStealable(ownerId: string, probe?: ProcessSignalProbe): boolean {
  const pid = parseCliDaemonPidFromOwnerId(ownerId);
  if (pid === null) return false;
  return isPidProvablyAbsent(pid, probe);
}
