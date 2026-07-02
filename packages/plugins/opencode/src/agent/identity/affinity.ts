import {
  readOpenCodeSessionAffinityFromMetadata,
  type OpenCodeSessionAffinity,
} from './runtimeDescriptor.js';

import { writeOpenCodeProviderSessionIdMetadata } from './session.js';

type OpenCodeBackendMode = OpenCodeSessionAffinity['backendMode'];

export { readOpenCodeSessionAffinityFromMetadata };
export type { OpenCodeSessionAffinity };

export function buildOpenCodeSessionEnvironmentVariables(params: Readonly<{
  backendMode: OpenCodeBackendMode | null;
  serverBaseUrl?: string | null;
  serverBaseUrlExplicit?: boolean;
}>): Record<string, string> {
  return {
    ...(params.backendMode ? { HAPPIER_OPENCODE_BACKEND_MODE: params.backendMode } : {}),
    ...(params.serverBaseUrl ? { HAPPIER_OPENCODE_SERVER_URL: params.serverBaseUrl } : {}),
    ...(params.serverBaseUrl && params.serverBaseUrlExplicit ? { HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1' } : {}),
  };
}

export function applyOpenCodeSessionAffinityMetadata(params: Readonly<{
  backendMode: OpenCodeBackendMode | null;
  providerSessionId?: string | null;
  serverBaseUrl?: string | null;
  serverBaseUrlExplicit?: boolean;
}>): Readonly<Record<string, unknown>> {
  const nextServerBaseUrl = params.serverBaseUrlExplicit ? params.serverBaseUrl : null;

  return {
    ...writeOpenCodeProviderSessionIdMetadata(params.providerSessionId),
    ...(params.backendMode ? { opencodeBackendMode: params.backendMode } : {}),
    ...(nextServerBaseUrl ? { opencodeServerBaseUrl: nextServerBaseUrl } : {}),
    ...(nextServerBaseUrl ? { opencodeServerBaseUrlExplicit: true } : {}),
  };
}
