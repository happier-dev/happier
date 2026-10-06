import { inTx, type Tx } from "@/storage/inTx";
import * as privacyKit from 'privacy-kit';
import { artifactConversionBlobKey, artifactConversionBlobCustody, type PreparedArtifactAccountEncryptionConversionBlob, type PreparedArtifactAccountEncryptionConversionBlobs } from './artifactEncryptionConversionBlobService';
import { db } from '@/storage/db';
import { deletePrivateFile } from '@/storage/blob/files';
import type { ArtifactBlobWriteV1 } from '@happier-dev/protocol';
import { prepareArtifactBlobWrite, admitArtifactBlobWriteInTx, completeArtifactBlobCandidateCustodyInTx, discardArtifactBlobCandidate, cleanupArtifactOrphanBlobs, cleanupRejectedArtifactBlobUploads, artifactBlobRejectedUploadReuseKey, type PreparedArtifactBlobWrite } from './artifactBlobService';
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import {
    deriveAccountEncryptionCurrentnessFromRow,
} from "@/app/encryption/accountContentKeyAdmission";
import type {
    AccountEncryptionMigrateArtifactsDirective,
} from "@happier-dev/protocol";
import { ArtifactRecipientKeyEnvelopesV1Schema, ArtifactBlobReferenceV1Schema, decodePlainArtifactStoredContent, parseEncryptedDataKeyEnvelopeV1 } from "@happier-dev/protocol";
import { buildPluginDomainAccountChangeEntityId } from "@happier-dev/protocol/changes";
import { checkArtifactStorageBudgetInTx, retainArtifactBodyRevisionInTx, type ArtifactQuotaExceeded } from "./artifactStorageService";
import {
    artifactDataKeyMatchesAccountMode,
    artifactProvenanceMatchesAccountMode,
    artifactStoredContentMatchesAccountMode,
    artifactUpdateMatchesStoredMode,
    isPlainArtifactDataKeyBytes,
    openArtifactStoredContentBytes,
    openArtifactProvenanceBytes,
    openArtifactStoredContentPair,
    storePlainArtifactDbBytes,
} from "./artifactStoredContent";
import {
    artifactClassificationFromRelations,
    artifactOrdinaryWhere,
    artifactVisibleWhere,
} from "./artifactClassification";
import {
    readArtifactForCallerInTx,
    resolveArtifactAccessInTx,
    resolveArtifactAudienceInTx,
    applyArtifactRecipientKeyEnvelopesInTx,
} from "./artifactAccessService";

type Cursor = number;

export class ArtifactAccountEncryptionMigrationConflictError extends Error {
    constructor() {
        super("Artifact account-encryption migration lost its version precondition");
        this.name = "ArtifactAccountEncryptionMigrationConflictError";
    }
}

export class ArtifactAccountEncryptionMigrationQuotaExceededError extends Error {
    constructor(readonly quota: ArtifactQuotaExceeded) {
        super("Artifact account-encryption migration exceeds its configured storage budget");
        this.name = "ArtifactAccountEncryptionMigrationQuotaExceededError";
    }
}

export type ArtifactAccountEncryptionMigrationResult =
    | Readonly<{ status: "applied" }>
    | Readonly<{ status: "not_empty" }>
    | Readonly<{ status: "migration_incomplete" }>
    | Readonly<{ status: "invalid_content" }>;

export type ArtifactAccountEncryptionMigrationPostStateResult =
    | Readonly<{ status: "matched" }>
    | Readonly<{ status: "mismatch" }>
    | Readonly<{ status: "migration_incomplete" }>;

export type ArtifactAccountEncryptionMigrationRow = Readonly<{
    id: string;
    header: Uint8Array;
    headerVersion: number;
    body: Uint8Array;
    bodyVersion: number;
    dataEncryptionKey: Uint8Array;
    seq: number;
    currentBlobId: string | null;
    provenance: Uint8Array | null;
    provenanceDataEncryptionKey: Uint8Array | null;
    revisions: readonly Readonly<{ bodyVersion: number; body: Uint8Array; blobId: string | null; provenance: Uint8Array | null }>[];
    blobs: readonly Readonly<{ id: string; storageKey: string; encryptionMode: string; storedSizeBytes: bigint }>[];
    pluginUiArtifact: Readonly<{
        release: Readonly<{
            accountId: string;
            pluginId: string;
            version: string;
        }>;
    }> | null;
    packageAssetRelease: Readonly<{
        accountId: string;
        pluginId: string;
        version: string;
    }> | null;
}>;

export async function readArtifactAccountEncryptionMigrationRowsInTx(
    tx: Tx,
    accountId: string,
    page?: Readonly<{ afterId?: string; take: number }>,
): Promise<readonly ArtifactAccountEncryptionMigrationRow[]> {
    return await tx.artifact.findMany({
        where: { accountId, ...(page?.afterId ? { id: { gt: page.afterId } } : {}) },
        ...(page ? { orderBy: { id: 'asc' as const }, take: page.take } : {}),
        select: {
            id: true,
            header: true,
            headerVersion: true,
            body: true,
            bodyVersion: true,
            dataEncryptionKey: true,
            seq: true,
            currentBlobId: true,
            provenance: true,
            provenanceDataEncryptionKey: true,
            revisions: { select: { bodyVersion: true, body: true, blobId: true, provenance: true } },
            blobs: { select: { id: true, storageKey: true, encryptionMode: true, storedSizeBytes: true } },
            pluginUiArtifact: {
                select: {
                    release: {
                        select: {
                            accountId: true,
                            pluginId: true,
                            version: true,
                        },
                    },
                },
            },
            packageAssetRelease: {
                select: {
                    accountId: true,
                    pluginId: true,
                    version: true,
                },
            },
        },
    });
}

function artifactBytesEqual(
    left: Uint8Array,
    right: Uint8Array,
): boolean {
    return left.byteLength === right.byteLength
        && left.every((value, index) => value === right[index]);
}

function nullableArtifactBytesEqual(left: Uint8Array | null | undefined, right: Uint8Array | null | undefined): boolean {
    return left == null || right == null ? left == null && right == null : artifactBytesEqual(left, right);
}

function privateDirectiveBytes(value: string | null | undefined): Uint8Array<ArrayBuffer> | null {
    return value == null ? null : new Uint8Array(privacyKit.decodeBase64(value));
}

/**
 * Read-only exact Artifact post-state matcher for Account-transition replay.
 */
