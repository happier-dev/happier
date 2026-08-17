import {
    encodePluginCollectionIndexTuplePrefixV1,
    getPluginCollectionScalarKindV1,
    nextPluginCollectionIndexPrefixV1,
    type NormalizedPluginAccountCollectionContractV1,
    type PluginCollectionIndexScalarV1,
    type PluginCollectionQuotaDimensionV1,
    type PluginCollectionQuotaRequestV1,
    type PluginDataCollectionsCapabilities,
} from '@happier-dev/protocol';

import type { Tx } from '@/storage/inTx';

import { countPluginCollectionIndexEntriesByRawOrdinalKey } from './rawOrdinalIndex';

const textEncoder = new TextEncoder();

export type PluginCollectionQuotaIncompatibility = Readonly<{
    dimension: PluginCollectionQuotaDimensionV1;
    effectiveMaximum: number;
}>;

export type PluginCollectionEffectiveQuotaLimits = Readonly<{
    maxRowEncodedBytes: number;
    maxRows: number;
    maxCollectionEncodedBytes: number;
    maxBatchRows: number;
    maxBatchBytes: number;
    maxAccountRows: number;
    maxAccountBytes: number;
}>;

export type PluginCollectionUsage = Readonly<{
    rows: number;
    encodedBytes: number;
    rowEncodedBytesByRowId: ReadonlyMap<string, number>;
}>;

export type PluginCollectionAccountUsage = Readonly<{
    rows: number;
    encodedBytes: number;
    collections: ReadonlyMap<string, PluginCollectionUsage>;
    contracts: ReadonlyMap<string, PluginCollectionPersistedContractForQuota>;
}>;

/** A non-canonical staged row measured through the same stored-row metric. */
export type PluginCollectionAdditionalStoredRowForQuota = Readonly<{
    storageKey: string;
    pluginId: string;
    collectionId: string;
    rowId: string;
    contentEnvelope: unknown;
    projections: readonly Readonly<{ fieldId: string; typedEncodedValue: string }>[];
}>;

/** One currently relevant immutable contract policy for quota evaluation. */
export type PluginCollectionQuotaPolicy = Readonly<{
    pluginId: string;
    collectionId: string;
    quota: PluginCollectionQuotaRequestV1 | undefined;
}>;

/**
 * The normalized static data needed to use the established raw-ordinal prefix
 * counter. This is policy input, not another state owner.
 */
export type PluginCollectionPrefixQuotaPolicy = Readonly<{
    pluginId: string;
    collectionId: string;
    contractId: string;
    contractDigest: string;
    quota: PluginCollectionQuotaRequestV1 | undefined;
    schema: NormalizedPluginAccountCollectionContractV1['schema'];
    indexes: NormalizedPluginAccountCollectionContractV1['indexes'];
}>;

export type PluginCollectionPrefixQuotaUsage = readonly Readonly<{
    pluginId: string;
    collectionId: string;
    contractDigest: string;
    indexId: string;
    prefix: readonly unknown[];
    maxRows: number;
    rows: number;
}>[];

/** A persisted Collection census/contract fact is semantically inconsistent. */
export class PluginCollectionQuotaCensusInconsistencyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PluginCollectionQuotaCensusInconsistencyError';
    }
}

/** Immutable contract columns attached to a live row during the one quota census. */
export type PluginCollectionPersistedContractForQuota = Readonly<{
    id: string;
    pluginId: string;
    collectionId: string;
    schemaVersion: number;
    contractDigest: string;
    normalizedSchema: unknown;
    indexes: unknown;
    relations: unknown;
    privacyProjection: unknown;
}>;

function collectionKey(pluginId: string, collectionId: string): string {
    return `${pluginId}\u0000${collectionId}`;
}

function emptyUsage(): PluginCollectionUsage {
    return {
        rows: 0,
        encodedBytes: 0,
        rowEncodedBytesByRowId: new Map(),
    };
}

function usageForCollection(
    usage: PluginCollectionAccountUsage,
    pluginId: string,
    collectionId: string,
): PluginCollectionUsage {
    return usage.collections.get(collectionKey(pluginId, collectionId)) ?? emptyUsage();
}

/**
 * The sole persisted-row measurement used by Collection quota enforcement.
 * It includes row identity, the complete plain/encrypted envelope, and every
 * typed projection value exactly as they are stored.
 */
