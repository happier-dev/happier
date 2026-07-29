import { describe, expect, it } from 'vitest';

import {
  ScmHostingProviderCapabilitiesSchema,
  ScmPullRequestOpenOrReuseRequestSchema,
  ScmPullRequestListResponseSchema,
  ScmPullRequestStatusProjectionSchema,
  resolveScmHostingProviderFollowupAllowedBaseUrl,
} from './pullRequests.js';

const provider = {
  id: 'scm.github',
  kind: 'github',
  displayName: 'GitHub',
  baseUrl: 'https://github.com',
  nameWithOwner: 'happier-dev/happier',
  remoteName: 'origin',
};

describe('SCM pull-request freshness protocol', () => {
  it('preserves remote hosting-provider capability scope metadata', () => {
    expect(ScmHostingProviderCapabilitiesSchema.parse({})).toMatchObject({
      capabilityScope: 'remote-hosting-provider',
      pullRequests: {
        list: false,
      },
    });

    expect(ScmHostingProviderCapabilitiesSchema.safeParse({
      capabilityScope: 'local-backend',
    }).success).toBe(false);
  });

  it('validates freshness metadata on PR status cache projections', () => {
    const parsed = ScmPullRequestStatusProjectionSchema.parse({
      provider,
      headBranch: 'feature/freshness',
      baseBranch: 'main',
      openPullRequest: null,
      freshness: {
        source: 'cached-remote',
        observedAt: 100,
        expiresAt: 200,
      },
      refreshPolicy: 'stale-while-revalidate',
    });

    expect(parsed.freshness).toEqual({
      source: 'cached-remote',
      observedAt: 100,
      expiresAt: 200,
    });
    expect(parsed.refreshPolicy).toBe('stale-while-revalidate');

    expect(ScmPullRequestStatusProjectionSchema.safeParse({
      provider,
      headBranch: 'feature/freshness',
      baseBranch: 'main',
      openPullRequest: null,
      freshness: {
        source: 'cached-local',
        observedAt: 100,
      },
    }).success).toBe(false);
  });

  it('validates freshness metadata on remote PR list cache responses', () => {
    const parsed = ScmPullRequestListResponseSchema.parse({
      success: true,
      pullRequests: [],
      freshness: {
        source: 'explicit-remote',
        observedAt: 100,
      },
      refreshPolicy: 'force-refresh',
    });

    expect(parsed).toMatchObject({
      success: true,
      freshness: {
        source: 'explicit-remote',
        observedAt: 100,
      },
      refreshPolicy: 'force-refresh',
    });

    expect(ScmPullRequestListResponseSchema.safeParse({
      success: true,
      pullRequests: [],
      freshness: {
        source: 'live-local',
        observedAt: 100,
      },
    }).success).toBe(false);
  });

  it('accepts request-scoped default-branch policy overrides for PR open-or-reuse', () => {
    expect(ScmPullRequestOpenOrReuseRequestSchema.parse({
      base: 'main',
      head: 'feature/scm-pr',
      defaultBranchPushPolicy: 'requires-feature-branch',
    })).toMatchObject({
      base: 'main',
      head: 'feature/scm-pr',
      defaultBranchPushPolicy: 'requires-feature-branch',
    });

    expect(ScmPullRequestOpenOrReuseRequestSchema.safeParse({
      base: 'main',
      defaultBranchPushPolicy: 'prompt',
    }).success).toBe(false);
  });

  it('accepts a qualified external backend preference', () => {
    expect(ScmPullRequestOpenOrReuseRequestSchema.parse({
      base: 'main',
      head: 'feature/scm-pr',
      backendPreference: {
        kind: 'prefer',
        backendId: 'acme.scm/stacked',
      },
    })).toMatchObject({
      backendPreference: {
        kind: 'prefer',
        backendId: 'acme.scm/stacked',
      },
    });
  });
});

