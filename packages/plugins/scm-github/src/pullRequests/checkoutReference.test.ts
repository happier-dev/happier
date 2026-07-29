import type {
  ScmHostingProviderRef,
  ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/experimental/scm';
import { describe, expect, it } from 'vitest';

const provider: ScmHostingProviderRef = {
  id: 'scm.github',
  kind: 'github',
  displayName: 'GitHub',
  baseUrl: 'https://github.com',
  nameWithOwner: 'happier-dev/happier',
  urlSafety: { allowedSchemes: ['https:'] },
};

describe('GitHub checkout reference metadata', () => {
  it('derives checkout metadata without creating worktrees or switching branches', async () => {
    const mod = await import('./checkoutReference.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const pullRequest: ScmPullRequestSummary = {
      provider,
      number: 4,
      title: 'Checkout metadata',
      url: 'https://github.com/happier-dev/happier/pull/4',
      baseBranch: 'main',
      headBranch: 'feature/checkout-reference',
      baseSha: 'base-sha',
      headSha: 'head-sha',
      state: 'open',
    };

    expect(mod.resolveGithubCheckoutReferenceFromPullRequest(pullRequest)).toEqual({
      pullRequest,
      branch: 'feature/checkout-reference',
      remoteRef: 'refs/pull/4/head',
      headSha: 'head-sha',
      baseSha: 'base-sha',
    });
  });
});
