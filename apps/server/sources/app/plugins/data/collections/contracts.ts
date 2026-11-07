import type { Prisma } from "@prisma/client";
import { PluginCollectionMigrationDeclarationV1Schema, PluginCollectionQuotaRequestV1Schema, PluginCollectionUiQueryDescriptorV1Schema, type PluginAccountCollectionContributionV1 } from '@happier-dev/protocol/plugins/data/collectionContributionV1';
import { PluginCollectionContractRefV1Schema, type PluginCollectionContractRefV1 } from '@happier-dev/protocol/plugins/data/collectionContractRefV1';
import { PluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { preparePluginAccountCollectionContractV1, normalizePluginAccountCollectionContractsV1, type NormalizedPluginAccountCollectionContractV1, type PluginCollectionQuotaDimensionV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { z } from "zod/mini";

import { readPluginsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { isPrismaErrorCode } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";

import {
    findPluginCollectionActivationQuotaIncompatibility,
    PluginCollectionQuotaCensusInconsistencyError,
    readPluginCollectionAccountActivationUsageInTx,
    readPluginCollectionPrefixQuotaUsageInTx,
    type PluginCollectionQuotaIncompatibility,
    type PluginCollectionPrefixQuotaUsage,
} from "./quota";

const PersistedPrivacyProjectionV1Schema = z.strictObject({
    v: z.literal(1),
    rowIdField: z.string(),
    serverReadable: z.array(z.string()),
    uiQueries: z.array(PluginCollectionUiQueryDescriptorV1Schema),
    quota: z.optional(PluginCollectionQuotaRequestV1Schema),
    readableSchemaVersions: z.array(z.number().check(z.int(), z.minimum(1))),
    // Absent on contracts materialized before finite migration identities were
    // added. The normalized empty chain deliberately retains the legacy digest.
    migrations: z._default(z.array(PluginCollectionMigrationDeclarationV1Schema), []),
    // Absent on contracts materialized before mode-derived identity was
    // declarable. An empty set is semantically "no mode-derived identity" and
    // likewise retains the legacy digest.
    identityFields: z._default(z.array(z.string()), []),
});

type StoredPluginCollectionContractRow = Readonly<{
    pluginId: string;
    collectionId: string;
    schemaVersion: number;
    contractDigest: string;
    normalizedSchema: unknown;
    indexes: unknown;
    relations: unknown;
    privacyProjection: unknown;
}>;

type PreparedMaterializedCollectionContract = ReturnType<typeof preparePluginAccountCollectionContractV1>;

// Materialized contract versions are immutable, global declaration facts:
// Account writer changes do not retire a version another Account or retained
// reader still uses. Keep one preparation per qualified version for this server
// lifetime, shared by reads, mutations, readiness and migration declarations.
// Account admission and persisted-row existence are still read by each caller.
const preparedMaterializedContracts = new Map<string, Readonly<{
    stored: string;
    prepared: PreparedMaterializedCollectionContract;
}>>();

export class PluginCollectionContractMaterializationError extends Error {
    constructor(readonly code: "collection_contract_invalid" | "collection_contract_inconsistent") {
        super(code);
        this.name = "PluginCollectionContractMaterializationError";
    }
}

export type PluginCollectionWriterReadinessErrorCode =
    | "collection_writer_contract_invalid"
    | "collection_writer_contract_unavailable"
    | "collection_writer_contract_not_ready"
    | "collection_quota_incompatible";

/**
 * The Data-owned readiness outcome consumed by the Availability intent CAS.
 * It deliberately has no release/version result: Availability remains the
 * owner of release selection and Account currentness.
 */
export class PluginCollectionWriterReadinessError extends Error {
    readonly dimension: PluginCollectionQuotaDimensionV1 | undefined;
    readonly effectiveMaximum: number | undefined;

    constructor(
        readonly code: PluginCollectionWriterReadinessErrorCode,
        quota?: PluginCollectionQuotaIncompatibility,
    ) {
        super(code);
        this.name = "PluginCollectionWriterReadinessError";
        this.dimension = quota?.dimension;
        this.effectiveMaximum = quota?.effectiveMaximum;
    }
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new PluginCollectionContractMaterializationError("collection_contract_inconsistent");
    }
    return JSON.parse(serialized) as Prisma.InputJsonValue;
}

function storedPrivacyProjection(contract: NormalizedPluginAccountCollectionContractV1): Prisma.InputJsonValue {
    return toPrismaJson({
        v: 1,
        rowIdField: contract.rowIdField,
        serverReadable: contract.serverReadable,
        uiQueries: contract.uiQueries.map((query) => ({
            id: query.id,
            indexId: query.indexId,
            parameters: query.parameters,
            prefix: query.prefix,
            ...(query.range ? { range: query.range } : {}),
            order: query.order,
            pageSize: query.pageSize,
            projectedFields: query.projectedFields.map((field) => field.field),
        })),
        ...(contract.quota ? { quota: contract.quota } : {}),
        readableSchemaVersions: contract.readableSchemaVersions,
        migrations: contract.migrations,
        identityFields: contract.identityFields,
    });
}

function contractRef(contract: NormalizedPluginAccountCollectionContractV1): PluginCollectionContractRefV1 {
    return {
        pluginId: contract.pluginId,
        collectionId: contract.collectionId,
        schemaVersion: contract.schemaVersion,
        contractDigest: contract.contractDigest,
    };
}

function canonicalizeWritableContractRefs(input: Readonly<{
    pluginId: string;
    contracts: unknown;
}>): readonly PluginCollectionContractRefV1[] {
    try {
        const pluginId = PluginIdSchema.parse(input.pluginId);
        const contracts = z.array(PluginCollectionContractRefV1Schema).check(z.maxLength(32)).parse(input.contracts);
        const collectionIds = new Set<string>();
        for (const contract of contracts) {
            if (contract.pluginId !== pluginId || collectionIds.has(contract.collectionId)) {
                throw new Error("Writable contracts must be unique and belong to the selected plugin.");
            }
            collectionIds.add(contract.collectionId);
        }
        return Object.freeze([...contracts].sort((left, right) => (
            left.collectionId < right.collectionId ? -1 : left.collectionId > right.collectionId ? 1 : 0
        )));
    } catch {
        throw new PluginCollectionWriterReadinessError("collection_writer_contract_invalid");
    }
}

/**
 * Reads one exact immutable contract fact for Data-owned readiness and query
 * callers. It intentionally knows nothing about release selection.
 */
export async function findExactMaterializedPluginCollectionContractTx(input: Readonly<{
    tx: Pick<Tx, 'pluginCollectionContract'>;
    ref: PluginCollectionContractRefV1;
}>): Promise<(StoredPluginCollectionContractRow & Readonly<{ id: string }>) | null> {
    return await input.tx.pluginCollectionContract.findFirst({
        where: {
            pluginId: input.ref.pluginId,
            collectionId: input.ref.collectionId,
            schemaVersion: input.ref.schemaVersion,
            contractDigest: input.ref.contractDigest,
        },
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
    });
}

async function readExactMaterializedPluginCollectionContractTx(input: Readonly<{
    tx: Tx;
    ref: PluginCollectionContractRefV1;
}>): Promise<Readonly<{
    id: string;
    contract: NormalizedPluginAccountCollectionContractV1;
}>> {
    const persisted = await findExactMaterializedPluginCollectionContractTx(input);
    if (!persisted) {
        throw new PluginCollectionWriterReadinessError("collection_writer_contract_unavailable");
    }
    try {
        const contract = readMaterializedPluginCollectionContract(persisted);
        if (
            contract.pluginId !== input.ref.pluginId
            || contract.collectionId !== input.ref.collectionId
            || contract.schemaVersion !== input.ref.schemaVersion
            || contract.contractDigest !== input.ref.contractDigest
        ) {
            throw new Error("Persisted contract did not reconstruct to the requested immutable ref.");
        }
        return { id: persisted.id, contract };
    } catch {
        throw new PluginCollectionWriterReadinessError("collection_writer_contract_unavailable");
    }
}

function assertReadyIndexState(input: Readonly<{
    state: Readonly<{
        contractId: string;
        buildState: string;
        indexedThroughRevision: number | null;
    }> | null;
    contractId: string;
}>): void {
    if (
        !input.state
        || input.state.contractId !== input.contractId
        || input.state.buildState !== "ready"
        || input.state.indexedThroughRevision === null
    ) {
        throw new PluginCollectionWriterReadinessError("collection_writer_contract_not_ready");
    }
}

async function prepareIndexStateTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    pluginId: string;
    collectionId: string;
    indexId: string;
    contractId: string;
    contractDigest: string;
    hasRows: boolean;
}>): Promise<void> {
    const identity = {
        accountId: input.accountId,
        pluginId: input.pluginId,
        collectionId: input.collectionId,
        indexId: input.indexId,
        contractDigest: input.contractDigest,
    };
    const select = {
        contractId: true,
        buildState: true,
        indexedThroughRevision: true,
    } as const;
    let state = await input.tx.pluginCollectionIndexState.findUnique({
        where: { accountId_pluginId_collectionId_indexId_contractDigest: identity },
        select,
    });
    if (!state && !input.hasRows) {
        try {
            state = await input.tx.pluginCollectionIndexState.create({
                data: {
                    ...identity,
                    contractId: input.contractId,
                    buildState: "ready",
                    indexedThroughRevision: 0,
                },
                select,
            });
        } catch (error) {
            if (!isPrismaErrorCode(error, "P2002")) throw error;
            state = await input.tx.pluginCollectionIndexState.findUnique({
                where: { accountId_pluginId_collectionId_indexId_contractDigest: identity },
                select,
            });
        }
    }
    assertReadyIndexState({ state, contractId: input.contractId });
}

