import * as privacyKit from 'privacy-kit';
import type { ArtifactForCaller } from './artifactAccessService';

/** Reads and create acknowledgements project the same caller-authorized bytes and exposure facts. */
export function projectArtifactHttpRead(artifact: ArtifactForCaller & { publicAudience: 'retained' | 'none' }) {
    return {
        ...(artifact.ownerDisplayName === undefined ? {} : { ownerDisplayName: artifact.ownerDisplayName }),
        id: artifact.id, kind: artifact.kind, ...(artifact.kindHint === undefined ? {} : { kindHint: artifact.kindHint }), ownerAccountId: artifact.ownerAccountId, access: artifact.access, encryptionMode: artifact.encryptionMode,
        header: privacyKit.encodeBase64(artifact.header), headerVersion: artifact.headerVersion,
        body: privacyKit.encodeBase64(artifact.body), bodyVersion: artifact.bodyVersion, publicAudience: artifact.publicAudience,
        ...(artifact.sharedTeamIds === undefined ? {} : { sharedTeamIds: [...artifact.sharedTeamIds] }),
        provenance: artifact.provenance ? privacyKit.encodeBase64(artifact.provenance) : null,
        provenanceDataEncryptionKey: artifact.provenanceDataEncryptionKey ? privacyKit.encodeBase64(artifact.provenanceDataEncryptionKey) : null,
        dataEncryptionKey: privacyKit.encodeBase64(artifact.dataEncryptionKey), seq: artifact.seq,
        createdAt: artifact.createdAt.getTime(), updatedAt: artifact.updatedAt.getTime(),
    };
}
