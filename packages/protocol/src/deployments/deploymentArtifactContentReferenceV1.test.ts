import { describe, expect, it } from 'vitest';
import { readDeploymentArtifactHeaderV1, readDeploymentArtifactJsonBodyV1 } from './deploymentArtifactContentReferenceV1.js';

describe('opened deployment Artifact identity and content', () => {
  const reference = { contentArtifactId: 'environment-content', contentHeaderVersion: 2, contentBodyVersion: 3 };
  const artifact = { artifactId: reference.contentArtifactId, revision: { headerVersion: 2, bodyVersion: 3 },
    header: { kind: 'deployment-environment.v1', title: 'Staging', excerpt: 'generic Artifact metadata' },
    body: JSON.stringify({ previewProvenance: { private: 'domain parser still required' } }) };
  it('shares exact identity/kind/CAS admission without granting domain meaning to an opened body', () => {
    expect(readDeploymentArtifactHeaderV1(reference, artifact, 'deployment-environment.v1'))
      .toEqual({ ok: true, title: 'Staging' });
    expect(readDeploymentArtifactJsonBodyV1(reference, artifact, 'deployment-environment.v1'))
      .toEqual({ ok: true, title: 'Staging', body: JSON.parse(artifact.body) });
    for (const stale of [{ ...artifact, artifactId: 'other' },
      { ...artifact, revision: { headerVersion: 3, bodyVersion: 3 } },
      { ...artifact, revision: { headerVersion: 2, bodyVersion: 4 } }]) {
      expect(readDeploymentArtifactJsonBodyV1(reference, stale, 'deployment-environment.v1'))
        .toEqual({ ok: false, error: 'deployment_conflict' });
    }
    for (const invalid of [null, { ...artifact, header: { ...artifact.header, kind: 'deployment-receipt.v1' } },
      { ...artifact, body: '{malformed' }, { ...artifact, body: null }]) {
      expect(readDeploymentArtifactJsonBodyV1(reference, invalid, 'deployment-environment.v1'))
        .toEqual({ ok: false, error: 'deployment_content_unavailable' });
    }
  });
});
