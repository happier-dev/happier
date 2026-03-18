import type { DirectSessionActivityV1 } from '@happier-dev/protocol';

function resolveRecentActivityWindowMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.HAPPIER_DIRECT_SESSIONS_RECENT_ACTIVITY_WINDOW_MS ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 15_000;
  return Math.max(1000, Math.min(60 * 60 * 1000, configured));
}

export function deriveDirectSessionActivityFromTimestamp(params: Readonly<{
  updatedAtMs: number | null | undefined;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}>): DirectSessionActivityV1 {
  const updatedAtMs = typeof params.updatedAtMs === 'number' && Number.isFinite(params.updatedAtMs)
    ? Math.trunc(params.updatedAtMs)
    : null;
  if (updatedAtMs == null || updatedAtMs < 0) return 'unknown';

  const env = params.env ?? process.env;
  const nowMs = params.nowMs ?? Date.now();
  const ageMs = nowMs - updatedAtMs;
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'unknown';

  return ageMs <= resolveRecentActivityWindowMs(env) ? 'active_recently' : 'idle';
}
