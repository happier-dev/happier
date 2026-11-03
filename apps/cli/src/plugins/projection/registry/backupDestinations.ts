import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

/** Cold declarations share their supplying occurrence's existing retirement boundary. */
export const backupDestinationsProjectionFamily = definePluginProjectionFamilyV2({
    family: 'backupDestinations',
    project: ({ registry, pluginExecutionOriginsByPluginId }) => ({
        family: 'backupDestinations',
        entriesById: Object.freeze(Object.fromEntries((registry.backupDestinations ?? []).flatMap(entry => {
            if (!entry.pluginVersion) return [];
            const key = buildQualifiedPluginContributionKey(entry.identity);
            const origin = pluginExecutionOriginsByPluginId?.[entry.pluginId];
            return [[key, Object.freeze({ id: key, pluginId: entry.pluginId,
                pluginVersion: entry.pluginVersion, definition: entry.definition,
                ...(origin ? { executionOrigin: origin } : {}) })]];
        }))),
    }),
});
