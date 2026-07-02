import { readCanonicalRuntimeDescriptorV1ForProvider } from '@happier-dev/protocol';

export type OpenCodeBackendMode = 'server' | 'acp';

export type CanonicalOpenCodeAgentRuntimeDescriptorV1 = Readonly<{
  providerId: 'opencode';
  backendMode: OpenCodeBackendMode;
  providerSessionId: string | null;
  serverBaseUrl: string | null;
  serverBaseUrlExplicit: boolean;
}>;

type RuntimeDescriptorEnvelopeV1 = Readonly<{
  v: 1;
  providerId: string;
  provider: Readonly<Record<string, unknown>>;
} & Record<string, unknown>>;

export type OpenCodeSessionAffinity = Readonly<{
  backendMode: OpenCodeBackendMode | null;
  serverBaseUrl: string | null;
  serverBaseUrlExplicit: boolean;
}>;

export type OpenCodeSessionRuntimeHandle = OpenCodeSessionAffinity & Readonly<{
  providerSessionId: string | null;
}>;

export type OpenCodeRuntimeDescriptor = CanonicalOpenCodeAgentRuntimeDescriptorV1 & Readonly<{
  runtimeKind: CanonicalOpenCodeAgentRuntimeDescriptorV1['backendMode'];
  runtimeHandle: Readonly<Record<string, unknown>> | null;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readRuntimeDescriptorV1(value: unknown): RuntimeDescriptorEnvelopeV1 | null {
  const descriptor = asRecord(value);
  if (!descriptor || descriptor.v !== 1 || typeof descriptor.providerId !== 'string' || !descriptor.providerId.trim()) {
    return null;
  }
  const provider = asRecord(descriptor.provider);
  if (!provider) return null;
  return {
    ...descriptor,
    v: 1,
    providerId: descriptor.providerId,
    provider,
  } as RuntimeDescriptorEnvelopeV1;
}

function readRuntimeDescriptorV1FromMetadata(metadata: unknown): RuntimeDescriptorEnvelopeV1 | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;
  return readRuntimeDescriptorV1(metadataRecord.runtimeDescriptorV1)
    ?? readRuntimeDescriptorV1(metadataRecord.agentRuntimeDescriptorV1);
}

function readRawRuntimeDescriptorV1FromMetadata(metadata: unknown): unknown {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;
  return metadataRecord.runtimeDescriptorV1 ?? metadataRecord.agentRuntimeDescriptorV1 ?? null;
}

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
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

function readCanonicalOpenCodeAgentRuntimeDescriptorV1(
  value: unknown,
): CanonicalOpenCodeAgentRuntimeDescriptorV1 | null {
  const descriptor = readCanonicalRuntimeDescriptorV1ForProvider(value, 'opencode');
  if (!descriptor) return null;
  const serverBaseUrl = normalizeOpenCodeServerBaseUrl(descriptor.serverBaseUrl);
  return {
    providerId: 'opencode',
    backendMode: normalizeOptionalOpenCodeBackendMode(descriptor.backendMode) ?? 'server',
    providerSessionId: normalizeTrimmedString(descriptor.providerSessionId),
    serverBaseUrl,
    serverBaseUrlExplicit: Boolean(serverBaseUrl && descriptor.serverBaseUrlExplicit === true),
  };
}

function readLegacyOpenCodeBackendMode(metadata: Readonly<Record<string, unknown>>): OpenCodeBackendMode | null {
  const backendModeRaw = normalizeTrimmedString(metadata.opencodeBackendMode);
  const backendMode = backendModeRaw?.toLowerCase();
  return backendMode === 'server' || backendMode === 'acp' ? backendMode : null;
}

function readLegacyOpenCodeProviderSessionId(metadata: Readonly<Record<string, unknown>>): string | null {
  return normalizeTrimmedString(metadata.opencodeSessionId);
}

function assignRuntimeHandleValue(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== null && value !== undefined) {
    target[key] = value;
  }
}

function buildOpenCodeRuntimeHandle(
  descriptor: CanonicalOpenCodeAgentRuntimeDescriptorV1,
): Readonly<Record<string, unknown>> | null {
  const runtimeHandle: Record<string, unknown> = {};
  assignRuntimeHandleValue(runtimeHandle, 'backendMode', descriptor.backendMode);
  assignRuntimeHandleValue(runtimeHandle, 'providerSessionId', descriptor.providerSessionId);
  assignRuntimeHandleValue(runtimeHandle, 'serverBaseUrl', descriptor.serverBaseUrl);
  if (descriptor.serverBaseUrlExplicit) {
    runtimeHandle.serverBaseUrlExplicit = true;
  }
  return Object.keys(runtimeHandle).length > 0 ? runtimeHandle : null;
}

