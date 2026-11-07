import { encodePluginCollectionIndexTuplePrefixV1, getPluginCollectionScalarKindV1, type NormalizedPluginAccountCollectionContractV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type { Tx } from '@/storage/inTx';
import { readMaterializedPluginCollectionContract } from './contracts';
import { measurePluginCollectionStoredRowEncodedBytes, PluginCollectionQuotaCensusInconsistencyError } from './storedRowUsage';
import type { PluginCollectionAccountUsage, PluginCollectionPersistedContractForQuota, PluginCollectionUsage, PluginCollectionPrefixQuotaPolicy } from './quota';

export interface PluginCollectionUsageSnapshot {
    readonly rows: readonly Readonly<{ pluginId: string; collectionId: string; rowId: string; contractId: string; encodedBytes: number }>[];
    readonly indexEntries: readonly Readonly<{ indexStateId: string; encodedSortKey: Uint8Array }>[];
}

export interface PluginCollectionDeclaredQuotaPrefix {
    readonly indexId: string;
    readonly prefix: readonly unknown[];
    readonly maxRows: number;
    readonly encodedPrefix: Uint8Array;
    readonly key: string;
}

export interface PluginCollectionUsageDelta {
    readonly rows: bigint;
    readonly encodedBytes: bigint;
    readonly collections: ReadonlyMap<string, Readonly<{ pluginId: string; collectionId: string; rows: bigint; encodedBytes: bigint }>>;
    readonly contracts: ReadonlyMap<string, bigint>;
    readonly before: PluginCollectionUsageSnapshot;
    readonly after: PluginCollectionUsageSnapshot;
}

export interface PluginCollectionIndexUsageTransition {
    readonly id: string;
    readonly pluginId: string;
    readonly collectionId: string;
    readonly indexId: string;
    readonly contractId: string;
    readonly contractDigest: string;
    readonly buildState: string;
    readonly indexedThroughRevision: number | null;
    readonly beforePrefixCounts: Readonly<Record<string, number>>;
    readonly afterPrefixCounts: Readonly<Record<string, number>>;
    readonly changed: boolean;
}

function collectionKey(pluginId: string, collectionId: string): string {
    return `${pluginId}\u0000${collectionId}`;
}

function hex(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('hex');
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
    return prefix.length <= bytes.length && prefix.every((value, position) => bytes[position] === value);
}

function number(value: bigint): number {
    const result = Number(value);
    if (!Number.isSafeInteger(result)) throw new PluginCollectionQuotaCensusInconsistencyError('Collection usage is not safely representable.');
    return result;
}

/** The immutable contract owns prefix encoding; readers and delta writers share these keys. */
export function resolvePluginCollectionDeclaredQuotaPrefixes(input: Readonly<{ contract: Pick<NormalizedPluginAccountCollectionContractV1, 'quota' | 'schema' | 'indexes'> }>): readonly PluginCollectionDeclaredQuotaPrefix[] {
    return (input.contract.quota?.maxRowsByIndexPrefix ?? []).map(quota => {
        const index = input.contract.indexes.find(index => index.id === quota.indexId);
        if (!index || quota.prefix.length > index.fields.length) {
            throw new PluginCollectionQuotaCensusInconsistencyError('Collection prefix quota exceeds its index.');
        }
        let encodedPrefix: Uint8Array;
        try {
            encodedPrefix = encodePluginCollectionIndexTuplePrefixV1({ fields: quota.prefix.map((value, position) => {
                const field = index.fields[position]!;
                return { kind: getPluginCollectionScalarKindV1({ schema: input.contract.schema, field: field.field }), value, direction: field.direction };
            }) });
        } catch {
            throw new PluginCollectionQuotaCensusInconsistencyError('Collection prefix quota is inconsistent with its immutable contract.');
        }
        return { ...quota, encodedPrefix, key: hex(encodedPrefix) };
    });
}

export function readPluginCollectionQuotaPrefixCount(counts: unknown, key: string): number {
    if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) {
        throw new PluginCollectionQuotaCensusInconsistencyError('Collection prefix quota counts are inconsistent.');
    }
    const value = (counts as Record<string, unknown>)[key] ?? 0;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new PluginCollectionQuotaCensusInconsistencyError('Collection prefix quota count is not safely representable.');
    }
    return value;
}

