import { inReadSnapshot, inTx, type Tx } from "@/storage/inTx";
import { readArtifactStorageEnv } from "@/app/features/catalog/readFeatureEnv";
import { acquireArtifactPublicationLocksInTx, readArtifactForCallerInTx, readArtifactHeaderForCallerInTx, resolveArtifactAudienceInTx } from "./artifactAccessService";
import { readArtifactStorageUsageInTx, storageSize, storageSql, storedDateTimestamp } from "./artifactStorageService";
import { getArtifactKindPolicyV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { viewerMayTrimArtifactRevisions } from './artifactClassification';
import { captureReadSnapshot } from "@/storage/captureReadSnapshot";
import { openArtifactStoredContentBytes, openArtifactProvenanceBytes } from "./artifactStoredContent";
import { updateArtifactTx, type UpdateArtifactResult } from "./artifactWriteService";
import { cleanupArtifactOrphanBlobs, cleanupArtifactOrphanBlobsAfterCommit } from './artifactBlobService';
import { markAccountsChanged } from '@/app/changes/markAccountChanged';
import { ArtifactBodyEnvelopeV1Schema, ArtifactBodyEnvelopeV1StoredSchema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import * as privacyKit from 'privacy-kit';

/** Reads history under the same current access, mode and recipient envelope admission as the head. */
async function captureArtifactBodyRevisionsInTx(tx: Tx, input: Readonly<{
    actorAccountId: string;
    artifactId: string;
}>) {
    const read = await readArtifactForCallerInTx(tx, input);
    if (!read.ok) return read;
    const revisions = await tx.artifactRevision.findMany({ where: { artifactId: input.artifactId }, orderBy: { bodyVersion: "desc" } });
    const projected = [];
    for (const revision of revisions) {
        const body = openArtifactStoredContentBytes({ accountId: read.artifact.ownerAccountId, artifactId: input.artifactId,
            mode: read.artifact.encryptionMode, field: "body", dataEncryptionKey: read.artifact.dataEncryptionKey, content: revision.body });
        if (!body) return { ok: false as const, error: "artifact_content_unavailable" as const };
        const provenance = revision.provenance && (read.artifact.encryptionMode === 'plain' || read.artifact.provenanceDataEncryptionKey)
            ? openArtifactProvenanceBytes({ accountId: read.artifact.ownerAccountId, artifactId: input.artifactId,
                mode: read.artifact.encryptionMode, bodyVersion: revision.bodyVersion, dataEncryptionKey: read.artifact.dataEncryptionKey,
                provenanceDataEncryptionKey: read.artifact.provenanceDataEncryptionKey, content: revision.provenance }) : null;
        if (revision.provenance && (read.artifact.encryptionMode === 'plain' || read.artifact.provenanceDataEncryptionKey) && !provenance) return { ok: false as const, error: 'artifact_content_unavailable' as const };
        projected.push({ bodyVersion: revision.bodyVersion, body, provenance, createdAt: revision.createdAt });
    }
    return { ok: true as const, revisions: projected, retentionCount: readArtifactStorageEnv(process.env).revisionRetentionCount };
}

export async function listArtifactBodyRevisionsInTx(tx: Tx, input: Parameters<typeof captureArtifactBodyRevisionsInTx>[1]) {
    return captureArtifactBodyRevisionsInTx(tx, input);
}

export async function listArtifactBodyRevisions(input: Parameters<typeof listArtifactBodyRevisionsInTx>[1]): Promise<Awaited<ReturnType<typeof listArtifactBodyRevisionsInTx>>> {
    return await captureReadSnapshot<Awaited<ReturnType<typeof captureArtifactBodyRevisionsInTx>>>(
        tx => captureArtifactBodyRevisionsInTx(tx, input));
}

export async function listArtifactRevisionHeaders(input: Readonly<{ actorAccountId: string; artifactId: string }>) {
    return captureReadSnapshot(async tx => {
        const access = await readArtifactHeaderForCallerInTx(tx, input);
        if (!access.ok) return access;
        if (!getArtifactKindPolicyV1(access.artifact.kindHint).browserListed)
            return { ok: false as const, error: 'artifact_not_found' as const };
        const { sql, identifier: name, bytes } = storageSql();
        const rows = await tx.$queryRaw<Array<{ bodyVersion: number | bigint; createdAt: Date | bigint;
            sizeBytes: number | bigint | string }>>(sql.sql`
            SELECT r.${name('bodyVersion')}, r.${name('createdAt')},
                ${bytes('body', 'r')} + COALESCE(${bytes('provenance', 'r')}, 0)
                + COALESCE(b.${name('storedSizeBytes')}, 0) AS ${name('sizeBytes')}
            FROM ${name('ArtifactRevision')} r LEFT JOIN ${name('ArtifactBlob')} b
                ON b.${name('id')} = r.${name('blobId')} AND b.${name('artifactId')} = r.${name('artifactId')}
            WHERE r.${name('artifactId')} = ${input.artifactId}
            ORDER BY r.${name('bodyVersion')} DESC`);
        return { ok: true as const, revisions: rows.map(row => ({ bodyVersion: storageSize(row.bodyVersion),
            createdAt: storedDateTimestamp(row.createdAt), sizeBytes: storageSize(row.sizeBytes) })),
            retentionCount: readArtifactStorageEnv(process.env).revisionRetentionCount };
    });
}

export async function trimArtifactRevisions(input: Readonly<{ actorAccountId: string; artifactId: string }>) {
    const { artifactId, actorAccountId } = input;
    const trimmed = await inTx(async tx => {
        await acquireArtifactPublicationLocksInTx(tx, artifactId, [actorAccountId]);
        const access = await readArtifactHeaderForCallerInTx(tx, input);
        if (!access.ok || !viewerMayTrimArtifactRevisions(access.artifact.access, access.artifact.kindHint)) return null;
        const { sql, identifier: name, bytes } = storageSql();
        const [total] = await tx.$queryRaw<Array<{ freedBytes: number | bigint | string }>>(sql.sql`
            SELECT COALESCE(SUM(${bytes('body')} + COALESCE(${bytes('provenance')}, 0)), 0) AS ${name('freedBytes')}
            FROM ${name('ArtifactRevision')} WHERE ${name('artifactId')} = ${artifactId}`);
        const freedBytes = storageSize(total?.freedBytes ?? 0);
        const removed = await tx.artifactRevision.deleteMany({ where: { artifactId } });
        if (removed.count > 0) await markAccountsChanged(tx, { accountIds: await resolveArtifactAudienceInTx(tx, artifactId),
            kind: 'artifact', entityId: artifactId });
        return freedBytes;
    }, { transactionClass: 'artifact-restore' });
    if (trimmed === null) return null;
    const removedFiles = await cleanupArtifactOrphanBlobs(artifactId);
    return { artifactId, freedBytes: storageSize(trimmed + storageSize(removedFiles)),
        storageUsage: await inReadSnapshot(tx => readArtifactStorageUsageInTx(tx, actorAccountId)) };
}

/** Restore the selected body with caller-prepared provenance, atomically advancing both head versions. */
export async function restoreArtifactBodyRevision(input: Readonly<{
    actorUserId: string;
    artifactId: string;
    bodyVersion: number;
    header: Uint8Array;
    kind?: string;
    body?: Uint8Array;
    provenance?: Uint8Array;
    provenanceDataEncryptionKey?: Uint8Array;
    expectedRevision: Readonly<{ headerVersion: number; bodyVersion: number }>;
}>): Promise<UpdateArtifactResult> {
    try {
        const result = await inTx<UpdateArtifactResult>(async tx => {
            await acquireArtifactPublicationLocksInTx(tx, input.artifactId);
            const read = await readArtifactForCallerInTx(tx, { actorAccountId: input.actorUserId, artifactId: input.artifactId });
            if (!read.ok || read.artifact.access === "view") return { ok: false, error: "not-found" };
            const revision = await tx.artifactRevision.findUnique({ where: {
                artifactId_bodyVersion: { artifactId: input.artifactId, bodyVersion: input.bodyVersion },
            } });
            if (!revision) return { ok: false, error: "not-found" };
            const bytes = openArtifactStoredContentBytes({ accountId: read.artifact.ownerAccountId, artifactId: input.artifactId,
                mode: read.artifact.encryptionMode, field: "body", dataEncryptionKey: read.artifact.dataEncryptionKey, content: revision.body });
            if (!bytes) return { ok: false, error: "internal" };
            if (input.body !== undefined && read.artifact.encryptionMode === 'plain') {
                const selected = ArtifactBodyEnvelopeV1StoredSchema.safeParse(decodePlainArtifactStoredContent(privacyKit.encodeBase64(bytes)));
                const replacement = ArtifactBodyEnvelopeV1Schema.safeParse(decodePlainArtifactStoredContent(privacyKit.encodeBase64(Buffer.from(input.body))));
                // Provenance may change; the selected content and binary reference stay authoritative.
                if (!selected.success || !replacement.success || !sameStrictJsonValue(selected.data.body, replacement.data.body)) {
                    return { ok: false, error: 'invalid-params' };
                }
            }
            return await updateArtifactTx(tx, { actorUserId: input.actorUserId, artifactId: input.artifactId,
                kind: input.kind,
                expectedRevision: input.expectedRevision,
                provenance: input.provenance, provenanceDataEncryptionKey: input.provenanceDataEncryptionKey,
                header: { bytes: input.header, expectedVersion: input.expectedRevision.headerVersion },
                body: { bytes: input.body ?? bytes, expectedVersion: input.expectedRevision.bodyVersion }, restoredBlobId: revision.blobId });
        }, { transactionClass: "artifact-restore" });
        if (result.ok) await cleanupArtifactOrphanBlobsAfterCommit(input.artifactId);
        return result;
    } catch {
        return { ok: false, error: "internal" };
    }
}
