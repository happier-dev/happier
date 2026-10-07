import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { ArtifactBlobReferenceV1Schema, ArtifactBlobStoredContentV1Schema,
    type ArtifactBlobReferenceV1, type ArtifactBlobStoredContentV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import type { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { HappyError } from '@/utils/errors/errors';

export function hashArtifactBinaryContent(bytes: Uint8Array): string {
    return bytesToHex(sha256(bytes));
}

export async function sealArtifactBinaryContent(bytes: Uint8Array, mode: 'plain' | 'e2ee', encryption: ArtifactEncryption | null): Promise<ArtifactBlobStoredContentV1> {
    if (mode === 'plain') return { t: 'plain', v: encodeBase64(bytes) };
    if (!encryption) throw new HappyError('Artifact encryption material is unavailable', false, { code: 'artifact_content_unavailable' });
    return { t: 'encrypted', c: await encryption.encryptBytes(bytes) };
}

/** One binary opening owner for ordinary reads and Account conversion. */
export async function openArtifactBinaryContent(input: Readonly<{
    reference: ArtifactBlobReferenceV1;
    content: ArtifactBlobStoredContentV1;
    mode: 'plain' | 'e2ee';
    encryption: ArtifactEncryption | null;
}>): Promise<Uint8Array> {
    const reference = ArtifactBlobReferenceV1Schema.parse(input.reference);
    const content = ArtifactBlobStoredContentV1Schema.parse(input.content);
    if ((input.mode === 'plain') !== (content.t === 'plain')) throw new HappyError('Artifact file does not match its owner Account mode', false,
        { code: 'artifact_account_mode_mismatch' });
    let bytes: Uint8Array;
    if (content.t === 'plain') bytes = decodeBase64(content.v);
    else {
        if (!input.encryption) throw new HappyError('Artifact encryption material is unavailable', false, { code: 'artifact_content_unavailable' });
        bytes = await input.encryption.decryptBytes(content.c);
    }
    if (bytes.length !== reference.sizeBytes || hashArtifactBinaryContent(bytes) !== reference.sha256) throw new HappyError('Artifact file integrity check failed', false,
        { code: 'artifact_content_unavailable' });
    return bytes;
}
