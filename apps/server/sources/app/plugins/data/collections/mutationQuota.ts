import type { NormalizedPluginAccountCollectionContractV1, PluginCollectionProjectionV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import type { PluginDataCollectionsCapabilities } from '@happier-dev/protocol/features/payload/capabilities/pluginDataCollectionsCapabilities';
import type { Tx } from '@/storage/inTx';

import { readMaterializedPluginCollectionContract } from './contracts';
import type { ResolvedWritableCollection } from './mutation';
import {
    findPluginCollectionMutationQuotaIncompatibility,
    PluginCollectionQuotaCensusInconsistencyError,
    readPluginCollectionPrefixQuotaTransitionInTx,
    type PluginCollectionAccountUsage,
    type PluginCollectionPrefixQuotaPolicy,
    type PluginCollectionQuotaPolicy,
} from './quota';
import {
    applyPluginCollectionUsageDeltaInTx,
    buildPluginCollectionUsageSnapshot,
    capturePluginCollectionUsageInTx,
    createPluginCollectionUsageDelta,
    derivePluginCollectionMutationUsage,
    mergePluginCollectionUsageSnapshots,
    readPluginCollectionMutationUsageInTx,
    type PluginCollectionUsageSnapshot,
} from './usageTotals';

type ChangedCollectionRows = Readonly<{ pluginId: string; collectionId: string; rowIds: readonly string[] }>;

export type PluginCollectionQuotaRowWrite = Readonly<{
    resolved: ResolvedWritableCollection;
    rowId: string;
    contentEnvelope: unknown;
    projection: PluginCollectionProjectionV1 | null;
    indexEntries: PluginCollectionUsageSnapshot['indexEntries'];
}>;

function collectQuotaPolicies(input: Readonly<{
    usage: PluginCollectionAccountUsage;
    resolved: readonly ResolvedWritableCollection[];
}>): Readonly<{
    collections: readonly PluginCollectionQuotaPolicy[];
    prefixes: readonly PluginCollectionPrefixQuotaPolicy[];
}> {
    const contracts = new Map<string, Readonly<{ id: string; contract: NormalizedPluginAccountCollectionContractV1 }>>();
    const add = (candidate: Readonly<{ id: string; contract: NormalizedPluginAccountCollectionContractV1 }>): void => {
        const identity = `${candidate.contract.pluginId}\u0000${candidate.contract.collectionId}\u0000${candidate.contract.contractDigest}`;
        const existing = contracts.get(identity);
        if (existing && existing.id !== candidate.id) {
            throw new PluginCollectionQuotaCensusInconsistencyError('Collection quota policy has two immutable contract records for one digest.');
        }
        contracts.set(identity, candidate);
    };
    for (const persisted of input.usage.contracts.values()) {
        add({ id: persisted.id, contract: readMaterializedPluginCollectionContract(
            persisted as Parameters<typeof readMaterializedPluginCollectionContract>[0],
        ) });
    }
    for (const current of input.resolved) add({ id: current.contractId, contract: current.contract });
    const materialized = [...contracts.values()].sort((left, right) => (
        left.contract.pluginId.localeCompare(right.contract.pluginId)
        || left.contract.collectionId.localeCompare(right.contract.collectionId)
        || left.contract.contractDigest.localeCompare(right.contract.contractDigest)
    ));
    return {
        collections: materialized.map(({ contract }) => ({ pluginId: contract.pluginId, collectionId: contract.collectionId, quota: contract.quota })),
        prefixes: materialized.map(({ id, contract }) => ({ pluginId: contract.pluginId, collectionId: contract.collectionId,
            contractId: id, contractDigest: contract.contractDigest, quota: contract.quota, schema: contract.schema, indexes: contract.indexes })),
    };
}

/** One transaction's changed-row evidence; the persisted totals remain the before
 * facts until every row/relation effect has settled and the single delta applies. */
export function createPluginCollectionMutationQuotaInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    deployment: PluginDataCollectionsCapabilities;
}>) {
    const captured = new Set<string>();
    const snapshots: PluginCollectionUsageSnapshot[] = [];
    const written = new Map<string, PluginCollectionUsageSnapshot>();
    return {
        async captureBefore(collections: readonly (ChangedCollectionRows & Readonly<{ indexStateIds: readonly string[] }>)[]): Promise<void> {
            const unseen = collections.map(group => ({ ...group, rowIds: group.rowIds.filter(rowId => {
                const key = `${group.pluginId}\u0000${group.collectionId}\u0000${rowId}`;
                if (captured.has(key)) return false;
                captured.add(key);
                return true;
            }) })).filter(group => group.rowIds.length > 0);
            if (unseen.length > 0) snapshots.push(await capturePluginCollectionUsageInTx({ ...input, collections: unseen }));
        },
        recordAfter(change: PluginCollectionQuotaRowWrite): void {
            const { contract, contractId } = change.resolved;
            const projection = change.projection;
            const key = `${contract.pluginId}\u0000${contract.collectionId}\u0000${change.rowId}`;
            written.set(key, buildPluginCollectionUsageSnapshot({
                rows: projection === null ? [] : [{ pluginId: contract.pluginId, collectionId: contract.collectionId,
                    rowId: change.rowId, contractId, contentEnvelope: change.contentEnvelope,
                    projections: contract.serverReadable.map(fieldId => ({ fieldId,
                        typedEncodedValue: JSON.stringify(projection[fieldId]),
                    })),
                }],
                indexEntries: change.indexEntries,
            }));
        },
        async check(changes: Readonly<{ resolved: readonly ResolvedWritableCollection[]; changedRows: readonly ChangedCollectionRows[] }>) {
            const beforeRows = mergePluginCollectionUsageSnapshots(...snapshots);
            const afterRows = mergePluginCollectionUsageSnapshots(...written.values());
            const delta = createPluginCollectionUsageDelta({ before: beforeRows, after: afterRows });
            const before = await readPluginCollectionMutationUsageInTx({ ...input, changedRows: beforeRows });
            const after = derivePluginCollectionMutationUsage({ before, delta });
            const policies = collectQuotaPolicies({ usage: before, resolved: changes.resolved });
            const prefix = await readPluginCollectionPrefixQuotaTransitionInTx({ ...input, before, after,
                policies: policies.prefixes, delta });
            await applyPluginCollectionUsageDeltaInTx({ ...input, delta, indexUsage: prefix.indexUsage });
            return findPluginCollectionMutationQuotaIncompatibility({ deployment: input.deployment, before, after,
                collections: policies.collections, changedRows: changes.changedRows, beforePrefixUsage: prefix.before, afterPrefixUsage: prefix.after });
        },
    };
}
