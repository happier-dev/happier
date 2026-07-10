import {
  publishRuntimeIdentity,
  readNormalizedRuntimeDescriptor,
  resolveAgentIdFromSessionMetadata,
  resolveVendorResumeIdFromSessionMetadata,
} from '@happier-dev/agents';
import {
  ExternalSessionsSourceSchema,
  readLinkedExternalSessionV1FromMetadata,
  readRuntimeDescriptorV1FromMetadata,
  type RuntimeDescriptorV1,
  type ExternalSessionsSource,
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

function readExternalSessionRecord(metadataRecord: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(readLinkedExternalSessionV1FromMetadata(metadataRecord));
}

function readExternalSessionSource(externalSessionRecord: Record<string, unknown> | null): ExternalSessionsSource | null {
  if (!externalSessionRecord) return null;
  const parsed = ExternalSessionsSourceSchema.safeParse(externalSessionRecord.source);
  return parsed.success ? parsed.data : null;
}

function readExternalSessionRemoteSessionId(externalSessionRecord: Record<string, unknown> | null): string | null {
  if (!externalSessionRecord) return null;
  return normalizeString(externalSessionRecord.remoteSessionId);
}

function readExternalSessionAgentId(externalSessionRecord: Record<string, unknown> | null): string | null {
  if (!externalSessionRecord) return null;
  // legacy `providerId` external-link read-compat (pre-rename persisted metadata)
  return normalizeString(externalSessionRecord.agentId) ?? normalizeString(externalSessionRecord.providerId);
}

export type SessionRuntimeIdentitySourceTier =
  | 'canonical_runtime_descriptor'
  | 'legacy_session_metadata'
  | 'provider_defaults';

export type SessionRuntimeIdentityFallbackResult = Readonly<{
  providerId: string | null;
  providerSessionId: string | null;
  runtimeDescriptorV1: RuntimeDescriptorV1 | null;
  externalSessionSource: ExternalSessionsSource | null;
  externalSessionRemoteSessionId: string | null;
  runtimeIdentityPublication: ReturnType<typeof publishRuntimeIdentity>;
  sourceTier: SessionRuntimeIdentitySourceTier;
}>;

export function resolveSessionRuntimeIdentityFallback(params: Readonly<{
  metadata: unknown;
  providerDefaults?: Readonly<{
    agentId?: string | null;
    providerSessionId?: string | null;
    runtimeDescriptorV1?: RuntimeDescriptorV1 | null;
    externalSessionSource?: ExternalSessionsSource | null;
    externalSessionRemoteSessionId?: string | null;
  }>;
}>): SessionRuntimeIdentityFallbackResult {
  const metadataRecord = asRecord(params.metadata) ?? {};
  const externalSessionRecord = readExternalSessionRecord(metadataRecord);
  const descriptorFromExternalSession = readRuntimeDescriptorV1FromMetadata(externalSessionRecord);
  const descriptorFromMetadata = readRuntimeDescriptorV1FromMetadata(metadataRecord);
  const normalizedRuntimeDescriptor =
    readNormalizedRuntimeDescriptor(metadataRecord)
    ?? (descriptorFromExternalSession
      ? readNormalizedRuntimeDescriptor({ runtimeDescriptorV1: descriptorFromExternalSession })
      : null);
  const runtimeDescriptorV1 = descriptorFromExternalSession
    ?? descriptorFromMetadata
    ?? params.providerDefaults?.runtimeDescriptorV1
    ?? null;

  const providerIdFromLegacy = resolveAgentIdFromSessionMetadata(metadataRecord);
  const providerSessionIdFromLegacy = providerIdFromLegacy
    ? resolveVendorResumeIdFromSessionMetadata(providerIdFromLegacy, metadataRecord)
    : null;
  const externalSessionRemoteSessionId = readExternalSessionRemoteSessionId(externalSessionRecord)
    ?? params.providerDefaults?.externalSessionRemoteSessionId
    ?? null;
  const externalSessionSource = readExternalSessionSource(externalSessionRecord)
    ?? params.providerDefaults?.externalSessionSource
    ?? null;
  const externalSessionProviderId = readExternalSessionAgentId(externalSessionRecord);

  const providerId = normalizedRuntimeDescriptor?.providerId
    ?? normalizeString(descriptorFromExternalSession?.agentId)
    ?? normalizeString(descriptorFromMetadata?.agentId)
    ?? providerIdFromLegacy
    ?? externalSessionProviderId
    ?? normalizeString(params.providerDefaults?.agentId)
    ?? null;
  const providerSessionId = normalizedRuntimeDescriptor?.providerSessionId
    ?? providerSessionIdFromLegacy
    ?? externalSessionRemoteSessionId
    ?? normalizeString(params.providerDefaults?.providerSessionId)
    ?? null;

  const runtimeIdentityPublication = publishRuntimeIdentity({
    runtimeDescriptor: normalizedRuntimeDescriptor,
    compatibilitySources: normalizedRuntimeDescriptor ? ['runtimeDescriptorV1'] : ['legacy_provider_metadata'],
  });

  const hasLegacyIdentity =
    providerIdFromLegacy !== null
    || providerSessionIdFromLegacy !== null
    || readExternalSessionRemoteSessionId(externalSessionRecord) !== null
    || externalSessionProviderId !== null
    || readExternalSessionSource(externalSessionRecord) !== null
    || descriptorFromExternalSession !== null
    || descriptorFromMetadata !== null;

  const sourceTier: SessionRuntimeIdentitySourceTier = normalizedRuntimeDescriptor
    ? 'canonical_runtime_descriptor'
    : hasLegacyIdentity
      ? 'legacy_session_metadata'
      : 'provider_defaults';

  return {
    providerId,
    providerSessionId,
    runtimeDescriptorV1,
    externalSessionSource,
    externalSessionRemoteSessionId,
    runtimeIdentityPublication,
    sourceTier,
  };
}
