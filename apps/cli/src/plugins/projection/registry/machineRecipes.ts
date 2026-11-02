import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
import type { PluginProjectionInstalledPackageV2 } from '@happier-dev/protocol';
import { projectPluginContributionSource } from './projection/sourceMetadata';

/** Cold immutable setup data follows its supplying occurrence's normal retirement. */
export const machineRecipesProjectionFamily = definePluginProjectionFamilyV2({
    family: 'machineRecipes',
    project: ({ registry, pluginExecutionOriginsByPluginId, machineRecipeRefs, readPluginBrandAsset }) => {
        const metadataByPluginId = new Map<string, Pick<PluginProjectionInstalledPackageV2, 'source' | 'brand'>>();
        return { family: 'machineRecipes',
            entriesById: Object.freeze(Object.fromEntries((machineRecipeRefs?.length === 0 ? [] : registry.machineRecipes ?? []).flatMap(entry => {
            if (!entry.pluginVersion) return [];
            const key = buildQualifiedPluginContributionKey(entry.identity);
            if (machineRecipeRefs !== undefined && !machineRecipeRefs.some(ref => (
                ref.pluginId === entry.pluginId && ref.recipeId === entry.identity.localId
                && ref.revision === entry.definition.revision
            ))) return [];
            let metadata = metadataByPluginId.get(entry.pluginId);
            if (!metadata) {
                const declaration = registry.pluginDeclarations?.find(candidate => candidate.pluginId === entry.pluginId);
                const source = projectPluginContributionSource({ pluginId: entry.pluginId, sourceKind: entry.source.kind,
                    manifestPath: entry.manifestPath, sourceSpec: declaration?.sourceSpec });
                const brand = readPluginBrandAsset?.(entry.pluginId);
                metadata = { source, ...(brand ? { brand } : {}) };
                metadataByPluginId.set(entry.pluginId, metadata);
            }
            const origin = pluginExecutionOriginsByPluginId?.[entry.pluginId];
            return [[key, Object.freeze({ id: key, pluginId: entry.pluginId,
                pluginVersion: entry.pluginVersion, ...metadata, definition: entry.definition,
                ...(origin ? { executionOrigin: origin } : {}) })]];
            }))),
        };
    },
});

export const machineSetupPresetsProjectionFamily = definePluginProjectionFamilyV2({
    family: 'machineSetupPresets',
    project: ({ registry, pluginExecutionOriginsByPluginId }) => ({
        family: 'machineSetupPresets',
        entriesById: Object.freeze(Object.fromEntries((registry.machineSetupPresets ?? []).flatMap(entry => {
            if (!entry.pluginVersion) return [];
            const key = buildQualifiedPluginContributionKey(entry.identity);
            const origin = pluginExecutionOriginsByPluginId?.[entry.pluginId];
            return [[key, Object.freeze({ id: key, pluginId: entry.pluginId,
                pluginVersion: entry.pluginVersion, definition: entry.definition,
                ...(origin ? { executionOrigin: origin } : {}) })]];
        }))),
    }),
});
