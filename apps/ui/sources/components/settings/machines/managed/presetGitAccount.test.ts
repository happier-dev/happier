import { describe, expect, it } from 'vitest';

import type { ScmProjectedHostingProvider } from '@/scm/registry/scmContributionCatalog';

import {
  selectPresetGitHostingProvider,
  withPresetGitAccount,
} from './presetGitAccount';

const host = (
  localId: string,
  authService: ScmProjectedHostingProvider['authService'],
): ScmProjectedHostingProvider => ({
  id: `forge.${localId}/${localId}`,
  localId,
  pluginId: `forge.${localId}`,
  title: localId,
  description: '',
  kind: 'git',
  authService,
  connectedServiceId: null,
  capabilities: {},
});
const githubAuth = { pluginId: 'forge.github', localId: 'github-account' };
const gitlabAuth = { pluginId: 'forge.gitlab', localId: 'gitlab-account' };

describe('a Git clone preset’s account', () => {
  it('offers the host that declares an account service, and keeps a stored account on its own host', () => {
    const providers = [
      host('plain', null),
      host('github', githubAuth),
      host('gitlab', gitlabAuth),
    ];
    expect(selectPresetGitHostingProvider(providers, undefined)?.localId).toBe(
      'github',
    );
    expect(
      selectPresetGitHostingProvider(providers, {
        service: gitlabAuth,
        accountId: 'mine',
      })?.localId,
    ).toBe('gitlab');
    expect(
      selectPresetGitHostingProvider([host('plain', null)], undefined),
    ).toBeNull();
  });

  it('stores the chosen account on the clone and clears it without touching the rest', () => {
    const clone = { kind: 'git_clone' as const };
    const account = { service: githubAuth, accountId: 'mine' };
    expect(withPresetGitAccount(clone, account)).toEqual({
      kind: 'git_clone',
      gitAccount: account,
    });
    expect(
      withPresetGitAccount({ kind: 'git_clone', gitAccount: account }, null),
    ).toEqual({ kind: 'git_clone' });
  });
});
