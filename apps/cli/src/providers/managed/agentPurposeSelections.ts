import type { ConnectedServiceBindingsV2, SessionModelSelectionV1 } from '@happier-dev/protocol';
import { resolveAgentSpawnPurposeDeclarations, type AgentSpawnPurposeContributions } from '@/daemon/connectedServices/requestAuth/agentPurposeDeclarations';
import { projectConnectedServiceBindingsToQualifiedPurposeBindingSnapshot } from '@/daemon/connectedServices/requestAuth/firstPartyConnectedAccountRequestAuthAdapter';

/** The selected declaration-managed sources shared by launch and model discovery. */
export function resolveAgentManagedPurposeSelections(input: Readonly<{
  contributions: AgentSpawnPurposeContributions;
  agentId: string;
  connectedServices: ConnectedServiceBindingsV2 | null;
  selection?: SessionModelSelectionV1;
}>) {
  const declarations = resolveAgentSpawnPurposeDeclarations(input);
  if (!declarations || !input.connectedServices) return [];
  const selected = projectConnectedServiceBindingsToQualifiedPurposeBindingSnapshot({ consumer: declarations.consumer,
    declarations: declarations.declarations, bindings: input.connectedServices });
  return declarations.declarations.flatMap(declaration => {
    if (!declaration.managedProviderEndpoint) return [];
    const binding = selected?.bindings.find(binding => binding.purpose.purpose === declaration.purpose);
    if (!binding || binding.target.kind !== 'account' && binding.target.kind !== 'group') return [];
    const prefix = declaration.managedProviderEndpoint.modelIdPrefix;
    if (input.selection && prefix && !input.selection.ref.modelId.startsWith(prefix)) return [];
    return [{ declaration, binding }];
  });
}
