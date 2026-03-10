import type { Metadata } from '@/api/types';
import {
  normalizeOpenCodeServerBaseUrlExplicit,
  readOpenCodeExplicitServerBaseUrl,
} from '@happier-dev/agents';

type OpenCodeBackendMode = 'server' | 'acp';

export type OpenCodeSessionAffinity = Readonly<{
  backendMode: OpenCodeBackendMode | null;
  serverBaseUrl: string | null;
  serverBaseUrlExplicit: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readOpenCodeSessionAffinityFromMetadata(metadata: unknown): OpenCodeSessionAffinity {
  if (!isRecord(metadata)) {
    return {
      backendMode: null,
      serverBaseUrl: null,
      serverBaseUrlExplicit: false,
    };
  }

  const backendModeRaw = typeof metadata.opencodeBackendMode === 'string'
    ? String(metadata.opencodeBackendMode).trim()
    : '';
  const backendMode = backendModeRaw === 'server' ? 'server' : backendModeRaw === 'acp' ? 'acp' : null;
  const serverBaseUrlExplicit = normalizeOpenCodeServerBaseUrlExplicit(metadata.opencodeServerBaseUrlExplicit);
  const serverBaseUrl = readOpenCodeExplicitServerBaseUrl(
    metadata.opencodeServerBaseUrl,
    metadata.opencodeServerBaseUrlExplicit,
  );

  return {
    backendMode,
    serverBaseUrl,
    serverBaseUrlExplicit,
  };
}

export function buildOpenCodeSessionEnvironmentVariables(params: Readonly<{
  backendMode: OpenCodeBackendMode | null;
  serverBaseUrl?: string | null;
}>): Record<string, string> {
  return {
    ...(params.backendMode ? { HAPPIER_OPENCODE_BACKEND_MODE: params.backendMode } : {}),
    ...(params.serverBaseUrl ? { HAPPIER_OPENCODE_SERVER_URL: params.serverBaseUrl } : {}),
    ...(params.serverBaseUrl ? { HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1' } : {}),
  };
}

export function applyOpenCodeSessionAffinityMetadata(
  params: Readonly<{
    backendMode: OpenCodeBackendMode | null;
    vendorSessionId?: string | null;
    serverBaseUrl?: string | null;
    serverBaseUrlExplicit?: boolean;
  }>,
): Partial<Metadata> {
  const nextVendorSessionId = typeof params.vendorSessionId === 'string' ? params.vendorSessionId.trim() : '';
  const nextServerBaseUrl = params.serverBaseUrlExplicit ? params.serverBaseUrl : null;

  return {
    ...(nextVendorSessionId ? { opencodeSessionId: nextVendorSessionId } : {}),
    ...(params.backendMode ? { opencodeBackendMode: params.backendMode } : {}),
    ...(nextServerBaseUrl ? { opencodeServerBaseUrl: nextServerBaseUrl } : {}),
    ...(nextServerBaseUrl ? { opencodeServerBaseUrlExplicit: true } : {}),
  };
}
