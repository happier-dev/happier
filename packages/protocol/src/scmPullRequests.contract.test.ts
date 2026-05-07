import { describe, expect, it } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from './scm.js';

describe('scm pull request protocol contracts', () => {
  it('parses hosting providers and pull request summaries', { timeout: 60_000 }, async () => {
    const protocol = await import('./scmPullRequests.js').catch(() => null);
    expect(protocol).not.toBeNull();
    if (!protocol) {
      throw new Error('expected scm pull request protocol module');
    }

    const provider = protocol.ScmHostingProviderSchema.parse({
      kind: 'github',
      name: 'GitHub',
      baseUrl: 'https://github.com',
      nameWithOwner: 'happier-dev/happier',
      remoteName: 'origin',
    });

    const pullRequest = protocol.ScmPullRequestSummarySchema.parse({
      provider,
      number: 42,
      title: 'Add PR support',
      url: 'https://github.com/happier-dev/happier/pull/42',
      baseBranch: 'main',
      headBranch: 'feature/pr-support',
      state: 'open',
    });

    expect(pullRequest.provider.kind).toBe('github');
    expect(pullRequest.provider.nameWithOwner).toBe('happier-dev/happier');
    expect(pullRequest.number).toBe(42);

    const rootProtocol = await import('./index.js') as Record<string, unknown>;
    expect(rootProtocol.ScmPullRequestSummarySchema).toBe(protocol.ScmPullRequestSummarySchema);
  });

  it('uses cwd on pull request requests and parses open-or-reuse fallbacks', async () => {
    const protocol = await import('./scmPullRequests.js').catch(() => null);
    expect(protocol).not.toBeNull();
    if (!protocol) {
      throw new Error('expected scm pull request protocol module');
    }

    const request = protocol.ScmPullRequestOpenOrReuseRequestSchema.parse({
      cwd: '/repo',
      backendPreference: {
        kind: 'prefer',
        backendId: 'sapling',
      },
      base: 'main',
      title: 'Add PR support',
      body: 'Implements the PR workflow.',
      head: 'feature/pr-support',
    });

    expect(request.cwd).toBe('/repo');
    expect(request.backendPreference?.backendId).toBe('sapling');
    expect('workingDirectory' in request).toBe(false);

    const fallback = protocol.ScmPullRequestOpenOrReuseResponseSchema.parse({
      success: true,
      kind: 'no-auth',
      composeUrl: 'https://github.com/happier-dev/happier/compare/main...feature/pr-support',
    });

    expect(fallback.kind).toBe('no-auth');
  });

  it('accepts only the currently supported pull request list state filter', async () => {
    const protocol = await import('./scmPullRequests.js').catch(() => null);
    expect(protocol).not.toBeNull();
    if (!protocol) {
      throw new Error('expected scm pull request protocol module');
    }

    const openListRequest = protocol.ScmPullRequestListRequestSchema.parse({
      cwd: '/repo',
      state: 'open',
    });
    expect(openListRequest.state).toBe('open');

    const closedListRequest = protocol.ScmPullRequestListRequestSchema.safeParse({
      cwd: '/repo',
      state: 'closed',
    });
    expect(closedListRequest.success).toBe(false);

    const mergedListRequest = protocol.ScmPullRequestListRequestSchema.safeParse({
      cwd: '/repo',
      state: 'merged',
    });
    expect(mergedListRequest.success).toBe(false);
  });

  it('parses stacked action progress events', async () => {
    const protocol = await import('./scmPullRequests.js').catch(() => null);
    expect(protocol).not.toBeNull();
    if (!protocol) {
      throw new Error('expected scm pull request protocol module');
    }

    const request = protocol.ScmPullRequestRunStackedRequestSchema.parse({
      cwd: '/repo',
      action: 'commitPushPr',
      commitMessage: 'Add PR support',
      featureBranch: 'feature/pr-support',
      filePaths: ['packages/protocol/src/scmPullRequests.ts'],
      base: 'main',
    });
    expect(request.action).toBe('commitPushPr');

    const event = protocol.ScmPullRequestRunStackedProgressEventSchema.parse({
      kind: 'phase_started',
      phase: 'push',
      message: 'Pushing branch',
      timestamp: 1_714_000_000_000,
    });

    expect(event.phase).toBe('push');

    const fallback = protocol.ScmPullRequestRunStackedResponseSchema.parse({
      success: true,
      branch: 'feature/pr-support',
      pullRequest: null,
      composeUrl: 'https://github.com/happier-dev/happier/compare/main...feature/pr-support',
      nextAction: {
        kind: 'openCompose',
        url: 'https://github.com/happier-dev/happier/compare/main...feature/pr-support',
      },
      events: [],
    });

    expect(fallback).toMatchObject({
      success: true,
      composeUrl: 'https://github.com/happier-dev/happier/compare/main...feature/pr-support',
      nextAction: {
        kind: 'openCompose',
      },
    });

    const openPullRequestAction = protocol.ScmPullRequestRunStackedNextActionSchema.parse({
      kind: 'openPullRequest',
      url: 'https://github.com/happier-dev/happier/pull/42',
    });
    expect(openPullRequestAction.kind).toBe('openPullRequest');

    const failed = protocol.ScmPullRequestRunStackedResponseSchema.parse({
      success: false,
      error: 'Push failed',
      errorCode: 'COMMAND_FAILED',
      events: [{
        kind: 'action_failed',
        phase: 'push',
        message: 'Push failed',
        timestamp: 1_714_000_000_001,
      }],
    });

    expect(failed).toMatchObject({
      success: false,
      events: [{
        kind: 'action_failed',
        phase: 'push',
      }],
    });
  });

  it('rejects pull request error responses with unknown SCM error codes', async () => {
    const protocol = await import('./scmPullRequests.js').catch(() => null);
    expect(protocol).not.toBeNull();
    if (!protocol) {
      throw new Error('expected scm pull request protocol module');
    }

    const parsed = protocol.ScmPullRequestListResponseSchema.safeParse({
      success: false,
      error: 'Unsupported',
      errorCode: 'some_new_error_code',
    });
    expect(parsed.success).toBe(false);

    const known = protocol.ScmPullRequestListResponseSchema.parse({
      success: false,
      error: 'Unsupported',
      errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
    });
    expect(known).toMatchObject({
      success: false,
      errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
    });
  });
});
