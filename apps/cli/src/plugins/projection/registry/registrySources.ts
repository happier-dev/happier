import { projectPluginRegistrySourceDeclarationV1 } from '@happier-dev/protocol/registries/registryPluginSourcesV1';
import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

export const registrySourcesProjectionFamily = definePluginProjectionFamilyV2({
    family: 'registrySources',
    project: ({ registry, pluginExecutionOriginsByPluginId }) => ({
        family: 'registrySources',
        entriesById: Object.freeze(Object.fromEntries((registry.registrySources ?? []).flatMap(entry => {
            if (!entry.pluginVersion) return [];
            const declaration = projectPluginRegistrySourceDeclarationV1({ pluginId: entry.pluginId,
                pluginVersion: entry.pluginVersion, definition: entry.definition });
            const origin = pluginExecutionOriginsByPluginId?.[entry.pluginId];
            const occurrenceId = registry.occurrenceIdsByPluginId?.[entry.pluginId];
            if ('packageContent' in entry.definition && !occurrenceId) return [];
            return [[declaration.id, Object.freeze({ ...declaration,
                ...(occurrenceId ? { occurrenceId } : {}),
                ...(origin ? { executionOrigin: origin } : {}) })]];
        }))),
    }),
});