export function buildPluginCollectionUsageSnapshot(input: Readonly<{
    rows: readonly Readonly<{ pluginId: string; collectionId: string; rowId: string; contractId: string; contentEnvelope: unknown; projections: readonly Readonly<{ fieldId: string; typedEncodedValue: string }>[] }>[];
    indexEntries?: PluginCollectionUsageSnapshot['indexEntries'];
}>): PluginCollectionUsageSnapshot {
    return { rows: input.rows.map(row => ({ pluginId: row.pluginId, collectionId: row.collectionId, rowId: row.rowId,
        contractId: row.contractId, encodedBytes: measurePluginCollectionStoredRowEncodedBytes(row) })), indexEntries: input.indexEntries ?? [] };
}

/** Combine disjoint row groups; the mutation owner captures each identity only once before effects. */
export function mergePluginCollectionUsageSnapshots(...snapshots: readonly PluginCollectionUsageSnapshot[]): PluginCollectionUsageSnapshot {
    const rows = new Map<string, PluginCollectionUsageSnapshot['rows'][number]>();
    const entries = new Map<string, PluginCollectionUsageSnapshot['indexEntries'][number]>();
    for (const snapshot of snapshots) {
        for (const row of snapshot.rows) {
            const key = `${collectionKey(row.pluginId, row.collectionId)}\u0000${row.rowId}`;
            if (!rows.has(key)) rows.set(key, row);
        }
        for (const entry of snapshot.indexEntries) {
            const key = `${entry.indexStateId}\u0000${hex(entry.encodedSortKey)}`;
            if (!entries.has(key)) entries.set(key, entry);
        }
    }
    return { rows: [...rows.values()], indexEntries: [...entries.values()] };
}

export async function capturePluginCollectionUsageInTx(input: Readonly<{
    tx: Tx; accountId: string; collections: readonly Readonly<{
        pluginId: string; collectionId: string; rowIds: readonly string[];
        /** Omitted for an all-state lifecycle snapshot; an empty list captures no entries. */
        indexStateIds?: readonly string[];
    }>[];
}>): Promise<PluginCollectionUsageSnapshot> {
    const collections = input.collections.filter(group => group.rowIds.length > 0);
    if (collections.length === 0) return { rows: [], indexEntries: [] };
    const rows = await input.tx.pluginCollectionRow.findMany({
        where: { accountId: input.accountId, deletedAt: null, OR: collections.map(group => ({
            pluginId: group.pluginId, collectionId: group.collectionId, rowId: { in: [...group.rowIds] },
        })) },
        select: { pluginId: true, collectionId: true, rowId: true, contractId: true, contentEnvelope: true,
            projections: { select: { fieldId: true, typedEncodedValue: true } } },
    });
    const entryCollections = collections.filter(group => group.indexStateIds === undefined || group.indexStateIds.length > 0);
    const indexEntries = entryCollections.length === 0 ? [] : await input.tx.pluginCollectionIndexEntry.findMany({
        where: { OR: entryCollections.map(group => ({ rowId: { in: [...group.rowIds] },
            ...(group.indexStateIds === undefined ? {} : { indexStateId: { in: [...group.indexStateIds] } }),
            indexState: { accountId: input.accountId, pluginId: group.pluginId, collectionId: group.collectionId },
        })) },
        select: { indexStateId: true, encodedSortKey: true },
    });
    return buildPluginCollectionUsageSnapshot({ rows, indexEntries });
}

export async function transferPluginCollectionUsageContractInTx(input: Readonly<{
    tx: Tx; accountId: string; fromContractId: string; toContractId: string; rows: number;
}>): Promise<void> {
    if (input.rows === 0 || input.fromContractId === input.toContractId) return;
    for (const [contractId, delta] of [[input.fromContractId, -input.rows], [input.toContractId, input.rows]] as const) {
        await input.tx.pluginCollectionContractUsage.upsert({
            where: { accountId_contractId: { accountId: input.accountId, contractId } },
            create: { accountId: input.accountId, contractId, rows: BigInt(delta) },
            update: { rows: { increment: BigInt(delta) } },
        });
    }
}

