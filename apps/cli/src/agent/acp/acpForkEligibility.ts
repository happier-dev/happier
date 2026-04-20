import { AGENTS_CORE, resolvePersistedCodexRuntimeIdentity, type AgentId } from '@happier-dev/agents';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readProviderIdFromMetadataEntry(metadata: Record<string, unknown>, key: string): string | null {
  const entry = metadata[key];
  if (!isRecord(entry)) return null;
  const provider = entry.provider;
  return typeof provider === 'string' ? provider : null;
}

function resolveAcpRuntimeDescriptorEligibility(metadata: Record<string, unknown>, providerId: string): boolean | null {
  const descriptor = readRuntimeDescriptorV1FromMetadata(metadata);
  if (!descriptor || descriptor.providerId !== providerId) return null;
  const provider = isRecord(descriptor.provider) ? descriptor.provider : null;
  const backendMode = typeof provider?.backendMode === 'string' ? provider.backendMode.trim() : '';
  if (!backendMode) return null;
  return backendMode === 'acp';
}

function isCatalogDeclaredAcpOnlyProvider(providerId: string): boolean {
  const provider = (AGENTS_CORE as Readonly<Record<string, { tools?: { delivery?: string } }>>)[providerId];
  return provider?.tools?.delivery === 'shell_bridge';
}

export function isAcpForkEligibleForProvider(params: Readonly<{ providerId: string; metadata: unknown }>): boolean {
  const providerId = params.providerId.trim();
  if (!providerId) return false;

  if (!isRecord(params.metadata)) return false;
  const metadata = params.metadata;

  // Catalog-declared shell-bridge providers are ACP-only in the current product model.
  if (isCatalogDeclaredAcpOnlyProvider(providerId)) return true;

  if (providerId === 'codex') {
    const runtimeIdentity = resolvePersistedCodexRuntimeIdentity(metadata);
    if (runtimeIdentity) {
      return runtimeIdentity.backendMode === 'acp';
    }
  }

  const runtimeDescriptorEligibility = resolveAcpRuntimeDescriptorEligibility(metadata, providerId);
  if (runtimeDescriptorEligibility !== null) return runtimeDescriptorEligibility;

  const eligible = (
    readProviderIdFromMetadataEntry(metadata, 'acpTransportV1') === providerId ||
    readProviderIdFromMetadataEntry(metadata, 'acpSessionModesV1') === providerId ||
    readProviderIdFromMetadataEntry(metadata, 'acpSessionModelsV1') === providerId ||
    readProviderIdFromMetadataEntry(metadata, 'acpConfigOptionsV1') === providerId ||
    readProviderIdFromMetadataEntry(metadata, 'acpHistoryImportV1') === providerId
  );

  if (eligible) return true;

  // Back-compat: older OpenCode sessions marked ACP mode directly.
  if (providerId !== 'opencode') return false;
  const legacyMode = metadata.opencodeBackendMode;
  return typeof legacyMode === 'string' && legacyMode.trim() === 'acp';
}