/**
 * Reconstructs the admitted static contract from its immutable Data-owned
 * columns. A malformed/corrupt persisted contract is never interpreted as a
 * looser query descriptor.
 */
function reconstructMaterializedPluginCollectionContract(
    row: StoredPluginCollectionContractRow,
): PreparedMaterializedCollectionContract {
    try {
        const key = JSON.stringify([row.pluginId, row.collectionId, row.schemaVersion, row.contractDigest]);
        // Prisma returns fresh JSON objects. Compare their stored representation,
        // without parsing or normalizing the schema again. A changed/corrupt row
        // under the same digest must still pass the original consistency check.
        const stored = JSON.stringify([row.normalizedSchema, row.indexes, row.relations, row.privacyProjection]);
        const admitted = preparedMaterializedContracts.get(key);
        if (admitted?.stored === stored) return admitted.prepared;
        const privacy = PersistedPrivacyProjectionV1Schema.parse(row.privacyProjection);
        const { contribution, normalized } = preparePluginAccountCollectionContractV1({
            pluginId: row.pluginId,
            contribution: {
                id: row.collectionId,
                schemaVersion: row.schemaVersion,
                schema: row.normalizedSchema,
                rowIdField: privacy.rowIdField,
                serverReadable: privacy.serverReadable,
                indexes: row.indexes,
                uiQueries: privacy.uiQueries,
                relations: row.relations,
                ...(privacy.quota ? { quota: privacy.quota } : {}),
                readableSchemaVersions: privacy.readableSchemaVersions,
                migrations: privacy.migrations,
                identityFields: privacy.identityFields,
            },
        });
        if (normalized.contractDigest !== row.contractDigest) {
            throw new PluginCollectionContractMaterializationError("collection_contract_inconsistent");
        }
        const prepared = Object.freeze({ contribution, normalized });
        preparedMaterializedContracts.set(key, Object.freeze({ stored, prepared }));
        return prepared;
    } catch (error) {
        if (error instanceof PluginCollectionContractMaterializationError) throw error;
        throw new PluginCollectionContractMaterializationError("collection_contract_inconsistent");
    }
}