export function createPluginCollectionUsageDelta(input: Readonly<{
    before: PluginCollectionUsageSnapshot; after: PluginCollectionUsageSnapshot;
}>): PluginCollectionUsageDelta {
    const collections = new Map<string, { pluginId: string; collectionId: string; rows: bigint; encodedBytes: bigint }>();
    const contracts = new Map<string, bigint>();
    let rows = 0n;
    let encodedBytes = 0n;
    for (const [snapshot, sign] of [[input.before, -1n], [input.after, 1n]] as const) {
        for (const row of snapshot.rows) {
            const key = collectionKey(row.pluginId, row.collectionId);
            const collection = collections.get(key) ?? { pluginId: row.pluginId, collectionId: row.collectionId, rows: 0n, encodedBytes: 0n };
            collection.rows += sign;
            collection.encodedBytes += sign * BigInt(row.encodedBytes);
            collections.set(key, collection);
            contracts.set(row.contractId, (contracts.get(row.contractId) ?? 0n) + sign);
            rows += sign;
            encodedBytes += sign * BigInt(row.encodedBytes);
        }
    }
    return { rows, encodedBytes, collections, contracts, before: input.before, after: input.after };
}

function rowMapsForSnapshot(snapshot: PluginCollectionUsageSnapshot): ReadonlyMap<string, ReadonlyMap<string, number>> {
    const maps = new Map<string, Map<string, number>>();
    for (const row of snapshot.rows) {
        const key = collectionKey(row.pluginId, row.collectionId);
        const map = maps.get(key) ?? new Map<string, number>();
        map.set(row.rowId, row.encodedBytes);
        maps.set(key, map);
    }
    return maps;
}

/** Derives the exact after facts from one retained baseline and canonical writes. */
export function derivePluginCollectionMutationUsage(input: Readonly<{
    before: PluginCollectionAccountUsage; delta: PluginCollectionUsageDelta;
}>): Pick<PluginCollectionAccountUsage, 'rows' | 'encodedBytes' | 'collections'> {
    const rowMaps = rowMapsForSnapshot(input.delta.after);
    const collections = new Map<string, PluginCollectionUsage>();
    for (const [key, usage] of input.before.collections) {
        collections.set(key, { ...usage, rowEncodedBytesByRowId: rowMaps.get(key) ?? new Map() });
    }
    for (const [key, delta] of input.delta.collections) {
        const before = input.before.collections.get(key);
        collections.set(key, { rows: number(BigInt(before?.rows ?? 0) + delta.rows),
            encodedBytes: number(BigInt(before?.encodedBytes ?? 0) + delta.encodedBytes),
            rowEncodedBytesByRowId: rowMaps.get(key) ?? new Map() });
    }
    return { rows: number(BigInt(input.before.rows) + input.delta.rows),
        encodedBytes: number(BigInt(input.before.encodedBytes) + input.delta.encodedBytes), collections };
}

