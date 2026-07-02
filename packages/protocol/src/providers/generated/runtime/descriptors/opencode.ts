/**
 * GENERATED FILE CONTRACT (A.16y.6-runtime-descriptor-protocol-abi-codegen)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

export type OpenCodeBackendMode = 'server' | 'acp';

type RuntimeDescriptorProviderExtra = Readonly<{
  owner: 'opencode';
  schemaId: 'opencode.agentRuntimeDescriptorExtra';
  v: 1;
  runtimeHandle?: Readonly<{
    backendMode?: OpenCodeBackendMode;
    providerSessionId?: string;
    serverBaseUrl?: string;
    serverBaseUrlExplicit?: true;
  }>;
}>;

export type OpenCodeAgentRuntimeDescriptorV1 = Readonly<{
  v: 1;
  providerId: 'opencode';
  provider: Readonly<{
    backendMode: OpenCodeBackendMode;
    providerSessionId?: string;
    serverBaseUrl?: string;
    serverBaseUrlExplicit?: true;
    providerExtra: RuntimeDescriptorProviderExtra;
  }>;
} & Record<string, unknown>>;

export type CanonicalOpenCodeAgentRuntimeDescriptorV1 = Readonly<{
  providerId: 'opencode';
  backendMode: OpenCodeBackendMode;
  providerSessionId: string | null;
  serverBaseUrl: string | null;
  serverBaseUrlExplicit: boolean;
}>;

export type BuildOpenCodeAgentRuntimeDescriptorParams = Readonly<{
  backendMode?: OpenCodeBackendMode | null;
  providerSessionId?: string | null;
  serverBaseUrl?: string | null;
  serverBaseUrlExplicit?: boolean | string | null;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readProviderSessionIdCompat(record: Readonly<Record<string, unknown>>): string | null {
  return normalizeTrimmedString(record.providerSessionId)
    ?? normalizeTrimmedString(record.vendorSessionId);
}

export function normalizeOpenCodeBackendMode(raw: unknown): OpenCodeBackendMode {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value === 'acp' ? 'acp' : 'server';
}

function normalizeOptionalOpenCodeBackendMode(raw: unknown): OpenCodeBackendMode | null {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'acp' || value === 'server') return value;
  return null;
}

export function normalizeOpenCodeServerBaseUrl(raw: unknown): string | null {
  const value = normalizeTrimmedString(raw);
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol === 'http:') {
      const hostname = parsed.hostname.trim().toLowerCase();
      const isLoopback =
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === '[::1]';
      if (!isLoopback) return null;
    }
    return parsed.origin.endsWith('/') ? parsed.origin : `${parsed.origin}/`;
  } catch {
    return null;
  }
}

export function normalizeOpenCodeServerBaseUrlExplicit(raw: unknown): boolean {
  if (raw === true) return true;
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value === '1' || value === 'true' || value === 'yes';
}

function buildOpenCodeRuntimeDescriptorProviderExtra(params: BuildOpenCodeAgentRuntimeDescriptorParams): RuntimeDescriptorProviderExtra {
  const backendMode = normalizeOpenCodeBackendMode(params.backendMode);
  const providerSessionId = normalizeTrimmedString(params.providerSessionId);
  const requestedServerBaseUrlExplicit = normalizeOpenCodeServerBaseUrlExplicit(params.serverBaseUrlExplicit);
  const serverBaseUrl = requestedServerBaseUrlExplicit ? normalizeOpenCodeServerBaseUrl(params.serverBaseUrl) : null;
  const serverBaseUrlExplicit = Boolean(serverBaseUrl && requestedServerBaseUrlExplicit);

  return {
    owner: 'opencode',
    schemaId: 'opencode.agentRuntimeDescriptorExtra',
    v: 1,
    runtimeHandle: {
      backendMode,
      ...(providerSessionId ? { providerSessionId } : {}),
      ...(serverBaseUrl ? { serverBaseUrl } : {}),
      ...(serverBaseUrlExplicit ? { serverBaseUrlExplicit: true } : {}),
    },
  };
}

function readOpenCodeRuntimeDescriptorProviderExtra(value: unknown): CanonicalOpenCodeAgentRuntimeDescriptorV1 | null {
  const extra = asRecord(value);
  if (!extra || extra.owner !== 'opencode' || extra.schemaId !== 'opencode.agentRuntimeDescriptorExtra' || extra.v !== 1) {
    return null;
  }

  const runtimeHandle = asRecord(extra.runtimeHandle);
  if (!runtimeHandle) return null;

  const backendMode = normalizeOptionalOpenCodeBackendMode(runtimeHandle.backendMode);
  const providerSessionId = readProviderSessionIdCompat(runtimeHandle);
  const serverBaseUrl = normalizeOpenCodeServerBaseUrl(runtimeHandle.serverBaseUrl);
  const serverBaseUrlExplicit = serverBaseUrl
    ? normalizeOpenCodeServerBaseUrlExplicit(runtimeHandle.serverBaseUrlExplicit)
    : false;

  if (!backendMode && !providerSessionId && !serverBaseUrl) return null;
  return {
    providerId: 'opencode',
    backendMode: backendMode ?? 'server',
    providerSessionId,
    serverBaseUrl,
    serverBaseUrlExplicit,
  };
}

function readOpenCodeRuntimeDescriptorV1(value: unknown): OpenCodeAgentRuntimeDescriptorV1 | null {
  const descriptor = asRecord(value);
  if (!descriptor || descriptor.v !== 1 || descriptor.providerId !== 'opencode') return null;
  const provider = asRecord(descriptor.provider);
  if (!provider) return null;
  return {
    ...descriptor,
    v: 1,
    providerId: 'opencode',
    provider,
  } as OpenCodeAgentRuntimeDescriptorV1;
}

export function buildOpenCodeAgentRuntimeDescriptorV1(
  params: BuildOpenCodeAgentRuntimeDescriptorParams,
): OpenCodeAgentRuntimeDescriptorV1 {
  const backendMode = normalizeOpenCodeBackendMode(params.backendMode);
  const providerSessionId = normalizeTrimmedString(params.providerSessionId);
  const requestedServerBaseUrlExplicit = normalizeOpenCodeServerBaseUrlExplicit(params.serverBaseUrlExplicit);
  const serverBaseUrl = requestedServerBaseUrlExplicit ? normalizeOpenCodeServerBaseUrl(params.serverBaseUrl) : null;
  const serverBaseUrlExplicit = Boolean(serverBaseUrl && requestedServerBaseUrlExplicit);

  return {
    v: 1,
    providerId: 'opencode',
    provider: {
      backendMode,
      ...(providerSessionId ? { providerSessionId } : {}),
      ...(serverBaseUrl ? { serverBaseUrl } : {}),
      ...(serverBaseUrlExplicit ? { serverBaseUrlExplicit: true } : {}),
      providerExtra: buildOpenCodeRuntimeDescriptorProviderExtra({
        backendMode,
        providerSessionId,
        serverBaseUrl,
        serverBaseUrlExplicit,
      }),
    },
  };
}

export const buildOpenCodeAgentRuntimeDescriptor = buildOpenCodeAgentRuntimeDescriptorV1;
export const buildOpenCodeRuntimeIdentityDescriptorV1 = buildOpenCodeAgentRuntimeDescriptorV1;

export function readCanonicalOpenCodeAgentRuntimeDescriptorV1(
  value: unknown,
): CanonicalOpenCodeAgentRuntimeDescriptorV1 | null {
  const descriptor = readOpenCodeRuntimeDescriptorV1(value);
  if (!descriptor) return null;
  const provider = descriptor.provider;

  const providerExtra = readOpenCodeRuntimeDescriptorProviderExtra(provider.providerExtra);
  const backendMode = providerExtra?.backendMode ?? normalizeOptionalOpenCodeBackendMode(provider.backendMode) ?? 'server';
  const providerSessionId = providerExtra?.providerSessionId ?? readProviderSessionIdCompat(provider);
  const providerServerBaseUrl = normalizeOpenCodeServerBaseUrl(provider.serverBaseUrl);
  const providerServerBaseUrlExplicit = providerServerBaseUrl
    ? normalizeOpenCodeServerBaseUrlExplicit(provider.serverBaseUrlExplicit)
    : false;
  const serverBaseUrl = providerExtra?.serverBaseUrl ?? providerServerBaseUrl;
  const serverBaseUrlExplicit = serverBaseUrl
    ? (providerExtra?.serverBaseUrl ? providerExtra.serverBaseUrlExplicit : providerServerBaseUrlExplicit)
    : false;

  return {
    providerId: 'opencode',
    backendMode,
    providerSessionId,
    serverBaseUrl,
    serverBaseUrlExplicit,
  };
}
