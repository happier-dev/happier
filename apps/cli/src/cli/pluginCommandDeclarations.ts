import { evaluateContributionAvailability, resolveInvocationContributionPolicyFacts } from '@happier-dev/protocol/plugins/contributions/policy-evaluation';
import type { CanonicalPluginManifest } from '../plugins/manifest/types';
import type { ResolvedContributionProvenance, ResolvedContributionSource } from '../plugins/projection/registry/types';
import { readAgentSessionCapabilities, readAgentExecutionRunCapabilities } from '../plugins/projection/registry/agentContributionDefinition';
import { readAgentCommandTitle } from '../plugins/projection/registry/agentCommandTitle';
import { resolveContributedAgentRoutingId } from '../plugins/projection/registry/agentRoutingIdentity';
import type { BundledPluginCommandMetadata } from './commandDescriptors';

/** The same declaration projection serves publication and admitted local reads. */
export function projectPluginCommandDeclarations(params: Readonly<{
  manifest: CanonicalPluginManifest;
  provenance: ResolvedContributionProvenance;
  source: ResolvedContributionSource;
  bundledAgentId?: string;
}>): BundledPluginCommandMetadata {
  const { manifest, provenance, source } = params;
  return {
    pluginId: manifest.id,
    agents: (manifest.contributes.agents ?? []).flatMap((agent) => {
      if (!readAgentSessionCapabilities(agent) && !readAgentExecutionRunCapabilities(agent)) return [];
      const routingId = params.bundledAgentId ?? resolveContributedAgentRoutingId({ pluginId: manifest.id, localId: agent.id, provenance });
      return [{
        id: routingId,
        cliSubcommand: provenance === 'first_party' ? agent.id : routingId,
        title: agent.cli ? readAgentCommandTitle({ agentId: routingId, title: agent.title, cli: agent.cli }) : routingId,
      }];
    }),
    actions: (manifest.contributes.actions ?? []).filter((action) => action.surfaces.includes('cli') && action.cli).map((action) => ({
      pluginId: manifest.id,
      provenance,
      source,
      definition: { id: action.id },
      admittedTarget: { declaration: {
        id: action.id, title: action.title,
        ...(action.description === undefined ? {} : { description: action.description }),
        surfaces: action.surfaces, cli: action.cli,
      } },
      availability: evaluateContributionAvailability({ availability: action.availability, facts: resolveInvocationContributionPolicyFacts() }),
    })),
  };
}