export function measurePluginCollectionStoredRowEncodedBytes(input: Readonly<{
    rowId: string;
    contentEnvelope: unknown;
    projections: readonly Readonly<{ fieldId: string; typedEncodedValue: string }>[];
}>): number {
    const payload = JSON.stringify({
        rowId: input.rowId,
        contentEnvelope: input.contentEnvelope,
        projections: [...input.projections]
            .sort((left, right) => left.fieldId.localeCompare(right.fieldId))
            .map((projection) => ({
                fieldId: projection.fieldId,
                typedEncodedValue: projection.typedEncodedValue,
            })),
    });
    if (payload === undefined) {
        throw new PluginCollectionQuotaCensusInconsistencyError('Collection stored row is not JSON serializable.');
    }
    return textEncoder.encode(payload).byteLength;
}

/**
 * Extends the one Account census with bounded non-authoritative stage bytes.
 * The caller chooses collision-free storage keys because one logical row can
 * temporarily exist as both canonical source and prospective target.
 */
export function extendPluginCollectionAccountUsageWithStoredRows(input: Readonly<{
    usage: PluginCollectionAccountUsage;
    rows: readonly PluginCollectionAdditionalStoredRowForQuota[];
}>): PluginCollectionAccountUsage {
    const collections = new Map<string, {
        rows: number;
        encodedBytes: number;
        rowEncodedBytesByRowId: Map<string, number>;
    }>();
    for (const [key, usage] of input.usage.collections) {
        collections.set(key, {
            rows: usage.rows,
            encodedBytes: usage.encodedBytes,
            rowEncodedBytesByRowId: new Map(usage.rowEncodedBytesByRowId),
        });
    }
    let rows = input.usage.rows;
    let encodedBytes = input.usage.encodedBytes;
    for (const row of input.rows) {
        const key = collectionKey(row.pluginId, row.collectionId);
        let collection = collections.get(key);
        if (!collection) {
            collection = { rows: 0, encodedBytes: 0, rowEncodedBytesByRowId: new Map() };
            collections.set(key, collection);
        }
        if (collection.rowEncodedBytesByRowId.has(row.storageKey)) {
            throw new PluginCollectionQuotaCensusInconsistencyError(
                "Collection staged quota census has a duplicate storage identity.",
            );
        }
        const measured = measurePluginCollectionStoredRowEncodedBytes({
            rowId: row.rowId,
            contentEnvelope: row.contentEnvelope,
            projections: row.projections,
        });
        collection.rows += 1;
        collection.encodedBytes += measured;
        collection.rowEncodedBytesByRowId.set(row.storageKey, measured);
        rows += 1;
        encodedBytes += measured;
    }
    return Object.freeze({
        rows,
        encodedBytes,
        collections: new Map([...collections.entries()].map(([key, usage]) => [
            key,
            Object.freeze({
                rows: usage.rows,
                encodedBytes: usage.encodedBytes,
                rowEncodedBytesByRowId: usage.rowEncodedBytesByRowId,
            }),
        ])),
        contracts: input.usage.contracts,
    });
}

/**
 * Resolves the only effective Collection quota policy. Account deployment
 * ceilings additionally bound any individual collection, but Account totals
 * remain separate aggregate checks below.
 */
export function resolvePluginCollectionEffectiveQuotaLimits(input: Readonly<{
    deployment: PluginDataCollectionsCapabilities;
    quota: PluginCollectionQuotaRequestV1 | undefined;
}>): PluginCollectionEffectiveQuotaLimits {
    return Object.freeze({
        maxRowEncodedBytes: Math.min(
            input.deployment.maxRowEncodedBytes,
            input.quota?.maxRowEncodedBytes ?? Number.POSITIVE_INFINITY,
        ),
        maxRows: Math.min(
            input.deployment.maxAccountRows,
            input.quota?.maxRows ?? Number.POSITIVE_INFINITY,
        ),
        maxCollectionEncodedBytes: Math.min(
            input.deployment.maxAccountBytes,
            input.quota?.maxCollectionEncodedBytes ?? Number.POSITIVE_INFINITY,
        ),
        maxBatchRows: input.deployment.maxBatchRows,
        maxBatchBytes: input.deployment.maxBatchBytes,
        maxAccountRows: input.deployment.maxAccountRows,
        maxAccountBytes: input.deployment.maxAccountBytes,
    });
}

