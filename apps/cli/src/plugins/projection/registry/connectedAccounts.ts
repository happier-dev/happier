import {
  buildQualifiedPluginContributionKey,
  ConnectedAccountUiProjectionEntryV1Schema,
  createPluginContributionIdentity,
} from '@happier-dev/protocol';

import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

function referencesConnectedAccountDescriptor(input: Readonly<{
  reference: string | Readonly<{ pluginId: string; localId: string }> | undefined;
  providerPluginId?: string;
  descriptorPluginId?: string;
  descriptorId: string;
}>): boolean {
  if (!input.reference) return false;
  if (typeof input.reference === 'string') {
    return input.providerPluginId === input.descriptorPluginId
      && input.reference === input.descriptorId;
  }
  return input.reference.pluginId === input.descriptorPluginId
    && input.reference.localId === input.descriptorId;
}

function connectedAccountProjectionKey(pluginId: string | undefined, descriptorId: string): string {
  return pluginId
    ? buildQualifiedPluginContributionKey(createPluginContributionIdentity({ pluginId, localId: descriptorId }))
    : descriptorId;
}

export const connectedAccountProjectionFamily = definePluginProjectionFamilyV2({
  family: 'connectedAccounts',
  project({ registry }) {
    return {
      family: 'connectedAccounts',
      entriesById: Object.fromEntries((registry.connectedAccountDescriptors ?? []).flatMap((contribution) => {
        const descriptor = contribution.definition;
        const hostingProvider = (registry.scmHostingProviders ?? []).find((provider) => referencesConnectedAccountDescriptor({
          reference: provider.definition.authService,
          providerPluginId: provider.pluginId,
          descriptorPluginId: contribution.pluginId,
          descriptorId: descriptor.id,
        }));
        const serviceId = hostingProvider?.id ?? descriptor.id;
        const pluginId = contribution.pluginId?.trim() || undefined;
        const diagnostics = [
          ...(pluginId
            ? (registry.pluginDiagnosticsByPluginId?.[pluginId] ?? []).map((diagnostic) => diagnostic.code)
            : []),
        ];
        const entry = ConnectedAccountUiProjectionEntryV1Schema.parse({
          id: descriptor.id, serviceId, ...(pluginId ? { pluginId } : {}),
          provenance: contribution.provenance, sourceKind: contribution.source.kind,
          title: descriptor.title, ...(descriptor.description ? { description: descriptor.description } : {}),
          authentication: descriptor.authentication,
          capabilities: descriptor.capabilities ?? [],
          availability: { state: diagnostics.length === 0 ? 'available' : 'blocked', reason: diagnostics.length === 0 ? 'resolved' : 'plugin_diagnostics' },
          diagnostics,
        });
        return [[connectedAccountProjectionKey(pluginId, entry.id), entry] as const];
      })),
    };
  },
});
