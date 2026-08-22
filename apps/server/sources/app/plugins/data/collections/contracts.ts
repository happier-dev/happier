import type { Prisma } from "@prisma/client";
import {
    PluginAccountCollectionContributionV1Schema,
    PluginCollectionContractRefV1Schema,
    PluginCollectionMigrationDeclarationV1Schema,
    PluginCollectionQuotaRequestV1Schema,
    PluginCollectionUiQueryDescriptorV1Schema,
    PluginIdSchema,
    PluginManifestV2Schema,
    normalizePluginAccountCollectionContractV1,
    normalizePluginAccountCollectionContractsV1,
    type NormalizedPluginAccountCollectionContractV1,
    type PluginCollectionContractRefV1,
    type PluginCollectionQuotaDimensionV1,
} from "@happier-dev/protocol";
import { z } from "zod";

import { readPluginsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { isPrismaErrorCode } from "@/storage/db";
import type { Tx } from "@/storage/inTx";

import {
    findPluginCollectionActivationQuotaIncompatibility,
    PluginCollectionQuotaCensusInconsistencyError,
    readPluginCollectionAccountActivationUsageInTx,
    readPluginCollectionPrefixQuotaUsageInTx,
    type PluginCollectionQuotaIncompatibility,
    type PluginCollectionPrefixQuotaUsage,
} from "./quota";

const PersistedPrivacyProjectionV1Schema = z.object({
    v: z.literal(1),
    rowIdField: z.string(),
    serverReadable: z.array(z.string()),
    uiQueries: z.array(PluginCollectionUiQueryDescriptorV1Schema),
    quota: PluginCollectionQuotaRequestV1Schema.optional(),
    readableSchemaVersions: z.array(z.number().int().min(1)),
    // Absent on contracts materialized before finite migration identities were
    // added. The normalized empty chain deliberately retains the legacy digest.
    migrations: z.array(PluginCollectionMigrationDeclarationV1Schema).default([]),
    // Absent on contracts materialized before mode-derived identity was
    // declarable. An empty set is semantically "no mode-derived identity" and
    // likewise retains the legacy digest.
    identityFields: z.array(z.string()).default([]),
}).strict();

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

export class PluginCollectionContractMaterializationError extends Error {
    constructor(readonly code: "collection_contract_conflict" | "collection_contract_inconsistent") {
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
        const contracts = z.array(PluginCollectionContractRefV1Schema).max(32).parse(input.contracts);
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
async function readExactMaterializedPluginCollectionContractTx(input: Readonly<{
    tx: Tx;
    ref: PluginCollectionContractRefV1;
}>): Promise<Readonly<{
    id: string;
    contract: NormalizedPluginAccountCollectionContractV1;
}>> {
    const persisted = await input.tx.pluginCollectionContract.findFirst({
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
export function readMaterializedPluginCollectionContract(
    row: StoredPluginCollectionContractRow,
): NormalizedPluginAccountCollectionContractV1 {
    try {
        const privacy = PersistedPrivacyProjectionV1Schema.parse(row.privacyProjection);
        const contribution = PluginAccountCollectionContributionV1Schema.parse({
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
        });
        const normalized = normalizePluginAccountCollectionContractV1({
            pluginId: row.pluginId,
            contribution,
        });
        if (normalized.contractDigest !== row.contractDigest) {
            throw new PluginCollectionContractMaterializationError("collection_contract_inconsistent");
        }
        return normalized;
    } catch (error) {
        if (error instanceof PluginCollectionContractMaterializationError) throw error;
        throw new PluginCollectionContractMaterializationError("collection_contract_inconsistent");
    }
}

async function assertExistingContract(
    tx: Tx,
    contract: NormalizedPluginAccountCollectionContractV1,
): Promise<void> {
    const existing = await tx.pluginCollectionContract.findFirst({
        where: {
            pluginId: contract.pluginId,
            collectionId: contract.collectionId,
            schemaVersion: contract.schemaVersion,
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
    if (!existing) {
        throw new PluginCollectionContractMaterializationError("collection_contract_inconsistent");
    }
    if (existing.contractDigest !== contract.contractDigest) {
        throw new PluginCollectionContractMaterializationError("collection_contract_conflict");
    }
    const reconstructed = readMaterializedPluginCollectionContract(existing);
    if (reconstructed.contractDigest !== contract.contractDigest) {
        throw new PluginCollectionContractMaterializationError("collection_contract_inconsistent");
    }
}

async function materializeOnePluginCollectionContractTx(
    tx: Tx,
    contract: NormalizedPluginAccountCollectionContractV1,
): Promise<void> {
    const existing = await tx.pluginCollectionContract.findFirst({
        where: {
            pluginId: contract.pluginId,
            collectionId: contract.collectionId,
            schemaVersion: contract.schemaVersion,
        },
        select: { contractDigest: true },
    });
    if (existing) {
        await assertExistingContract(tx, contract);
        return;
    }

    try {
        await tx.pluginCollectionContract.create({
            data: {
                pluginId: contract.pluginId,
                collectionId: contract.collectionId,
                schemaVersion: contract.schemaVersion,
                contractDigest: contract.contractDigest,
                normalizedSchema: toPrismaJson(contract.schema),
                indexes: toPrismaJson(contract.indexes),
                relations: toPrismaJson(contract.relations),
                privacyProjection: storedPrivacyProjection(contract),
            },
        });
    } catch (error) {
        if (!isPrismaErrorCode(error, "P2002")) throw error;
        await assertExistingContract(tx, contract);
    }
}

/**
 * The sole server ingress from an admitted normalized manifest declaration to
 * immutable Data contracts. It deliberately receives no Account, release,
 * artifact, generation, or package identity.
 */
export async function materializePluginCollectionContractsFromManifestTx(input: Readonly<{
    tx: Tx;
    manifest: unknown;
}>): Promise<readonly PluginCollectionContractRefV1[]> {
    const manifest = PluginManifestV2Schema.parse(input.manifest);
    const contracts = normalizePluginAccountCollectionContractsV1({
        pluginId: manifest.id,
        contributions: manifest.contributes.accountCollections,
    });
    for (const contract of contracts) {
        await materializeOnePluginCollectionContractTx(input.tx, contract);
    }
    return Object.freeze(contracts.map(contractRef));
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
