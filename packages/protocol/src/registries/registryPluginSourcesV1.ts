import { buildQualifiedPluginContributionKey, createPluginContributionIdentity } from '../plugins/contributionIdentity.js';
import type { PluginRegistrySourceContributionV1 } from '../plugins/contributions/registrySources.js';
import type { PluginProjectedRegistrySourceEntryV1 } from '../daemon/contributionRegistryProjection.js';
import type { RegistrySourceDescriptorV1 } from './registrySourcesV1.js';

/** The daemon and cold Account declaration projection publish the same qualified descriptor. */
export function projectPluginRegistrySourceDeclarationV1(input: Readonly<{
  pluginId: string;
  pluginVersion: string;
  definition: PluginRegistrySourceContributionV1;
}>): PluginProjectedRegistrySourceEntryV1 {
  return { ...input, id: buildQualifiedPluginContributionKey(createPluginContributionIdentity({
    pluginId: input.pluginId, localId: input.definition.id,
  })) };
}

/** Projection adapter for the one source list; installation suppliers are host facts. */
export function createPluginRegistrySourceDescriptorV1(input: Readonly<{
  pluginId: string;
  pluginVersion?: string;
  occurrenceId?: string;
  definition: PluginRegistrySourceContributionV1;
  suppliers: readonly string[];
}>): RegistrySourceDescriptorV1 {
  const { id: localId, ...definition } = input.definition;
  if ('packageContent' in definition) {
    if (!input.pluginVersion || !input.occurrenceId) throw new Error('Packaged registry source requires a current plugin version and occurrence');
    return { ...definition, kinds: [...definition.kinds], id: buildQualifiedPluginContributionKey(createPluginContributionIdentity({ pluginId: input.pluginId, localId })),
      packageContent: { ...definition.packageContent, pluginId: input.pluginId, pluginVersion: input.pluginVersion, occurrenceId: input.occurrenceId },
      enabled: true, addedAt: 0, removable: false,
      origin: { kind: 'plugin', pluginId: input.pluginId, localId, suppliers: [...new Set(input.suppliers)] } };
  }
  return { ...definition, id: buildQualifiedPluginContributionKey(createPluginContributionIdentity({ pluginId: input.pluginId, localId })),
    enabled: true, addedAt: 0, removable: false,
    origin: { kind: 'plugin', pluginId: input.pluginId, localId, suppliers: [...new Set(input.suppliers)],
      ...(definition.kinds.some(kind => kind === 'app') && input.pluginVersion && input.occurrenceId
        ? { contributor: { pluginVersion: input.pluginVersion, occurrenceId: input.occurrenceId } } : {}) } };
}
