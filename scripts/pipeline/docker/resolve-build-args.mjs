// @ts-check

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ defaultSentryRelease?: string }} [opts]
 * @returns {string[]}
 */
export function resolveOptionalDockerBuildArgs(env, opts) {
  /** @type {string[]} */
  const args = [];
  const readFirstNonEmpty = (...keys) => {
    for (const key of keys) {
      const value = String(env[key] ?? '').trim();
      if (value) return value;
    }
    return '';
  };

  const sentryToken = String(env.SENTRY_AUTH_TOKEN ?? '').trim();
  if (sentryToken) {
    args.push('--build-arg', `SENTRY_AUTH_TOKEN=${sentryToken}`);
  }

  const sentryUrl = String(env.SENTRY_URL ?? '').trim();
  if (sentryUrl) {
    args.push('--build-arg', `SENTRY_URL=${sentryUrl}`);
  }

  const sentryDsn = String(env.SENTRY_DSN ?? '').trim();
  if (sentryDsn) {
    args.push('--build-arg', `SENTRY_DSN=${sentryDsn}`);
  }

  const sentryReleaseRaw = String(env.SENTRY_RELEASE ?? '').trim();
  const sentryRelease = sentryReleaseRaw || String(opts?.defaultSentryRelease ?? '').trim();
  if (sentryRelease) {
    args.push('--build-arg', `SENTRY_RELEASE=${sentryRelease}`);
  }

  const sentryServerCentralDsn = String(env.SENTRY_SERVER_CENTRAL_DSN ?? '').trim();
  if (sentryServerCentralDsn) {
    args.push('--build-arg', `SENTRY_SERVER_CENTRAL_DSN=${sentryServerCentralDsn}`);
  }

  const posthogApiKey = String(env.POSTHOG_API_KEY ?? '').trim();
  if (posthogApiKey) {
    args.push('--build-arg', `POSTHOG_API_KEY=${posthogApiKey}`);
  }

  const posthogHost = String(env.POSTHOG_HOST ?? '').trim();
  if (posthogHost) {
    args.push('--build-arg', `POSTHOG_HOST=${posthogHost}`);
  }

  const happierServerUrl = readFirstNonEmpty(
    'EXPO_PUBLIC_HAPPIER_SERVER_URL',
    'EXPO_PUBLIC_HAPPY_SERVER_URL',
    'EXPO_PUBLIC_SERVER_URL',
  );
  if (happierServerUrl) {
    args.push('--build-arg', `EXPO_PUBLIC_HAPPIER_SERVER_URL=${happierServerUrl}`);
  }

  return args;
}
