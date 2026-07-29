import { createHash, timingSafeEqual } from 'node:crypto';

const SOURCE_GENERATION_ANCHOR_DOMAIN_V1 =
  'happier.external-session.source-generation-anchor.v1\u0000';

export function createExternalSessionSourceGenerationAnchor(
  sourceSnapshotEvidenceRef: string,
): string {
  return createHash('sha256')
    .update(SOURCE_GENERATION_ANCHOR_DOMAIN_V1, 'utf8')
    .update(sourceSnapshotEvidenceRef, 'utf8')
    .digest('base64url');
}

export function matchesExternalSessionSourceGenerationAnchor(
  sourceGeneration: string,
  sourceSnapshotEvidenceRef: string,
): boolean {
  const expected = Buffer.from(
    createExternalSessionSourceGenerationAnchor(sourceSnapshotEvidenceRef),
    'utf8',
  );
  const actual = Buffer.from(sourceGeneration, 'utf8');
  return actual.length === expected.length
    && timingSafeEqual(actual, expected);
}
