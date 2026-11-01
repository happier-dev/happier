import type { PluginContributionIdentityV1 } from '@happier-dev/protocol';
import { loadEnabledBundledPluginLocatorResult } from './builtIn/locators';
import { projectLoadedPluginContributes } from './fullProjection';
import { projectBuiltInContributionInputs, type ResolvedBuiltInContributionInputs } from './builtIn/project';
import type { ResolvedPluginEnablement } from './types';

/**
 * Projects first-party packages through the same canonical manifest path as
 * installed plugins, then joins only host-owned canonical identity and proven
 * bundled backend-compatibility facts. Author-owned CLI, catalog, capability,
 * and presentation facts remain on the public manifest projection.
 */
export function resolveBuiltInContributions(params?: Readonly<{ providerContributionKeys?: readonly string[]; agentIdentity?: PluginContributionIdentityV1;
    pluginEnablementById?: Readonly<Record<string, ResolvedPluginEnablement>>;
}>): ResolvedBuiltInContributionInputs {
    const bundled = loadEnabledBundledPluginLocatorResult({
        ...(params?.agentIdentity ? { pluginIds: [params.agentIdentity.pluginId] } : {}),
        pluginEnablementById: params?.pluginEnablementById,
    });
    const projected = projectLoadedPluginContributes({
        loadResult: {
            loadedPlugins: bundled.loadedPlugins,
            diagnosticsByPluginId: Object.fromEntries(bundled.pluginFailures.map((failure) => [
                failure.pluginId,
                [failure.diagnostic],
            ])),
        },
        provenance: 'first_party',
        admittedGraph: bundled.admittedGraph,
        providerContributionKeys: params?.providerContributionKeys,
        agentIdentity: params?.agentIdentity,
    });
    return projectBuiltInContributionInputs(projected, params);
}
