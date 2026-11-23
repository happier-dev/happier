import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { admitPluginContributionGraph } from '@/plugins/projection/registry/normalize/admission';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

type SelectedDeclaration = Readonly<{ declaration: LoadedPlugin; custodyId: string }>;
type Projection = Readonly<{ generation: string; contributes: ResolvedContributionRegistry }>;

// Keep the current declaration projection alongside its host declaration generation.
// Request-owned custody, credentials and activation are resolved by the caller.
const currentProjectionByHost = new WeakMap<ResolvedContributionRegistry, Projection>();

export function projectAccountContributionRegistry(input: Readonly<{
    host: ResolvedContributionRegistry;
    accountScopeKey: string;
    selected: readonly SelectedDeclaration[];
}>): ResolvedContributionRegistry {
    const generation = JSON.stringify([input.accountScopeKey, input.selected.map(({ declaration, custodyId }) => [
        declaration.pluginId, custodyId, declaration.pluginRootPath,
        // Portable releases can gain a compiler graph for an existing slot.
        declaration.generatedUiArtifactsManifest?.entries.map(entry => [entry.artifactId, entry.tier, entry.entry, entry.digest]),
    ])]);
    const current = currentProjectionByHost.get(input.host);
    if (current?.generation === generation) return current.contributes;

    const bundled: LoadedPlugin[] = [];
    const portable: LoadedPlugin[] = [];
    for (const { declaration } of input.selected) {
        (declaration.sourceSpec.kind === 'bundled' ? bundled : portable).push(declaration);
    }
    const bundledGraph = admitPluginContributionGraph({ loadedPlugins: bundled });
    const portableGraph = admitPluginContributionGraph({
        loadedPlugins: portable,
        referenceGraph: loadCurrentBundledPluginLocatorResult().admittedGraph,
    });
    // Bundled declarations stand on their own, while a portable declaration
    // can still reference the host's admitted bundled universe.
    const loadedPlugins = [...bundledGraph.loadedPlugins, ...portableGraph.loadedPlugins];
    const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({
        provenance: plugin => plugin.sourceSpec.kind === 'bundled' ? 'first_party' : 'external',
        loadResult: { loadedPlugins, diagnosticsByPluginId: {} },
        admittedGraph: {
            loadedPlugins,
            diagnosticsByPluginId: { ...bundledGraph.diagnosticsByPluginId, ...portableGraph.diagnosticsByPluginId },
            unavailablePlugins: [...(bundledGraph.unavailablePlugins ?? []), ...(portableGraph.unavailablePlugins ?? [])],
        },
    }));
    currentProjectionByHost.set(input.host, { generation, contributes });
    return contributes;
}
