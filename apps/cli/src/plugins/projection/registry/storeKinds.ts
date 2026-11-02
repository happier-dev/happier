import { projectPluginStoreKindDeclarationV1 } from '@happier-dev/protocol';
import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

/** Cold declarations reuse their supplying occurrence; invocation remains Action-owned. */
export const storeKindsProjectionFamily = definePluginProjectionFamilyV2({
    family: 'storeKinds',
    project: ({ registry, pluginExecutionOriginsByPluginId }) => ({
        family: 'storeKinds',
        entriesById: Object.freeze(Object.fromEntries((registry.storeKinds ?? []).flatMap(entry => {
            if (!entry.pluginVersion) return [];
            const declaration = projectPluginStoreKindDeclarationV1({ pluginId: entry.pluginId,
                pluginVersion: entry.pluginVersion, definition: entry.definition });
            const origin = pluginExecutionOriginsByPluginId?.[entry.pluginId];
            return [[declaration.id, Object.freeze({ ...declaration,
                ...(origin ? { executionOrigin: origin } : {}) })]];
        }))),
    }),
});
