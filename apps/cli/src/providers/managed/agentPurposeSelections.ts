import type { SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import type { ConnectedServiceBindingsV2 } from '@happier-dev/protocol';
import { resolveAgentSpawnPurposeDeclarations, type AgentSpawnPurposeContributions } from '@/daemon/connectedServices/requestAuth/agentPurposeDeclarations';
import { projectConnectedServiceBindingsToQualifiedPurposeBindingSnapshot } from '@/daemon/connectedServices/requestAuth/firstPartyConnectedAccountRequestAuthAdapter';

/** Exact declared Account sources shared by launch and model discovery. */
export function resolveAgentPurposeSelections(input: Readonly<{
  contributions: AgentSpawnPurposeContributions;
  agentId: string;
  connectedServices: ConnectedServiceBindingsV2 | null;
}>) {
  const declarations = resolveAgentSpawnPurposeDeclarations(input);
  if (!declarations || !input.connectedServices) return [];
  const selected = projectConnectedServiceBindingsToQualifiedPurposeBindingSnapshot({ consumer: declarations.consumer,
    declarations: declarations.declarations, bindings: input.connectedServices });
  return declarations.declarations.flatMap(declaration => {
    const binding = selected?.bindings.find(binding => binding.purpose.purpose === declaration.purpose);
    if (!binding || binding.target.kind !== 'account' && binding.target.kind !== 'group') return [];
    return [{ declaration, binding }];
  });
}

/** Managed launch consumes only purposes that delegate endpoint acquisition. */
export function resolveAgentManagedPurposeSelections(input: Parameters<typeof resolveAgentPurposeSelections>[0] & Readonly<{
  selection?: SessionModelSelection;
}>) {
  return resolveAgentPurposeSelections(input).filter(({ declaration }) => {
    const route = declaration.managedProviderEndpoint;
    // CLI callers may supply the catalog id directly. Qualified ids still
    // select only their declared namespace; admission verifies the catalog row.
    return route !== undefined && (!input.selection || !route.modelIdPrefix
      || !input.selection.ref.modelId.includes('/') || input.selection.ref.modelId.startsWith(route.modelIdPrefix));
  });
}
