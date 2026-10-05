import { decodeArtifactUploadMetadataV1 } from '@happier-dev/transfers';
import { z } from 'zod';

/** Model the HTTP boundary's published byte carrier while retaining real document codecs. */
export function readCarrierMutation(input: unknown): Record<string, unknown> {
  if (!Buffer.isBuffer(input)) return z.record(z.string(), z.unknown()).parse(input);
  const separator = input.indexOf(10);
  const metadata = decodeArtifactUploadMetadataV1(input.subarray(0, separator));
  const bytes = input.subarray(separator + 1).toString('base64');
  return { ...metadata, ...(metadata.kind === 'create' ? { id: metadata.artifactId } : {}),
    blob: { blobId: metadata.blobId, content: metadata.t === 'plain'
      ? { t: 'plain', v: bytes } : { t: 'encrypted', c: bytes } } };
}
