import type { InstallableRegistryContribution } from './registry.js';

export type InstallableProjectionEntry = Readonly<{
  id: string;
  pluginId?: string;
  key: string;
  capabilityId: string;
  sourceKind: string;
  display: Readonly<{
    name: string;
    subtitle?: string;
  }>;
  description?: string;
  ui?: Readonly<{
    setupUrl?: string;
    iconName?: string;
  }>;
  defaultPolicy: Readonly<{
    autoInstallWhenNeeded: boolean;
    autoUpdateMode: string;
  }>;
  experimental: boolean;
}>;

export function projectInstallableContribution(
  contribution: InstallableRegistryContribution,
): InstallableProjectionEntry {
  const descriptor = contribution.descriptor;
  return Object.freeze({
    id: descriptor.key,
    ...(contribution.owner.pluginId ? { pluginId: contribution.owner.pluginId } : {}),
    key: descriptor.key,
    capabilityId: descriptor.capabilityId,
    sourceKind: descriptor.source.kind,
    display: descriptor.display,
    description: descriptor.description,
    ...(descriptor.ui ? { ui: descriptor.ui } : {}),
    defaultPolicy: descriptor.defaultPolicy,
    experimental: descriptor.stability.experimental,
  });
}