/** Loads each needed state once, before any counter write, and computes exact prefix transitions. */
export async function readPluginCollectionIndexUsageTransitionInTx(input: Readonly<{
    tx: Tx; accountId: string; delta: PluginCollectionUsageDelta; policies?: readonly PluginCollectionPrefixQuotaPolicy[];
}>): Promise<readonly PluginCollectionIndexUsageTransition[]> {
    const stateIds = [...new Set([...input.delta.before.indexEntries, ...input.delta.after.indexEntries].map(entry => entry.indexStateId))];
    const policies = (input.policies ?? []).filter(policy => (policy.quota?.maxRowsByIndexPrefix?.length ?? 0) > 0);
    if (stateIds.length === 0 && policies.length === 0) return [];
    const states = await input.tx.pluginCollectionIndexState.findMany({ where: { accountId: input.accountId, OR: [
        { id: { in: stateIds } }, ...policies.map(policy => ({ pluginId: policy.pluginId, collectionId: policy.collectionId,
            contractDigest: policy.contractDigest, indexId: { in: policy.quota!.maxRowsByIndexPrefix!.map(prefix => prefix.indexId) } })),
    ] }, include: { contract: true } });
    return states.map(state => {
        const prefixes = resolvePluginCollectionDeclaredQuotaPrefixes({ contract: readMaterializedPluginCollectionContract(state.contract) })
            .filter(prefix => prefix.indexId === state.indexId);
        const beforePrefixCounts: Record<string, number> = {};
        const afterPrefixCounts: Record<string, number> = {};
        let changed = false;
        for (const prefix of prefixes) {
            let delta = 0;
            for (const entry of input.delta.before.indexEntries) if (entry.indexStateId === state.id && startsWith(entry.encodedSortKey, prefix.encodedPrefix)) delta -= 1;
            for (const entry of input.delta.after.indexEntries) if (entry.indexStateId === state.id && startsWith(entry.encodedSortKey, prefix.encodedPrefix)) delta += 1;
            beforePrefixCounts[prefix.key] = readPluginCollectionQuotaPrefixCount(state.quotaPrefixCounts, prefix.key);
            afterPrefixCounts[prefix.key] = beforePrefixCounts[prefix.key]! + delta;
            changed ||= delta !== 0;
        }
        return { id: state.id, pluginId: state.pluginId, collectionId: state.collectionId, indexId: state.indexId,
            contractId: state.contractId, contractDigest: state.contractDigest, buildState: state.buildState,
            indexedThroughRevision: state.indexedThroughRevision, beforePrefixCounts, afterPrefixCounts, changed };
    });
}

/** Caller holds the existing Account fence; rows, indexes, and these totals commit together. */
export async function applyPluginCollectionUsageDeltaInTx(input: Readonly<{
    tx: Tx; accountId: string; delta: PluginCollectionUsageDelta; indexUsage?: readonly PluginCollectionIndexUsageTransition[];
}>): Promise<void> {
    const { rows, encodedBytes, collections, contracts } = input.delta;
    const indexUsage = input.indexUsage ?? await readPluginCollectionIndexUsageTransitionInTx(input);
    if (rows !== 0n || encodedBytes !== 0n) await input.tx.account.update({ where: { id: input.accountId }, data: {
        pluginCollectionRows: { increment: rows }, pluginCollectionEncodedBytes: { increment: encodedBytes },
    } });
    for (const value of collections.values()) {
        if (value.rows === 0n && value.encodedBytes === 0n) continue;
        const identity = { accountId: input.accountId, pluginId: value.pluginId, collectionId: value.collectionId };
        await input.tx.pluginCollectionUsage.upsert({ where: { accountId_pluginId_collectionId: identity },
            create: { ...identity, rows: value.rows, encodedBytes: value.encodedBytes },
            update: { rows: { increment: value.rows }, encodedBytes: { increment: value.encodedBytes } },
        });
    }
    for (const [contractId, delta] of contracts) {
        if (delta === 0n) continue;
        const identity = { accountId: input.accountId, contractId };
        await input.tx.pluginCollectionContractUsage.upsert({ where: { accountId_contractId: identity },
            create: { ...identity, rows: delta }, update: { rows: { increment: delta } },
        });
    }
    for (const state of indexUsage) {
        if (state.changed) await input.tx.pluginCollectionIndexState.update({ where: { id: state.id }, data: { quotaPrefixCounts: { ...state.afterPrefixCounts } } });
    }
}

/** Reads aggregate facts plus only the changed rows needed by monotonic per-row checks. */
export async function readPluginCollectionMutationUsageInTx(input: Readonly<{
    tx: Tx; accountId: string; changedRows: PluginCollectionUsageSnapshot;
}>): Promise<PluginCollectionAccountUsage> {
    const account = await input.tx.account.findUniqueOrThrow({ where: { id: input.accountId }, select: { pluginCollectionRows: true, pluginCollectionEncodedBytes: true } });
    const stored = await input.tx.pluginCollectionUsage.findMany({ where: { accountId: input.accountId } });
    const membership = await input.tx.pluginCollectionContractUsage.findMany({ where: { accountId: input.accountId, rows: { gt: 0n } }, include: { contract: true } });
    const rowMaps = rowMapsForSnapshot(input.changedRows);
    const collections = new Map<string, PluginCollectionUsage>(stored.map(value => {
        const key = collectionKey(value.pluginId, value.collectionId);
        return [key, { rows: number(value.rows), encodedBytes: number(value.encodedBytes), rowEncodedBytesByRowId: rowMaps.get(key) ?? new Map() }];
    }));
    const contracts = new Map<string, PluginCollectionPersistedContractForQuota>(membership.map(value => [value.contractId, value.contract]));
    return { rows: number(account.pluginCollectionRows), encodedBytes: number(account.pluginCollectionEncodedBytes), collections, contracts };
}