/** A declared limit can lower deployment policy but cannot request a higher one. */
export function findPluginCollectionDeclaredQuotaIncompatibility(input: Readonly<{
    deployment: PluginDataCollectionsCapabilities;
    quota: PluginCollectionQuotaRequestV1 | undefined;
}>): PluginCollectionQuotaIncompatibility | null {
    if (
        input.quota?.maxRowEncodedBytes !== undefined
        && input.quota.maxRowEncodedBytes > input.deployment.maxRowEncodedBytes
    ) {
        return { dimension: 'maxRowEncodedBytes', effectiveMaximum: input.deployment.maxRowEncodedBytes };
    }
    if (input.quota?.maxRows !== undefined && input.quota.maxRows > input.deployment.maxAccountRows) {
        return { dimension: 'maxRows', effectiveMaximum: input.deployment.maxAccountRows };
    }
    if (
        input.quota?.maxCollectionEncodedBytes !== undefined
        && input.quota.maxCollectionEncodedBytes > input.deployment.maxAccountBytes
    ) {
        return { dimension: 'maxCollectionEncodedBytes', effectiveMaximum: input.deployment.maxAccountBytes };
    }
    return null;
}

/** Reads live persisted state once for every Collection quota consumer. */
export async function readPluginCollectionAccountUsageInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
}>): Promise<PluginCollectionAccountUsage> {
    const rows = await input.tx.pluginCollectionRow.findMany({
        where: { accountId: input.accountId, deletedAt: null },
        select: {
            pluginId: true,
            collectionId: true,
            rowId: true,
            contentEnvelope: true,
            contract: {
                select: {
                    id: true,
                    pluginId: true,
                    collectionId: true,
                    schemaVersion: true,
                    contractDigest: true,
                    normalizedSchema: true,
                    indexes: true,
                    relations: true,
                    privacyProjection: true,
                },
            },
            projections: {
                select: { fieldId: true, typedEncodedValue: true },
            },
        },
    });
    const mutableCollections = new Map<string, {
        rows: number;
        encodedBytes: number;
        rowEncodedBytesByRowId: Map<string, number>;
    }>();
    const contracts = new Map<string, PluginCollectionPersistedContractForQuota>();
    let accountRows = 0;
    let accountEncodedBytes = 0;
    for (const row of rows) {
        const existingContract = contracts.get(row.contract.id);
        if (existingContract && (
            existingContract.pluginId !== row.contract.pluginId
            || existingContract.collectionId !== row.contract.collectionId
            || existingContract.contractDigest !== row.contract.contractDigest
        )) {
            throw new PluginCollectionQuotaCensusInconsistencyError(
                'Collection quota census found an ambiguous contract identity.',
            );
        }
        contracts.set(row.contract.id, row.contract);
        const key = collectionKey(row.pluginId, row.collectionId);
        let collection = mutableCollections.get(key);
        if (!collection) {
            collection = { rows: 0, encodedBytes: 0, rowEncodedBytesByRowId: new Map() };
            mutableCollections.set(key, collection);
        }
        const encodedBytes = measurePluginCollectionStoredRowEncodedBytes({
            rowId: row.rowId,
            contentEnvelope: row.contentEnvelope,
            projections: row.projections,
        });
        collection.rows += 1;
        collection.encodedBytes += encodedBytes;
        collection.rowEncodedBytesByRowId.set(row.rowId, encodedBytes);
        accountRows += 1;
        accountEncodedBytes += encodedBytes;
    }
    const collections = new Map<string, PluginCollectionUsage>();
    for (const [key, usage] of mutableCollections) {
        collections.set(key, Object.freeze({
            rows: usage.rows,
            encodedBytes: usage.encodedBytes,
            rowEncodedBytesByRowId: usage.rowEncodedBytesByRowId,
        }));
    }
    return Object.freeze({ rows: accountRows, encodedBytes: accountEncodedBytes, collections, contracts });
}

function prefixQuotaUsageIdentity(input: Readonly<{
    pluginId: string;
    collectionId: string;
    contractDigest: string;
    indexId: string;
    prefix: readonly unknown[];
}>): string {
    const prefix = JSON.stringify(input.prefix);
    if (prefix === undefined) {
        throw new PluginCollectionQuotaCensusInconsistencyError(
            'Collection prefix quota is not JSON serializable.',
        );
    }
    return [
        input.pluginId,
        input.collectionId,
        input.contractDigest,
        input.indexId,
        prefix,
    ].join('\u0000');
}

function prefixQuotaStateIdentity(input: Readonly<{
    pluginId: string;
    collectionId: string;
    indexId: string;
    contractDigest: string;
}>): string {
    return [input.pluginId, input.collectionId, input.indexId, input.contractDigest].join('\u0000');
}

