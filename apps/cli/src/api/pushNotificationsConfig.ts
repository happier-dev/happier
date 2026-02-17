function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  const value = (raw ?? '').trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(600_000, Math.trunc(parsed)));
}

export function readPushFetchTokensTimeoutMs(): number {
  return parseTimeoutMs(process.env.HAPPIER_PUSH_FETCH_TOKENS_TIMEOUT_MS, 15_000);
}

export function isPushDebugEnabled(): boolean {
  const raw = typeof process.env.HAPPIER_DEBUG_PUSH === 'string' ? process.env.HAPPIER_DEBUG_PUSH.trim().toLowerCase() : '';
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