export async function matchArtifactAccountEncryptionMigrationPostStateInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        toMode: "plain" | "e2ee";
        directive: AccountEncryptionMigrateArtifactsDirective;
        preparedBlobs?: PreparedArtifactAccountEncryptionConversionBlobs;
    }>,
): Promise<ArtifactAccountEncryptionMigrationPostStateResult> {
    const rows =
        await readArtifactAccountEncryptionMigrationRowsInTx(
            params.tx,
            params.accountId,
        );
    if (rows.some((row) => artifactClassificationFromRelations({
        pluginUiArtifact: row.pluginUiArtifact,
        packageAssetRelease: row.packageAssetRelease,
    }, params.accountId).kind === "invalid")) {
        // Classification links must remain one Account-local plugin owner.
        // Do not reinterpret corruption as an ordinary Artifact.
        return { status: "migration_incomplete" };
    }
    if (params.directive.action === "assert_empty") {
        return {
            status: rows.length === 0
                ? "matched"
                : "mismatch",
        };
    }
    const itemsById = new Map(
        params.directive.items.map((item) => [
            item.artifactId,
            item,
        ] as const),
    );
    if (
        itemsById.size !== params.directive.items.length
        || itemsById.size !== rows.length
    ) {
        return { status: "mismatch" };
    }
    for (const row of rows) {
        const item = itemsById.get(row.id);
        if (!item) return { status: "mismatch" };
        const retainedIds = new Set([row.currentBlobId, ...row.revisions.map(revision => revision.blobId)].filter((id): id is string => Boolean(id)));
        if (retainedIds.size !== item.blobs.length) return { status: 'mismatch' };
        for (const blob of item.blobs) {
            const actual = row.blobs.find(value => value.id === blob.blobId);
            const verified = params.preparedBlobs?.get(`${row.id}/${blob.blobId}`);
            if (!retainedIds.has(blob.blobId) || !actual || actual.encryptionMode !== params.toMode
                || actual.storageKey !== artifactConversionBlobKey(row.id, blob.blobId, blob.content.uploadId)
                || !verified || verified.target.row.storageKey !== actual.storageKey
                || verified.target.contentSha256 !== blob.content.contentSha256) return { status: 'mismatch' };
        }
        const revisionsByVersion = new Map(item.revisions.map(revision => [revision.bodyVersion, revision]));
        if (revisionsByVersion.size !== item.revisions.length || revisionsByVersion.size !== row.revisions.length) {
            return { status: "mismatch" };
        }
        for (const revision of row.revisions) {
            const expected = revisionsByVersion.get(revision.bodyVersion);
            const openedBody = openArtifactStoredContentBytes({ accountId: params.accountId, artifactId: row.id,
                mode: params.toMode, field: "body", dataEncryptionKey: row.dataEncryptionKey, content: revision.body });
            if (!expected || !openedBody || !artifactBytesEqual(openedBody, Buffer.from(expected.body, "base64"))) {
                return { status: "mismatch" };
            }
            const openedProvenance = revision.provenance ? openArtifactProvenanceBytes({ accountId: params.accountId,
                artifactId: row.id, bodyVersion: revision.bodyVersion, mode: params.toMode, dataEncryptionKey: row.dataEncryptionKey,
                provenanceDataEncryptionKey: row.provenanceDataEncryptionKey, content: revision.provenance }) : null;
            if ((revision.provenance && !openedProvenance) || !nullableArtifactBytesEqual(openedProvenance, privateDirectiveBytes(expected.provenance))) return { status: 'mismatch' };
        }
        const expectedHeader =
            new Uint8Array(Buffer.from(item.header, "base64"));
        const expectedBody =
            new Uint8Array(Buffer.from(item.body, "base64"));
        const expectedDataEncryptionKey =
            new Uint8Array(
                Buffer.from(item.dataEncryptionKey, "base64"),
            );
        const openedProvenance = row.provenance ? openArtifactProvenanceBytes({ accountId: params.accountId,
            artifactId: row.id, bodyVersion: row.bodyVersion, mode: params.toMode, dataEncryptionKey: row.dataEncryptionKey,
            provenanceDataEncryptionKey: row.provenanceDataEncryptionKey, content: row.provenance }) : null;
        if ((row.provenance && !openedProvenance)
            || !nullableArtifactBytesEqual(openedProvenance, privateDirectiveBytes(item.provenance))
            || !nullableArtifactBytesEqual(row.provenanceDataEncryptionKey, privateDirectiveBytes(item.provenanceDataEncryptionKey))) return { status: 'mismatch' };
        if (!artifactProvenanceMatchesAccountMode({ mode: params.toMode, artifactId: row.id, bodyVersion: row.bodyVersion,
            provenance: openedProvenance, provenanceDataEncryptionKey: row.provenanceDataEncryptionKey })) return { status: 'mismatch' };
        const opened = openArtifactStoredContentPair({
            accountId: params.accountId,
            artifactId: row.id,
            mode: params.toMode,
            dataEncryptionKey: row.dataEncryptionKey,
            header: row.header,
            body: row.body,
        });
        if (
            !opened
            || row.headerVersion
                !== item.expectedHeaderVersion + 1
            || row.bodyVersion
                !== item.expectedBodyVersion + 1
            || !artifactBytesEqual(
                opened.header,
                expectedHeader,
            )
            || !artifactBytesEqual(
                opened.body,
                expectedBody,
            )
            || !artifactBytesEqual(
                row.dataEncryptionKey,
                expectedDataEncryptionKey,
            )
            || !artifactStoredContentMatchesAccountMode({
                mode: params.toMode,
                header: opened.header,
                body: opened.body,
                dataEncryptionKey: row.dataEncryptionKey,
            })
        ) {
            return { status: "mismatch" };
        }
    }
    return { status: "matched" };
}

export async function migrateArtifactAccountEncryptionInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    fromMode: "plain" | "e2ee";
    toMode: "plain" | "e2ee";
    directive: AccountEncryptionMigrateArtifactsDirective;
    preparedBlobs?: PreparedArtifactAccountEncryptionConversionBlobs;
    markChanged?: (artifactId: string) => Promise<unknown>;
}>): Promise<ArtifactAccountEncryptionMigrationResult> {
    const rows =
        await readArtifactAccountEncryptionMigrationRowsInTx(
            params.tx,
            params.accountId,
        );
    if (rows.some((row) => artifactClassificationFromRelations({
        pluginUiArtifact: row.pluginUiArtifact,
        packageAssetRelease: row.packageAssetRelease,
    }, params.accountId).kind === "invalid")) {
        return { status: "migration_incomplete" };
    }
    if (params.directive.action === "assert_empty") {
        return rows.length === 0
            ? { status: "applied" }
            : { status: "not_empty" };
    }

    const itemsById = new Map(
        params.directive.items.map((item) => [item.artifactId, item]),
    );
    if (
        itemsById.size !== params.directive.items.length
        || itemsById.size !== rows.length
    ) {
        return { status: "migration_incomplete" };
    }

    const prepared = new Map<string, Readonly<{
        header: Uint8Array;
        body: Uint8Array;
        dataEncryptionKey: Uint8Array;
        seq: number;
        provenance: Uint8Array | null;
        provenanceDataEncryptionKey: Uint8Array | null;
        currentProvenanceBytes: number;
        currentHeaderBytes: number;
        currentBodyBytes: number;
        currentBlobId: string | null;
        blobs: readonly PreparedArtifactAccountEncryptionConversionBlob[];
        ordinary: boolean;
        revisions: readonly Readonly<{ bodyVersion: number; expectedStoredBody: Uint8Array; body: Uint8Array;
            expectedStoredProvenance: Uint8Array | null; provenance: Uint8Array | null }>[];
    }>>();
    for (const row of rows) {
        const item = itemsById.get(row.id);
        if (
            !item
            || item.expectedHeaderVersion !== row.headerVersion
            || item.expectedBodyVersion !== row.bodyVersion
            || !artifactBytesEqual(
                row.dataEncryptionKey, new Uint8Array(Buffer.from(item.expectedDataEncryptionKey, "base64")),
            )
        ) {
            return { status: "migration_incomplete" };
        }
        const sourceProvenance = row.provenance ? openArtifactProvenanceBytes({ accountId: params.accountId, artifactId: row.id,
            mode: params.fromMode, bodyVersion: row.bodyVersion, dataEncryptionKey: row.dataEncryptionKey,
            provenanceDataEncryptionKey: row.provenanceDataEncryptionKey, content: row.provenance }) : null;
        if ((row.provenance && !sourceProvenance)
            || !nullableArtifactBytesEqual(sourceProvenance, privateDirectiveBytes(item.expectedProvenance))
            || !nullableArtifactBytesEqual(row.provenanceDataEncryptionKey, privateDirectiveBytes(item.expectedProvenanceDataEncryptionKey))) return { status: 'migration_incomplete' };
        if (!artifactProvenanceMatchesAccountMode({ mode: params.fromMode, artifactId: row.id, bodyVersion: row.bodyVersion,
            provenance: sourceProvenance, provenanceDataEncryptionKey: row.provenanceDataEncryptionKey })) return { status: 'invalid_content' };
        const provenance = privateDirectiveBytes(item.provenance);
        const provenanceDataEncryptionKey = privateDirectiveBytes(item.provenanceDataEncryptionKey);
        if (Boolean(sourceProvenance) !== Boolean(provenance)
            || !artifactProvenanceMatchesAccountMode({ mode: params.toMode, artifactId: row.id,
                bodyVersion: row.bodyVersion + 1, provenance, provenanceDataEncryptionKey })) return { status: 'invalid_content' };
        const storedProvenance = provenance == null ? null : params.toMode === 'plain'
            ? storePlainArtifactDbBytes({ accountId: params.accountId, artifactId: row.id, field: 'provenance', content: provenance }) : provenance;
        if (provenance && !storedProvenance) return { status: 'invalid_content' };
        const retainedIds = new Set([row.currentBlobId, ...row.revisions.map(revision => revision.blobId)].filter((id): id is string => Boolean(id)));
        if (retainedIds.size !== item.blobs.length || new Set(item.blobs.map(blob => blob.blobId)).size !== item.blobs.length) {
            return { status: 'migration_incomplete' };
        }
        const blobs: PreparedArtifactAccountEncryptionConversionBlob[] = [];
        for (const blob of item.blobs) {
            const source = row.blobs.find(value => value.id === blob.blobId);
            const candidate = params.preparedBlobs?.get(`${row.id}/${blob.blobId}`);
            if (!retainedIds.has(blob.blobId) || !source || !candidate || source.encryptionMode !== params.fromMode
                || candidate.source.storageKey !== source.storageKey || candidate.source.encryptionMode !== source.encryptionMode
                || candidate.source.storedSizeBytes !== source.storedSizeBytes || candidate.expectedContentSha256 !== blob.expectedContentSha256
                || candidate.target.accountId !== params.accountId || candidate.target.row.id !== blob.blobId
                || !candidate.target.candidate || blob.content.t !== (params.toMode === 'plain' ? 'plain' : 'encrypted')
                || candidate.target.row.artifactId !== row.id || candidate.target.row.encryptionMode !== params.toMode
                || candidate.target.row.storageKey !== artifactConversionBlobKey(row.id, blob.blobId, blob.content.uploadId)
                || candidate.target.contentSha256 !== blob.content.contentSha256
                || !await params.tx.uploadedFile.findFirst({ where: { accountId: params.accountId, path: candidate.target.row.storageKey,
                    reuseKey: artifactConversionBlobCustody(candidate.target.row) } })) return { status: 'migration_incomplete' };
            blobs.push(candidate);
        }
        if (!artifactDataKeyMatchesAccountMode({ mode: params.fromMode, dataEncryptionKey: row.dataEncryptionKey })) {
            return { status: "invalid_content" };
        }
        if (!ArtifactRecipientKeyEnvelopesV1Schema.safeParse(item.recipientKeyEnvelopes).success
            || item.recipientKeyEnvelopes.some(envelope => !parseEncryptedDataKeyEnvelopeV1(new Uint8Array(Buffer.from(envelope.encryptedDataKey, "base64"))))
            || item.recipientKeyEnvelopes.some(envelope => envelope.encryptedProvenanceDataKey !== undefined
                && (!provenanceDataEncryptionKey || !parseEncryptedDataKeyEnvelopeV1(privacyKit.decodeBase64(envelope.encryptedProvenanceDataKey))))
            || (item.recipientKeyEnvelopes.length > 0 && params.toMode === "plain")) {
            return { status: "invalid_content" };
        }
        const header = new Uint8Array(Buffer.from(item.header, "base64"));
        const body = new Uint8Array(Buffer.from(item.body, "base64"));
        const dataEncryptionKey = new Uint8Array(
            Buffer.from(item.dataEncryptionKey, "base64"),
        );
        if (!artifactStoredContentMatchesAccountMode({
            mode: params.toMode,
            header,
            body,
            dataEncryptionKey,
        })) {
            return { status: "invalid_content" };
        }
        const storedHeader =
            params.toMode === "plain"
                ? storePlainArtifactDbBytes({
                    accountId: params.accountId,
                    artifactId: row.id,
                    field: "header",
                    content: header,
                })
                : header;
        const storedBody =
            params.toMode === "plain"
                ? storePlainArtifactDbBytes({
                    accountId: params.accountId,
                    artifactId: row.id,
                    field: "body",
                    content: body,
                })
                : body;
        if (!storedHeader || !storedBody) {
            return { status: "invalid_content" };
        }
        const plainBodyMatchesBlob = (body: Uint8Array, blobId: string | null | undefined) => {
            if (params.toMode !== 'plain') return true;
            const decoded = decodePlainArtifactStoredContent(Buffer.from(body).toString('base64'));
            const reference = ArtifactBlobReferenceV1Schema.safeParse(decoded && typeof decoded === 'object' && 'body' in decoded ? decoded.body : null);
            if (!blobId) return !reference.success;
            const blob = blobs.find(value => value.target.row.id === blobId);
            return reference.success && reference.data.blobId === blobId && Boolean(blob)
                && reference.data.sizeBytes === blob!.target.sizeBytes
                && reference.data.sha256 === blob!.target.contentSha256;
        };
        if (!plainBodyMatchesBlob(body, row.currentBlobId)) return { status: 'invalid_content' };
        const revisionsByVersion = new Map(item.revisions.map(revision => [revision.bodyVersion, revision]));
        if (revisionsByVersion.size !== item.revisions.length || revisionsByVersion.size !== row.revisions.length) {
            return { status: "migration_incomplete" };
        }
        const revisions = [];
        for (const revision of row.revisions) {
            const target = revisionsByVersion.get(revision.bodyVersion);
            const sourceBody = openArtifactStoredContentBytes({ accountId: params.accountId, artifactId: row.id,
                mode: params.fromMode,
                field: "body", dataEncryptionKey: row.dataEncryptionKey, content: revision.body });
            if (!target || !sourceBody || !artifactBytesEqual(sourceBody, Buffer.from(target.expectedBody, "base64"))) {
                return { status: "migration_incomplete" };
            }
            const body = Buffer.from(target.body, "base64");
            const sourceProvenance = revision.provenance ? openArtifactProvenanceBytes({ accountId: params.accountId,
                artifactId: row.id, bodyVersion: revision.bodyVersion, mode: params.fromMode, dataEncryptionKey: row.dataEncryptionKey,
                provenanceDataEncryptionKey: row.provenanceDataEncryptionKey, content: revision.provenance }) : null;
            if ((revision.provenance && !sourceProvenance)
                || !nullableArtifactBytesEqual(sourceProvenance, privateDirectiveBytes(target.expectedProvenance))) return { status: 'migration_incomplete' };
            const provenance = privateDirectiveBytes(target.provenance);
            if (Boolean(sourceProvenance) !== Boolean(provenance)
                || !artifactProvenanceMatchesAccountMode({ mode: params.toMode, artifactId: row.id,
                    bodyVersion: revision.bodyVersion, provenance, provenanceDataEncryptionKey })) return { status: 'invalid_content' };
            const storedProvenance = provenance == null ? null : params.toMode === 'plain'
                ? storePlainArtifactDbBytes({ accountId: params.accountId, artifactId: row.id, field: 'provenance', content: provenance }) : provenance;
            if (provenance && !storedProvenance) return { status: 'invalid_content' };
            if (!plainBodyMatchesBlob(body, revision.blobId)) return { status: 'invalid_content' };
            if (!artifactUpdateMatchesStoredMode({ dataEncryptionKey, body })) return { status: "invalid_content" };
            const stored = params.toMode === "plain" ? storePlainArtifactDbBytes({
                accountId: params.accountId, artifactId: row.id, field: "body", content: body,
            }) : body;
            if (!stored) return { status: "invalid_content" };
            revisions.push({ bodyVersion: revision.bodyVersion, expectedStoredBody: revision.body, body: stored,
                expectedStoredProvenance: revision.provenance, provenance: storedProvenance });
        }
        prepared.set(row.id, {
            header: storedHeader,
            body: storedBody,
            dataEncryptionKey,
            seq: row.seq,
            provenance: storedProvenance, provenanceDataEncryptionKey,
            currentProvenanceBytes: row.provenance?.byteLength ?? 0,
            currentHeaderBytes: row.header.byteLength,
            currentBodyBytes: row.body.byteLength,
            currentBlobId: row.currentBlobId,
            blobs,
            ordinary: artifactClassificationFromRelations({ pluginUiArtifact: row.pluginUiArtifact,
                packageAssetRelease: row.packageAssetRelease }, params.accountId).kind === "ordinary",
            revisions,
        });
    }

    const pluginIdByArtifactId = new Map(
        rows.flatMap((row) => {
            const classification = artifactClassificationFromRelations({
                pluginUiArtifact: row.pluginUiArtifact,
                packageAssetRelease: row.packageAssetRelease,
            }, params.accountId);
            return classification.kind === "plugin"
                ? [[row.id, classification.pluginId] as const]
                : [];
        }),
    );
    const markChanged =
        params.markChanged
        ?? (async (artifactId: string) => {
            const pluginId = pluginIdByArtifactId.get(artifactId);
            if (pluginId) {
                const hint = {
                    pluginDomain: "availability" as const,
                    pluginId,
                };
                return await markAccountChanged(params.tx, {
                    accountId: params.accountId,
                    kind: "pluginDomain",
                    entityId: buildPluginDomainAccountChangeEntityId(hint),
                    hint,
                });
            }
            return await markAccountChanged(params.tx, {
                accountId: params.accountId,
                kind: "artifact",
                entityId: artifactId,
            });
        });
    for (const item of params.directive.items) {
        const replacement = prepared.get(item.artifactId)!;
        if (replacement.ordinary) {
            const quota = await checkArtifactStorageBudgetInTx(params.tx, {
                accountId: params.accountId, artifactId: item.artifactId,
                nextHeaderBytes: replacement.header.byteLength, nextBodyBytes: replacement.body.byteLength,
                currentHeaderBytes: replacement.currentHeaderBytes, currentBodyBytes: replacement.currentBodyBytes,
                currentProvenanceBytes: replacement.currentProvenanceBytes, nextProvenanceBytes: replacement.provenance?.byteLength ?? 0,
                revisionBytesDelta: replacement.revisions.reduce((sum, revision) => sum + revision.body.byteLength - revision.expectedStoredBody.byteLength
                    + (revision.provenance?.byteLength ?? 0) - (revision.expectedStoredProvenance?.byteLength ?? 0), 0),
                currentBlobId: replacement.currentBlobId,
                blobBytesDelta: replacement.blobs.reduce((sum, blob) => sum + Number(blob.target.row.storedSizeBytes - blob.source.storedSizeBytes), 0),
            });
            if (quota) throw new ArtifactAccountEncryptionMigrationQuotaExceededError(quota);
        }
        const updated = await params.tx.artifact.updateMany({
            where: {
                accountId: params.accountId,
                id: item.artifactId,
                headerVersion: item.expectedHeaderVersion,
                bodyVersion: item.expectedBodyVersion,
                dataEncryptionKey: Buffer.from(item.expectedDataEncryptionKey, "base64"),
                provenanceDataEncryptionKey: privateDirectiveBytes(item.expectedProvenanceDataEncryptionKey),
            },
            data: {
                header: Buffer.from(replacement.header),
                headerVersion: item.expectedHeaderVersion + 1,
                body: Buffer.from(replacement.body),
                bodyVersion: item.expectedBodyVersion + 1,
                provenance: replacement.provenance ? Buffer.from(replacement.provenance) : null,
                provenanceDataEncryptionKey: replacement.provenanceDataEncryptionKey ? Buffer.from(replacement.provenanceDataEncryptionKey) : null,
                dataEncryptionKey: Buffer.from(
                    replacement.dataEncryptionKey,
                ),
                seq: replacement.seq + 1,
                updatedAt: new Date(),
            },
        });
        if (updated.count !== 1) {
            throw new ArtifactAccountEncryptionMigrationConflictError();
        }
        // Ordinary body writers acquire this same parent CAS before retaining
        // or pruning history. Recheck the whole set after acquiring that fence.
        if (await params.tx.artifactRevision.count({ where: { artifactId: item.artifactId } }) !== replacement.revisions.length) {
            throw new ArtifactAccountEncryptionMigrationConflictError();
        }
        for (const revision of replacement.revisions) {
            const migrated = await params.tx.artifactRevision.updateMany({
                where: { artifactId: item.artifactId, bodyVersion: revision.bodyVersion, body: Buffer.from(revision.expectedStoredBody),
                    provenance: revision.expectedStoredProvenance ? Buffer.from(revision.expectedStoredProvenance) : null },
                data: { body: Buffer.from(revision.body), provenance: revision.provenance ? Buffer.from(revision.provenance) : null },
            });
            if (migrated.count !== 1) throw new ArtifactAccountEncryptionMigrationConflictError();
        }
        for (const blob of replacement.blobs) {
            // The displaced physical file keeps durable retry custody in this same atomic commit.
            await params.tx.uploadedFile.upsert({ where: { accountId_path: { accountId: params.accountId, path: blob.source.storageKey } },
                create: { accountId: params.accountId, path: blob.source.storageKey, reuseKey: artifactBlobRejectedUploadReuseKey(item.artifactId) },
                update: { reuseKey: artifactBlobRejectedUploadReuseKey(item.artifactId) } });
            const migrated = await params.tx.artifactBlob.updateMany({ where: { id: blob.source.id, artifactId: item.artifactId,
                storageKey: blob.source.storageKey, encryptionMode: params.fromMode, storedSizeBytes: blob.source.storedSizeBytes },
                data: { storageKey: blob.target.row.storageKey, encryptionMode: params.toMode, storedSizeBytes: blob.target.row.storedSizeBytes } });
            if (migrated.count !== 1) throw new ArtifactAccountEncryptionMigrationConflictError();
            const consumed = await params.tx.uploadedFile.deleteMany({ where: { accountId: params.accountId, path: blob.target.row.storageKey,
                reuseKey: artifactConversionBlobCustody(blob.target.row) } });
            if (consumed.count !== 1) throw new ArtifactAccountEncryptionMigrationConflictError();
        }
        // A replacement resource key invalidates every previously wrapped key.
        await params.tx.artifactKeyEnvelope.deleteMany({ where: { artifactId: item.artifactId } });
        const notifiedRecipients = new Set<string>();
        if (params.toMode === "e2ee") {
            const committed = await applyArtifactRecipientKeyEnvelopesInTx(params.tx, {
                artifactId: item.artifactId, recipientKeyEnvelopes: item.recipientKeyEnvelopes,
            });
            for (const accountId of committed.appliedRecipientAccountIds) notifiedRecipients.add(accountId);
        }
        // Removed wraps are also a content change: live, unprepared recipients
        // must refresh into the truthful locked state (plain targets refresh too).
        for (const accountId of await resolveArtifactAudienceInTx(params.tx, item.artifactId)) {
            if (accountId === params.accountId || notifiedRecipients.has(accountId)) continue;
            await markAccountChanged(params.tx, { accountId, kind: "artifact", entityId: item.artifactId });
        }
        await markChanged(item.artifactId);
    }
    return { status: "applied" };
}

