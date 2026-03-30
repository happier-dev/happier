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
}>): string {
  const metroUrl = stripTrailingSlash(String(params.metroUrl ?? '').trim());
  if (!metroUrl) return '';

  const scheme = resolveExpoDevClientScheme(params.env);
  if (!scheme) return '';

  return `${scheme}://expo-development-client/?url=${encodeURIComponent(metroUrl)}&disableOnboarding=1`;
}
