import { gitScmBackendSettingsPlugin } from '@/scm/backends/git/settingsPlugin';
import { saplingScmBackendSettingsPlugin } from '@/scm/backends/sapling/settingsPlugin';
import { getFirstPartyScmBackendQualifiedId } from '@/scm/registry/firstPartyScmBackendIdentity';
import type { ScmContributionCatalog } from '@/scm/registry/scmContributionCatalog';
import type {
    ScmBackendSettingsPlugin,
    ScmHostingProviderSettingsPlugin,
} from '@/scm/settings/scmBackendSettingsPlugin';

const scmBackendSettingsPlugins: readonly ScmBackendSettingsPlugin[] = [
    gitScmBackendSettingsPlugin,
    saplingScmBackendSettingsPlugin,
];

function buildBuiltInPluginMap() {
    const map = new Map<string, ScmBackendSettingsPlugin>();
    for (const plugin of scmBackendSettingsPlugins) {
        if (map.has(plugin.backendId)) {
            throw new Error(`Duplicate SCM backend settings plugin id: ${plugin.backendId}`);
        }
        map.set(plugin.backendId, plugin);
        const qualifiedId = getFirstPartyScmBackendQualifiedId(plugin.backendId);
        if (qualifiedId) {
            map.set(qualifiedId, { ...plugin, backendId: qualifiedId });
        }
    }
    return map;
}

const builtInPluginMap = buildBuiltInPluginMap();

export function createScmBackendSettingsRegistry(catalog: ScmContributionCatalog) {
    const plugins = catalog.backends.map((backend): ScmBackendSettingsPlugin => {
        const builtIn = builtInPluginMap.get(backend.id)
            ?? (backend.pluginId === null ? builtInPluginMap.get(backend.localId) : undefined);
        return builtIn
            ? { ...builtIn, backendId: backend.id, title: backend.title, description: backend.description || builtIn.description }
            : {
                backendId: backend.id,
                title: backend.title,
                description: backend.description,
                infoItems: [],
            };
    });
    const pluginMap = new Map(plugins.map((plugin) => [plugin.backendId, plugin]));
    const hostingProviders = catalog.hostingProviders.map((provider): ScmHostingProviderSettingsPlugin => ({
        providerId: provider.id,
        serviceId: provider.connectedServiceId,
        title: provider.title,
        description: provider.description,
        kind: provider.kind,
        authService: provider.authService,
    }));

    return {
        listPlugins(): readonly ScmBackendSettingsPlugin[] {
            return plugins;
        },
        listHostingProviders(): readonly ScmHostingProviderSettingsPlugin[] {
            return hostingProviders;
        },
        getPlugin(backendId: string | null | undefined): ScmBackendSettingsPlugin | null {
            if (!backendId) return null;
            return pluginMap.get(backendId) ?? null;
        },
        assertRegistryValid(): void {
            void buildBuiltInPluginMap();
        },
    };
}
