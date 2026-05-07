const DEFAULT_APP_SCHEME = 'happier';

const APP_SCHEME_BY_APP_ID = new Map<string, string>([
  ['dev.happier.app.internaldev', 'happier-internaldev'],
  ['dev.happier.app.internaldev.devclient', 'happier-internaldev-devclient'],
  ['dev.happier.app.dev.internal.devclient', 'happier-internaldev'],
  ['dev.happier.app.publicdev', 'happier-dev'],
  ['dev.happier.app.publicdev.devclient', 'happier-dev-devclient'],
]);

export function resolveMobileAppScheme(
  env: NodeJS.ProcessEnv,
  options?: Readonly<{ appId?: string | null }>,
): string {
  const configured = String(
    env.HAPPIER_E2E_MOBILE_APP_SCHEME ??
    env.EXPO_APP_SCHEME ??
    '',
  ).trim();

  if (configured) return configured;

  const appId = String(options?.appId ?? '').trim();
  const appIdScheme = APP_SCHEME_BY_APP_ID.get(appId);
  return appIdScheme || DEFAULT_APP_SCHEME;
}
