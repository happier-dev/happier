import {
  readNonAuthoritativeLinkedExternalSessionV1FromMetadata,
  readRuntimeDescriptorV1FromMetadata,
} from '@happier-dev/protocol';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readAgentIdFromMetadataEntry(metadata: Record<string, unknown>, key: string): string | null {
  const entry = metadata[key];
  if (!isRecord(entry)) return null;
  // legacy `provider` state-record read-compat (pre-rename persisted metadata)
  const agentId = entry.agentId ?? entry.provider;
  return typeof agentId === 'string' ? agentId : null;
}

function readCurrentRuntimeDescriptorAgentId(metadata: Record<string, unknown>): string | null {
  const descriptor = readRuntimeDescriptorV1FromMetadata(metadata);
  return descriptor?.agentId ?? null;
}

function hasPublishedAcpForkProtocol(metadata: Record<string, unknown>): boolean {
  const capabilities = isRecord(metadata.agentRuntimeCapabilitiesV1)
    ? metadata.agentRuntimeCapabilitiesV1
    : null;
  const sessionCapabilities = capabilities && isRecord(capabilities.sessionCapabilities)
    ? capabilities.sessionCapabilities
    : null;
  const sessionFork = sessionCapabilities && isRecord(sessionCapabilities.sessionFork)
    ? sessionCapabilities.sessionFork
    : null;
  return sessionFork?.protocol === 'acp';
}

type BackendModeEligibility = 'acp' | 'non_acp';

function normalizeRuntimeBackendModeForAcpEligibility(value: unknown): BackendModeEligibility | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === 'acp') return 'acp';
  if (trimmed === 'appServer' || trimmed === 'mcp') return 'non_acp';
  return null;
}

function readBackendModeEligibility(value: unknown): boolean | null {
  const backendMode = normalizeRuntimeBackendModeForAcpEligibility(value);
  if (!backendMode) return null;
  return backendMode === 'acp';
}

function readAgentKeyedBackendModeEligibility(
  metadata: Record<string, unknown>,
  agentId: string,
): boolean | null {
  return readBackendModeEligibility(metadata[`${agentId}BackendMode`]);
}

/**
 * Released CLI writers persisted the runtime selector as an agent-keyed key
 * directly on the linked-session envelope. The protocol link reader is the
 * sole owner that admits those rows, so only a valid released envelope may
 * expose that exact compatibility key here. The link's embedded runtime
 * descriptor stays provider-owned and opaque.
 */
function readReleasedLinkedSessionRuntimeModeEligibility(
  metadata: Record<string, unknown>,
  link: NonNullable<ReturnType<typeof readNonAuthoritativeLinkedExternalSessionV1FromMetadata>>,
  agentId: string,
): boolean | null {
  const envelope = isRecord(metadata.externalSessionV1)
    ? metadata.externalSessionV1
    : isRecord(metadata.directSessionV1)
      ? metadata.directSessionV1
      : null;
  if (!envelope || !Object.hasOwn(envelope, `${agentId}BackendMode`)) return null;
  if (link.agentId !== agentId) return null;
  return readBackendModeEligibility(envelope[`${agentId}BackendMode`]);
}

function resolveLegacyRuntimeBackendModeEligibility(metadata: Record<string, unknown>, agentId: string): boolean | null {
  const legacyRuntimeDescriptorRaw = metadata[`${agentId}RuntimeDescriptorV1`];
  const legacyRuntimeDescriptor = isRecord(legacyRuntimeDescriptorRaw)
    ? legacyRuntimeDescriptorRaw
    : null;
  if (legacyRuntimeDescriptor?.v === 1) {
    const descriptorEligibility = readBackendModeEligibility(legacyRuntimeDescriptor.backendMode);
    if (descriptorEligibility !== null) return descriptorEligibility;
  }

  const affinityEligibility = readBackendModeEligibility(
    isRecord(metadata.affinity) ? metadata.affinity.backendMode : null,
  );
  if (affinityEligibility !== null) return affinityEligibility;

  const topLevelEligibility = readAgentKeyedBackendModeEligibility(metadata, agentId);
  if (topLevelEligibility !== null) return topLevelEligibility;

  const externalSessionLink = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(metadata);
  if (externalSessionLink?.agentId === agentId) {
    const externalSessionEligibility = readAgentKeyedBackendModeEligibility(externalSessionLink, agentId)
      ?? readReleasedLinkedSessionRuntimeModeEligibility(metadata, externalSessionLink, agentId);
    if (externalSessionEligibility !== null) return externalSessionEligibility;
  }

  return null;
}

export function isAcpForkEligibleForAgent(params: Readonly<{ agentId: string; metadata: unknown }>): boolean {
  const agentId = params.agentId.trim();
  if (!agentId) return false;

  if (!isRecord(params.metadata)) return false;
  const metadata = params.metadata;

  const descriptorAgentId = readCurrentRuntimeDescriptorAgentId(metadata);
  if (descriptorAgentId && descriptorAgentId !== agentId) return false;
  if (hasPublishedAcpForkProtocol(metadata)) return true;

  // runtimeDescriptorV1.agent is intentionally provider-owned and opaque to
  // generic host code. A current descriptor without the typed capability fact
  // must fail closed instead of allowing stale legacy breadcrumbs to override
  // the concrete runtime.
  if (descriptorAgentId === agentId) return false;

  // Released pre-runtime-capability Session rows remain readable at this one
  // fork seam. New runtimes publish sessionFork.protocol above; these readers
  // can be removed once those persisted rows no longer require fork support.
  const legacyRuntimeBackendModeEligibility = resolveLegacyRuntimeBackendModeEligibility(metadata, agentId);
  if (legacyRuntimeBackendModeEligibility !== null) return legacyRuntimeBackendModeEligibility;

  const eligible = (
    readAgentIdFromMetadataEntry(metadata, 'acpTransportV1') === agentId ||
    readAgentIdFromMetadataEntry(metadata, 'acpSessionModesV1') === agentId ||
    readAgentIdFromMetadataEntry(metadata, 'acpSessionModelsV1') === agentId ||
    readAgentIdFromMetadataEntry(metadata, 'acpConfigOptionsV1') === agentId ||
    readAgentIdFromMetadataEntry(metadata, 'acpHistoryImportV1') === agentId
  );

  if (eligible) return true;

  return false;
}
