import { ArtifactKindCoverageV1Schema } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { ArtifactReadBatchInputV1Schema, ArtifactReadBatchResponseV1Schema, ArtifactReadHeadersBatchInputV1Schema, ArtifactReadHeadersBatchResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';

/** Kind-filtered Artifact lists answer one envelope; this is the Home wire shape the CLI list reader accepts. */
export function artifactKindListResponse<T>(items: readonly T[],
  coverage = ArtifactKindCoverageV1Schema.parse({ status: 'complete', unclassifiedCount: 0 })): Readonly<{
  items: readonly T[]; hasUnclassified: boolean; coverage: ReturnType<typeof ArtifactKindCoverageV1Schema.parse>;
}> {
  return { items, hasUnclassified: coverage.status === 'partial', coverage };
}

/** GET /v1/artifacts answers a bare array unless the request selects membership, which answers the envelope. */
export function artifactListResponse<T>(url: string, items: readonly T[]): readonly T[] | ReturnType<typeof artifactKindListResponse<T>> {
  const { searchParams } = new URL(url, 'http://home.test');
  return ['kind', 'kinds', 'browserListed', 'approvalStates', 'approvalSessionIds', 'unclassified']
    .some(name => searchParams.has(name)) ? artifactKindListResponse(items) : items;
}

type ArtifactRow = Readonly<{ id: string }> & Readonly<Record<string, unknown>>;

/**
 * POST /v1/artifacts/read: a 'headers' projection never carries bodies; the plain batch carries each
 * Artifact with its body. An unknown identity is the typed per-item refusal, never a transport failure.
 */
export function artifactReadResponse(
  body: unknown, readArtifact: (artifactId: string) => ArtifactRow | null,
): Readonly<{ status: 200; data: unknown }> {
  const headersOnly = ArtifactReadHeadersBatchInputV1Schema.safeParse(body);
  const { artifactIds } = headersOnly.success ? headersOnly.data : ArtifactReadBatchInputV1Schema.parse(body);
  const refusal = (artifactId: string) => ({ artifactId, ok: false, error: 'artifact_not_found', status: 404, retryable: false });
  if (headersOnly.success) {
    return { status: 200, data: ArtifactReadHeadersBatchResponseV1Schema.parse({ projection: 'headers', items: artifactIds.map(artifactId => {
      const row = readArtifact(artifactId);
      if (!row) return refusal(artifactId);
      const { body: _body, ...header } = row;
      return { artifactId, ok: true, artifact: { publicAudience: 'none', ...header } };
    }) }) };
  }
  return { status: 200, data: ArtifactReadBatchResponseV1Schema.parse({ items: artifactIds.map(artifactId => {
    const row = readArtifact(artifactId);
    if (!row) return refusal(artifactId);
    // An E2EE Artifact carries its caller's recipient census with the detail; a plain one never does.
    const census = row.encryptionMode === 'plain' ? null : { artifactId, ownerAccountId: row.ownerAccountId,
      access: row.access, encryptionMode: row.encryptionMode, dataEncryptionKey: row.dataEncryptionKey,
      callerDataEncryptionKey: row.dataEncryptionKey, recipients: [] };
    return { artifactId, ok: true, artifact: { publicAudience: 'none', ...row }, recipientCensus: census };
  }) }) };
}
