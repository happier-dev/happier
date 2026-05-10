import { describe, expect, it } from 'vitest';

import {
  ScmHostingProviderCapabilitiesSchema,
  ScmPullRequestListResponseSchema,
  ScmPullRequestStatusProjectionSchema,
} from './scmPullRequests.js';

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
});