export function readMaterializedPluginCollectionContract(
    row: StoredPluginCollectionContractRow,
): NormalizedPluginAccountCollectionContractV1 {
    return reconstructMaterializedPluginCollectionContract(row).normalized;
}

export function readMaterializedPluginCollectionDeclaration(
    row: StoredPluginCollectionContractRow,
): PluginAccountCollectionContributionV1 {
    return reconstructMaterializedPluginCollectionContract(row).contribution;
}

/**
 * Contract identity is the digest: the same `(plugin, collection,
 * schemaVersion)` may exist under several digests because each Account's
 * writer pointer, not a global row, selects the one it writes. A global
 * schemaVersion uniqueness would let any Account's first materialization
 * squat that coordinate for every other Account on the server.
 */
async function assertExistingContract(
    tx: Tx,
    contract: NormalizedPluginAccountCollectionContractV1,
): Promise<boolean> {
    const existing = await tx.pluginCollectionContract.findFirst({
        where: {
            pluginId: contract.pluginId,
            collectionId: contract.collectionId,
            contractDigest: contract.contractDigest,
        },
        select: {
            pluginId: true,
            collectionId: true,
            schemaVersion: true,
            contractDigest: true,
            normalizedSchema: true,
            indexes: true,
            relations: true,
            privacyProjection: true,
        },
    });
    if (!existing) return false;
    // Reconstruction recomputes the digest from the stored columns, so a
    // corrupt row is typed inconsistent rather than silently reused.
    readMaterializedPluginCollectionContract(existing);
    return true;
}

