const CODEX_FAST_SERVICE_TIER_ID = 'priority';
const CODEX_LEGACY_FAST_SERVICE_TIER_ID = 'fast';

export function isCodexAppServerFastServiceTier(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === CODEX_FAST_SERVICE_TIER_ID
    || normalized === CODEX_LEGACY_FAST_SERVICE_TIER_ID;
}
