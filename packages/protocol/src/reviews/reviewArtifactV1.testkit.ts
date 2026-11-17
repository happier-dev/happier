import {
  createReviewRecordPortV1,
  ReviewMetadataV1Schema,
  type ReviewArtifactTransportV1,
  type ReviewMetadataV1,
  type ReviewRecordPortV1,
} from './reviewArtifactV1.js';

/** Replace only Artifact persistence; Review admission, content and settlement stay real. */
export function createInMemoryReviewRecordPortV1(): ReviewRecordPortV1 {
  type Row = NonNullable<Awaited<ReturnType<ReviewArtifactTransportV1['read']>>> & {
    reviewMetadata: ReviewMetadataV1;
  };
  const rows = new Map<string, Row>();
  return createReviewRecordPortV1({
    read: async (artifactId, options) => {
      options?.signal?.throwIfAborted();
      return rows.get(artifactId) ?? null;
    },
    create: async input => {
      input.signal?.throwIfAborted();
      if (rows.has(input.artifactId)) throw new Error('artifact_already_exists');
      const row: Row = { artifactId: input.artifactId, header: input.header, body: input.body,
        reviewMetadata: ReviewMetadataV1Schema.parse(input.reviewMetadata),
        revision: { headerVersion: 1, bodyVersion: 1 } };
      rows.set(input.artifactId, row);
      return row;
    },
    update: async input => {
      input.signal?.throwIfAborted();
      const previous = rows.get(input.artifactId);
      if (!previous) return { ok: false, errorCode: 'artifact_not_found' };
      if (previous.revision.headerVersion !== input.expectedRevision.headerVersion
        || previous.revision.bodyVersion !== input.expectedRevision.bodyVersion) {
        return { ok: false, errorCode: 'version_mismatch' };
      }
      const revision = { headerVersion: previous.revision.headerVersion + 1, bodyVersion: previous.revision.bodyVersion + 1 };
      rows.set(input.artifactId, { artifactId: input.artifactId, header: input.header, body: input.body, revision,
        reviewMetadata: ReviewMetadataV1Schema.parse({ ...previous.reviewMetadata, ...input.reviewMetadata }) });
      return { ok: true, revision };
    },
  });
}
