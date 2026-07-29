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
export function resolveTuiChildTerminationPlan({
  childPid,
  processInstanceFingerprint = null,
} = {}) {
  const pid = coercePid(childPid);
  if (!pid) return { strategy: 'none', target: null };
  return {
    strategy: 'owned',
    target: pid,
    processInstanceFingerprint: String(processInstanceFingerprint ?? '').trim() || null,
  };
}
