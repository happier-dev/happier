import type { UpdateContainer } from '@happier-dev/protocol/updates';

export type ArtifactPrivateEventMetadata = Readonly<{
    provenance?: Uint8Array | null;
    provenanceDataEncryptionKey?: Uint8Array | null;
}>;

export function buildNewArtifactUpdate(artifact: {
    id: string;
    seq: number;
    header: Uint8Array;
    headerVersion: number;
    body: Uint8Array;
    bodyVersion: number;
    dataEncryptionKey: Uint8Array;
    createdAt: Date;
    updatedAt: Date;
} & ArtifactPrivateEventMetadata, updateSeq: number, updateId: string): UpdateContainer & {
    body: Extract<UpdateContainer['body'], { t: 'new-artifact' }>;
} {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'new-artifact',
            artifactId: artifact.id,
            seq: artifact.seq,
            header: Buffer.from(artifact.header).toString('base64'),
            headerVersion: artifact.headerVersion,
            body: Buffer.from(artifact.body).toString('base64'),
            bodyVersion: artifact.bodyVersion,
            dataEncryptionKey: Buffer.from(artifact.dataEncryptionKey).toString('base64'),
            provenance: artifact.provenance == null ? null : Buffer.from(artifact.provenance).toString('base64'),
            provenanceDataEncryptionKey: artifact.provenanceDataEncryptionKey == null
                ? null : Buffer.from(artifact.provenanceDataEncryptionKey).toString('base64'),
            createdAt: artifact.createdAt.getTime(),
            updatedAt: artifact.updatedAt.getTime()
        },
        createdAt: Date.now()
    };
}

export function buildUpdateArtifactUpdate(artifactId: string, updateSeq: number, updateId: string,
    header?: { value: string; version: number }, body?: { value: string; version: number },
    privateMetadata?: ArtifactPrivateEventMetadata): UpdateContainer & {
    body: Extract<UpdateContainer['body'], { t: 'update-artifact' }>;
} {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'update-artifact',
            artifactId,
            header,
            body,
            ...(privateMetadata ? {
                provenance: privateMetadata.provenance == null ? null : Buffer.from(privateMetadata.provenance).toString('base64'),
                provenanceDataEncryptionKey: privateMetadata.provenanceDataEncryptionKey == null
                    ? null : Buffer.from(privateMetadata.provenanceDataEncryptionKey).toString('base64'),
            } : {}),
        },
        createdAt: Date.now()
    };
}
