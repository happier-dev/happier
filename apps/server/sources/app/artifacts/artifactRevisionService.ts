import { inTx, type Tx } from "@/storage/inTx";
import { readArtifactStorageEnv } from "@/app/features/catalog/readFeatureEnv";
import { readArtifactForCallerInTx } from "./artifactAccessService";
import { openArtifactStoredContentBytes, openArtifactProvenanceBytes } from "./artifactStoredContent";
import { updateArtifactTx, type UpdateArtifactResult } from "./artifactWriteService";
import { cleanupArtifactOrphanBlobs } from './artifactBlobService';
import { ArtifactBodyEnvelopeV1Schema, ArtifactBodyEnvelopeV1StoredSchema, decodePlainArtifactStoredContent, sameStrictJsonValue } from '@happier-dev/protocol';
import * as privacyKit from 'privacy-kit';

/** Reads history under the same current access, mode and recipient envelope admission as the head. */
export async function listArtifactBodyRevisionsInTx(tx: Tx, input: Readonly<{
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
        projected.push({ bodyVersion: revision.bodyVersion, body, provenance, createdAt: revision.createdAt,
            sizeBytes: revision.body.byteLength + (revision.provenance?.byteLength ?? 0) });
    }
    return { ok: true as const, revisions: projected, retentionCount: readArtifactStorageEnv(process.env).revisionRetentionCount };
}

/** Restore the selected body with caller-prepared provenance, atomically advancing both head versions. */
export async function restoreArtifactBodyRevision(input: Readonly<{
    actorUserId: string;
    artifactId: string;
    bodyVersion: number;
    header: Uint8Array;
    body?: Uint8Array;
    provenance?: Uint8Array;
    provenanceDataEncryptionKey?: Uint8Array;
    expectedRevision: Readonly<{ headerVersion: number; bodyVersion: number }>;
}>): Promise<UpdateArtifactResult> {
    try {
        const result = await inTx<UpdateArtifactResult>(async tx => {
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
                expectedRevision: input.expectedRevision,
                provenance: input.provenance, provenanceDataEncryptionKey: input.provenanceDataEncryptionKey,
                header: { bytes: input.header, expectedVersion: input.expectedRevision.headerVersion },
                body: { bytes: input.body ?? bytes, expectedVersion: input.expectedRevision.bodyVersion }, restoredBlobId: revision.blobId });
        });
        if (result.ok) await cleanupArtifactOrphanBlobs(input.artifactId);
        return result;
    } catch {
        return { ok: false, error: "internal" };
    }
}
