import type { Tx } from "@/storage/inTx";
import { getDbProviderFromEnv, type DbProvider } from "@/storage/prisma";
import type {
    NormalizedPluginAccountCollectionContractV1,
    PluginCollectionProjectionV1,
} from "@happier-dev/protocol";

import {
    buildPluginCollectionIndexEntries,
    buildPluginCollectionIndexValues,
    materializePluginCollectionRelationReplacementInTx,
    type PluginCollectionIndexValue,
    type PluginCollectionPreparedRelationReplacement,
    type ResolvedWritableCollection,
    updateIndexReadinessInTx,
} from "./mutation";

type CandidatePromotionContract = Readonly<{
    contractId: string;
    schemaVersion: number;
    contractDigest: string;
}>;

type CandidatePromotionRowUpdate = Readonly<{
    id: string;
    expectedRevision: number;
    nextRevision: number;
    contentEnvelopeJson: string;
}>;

type CandidatePromotionRowUpdateInput = Readonly<{
    tx: Pick<Tx, "$executeRawUnsafe">;
    provider: DbProvider;
    accountId: string;
    source: CandidatePromotionContract;
    target: CandidatePromotionContract;
    rows: readonly CandidatePromotionRowUpdate[];
}>;

type CandidatePromotionMaterializedRow = Readonly<{
    id: string;
    rowId: string;
    expectedRevision: number;
    contentEnvelopeJson: string;
    projections: readonly Readonly<{
        fieldId: string;
        typedEncodedValue: string;
    }>[];
    indexValues: readonly PluginCollectionIndexValue[];
}>;

type CandidatePromotionMaterializationInput = Readonly<{
    tx: Tx;
    accountId: string;
    source: CandidatePromotionContract;
    target: CandidatePromotionContract;
    resolved: ResolvedWritableCollection;
    rows: readonly CandidatePromotionMaterializedRow[];
    relations: PluginCollectionPreparedRelationReplacement;
    maximumBatchRows: number;
}>;

function jsonParameter(value: unknown): string {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new TypeError("Candidate promotion content must be JSON serializable.");
    }
    return serialized;
}

function rowParameters(input: CandidatePromotionRowUpdateInput): unknown[] {
    return input.rows.flatMap((row) => [
        row.id,
        row.expectedRevision,
        input.target.schemaVersion,
        row.nextRevision,
        input.target.contractId,
        input.target.contractDigest,
        row.contentEnvelopeJson,
    ]);
}

function sqlitePromotionRowUpdateQuery(input: CandidatePromotionRowUpdateInput): Readonly<{
    query: string;
    parameters: unknown[];
}> {
    const values = input.rows.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    return {
        query: `
            WITH "candidate"(
                "id",
                "expectedRevision",
                "nextSchemaVersion",
                "nextRevision",
                "nextContractId",
                "nextContractDigest",
                "nextContentEnvelope"
            ) AS (VALUES ${values})
            UPDATE "PluginCollectionRow" AS "row"
            SET
                "schemaVersion" = (
                    SELECT "nextSchemaVersion" FROM "candidate"
                    WHERE "candidate"."id" = "row"."id"
                ),
                "revision" = (
                    SELECT "nextRevision" FROM "candidate"
                    WHERE "candidate"."id" = "row"."id"
                ),
                "contractId" = (
                    SELECT "nextContractId" FROM "candidate"
                    WHERE "candidate"."id" = "row"."id"
                ),
                "contractDigest" = (
                    SELECT "nextContractDigest" FROM "candidate"
                    WHERE "candidate"."id" = "row"."id"
                ),
                "contentEnvelope" = json((
                    SELECT "nextContentEnvelope" FROM "candidate"
                    WHERE "candidate"."id" = "row"."id"
                )),
                "updatedAt" = CURRENT_TIMESTAMP
            WHERE
                "row"."accountId" = ?
                AND "row"."deletedAt" IS NULL
                AND "row"."contractId" = ?
                AND "row"."schemaVersion" = ?
                AND "row"."contractDigest" = ?
                AND EXISTS (
                    SELECT 1 FROM "candidate"
                    WHERE
                        "candidate"."id" = "row"."id"
                        AND "candidate"."expectedRevision" = "row"."revision"
                )
        `,
        parameters: [
            ...rowParameters(input),
            input.accountId,
            input.source.contractId,
            input.source.schemaVersion,
            input.source.contractDigest,
        ],
    };
}

