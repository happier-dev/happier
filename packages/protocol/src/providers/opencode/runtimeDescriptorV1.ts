import { normalizeOpenCodeBackendMode } from './backendMode.js';

type OpenCodeRuntimeDescriptorProviderExtra = Readonly<{
  owner: 'opencode';
  schemaId: 'opencode.agentRuntimeDescriptorExtra';
  v: 1;
  runtimeHandle?: Readonly<{
    backendMode?: 'server' | 'acp';
    vendorSessionId?: string;
    serverBaseUrl?: string;
    serverBaseUrlExplicit?: true;
  }>;
}>;

type OpenCodeAgentRuntimeDescriptorProvider = Readonly<{
  backendMode: 'server' | 'acp';
  vendorSessionId?: string;
  serverBaseUrl?: string;
  serverBaseUrlExplicit?: true;
  providerExtra?: OpenCodeRuntimeDescriptorProviderExtra;
}>;

export type OpenCodeAgentRuntimeDescriptorV1 = Readonly<{
  v: 1;
  providerId: 'opencode';
  provider: OpenCodeAgentRuntimeDescriptorProvider;
} & Record<string, unknown>>;

export type CanonicalOpenCodeAgentRuntimeDescriptorV1 = Readonly<{
  providerId: 'opencode';
  backendMode: 'server' | 'acp' | null;
  vendorSessionId: string | null;
  serverBaseUrl: string | null;
  serverBaseUrlExplicit: boolean;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeOpenCodeServerBaseUrlExplicit(value: unknown): boolean {
  return value === true;
}

function readCanonicalOpenCodeProviderExtra(value: unknown) {
  const extra = asRecord(value);
  if (!extra || extra.v !== 1) return null;

  const runtimeHandle = asRecord(extra.runtimeHandle);
  if (!runtimeHandle) return null;

  return {
    backendMode: normalizeOpenCodeBackendMode(runtimeHandle.backendMode),
    vendorSessionId: normalizeTrimmedString(runtimeHandle.vendorSessionId),
    serverBaseUrl: normalizeTrimmedString(runtimeHandle.serverBaseUrl),
    serverBaseUrlExplicit: normalizeOpenCodeServerBaseUrlExplicit(runtimeHandle.serverBaseUrlExplicit),
  };
}

export function buildOpenCodeAgentRuntimeDescriptorV1(params: Readonly<{
  backendMode: 'server' | 'acp';
  vendorSessionId?: string | null;
  serverBaseUrl?: string | null;
  serverBaseUrlExplicit?: boolean;
}>): OpenCodeAgentRuntimeDescriptorV1 {
  return {
    v: 1,
    providerId: 'opencode',
    provider: {
      backendMode: params.backendMode,
      ...(params.vendorSessionId ? { vendorSessionId: params.vendorSessionId } : {}),
      ...(params.serverBaseUrl ? { serverBaseUrl: params.serverBaseUrl } : {}),
      ...(params.serverBaseUrlExplicit ? { serverBaseUrlExplicit: true } : {}),
      providerExtra: {
        owner: 'opencode',
        schemaId: 'opencode.agentRuntimeDescriptorExtra',
        v: 1,
        runtimeHandle: {
          backendMode: params.backendMode,
          ...(params.vendorSessionId ? { vendorSessionId: params.vendorSessionId } : {}),
          ...(params.serverBaseUrl ? { serverBaseUrl: params.serverBaseUrl } : {}),
          ...(params.serverBaseUrlExplicit ? { serverBaseUrlExplicit: true } : {}),
        },
      },
    },
  };
}

export function readCanonicalOpenCodeAgentRuntimeDescriptorV1(
  descriptor: OpenCodeAgentRuntimeDescriptorV1 | null,
): CanonicalOpenCodeAgentRuntimeDescriptorV1 | null {
  if (!descriptor) return null;
  const providerExtra = readCanonicalOpenCodeProviderExtra(descriptor.provider.providerExtra);
  return {
    providerId: 'opencode',
    backendMode: providerExtra?.backendMode ?? normalizeOpenCodeBackendMode(descriptor.provider.backendMode),
    vendorSessionId: providerExtra?.vendorSessionId ?? normalizeTrimmedString(descriptor.provider.vendorSessionId),
    serverBaseUrl: providerExtra?.serverBaseUrl ?? normalizeTrimmedString(descriptor.provider.serverBaseUrl),
    serverBaseUrlExplicit: providerExtra?.serverBaseUrlExplicit
      ?? normalizeOpenCodeServerBaseUrlExplicit(descriptor.provider.serverBaseUrlExplicit),
  };
}
