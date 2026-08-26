import {
  normalizeOpenCodeBackendMode,
  normalizeOpenCodeServerBaseUrl,
} from '../identity/runtimeDescriptor.js';
import type { OpenCodeBackendMode } from '../runtime/mode.js';

export type OpenCodeSessionRuntimePreferences = Readonly<{
  opencodeBackendMode?: OpenCodeBackendMode;
  opencodeServerBaseUrl?: string;
  opencodeServerBaseUrlExplicit?: boolean;
}>;

export function resolveOpenCodeSessionRuntimePreferences(params: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  environment: Readonly<Record<string, string | undefined>>;
}>): OpenCodeSessionRuntimePreferences {
  void params.environment;
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

export type { OpenCodeBackendMode };
