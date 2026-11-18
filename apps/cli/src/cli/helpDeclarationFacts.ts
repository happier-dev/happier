import type { AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol';

import { indexAgentBindings, manifestAgentKey } from '@/plugins/projection/registry/builtIn/agentIdentity';
import { BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS } from '@/plugins/projection/registry/sources/generatedBundledPlugins';

export type CliAgentHelpRow = Readonly<{
  id: string;
  pluginId: string;
  identity?: PluginContributionIdentityV1;
  title: string;
  runtimeSpec: AgentCliRuntimeDescriptor | null;
}>;

/** Read-only accepted input to help, never installed into executable catalogs. */
export async function resolveCliAgentHelpRows(happyHomeDir: string): Promise<readonly CliAgentHelpRow[]> {
  const [{ BUNDLED_CLI_HELP_FACTS }, { resolveReadOnlyHelpDeclarations }] = await Promise.all([
    import('@/plugins/projection/registry/sources/generatedBundledCliHelpFacts'), import('./rootHelp'),
  ]);
  const declarations = await resolveReadOnlyHelpDeclarations(happyHomeDir);
  const { byIdentity } = indexAgentBindings(BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS);
  const rows: CliAgentHelpRow[] = BUNDLED_CLI_HELP_FACTS.agents
    .filter((agent) => declarations.pluginIds.includes(agent.pluginId))
    .map((agent) => {
      // The generated help rows come from manifests. The registration binding
      // supplies the Agent ID accepted by the install and Agent commands.
      const identity = agent.identity;
      const binding = identity && byIdentity.get(manifestAgentKey(identity.pluginId, identity.localId));
      const id = binding?.implementationOwnerId ?? agent.id;
      return id === agent.id ? agent : {
        ...agent, id, runtimeSpec: agent.runtimeSpec && { ...agent.runtimeSpec, id },
      };
    });
  if (declarations.installedPlugins.length > 0) {
    const [{ projectManifestAgentFields }, { readResolvedAgentTitle }] = await Promise.all([
      import('@/plugins/projection/registry/projectManifestAgentFields'), import('@/plugins/projection/registry/agentCommandTitle'),
    ]);
    for (const plugin of declarations.installedPlugins) {
      for (const definition of plugin.manifest.contributes.agents ?? []) {
        // The only non-selectable container is the bundled custom-ACP identity;
        // canonical plugin-identity admission already rejects any replacement.
        const fields = projectManifestAgentFields({ definition, pluginId: plugin.pluginId, provenance: 'external', source: { kind: plugin.sourceSpec.kind } });
        rows.push({ id: fields.id, pluginId: plugin.pluginId, identity: fields.identity, title: readResolvedAgentTitle(fields), runtimeSpec: fields.runtimeSpec ?? null });
      }
    }
  }
  return Object.freeze(rows.sort((left, right) => left.id.localeCompare(right.id)));
}
