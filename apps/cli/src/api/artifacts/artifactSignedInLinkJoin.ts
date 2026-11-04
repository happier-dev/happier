import { createArtifactSignedInLinkJoinActionV1 } from '@happier-dev/protocol/actions/executor/artifactPublicLinkActions';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactBodyEnvelopeV1StoredSchema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { ArtifactHeaderMetadataV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { decodeBase64, decryptWithDataKey, getRandomBytes } from '@/api/encryption';

/** The CLI keyholding host opens stored envelopes before the transient recipient callback. */
export function createCliArtifactSignedInLinkJoinAction(params: Omit<Parameters<typeof createArtifactSignedInLinkJoinActionV1>[0], 'openContent' | 'randomBytes'>) {
  return createArtifactSignedInLinkJoinActionV1({ ...params, randomBytes: getRandomBytes,
    openContent: async ({ read, dataKey }) => {
      if (read.content.kind !== 'artifact') throw Object.assign(new Error('artifact_content_unavailable'), { code: 'artifact_content_unavailable' });
      const decode = (value: string): unknown => {
        if (read.encryptionMode === 'plain') return decodePlainArtifactStoredContent(value);
        if (!dataKey) throw Object.assign(new Error('artifact_encryption_material_unavailable'), { code: 'artifact_encryption_material_unavailable' });
        return decryptWithDataKey(decodeBase64(value), dataKey);
      };
      const header = ArtifactHeaderMetadataV1Schema.parse(decode(read.content.header));
      return { artifactId: read.artifactId, ownerAccountId: read.authorAccountId,
        header, body: ArtifactBodyEnvelopeV1StoredSchema.parse(decode(read.content.body)).body,
        revision: { headerVersion: read.content.headerVersion, bodyVersion: read.content.bodyVersion } };
    },
  });
}
