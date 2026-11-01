import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { admitPluginContributionGraph } from './normalize/admission';
import { loadEnabledBundledPluginLocatorResult } from './builtIn/locators';
import type { ResolvePluginContributesParams } from './loadedProjection';
import type { ResolvedContributionInputs } from './types';

export async function resolvePluginContributes(
    params: ResolvePluginContributesParams = {},
): Promise<ResolvedContributionInputs> {
    let loadResult = await loadInstalledPlugins({ happyHomeDir: params.happyHomeDir,
        ...(params.agentIdentity ? { pluginIds: [params.agentIdentity.pluginId] } : {}),
    });
    let referenceGraph = params.referenceGraph ?? loadEnabledBundledPluginLocatorResult({
        ...(params.agentIdentity ? { pluginIds: [params.agentIdentity.pluginId] } : {}),
        pluginEnablementById: params.pluginEnablementById,
    }).admittedGraph;
    let admittedGraph = admitPluginContributionGraph({ loadedPlugins: loadResult.loadedPlugins, referenceGraph,
        pluginEnablementById: params.pluginEnablementById });
    if (params.agentIdentity && Object.keys(admittedGraph.diagnosticsByPluginId).length > 0) {
        // Cross-plugin references are a real demand for the reference universe,
        // including installed peers. Keep the existing admission decision whole.
        loadResult = await loadInstalledPlugins({ happyHomeDir: params.happyHomeDir });
        referenceGraph = params.referenceGraph ?? loadEnabledBundledPluginLocatorResult({
            pluginEnablementById: params.pluginEnablementById,
        }).admittedGraph;
        admittedGraph = admitPluginContributionGraph({ loadedPlugins: loadResult.loadedPlugins, referenceGraph,
            pluginEnablementById: params.pluginEnablementById });
    }
    const project = params.agentIdentity || params.providerContributionKeys
        ? (await import('./selected')).projectSelectedLoadedPluginContributes
        : (await import('./fullProjection')).projectLoadedPluginContributes;
    return project({
        loadResult,
        provenance: 'external',
        existingAgentIds: params.existingAgentIds,
        providerContributionKeys: params.providerContributionKeys,
        agentIdentity: params.agentIdentity,
        referenceGraph,
        admittedGraph,
    });
}

export { projectLoadedPluginContributes } from './fullProjection';
