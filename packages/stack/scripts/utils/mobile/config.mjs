import { sanitizeBundleIdSegment, sanitizeUrlScheme } from './identifiers.mjs';

export function resolveMobileExpoConfig({ env = process.env } = {}) {
  const user = sanitizeBundleIdSegment(env.USER ?? env.USERNAME ?? 'user');
  const defaultLocalBundleId = `com.happy.local.${user}.dev`;

  const appEnv = env.APP_ENV ?? env.HAPPY_STACKS_APP_ENV ?? env.HAPPY_LOCAL_APP_ENV ?? 'development';
  // Prefer stack-scoped config, but also support generic Expo build env vars so users can
  // drive mobile identity purely via stack env files without learning Happy Stacks-specific keys.
  const iosAppName = (env.HAPPY_STACKS_IOS_APP_NAME ?? env.HAPPY_LOCAL_IOS_APP_NAME ?? env.EXPO_APP_NAME ?? '').toString();
  const iosBundleId = (
    env.HAPPY_STACKS_IOS_BUNDLE_ID ??
    env.HAPPY_LOCAL_IOS_BUNDLE_ID ??
    env.EXPO_APP_BUNDLE_ID ??
    defaultLocalBundleId
  ).toString();
  // Happy Stacks convention:
  // - dev-client QR should open a dedicated "Happy Stacks Dev" app (not a per-stack release build)
  // - so default to a stable happy-stacks-specific scheme unless explicitly overridden.
  const scheme = sanitizeUrlScheme(
    (env.HAPPY_STACKS_MOBILE_SCHEME ??
      env.HAPPY_LOCAL_MOBILE_SCHEME ??
      env.HAPPY_STACKS_DEV_CLIENT_SCHEME ??
      env.HAPPY_LOCAL_DEV_CLIENT_SCHEME ??
      env.EXPO_APP_SCHEME ??
      'happystacks-dev')
      .toString()
  );
  const host = (env.HAPPY_STACKS_MOBILE_HOST ?? env.HAPPY_LOCAL_MOBILE_HOST ?? 'lan').toString();

  return {
    appEnv,
    iosAppName,
    iosBundleId,
    scheme,
    host,
  };
}

