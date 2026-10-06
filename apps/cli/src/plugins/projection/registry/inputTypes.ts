import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

/** Type declarations share the same projection and occurrence retirement as their leaves. */
export const inputTypesProjectionFamily = definePluginProjectionFamilyV2({
    family: 'inputTypes',
    project: ({ registry, pluginExecutionOriginsByPluginId }) => ({
        family: 'inputTypes',
        entriesById: Object.freeze(Object.fromEntries((registry.inputTypes ?? []).flatMap((entry) => {
            if (!entry.pluginVersion) return [];
            const key = buildQualifiedPluginContributionKey(entry.identity);
            const origin = pluginExecutionOriginsByPluginId?.[entry.pluginId];
            return [[key, Object.freeze({ id: key, pluginId: entry.pluginId,
                pluginVersion: entry.pluginVersion, definition: entry.definition,
                ...(origin ? { serverIdentityId: origin.serverIdentityId,
                    materializationRef: origin.materializationRef } : {}) })]];
        }))),
    }),
});
