import type { Tx } from "@/storage/inTx";
import { getActivePrismaRuntime, getDbProviderFromEnv } from "@/storage/prisma";
import { readArtifactStorageEnv } from "@/app/features/catalog/readFeatureEnv";
import { artifactOrdinarySqlPredicate } from "./artifactClassification";
import type { ArtifactQuotaExceededV1, ArtifactStorageUsageV1 } from "@happier-dev/protocol";

export type ArtifactQuotaExceeded = ArtifactQuotaExceededV1;

export class ArtifactStorageSizeUnavailableError extends Error {
    readonly code = 'storage_size_out_of_range';
    constructor() { super('Artifact storage size cannot be represented by the wire integer contract'); }
}

function storageSize(value: bigint | number | string): number {
    const size = Number(value);
    if (!Number.isSafeInteger(size) || size < 0) throw new ArtifactStorageSizeUnavailableError();
    return size;
}

function storageSql() {
    const sql = getActivePrismaRuntime();
    const provider = getDbProviderFromEnv(process.env, "postgres");
    const mysql = provider === "mysql";
    const identifier = (value: string) => sql.raw(mysql ? `\`${value}\`` : `"${value}"`);
    const bytes = (column: string, alias?: "r") => sql.sql`${sql.raw(provider === "sqlite" ? "LENGTH" : "OCTET_LENGTH")}(${sql.raw(alias ? `${alias}.` : "")}${identifier(column)})`;
    return { sql, identifier, bytes, mysql };
}

/** Count persisted content without fetching ciphertext. Classification stays with its canonical owner. */
export async function readArtifactStorageUsageInTx(tx: Tx, accountId: string): Promise<ArtifactStorageUsageV1> {
    const config = readArtifactStorageEnv(process.env);
    const { sql, identifier, bytes, mysql } = storageSql();
    const ordinary = sql.raw(artifactOrdinarySqlPredicate(mysql));
    const rows = await tx.$queryRaw<Array<{ usedBytes: bigint | number | string }>>(sql.sql`
        SELECT COALESCE(SUM(${identifier("contentBytes")}), 0) AS ${identifier("usedBytes")} FROM (
            SELECT ${bytes("header")} + ${bytes("body")} + COALESCE(${bytes("provenance")}, 0) AS ${identifier("contentBytes")}
            FROM ${identifier("Artifact")} a WHERE a.${identifier("accountId")} = ${accountId} AND ${ordinary}
            UNION ALL
            SELECT ${bytes("body", "r")} + COALESCE(${bytes("provenance", "r")}, 0) AS ${identifier("contentBytes")}
            FROM ${identifier("ArtifactRevision")} r INNER JOIN ${identifier("Artifact")} a ON r.${identifier("artifactId")} = a.${identifier("id")}
            WHERE a.${identifier("accountId")} = ${accountId} AND ${ordinary}
            UNION ALL
            SELECT b.${identifier("storedSizeBytes")} AS ${identifier("contentBytes")}
            FROM ${identifier("ArtifactBlob")} b INNER JOIN ${identifier("Artifact")} a ON b.${identifier("artifactId")} = a.${identifier("id")}
            WHERE a.${identifier("accountId")} = ${accountId} AND ${ordinary}
        ) ${identifier("content")}`);
    return { usedBytes: storageSize(rows[0]?.usedBytes ?? 0), limitBytes: config.accountLimitBytes,
        documentLimitBytes: config.documentLimitBytes, revisionRetentionCount: config.revisionRetentionCount };
}

