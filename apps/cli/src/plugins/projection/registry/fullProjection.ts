import { buildPluginContributionRegistry } from './normalize/package';
import { projectLoadedPluginRegistry } from './loadedProjection';
import { loadCurrentBundledPluginLocatorResult } from './builtIn/locators';
import type { ResolvedContributionInputs } from './types';

export function projectLoadedPluginContributes(
  params: Omit<Parameters<typeof projectLoadedPluginRegistry>[0], 'pluginRegistry'>,
): ResolvedContributionInputs {
    const pluginRegistry = buildPluginContributionRegistry({
        loadedPlugins: params.loadResult.loadedPlugins,
        admittedGraph: params.admittedGraph,
        providerContributionKeys: params.providerContributionKeys,
        agentIdentity: params.agentIdentity,
        ...(params.provenance === 'external'
            ? {
                referenceGraph: params.referenceGraph ?? loadCurrentBundledPluginLocatorResult().admittedGraph,
            }
            : {}),
    });
    return projectLoadedPluginRegistry({ ...params, pluginRegistry });
}
