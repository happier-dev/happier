import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

export const themesProjectionFamily = definePluginProjectionFamilyV2({
    family: 'themes',
    project: ({ registry, pluginExecutionOriginsByPluginId }) => ({
        family: 'themes',
        entriesById: Object.freeze(Object.fromEntries((registry.themes ?? []).flatMap(entry => {
            if (!entry.pluginVersion) return [];
            const id = buildQualifiedPluginContributionKey(entry.identity);
            const origin = pluginExecutionOriginsByPluginId?.[entry.pluginId];
            return [[id, Object.freeze({ id, pluginId: entry.pluginId, pluginVersion: entry.pluginVersion,
                definition: entry.definition, ...(entry.pluginName ? { pluginName: entry.pluginName } : {}), ...(origin ? { executionOrigin: origin } : {}) })]];
        }))),
    }),
});