/** Project retention before the write, so quota refusal leaves head, history and changes untouched. */
export async function checkArtifactStorageBudgetInTx(tx: Tx, input: Readonly<{
    accountId: string;
    artifactId: string;
    nextHeaderBytes: number;
    nextBodyBytes: number;
    nextProvenanceBytes?: number;
    currentHeaderBytes?: number;
    currentBodyBytes?: number;
    currentProvenanceBytes?: number;
    retainCurrentBody?: boolean;
    revisionBytesDelta?: number;
    currentBlobId?: string | null;
    nextBlobId?: string | null;
    candidateBlobBytes?: number;
    blobBytesDelta?: number;
}>): Promise<ArtifactQuotaExceeded | null> {
    const config = readArtifactStorageEnv(process.env);
    if (config.documentLimitBytes === null && config.accountLimitBytes === null) return null;
    const headBytes = storageSize(input.nextHeaderBytes + input.nextBodyBytes + (input.nextProvenanceBytes ?? 0));
    const { sql, identifier, bytes } = storageSql();
    const rows = await tx.$queryRaw<Array<{ sizeBytes: bigint | number | string; blobId: string | null }>>(sql.sql`
        SELECT ${bytes("body")} + COALESCE(${bytes("provenance")}, 0) AS ${identifier("sizeBytes")}, ${identifier("blobId")} FROM ${identifier("ArtifactRevision")}
        WHERE ${identifier("artifactId")} = ${input.artifactId} ORDER BY ${identifier("bodyVersion")} DESC`);
    const currentRevisionBytes = storageSize(rows.reduce((sum, row) => sum + storageSize(row.sizeBytes), 0));
    const removedRevisionBytes = input.retainCurrentBody
        ? rows.slice(Math.max(0, config.revisionRetentionCount - 1)).reduce((sum, row) => sum + storageSize(row.sizeBytes), 0)
        : 0;
    const revisionBytesDelta = (input.retainCurrentBody && config.revisionRetentionCount > 0 ? (input.currentBodyBytes ?? 0) + (input.currentProvenanceBytes ?? 0) : 0)
        - removedRevisionBytes + (input.revisionBytesDelta ?? 0);
    const blobs = await tx.artifactBlob.findMany({ where: { artifactId: input.artifactId }, select: { id: true, storedSizeBytes: true } });
    const currentBlobBytes = storageSize(blobs.reduce((sum, blob) => sum + storageSize(blob.storedSizeBytes), 0));
    const retainedRows = input.retainCurrentBody ? rows.slice(0, Math.max(0, config.revisionRetentionCount - 1)) : rows;
    const retainedIds = new Set(retainedRows.flatMap(row => row.blobId ? [row.blobId] : []));
    if (input.retainCurrentBody && config.revisionRetentionCount > 0 && input.currentBlobId) retainedIds.add(input.currentBlobId);
    const nextBlobId = input.nextBlobId === undefined ? input.currentBlobId : input.nextBlobId;
    if (nextBlobId) retainedIds.add(nextBlobId);
    const projectedBlobBytes = storageSize(blobs.filter(blob => retainedIds.has(blob.id)).reduce((sum, blob) => sum + storageSize(blob.storedSizeBytes), 0)
        + (input.candidateBlobBytes ?? 0) + (input.blobBytesDelta ?? 0));
    const documentBytes = storageSize(headBytes + currentRevisionBytes + revisionBytesDelta + projectedBlobBytes);
    if (config.documentLimitBytes !== null && documentBytes > config.documentLimitBytes) {
        return { error: "quota_exceeded", budget: "document", limitBytes: config.documentLimitBytes, usedBytes: documentBytes };
    }
    if (config.accountLimitBytes === null) return null;
    const usage = await readArtifactStorageUsageInTx(tx, input.accountId);
    const usedBytes = storageSize(usage.usedBytes + headBytes - (input.currentHeaderBytes ?? 0) - (input.currentBodyBytes ?? 0) - (input.currentProvenanceBytes ?? 0)
        + revisionBytesDelta + projectedBlobBytes - currentBlobBytes);
    return usedBytes > config.accountLimitBytes
        ? { error: "quota_exceeded", budget: "account", limitBytes: config.accountLimitBytes, usedBytes }
        : null;
}

/** Successful body CAS writes retain the displaced stored bytes in the same transaction. */
export async function retainArtifactBodyRevisionInTx(tx: Tx, input: Readonly<{
    artifactId: string;
    bodyVersion: number;
    body: Uint8Array;
    provenance?: Uint8Array | null;
    blobId?: string | null;
}>) {
    const { revisionRetentionCount } = readArtifactStorageEnv(process.env);
    if (revisionRetentionCount > 0) {
        await tx.artifactRevision.create({ data: { ...input, body: Buffer.from(input.body), provenance: input.provenance ? Buffer.from(input.provenance) : null } });
    }
    const retained = await tx.artifactRevision.findMany({ where: { artifactId: input.artifactId },
        orderBy: { bodyVersion: "desc" }, take: revisionRetentionCount, select: { bodyVersion: true } });
    await tx.artifactRevision.deleteMany({ where: { artifactId: input.artifactId,
        bodyVersion: { notIn: retained.map(row => row.bodyVersion) } } });
}
