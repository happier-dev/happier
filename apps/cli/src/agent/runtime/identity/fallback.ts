import {
  publishRuntimeIdentity,
  readNormalizedRuntimeDescriptor,
  resolveAgentIdFromSessionMetadata,
  resolveVendorResumeIdFromSessionMetadata,
} from '@happier-dev/agents';
import {
  DirectSessionsSourceSchema,
  readRuntimeDescriptorV1FromMetadata,
  type RuntimeDescriptorV1,
  type DirectSessionsSource,
} from '@happier-dev/protocol';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readDirectSessionRecord(metadataRecord: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(metadataRecord.directSessionV1);
}

function readDirectSessionSource(directSessionRecord: Record<string, unknown> | null): DirectSessionsSource | null {
  if (!directSessionRecord) return null;
  const parsed = DirectSessionsSourceSchema.safeParse(directSessionRecord.source);
  return parsed.success ? parsed.data : null;
}

function readDirectSessionRemoteSessionId(directSessionRecord: Record<string, unknown> | null): string | null {
  if (!directSessionRecord) return null;
  return normalizeString(directSessionRecord.remoteSessionId);
}

function readDirectSessionProviderId(directSessionRecord: Record<string, unknown> | null): string | null {
  if (!directSessionRecord) return null;
  return normalizeString(directSessionRecord.providerId);
}

export type SessionRuntimeIdentitySourceTier =
  | 'canonical_runtime_descriptor'
  | 'legacy_session_metadata'
  | 'provider_defaults';

export type SessionRuntimeIdentityFallbackResult = Readonly<{
  providerId: string | null;
  vendorSessionId: string | null;
  runtimeDescriptorV1: RuntimeDescriptorV1 | null;
  directSessionSource: DirectSessionsSource | null;
  directSessionRemoteSessionId: string | null;
  runtimeIdentityPublication: ReturnType<typeof publishRuntimeIdentity>;
  sourceTier: SessionRuntimeIdentitySourceTier;
}>;

export function resolveSessionRuntimeIdentityFallback(params: Readonly<{
  metadata: unknown;
  providerDefaults?: Readonly<{
    providerId?: string | null;
    vendorSessionId?: string | null;
    runtimeDescriptorV1?: RuntimeDescriptorV1 | null;
    directSessionSource?: DirectSessionsSource | null;
    directSessionRemoteSessionId?: string | null;
  }>;
}>): SessionRuntimeIdentityFallbackResult {
  const metadataRecord = asRecord(params.metadata) ?? {};
  const directSessionRecord = readDirectSessionRecord(metadataRecord);
  const descriptorFromDirectSession = readRuntimeDescriptorV1FromMetadata(directSessionRecord);
  const descriptorFromMetadata = readRuntimeDescriptorV1FromMetadata(metadataRecord);
  const normalizedRuntimeDescriptor =
    readNormalizedRuntimeDescriptor(metadataRecord)
    ?? (descriptorFromDirectSession
      ? readNormalizedRuntimeDescriptor({ runtimeDescriptorV1: descriptorFromDirectSession })
      : null);
  const runtimeDescriptorV1 = descriptorFromDirectSession
    ?? descriptorFromMetadata
    ?? params.providerDefaults?.runtimeDescriptorV1
    ?? null;

  const providerIdFromLegacy = resolveAgentIdFromSessionMetadata(metadataRecord);
  const vendorSessionIdFromLegacy = providerIdFromLegacy
    ? resolveVendorResumeIdFromSessionMetadata(providerIdFromLegacy, metadataRecord)
    : null;
  const directSessionRemoteSessionId = readDirectSessionRemoteSessionId(directSessionRecord)
    ?? params.providerDefaults?.directSessionRemoteSessionId
    ?? null;
  const directSessionSource = readDirectSessionSource(directSessionRecord)
    ?? params.providerDefaults?.directSessionSource
    ?? null;
  const directSessionProviderId = readDirectSessionProviderId(directSessionRecord);

  const providerId = normalizedRuntimeDescriptor?.providerId
    ?? normalizeString(descriptorFromDirectSession?.providerId)
    ?? normalizeString(descriptorFromMetadata?.providerId)
    ?? providerIdFromLegacy
    ?? directSessionProviderId
    ?? normalizeString(params.providerDefaults?.providerId)
    ?? null;
  const vendorSessionId = normalizedRuntimeDescriptor?.vendorSessionId
    ?? vendorSessionIdFromLegacy
    ?? directSessionRemoteSessionId
    ?? normalizeString(params.providerDefaults?.vendorSessionId)
    ?? null;

  const runtimeIdentityPublication = publishRuntimeIdentity({
    runtimeDescriptor: normalizedRuntimeDescriptor,
    compatibilitySources: normalizedRuntimeDescriptor ? ['runtimeDescriptorV1'] : ['legacy_provider_metadata'],
  });

  const hasLegacyIdentity =
    providerIdFromLegacy !== null
    || vendorSessionIdFromLegacy !== null
    || readDirectSessionRemoteSessionId(directSessionRecord) !== null
    || directSessionProviderId !== null
    || readDirectSessionSource(directSessionRecord) !== null
    || descriptorFromDirectSession !== null
    || descriptorFromMetadata !== null;

  const sourceTier: SessionRuntimeIdentitySourceTier = normalizedRuntimeDescriptor
    ? 'canonical_runtime_descriptor'
    : hasLegacyIdentity
      ? 'legacy_session_metadata'
      : 'provider_defaults';

  return {
    providerId,
    vendorSessionId,
    runtimeDescriptorV1,
    directSessionSource,
    directSessionRemoteSessionId,
    runtimeIdentityPublication,
    sourceTier,
  };
}
