import { resolveUiWebSourceFingerprint } from './uiWebSourceFingerprint';

function buildUiWebExportEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const debug = String(env.EXPO_PUBLIC_DEBUG ?? '1').trim() || '1';
  return {
    ...process.env,
    ...env,
    CI: '1',
    NODE_ENV: 'production',
    EXPO_NO_TELEMETRY: '1',
    EXPO_PUBLIC_DEBUG: debug,
    EXPO_PUBLIC_POSTHOG_KEY: String(env.EXPO_PUBLIC_POSTHOG_KEY ?? 'phc-clear-export').trim() || 'phc-clear-export',
    EXPO_PUBLIC_HAPPIER_SERVER_URL: '',
    EXPO_PUBLIC_HAPPY_SERVER_URL: '',
    EXPO_PUBLIC_SERVER_URL: '',
    EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: '',
    EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON: '',
  };
}

export function buildUiWebExportCacheKey(env: NodeJS.ProcessEnv): string {
  const relevantEntries = Object.entries(buildUiWebExportEnv(env))
    .filter(([key]) =>
      key.startsWith('EXPO_PUBLIC_')
      || key === 'APP_ENV'
      || key === 'APP_VARIANT'
      || key === 'HAPPIER_APP_VARIANT_OVERRIDE'
      || key === 'EAS_BUILD_PROFILE'
      || key === 'EXPO_UPDATES_CHANNEL'
      || key === 'NODE_ENV'
    )
    .sort(([left], [right]) => left.localeCompare(right));

  relevantEntries.push(['__UI_WEB_SOURCE_FINGERPRINT__', resolveUiWebSourceFingerprint()]);

  return JSON.stringify(relevantEntries);
}
