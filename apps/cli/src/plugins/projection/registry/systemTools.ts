import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

/** Machine CLI discovery consumes the current registry's public declarations. */
export const systemToolsProjectionFamily = definePluginProjectionFamilyV2({
    family: 'systemTools',
    project: ({ registry }) => ({
        family: 'systemTools',
        entriesById: Object.freeze(Object.fromEntries((registry.systemTools ?? []).flatMap(entry => {
            if (!entry.pluginId) return [];
            const id = buildQualifiedPluginContributionKey({ pluginId: entry.pluginId, localId: entry.definition.id });
            return [[id, Object.freeze({ id, pluginId: entry.pluginId, definition: entry.definition })]];
        }))),
    }),
});
