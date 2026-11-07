import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

export const botTemplatesProjectionFamily = definePluginProjectionFamilyV2({
    family: 'botTemplates',
    project: ({ registry }) => ({
        family: 'botTemplates',
        entriesById: Object.freeze(Object.fromEntries((registry.botTemplates ?? []).flatMap(entry => {
            if (!entry.pluginVersion) return [];
            const id = buildQualifiedPluginContributionKey(entry.identity);
            return [[id, Object.freeze({ id, pluginId: entry.pluginId, pluginVersion: entry.pluginVersion,
                definition: entry.definition })]];
        }))),
    }),
});
