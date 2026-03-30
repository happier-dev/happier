const DEFAULT_APP_SCHEME = 'happier';

export function resolveMobileAppScheme(env: NodeJS.ProcessEnv): string {
  const configured = String(
    env.HAPPIER_E2E_MOBILE_APP_SCHEME ??
    env.EXPO_APP_SCHEME ??
    '',
  ).trim();

  return configured || DEFAULT_APP_SCHEME;
}