export type CreateArtifactResult =
    | ({ ok: false } & ArtifactQuotaExceeded)
    | { ok: true; didWrite: true; cursor: Cursor; artifact: ArtifactRow }
    | { ok: true; didWrite: false; artifact: ArtifactRow }
    | {
        ok: false;
        error:
            | "invalid-params"
            | "conflict"
            | "internal";
      };

type ArtifactRow = {
    id: string;
    seq: number;
    header: Uint8Array;
    headerVersion: number;
    body: Uint8Array;
    bodyVersion: number;
    dataEncryptionKey: Uint8Array;
    provenance: Uint8Array | null;
    provenanceDataEncryptionKey: Uint8Array | null;
    createdAt: Date;
    updatedAt: Date;
};

export async function createArtifact(params: {
    actorUserId: string;
    artifactId: string;
    header: Uint8Array;
    body: Uint8Array;
    dataEncryptionKey: Uint8Array;
    provenance?: Uint8Array;
    provenanceDataEncryptionKey?: Uint8Array;
    blob?: ArtifactBlobWriteV1;
}): Promise<CreateArtifactResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const artifactId = typeof params.artifactId === "string" ? params.artifactId : "";
    const header = params.header instanceof Uint8Array ? params.header : null;
    const body = params.body instanceof Uint8Array ? params.body : null;
    const dataEncryptionKey = params.dataEncryptionKey instanceof Uint8Array ? params.dataEncryptionKey : null;

    if (!actorUserId || !artifactId || !header || !body || !dataEncryptionKey) {
        return { ok: false, error: "invalid-params" };
    }

    let preparedBlob: PreparedArtifactBlobWrite | undefined;
    let admitted = false;
    try {
        if (params.blob) {
            if (!params.blob.content) return { ok: false, error: 'invalid-params' };
            await cleanupRejectedArtifactBlobUploads(actorUserId);
            preparedBlob = await prepareArtifactBlobWrite({ accountId: actorUserId, artifactId, blob: params.blob }) ?? undefined;
        }
        const result = await inTx(async (tx) => await createArtifactTx(tx, {
            actorUserId,
            artifactId,
            header,
            body,
            dataEncryptionKey,
            provenance: params.provenance,
            provenanceDataEncryptionKey: params.provenanceDataEncryptionKey,
            blob: params.blob, preparedBlob,
        }));
        admitted = result.ok && result.didWrite;
        return result;
    } catch {
        return { ok: false, error: "internal" };
    } finally {
        if (!admitted) await discardArtifactBlobCandidate(preparedBlob);
    }
}