/**
 * Counts normalized indexed-prefix quota membership through the one raw-byte
 * range primitive. Both readiness admission and mutation pass their current
 * Account census here, so no consumer owns a competing prefix decision.
 */
export async function readPluginCollectionPrefixQuotaUsageInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    usage: PluginCollectionAccountUsage;
    policies: readonly PluginCollectionPrefixQuotaPolicy[];
}>): Promise<PluginCollectionPrefixQuotaUsage> {
    const policies = [...input.policies].sort((left, right) => (
        left.pluginId.localeCompare(right.pluginId)
        || left.collectionId.localeCompare(right.collectionId)
        || left.contractDigest.localeCompare(right.contractDigest)
    )).filter((policy) => (
        policy.quota?.maxRowsByIndexPrefix !== undefined
        && usageForCollection(input.usage, policy.pluginId, policy.collectionId).rows > 0
    ));
    if (policies.length === 0) return Object.freeze([]);
    const states = await input.tx.pluginCollectionIndexState.findMany({
        where: { accountId: input.accountId },
        select: {
            id: true,
            pluginId: true,
            collectionId: true,
            indexId: true,
            contractId: true,
            contractDigest: true,
            buildState: true,
            indexedThroughRevision: true,
        },
    });
    const statesByIdentity = new Map(states.map((state) => [prefixQuotaStateIdentity(state), state]));
    const usages: Array<PluginCollectionPrefixQuotaUsage[number]> = [];
    const seen = new Set<string>();
    for (const policy of policies) {
        const declared = policy.quota?.maxRowsByIndexPrefix;
        if (!declared) continue;
        for (const prefixQuota of declared) {
            const identity = prefixQuotaUsageIdentity({
                pluginId: policy.pluginId,
                collectionId: policy.collectionId,
                contractDigest: policy.contractDigest,
                indexId: prefixQuota.indexId,
                prefix: prefixQuota.prefix,
            });
            if (seen.has(identity)) continue;
            seen.add(identity);

            const index = policy.indexes.find((candidate) => candidate.id === prefixQuota.indexId);
            const state = statesByIdentity.get(prefixQuotaStateIdentity({
                pluginId: policy.pluginId,
                collectionId: policy.collectionId,
                indexId: prefixQuota.indexId,
                contractDigest: policy.contractDigest,
            }));
            if (
                !index
                || !state
                || state.contractId !== policy.contractId
                || state.buildState !== 'ready'
                || state.indexedThroughRevision === null
                || prefixQuota.prefix.length > index.fields.length
            ) {
                throw new PluginCollectionQuotaCensusInconsistencyError('Collection prefix quota index is not ready.');
            }
            let encodedPrefix: Uint8Array;
            try {
                encodedPrefix = encodePluginCollectionIndexTuplePrefixV1({
                    fields: prefixQuota.prefix.map((value, position) => {
                        const indexField = index.fields[position];
                        if (!indexField) {
                            throw new PluginCollectionQuotaCensusInconsistencyError(
                                'Collection prefix quota exceeds its index.',
                            );
                        }
                        return {
                            kind: getPluginCollectionScalarKindV1({ schema: policy.schema, field: indexField.field }),
                            value,
                            direction: indexField.direction,
                        } satisfies PluginCollectionIndexScalarV1;
                    }),
                });
            } catch {
                throw new PluginCollectionQuotaCensusInconsistencyError(
                    'Collection prefix quota is inconsistent with its immutable contract.',
                );
            }
            const upper = nextPluginCollectionIndexPrefixV1(encodedPrefix);
            const count = await countPluginCollectionIndexEntriesByRawOrdinalKey({
                tx: input.tx,
                indexStateId: state.id,
                bounds: {
                    lower: encodedPrefix,
                    ...(upper ? { upper } : {}),
                },
            });
            if (count === null || count > BigInt(Number.MAX_SAFE_INTEGER)) {
                throw new PluginCollectionQuotaCensusInconsistencyError(
                    'Collection prefix quota count is not safely representable.',
                );
            }
            usages.push({
                pluginId: policy.pluginId,
                collectionId: policy.collectionId,
                contractDigest: policy.contractDigest,
                indexId: prefixQuota.indexId,
                prefix: prefixQuota.prefix,
                maxRows: prefixQuota.maxRows,
                rows: Number(count),
            });
        }
    }
    return Object.freeze(usages.sort((left, right) => (
        prefixQuotaUsageIdentity(left).localeCompare(prefixQuotaUsageIdentity(right))
    )));
}

