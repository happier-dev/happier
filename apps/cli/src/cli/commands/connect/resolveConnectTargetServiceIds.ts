import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import {
  ConnectedServiceIdSchema,
  getConnectedAccountDescriptorsForTarget,
  type ConnectedServiceId,
} from '@happier-dev/protocol';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readSupportedServiceIdsFromProviderDefinition(definition: unknown): readonly unknown[] {
  if (!isRecord(definition)) return [];

  const core = isRecord(definition.core) ? definition.core : null;
  const connectedServices = core && isRecord(core.connectedServices) ? core.connectedServices : null;
  const supportedCoreServiceIds = connectedServices?.supportedServiceIds;
  if (Array.isArray(supportedCoreServiceIds)) {
    return supportedCoreServiceIds;
  }

  const auth = isRecord(definition.auth) ? definition.auth : null;
  const supportedCompatibilityServiceIds = auth?.connectedServiceCompatibility;
  if (Array.isArray(supportedCompatibilityServiceIds)) {
    return supportedCompatibilityServiceIds;
  }

  return [];
}

export function resolveConnectTargetServiceIds(targetId: string): ConnectedServiceId[] {
  return resolveConnectTargetServiceIdsFromRegistry(targetId, getResolvedContributionRegistry());
}

export function resolveConnectTargetServiceIdsFromRegistry(
  targetId: string,
  registry: Pick<ResolvedContributionRegistry, 'catalogEntriesById' | 'providerDefinitionsById'>,
): ConnectedServiceId[] {
  const normalized = String(targetId ?? '').trim().toLowerCase();
  if (!normalized) return [];

  const descriptorServiceIds = getConnectedAccountDescriptorsForTarget(normalized).map((descriptor) => descriptor.id);
  const catalogEntry = registry.catalogEntriesById[normalized];
  if (!catalogEntry?.getCloudConnectTarget) return descriptorServiceIds;

  const providerContribution = registry.providerDefinitionsById.get(normalized);
  if (!providerContribution) return descriptorServiceIds;

  const supported = readSupportedServiceIdsFromProviderDefinition(providerContribution.definition);
  const providerServiceIds = supported.map((serviceId) => ConnectedServiceIdSchema.parse(serviceId));
  return Array.from(new Set([...descriptorServiceIds, ...providerServiceIds]));
}
