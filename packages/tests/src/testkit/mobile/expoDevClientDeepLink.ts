function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, '');
}

import { resolveMobileAppScheme } from './mobileAppScheme';

function resolveExpoDevClientScheme(env: NodeJS.ProcessEnv): string {
  return resolveMobileAppScheme(env);
}

export function resolveExpoDevClientDeepLink(params: Readonly<{
  env: NodeJS.ProcessEnv;
  metroUrl: string;
  scheme?: string;
}>): string {
  const metroUrl = stripTrailingSlash(String(params.metroUrl ?? '').trim());
  if (!metroUrl) return '';

  const scheme = String(params.scheme ?? '').trim() || resolveExpoDevClientScheme(params.env);
  if (!scheme) return '';

  return `${scheme}://expo-development-client/?url=${encodeURIComponent(metroUrl)}&disableOnboarding=1`;
}