type PluginCollectionIndexUsageScope = Readonly<{
    tx: Tx; accountId: string; indexStateIds: readonly string[];
}>;

async function readIndexUsageSummariesInTx(input: PluginCollectionIndexUsageScope) {
    if (input.indexStateIds.length === 0) return [];
    const states = await input.tx.pluginCollectionIndexState.findMany({ where: { accountId: input.accountId, id: { in: [...input.indexStateIds] } }, include: { contract: true } });
    return states.map(state => {
        const prefixes = resolvePluginCollectionDeclaredQuotaPrefixes({ contract: readMaterializedPluginCollectionContract(state.contract) }).filter(prefix => prefix.indexId === state.indexId);
        const counts: Record<string, number> = Object.fromEntries(prefixes.map(prefix => [prefix.key, 0]));
        return { id: state.id, previousCounts: state.quotaPrefixCounts, prefixes, counts };
    });
}

async function publishIndexUsageSummaryInTx(tx: Tx, summary: Awaited<ReturnType<typeof readIndexUsageSummariesInTx>>[number]): Promise<void> {
    if (!pluginJsonValuesEqual(summary.previousCounts, summary.counts)) {
        await tx.pluginCollectionIndexState.update({ where: { id: summary.id }, data: { quotaPrefixCounts: summary.counts } });
    }
}

/** The caller has cleared every entry in these states; no readback is needed. */
export async function resetPluginCollectionIndexUsageInTx(input: PluginCollectionIndexUsageScope): Promise<void> {
    for (const summary of await readIndexUsageSummariesInTx(input)) {
        await publishIndexUsageSummaryInTx(input.tx, summary);
    }
}

/** One-shot rebuild only: replace declared-prefix summaries from actual stored entries. */
export async function refreshPluginCollectionIndexUsageInTx(input: PluginCollectionIndexUsageScope): Promise<void> {
    for (const summary of await readIndexUsageSummariesInTx(input)) {
        if (summary.prefixes.length > 0) {
            const entries = await input.tx.pluginCollectionIndexEntry.findMany({ where: { indexStateId: summary.id }, select: { encodedSortKey: true } });
            for (const entry of entries) for (const prefix of summary.prefixes) if (startsWith(entry.encodedSortKey, prefix.encodedPrefix)) summary.counts[prefix.key]! += 1;
        }
        await publishIndexUsageSummaryInTx(input.tx, summary);
    }
}

/** Explicit one-shot repair, also used during deployment; never called on a mutation arrival. */
export async function backfillPluginCollectionUsageTotalsInTx(input: Readonly<{ tx: Tx; accountId: string }>): Promise<void> {
    const rows = await input.tx.pluginCollectionRow.findMany({ where: { accountId: input.accountId, deletedAt: null },
        select: { pluginId: true, collectionId: true, rowId: true, contractId: true, contentEnvelope: true,
            projections: { select: { fieldId: true, typedEncodedValue: true } } } });
    await input.tx.pluginCollectionUsage.deleteMany({ where: { accountId: input.accountId } });
    await input.tx.pluginCollectionContractUsage.deleteMany({ where: { accountId: input.accountId } });
    await input.tx.account.update({ where: { id: input.accountId }, data: { pluginCollectionRows: 0n, pluginCollectionEncodedBytes: 0n } });
    await applyPluginCollectionUsageDeltaInTx({ ...input, delta: createPluginCollectionUsageDelta({
        before: { rows: [], indexEntries: [] }, after: buildPluginCollectionUsageSnapshot({ rows }),
    }) });
    const states = await input.tx.pluginCollectionIndexState.findMany({ where: { accountId: input.accountId }, select: { id: true } });
    await refreshPluginCollectionIndexUsageInTx({ ...input, indexStateIds: states.map(state => state.id) });
}
