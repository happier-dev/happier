export const DEFAULT_SERVER_SHUTDOWN_DEADLINE_MS = 5_000;
export const SERVER_PROCESS_EXIT_OVERHEAD_MS = 250;

export function resolveServerShutdownGraceMs(env = process.env) {
  const raw = String(env.HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS ?? '').trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const shutdownDeadlineMs = Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_SERVER_SHUTDOWN_DEADLINE_MS;
  return shutdownDeadlineMs + SERVER_PROCESS_EXIT_OVERHEAD_MS;
}