function isMonotonicallyAllowed(input: Readonly<{
    before: number;
    after: number;
    effectiveMaximum: number;
}>): boolean {
    return input.after <= input.effectiveMaximum
        || (input.before > input.effectiveMaximum && input.after < input.before);
}

function incompatibilityForTransition(input: Readonly<{
    dimension: PluginCollectionQuotaDimensionV1;
    effectiveMaximum: number;
    before: number;
    after: number;
}>): PluginCollectionQuotaIncompatibility | null {
    return isMonotonicallyAllowed(input)
        ? null
        : { dimension: input.dimension, effectiveMaximum: input.effectiveMaximum };
}

/** Batch admission has no retained state, so it never gets a lowering exception. */
export function findPluginCollectionBatchQuotaIncompatibility(input: Readonly<{
    deployment: PluginDataCollectionsCapabilities;
    operationCount: number;
    encodedBytes: number;
}>): PluginCollectionQuotaIncompatibility | null {
    if (input.operationCount > input.deployment.maxBatchRows) {
        return { dimension: 'maxBatchRows', effectiveMaximum: input.deployment.maxBatchRows };
    }
    if (input.encodedBytes > input.deployment.maxBatchBytes) {
        return { dimension: 'maxBatchBytes', effectiveMaximum: input.deployment.maxBatchBytes };
    }
    return null;
}

function prefixQuotaUsagesByIdentity(
    usages: PluginCollectionPrefixQuotaUsage,
): ReadonlyMap<string, PluginCollectionPrefixQuotaUsage[number]> {
    const result = new Map<string, PluginCollectionPrefixQuotaUsage[number]>;
    for (const usage of usages) {
        const identity = prefixQuotaUsageIdentity(usage);
        const existing = result.get(identity);
        if (existing && (existing.maxRows !== usage.maxRows || existing.rows !== usage.rows)) {
            throw new PluginCollectionQuotaCensusInconsistencyError('Collection prefix quota usage is ambiguous.');
        }
        result.set(identity, usage);
    }
    return result;
}

function findPluginCollectionPrefixActivationQuotaIncompatibility(
    usage: PluginCollectionPrefixQuotaUsage,
): PluginCollectionQuotaIncompatibility | null {
    for (const entry of [...usage].sort((left, right) => (
        prefixQuotaUsageIdentity(left).localeCompare(prefixQuotaUsageIdentity(right))
    ))) {
        if (entry.rows > entry.maxRows) {
            // Indexed-prefix quotas are a scoped row-count declaration; the
            // existing typed row-count result remains its public diagnostic.
            return { dimension: 'maxRows', effectiveMaximum: entry.maxRows };
        }
    }
    return null;
}

function findPluginCollectionPrefixMutationQuotaIncompatibility(input: Readonly<{
    before: PluginCollectionPrefixQuotaUsage;
    after: PluginCollectionPrefixQuotaUsage;
}>): PluginCollectionQuotaIncompatibility | null {
    const before = prefixQuotaUsagesByIdentity(input.before);
    const after = prefixQuotaUsagesByIdentity(input.after);
    const identities = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) => left.localeCompare(right));
    for (const identity of identities) {
        const previous = before.get(identity);
        const next = after.get(identity);
        const maxRows = previous?.maxRows ?? next?.maxRows;
        if (maxRows === undefined || (previous && next && previous.maxRows !== next.maxRows)) {
            throw new PluginCollectionQuotaCensusInconsistencyError('Collection prefix quota usage is inconsistent.');
        }
        const incompatibility = incompatibilityForTransition({
            dimension: 'maxRows',
            effectiveMaximum: maxRows,
            before: previous?.rows ?? 0,
            after: next?.rows ?? 0,
        });
        if (incompatibility) return incompatibility;
    }
    return null;
}

/**
 * Evaluates a complete mutation transition after all relation cascades. Old
 * overages may only move strictly toward compliance; fresh/non-reducing state
 * is rejected before any transaction side effects can commit.
 */
