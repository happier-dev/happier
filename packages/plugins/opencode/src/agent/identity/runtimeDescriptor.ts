import {
  normalizeOpenCodeServerBaseUrl,
  normalizeOpenCodeServerBaseUrlExplicit,
  readCanonicalOpenCodeAgentRuntimeDescriptorV1,
  type CanonicalOpenCodeAgentRuntimeDescriptorV1,
  type OpenCodeBackendMode,
} from '../../protocol/runtimeDescriptorV1.js';

export {
  buildOpenCodeAgentRuntimeDescriptor,
  buildOpenCodeAgentRuntimeDescriptorV1,
  buildOpenCodeRuntimeIdentityDescriptorV1,
  normalizeOpenCodeBackendMode,
  normalizeOpenCodeServerBaseUrl,
  normalizeOpenCodeServerBaseUrlExplicit,
  readCanonicalOpenCodeAgentRuntimeDescriptorV1,
} from '../../protocol/runtimeDescriptorV1.js';

export type {
  BuildOpenCodeAgentRuntimeDescriptorParams,
  CanonicalOpenCodeAgentRuntimeDescriptorV1,
  OpenCodeAgentRuntimeDescriptorV1,
} from '../../protocol/runtimeDescriptorV1.js';

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

function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
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

function readCanonicalOpenCodeRuntimeDescriptor(
  metadata: Readonly<Record<string, unknown>>,
): OpenCodeRuntimeDescriptor | null {
  const canonical = metadata.runtimeDescriptorV1
    ? readCanonicalOpenCodeAgentRuntimeDescriptorV1(metadata.runtimeDescriptorV1)
    : null;
  return canonical ? toOpenCodeRuntimeDescriptor(canonical) : null;
}

/**
 * Persisted-session ingress for the `remote-dev` predecessor
 * `ec4d3a29defa7fb094f4eb92909ddc74f172461b`, which still writes these flat
 * OpenCode fields. Current host surface writers carry `runtimeDescriptorV1`.
 * Remove this adapter when the supported released predecessor no longer
 * produces the flat shape.
 */
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
    agentId: 'opencode',
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
  return readCanonicalOpenCodeRuntimeDescriptor(metadataRecord)
    ?? readLegacyOpenCodeRuntimeDescriptor(metadataRecord);
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
