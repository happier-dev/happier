import type { ScmHostingProviderRef } from '@happier-dev/plugin-sdk/experimental/scm';
import { describe, expect, it } from 'vitest';

const provider: ScmHostingProviderRef = {
  id: 'scm.github',
  kind: 'github',
  displayName: 'GitHub',
  baseUrl: 'https://github.com',
  nameWithOwner: 'happier-dev/happier',
  urlSafety: { allowedSchemes: ['https:'] },
};

describe('GitHub pull request mapping', () => {
  it('normalizes REST pull request payloads into canonical summaries', async () => {
    const mod = await import('./mapping.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.mapGithubPullRequest(provider, {
      number: 42,
      id: 123456,
      title: 'Add adapters',
      html_url: 'https://github.com/happier-dev/happier/pull/42',
      state: 'open',
      draft: true,
      user: {
        login: 'octocat',
        html_url: 'https://github.com/octocat',
      },
      base: {
        ref: 'main',
        sha: 'base-sha',
      },
      head: {
        ref: 'feature/scm-pr-4',
        sha: 'head-sha',
        repo: {
          full_name: 'happier-dev/happier',
        },
      },
    })).toMatchObject({
      provider,
      number: 42,
      providerNativeId: '123456',
      title: 'Add adapters',
      url: 'https://github.com/happier-dev/happier/pull/42',
      baseBranch: 'main',
      headBranch: 'feature/scm-pr-4',
      headRepositoryNameWithOwner: 'happier-dev/happier',
      isCrossRepository: false,
      baseSha: 'base-sha',
      headSha: 'head-sha',
      state: 'draft',
      isDraft: true,
      author: {
        login: 'octocat',
        url: 'https://github.com/octocat',
      },
    });
  });

  it('normalizes gh CLI pull request payloads into canonical summaries', async () => {
    const mod = await import('./mapping.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.mapGithubPullRequest(provider, {
      number: 7,
      title: 'Read through provider hook',
      url: 'https://github.com/happier-dev/happier/pull/7',
      state: 'MERGED',
      isDraft: false,
      author: {
        login: 'monalisa',
        name: 'Mona Lisa',
        url: 'https://github.com/monalisa',
      },
      baseRefName: 'main',
      headRefName: 'feature/provider-hook',
      headRepository: {
        nameWithOwner: 'happier-dev/happier',
      },
      baseRefOid: 'cli-base-sha',
      headRefOid: 'cli-head-sha',
      statusCheckRollup: [
        { conclusion: 'SUCCESS' },
      ],
    })).toMatchObject({
      number: 7,
      title: 'Read through provider hook',
      baseBranch: 'main',
      headBranch: 'feature/provider-hook',
      headRepositoryNameWithOwner: 'happier-dev/happier',
      isCrossRepository: false,
      baseSha: 'cli-base-sha',
      headSha: 'cli-head-sha',
      state: 'merged',
      isDraft: false,
      author: {
        login: 'monalisa',
        displayName: 'Mona Lisa',
      },
      checks: {
        state: 'success',
      },
    });
  });
});