export function findPluginCollectionMutationQuotaIncompatibility(input: Readonly<{
    deployment: PluginDataCollectionsCapabilities;
    before: PluginCollectionAccountUsage;
    after: PluginCollectionAccountUsage;
    collections: readonly PluginCollectionQuotaPolicy[];
    beforePrefixUsage: PluginCollectionPrefixQuotaUsage;
    afterPrefixUsage: PluginCollectionPrefixQuotaUsage;
}>): PluginCollectionQuotaIncompatibility | null {
    const collections = [...input.collections].sort((left, right) => (
        left.pluginId.localeCompare(right.pluginId) || left.collectionId.localeCompare(right.collectionId)
    ));
    for (const collection of collections) {
        const limits = resolvePluginCollectionEffectiveQuotaLimits({
            deployment: input.deployment,
            quota: collection.quota,
        });
        const before = usageForCollection(input.before, collection.pluginId, collection.collectionId);
        const after = usageForCollection(input.after, collection.pluginId, collection.collectionId);
        const rowCount = incompatibilityForTransition({
            dimension: 'maxRows',
            effectiveMaximum: limits.maxRows,
            before: before.rows,
            after: after.rows,
        });
        if (rowCount) return rowCount;
        const collectionBytes = incompatibilityForTransition({
            dimension: 'maxCollectionEncodedBytes',
            effectiveMaximum: limits.maxCollectionEncodedBytes,
            before: before.encodedBytes,
            after: after.encodedBytes,
        });
        if (collectionBytes) return collectionBytes;

        for (const rowId of [...new Set([
            ...before.rowEncodedBytesByRowId.keys(),
            ...after.rowEncodedBytesByRowId.keys(),
        ])].sort((left, right) => left.localeCompare(right))) {
            const row = incompatibilityForTransition({
                dimension: 'maxRowEncodedBytes',
                effectiveMaximum: limits.maxRowEncodedBytes,
                before: before.rowEncodedBytesByRowId.get(rowId) ?? 0,
                after: after.rowEncodedBytesByRowId.get(rowId) ?? 0,
            });
            if (row) return row;
        }
    }
    const prefix = findPluginCollectionPrefixMutationQuotaIncompatibility({
        before: input.beforePrefixUsage,
        after: input.afterPrefixUsage,
    });
    if (prefix) return prefix;
    const accountRows = incompatibilityForTransition({
        dimension: 'maxAccountRows',
        effectiveMaximum: input.deployment.maxAccountRows,
        before: input.before.rows,
        after: input.after.rows,
    });
    if (accountRows) return accountRows;
    return incompatibilityForTransition({
        dimension: 'maxAccountBytes',
        effectiveMaximum: input.deployment.maxAccountBytes,
        before: input.before.encodedBytes,
        after: input.after.encodedBytes,
    });
}

/** Activation is a new writable contract, so existing overages are never admitted. */
export function findPluginCollectionActivationQuotaIncompatibility(input: Readonly<{
    deployment: PluginDataCollectionsCapabilities;
    usage: PluginCollectionAccountUsage;
    collections: readonly PluginCollectionQuotaPolicy[];
    prefixUsage: PluginCollectionPrefixQuotaUsage;
}>): PluginCollectionQuotaIncompatibility | null {
    const collections = [...input.collections].sort((left, right) => (
        left.pluginId.localeCompare(right.pluginId) || left.collectionId.localeCompare(right.collectionId)
    ));
    for (const collection of collections) {
        const declared = findPluginCollectionDeclaredQuotaIncompatibility({
            deployment: input.deployment,
            quota: collection.quota,
        });
        if (declared) return declared;
        const limits = resolvePluginCollectionEffectiveQuotaLimits({
            deployment: input.deployment,
            quota: collection.quota,
        });
        const usage = usageForCollection(input.usage, collection.pluginId, collection.collectionId);
        if (usage.rows > limits.maxRows) {
            return { dimension: 'maxRows', effectiveMaximum: limits.maxRows };
        }
        if (usage.encodedBytes > limits.maxCollectionEncodedBytes) {
            return { dimension: 'maxCollectionEncodedBytes', effectiveMaximum: limits.maxCollectionEncodedBytes };
        }
        for (const encodedBytes of usage.rowEncodedBytesByRowId.values()) {
            if (encodedBytes > limits.maxRowEncodedBytes) {
                return { dimension: 'maxRowEncodedBytes', effectiveMaximum: limits.maxRowEncodedBytes };
            }
        }
    }
    const prefix = findPluginCollectionPrefixActivationQuotaIncompatibility(input.prefixUsage);
    if (prefix) return prefix;
    if (input.usage.rows > input.deployment.maxAccountRows) {
        return { dimension: 'maxAccountRows', effectiveMaximum: input.deployment.maxAccountRows };
    }
    if (input.usage.encodedBytes > input.deployment.maxAccountBytes) {
        return { dimension: 'maxAccountBytes', effectiveMaximum: input.deployment.maxAccountBytes };
    }
    return null;
}
