import {
  normalizeOpenCodeBackendMode,
  normalizeOpenCodeServerBaseUrl,
  type OpenCodeBackendMode,
} from '../../providerSettings/index.js';

export function resolveOpenCodeSessionRuntimePreferences(params: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  processEnv: NodeJS.ProcessEnv;
}>): Readonly<{
  opencodeBackendMode?: OpenCodeBackendMode;
  opencodeServerBaseUrl?: string;
  opencodeServerBaseUrlExplicit?: boolean;
}> {
  void params.processEnv;
  const backendMode = normalizeOpenCodeBackendMode(params.settings.opencodeBackendMode);
  const settingsServerBaseUrl = normalizeOpenCodeServerBaseUrl(params.settings.opencodeServerBaseUrl);

  return {
    opencodeBackendMode: backendMode,
    ...(settingsServerBaseUrl
      ? {
          opencodeServerBaseUrl: settingsServerBaseUrl,
          opencodeServerBaseUrlExplicit: true,
        }
      : {
          opencodeServerBaseUrlExplicit: false,
        }),
  };
}
