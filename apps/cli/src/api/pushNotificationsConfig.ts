import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  const value = (raw ?? '').trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(600_000, Math.trunc(parsed)));
}

export function readPushFetchTokensTimeoutMs(env: NodeJS.ProcessEnv = sessionProcessEnvironment()): number {
  return parseTimeoutMs(env.HAPPIER_PUSH_FETCH_TOKENS_TIMEOUT_MS, 15_000);
}

export function readPushFetchTokensFailureCooldownMs(env: NodeJS.ProcessEnv = sessionProcessEnvironment()): number {
  return parseTimeoutMs(env.HAPPIER_PUSH_FETCH_TOKENS_FAILURE_COOLDOWN_MS, 30_000);
}

export function isPushDebugEnabled(env: NodeJS.ProcessEnv = sessionProcessEnvironment()): boolean {
  const raw = typeof env.HAPPIER_DEBUG_PUSH === 'string' ? env.HAPPIER_DEBUG_PUSH.trim().toLowerCase() : '';
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
