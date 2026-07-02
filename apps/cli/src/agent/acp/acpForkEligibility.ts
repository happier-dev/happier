import {
  AGENTS_CORE,
  type AgentId,
} from '@happier-dev/agents';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol';

import { AGENTS } from '@/backends/catalog';
import { hasCatalogAcpBackendOwner } from './catalog/owner';

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
  const entry = (AGENTS as Readonly<Record<string, {
    getAcpBackendFactory?: unknown;
    getAcpRuntimeDefinitionBridge?: unknown;
    vendorResumeSupport?: string;
  }>>)[providerId];
  const provider = (AGENTS_CORE as Readonly<Record<string, { sessionStorage?: { direct?: boolean }; tools?: { delivery?: string } }>>)[providerId];
  if (hasCatalogAcpBackendOwner(entry) && entry.vendorResumeSupport !== 'unsupported') {
    return provider?.sessionStorage?.direct === false;
  }

  if (provider?.tools?.delivery === 'shell_bridge') return true;
  if (provider?.tools?.delivery === 'native_mcp') return provider.sessionStorage?.direct === false;
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

function readProviderKeyedBackendModeEligibility(
  metadata: Record<string, unknown>,
  providerId: string,
): boolean | null {
  return readBackendModeEligibility(metadata[`${providerId}BackendMode`]);
}

function readProviderScopedBackendModeEligibility(
  metadata: Record<string, unknown>,
  providerId: string,
): boolean | null {
  const metadataProviderId = typeof metadata.providerId === 'string' ? metadata.providerId.trim() : '';
  if (metadataProviderId && metadataProviderId !== providerId) return null;
  return readProviderKeyedBackendModeEligibility(metadata, providerId);
}

function resolveLegacyRuntimeBackendModeEligibility(metadata: Record<string, unknown>, providerId: string): boolean | null {
  const legacyRuntimeDescriptorRaw = metadata[`${providerId}RuntimeDescriptorV1`];
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

  const topLevelEligibility = readProviderKeyedBackendModeEligibility(metadata, providerId);
  if (topLevelEligibility !== null) return topLevelEligibility;

  const directSession = isRecord(metadata.directSessionV1) ? metadata.directSessionV1 : null;
  const directSessionEligibility = directSession
    ? readProviderScopedBackendModeEligibility(directSession, providerId)
    : null;
  if (directSessionEligibility !== null) return directSessionEligibility;

  const externalSession = isRecord(metadata.externalSessionV1) ? metadata.externalSessionV1 : null;
  const externalSessionEligibility = externalSession
    ? readProviderScopedBackendModeEligibility(externalSession, providerId)
    : null;
  if (externalSessionEligibility !== null) return externalSessionEligibility;

  return null;
}

export function isAcpForkEligibleForProvider(params: Readonly<{ providerId: string; metadata: unknown }>): boolean {
  const providerId = params.providerId.trim();
  if (!providerId) return false;

  if (!isRecord(params.metadata)) return false;
  const metadata = params.metadata;

  // Catalog-declared shell-bridge providers are ACP-only in the current product model.
  if (isCatalogDeclaredAcpOnlyProvider(providerId)) return true;

  const runtimeDescriptorEligibility = resolveAcpRuntimeDescriptorEligibility(metadata, providerId);
  if (runtimeDescriptorEligibility !== null) return runtimeDescriptorEligibility;

  const legacyRuntimeBackendModeEligibility = resolveLegacyRuntimeBackendModeEligibility(metadata, providerId);
  if (legacyRuntimeBackendModeEligibility !== null) return legacyRuntimeBackendModeEligibility;

  const eligible = (
    readProviderIdFromMetadataEntry(metadata, 'acpTransportV1') === providerId ||
    readProviderIdFromMetadataEntry(metadata, 'acpSessionModesV1') === providerId ||
    readProviderIdFromMetadataEntry(metadata, 'acpSessionModelsV1') === providerId ||
    readProviderIdFromMetadataEntry(metadata, 'acpConfigOptionsV1') === providerId ||
    readProviderIdFromMetadataEntry(metadata, 'acpHistoryImportV1') === providerId
  );

  if (eligible) return true;

  return false;
}
