const LOCAL_PLAYWRIGHT_WRAPPER_TIMEOUT_MS = 90 * 60 * 1000;
const CI_PLAYWRIGHT_WRAPPER_TIMEOUT_MS = 42 * 60 * 1000;

function readPositiveInteger(rawValue) {
  const parsed = Number.parseInt(String(rawValue ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isTruthyCi(rawValue) {
  const normalized = String(rawValue ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export function resolvePlaywrightWrapperTimeoutFallbackMs(env = process.env) {
  const explicitTimeoutMs = readPositiveInteger(env.HAPPIER_PLAYWRIGHT_WRAPPER_TIMEOUT_MS);
  if (explicitTimeoutMs != null) return explicitTimeoutMs;
  return isTruthyCi(env.CI) ? CI_PLAYWRIGHT_WRAPPER_TIMEOUT_MS : LOCAL_PLAYWRIGHT_WRAPPER_TIMEOUT_MS;
}
