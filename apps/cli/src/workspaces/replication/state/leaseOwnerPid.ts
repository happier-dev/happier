const CLI_DAEMON_OWNER_ID_REGEX = /^cli-daemon:(\d+)(?::|$)/u;

function parseCliDaemonPidFromOwnerId(ownerId: string): number | null {
  const match = CLI_DAEMON_OWNER_ID_REGEX.exec(ownerId);
  if (!match) return null;
  const parsed = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

// Used to avoid TTL stalls after daemon restarts/crashes: if the lease owner pid is gone, treat
// the lease as stealable even if unexpired.
export function isCliDaemonOwnedLeaseStealable(ownerId: string): boolean {
  const pid = parseCliDaemonPidFromOwnerId(ownerId);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    return nodeError?.code === 'ESRCH';
  }
}
