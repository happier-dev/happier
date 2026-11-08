import { BUILT_IN_INSTALLABLES_REGISTRY } from '@happier-dev/protocol/installables';
import type { InstallablesRegistry } from '@happier-dev/protocol/installables';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ManagedDependencyStatus } from '@happier-dev/plugin-sdk/managed-services';

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
  selectExecutableManagedDependencies,
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
  readManagedDependencyStatus?: (dependency: PluginContributionIdentityV1) => Promise<ManagedDependencyStatus>;
  managedDependencyContributions?: readonly ResolvedInstallableContribution[];
}>): Promise<Capability[]> {
  const resolveAdapter = params.getRuntimeInstallableAdapter ?? getRuntimeInstallableAdapter;
  const existingCapabilityIds = params.existingCapabilityIds ?? new Set<CapabilityId>();
  const capabilities: Capability[] = [];
  const dependenciesByInstallId = new Map<string, Array<ReturnType<typeof selectExecutableManagedDependencies>[number]>>();
  for (const entry of selectExecutableManagedDependencies(params.managedDependencyContributions ?? [])) {
    const candidates = dependenciesByInstallId.get(entry.definition.key);
    if (candidates) candidates.push(entry);
    else dependenciesByInstallId.set(entry.definition.key, [entry]);
  }

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
    // Consume the registry's winning owner when install ids collide.
    const dependency = dependenciesByInstallId.get(descriptor.key)?.find(entry =>
      entry.pluginId === contribution.owner.pluginId && entry.manifestPath === contribution.owner.manifestPath)?.managedDependency;
    const readStatus = params.readManagedDependencyStatus;
    capabilities.push(createInstallableCapability(descriptor, adapter, dependency && readStatus
      ? () => readStatus(dependency) : undefined));
  }

  return capabilities;
}

export async function createInstallableCapabilitiesFromContributions(params: Readonly<{
  installables?: readonly ResolvedInstallableContribution[];
  existingCapabilityIds?: ReadonlySet<CapabilityId>;
  getRuntimeInstallableAdapter?: RuntimeInstallableAdapterResolver;
  readManagedDependencyStatus?: (dependency: PluginContributionIdentityV1) => Promise<ManagedDependencyStatus>;
}>): Promise<Capability[]> {
  const installablesRegistry = params.installables
    ? createInstallablesRegistryFromResolvedContributions(params.installables)
    : BUILT_IN_INSTALLABLES_REGISTRY;

  return createInstallableCapabilities({
    installablesRegistry,
    existingCapabilityIds: params.existingCapabilityIds,
    getRuntimeInstallableAdapter: params.getRuntimeInstallableAdapter,
    managedDependencyContributions: params.installables,
    readManagedDependencyStatus: params.readManagedDependencyStatus,
  });
}

export function createInstallableCapabilityRequests(
  installablesRegistry: Pick<InstallablesRegistry, 'descriptors'> = BUILT_IN_INSTALLABLES_REGISTRY,
): CapabilityDetectRequest[] {
  return installablesRegistry.descriptors.map((contribution) => ({
    id: contribution.descriptor.capabilityId,
  }));
}