async function materializeOnePluginCollectionContractTx(
    tx: Tx,
    contract: NormalizedPluginAccountCollectionContractV1,
): Promise<void> {
    if (await assertExistingContract(tx, contract)) return;
    const data = {
        pluginId: contract.pluginId,
        collectionId: contract.collectionId,
        schemaVersion: contract.schemaVersion,
        contractDigest: contract.contractDigest,
        normalizedSchema: toPrismaJson(contract.schema),
        indexes: toPrismaJson(contract.indexes),
        relations: toPrismaJson(contract.relations),
        privacyProjection: storedPrivacyProjection(contract),
    };
    if (getDbProviderFromEnv(process.env, "postgres") !== "sqlite") {
        // Contracts are shared across Accounts, whose publication fences are
        // independent. A duplicate insert must not abort PostgreSQL before
        // this canonical owner can reconstruct and validate the winner.
        const inserted = await tx.pluginCollectionContract.createMany({ data, skipDuplicates: true });
        if (inserted.count === 0 && !await assertExistingContract(tx, contract)) {
            throw new PluginCollectionContractMaterializationError("collection_contract_inconsistent");
        }
        return;
    }
    try {
        await tx.pluginCollectionContract.create({ data });
    } catch (error) {
        if (!isPrismaErrorCode(error, "P2002")) throw error;
        if (!await assertExistingContract(tx, contract)) throw error;
    }
}

/**
 * The sole server ingress from admitted author declarations to immutable Data
 * contracts. It deliberately receives no Account, release, artifact,
 * generation, or package identity; the digest is always recomputed here.
 */
export async function materializePluginCollectionContractsTx(input: Readonly<{
    tx: Tx;
    pluginId: string;
    contributions: readonly PluginAccountCollectionContributionV1[];
}>): Promise<readonly PluginCollectionContractRefV1[]> {
    let contracts: readonly NormalizedPluginAccountCollectionContractV1[];
    try {
        contracts = normalizePluginAccountCollectionContractsV1({
            pluginId: input.pluginId,
            contributions: input.contributions,
        });
    } catch {
        throw new PluginCollectionContractMaterializationError("collection_contract_invalid");
    }
    for (const contract of contracts) {
        await materializeOnePluginCollectionContractTx(input.tx, contract);
    }
    return Object.freeze(contracts.map(contractRef));
}

/** Release publication's manifest wrapper over the declaration ingress. */
export async function materializePluginCollectionContractsFromManifestTx(input: Readonly<{
    tx: Tx;
    manifest: unknown;
}>): Promise<readonly PluginCollectionContractRefV1[]> {
    const manifest = PluginManifestV2Schema.parse(input.manifest);
    return await materializePluginCollectionContractsTx({
        tx: input.tx,
        pluginId: manifest.id,
        contributions: manifest.contributes.accountCollections,
    });
}

