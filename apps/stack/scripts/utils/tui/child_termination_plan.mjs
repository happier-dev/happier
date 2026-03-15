function coercePid(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 1 ? n : null;
}

/**
 * Decide whether we can safely kill a child's process-group, or need to fall back to killing only the child PID.
 *
 * Why:
 * - `terminateProcessGroup(...)` uses `process.kill(-pgid, ...)`. If `pgid` equals the TUI's own PGID
 *   (e.g. detached group creation failed), we'd SIGINT ourselves and the TUI would exit.
 */
export function resolveTuiChildTerminationPlan({ childPid, childPgid, selfPgid } = {}) {
  const pid = coercePid(childPid);
  if (!pid) return { strategy: 'none', target: null };

  const pgid = coercePid(childPgid);
  const self = coercePid(selfPgid);

  // If we don't know our own PGID, prefer killing the child's PGID when available.
  if (pgid && !self) return { strategy: 'pgid', target: pgid };

  // Only kill the child's process-group if it is different from the TUI process-group.
  if (pgid && self && pgid !== self) return { strategy: 'pgid', target: pgid };

  // Fallback: kill only the child pid (best-effort; stack stop will clean infra if needed).
  return { strategy: 'pid', target: pid };
}
