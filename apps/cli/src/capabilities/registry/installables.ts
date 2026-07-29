import {
  BUILT_IN_INSTALLABLES_REGISTRY,
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
import {
  resolveExecutableManagedDependenciesRegistry,
} from '@/plugins/projection/registry/managedDependencyExecutables';

export type RuntimeInstallableAdapterResolver = (
  key: string,
  opts?: Readonly<{ installablesRegistry?: InstallablesRegistry }>,
) => Promise<RuntimeInstallableAdapter>;

export function createInstallablesRegistryFromResolvedContributions(
  contributions: readonly ResolvedInstallableContribution[],
): InstallablesRegistry {
  return resolveExecutableManagedDependenciesRegistry(contributions);
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
