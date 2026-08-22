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

/**
 * The activation path needs aggregate row measurements, not the identity of
 * every retained row. Mutation keeps the fuller census above because its
 * monotonic transition rule compares individual row identities.
 */
export type PluginCollectionActivationUsage = Readonly<{
    rows: number;
    encodedBytes: number;
    maximumRowEncodedBytes: number;
}>;

export type PluginCollectionAccountActivationUsage = Readonly<{
    rows: number;
    encodedBytes: number;
    collections: ReadonlyMap<string, PluginCollectionActivationUsage>;
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

type PluginCollectionQuotaCensusRow = Readonly<{
    id: string;
    pluginId: string;
    collectionId: string;
    rowId: string;
    contentEnvelope: unknown;
    contract: PluginCollectionPersistedContractForQuota;
    projections: readonly Readonly<{ fieldId: string; typedEncodedValue: string }>[];
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

function emptyActivationUsage(): PluginCollectionActivationUsage {
    return {
        rows: 0,
        encodedBytes: 0,
        maximumRowEncodedBytes: 0,
    };
}

function activationUsageForCollection(
    usage: PluginCollectionAccountActivationUsage,
    pluginId: string,
    collectionId: string,
): PluginCollectionActivationUsage {
    return usage.collections.get(collectionKey(pluginId, collectionId)) ?? emptyActivationUsage();
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
 * Extends the compact activation census with bounded non-authoritative stage
 * bytes. Candidate storage identities are deliberately NUL-prefixed while
 * public row identities reject NUL, so canonical source and target rows stay
 * distinct without retaining every live row identity in memory.
 */
export function extendPluginCollectionAccountActivationUsageWithStoredRows(input: Readonly<{
    usage: PluginCollectionAccountActivationUsage;
    rows: readonly PluginCollectionAdditionalStoredRowForQuota[];
}>): PluginCollectionAccountActivationUsage {
    const collections = new Map<string, PluginCollectionActivationUsage>(input.usage.collections);
    const changedCollections = new Map<string, {
        rows: number;
        encodedBytes: number;
        maximumRowEncodedBytes: number;
        storageKeys: Set<string>;
    }>();
    let rows = input.usage.rows;
    let encodedBytes = input.usage.encodedBytes;
    for (const row of input.rows) {
        if (!row.storageKey.includes('\u0000')) {
            throw new PluginCollectionQuotaCensusInconsistencyError(
                "Collection staged quota census storage identity can overlap a public row identity.",
            );
        }
        const key = collectionKey(row.pluginId, row.collectionId);
        let collection = changedCollections.get(key);
        if (!collection) {
            const existing = collections.get(key);
            collection = existing
                ? {
                    rows: existing.rows,
                    encodedBytes: existing.encodedBytes,
                    maximumRowEncodedBytes: existing.maximumRowEncodedBytes,
                    storageKeys: new Set(),
                }
                : { rows: 0, encodedBytes: 0, maximumRowEncodedBytes: 0, storageKeys: new Set() };
            changedCollections.set(key, collection);
        }
        if (collection.storageKeys.has(row.storageKey)) {
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
        collection.maximumRowEncodedBytes = Math.max(collection.maximumRowEncodedBytes, measured);
        collection.storageKeys.add(row.storageKey);
        rows += 1;
        encodedBytes += measured;
    }
    for (const [key, usage] of changedCollections) {
        collections.set(key, Object.freeze({
            rows: usage.rows,
            encodedBytes: usage.encodedBytes,
            maximumRowEncodedBytes: usage.maximumRowEncodedBytes,
        }));
    }
    return Object.freeze({
        rows,
        encodedBytes,
        collections,
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

/**
 * The working set one census page may materialize before the next round trip.
 *
 * The census reads every live stored row, keeps only its measured byte count,
 * and discards the row, so the page — not the Account — is what has to be
 * bounded, and it has to be bounded in bytes. `maxRowEncodedBytes` is a
 * rejection ceiling (512 KiB by default, 2 MiB at the protocol ceiling) that
 * ordinary rows sit orders of magnitude below: a page fixed at that ceiling
 * costs hundreds of round trips for a normal Account, and a page fixed at
 * ordinary row sizes is unbounded for a pathological one. So the first page is
 * sized from the ceiling and every later page from the largest row this census
 * has actually measured.
 */
const PLUGIN_COLLECTION_QUOTA_CENSUS_PAGE_BYTES = 16 * 1024 * 1024;

/** Round-trip ceiling: no page asks a provider for more rows than this. */
const PLUGIN_COLLECTION_QUOTA_CENSUS_MAX_PAGE_ROWS = 1_000;

/**
 * A census page never depends on `maxBatchRows`: that limit bounds how many row
 * operations one inbound client mutation may carry, not how much stored data
 * this server reads per round trip.
 */
function resolvePluginCollectionQuotaCensusPageRows(largestRowEncodedBytes: number): number {
    if (!Number.isFinite(largestRowEncodedBytes) || largestRowEncodedBytes < 1) {
        throw new PluginCollectionQuotaCensusInconsistencyError(
            'Collection quota census requires a positive stored-row byte ceiling.',
        );
    }
    return Math.max(1, Math.min(
        PLUGIN_COLLECTION_QUOTA_CENSUS_MAX_PAGE_ROWS,
        Math.floor(PLUGIN_COLLECTION_QUOTA_CENSUS_PAGE_BYTES / largestRowEncodedBytes),
    ));
}

/** The single bounded live-row reader shared by mutation and activation census shapes. */
async function forEachLivePluginCollectionQuotaCensusRowInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    deployment: PluginDataCollectionsCapabilities;
    visit: (visited: Readonly<{ row: PluginCollectionQuotaCensusRow; encodedBytes: number }>) => void;
}>): Promise<void> {
    let largestRowEncodedBytes = input.deployment.maxRowEncodedBytes;
    let afterId: string | null = null;
    while (true) {
        const take = resolvePluginCollectionQuotaCensusPageRows(largestRowEncodedBytes);
        const rows: readonly PluginCollectionQuotaCensusRow[] = await input.tx.pluginCollectionRow.findMany({
            where: {
                accountId: input.accountId,
                deletedAt: null,
                ...(afterId === null ? {} : { id: { gt: afterId } }),
            },
            // Naming the supporting index's own column order, not just `id`, is
            // what keeps the walk on `PluginCollectionRow_account_live_scan_idx`.
            // `accountId` and `deletedAt` are pinned by the predicate above, so
            // this is the same row order as `id` alone — but measured on
            // PostgreSQL 16, ordering by the bare `id` leaves the planner on the
            // primary key under `LIMIT`, filtering out every other tenant's rows
            // (200,000 rows removed and 17,443 buffers for one page against 12
            // buffers here).
            orderBy: [{ accountId: 'asc' }, { deletedAt: 'asc' }, { id: 'asc' }],
            take,
            select: {
                id: true,
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
        let largestObservedRowEncodedBytes = 0;
        for (const row of rows) {
            const encodedBytes = measurePluginCollectionStoredRowEncodedBytes({
                rowId: row.rowId,
                contentEnvelope: row.contentEnvelope,
                projections: row.projections,
            });
            largestObservedRowEncodedBytes = Math.max(largestObservedRowEncodedBytes, encodedBytes);
            input.visit({ row, encodedBytes });
        }
        if (rows.length < take) return;
        const last = rows[rows.length - 1];
        if (!last) return;
        afterId = last.id;
        largestRowEncodedBytes = Math.max(1, largestObservedRowEncodedBytes);
    }
}

function recordPluginCollectionQuotaCensusContract(input: Readonly<{
    contracts: Map<string, PluginCollectionPersistedContractForQuota>;
    contract: PluginCollectionPersistedContractForQuota;
}>): void {
    const existingContract = input.contracts.get(input.contract.id);
    if (existingContract && (
        existingContract.pluginId !== input.contract.pluginId
        || existingContract.collectionId !== input.contract.collectionId
        || existingContract.contractDigest !== input.contract.contractDigest
    )) {
        throw new PluginCollectionQuotaCensusInconsistencyError(
            'Collection quota census found an ambiguous contract identity.',
        );
    }
    input.contracts.set(input.contract.id, input.contract);
}

/**
 * Reads the complete live-row census required by mutation's monotonic
 * per-row transition checks. Activation must use the compact census below.
 */
export async function readPluginCollectionAccountUsageInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    deployment: PluginDataCollectionsCapabilities;
}>): Promise<PluginCollectionAccountUsage> {
    const mutableCollections = new Map<string, {
        rows: number;
        encodedBytes: number;
        rowEncodedBytesByRowId: Map<string, number>;
    }>();
    const contracts = new Map<string, PluginCollectionPersistedContractForQuota>();
    let accountRows = 0;
    let accountEncodedBytes = 0;
    await forEachLivePluginCollectionQuotaCensusRowInTx({
        ...input,
        visit: ({ row, encodedBytes }) => {
            recordPluginCollectionQuotaCensusContract({ contracts, contract: row.contract });
            const key = collectionKey(row.pluginId, row.collectionId);
            let collection = mutableCollections.get(key);
            if (!collection) {
                collection = { rows: 0, encodedBytes: 0, rowEncodedBytesByRowId: new Map() };
                mutableCollections.set(key, collection);
            }
            collection.rows += 1;
            collection.encodedBytes += encodedBytes;
            collection.rowEncodedBytesByRowId.set(row.rowId, encodedBytes);
            accountRows += 1;
            accountEncodedBytes += encodedBytes;
        },
    });
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

/**
 * Reads the bounded aggregate needed for contract activation and candidate
 * staging. It intentionally retains no per-row identity map: all activation
 * row-size checks reduce exactly to the collection maximum.
 */
export async function readPluginCollectionAccountActivationUsageInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    deployment: PluginDataCollectionsCapabilities;
}>): Promise<PluginCollectionAccountActivationUsage> {
    const mutableCollections = new Map<string, {
        rows: number;
        encodedBytes: number;
        maximumRowEncodedBytes: number;
    }>();
    const contracts = new Map<string, PluginCollectionPersistedContractForQuota>();
    let accountRows = 0;
    let accountEncodedBytes = 0;
    await forEachLivePluginCollectionQuotaCensusRowInTx({
        ...input,
        visit: ({ row, encodedBytes }) => {
            recordPluginCollectionQuotaCensusContract({ contracts, contract: row.contract });
            const key = collectionKey(row.pluginId, row.collectionId);
            let collection = mutableCollections.get(key);
            if (!collection) {
                collection = { rows: 0, encodedBytes: 0, maximumRowEncodedBytes: 0 };
                mutableCollections.set(key, collection);
            }
            collection.rows += 1;
            collection.encodedBytes += encodedBytes;
            collection.maximumRowEncodedBytes = Math.max(collection.maximumRowEncodedBytes, encodedBytes);
            accountRows += 1;
            accountEncodedBytes += encodedBytes;
        },
    });
    const collections = new Map<string, PluginCollectionActivationUsage>();
    for (const [key, usage] of mutableCollections) {
        collections.set(key, Object.freeze({
            rows: usage.rows,
            encodedBytes: usage.encodedBytes,
            maximumRowEncodedBytes: usage.maximumRowEncodedBytes,
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

type PluginCollectionAccountRowsUsage = Readonly<{
    collections: ReadonlyMap<string, Readonly<{ rows: number }>>;
}>;

/**
 * Counts normalized indexed-prefix quota membership through the one raw-byte
 * range primitive. Both compact activation and mutation census shapes pass
 * their current Account rows here, so no consumer owns a competing prefix
 * decision.
 */
export async function readPluginCollectionPrefixQuotaUsageInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    usage: PluginCollectionAccountRowsUsage;
    policies: readonly PluginCollectionPrefixQuotaPolicy[];
}>): Promise<PluginCollectionPrefixQuotaUsage> {
    const policies = [...input.policies].sort((left, right) => (
        left.pluginId.localeCompare(right.pluginId)
        || left.collectionId.localeCompare(right.collectionId)
        || left.contractDigest.localeCompare(right.contractDigest)
    )).filter((policy) => (
        policy.quota?.maxRowsByIndexPrefix !== undefined
        && (input.usage.collections.get(collectionKey(policy.pluginId, policy.collectionId))?.rows ?? 0) > 0
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
    usage: PluginCollectionAccountActivationUsage;
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
        const usage = activationUsageForCollection(input.usage, collection.pluginId, collection.collectionId);
        if (usage.rows > limits.maxRows) {
            return { dimension: 'maxRows', effectiveMaximum: limits.maxRows };
        }
        if (usage.encodedBytes > limits.maxCollectionEncodedBytes) {
            return { dimension: 'maxCollectionEncodedBytes', effectiveMaximum: limits.maxCollectionEncodedBytes };
        }
        if (usage.maximumRowEncodedBytes > limits.maxRowEncodedBytes) {
            return { dimension: 'maxRowEncodedBytes', effectiveMaximum: limits.maxRowEncodedBytes };
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
