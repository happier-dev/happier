import { describe, expect, it } from 'vitest';
import { resolveProjectFilesForManagedLaunch } from './projectFilesLaunchSelection';

describe('Project files managed launch selection', () => {
  it('retains the selected Git account when placement omitted it but the recipe carries it', () => {
    const selected = { service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' }, accountId: 'selected' } as const;
    expect(resolveProjectFilesForManagedLaunch({
      placement: { kind: 'git_clone', source: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' }, repository: { nameWithOwner: 'org/repo' }, protocol: 'https' }, branch: 'main' },
      recipe: { kind: 'git_clone', source: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' }, repository: { nameWithOwner: 'org/repo' }, protocol: 'https' }, branch: 'main', gitAccount: selected },
    })).toMatchObject({ kind: 'git_clone', gitAccount: selected });
  });
});
