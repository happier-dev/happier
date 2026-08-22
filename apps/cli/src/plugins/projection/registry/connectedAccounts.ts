import {
  buildQualifiedPluginContributionKey,
  ConnectedAccountUiProjectionEntryV1Schema,
  createPluginContributionIdentity,
} from '@happier-dev/protocol';

import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
import { hasUnusablePluginDeclarationDiagnostic } from '@/plugins/validation/diagnostics/declarationUsability';

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
  project({ registry, pluginDiagnosticsByPluginId }) {
    const diagnosticsByPluginId = pluginDiagnosticsByPluginId ?? registry.pluginDiagnosticsByPluginId;
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
            ? (diagnosticsByPluginId?.[pluginId] ?? []).map((diagnostic) => diagnostic.code)
            : []),
        ];
        const entry = ConnectedAccountUiProjectionEntryV1Schema.parse({
          id: descriptor.id, serviceId, ...(pluginId ? { pluginId } : {}),
          provenance: contribution.provenance, sourceKind: contribution.source.kind,
          title: descriptor.title, ...(descriptor.description ? { description: descriptor.description } : {}),
          authentication: descriptor.authentication,
          capabilities: descriptor.capabilities ?? [],
          // UI-T28: Connected Account setup is host-rendered from the STATIC
          // descriptor, so it is blocked only when that declaration is itself
          // unusable (missing/invalid manifest or unapproved trust). A runtime
          // diagnostic — a failed daemon activation above all — is disclosed but
          // must not remove the very flow that repairs the configuration.
          availability: hasUnusablePluginDeclarationDiagnostic(diagnostics)
            ? { state: 'blocked', reason: 'plugin_declaration_unusable' }
            : { state: 'available', reason: 'resolved' },
          diagnostics,
        });
        return [[connectedAccountProjectionKey(pluginId, entry.id), entry] as const];
      })),
    };
  },
});