describe('resolveScmHostingProviderFollowupAllowedBaseUrl', () => {
  it('fails closed for known repository-scoped providers without repository identity', () => {
    expect(resolveScmHostingProviderFollowupAllowedBaseUrl({
      provider: {
        id: 'scm.github',
        kind: 'github',
        displayName: 'GitHub',
        baseUrl: 'https://github.com',
      },
      allowedBaseUrl: 'https://github.com',
    })).toBeNull();
  });

  it('fails closed when a repository-scoped provider has no provider-owned repository web base', () => {
    expect(resolveScmHostingProviderFollowupAllowedBaseUrl({
      provider: {
        id: 'scm.custom',
        kind: 'custom',
        displayName: 'Custom SCM',
        baseUrl: 'https://code.example.test',
        nameWithOwner: 'acme/repo',
      },
      allowedBaseUrl: 'https://code.example.test',
    })).toBeNull();
  });

  it('uses provider-owned repository web bases without provider-kind path derivation', () => {
    expect(resolveScmHostingProviderFollowupAllowedBaseUrl({
      provider: {
        id: 'scm.custom',
        kind: 'custom',
        displayName: 'Custom SCM',
        baseUrl: 'https://code.example.test',
        nameWithOwner: 'acme/repo',
        repositoryWebUrl: 'https://code.example.test/projects/acme/repo',
      },
      allowedBaseUrl: 'https://code.example.test',
    })).toBe('https://code.example.test/projects/acme/repo');
  });

  it('rejects caller-provided allowed bases outside the detected provider origin', () => {
    expect(resolveScmHostingProviderFollowupAllowedBaseUrl({
      provider: {
        id: 'scm.github',
        kind: 'github',
        displayName: 'GitHub',
        baseUrl: 'https://github.com',
        nameWithOwner: 'acme/repo',
        repositoryWebUrl: 'https://github.com/acme/repo',
      },
      allowedBaseUrl: 'https://evil.example.com',
    })).toBeNull();
  });

  it('rejects provider-owned repository web bases containing credentials', () => {
    expect(resolveScmHostingProviderFollowupAllowedBaseUrl({
      provider: {
        id: 'scm.github',
        kind: 'github',
        displayName: 'GitHub',
        baseUrl: 'https://github.com',
        nameWithOwner: 'acme/repo',
        repositoryWebUrl: 'https://token@github.com/acme/repo',
      },
      allowedBaseUrl: 'https://github.com',
    })).toBeNull();
  });

  it('scopes Azure DevOps follow-up URLs to the detected repository path', () => {
    expect(resolveScmHostingProviderFollowupAllowedBaseUrl({
      provider: {
        id: 'scm.azure-devops',
        kind: 'azure-devops',
        displayName: 'Azure DevOps',
        baseUrl: 'https://dev.azure.com/acme',
        nameWithOwner: 'acme/project-a/repo-a',
        repositoryWebUrl: 'https://dev.azure.com/acme/project-a/_git/repo-a',
      },
      allowedBaseUrl: 'https://dev.azure.com/acme',
    })).toBe('https://dev.azure.com/acme/project-a/_git/repo-a');
  });

  it('scopes legacy Azure DevOps follow-up URLs to the detected repository path', () => {
    expect(resolveScmHostingProviderFollowupAllowedBaseUrl({
      provider: {
        id: 'scm.azure-devops',
        kind: 'azure-devops',
        displayName: 'Azure DevOps',
        baseUrl: 'https://acme.visualstudio.com',
        nameWithOwner: 'acme/project-a/repo-a',
        repositoryWebUrl: 'https://acme.visualstudio.com/project-a/_git/repo-a',
      },
      allowedBaseUrl: 'https://acme.visualstudio.com',
    })).toBe('https://acme.visualstudio.com/project-a/_git/repo-a');
  });

  it('rejects Azure DevOps repository paths outside the allowed organization base path', () => {
    expect(resolveScmHostingProviderFollowupAllowedBaseUrl({
      provider: {
        id: 'scm.azure-devops',
        kind: 'azure-devops',
        displayName: 'Azure DevOps',
        baseUrl: 'https://dev.azure.com/acme',
        nameWithOwner: 'other/project-a/repo-a',
        repositoryWebUrl: 'https://dev.azure.com/other/project-a/_git/repo-a',
      },
      allowedBaseUrl: 'https://dev.azure.com/acme',
    })).toBeNull();
  });

  it('scopes self-managed GitLab follow-up URLs under the configured base path', () => {
    expect(resolveScmHostingProviderFollowupAllowedBaseUrl({
      provider: {
        id: 'scm.gitlab',
        kind: 'gitlab',
        displayName: 'GitLab',
        baseUrl: 'https://code.internal.test/gitlab',
        nameWithOwner: 'platform/happier/app',
        repositoryWebUrl: 'https://code.internal.test/gitlab/platform/happier/app',
      },
      allowedBaseUrl: 'https://code.internal.test/gitlab',
    })).toBe('https://code.internal.test/gitlab/platform/happier/app');
  });
});
