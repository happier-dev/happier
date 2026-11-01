import type { PluginContributionIdentityV1 } from '@happier-dev/protocol';
import { projectPluginContributionRegistry } from './normalize/registry';
import { projectLoadedPluginRegistry } from './loadedProjection';
import { loadCurrentBundledPluginLocatorResult, loadEnabledBundledPluginLocatorResult } from './builtIn/locators';
import { projectBuiltInContributionInputs, type ResolvedBuiltInContributionInputs } from './builtIn/project';
import type { ResolvedContributionInputs } from './types';
import type { ResolvedPluginEnablement } from './types';

type ExactSelection = Readonly<{ agentIdentity: PluginContributionIdentityV1; providerContributionKeys?: readonly string[] }>
  | Readonly<{ providerContributionKeys: readonly string[]; agentIdentity?: PluginContributionIdentityV1 }>;

/** The existing exact family gate cannot expose Workflow declarations. */
export function projectSelectedLoadedPluginContributes(
  params: Omit<Parameters<typeof projectLoadedPluginRegistry>[0], 'pluginRegistry'>,
): ResolvedContributionInputs {
  if (!params.agentIdentity && !params.providerContributionKeys) throw new Error('An exact Agent or Provider selection is required');
  const pluginRegistry = projectPluginContributionRegistry({
    loadedPlugins: params.loadResult.loadedPlugins,
    admittedGraph: params.admittedGraph,
    providerContributionKeys: params.providerContributionKeys,
    agentIdentity: params.agentIdentity,
    ...(params.provenance === 'external' ? { referenceGraph: params.referenceGraph ?? loadCurrentBundledPluginLocatorResult().admittedGraph } : {}),
    canonicalize: (entry, value, pluginId) => entry.canonicalize(value, { pluginId }),
  });
  return projectLoadedPluginRegistry({ ...params, pluginRegistry });
}

export function resolveSelectedBuiltInContributions(params: ExactSelection & Readonly<{
  pluginEnablementById?: Readonly<Record<string, ResolvedPluginEnablement>>;
}>): ResolvedBuiltInContributionInputs {
  const bundled = loadEnabledBundledPluginLocatorResult({
    ...(params.agentIdentity ? { pluginIds: [params.agentIdentity.pluginId] } : {}),
    pluginEnablementById: params.pluginEnablementById,
  });
  const projected = projectSelectedLoadedPluginContributes({
    loadResult: { loadedPlugins: bundled.loadedPlugins,
      diagnosticsByPluginId: Object.fromEntries(bundled.pluginFailures.map(failure => [failure.pluginId, [failure.diagnostic]])) },
    provenance: 'first_party', ...params, admittedGraph: bundled.admittedGraph,
  });
  return { ...projectBuiltInContributionInputs(projected, params), pluginEnablementById: params.pluginEnablementById };
}
