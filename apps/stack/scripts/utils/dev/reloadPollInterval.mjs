const DEFAULT_DEV_RELOAD_POLL_INTERVAL_MS = 2000;

export function resolveDevReloadPollIntervalMs(
  env = process.env,
  { defaultMs = DEFAULT_DEV_RELOAD_POLL_INTERVAL_MS } = {},
) {
  const fallback = Number.isFinite(Number(defaultMs)) && Number(defaultMs) >= 0
    ? Math.floor(Number(defaultMs))
    : DEFAULT_DEV_RELOAD_POLL_INTERVAL_MS;
  const raw = String(env?.HAPPIER_STACK_DEV_RELOAD_POLL_MS ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}
