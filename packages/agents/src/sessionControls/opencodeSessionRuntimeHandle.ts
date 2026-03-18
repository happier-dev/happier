import {
  normalizeOpenCodeServerBaseUrlExplicit,
  readOpenCodeExplicitServerBaseUrl,
  type OpenCodeBackendMode,
} from '../providerSettings/definitions/opencode.js';
import { readSessionMetadataRuntimeDescriptor } from './agentRuntimeDescriptor.js';

export type OpenCodeSessionAffinity = Readonly<{
  backendMode: OpenCodeBackendMode | null;
  serverBaseUrl: string | null;
  serverBaseUrlExplicit: boolean;
}>;

export type OpenCodeSessionRuntimeHandle = OpenCodeSessionAffinity & Readonly<{
  vendorSessionId: string | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readLegacyOpenCodeBackendMode(metadata: Record<string, unknown>): OpenCodeBackendMode | null {
  const backendModeRaw = typeof metadata.opencodeBackendMode === 'string'
    ? String(metadata.opencodeBackendMode).trim()
    : '';
  return backendModeRaw === 'server' ? 'server' : backendModeRaw === 'acp' ? 'acp' : null;
}

function readLegacyOpenCodeVendorSessionId(metadata: Record<string, unknown>): string | null {
  const vendorSessionId = typeof metadata.opencodeSessionId === 'string'
    ? metadata.opencodeSessionId.trim()
    : '';
  return vendorSessionId || null;
}

export function readOpenCodeSessionAffinityFromMetadata(metadata: unknown): OpenCodeSessionAffinity {
  if (!isRecord(metadata)) {
    return {
      backendMode: null,
      serverBaseUrl: null,
      serverBaseUrlExplicit: false,
    };
  }

  const runtimeDescriptor = readSessionMetadataRuntimeDescriptor(metadata, 'opencode');
  return {
    backendMode: runtimeDescriptor?.backendMode ?? readLegacyOpenCodeBackendMode(metadata),
    serverBaseUrl: runtimeDescriptor?.serverBaseUrl ?? readOpenCodeExplicitServerBaseUrl(
      metadata.opencodeServerBaseUrl,
      metadata.opencodeServerBaseUrlExplicit,
    ),
    serverBaseUrlExplicit: runtimeDescriptor?.serverBaseUrlExplicit ?? normalizeOpenCodeServerBaseUrlExplicit(metadata.opencodeServerBaseUrlExplicit),
  };
}

export function readOpenCodeSessionRuntimeHandleFromMetadata(metadata: unknown): OpenCodeSessionRuntimeHandle {
  if (!isRecord(metadata)) {
    return {
      backendMode: null,
      serverBaseUrl: null,
      serverBaseUrlExplicit: false,
      vendorSessionId: null,
    };
  }

  const runtimeDescriptor = readSessionMetadataRuntimeDescriptor(metadata, 'opencode');
  return {
    ...readOpenCodeSessionAffinityFromMetadata(metadata),
    vendorSessionId: runtimeDescriptor?.vendorSessionId ?? readLegacyOpenCodeVendorSessionId(metadata),
  };
}