function toOpenCodeRuntimeDescriptor(
  descriptor: CanonicalOpenCodeAgentRuntimeDescriptorV1,
): OpenCodeRuntimeDescriptor {
  return {
    ...descriptor,
    runtimeKind: descriptor.backendMode,
    runtimeHandle: buildOpenCodeRuntimeHandle(descriptor),
  };
}

function readLegacyOpenCodeRuntimeDescriptor(
  metadata: Readonly<Record<string, unknown>>,
): OpenCodeRuntimeDescriptor | null {
  const backendMode = readLegacyOpenCodeBackendMode(metadata);
  const providerSessionId = readLegacyOpenCodeProviderSessionId(metadata);
  const requestedServerBaseUrlExplicit = normalizeOpenCodeServerBaseUrlExplicit(metadata.opencodeServerBaseUrlExplicit);
  const serverBaseUrl = requestedServerBaseUrlExplicit
    ? normalizeOpenCodeServerBaseUrl(metadata.opencodeServerBaseUrl)
    : null;
  const serverBaseUrlExplicit = requestedServerBaseUrlExplicit && !!serverBaseUrl;

  if (!backendMode && !providerSessionId && !serverBaseUrl && !serverBaseUrlExplicit) return null;
  return toOpenCodeRuntimeDescriptor({
    providerId: 'opencode',
    backendMode: backendMode ?? 'server',
    providerSessionId,
    serverBaseUrl,
    serverBaseUrlExplicit,
  });
}

export function readOpenCodeSessionMetadataRuntimeDescriptor(
  metadata: unknown,
): OpenCodeRuntimeDescriptor | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;
  const rawDescriptorInput = readRawRuntimeDescriptorV1FromMetadata(metadataRecord);
  const descriptor = readCanonicalOpenCodeAgentRuntimeDescriptorV1(
    readRuntimeDescriptorV1FromMetadata(metadataRecord) ?? rawDescriptorInput,
  );
  const legacyDescriptor = readLegacyOpenCodeRuntimeDescriptor(metadataRecord);
  if (!descriptor) return legacyDescriptor;
  const serverBaseUrl = descriptor.serverBaseUrl ?? legacyDescriptor?.serverBaseUrl ?? null;
  return toOpenCodeRuntimeDescriptor({
    providerId: 'opencode',
    backendMode: descriptor.backendMode ?? legacyDescriptor?.backendMode ?? 'server',
    providerSessionId: descriptor.providerSessionId ?? legacyDescriptor?.providerSessionId ?? null,
    serverBaseUrl,
    serverBaseUrlExplicit: Boolean(serverBaseUrl && (descriptor.serverBaseUrlExplicit || legacyDescriptor?.serverBaseUrlExplicit === true)),
  });
}

export function readOpenCodeSessionAffinityFromMetadata(metadata: unknown): OpenCodeSessionAffinity {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) {
    return {
      backendMode: null,
      serverBaseUrl: null,
      serverBaseUrlExplicit: false,
    };
  }

  const runtimeDescriptor = readOpenCodeSessionMetadataRuntimeDescriptor(metadataRecord);
  const legacyServerBaseUrl = normalizeOpenCodeServerBaseUrlExplicit(metadataRecord.opencodeServerBaseUrlExplicit)
    ? normalizeOpenCodeServerBaseUrl(metadataRecord.opencodeServerBaseUrl)
    : null;
  const serverBaseUrl = runtimeDescriptor?.serverBaseUrl ?? legacyServerBaseUrl;
  return {
    backendMode: runtimeDescriptor?.backendMode ?? readLegacyOpenCodeBackendMode(metadataRecord),
    serverBaseUrl,
    serverBaseUrlExplicit: Boolean(serverBaseUrl && (runtimeDescriptor?.serverBaseUrlExplicit ?? Boolean(legacyServerBaseUrl))),
  };
}

export function readOpenCodeSessionRuntimeHandleFromMetadata(metadata: unknown): OpenCodeSessionRuntimeHandle {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) {
    return {
      backendMode: null,
      serverBaseUrl: null,
      serverBaseUrlExplicit: false,
      providerSessionId: null,
    };
  }

  const runtimeDescriptor = readOpenCodeSessionMetadataRuntimeDescriptor(metadataRecord);
  return {
    ...readOpenCodeSessionAffinityFromMetadata(metadataRecord),
    providerSessionId: runtimeDescriptor?.providerSessionId ?? readLegacyOpenCodeProviderSessionId(metadataRecord),
  };
}
