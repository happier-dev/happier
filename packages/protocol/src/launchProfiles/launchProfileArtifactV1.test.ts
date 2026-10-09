import { describe, expect, it } from 'vitest';
import { readLaunchProfileArtifactV1, readLaunchProfileArtifactForReferenceCensusV1 } from './launchProfileArtifactV1.js';

describe('Launch Profile Artifact reference census admission', () => {
  it('retains harmless additive display fields but refuses references lost by the stored projection', () => {
    const resource = (extra: Record<string, unknown>) => ({ artifactId: 'published',
      header: { kind: 'launch-profile.v1', profileId: 'profile', name: 'Profile' },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile: {
        v: 2, id: 'profile', name: 'Profile', createdAt: 1, updatedAt: 1, ...extra,
      }, secretBindings: { TOKEN: 'happier:shared-secret:v1:resource' } }),
    });
    const unknownReference = resource({ future: { bootstrapCredentialRef: 'retained-secret' } });
    expect(readLaunchProfileArtifactV1(unknownReference)?.profile.id).toBe('profile');
    expect(readLaunchProfileArtifactForReferenceCensusV1(unknownReference)).toBeNull();
    expect(readLaunchProfileArtifactForReferenceCensusV1(resource({ futureDisplay: 'harmless' })))
      .toMatchObject({ profile: { id: 'profile' }, secretBindings: { TOKEN: 'happier:shared-secret:v1:resource' } });
  });
});
