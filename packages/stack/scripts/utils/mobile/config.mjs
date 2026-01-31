import { sanitizeBundleIdSegment, sanitizeUrlScheme } from './identifiers.mjs';

export function resolveMobileExpoConfig({ env = process.env } = {}) {
  const user = sanitizeBundleIdSegment(env.USER ?? env.USERNAME ?? 'user');
  const defaultLocalBundleId = `com.happier.local.${user}.dev`;

  const appEnv = env.APP_ENV ?? env.HAPPIER_STACK_APP_ENV ?? 'development';
  // Prefer stack-scoped config, but also support generic Expo build env vars so users can
  // drive mobile identity purely via stack env files without learning Hapsta-specific keys.
  const iosAppName = (env.HAPPIER_STACK_IOS_APP_NAME ?? env.EXPO_APP_NAME ?? '').toString();
  const iosBundleId = (
    env.HAPPIER_STACK_IOS_BUNDLE_ID ??
    env.EXPO_APP_BUNDLE_ID ??
    defaultLocalBundleId
  ).toString();
  // Hapsta convention:
  // - dev-client QR should open a dedicated "Happy Stacks Dev" app (not a per-stack release build)
  // - so default to a stable happy-stacks-specific scheme unless explicitly overridden.
  const scheme = sanitizeUrlScheme(
    (env.HAPPIER_STACK_MOBILE_SCHEME ??
      env.HAPPIER_STACK_DEV_CLIENT_SCHEME ??
      env.EXPO_APP_SCHEME ??
      'hapsta-dev')
      .toString()
  );
  const host = (env.HAPPIER_STACK_MOBILE_HOST ?? 'lan').toString();

  return {
    appEnv,
    iosAppName,
    iosBundleId,
    scheme,
    host,
  };
}
