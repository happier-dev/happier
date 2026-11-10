import { describe, expect, it } from 'vitest';
import { previewRepositoryForDefinition } from './provisionRepositoryForDefinition';

describe('repository provisioning review', () => {
  it('previews the seed and branch publication without requiring a checkout or causing Forge effects', () => {
    expect(previewRepositoryForDefinition({ providerKind: 'github', owner: 'alice', repositoryName: 'application', visibility: 'private' }))
      .toMatchObject({ initialBranch: 'main', files: [{ path: 'README.md', content: expect.any(String) }],
        createRepository: { pushCurrentBranch: true } });
  });

  it('previews an existing committed base without promising a new seed', () => {
    expect(previewRepositoryForDefinition({ providerKind: 'github', owner: 'alice', repositoryName: 'application', visibility: 'private' },
      { baseCommit: 'a'.repeat(40), baseBranch: 'personal' }))
      .toMatchObject({ initialBranch: 'personal', files: [], createRepository: { pushCurrentBranch: true } });
  });
});