function postgresPromotionRowUpdateQuery(input: CandidatePromotionRowUpdateInput): Readonly<{
    query: string;
    parameters: unknown[];
}> {
    let position = 0;
    const parameter = (cast: string): string => `$${++position}::${cast}`;
    const values = input.rows.map(() => `(
        ${parameter("text")},
        ${parameter("integer")},
        ${parameter("integer")},
        ${parameter("integer")},
        ${parameter("text")},
        ${parameter("text")},
        ${parameter("jsonb")}
    )`).join(", ");
    const accountId = parameter("text");
    const sourceContractId = parameter("text");
    const sourceSchemaVersion = parameter("integer");
    const sourceContractDigest = parameter("text");
    return {
        query: `
            UPDATE "PluginCollectionRow" AS "row"
            SET
                "schemaVersion" = "candidate"."nextSchemaVersion",
                "revision" = "candidate"."nextRevision",
                "contractId" = "candidate"."nextContractId",
                "contractDigest" = "candidate"."nextContractDigest",
                "contentEnvelope" = "candidate"."nextContentEnvelope",
                "updatedAt" = CURRENT_TIMESTAMP
            FROM (VALUES ${values}) AS "candidate"(
                "id",
                "expectedRevision",
                "nextSchemaVersion",
                "nextRevision",
                "nextContractId",
                "nextContractDigest",
                "nextContentEnvelope"
            )
            WHERE
                "candidate"."id" = "row"."id"
                AND "row"."accountId" = ${accountId}
                AND "row"."deletedAt" IS NULL
                AND "row"."contractId" = ${sourceContractId}
                AND "row"."schemaVersion" = ${sourceSchemaVersion}
                AND "row"."contractDigest" = ${sourceContractDigest}
                AND "row"."revision" = "candidate"."expectedRevision"
        `,
        parameters: [
            ...rowParameters(input),
            input.accountId,
            input.source.contractId,
            input.source.schemaVersion,
            input.source.contractDigest,
        ],
    };
}

function mysqlPromotionRowUpdateQuery(input: CandidatePromotionRowUpdateInput): Readonly<{
    query: string;
    parameters: unknown[];
}> {
    const selects = input.rows.map((_, index) => (
        index === 0
            ? `SELECT
                ? AS \`id\`,
                ? AS \`expectedRevision\`,
                ? AS \`nextSchemaVersion\`,
                ? AS \`nextRevision\`,
                ? AS \`nextContractId\`,
                ? AS \`nextContractDigest\`,
                CAST(? AS JSON) AS \`nextContentEnvelope\``
            : `SELECT
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                CAST(? AS JSON)`
    )).join(" UNION ALL ");
    return {
        query: `
            UPDATE \`PluginCollectionRow\` AS \`row\`
            INNER JOIN (${selects}) AS \`candidate\`
                ON \`candidate\`.\`id\` = \`row\`.\`id\`
            SET
                \`row\`.\`schemaVersion\` = \`candidate\`.\`nextSchemaVersion\`,
                \`row\`.\`revision\` = \`candidate\`.\`nextRevision\`,
                \`row\`.\`contractId\` = \`candidate\`.\`nextContractId\`,
                \`row\`.\`contractDigest\` = \`candidate\`.\`nextContractDigest\`,
                \`row\`.\`contentEnvelope\` = \`candidate\`.\`nextContentEnvelope\`,
                \`row\`.\`updatedAt\` = CURRENT_TIMESTAMP
            WHERE
                \`row\`.\`accountId\` = ?
                AND \`row\`.\`deletedAt\` IS NULL
                AND \`row\`.\`contractId\` = ?
                AND \`row\`.\`schemaVersion\` = ?
                AND \`row\`.\`contractDigest\` = ?
                AND \`row\`.\`revision\` = \`candidate\`.\`expectedRevision\`
        `,
        parameters: [
            ...rowParameters(input),
            input.accountId,
            input.source.contractId,
            input.source.schemaVersion,
            input.source.contractDigest,
        ],
    };
}

/**
 * Prisma cannot express one heterogeneous revision-fenced update. This is the
 * sole provider-specific adapter inside candidate promotion; each arm applies
 * the same exact source-contract/revision predicate and returns false unless
 * the complete supplied set was affected.
 */
export async function applyCandidatePromotionRowUpdatesSetwiseInTx(
    input: CandidatePromotionRowUpdateInput,
): Promise<boolean> {
    if (input.rows.length === 0) return true;
    if (new Set(input.rows.map((row) => row.id)).size !== input.rows.length) {
        throw new Error("Candidate promotion row ids must be unique.");
    }
    const statement = input.provider === "sqlite"
        ? sqlitePromotionRowUpdateQuery(input)
        : input.provider === "mysql"
            ? mysqlPromotionRowUpdateQuery(input)
            : postgresPromotionRowUpdateQuery(input);
    const affectedRows = await input.tx.$executeRawUnsafe(
        statement.query,
        ...statement.parameters,
    );
    return affectedRows === input.rows.length;
}

function boundedChunks<T>(items: readonly T[], maximumSize: number): T[][] {
    if (!Number.isSafeInteger(maximumSize) || maximumSize < 1) {
        throw new Error("Candidate promotion batch size must be a positive safe integer.");
    }
    const chunks: T[][] = [];
    for (let start = 0; start < items.length; start += maximumSize) {
        chunks.push(items.slice(start, start + maximumSize));
    }
    return chunks;
}

function encodeProjectionValue(value: unknown): string {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
        throw new TypeError("Candidate promotion projection values must be JSON serializable.");
    }
    return encoded;
}

