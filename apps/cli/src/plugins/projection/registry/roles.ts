import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginRoleContributionV1 } from '@happier-dev/protocol';
import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
import type { ResolvedContributionRegistry } from './types';

/** Role sources share the current occurrence facts with the client projection. */
export function readPluginRoleSources(registry: ResolvedContributionRegistry): readonly PluginRoleContributionV1[] {
    return (registry.roles ?? []).flatMap((entry) => {
        if (!registry.occurrenceIdsByPluginId?.[entry.pluginId]) return [];
        const { id: localId, ...role } = entry.definition;
        return [{ pluginId: entry.pluginId, ...(entry.displayName ? { pluginDisplayName: entry.displayName } : {}), localId, role }];
    });
}

export const rolesProjectionFamily = definePluginProjectionFamilyV2({
    family: 'roles',
    project: ({ registry }) => ({
        family: 'roles',
        entriesById: Object.freeze(Object.fromEntries((registry.roles ?? []).map((entry) => {
            const key = buildQualifiedPluginContributionKey(entry.identity);
            return [key, Object.freeze({ id: key, pluginId: entry.pluginId, definition: entry.definition })];
        }))),
    }),
});