export async function createArtifactTx(
    tx: Tx,
    params: {
        actorUserId: string;
        artifactId: string;
        header: Uint8Array;
        body: Uint8Array;
        dataEncryptionKey: Uint8Array;
        provenance?: Uint8Array;
        provenanceDataEncryptionKey?: Uint8Array;
        blob?: ArtifactBlobWriteV1;
        preparedBlob?: PreparedArtifactBlobWrite;
        /**
         * A qualified owner may replace the generic Artifact invalidation only
         * while composing its classification in this same transaction.
         */
        markChanged?: (artifactId: string) => Promise<Cursor>;
    }
): Promise<CreateArtifactResult> {
    const account = await tx.account.findUnique({
        where: { id: params.actorUserId },
        select: {
            encryptionMode: true,
            publicKey: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    const currentness = account
        ? deriveAccountEncryptionCurrentnessFromRow(account)
        : null;
    if (currentness?.status !== "ready") {
        return { ok: false, error: "invalid-params" };
    }
    const existing = await tx.artifact.findUnique({
        where: { id: params.artifactId },
        select: {
            id: true,
            accountId: true,
            header: true,
            headerVersion: true,
            body: true,
            bodyVersion: true,
            dataEncryptionKey: true,
            seq: true,
            createdAt: true,
            updatedAt: true,
            deletedAt: true,
            provenance: true,
            provenanceDataEncryptionKey: true,
            pluginUiArtifact: {
                select: {
                    release: {
                        select: {
                            accountId: true,
                            pluginId: true,
                        },
                    },
                },
            },
            packageAssetRelease: {
                select: {
                    accountId: true,
                    pluginId: true,
                },
            },
        },
    });

    if (existing) {
        if (
            existing.accountId !== params.actorUserId
            || existing.deletedAt
            || artifactClassificationFromRelations({
                pluginUiArtifact: existing.pluginUiArtifact,
                packageAssetRelease: existing.packageAssetRelease,
            }, params.actorUserId).kind !== "ordinary"
        ) {
            return { ok: false, error: "conflict" };
        }

        const opened = openArtifactStoredContentPair({
            accountId: existing.accountId,
            artifactId: existing.id,
            mode: currentness.currentness.encryptionMode,
            dataEncryptionKey: existing.dataEncryptionKey,
            header: existing.header,
            body: existing.body,
        });
        if (!opened) {
            return { ok: false, error: "internal" };
        }
        const openedProvenance = existing.provenance ? openArtifactProvenanceBytes({ accountId: existing.accountId,
            artifactId: existing.id, bodyVersion: existing.bodyVersion, mode: currentness.currentness.encryptionMode,
            dataEncryptionKey: existing.dataEncryptionKey, provenanceDataEncryptionKey: existing.provenanceDataEncryptionKey,
            content: existing.provenance }) : null;
        if (existing.provenance && !openedProvenance) return { ok: false, error: 'internal' };
        const {
            accountId: _accountId,
            pluginUiArtifact: _pluginUiArtifact,
            packageAssetRelease: _packageAssetRelease,
            deletedAt: _deletedAt,
            ...artifact
        } = existing;
        return {
            ok: true,
            didWrite: false,
            artifact: {
                ...artifact,
                header: opened.header,
                body: opened.body,
                provenance: openedProvenance,
            },
        };
    }

    if (
        !artifactStoredContentMatchesAccountMode({
        mode: currentness.currentness.encryptionMode,
        header: params.header,
        body: params.body,
        dataEncryptionKey: params.dataEncryptionKey,
    })
    ) {
        return { ok: false, error: "invalid-params" };
    }

    const plain = isPlainArtifactDataKeyBytes(params.dataEncryptionKey);
    if (params.provenanceDataEncryptionKey && !params.provenance) return { ok: false, error: 'invalid-params' };
    if (!artifactProvenanceMatchesAccountMode({ mode: currentness.currentness.encryptionMode,
        artifactId: params.artifactId, bodyVersion: 1, provenance: params.provenance,
        provenanceDataEncryptionKey: params.provenanceDataEncryptionKey })) return { ok: false, error: "invalid-params" };
    const storedProvenance = params.provenance == null ? null : plain
        ? storePlainArtifactDbBytes({ accountId: params.actorUserId, artifactId: params.artifactId, field: "provenance", content: params.provenance })
        : params.provenance;
    if (params.provenance && !storedProvenance) return { ok: false, error: "invalid-params" };
    const storedHeader = plain
        ? storePlainArtifactDbBytes({
            accountId: params.actorUserId,
            artifactId: params.artifactId,
            field: "header",
            content: params.header,
        })
        : params.header;
    const storedBody = plain
        ? storePlainArtifactDbBytes({
            accountId: params.actorUserId,
            artifactId: params.artifactId,
            field: "body",
            content: params.body,
        })
        : params.body;
    if (!storedHeader || !storedBody) {
        return { ok: false, error: "internal" };
    }

    if (params.markChanged && params.blob) return { ok: false, error: 'invalid-params' };
    if (!params.markChanged && !await admitArtifactBlobWriteInTx(tx, { artifactId: params.artifactId,
        mode: currentness.currentness.encryptionMode, body: params.body, blob: params.blob, prepared: params.preparedBlob })) {
        return { ok: false, error: 'invalid-params' };
    }

    // Qualified plugin publication is governed by its own availability budgets.
    if (!params.markChanged) {
        const quota = await checkArtifactStorageBudgetInTx(tx, { accountId: params.actorUserId,
            artifactId: params.artifactId, nextHeaderBytes: storedHeader.byteLength, nextBodyBytes: storedBody.byteLength,
            nextProvenanceBytes: storedProvenance?.byteLength ?? 0,
            nextBlobId: params.blob?.blobId ?? null, candidateBlobBytes: Number(params.preparedBlob?.row.storedSizeBytes ?? 0) });
        if (quota) return { ok: false, ...quota };
    }

    const created = await tx.artifact.create({
        data: {
            id: params.artifactId,
            accountId: params.actorUserId,
            header: Buffer.from(storedHeader),
            headerVersion: 1,
            body: Buffer.from(storedBody),
            bodyVersion: 1,
            currentBlobId: params.blob?.blobId ?? null,
            provenance: storedProvenance ? Buffer.from(storedProvenance) : null,
            provenanceDataEncryptionKey: params.provenanceDataEncryptionKey ? Buffer.from(params.provenanceDataEncryptionKey) : null,
            dataEncryptionKey: Buffer.from(params.dataEncryptionKey),
            seq: 0,
        },
        select: {
            id: true,
            header: true,
            headerVersion: true,
            body: true,
            bodyVersion: true,
            dataEncryptionKey: true,
            seq: true,
            createdAt: true,
            updatedAt: true,
            provenance: true,
            provenanceDataEncryptionKey: true,
        },
    });

    if (params.preparedBlob?.candidate) {
        await tx.artifactBlob.create({ data: params.preparedBlob.row });
        await completeArtifactBlobCandidateCustodyInTx(tx, params.preparedBlob);
    }

    const cursor = await (
        params.markChanged
        ?? (async (artifactId: string) =>
            await markAccountChanged(tx, {
                accountId: params.actorUserId,
                kind: "artifact",
                entityId: artifactId,
            }))
    )(params.artifactId);
    return {
        ok: true,
        didWrite: true,
        cursor,
        artifact: {
            ...created,
            header: params.header,
            body: params.body,
            provenance: params.provenance ? Buffer.from(params.provenance) : null,
        },
    };
}

export type UpdateArtifactResult =
    | ({ ok: false } & ArtifactQuotaExceeded)
    | {
        ok: true;
        cursor: Cursor;
        recipientUpdates: readonly Readonly<{
            accountId: string;
            cursor: Cursor;
            provenance: Uint8Array | null;
            provenanceDataEncryptionKey: Uint8Array | null;
        }>[];
        header?: { bytes: Uint8Array; version: number };
        body?: { bytes: Uint8Array; version: number };
      }
    | {
        ok: false;
        error:
            | "invalid-params"
            | "not-found"
            | "version-mismatch"
            | "artifact_binary_content_requires_explicit_update"
            | "internal";
        current?: {
            headerVersion: number;
            header: Uint8Array;
            bodyVersion: number;
            body: Uint8Array;
        };
      };

export async function updateArtifact(params: {
    actorUserId: string;
    artifactId: string;
    header?: { bytes: Uint8Array; expectedVersion: number };
    body?: { bytes: Uint8Array; expectedVersion: number };
    provenance?: Uint8Array;
    provenanceDataEncryptionKey?: Uint8Array;
    blob?: ArtifactBlobWriteV1 | null;
}): Promise<UpdateArtifactResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const artifactId = typeof params.artifactId === "string" ? params.artifactId : "";
    const header = params.header;
    const body = params.body;

    if (!actorUserId || !artifactId) {
        return { ok: false, error: "invalid-params" };
    }
    if (!header && !body) {
        return { ok: false, error: "invalid-params" };
    }
    if (params.blob !== undefined && !body) return { ok: false, error: "invalid-params" };
    if ((params.provenance !== undefined || params.provenanceDataEncryptionKey !== undefined) && !body) return { ok: false, error: "invalid-params" };
    if (header && (!(header.bytes instanceof Uint8Array) || typeof header.expectedVersion !== "number")) {
        return { ok: false, error: "invalid-params" };
    }
    if (body && (!(body.bytes instanceof Uint8Array) || typeof body.expectedVersion !== "number")) {
        return { ok: false, error: "invalid-params" };
    }

    let preparedBlob: PreparedArtifactBlobWrite | undefined;
    let admitted = false;
    try {
        const access = await inTx(tx => resolveArtifactAccessInTx(tx, { actorAccountId: actorUserId, artifactId }));
        if (!access || access.level === 'view') return { ok: false, error: 'not-found' };
        await cleanupArtifactOrphanBlobs(artifactId);
        if (params.blob) {
            if (!body) return { ok: false, error: 'invalid-params' };
            const owner = await db.artifact.findUnique({ where: { id: artifactId }, select: { accountId: true } });
            if (!owner) return { ok: false, error: 'not-found' };
            await cleanupRejectedArtifactBlobUploads(owner.accountId);
            preparedBlob = await prepareArtifactBlobWrite({ accountId: owner.accountId, artifactId, blob: params.blob }) ?? undefined;
        }
        const result = await inTx(async (tx) => await updateArtifactTx(tx, {
            actorUserId,
            artifactId,
            header,
            body,
            provenance: params.provenance,
            provenanceDataEncryptionKey: params.provenanceDataEncryptionKey,
            blob: params.blob, preparedBlob,
        }));
        admitted = result.ok;
        if (result.ok) await cleanupArtifactOrphanBlobs(artifactId);
        return result;
    } catch {
        return { ok: false, error: "internal" };
    } finally {
        if (!admitted) await discardArtifactBlobCandidate(preparedBlob);
    }
}

export async function updateArtifactTx(
    tx: Tx,
    params: {
        actorUserId: string;
        artifactId: string;
        header?: { bytes: Uint8Array; expectedVersion: number };
        body?: { bytes: Uint8Array; expectedVersion: number };
        provenance?: Uint8Array;
        provenanceDataEncryptionKey?: Uint8Array;
        expectedRevision?: Readonly<{ headerVersion: number; bodyVersion: number }>;
        blob?: ArtifactBlobWriteV1 | null;
        preparedBlob?: PreparedArtifactBlobWrite;
        restoredBlobId?: string | null;
    },
): Promise<UpdateArtifactResult> {
    const access = await resolveArtifactAccessInTx(tx, {
        actorAccountId: params.actorUserId,
        artifactId: params.artifactId,
    });
    if (!access || access.level === "view") return { ok: false, error: "not-found" };
    if (access.ownerAccountId !== params.actorUserId) {
        const readable = await readArtifactForCallerInTx(tx, {
            actorAccountId: params.actorUserId,
            artifactId: params.artifactId,
        });
        if (!readable.ok) return { ok: false, error: "not-found" };
    }
    const ownerAccountId = access.ownerAccountId;
    const account = await tx.account.findUnique({
        where: { id: ownerAccountId },
        select: {
            encryptionMode: true,
            publicKey: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    const currentness = account
        ? deriveAccountEncryptionCurrentnessFromRow(account)
        : null;
    if (currentness?.status !== "ready") {
        return { ok: false, error: "invalid-params" };
    }
    const current = await tx.artifact.findFirst({
        where: {
            id: params.artifactId,
            accountId: ownerAccountId,
            ...artifactVisibleWhere,
        },
        select: {
            id: true,
            seq: true,
            header: true,
            headerVersion: true,
            body: true,
            bodyVersion: true,
            dataEncryptionKey: true,
            currentBlobId: true,
            provenance: true,
            provenanceDataEncryptionKey: true,
        },
    });

    if (!current) {
        return { ok: false, error: "not-found" };
    }
    if ((params.provenance !== undefined || params.provenanceDataEncryptionKey !== undefined) && !params.body) return { ok: false, error: "invalid-params" };

    if (!artifactUpdateMatchesStoredMode({
        dataEncryptionKey: current.dataEncryptionKey,
        ...(params.header ? { header: params.header.bytes } : {}),
        ...(params.body ? { body: params.body.bytes } : {}),
    })) {
        return { ok: false, error: "invalid-params" };
    }
    const openedCurrent = openArtifactStoredContentPair({
        accountId: ownerAccountId,
        artifactId: current.id,
        mode: currentness.currentness.encryptionMode,
        dataEncryptionKey: current.dataEncryptionKey,
        header: current.header,
        body: current.body,
    });
    if (!openedCurrent) {
        return { ok: false, error: "internal" };
    }

    const headerMismatch = (params.header && current.headerVersion !== params.header.expectedVersion)
        || (params.expectedRevision && current.headerVersion !== params.expectedRevision.headerVersion);
    const bodyMismatch = (params.body && current.bodyVersion !== params.body.expectedVersion)
        || (params.expectedRevision && current.bodyVersion !== params.expectedRevision.bodyVersion);
    if (headerMismatch || bodyMismatch) {
        return {
            ok: false,
            error: "version-mismatch",
            current: {
                headerVersion: current.headerVersion,
                header: openedCurrent.header,
                bodyVersion: current.bodyVersion,
                body: openedCurrent.body,
            },
        };
    }

    // Opaque older-client body writes cannot prove whether the file is retained
    // or intentionally replaced. Binary-aware writers declare the replacement.
    if (params.body && current.currentBlobId && params.blob === undefined && params.restoredBlobId === undefined) {
        return { ok: false, error: "artifact_binary_content_requires_explicit_update" };
    }
    const provenanceDataEncryptionKey = params.provenanceDataEncryptionKey ?? current.provenanceDataEncryptionKey;
    if (params.provenanceDataEncryptionKey && !params.provenance) return { ok: false, error: 'invalid-params' };
    if (params.provenanceDataEncryptionKey && current.provenanceDataEncryptionKey
        && !artifactBytesEqual(params.provenanceDataEncryptionKey, current.provenanceDataEncryptionKey)) return { ok: false, error: "invalid-params" };
    if (!artifactProvenanceMatchesAccountMode({ mode: currentness.currentness.encryptionMode,
        artifactId: current.id, bodyVersion: params.body ? params.body.expectedVersion + 1 : current.bodyVersion,
        provenance: params.body ? params.provenance : null, provenanceDataEncryptionKey })) return { ok: false, error: "invalid-params" };

    const updateData: {
        updatedAt: Date;
        seq: number;
        header?: Uint8Array<ArrayBuffer>;
        headerVersion?: number;
        body?: Uint8Array<ArrayBuffer>;
        bodyVersion?: number;
        currentBlobId?: string | null;
        provenance?: Uint8Array<ArrayBuffer> | null;
        provenanceDataEncryptionKey?: Uint8Array<ArrayBuffer>;
    } = {
        updatedAt: new Date(),
        seq: current.seq + 1,
    };

    let headerUpdate: { bytes: Uint8Array; version: number } | undefined;
    let bodyUpdate: { bytes: Uint8Array; version: number } | undefined;

    if (params.header) {
        const storedHeader = isPlainArtifactDataKeyBytes(current.dataEncryptionKey)
            ? storePlainArtifactDbBytes({
                accountId: ownerAccountId,
                artifactId: current.id,
                field: "header",
                content: params.header.bytes,
            })
            : params.header.bytes;
        if (!storedHeader) return { ok: false, error: "internal" };
        updateData.header = Buffer.from(storedHeader);
        updateData.headerVersion = params.header.expectedVersion + 1;
        headerUpdate = { bytes: params.header.bytes, version: params.header.expectedVersion + 1 };
    }
    if (params.body) {
        const storedProvenance = params.provenance == null ? null : currentness.currentness.encryptionMode === "plain"
            ? storePlainArtifactDbBytes({ accountId: ownerAccountId, artifactId: current.id, field: "provenance", content: params.provenance })
            : params.provenance;
        if (params.provenance && !storedProvenance) return { ok: false, error: "invalid-params" };
        updateData.provenance = storedProvenance ? Buffer.from(storedProvenance) : null;
        if (params.provenanceDataEncryptionKey) updateData.provenanceDataEncryptionKey = Buffer.from(params.provenanceDataEncryptionKey);
        if (params.restoredBlobId === undefined && !await admitArtifactBlobWriteInTx(tx, {
            artifactId: current.id, mode: currentness.currentness.encryptionMode, body: params.body.bytes,
            blob: params.blob ?? undefined, prepared: params.preparedBlob, currentBlobId: current.currentBlobId,
        })) return { ok: false, error: 'invalid-params' };
        if (params.restoredBlobId && !await tx.artifactBlob.findFirst({ where: { id: params.restoredBlobId,
            artifactId: current.id, encryptionMode: currentness.currentness.encryptionMode } })) return { ok: false, error: 'invalid-params' };
        const storedBody = isPlainArtifactDataKeyBytes(current.dataEncryptionKey)
            ? storePlainArtifactDbBytes({
                accountId: ownerAccountId,
                artifactId: current.id,
                field: "body",
                content: params.body.bytes,
            })
            : params.body.bytes;
        if (!storedBody) return { ok: false, error: "internal" };
        updateData.body = Buffer.from(storedBody);
        updateData.bodyVersion = params.body.expectedVersion + 1;
        updateData.currentBlobId = params.restoredBlobId ?? params.blob?.blobId ?? null;
        bodyUpdate = { bytes: params.body.bytes, version: params.body.expectedVersion + 1 };
    }

    const quota = await checkArtifactStorageBudgetInTx(tx, { accountId: ownerAccountId, artifactId: current.id,
        nextHeaderBytes: (updateData.header ?? current.header).byteLength,
        nextBodyBytes: (updateData.body ?? current.body).byteLength,
        currentHeaderBytes: current.header.byteLength, currentBodyBytes: current.body.byteLength, retainCurrentBody: Boolean(params.body),
        currentProvenanceBytes: current.provenance?.byteLength ?? 0,
        nextProvenanceBytes: (params.body ? updateData.provenance : current.provenance)?.byteLength ?? 0,
        currentBlobId: current.currentBlobId, nextBlobId: params.body ? updateData.currentBlobId : current.currentBlobId,
        candidateBlobBytes: params.preparedBlob?.candidate ? Number(params.preparedBlob.row.storedSizeBytes) : 0 });
    if (quota) return { ok: false, ...quota };

    const { count } = await tx.artifact.updateMany({
        where: {
            id: params.artifactId,
            accountId: ownerAccountId,
            ...(params.header && { headerVersion: params.header.expectedVersion }),
            ...(params.body && { bodyVersion: params.body.expectedVersion }),
            ...(params.expectedRevision && { headerVersion: params.expectedRevision.headerVersion, bodyVersion: params.expectedRevision.bodyVersion }),
            ...(params.provenanceDataEncryptionKey && { provenanceDataEncryptionKey: current.provenanceDataEncryptionKey }),
            ...artifactVisibleWhere,
        },
        data: updateData,
    });

    if (count === 0) {
        const fresh = await tx.artifact.findFirst({
            where: {
                id: params.artifactId,
                accountId: ownerAccountId,
                ...artifactOrdinaryWhere,
            },
            select: {
                id: true,
                header: true,
                headerVersion: true,
                body: true,
                bodyVersion: true,
                dataEncryptionKey: true,
            },
        });
        if (!fresh) {
            return { ok: false, error: "not-found" };
        }

        const openedFresh = openArtifactStoredContentPair({
            accountId: ownerAccountId,
            artifactId: fresh.id,
            mode: currentness.currentness.encryptionMode,
            dataEncryptionKey: fresh.dataEncryptionKey,
            header: fresh.header,
            body: fresh.body,
        });
        if (!openedFresh) {
            return { ok: false, error: "internal" };
        }
        return {
            ok: false,
            error: "version-mismatch",
            current: {
                headerVersion: fresh.headerVersion,
                header: openedFresh.header,
                bodyVersion: fresh.bodyVersion,
                body: openedFresh.body,
            },
        };
    }

    if (params.preparedBlob?.candidate) {
        await tx.artifactBlob.create({ data: params.preparedBlob.row });
        await completeArtifactBlobCandidateCustodyInTx(tx, params.preparedBlob);
    }
    if (params.body) await retainArtifactBodyRevisionInTx(tx, {
        artifactId: current.id, bodyVersion: current.bodyVersion, body: current.body, blobId: current.currentBlobId,
        provenance: current.provenance,
    });

    const recipients = await resolveArtifactAudienceInTx(tx, params.artifactId);
    const recipientCursors = [];
    const recipientUpdates = [];
    for (const accountId of recipients) {
        const cursor = await markAccountChanged(tx, { accountId, kind: "artifact", entityId: params.artifactId });
        recipientCursors.push({ accountId, cursor });
        // The access owner projects current recipient custody, never the writer's wrap.
        const read = await readArtifactForCallerInTx(tx, { actorAccountId: accountId, artifactId: params.artifactId });
        if (read.ok) {
            recipientUpdates.push({ accountId, cursor, provenance: read.artifact.provenance,
                provenanceDataEncryptionKey: read.artifact.provenanceDataEncryptionKey });
        } else if (accountId === ownerAccountId) {
            throw new Error("Artifact owner cannot read its committed update");
        }
    }
    const cursor = recipientCursors.find((recipient) => recipient.accountId === params.actorUserId)?.cursor;
    if (cursor === undefined) throw new Error("Artifact writer is missing from its authorized audience");
    const ownerCursor = recipientCursors.find((recipient) => recipient.accountId === ownerAccountId)?.cursor;
    if (ownerCursor === undefined) throw new Error("Artifact owner is missing from its authorized audience");
    return { ok: true, cursor, recipientUpdates,
        ...(headerUpdate ? { header: headerUpdate } : {}), ...(bodyUpdate ? { body: bodyUpdate } : {}) };
}

class ArtifactDeleteVersionConflictError extends Error {}

export type DeleteArtifactResult =
    | { ok: true; cursor: Cursor }
    | {
        ok: false;
        error:
            | "invalid-params"
            | "not-found"
            | "version-mismatch"
            | "internal";
      };

export async function deleteArtifact(params: {
    actorUserId: string;
    artifactId: string;
    expectedRevision?: Readonly<{ headerVersion: number; bodyVersion: number }>;
}): Promise<DeleteArtifactResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const artifactId = typeof params.artifactId === "string" ? params.artifactId : "";

    if (!actorUserId || !artifactId) {
        return { ok: false, error: "invalid-params" };
    }

    try {
        const retirement = await inTx(async (tx) => {
            const artifact = await tx.artifact.findFirst({
                where: {
                    id: artifactId,
                    accountId: actorUserId,
                    ...artifactOrdinaryWhere,
                },
                select: {
                    id: true,
                    dataEncryptionKey: true,
                    deletedAt: true,
                    headerVersion: true,
                    bodyVersion: true,
                    blobs: { select: { id: true, storageKey: true }, orderBy: { id: 'asc' } },
                },
            });
            if (!artifact) {
                return { ok: false, error: "not-found" } as const;
            }
            const account = await tx.account.findUnique({
                where: { id: actorUserId },
                select: {
                    encryptionMode: true,
                    publicKey: true,
                    contentPublicKey: true,
                    contentPublicKeySig: true,
                },
            });
            const currentness = account
                ? deriveAccountEncryptionCurrentnessFromRow(account)
                : null;
            if (
                currentness?.status !== "ready"
                || !artifactDataKeyMatchesAccountMode({
                    mode: currentness.currentness.encryptionMode,
                    dataEncryptionKey: artifact.dataEncryptionKey,
                })
            ) {
                return { ok: false, error: "internal" } as const;
            }

            if (params.expectedRevision && (artifact.headerVersion !== params.expectedRevision.headerVersion
                || artifact.bodyVersion !== params.expectedRevision.bodyVersion)) {
                return { ok: false as const, error: 'version-mismatch' as const };
            }
            const audience = artifact.deletedAt ? [actorUserId] : await resolveArtifactAudienceInTx(tx, artifactId);
            let cursor: Cursor | undefined;
            // Write changes while the FK target still exists; deletion nulls the
            // projection link, retaining the entity id for a removal refresh.
            for (const accountId of audience) {
                const recipientCursor = await markAccountChanged(tx, { accountId, kind: "artifact", entityId: artifactId });
                if (accountId === actorUserId) cursor = recipientCursor;
            }
            if (cursor === undefined) throw new Error("Artifact owner is missing from its authorized audience");
            const deletedAt = artifact.deletedAt ?? new Date();
            if (!artifact.deletedAt) {
                const retired = await tx.artifact.updateMany({ where: {
                    id: artifactId, accountId: actorUserId, deletedAt: null, ...artifactOrdinaryWhere,
                    headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion,
                }, data: { deletedAt } });
                if (retired.count !== 1) throw new ArtifactDeleteVersionConflictError();
            }
            return { ok: true as const, cursor, deletedAt, artifact };
        });
        if (!retirement.ok) return retirement;
        // Retired rows keep exact custody until every idempotent physical delete succeeds.
        for (const blob of retirement.artifact.blobs) {
            await deletePrivateFile(blob.storageKey);
            await inTx(async tx => {
                const current = await tx.artifact.findFirst({ where: {
                    id: artifactId, accountId: actorUserId, deletedAt: retirement.deletedAt,
                    headerVersion: retirement.artifact.headerVersion, bodyVersion: retirement.artifact.bodyVersion,
                }, select: { id: true } });
                if (!current) throw new Error('Artifact retirement changed during private cleanup');
                await tx.artifactBlob.deleteMany({ where: { id: blob.id, artifactId, storageKey: blob.storageKey } });
            });
        }
        return await inTx(async tx => {
            const current = await tx.artifact.findFirst({ where: {
                id: artifactId, accountId: actorUserId, deletedAt: retirement.deletedAt, ...artifactOrdinaryWhere,
                headerVersion: retirement.artifact.headerVersion, bodyVersion: retirement.artifact.bodyVersion,
            }, select: { blobs: { select: { id: true, storageKey: true }, orderBy: { id: 'asc' } } } });
            if (!current || current.blobs.length !== 0) {
                return { ok: false as const, error: 'internal' as const };
            }
            const removed = await tx.artifact.deleteMany({ where: {
                id: artifactId, accountId: actorUserId, deletedAt: retirement.deletedAt,
                headerVersion: retirement.artifact.headerVersion, bodyVersion: retirement.artifact.bodyVersion,
            } });
            return removed.count === 1 ? { ok: true as const, cursor: retirement.cursor }
                : { ok: false as const, error: 'internal' as const };
        });
    } catch (error) {
        if (error instanceof ArtifactDeleteVersionConflictError) return { ok: false, error: "version-mismatch" };
        return { ok: false, error: "internal" };
    }
}
