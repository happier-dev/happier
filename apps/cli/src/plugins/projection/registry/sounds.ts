import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

export const soundsProjectionFamily = definePluginProjectionFamilyV2({
    family: 'sounds',
    project: ({ registry, pluginExecutionOriginsByPluginId }) => ({
        family: 'sounds',
        entriesById: Object.freeze(Object.fromEntries((registry.sounds ?? []).flatMap(entry => {
            if (!entry.pluginVersion) return [];
            const id = buildQualifiedPluginContributionKey(entry.identity);
            const origin = pluginExecutionOriginsByPluginId?.[entry.pluginId];
            return [[id, Object.freeze({ id, pluginId: entry.pluginId, pluginVersion: entry.pluginVersion,
                definition: entry.definition, ...(origin ? { executionOrigin: origin } : {}) })]];
        }))),
    }),
});
