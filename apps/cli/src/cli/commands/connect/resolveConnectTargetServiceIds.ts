import { getResolvedContributionRegistry } from '@/extensions/registry/createResolvedContributionRegistry';
import { ConnectedServiceIdSchema, type ConnectedServiceId } from '@happier-dev/protocol';
import type { ResolvedContributionRegistry } from '@/extensions/registry/types';

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

  const catalogEntry = registry.catalogEntriesById[normalized];
  if (!catalogEntry?.getCloudConnectTarget) return [];

  const providerContribution = registry.providerDefinitionsById.get(normalized);
  if (!providerContribution) return [];

  const supported = readSupportedServiceIdsFromProviderDefinition(providerContribution.definition);
  return supported.map((serviceId) => ConnectedServiceIdSchema.parse(serviceId));
}
