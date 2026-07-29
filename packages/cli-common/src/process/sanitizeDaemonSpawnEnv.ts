/**
 * Removes caller/session/stack authority before any daemon process is spawned.
 * Call this after merging every launch-spec and caller-provided environment.
 */
export function sanitizeDaemonSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const key of Object.keys(sanitized)) {
    if (key.startsWith('HAPPIER_STACK_') || key.startsWith('HAPPY_STACK_')) {
      delete sanitized[key];
    }
  }
  delete sanitized.TMUX;
  delete sanitized.TMUX_PANE;
  delete sanitized.TMUX_TMPDIR;
  delete sanitized.HAPPIER_SESSION_ATTACH_FILE;
  delete sanitized.HAPPY_SESSION_ATTACH_FILE;
  delete sanitized.HAPPIER_ACTIVE_SERVER_ID;
  delete sanitized.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID;
  delete sanitized.HAPPIER_DAEMON_SERVICE_INSTANCE_ID;
  delete sanitized.HAPPIER_DAEMON_SERVICE_SERVER_URL;
  if (sanitized.HAPPIER_DISABLE_CAFFEINATE === undefined || sanitized.HAPPIER_DISABLE_CAFFEINATE === '') {
    sanitized.HAPPIER_DISABLE_CAFFEINATE = '1';
  }
  if (
    sanitized.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED === undefined
    || sanitized.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED === ''
  ) {
    sanitized.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED = '0';
  }
  return sanitized;
}
