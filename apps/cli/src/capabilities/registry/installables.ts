import {
  BUILT_IN_INSTALLABLES_REGISTRY,
  resolveInstallablesRegistry,
  type InstallableRegistryContribution,
  type InstallablesRegistry,
} from '@happier-dev/protocol/installables';

import { createInstallableCapability } from '@/capabilities/deps/installables';
import type { Capability } from '@/capabilities/service';
import type { CapabilityDetectRequest, CapabilityId } from '@/capabilities/types';
import {
  getRuntimeInstallableAdapter,
  type RuntimeInstallableAdapter,
} from '@/packagedRuntime/installables/registry';
import type { ResolvedInstallableContribution } from '@/plugins/projection/registry/types';

export type RuntimeInstallableAdapterResolver = (
  key: string,
  opts?: Readonly<{ installablesRegistry?: InstallablesRegistry }>,
) => Promise<RuntimeInstallableAdapter>;

function toInstallableRegistryContribution(
  candidate: ResolvedInstallableContribution,
): InstallableRegistryContribution {
  const isHostBuiltIn = candidate.provenance === 'first_party'
    && !candidate.manifestPath
    && !candidate.manifestDigest
    && !candidate.daemonEntryPath
    && !candidate.sourceSpec;

  return {
    owner: {
      provenance: isHostBuiltIn
        ? 'built_in'
        : candidate.provenance === 'first_party'
          ? 'bundled_first_party_plugin'
          : 'external_plugin',
      ownerId: candidate.pluginId ?? `${candidate.provenance}:${candidate.definition.key}`,
      ...(candidate.pluginId ? { pluginId: candidate.pluginId } : {}),
      ...(candidate.manifestPath ? { manifestPath: candidate.manifestPath } : {}),
      ...(candidate.manifestDigest ? { manifestDigest: candidate.manifestDigest } : {}),
    },
    descriptor: candidate.definition,
  };
}

export function createInstallablesRegistryFromResolvedContributions(
  contributions: readonly ResolvedInstallableContribution[],
): InstallablesRegistry {
  const builtIns: InstallableRegistryContribution[] = [];
  const bundledFirstPartyPlugins: InstallableRegistryContribution[] = [];
  const externalPlugins: InstallableRegistryContribution[] = [];

  for (const contribution of contributions) {
    const registryContribution = toInstallableRegistryContribution(contribution);
    if (registryContribution.owner.provenance === 'built_in') {
      builtIns.push(registryContribution);
    } else if (registryContribution.owner.provenance === 'bundled_first_party_plugin') {
      bundledFirstPartyPlugins.push(registryContribution);
    } else {
      externalPlugins.push(registryContribution);
    }
  }

  return resolveInstallablesRegistry({
    builtIns,
    bundledFirstPartyPlugins,
    externalPlugins,
  });
}

export async function createInstallableCapabilities(params: Readonly<{
  installablesRegistry: InstallablesRegistry;
  existingCapabilityIds?: ReadonlySet<CapabilityId>;
  getRuntimeInstallableAdapter?: RuntimeInstallableAdapterResolver;
}>): Promise<Capability[]> {
  const resolveAdapter = params.getRuntimeInstallableAdapter ?? getRuntimeInstallableAdapter;
  const existingCapabilityIds = params.existingCapabilityIds ?? new Set<CapabilityId>();
  const capabilities: Capability[] = [];

  for (const contribution of params.installablesRegistry.descriptors) {
    const descriptor = contribution.descriptor;
    if (existingCapabilityIds.has(descriptor.capabilityId)) continue;

    let adapter: RuntimeInstallableAdapter;
    try {
      adapter = await resolveAdapter(descriptor.key, { installablesRegistry: params.installablesRegistry });
    } catch {
      continue;
    }

    if (adapter.capabilityId !== descriptor.capabilityId) continue;
    capabilities.push(createInstallableCapability(descriptor, adapter));
  }

  return capabilities;
}

export async function createInstallableCapabilitiesFromContributions(params: Readonly<{
  installables?: readonly ResolvedInstallableContribution[];
  existingCapabilityIds?: ReadonlySet<CapabilityId>;
  getRuntimeInstallableAdapter?: RuntimeInstallableAdapterResolver;
}>): Promise<Capability[]> {
  const installablesRegistry = params.installables
    ? createInstallablesRegistryFromResolvedContributions(params.installables)
    : BUILT_IN_INSTALLABLES_REGISTRY;

  return createInstallableCapabilities({
    installablesRegistry,
    existingCapabilityIds: params.existingCapabilityIds,
    getRuntimeInstallableAdapter: params.getRuntimeInstallableAdapter,
  });
}

export function createInstallableCapabilityRequests(
  installablesRegistry: Pick<InstallablesRegistry, 'descriptors'> = BUILT_IN_INSTALLABLES_REGISTRY,
): CapabilityDetectRequest[] {
  return installablesRegistry.descriptors.map((contribution) => ({
    id: contribution.descriptor.capabilityId,
  }));
}
