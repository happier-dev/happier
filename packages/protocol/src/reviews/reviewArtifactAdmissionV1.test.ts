import { describe, expect, it } from 'vitest';
import { getArtifactContentDeliveryPolicyV1, deriveArtifactTeamResourceKindV1 } from '../artifacts/artifactKindV1.js';
import { getArtifactKindPolicyV1 } from '../artifacts/artifactSharingV1.js';
import { ArtifactJsonCreateHttpInputV1Schema, ArtifactJsonUpdateHttpInputV1Schema } from '../artifacts/artifactMutationHttpV1.js';
import { REVIEW_ARTIFACT_KIND_V1 } from './reviewArtifactV1.js';

describe('Review Artifact admission', () => {
  const metadata = { projectSourceId: null, workflowId: null, subjectKind: 'comparison', sourceKind: 'direct',
    state: 'running', currentRoundOrdinal: 1, startedAt: 1, finishedAt: null };
  it('shares through authenticated Artifact grants with addressed delivery and no public link or excerpt', () => {
    expect(getArtifactKindPolicyV1(REVIEW_ARTIFACT_KIND_V1)).toMatchObject({ peopleSharingAllowed: true, publicLinkAllowed: false });
    expect(getArtifactContentDeliveryPolicyV1(REVIEW_ARTIFACT_KIND_V1)).toEqual({ legacySocketPublication: false, bodyPreviewAllowed: false });
    expect(deriveArtifactTeamResourceKindV1({ storedKind: 'v1:other:review.v1' })).toBe('reviews');
  });
  it('admits only non-content lifecycle metadata alongside the sealed create and revision', () => {
    const create = { id: '11111111-1111-4111-8111-111111111111', kind: 'v1:other:review.v1', header: 'sealed', body: 'sealed', dataEncryptionKey: 'key', reviewMetadata: metadata };
    expect(ArtifactJsonCreateHttpInputV1Schema.parse(create)).toEqual(create);
    expect(ArtifactJsonCreateHttpInputV1Schema.safeParse({ ...create, reviewMetadata: { ...metadata, title: 'private' } }).success).toBe(false);
    expect(ArtifactJsonUpdateHttpInputV1Schema.parse({ header: 'next', expectedHeaderVersion: 1, body: 'next', expectedBodyVersion: 1,
      kind: 'v1:other:review.v1', reviewMetadata: { currentRoundOrdinal: 1, state: 'completed', finishedAt: 2 } })).toHaveProperty('reviewMetadata.state', 'completed');
  });
});
