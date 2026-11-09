import { expect } from "vitest";
import { nextPluginCollectionIndexPrefixV1 } from "@happier-dev/protocol/plugins/data/collectionsV1";

import { readPluginsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { inTx } from "@/storage/inTx";

import { readMaterializedPluginCollectionContract } from "./contracts";
import { readPluginCollectionAccountUsageInTx } from "./quota";
import { countPluginCollectionIndexEntriesByRawOrdinalKey } from "./rawOrdinalIndex";
import { readPluginCollectionQuotaPrefixCount, resolvePluginCollectionDeclaredQuotaPrefixes } from "./usageTotals";

/** Independent full-row/raw-index oracle for persisted usage maintenance tests. */
export async function assertPluginCollectionUsageTotalsMatchRows(accountId: string): Promise<void> {
    await inTx(async tx => {
        const census = await readPluginCollectionAccountUsageInTx({
            tx, accountId, deployment: readPluginsFeatureEnv(process.env).collectionLimits,
        });
        const account = await tx.account.findUniqueOrThrow({ where: { id: accountId },
            select: { pluginCollectionRows: true, pluginCollectionEncodedBytes: true } });
        expect(account).toEqual({ pluginCollectionRows: BigInt(census.rows),
            pluginCollectionEncodedBytes: BigInt(census.encodedBytes) });

        const collections = await tx.pluginCollectionUsage.findMany({ where: { accountId } });
        const collectionKeys = new Set(census.collections.keys());
        for (const usage of collections) {
            const key = `${usage.pluginId}\u0000${usage.collectionId}`;
            const expected = census.collections.get(key);
            expect({ rows: usage.rows, encodedBytes: usage.encodedBytes }).toEqual({
                rows: BigInt(expected?.rows ?? 0), encodedBytes: BigInt(expected?.encodedBytes ?? 0),
            });
            collectionKeys.delete(key);
        }
        expect([...collectionKeys]).toEqual([]);

        const memberships = await tx.pluginCollectionRow.groupBy({
            by: ["contractId"], where: { accountId, deletedAt: null }, _count: { _all: true },
        });
        const expectedMemberships = new Map(memberships.map(row => [row.contractId, BigInt(row._count._all)]));
        const storedMemberships = await tx.pluginCollectionContractUsage.findMany({ where: { accountId } });
        for (const usage of storedMemberships) {
            expect(usage.rows).toBe(expectedMemberships.get(usage.contractId) ?? 0n);
            expectedMemberships.delete(usage.contractId);
        }
        expect([...expectedMemberships]).toEqual([]);

        const states = await tx.pluginCollectionIndexState.findMany({ where: { accountId }, include: { contract: true } });
        for (const state of states) {
            const prefixes = resolvePluginCollectionDeclaredQuotaPrefixes({
                contract: readMaterializedPluginCollectionContract(state.contract),
            }).filter(prefix => prefix.indexId === state.indexId);
            for (const prefix of prefixes) {
                const upper = nextPluginCollectionIndexPrefixV1(prefix.encodedPrefix);
                const count = await countPluginCollectionIndexEntriesByRawOrdinalKey({
                    tx, indexStateId: state.id,
                    bounds: { lower: prefix.encodedPrefix, ...(upper ? { upper } : {}) },
                });
                expect(count).not.toBeNull();
                expect(BigInt(readPluginCollectionQuotaPrefixCount(state.quotaPrefixCounts, prefix.key))).toBe(count);
            }
        }
    });
}
