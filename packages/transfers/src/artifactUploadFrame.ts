import { ArtifactBlobStoredContentV1Schema, ArtifactBlobUploadInitV1Schema, decodeBase64,
    type ArtifactBlobStoredContentV1, type ArtifactBlobUploadInitV1 } from '@happier-dev/protocol';

export const ARTIFACT_UPLOAD_CONTENT_TYPE_V1 = 'application/vnd.happier.artifact-upload-v1';
export const ARTIFACT_UPLOAD_PATH_V1 = '/v1/artifacts/content/upload';
type Destination<T> = T extends unknown ? Omit<T, 'sizeBytes' | 't'> : never;
export type ArtifactUploadDestinationV1 = Destination<ArtifactBlobUploadInitV1>;

/** A strict JSON metadata line followed by uninterpreted bytes, all on one HTTP request. */
export function encodeArtifactUploadFrameV1(destination: ArtifactUploadDestinationV1,
    content: ArtifactBlobStoredContentV1): Uint8Array<ArrayBuffer> {
    const parsed = ArtifactBlobStoredContentV1Schema.parse(content);
    const bytes = decodeBase64(parsed.t === 'plain' ? parsed.v : parsed.c);
    const metadata = ArtifactBlobUploadInitV1Schema.parse({ ...destination, t: parsed.t, sizeBytes: bytes.byteLength });
    const prefix = new TextEncoder().encode(`${JSON.stringify(metadata)}\n`);
    const frame = new Uint8Array(prefix.byteLength + bytes.byteLength);
    frame.set(prefix);
    frame.set(bytes, prefix.byteLength);
    return frame;
}

export function decodeArtifactUploadMetadataV1(bytes: Uint8Array): ArtifactBlobUploadInitV1 {
    return ArtifactBlobUploadInitV1Schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}
