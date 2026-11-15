import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ConnectedAccountUiProjectionEntryV1Schema, projectConnectedAccountDescriptorV1 } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ConnectedAccountUiProjectionEntryV1 } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import type { ResolvedContributionRegistry } from './types';
import { qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { resolveConnectedAccountNativeLoginConstraintsV1 } from '@happier-dev/protocol/teams';

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

export function projectConnectedAccountDescriptors(
  registry: ResolvedContributionRegistry,
  pluginDiagnosticsByPluginId?: ResolvedContributionRegistry['pluginDiagnosticsByPluginId'],
): Readonly<Record<string, ConnectedAccountUiProjectionEntryV1>> {
    const diagnosticsByPluginId = pluginDiagnosticsByPluginId ?? registry.pluginDiagnosticsByPluginId;
    const agents = (registry.agents ?? []).flatMap(agent => {
        const definition = agent.richDefinition?.definition;
        const identity = agent.identity;
        return identity && definition ? [{ identity, title: resolvePluginLocalizedStringV2Text(definition.title),
            providerRequirements: definition.providerRequirements,
            connectedAccounts: definition.connectedAccounts?.map(purpose => ({
                service: qualifyPluginContributionReferenceV1(purpose.service, identity.pluginId),
            })),
        }] : [];
    });
    return Object.fromEntries((registry.connectedAccountDescriptors ?? []).flatMap((contribution) => {
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
        const entry = ConnectedAccountUiProjectionEntryV1Schema.parse(projectConnectedAccountDescriptorV1({
          descriptor, serviceId, ...(pluginId ? { pluginId } : {}),
          provenance: contribution.provenance, sourceKind: contribution.source.kind,
          ...(pluginId ? { nativeLoginRequiredBy: resolveConnectedAccountNativeLoginConstraintsV1({ pluginId, localId: descriptor.id }, agents) } : {}),
          // UI-T28: Connected Account setup is host-rendered from the STATIC
          // descriptor, so it is blocked only when that declaration is itself
          // unusable (missing/invalid manifest or unapproved trust). A runtime
          // diagnostic — a failed daemon activation above all — is disclosed but
          // must not remove the very flow that repairs the configuration.
          availability: hasUnusablePluginDeclarationDiagnostic(diagnostics)
            ? { state: 'blocked', reason: 'plugin_declaration_unusable' }
            : { state: 'available', reason: 'resolved' },
          diagnostics,
        }));
        return [[connectedAccountProjectionKey(pluginId, entry.id), entry] as const];
      }));
}

export const connectedAccountProjectionFamily = definePluginProjectionFamilyV2({
  family: 'connectedAccounts',
  project: ({ registry, pluginDiagnosticsByPluginId }) => ({
    family: 'connectedAccounts', entriesById: projectConnectedAccountDescriptors(registry, pluginDiagnosticsByPluginId),
  }),
});
