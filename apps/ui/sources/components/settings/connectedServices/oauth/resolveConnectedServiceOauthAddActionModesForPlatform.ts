import type { ConnectedServiceOauthAddMethod } from './resolveConnectedServiceOauthMode';

function normalizePlatformOS(platformOS: unknown): string {
  return typeof platformOS === 'string' ? platformOS.trim().toLowerCase() : '';
}

export function resolveConnectedServiceOauthAddActionModesForPlatform(params: Readonly<{
  platformOS: string;
  oauthAddActionModes?: ReadonlyArray<ConnectedServiceOauthAddMethod>;
}>): ReadonlyArray<ConnectedServiceOauthAddMethod> {
  const platformOS = normalizePlatformOS(params.platformOS);
  const modes = (params.oauthAddActionModes ?? []).slice();

  // Web cannot render embedded OAuthView (WebView), so hide the "browser" method.
  if (platformOS === 'web') return modes.filter((m) => m !== 'browser');
  return modes;
}
