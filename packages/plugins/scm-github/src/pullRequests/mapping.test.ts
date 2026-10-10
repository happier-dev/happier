import type { ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
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

    const mapped = mod.mapGithubPullRequest(provider, {
      number: 42,
      id: 123456,
      title: 'Add adapters',
      html_url: 'https://github.com/happier-dev/happier/pull/42',
      state: 'closed',
      draft: true,
      created_at: '2026-10-01T12:00:00Z',
      merged_at: '2026-10-02T12:00:00Z',
      closed_at: '2026-10-02T12:00:00Z',
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
    });
    expect(mapped).toMatchObject({
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
      state: 'merged',
      createdAtMs: Date.parse('2026-10-01T12:00:00Z'),
      mergedAtMs: Date.parse('2026-10-02T12:00:00Z'),
      closedAtMs: Date.parse('2026-10-02T12:00:00Z'),
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

    const mapped = mod.mapGithubPullRequest(provider, {
      number: 7,
      title: 'Read through provider hook',
      url: 'https://github.com/happier-dev/happier/pull/7',
      state: 'MERGED',
      isDraft: false,
      createdAt: 'invalid',
      mergedAt: '2026-10-02T12:00:00Z',
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
    });
    expect(mapped).toMatchObject({
      number: 7,
      title: 'Read through provider hook',
      baseBranch: 'main',
      headBranch: 'feature/provider-hook',
      headRepositoryNameWithOwner: 'happier-dev/happier',
      isCrossRepository: false,
      baseSha: 'cli-base-sha',
      headSha: 'cli-head-sha',
      state: 'merged',
      mergedAtMs: Date.parse('2026-10-02T12:00:00Z'),
      isDraft: false,
      author: {
        login: 'monalisa',
        displayName: 'Mona Lisa',
      },
      checks: {
        state: 'success',
      },
    });
    expect(mapped).not.toHaveProperty('createdAtMs');
    expect(mapped).not.toHaveProperty('closedAtMs');
  });

  it('keeps native close time separate from absent merge time and omits invalid dates', async () => {
    const { mapGithubPullRequest } = await import('./mapping.js');
    const mapped = mapGithubPullRequest(provider, {
      number: 8,
      title: 'Closed without merge',
      html_url: 'https://github.com/happier-dev/happier/pull/8',
      base: { ref: 'main' },
      head: { ref: 'feature/closed' },
      state: 'closed',
      created_at: 'invalid',
      closed_at: '2026-10-02T12:00:00Z',
      merged_at: null,
    });
    expect(mapped).toMatchObject({ state: 'closed', closedAtMs: Date.parse('2026-10-02T12:00:00Z') });
    expect(mapped).not.toHaveProperty('createdAtMs');
    expect(mapped).not.toHaveProperty('mergedAtMs');
  });

  it.each([
    { nativeState: 'closed', draft: true, merged: false, expectedState: 'closed' },
    { nativeState: 'open', draft: false, merged: false, expectedState: 'open' },
    { nativeState: 'open', draft: true, merged: false, expectedState: 'draft' },
    { nativeState: 'closed', draft: true, merged: true, expectedState: 'merged' },
    { nativeState: 'MERGED', draft: true, merged: false, expectedState: 'merged' },
  ] as const)('preserves $expectedState independently of malformed merge time', async ({ nativeState, draft, merged, expectedState }) => {
    const { mapGithubPullRequest } = await import('./mapping.js');
    const mapped = mapGithubPullRequest(provider, {
      number: 9,
      title: 'Native lifecycle',
      url: 'https://github.com/happier-dev/happier/pull/9',
      baseRefName: 'main',
      headRefName: 'feature/lifecycle',
      state: nativeState,
      draft,
      merged,
      merged_at: 'invalid',
    });
    expect(mapped).toMatchObject({ number: 9, state: expectedState, isDraft: draft });
    expect(mapped).not.toHaveProperty('mergedAtMs');
  });
});
