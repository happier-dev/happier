import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

export const notificationCategoriesProjectionFamily = definePluginProjectionFamilyV2({
    family: 'notificationCategories',
    project: ({ registry }) => ({
        family: 'notificationCategories',
        entriesById: Object.freeze(Object.fromEntries((registry.notifications ?? []).flatMap(entry => {
            if (!entry.pluginId || !entry.pluginVersion) return [];
            const id = buildQualifiedPluginContributionKey({ pluginId: entry.pluginId, localId: entry.definition.id });
            return [[id, Object.freeze({ id, pluginId: entry.pluginId,
                pluginVersion: entry.pluginVersion, definition: entry.definition })]];
        }))),
    }),
});
