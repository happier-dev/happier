/**
 * Normalize pipeline env aliases so callers can set a single variable name and
 * have downstream steps (Docker build args, Expo public env, etc.) work
 * consistently.
 *
 * NOTE: This function only fills missing values. It does not overwrite already
 * provided env vars (even if they conflict).
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function normalizePipelineEnvAliases(env) {
  /** @type {Record<string, string>} */
  const normalized = {};

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') normalized[key] = value;
  }

  const readTrimmed = (key) => String(normalized[key] ?? '').trim();
  const setIfMissing = (key, value) => {
    if (String(normalized[key] ?? '').trim()) return;
    if (!String(value ?? '').trim()) return;
    normalized[key] = String(value);
  };

  // PostHog (public key is safe to embed)
  const posthogKey =
    readTrimmed('EXPO_PUBLIC_POSTHOG_KEY') ||
    readTrimmed('EXPO_PUBLIC_POSTHOG_API_KEY') ||
    readTrimmed('POSTHOG_API_KEY');
  setIfMissing('POSTHOG_API_KEY', posthogKey);
  setIfMissing('EXPO_PUBLIC_POSTHOG_KEY', posthogKey);
  setIfMissing('EXPO_PUBLIC_POSTHOG_API_KEY', posthogKey);

  const posthogHost = readTrimmed('EXPO_PUBLIC_POSTHOG_HOST') || readTrimmed('POSTHOG_HOST');
  setIfMissing('POSTHOG_HOST', posthogHost);
  setIfMissing('EXPO_PUBLIC_POSTHOG_HOST', posthogHost);

  // Sentry (DSN is safe to embed; auth token is NOT aliased)
  const sentryDsn = readTrimmed('EXPO_PUBLIC_SENTRY_DSN') || readTrimmed('SENTRY_DSN');
  setIfMissing('SENTRY_DSN', sentryDsn);
  setIfMissing('EXPO_PUBLIC_SENTRY_DSN', sentryDsn);

  return normalized;
}