/**
 * Data's one readiness gate before Availability atomically publishes an
 * Account's current writable contract references. It has no release lookup or
 * currentness decision: Availability verifies that the requested references
 * belong to its selected release, then stores this canonical result in its
 * own intent row in the same transaction.
 *
 * Empty collections receive their ready index-state records here. A collection
 * with existing rows must already match the requested contract and have every
 * declared index prepared; this gate does not transform existing rows.
 */
export async function preparePluginCollectionWritableContractsTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    pluginId: string;
    contracts: unknown;
}>): Promise<Readonly<{
    contracts: readonly PluginCollectionContractRefV1[];
}>> {
    const contracts = canonicalizeWritableContractRefs({
        pluginId: input.pluginId,
        contracts: input.contracts,
    });
    const account = await input.tx.account.findUnique({
        where: { id: input.accountId },
        select: { id: true },
    });
    if (!account) {
        throw new PluginCollectionWriterReadinessError("collection_writer_contract_unavailable");
    }

    const materializedContracts: Array<Readonly<{
        ref: PluginCollectionContractRefV1;
        id: string;
        contract: NormalizedPluginAccountCollectionContractV1;
    }>> = [];
    for (const ref of contracts) {
        const materialized = await readExactMaterializedPluginCollectionContractTx({ tx: input.tx, ref });
        materializedContracts.push({
            ref,
            ...materialized,
        });
    }

    let usage;
    try {
        usage = await readPluginCollectionAccountActivationUsageInTx({
            tx: input.tx,
            accountId: input.accountId,
            deployment: readPluginsFeatureEnv(process.env).collectionLimits,
        });
    } catch (error) {
        if (error instanceof PluginCollectionQuotaCensusInconsistencyError) {
            throw new PluginCollectionWriterReadinessError("collection_writer_contract_not_ready");
        }
        throw error;
    }
    let prefixUsage: PluginCollectionPrefixQuotaUsage;
    try {
        prefixUsage = await readPluginCollectionPrefixQuotaUsageInTx({
            tx: input.tx,
            accountId: input.accountId,
            usage,
            policies: materializedContracts.map(({ id, contract }) => ({
                pluginId: contract.pluginId,
                collectionId: contract.collectionId,
                contractId: id,
                contractDigest: contract.contractDigest,
                quota: contract.quota,
                schema: contract.schema,
                indexes: contract.indexes,
            })),
        });
    } catch (error) {
        if (error instanceof PluginCollectionQuotaCensusInconsistencyError) {
            throw new PluginCollectionWriterReadinessError("collection_writer_contract_not_ready");
        }
        throw error;
    }
    const quotaIncompatibility = findPluginCollectionActivationQuotaIncompatibility({
        deployment: readPluginsFeatureEnv(process.env).collectionLimits,
        usage,
        collections: materializedContracts.map(({ contract }) => ({
            pluginId: contract.pluginId,
            collectionId: contract.collectionId,
            quota: contract.quota,
        })),
        prefixUsage,
    });
    if (quotaIncompatibility) {
        throw new PluginCollectionWriterReadinessError(
            "collection_quota_incompatible",
            quotaIncompatibility,
        );
    }

    for (const materialized of materializedContracts) {
        const { ref } = materialized;
        const existingRow = await input.tx.pluginCollectionRow.findFirst({
            where: {
                accountId: input.accountId,
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                deletedAt: null,
            },
            select: { id: true },
        });
        for (const index of materialized.contract.indexes) {
            await prepareIndexStateTx({
                tx: input.tx,
                accountId: input.accountId,
                pluginId: ref.pluginId,
                collectionId: ref.collectionId,
                indexId: index.id,
                contractId: materialized.id,
                contractDigest: ref.contractDigest,
                hasRows: existingRow !== null,
            });
        }
    }
    return { contracts };
}
