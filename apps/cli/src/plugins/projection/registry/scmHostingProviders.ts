import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

export const scmHostingProviderProjectionFamily = definePluginProjectionFamilyV2({
    family: 'scmHostingProviders',
    project({ registry }) {
        return {
            family: 'scmHostingProviders',
            entriesById: Object.fromEntries(
                [...(registry.scmHostingProviders ?? [])]
                    .sort((left, right) => left.id.localeCompare(right.id))
                    .map((provider) => [
                        provider.id,
                        {
                            id: provider.id,
                            pluginId: provider.pluginId,
                            kind: provider.definition.kind,
                            displayName: provider.definition.displayName,
                            baseUrl: provider.definition.baseUrl,
                            urlSafety: provider.definition.urlSafety,
                        },
                    ]),
            ),
        };
    },
});
