import {
    buildQualifiedPluginContributionKey,
    PluginProjectedAccountCollectionEntryV1Schema,
} from '@happier-dev/protocol';

import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
import type { ResolvedAccountCollectionContribution } from './types';

function accountCollectionProjectionKey(
    contribution: ResolvedAccountCollectionContribution,
): string {
    const { definition, identity, pluginId } = contribution;
    if (
        definition.pluginId !== pluginId
        || identity.pluginId !== pluginId
        || identity.localId !== definition.collectionId
    ) {
        throw new Error(`Account collection projection identity is inconsistent for '${pluginId}/${definition.collectionId}'`);
    }
    return buildQualifiedPluginContributionKey(identity);
}

/**
 * The static Data contract enters the common projection through one descriptor
 * family. This deliberately exposes only the normalized UI-query descriptors;
 * schema, storage, readiness, and runtime registration remain Data-owned.
 */
export const accountCollectionsProjectionFamily = definePluginProjectionFamilyV2({
    family: 'accountCollections',
    project({ registry }) {
        const entriesById: Record<string, ReturnType<typeof PluginProjectedAccountCollectionEntryV1Schema.parse>> = {};
        for (const contribution of registry.accountCollections ?? []) {
            const key = accountCollectionProjectionKey(contribution);
            if (entriesById[key]) {
                throw new Error(`Duplicate account collection projection '${key}'`);
            }
            const definition = contribution.definition;
            entriesById[key] = PluginProjectedAccountCollectionEntryV1Schema.parse({
                pluginId: definition.pluginId,
                collectionId: definition.collectionId,
                schemaVersion: definition.schemaVersion,
                contractDigest: definition.contractDigest,
                uiQueries: definition.uiQueries,
            });
        }
        return {
            family: 'accountCollections',
            entriesById,
        };
    },
});
