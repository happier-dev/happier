import { inReadSnapshot, type Tx } from "@/storage/inTx";
import type { ApprovalInputCustody } from '@happier-dev/protocol/approvals/approvalInputCustody';
import { getActivePrismaRuntime, getDbProviderFromEnv } from "@/storage/prisma";
import { readArtifactStorageEnv } from "@/app/features/catalog/readFeatureEnv";
import { artifactOrdinarySqlPredicate, artifactVisibleWhere, viewerMayTrimArtifactRevisions } from "./artifactClassification";
import { decodeArtifactKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { viewerMayRemoveDiscussionAttachment } from '@/app/discussions/attachmentRemovalAuthority';
import { storePlainArtifactDbBytes } from "./artifactStoredContent";
import { uploadedPublicImageUrlReuseKeyPrefix } from "@/storage/blob/uploadImage";
import { publicProfilePictureAppliedReuseKey, publicProfilePictureRejectedReuseKey,
    publicProfilePictureWritingReuseKey } from "@/storage/privateFiles/accountPrivateFileCustody";
import { z } from 'zod/mini';
import { StorageInventoryKindV1Schema, type ArtifactQuotaExceededV1, type ArtifactStorageUsageV1,
    type StorageInventoryItemV1, type StorageInventoryKindV1,
    type StorageInventoryV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';

export type ArtifactQuotaExceeded = ArtifactQuotaExceededV1;

function retainedRevisionCount(configuredCount: number, custody: ApprovalInputCustody | undefined): number {
    return custody === 'live_only' ? 0 : configuredCount;
}

export class ArtifactStorageSizeUnavailableError extends Error {
    readonly code = 'storage_size_out_of_range';
    constructor() { super('Artifact storage size cannot be represented by the wire integer contract'); }
}

export function storageSize(value: bigint | number | string): number {
    const size = Number(value);
    if (!Number.isSafeInteger(size) || size < 0) throw new ArtifactStorageSizeUnavailableError();
    return size;
}

export function storageSql() {
    const sql = getActivePrismaRuntime();
    const provider = getDbProviderFromEnv(process.env, "postgres");
    const mysql = provider === "mysql";
    const identifier = (value: string) => sql.raw(mysql ? `\`${value}\`` : `"${value}"`);
    const bytes = (column: string, alias?: "r") => sql.sql`${sql.raw(provider === "sqlite" ? "LENGTH" : "OCTET_LENGTH")}(${sql.raw(alias ? `${alias}.` : "")}${identifier(column)})`;
    return { sql, identifier, bytes, mysql };
}

export function storedDateTimestamp(date: Date | bigint | number | string): number {
    return new Date(typeof date === 'bigint' ? Number(date) : date).getTime();
}

type Sql = ReturnType<ReturnType<typeof storageSql>['sql']['sql']>;
type ByteCount = bigint | number | string;

/** Each persisted blob contributes once, independently of how many versions reference it. */
function artifactByteRows(scope: Sql, splitHistory = false) {
    const { sql, identifier: name, bytes } = storageSql();
    const historyHead = splitHistory ? sql.sql`, 0 AS history` : sql.empty;
    const historyRevision = splitHistory ? sql.sql`, 1` : sql.empty;
    const historyBlob = splitHistory ? sql.sql`, CASE WHEN
        (a.${name("currentBlobId")} IS NULL OR a.${name("currentBlobId")} <> b.${name("id")})
        AND EXISTS (SELECT 1 FROM ${name("ArtifactRevision")} retained
            WHERE retained.${name("artifactId")} = a.${name("id")} AND retained.${name("blobId")} = b.${name("id")})
        THEN 1 ELSE 0 END` : sql.empty;
    return sql.sql`
        SELECT a.${name("id")} AS ${name("artifactId")},
            ${bytes("header")} + ${bytes("body")} + COALESCE(${bytes("provenance")}, 0) AS ${name("contentBytes")}
            ${historyHead}
        FROM ${name("Artifact")} a WHERE ${scope}
        UNION ALL
        SELECT r.${name("artifactId")}, ${bytes("body", "r")} + COALESCE(${bytes("provenance", "r")}, 0) ${historyRevision}
        FROM ${name("ArtifactRevision")} r INNER JOIN ${name("Artifact")} a ON r.${name("artifactId")} = a.${name("id")}
        WHERE ${scope}
        UNION ALL
        SELECT b.${name("artifactId")}, b.${name("storedSizeBytes")} ${historyBlob}
        FROM ${name("ArtifactBlob")} b INNER JOIN ${name("Artifact")} a ON b.${name("artifactId")} = a.${name("id")}
        WHERE ${scope}`;
}

/** Count persisted content without fetching ciphertext. Classification stays with its canonical owner. */
export async function readArtifactStorageUsageInTx(tx: Tx, accountId: string): Promise<ArtifactStorageUsageV1> {
    const config = readArtifactStorageEnv(process.env);
    const { sql, identifier, mysql } = storageSql();
    const ordinary = sql.raw(artifactOrdinarySqlPredicate(mysql));
    const rows = await tx.$queryRaw<Array<{ usedBytes: ByteCount }>>(sql.sql`
        SELECT COALESCE(SUM(${identifier("contentBytes")}), 0) AS ${identifier("usedBytes")}
        FROM (${artifactByteRows(sql.sql`a.${identifier("accountId")} = ${accountId} AND ${ordinary}`)}) content`);
    return { usedBytes: storageSize(rows[0]?.usedBytes ?? 0), limitBytes: config.accountLimitBytes,
        documentLimitBytes: config.documentLimitBytes, revisionRetentionCount: config.revisionRetentionCount };
}

type InventorySelection = Readonly<{
    discussionId?: string;
    kinds?: readonly StorageInventoryKindV1[];
    cursor?: string;
}>;

export class InvalidStorageInventoryCursorError extends Error {
    readonly code = 'invalid_storage_inventory_cursor';
}

const inventoryCursor = z.tuple([
    z.number().check(z.int(), z.minimum(-1)), StorageInventoryKindV1Schema, z.string(), z.string(),
]);
const inventoryPageSize = 10; // Approved storage view's page size.

type InventorySizeRow = { kind: StorageInventoryKindV1; storedSizeBytes: ByteCount | null };
type InventoryItemRow = InventorySizeRow & { itemId: string; parentKey: string; parentItemId: string | null;
    createdAt: Date | bigint | number | string | null; authorAccountId: string | null;
    discussionOwnerAccountId: string | null; artifactStoredKind: string | null;
    artifactDeletedAt: Date | bigint | number | string | null };

function projectInventoryItem(row: InventoryItemRow, viewerAccountId: string): StorageInventoryItemV1 {
    let location: StorageInventoryItemV1['location'];
    let viewerMayRemove: boolean | undefined;
    let viewerMayTrim: boolean | undefined;
    switch (row.kind) {
        case 'artifacts':
        case 'artifactOldVersions':
        case 'pluginArtifacts':
            location = { kind: 'artifact', artifactId: row.itemId };
            viewerMayTrim = row.kind !== 'pluginArtifacts' && row.artifactDeletedAt === artifactVisibleWhere.deletedAt
                && viewerMayTrimArtifactRevisions('owner', decodeArtifactKindV1(row.artifactStoredKind).kindHint);
            break;
        case 'discussionAttachments':
            location = { kind: 'discussion', discussionId: row.parentKey, messageId: row.parentItemId!, attachmentId: row.itemId };
            viewerMayRemove = viewerMayRemoveDiscussionAttachment(viewerAccountId, row.authorAccountId, row.discussionOwnerAccountId);
            break;
        case 'accountPets':
            location = { kind: 'accountPet', petId: row.itemId };
            break;
        case 'pluginCollections':
            location = { kind: 'pluginCollection', pluginId: row.parentKey, collectionId: row.itemId };
            break;
        case 'teamLogos':
            location = { kind: 'team', teamId: row.itemId };
            break;
        default:
            location = { kind: 'profile' };
            break;
    }
    const date = row.createdAt;
    const createdAt = date === null ? null : storedDateTimestamp(date);
    return { id: row.itemId, kind: row.kind, location, createdAt,
        ...(viewerMayRemove === undefined ? {} : { viewerMayRemove }),
        ...(viewerMayTrim === undefined ? {} : { viewerMayTrim }),
        storedSizeBytes: row.storedSizeBytes === null ? null : storageSize(row.storedSizeBytes) };
}

/** Only authenticated or already-admitted identities may reach this projection. */
export async function readStorageInventoryInTx(tx: Tx, accountId: string, selection?: InventorySelection): Promise<StorageInventoryV1> {
    const { sql, identifier: name, mysql } = storageSql();
    const ordinary = sql.raw(artifactOrdinarySqlPredicate(mysql));
    const discussionId = selection?.discussionId;
    const discussionRows = sql.sql`
        SELECT 'discussionAttachments' AS kind, att.${name("blobId")} AS ${name("itemId")},
            d.${name("id")} AS ${name("parentKey")}, m.${name("id")} AS ${name("parentItemId")},
            att.${name("storedSizeBytes")} AS ${name("storedSizeBytes")}, m.${name("createdAt")} AS ${name("createdAt")},
            m.${name("authorAccountId")} AS ${name("authorAccountId")},
            d.${name("ownerAccountId")} AS ${name("discussionOwnerAccountId")}, NULL AS ${name("artifactStoredKind")},
            NULL AS ${name("artifactDeletedAt")}
        FROM ${name("Discussion")} d JOIN ${name("DiscussionMessage")} m ON m.${name("discussionId")} = d.${name("id")}
        JOIN ${name("DiscussionAttachment")} att ON att.${name("messageId")} = m.${name("id")}
        WHERE ${discussionId ? sql.sql`d.${name("id")} = ${discussionId}`
            : sql.sql`d.${name("ownerAccountId")} = ${accountId}`} AND att.${name("removedByAccountId")} IS NULL`;
    const accountRows = sql.sql`
        WITH artifactUsage AS (
            SELECT ${name("artifactId")}, SUM(${name("contentBytes")}) AS total,
                SUM(CASE WHEN history = 1 THEN ${name("contentBytes")} ELSE 0 END) AS old
            FROM (${artifactByteRows(sql.sql`a.${name("accountId")} = ${accountId}`, true)}) content
            GROUP BY ${name("artifactId")}
        ), inventory AS (
            ${discussionRows}
            UNION ALL
            SELECT CASE WHEN ${ordinary} THEN 'artifacts' ELSE 'pluginArtifacts' END,
                a.${name("id")}, '', NULL, CASE WHEN ${ordinary} THEN t.total - t.old ELSE t.total END, a.${name("updatedAt")},
                NULL, NULL, a.${name("kind")}, a.${name("deletedAt")}
            FROM artifactUsage t JOIN ${name("Artifact")} a ON a.${name("id")} = t.${name("artifactId")}
            UNION ALL
            SELECT 'artifactOldVersions', a.${name("id")}, '', NULL, t.old, a.${name("updatedAt")},
                NULL, NULL, a.${name("kind")}, a.${name("deletedAt")}
            FROM artifactUsage t JOIN ${name("Artifact")} a ON a.${name("id")} = t.${name("artifactId")}
            WHERE t.old > 0 AND ${ordinary}
            UNION ALL
            SELECT 'accountPets', ${name("id")}, '', NULL, ${name("sizeBytes")}, ${name("createdAt")}, NULL, NULL, NULL, NULL
            FROM ${name("AccountPetPackage")} WHERE ${name("accountId")} = ${accountId} AND ${name("deletedAt")} IS NULL
            UNION ALL
            SELECT 'pluginCollections', ${name("collectionId")}, ${name("pluginId")}, NULL, ${name("encodedBytes")}, NULL, NULL, NULL, NULL, NULL
            FROM ${name("PluginCollectionUsage")} WHERE ${name("accountId")} = ${accountId}
            UNION ALL
            SELECT 'profilePictures', ${name("id")}, '', NULL, ${name("storedSizeBytes")}, ${name("createdAt")}, NULL, NULL, NULL, NULL
            FROM ${name("UploadedFile")} WHERE ${name("accountId")} = ${accountId}
            AND ${name("reuseKey")} IN (${sql.join([publicProfilePictureAppliedReuseKey,
                publicProfilePictureRejectedReuseKey, publicProfilePictureWritingReuseKey])})
            UNION ALL
            SELECT 'avatars', ${name("id")}, '', NULL, ${name("storedSizeBytes")}, ${name("createdAt")}, NULL, NULL, NULL, NULL
            FROM ${name("UploadedFile")} WHERE ${name("accountId")} = ${accountId}
            AND ${name("reuseKey")} LIKE ${uploadedPublicImageUrlReuseKeyPrefix + '%'}
            UNION ALL
            SELECT 'teamLogos', t.${name("id")}, '', NULL, t.${name("logoStoredSizeBytes")}, NULL, NULL, NULL, NULL, NULL
            FROM ${name("TeamMembership")} tm JOIN ${name("Team")} t ON t.${name("id")} = tm.${name("teamId")}
            WHERE tm.${name("accountId")} = ${accountId} AND tm.${name("status")} = 'active'
            AND tm.${name("role")} = 'owner' AND t.${name("logo")} IS NOT NULL
        )`;
    const inventory = discussionId ? sql.sql`WITH inventory AS (${discussionRows})` : accountRows;
    const rows = await tx.$queryRaw<Array<{ kind: StorageInventoryKindV1; measuredBytes: ByteCount; unknown: ByteCount }>>(sql.sql`
        ${inventory}
        SELECT kind, COALESCE(SUM(${name("storedSizeBytes")}), 0) AS ${name("measuredBytes")},
            COUNT(*) - COUNT(${name("storedSizeBytes")}) AS unknown
        FROM inventory GROUP BY kind`);
    const kinds: NonNullable<StorageInventoryV1['kinds']> = {};
    const byKind: StorageInventoryV1['byKind'] = {
        artifacts: 0, pluginArtifacts: 0, discussionAttachments: 0, accountPets: 0, pluginCollections: 0,
    };
    const unmeasuredKinds: StorageInventoryV1['unmeasuredKinds'] = [];
    let totalBytes = 0;
    const byRowKind = new Map(rows.map(row => [row.kind, row]));
    for (const kind of StorageInventoryKindV1Schema.options) {
        if (discussionId && kind !== 'discussionAttachments') continue;
        const row = byRowKind.get(kind);
        const bytes = storageSize(row?.measuredBytes ?? 0);
        const unknown = storageSize(row?.unknown ?? 0) > 0;
        kinds[kind] = { storedSizeBytes: unknown ? null : bytes };
        totalBytes += bytes;
        if (kind === 'artifactOldVersions') byKind.artifacts += bytes;
        else if (kind === 'profilePictures' || kind === 'avatars' || kind === 'teamLogos') {
            if (unknown) unmeasuredKinds.push(kind);
        } else byKind[kind] += bytes;
    }
    const summary = { totalBytes: storageSize(totalBytes), byKind,
        artifactLimitBytes: discussionId ? null : readArtifactStorageEnv(process.env).accountLimitBytes, unmeasuredKinds };
    if (!selection) return summary;

    let after: z.infer<typeof inventoryCursor> | undefined;
    if (selection.cursor) {
        try { after = inventoryCursor.parse(JSON.parse(Buffer.from(selection.cursor, 'base64url').toString('utf8'))); }
        catch { throw new InvalidStorageInventoryCursorError(); }
    }
    const size = sql.sql`COALESCE(${name("storedSizeBytes")}, -1)`;
    const position = sql.sql`kind, ${name("parentKey")}, ${name("itemId")}`;
    const kindFilter = selection.kinds?.length
        ? sql.sql`AND kind IN (${sql.join([...selection.kinds])})`
        : selection.kinds ? sql.sql`AND 1 = 0` : sql.empty;
    const seek = after ? sql.sql`AND (${size} < ${after[0]} OR (${size} = ${after[0]}
        AND (${position}) > (${after[1]}, ${after[2]}, ${after[3]})))` : sql.empty;
    const found = await tx.$queryRaw<InventoryItemRow[]>(sql.sql`
        ${inventory}
        SELECT * FROM inventory WHERE 1 = 1 ${kindFilter} ${seek}
        ORDER BY ${size} DESC, ${position} LIMIT ${inventoryPageSize + 1}`);
    const visible = found.slice(0, inventoryPageSize);
    const last = visible.at(-1);
    const nextCursor = found.length > inventoryPageSize && last
        ? Buffer.from(JSON.stringify([last.storedSizeBytes === null ? -1 : storageSize(last.storedSizeBytes),
            last.kind, last.parentKey, last.itemId])).toString('base64url') : undefined;
    return { ...summary, kinds, page: { items: visible.map(row => projectInventoryItem(row, accountId)),
        ...(nextCursor ? { nextCursor } : {}) } };
}

/** Same snapshot as the admitted page. Work is proportional to page rows and their stored versions. */
export async function readArtifactStoredSizesInTx(tx: Tx, admittedIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    if (admittedIds.length === 0) return new Map();
    const { sql, identifier: name } = storageSql();
    const rows = await tx.$queryRaw<Array<{ artifactId: string; storedSizeBytes: ByteCount }>>(sql.sql`
        SELECT ${name("artifactId")}, SUM(${name("contentBytes")}) AS ${name("storedSizeBytes")}
        FROM (${artifactByteRows(sql.sql`a.${name("id")} IN (${sql.join([...admittedIds])})`)}) content
        GROUP BY ${name("artifactId")}`);
    return new Map(rows.map(row => [row.artifactId, storageSize(row.storedSizeBytes)]));
}

/** Project retention before the write, so quota refusal leaves head, history and changes untouched. */
export async function checkArtifactStorageBudgetInTx(tx: Tx, input: Readonly<{
    approvalInputCustody?: ApprovalInputCustody;
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
    const revisionRetentionCount = retainedRevisionCount(config.revisionRetentionCount, input.approvalInputCustody);
    const headBytes = storageSize(input.nextHeaderBytes + input.nextBodyBytes + (input.nextProvenanceBytes ?? 0));
    const { sql, identifier, bytes } = storageSql();
    const rows = await tx.$queryRaw<Array<{ sizeBytes: bigint | number | string; blobId: string | null }>>(sql.sql`
        SELECT ${bytes("body")} + COALESCE(${bytes("provenance")}, 0) AS ${identifier("sizeBytes")}, ${identifier("blobId")} FROM ${identifier("ArtifactRevision")}
        WHERE ${identifier("artifactId")} = ${input.artifactId} ORDER BY ${identifier("bodyVersion")} DESC`);
    const currentRevisionBytes = storageSize(rows.reduce((sum, row) => sum + storageSize(row.sizeBytes), 0));
    const removedRevisionBytes = input.retainCurrentBody
        ? rows.slice(Math.max(0, revisionRetentionCount - 1)).reduce((sum, row) => sum + storageSize(row.sizeBytes), 0)
        : 0;
    const revisionBytesDelta = (input.retainCurrentBody && revisionRetentionCount > 0 ? (input.currentBodyBytes ?? 0) + (input.currentProvenanceBytes ?? 0) : 0)
        - removedRevisionBytes + (input.revisionBytesDelta ?? 0);
    const blobs = await tx.artifactBlob.findMany({ where: { artifactId: input.artifactId }, select: { id: true, storedSizeBytes: true } });
    const currentBlobBytes = storageSize(blobs.reduce((sum, blob) => sum + storageSize(blob.storedSizeBytes), 0));
    const retainedRows = input.retainCurrentBody ? rows.slice(0, Math.max(0, revisionRetentionCount - 1)) : rows;
    const retainedIds = new Set(retainedRows.flatMap(row => row.blobId ? [row.blobId] : []));
    if (input.retainCurrentBody && revisionRetentionCount > 0 && input.currentBlobId) retainedIds.add(input.currentBlobId);
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

/** A snapshot can avoid a doomed object write. Serialized mutation still decides admission. */
export async function checkArtifactBlobUploadBudgetInSnapshot(input: Readonly<{
    accountId: string;
    artifactId: string;
    plain: boolean;
    header?: Uint8Array;
    body: Uint8Array;
    provenance?: Uint8Array;
    candidateBlobBytes: number;
    update?: Readonly<{ expectedHeaderVersion?: number; expectedBodyVersion: number; approvalInputCustody?: ApprovalInputCustody }>;
}>): Promise<ArtifactQuotaExceeded | null> {
    const config = readArtifactStorageEnv(process.env);
    if (config.documentLimitBytes === null && config.accountLimitBytes === null) return null;

    const { accountId, artifactId, update } = input;
    const storedSize = (field: 'header' | 'body' | 'provenance', content: Uint8Array) =>
        (input.plain ? storePlainArtifactDbBytes({ accountId, artifactId, field, content }) : content)?.byteLength;
    const nextHeaderBytes = input.header && storedSize('header', input.header);
    const nextBodyBytes = storedSize('body', input.body);
    const nextProvenanceBytes = input.provenance ? storedSize('provenance', input.provenance) : 0;
    if ((input.header && nextHeaderBytes === undefined) || nextBodyBytes === undefined || nextProvenanceBytes === undefined) return null;

    return inReadSnapshot(async tx => {
        const next = { accountId, artifactId, nextBodyBytes, nextProvenanceBytes, nextBlobId: null,
            candidateBlobBytes: input.candidateBlobBytes };
        if (!update) {
            // The existing create path owns replay and ID conflicts.
            if (await tx.artifact.findUnique({ where: { id: artifactId }, select: { id: true } })) return null;
            return checkArtifactStorageBudgetInTx(tx, { ...next, nextHeaderBytes: nextHeaderBytes ?? 0 });
        }
        const current = await tx.artifact.findFirst({ where: { id: artifactId, accountId, ...artifactVisibleWhere }, select: {
            headerVersion: true, bodyVersion: true, header: true, body: true, provenance: true, currentBlobId: true,
        } });
        // A version mismatch goes through the incumbent replay/CAS path.
        if (!current || current.bodyVersion !== update.expectedBodyVersion
            || (update.expectedHeaderVersion !== undefined && current.headerVersion !== update.expectedHeaderVersion)) return null;
        return checkArtifactStorageBudgetInTx(tx, { ...next, approvalInputCustody: update.approvalInputCustody,
            nextHeaderBytes: nextHeaderBytes ?? current.header.byteLength,
            currentHeaderBytes: current.header.byteLength, currentBodyBytes: current.body.byteLength,
            currentProvenanceBytes: current.provenance?.byteLength ?? 0,
            currentBlobId: current.currentBlobId, retainCurrentBody: true });
    }, { transactionClass: 'artifact-blob-quota-snapshot' });
}

/** Successful body CAS writes retain the displaced stored bytes in the same transaction. */
export async function retainArtifactBodyRevisionInTx(tx: Tx, input: Readonly<{
    approvalInputCustody?: ApprovalInputCustody;
    artifactId: string;
    bodyVersion: number;
    body: Uint8Array;
    provenance?: Uint8Array | null;
    blobId?: string | null;
    createdAt: Date;
}>) {
    const { approvalInputCustody, ...revision } = input;
    const revisionRetentionCount = retainedRevisionCount(readArtifactStorageEnv(process.env).revisionRetentionCount, approvalInputCustody);
    if (revisionRetentionCount > 0) {
        await tx.artifactRevision.create({ data: { ...revision, body: Buffer.from(input.body), provenance: input.provenance ? Buffer.from(input.provenance) : null } });
    }
    const retained = await tx.artifactRevision.findMany({ where: { artifactId: input.artifactId },
        orderBy: { bodyVersion: "desc" }, take: revisionRetentionCount, select: { bodyVersion: true } });
    await tx.artifactRevision.deleteMany({ where: { artifactId: input.artifactId,
        bodyVersion: { notIn: retained.map(row => row.bodyVersion) } } });
}
