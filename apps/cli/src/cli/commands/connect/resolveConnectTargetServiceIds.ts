import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import {
  ConnectedServiceIdSchema,
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
  registry: Pick<ResolvedContributionRegistry, 'agentDefinitionsById'>,
): ConnectedServiceId[] {
  const normalized = String(targetId ?? '').trim().toLowerCase();
  if (!normalized) return [];

  const agentContribution = registry.agentDefinitionsById.get(normalized);
  if (!agentContribution) return [];

  const supported = readSupportedServiceIdsFromProviderDefinition(
    agentContribution.definition,
  );
  return Array.from(new Set(supported.flatMap((serviceId) => {
    const parsed = ConnectedServiceIdSchema.safeParse(serviceId);
    return parsed.success ? [parsed.data] : [];
  })));
}