type CandidatePromotionUnmaterializedRow = Readonly<{
    id: string;
    rowId: string;
    expectedRevision: number;
    contentEnvelope: unknown;
    projection: PluginCollectionProjectionV1;
}>;

/**
 * Validates every byte that the setwise materializer will later write without
 * requiring target index-state ids. The caller runs this before the first
 * promotion write, then preserves these exact values through materialization.
 */
export function prepareCandidatePromotionMaterializedRows(input: Readonly<{
    contract: NormalizedPluginAccountCollectionContractV1;
    rows: readonly CandidatePromotionUnmaterializedRow[];
}>): readonly CandidatePromotionMaterializedRow[] {
    if (new Set(input.rows.map((row) => row.id)).size !== input.rows.length) {
        throw new Error("Candidate promotion row ids must be unique.");
    }
    return input.rows.map((row) => ({
        id: row.id,
        rowId: row.rowId,
        expectedRevision: row.expectedRevision,
        contentEnvelopeJson: jsonParameter(row.contentEnvelope),
        projections: input.contract.serverReadable.map((fieldId) => ({
            fieldId,
            typedEncodedValue: encodeProjectionValue(row.projection[fieldId]),
        })),
        indexValues: buildPluginCollectionIndexValues({
            contract: input.contract,
            rowId: row.rowId,
            projection: row.projection,
        }),
    }));
}

/**
 * The single Data-owned materialization primitive for a fully validated
 * candidate set. Availability owns the enclosing transaction and intent CAS;
 * this function never selects or publishes a release.
 */
export async function materializeCandidatePromotionSetwiseInTx(
    input: CandidatePromotionMaterializationInput,
): Promise<boolean> {
    const sourceRowIds = input.rows.map((row) => row.id);
    const projections = input.rows.flatMap((row) => (
        row.projections.map((projection) => ({
            rowDbId: row.id,
            accountId: input.accountId,
            pluginId: input.resolved.contract.pluginId,
            collectionId: input.resolved.contract.collectionId,
            rowId: row.rowId,
            fieldId: projection.fieldId,
            typedEncodedValue: projection.typedEncodedValue,
            rowRevision: row.expectedRevision + 1,
        }))
    ));
    const indexEntries = input.rows.flatMap((row) => (
        buildPluginCollectionIndexEntries({
            resolved: input.resolved,
            rowId: row.rowId,
            revision: row.expectedRevision + 1,
            projection: null,
            values: row.indexValues,
        })
    ));
    const projectionsByRowDbId = new Map<string, typeof projections>();
    for (const projection of projections) {
        const existing = projectionsByRowDbId.get(projection.rowDbId) ?? [];
        existing.push(projection);
        projectionsByRowDbId.set(projection.rowDbId, existing);
    }
    const indexEntriesByRowId = new Map<string, typeof indexEntries>();
    for (const entry of indexEntries) {
        const existing = indexEntriesByRowId.get(entry.rowId) ?? [];
        existing.push(entry);
        indexEntriesByRowId.set(entry.rowId, existing);
    }
    const provider = getDbProviderFromEnv(process.env, "postgres");

    // All relation/index/projection/content validation happened before target
    // derived-state setup. This only applies the prepared relation plan.
    await materializePluginCollectionRelationReplacementInTx({
        tx: input.tx,
        accountId: input.accountId,
        contract: input.resolved.contract,
        prepared: input.relations,
        maximumBatchRows: input.maximumBatchRows,
    });
    for (const rows of boundedChunks(input.rows, input.maximumBatchRows)) {
        const applied = await applyCandidatePromotionRowUpdatesSetwiseInTx({
            tx: input.tx,
            provider,
            accountId: input.accountId,
            source: input.source,
            target: input.target,
            rows: rows.map((row) => ({
                id: row.id,
                expectedRevision: row.expectedRevision,
                nextRevision: row.expectedRevision + 1,
                contentEnvelopeJson: row.contentEnvelopeJson,
            })),
        });
        if (!applied) return false;
    }
    for (const rowDbIds of boundedChunks(sourceRowIds, input.maximumBatchRows)) {
        await input.tx.pluginCollectionProjection.deleteMany({
            where: { rowDbId: { in: rowDbIds } },
        });
    }
    for (const rows of boundedChunks(input.rows, input.maximumBatchRows)) {
        const batch = rows.flatMap((row) => projectionsByRowDbId.get(row.id) ?? []);
        if (batch.length > 0) {
            await input.tx.pluginCollectionProjection.createMany({ data: batch });
        }
    }
    for (const rows of boundedChunks(input.rows, input.maximumBatchRows)) {
        const batch = rows.flatMap((row) => indexEntriesByRowId.get(row.rowId) ?? []);
        if (batch.length > 0) {
            await input.tx.pluginCollectionIndexEntry.createMany({ data: batch });
        }
    }
    await updateIndexReadinessInTx({
        tx: input.tx,
        accountId: input.accountId,
        resolved: input.resolved,
    });
    return true;
}
