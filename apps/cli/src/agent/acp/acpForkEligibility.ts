import {
  AGENTS_CORE,
} from '@happier-dev/agents';
import {
  readLinkedExternalSessionV1FromMetadata,
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

function resolveAcpRuntimeDescriptorEligibility(metadata: Record<string, unknown>, agentId: string): boolean | null {
  const descriptor = readRuntimeDescriptorV1FromMetadata(metadata);
  if (!descriptor || descriptor.agentId !== agentId) return null;
  const agentRuntime = isRecord(descriptor.agent) ? descriptor.agent : null;
  const backendMode = typeof agentRuntime?.backendMode === 'string' ? agentRuntime.backendMode.trim() : '';
  if (!backendMode) return null;
  return backendMode === 'acp';
}

function isCatalogDeclaredAcpOnlyAgent(agentId: string): boolean {
  const agent = (AGENTS_CORE as Readonly<Record<string, { sessionStorage?: { direct?: boolean }; tools?: { delivery?: string } }>>)[agentId];
  if (agent?.tools?.delivery === 'shell_bridge') return true;
  if (agent?.tools?.delivery === 'native_mcp') return agent.sessionStorage?.direct === false;
  return false;
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

  const externalSessionLink = readLinkedExternalSessionV1FromMetadata(metadata);
  if (externalSessionLink?.agentId === agentId) {
    const externalSessionEligibility = readAgentKeyedBackendModeEligibility(externalSessionLink, agentId);
    if (externalSessionEligibility !== null) return externalSessionEligibility;
  }

  return null;
}

export function isAcpForkEligibleForAgent(params: Readonly<{ agentId: string; metadata: unknown }>): boolean {
  const agentId = params.agentId.trim();
  if (!agentId) return false;

  if (!isRecord(params.metadata)) return false;
  const metadata = params.metadata;

  // Catalog-declared shell-bridge agents are ACP-only in the current product model.
  if (isCatalogDeclaredAcpOnlyAgent(agentId)) return true;

  const runtimeDescriptorEligibility = resolveAcpRuntimeDescriptorEligibility(metadata, agentId);
  if (runtimeDescriptorEligibility !== null) return runtimeDescriptorEligibility;

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
