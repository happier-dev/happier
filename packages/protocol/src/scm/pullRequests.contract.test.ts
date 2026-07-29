import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

type ZodLikeSchema<TValue = unknown> = {
  parse: (value: unknown) => TValue;
  safeParse: (value: unknown) => { success: boolean };
};

function readProtocolSchema<TValue = unknown>(name: string): ZodLikeSchema<TValue> {
  const value = (protocol as Record<string, unknown>)[name];
  expect(value).toMatchObject({
    parse: expect.any(Function),
    safeParse: expect.any(Function),
  });
  return value as ZodLikeSchema<TValue>;
}

describe('SCM pull-request protocol contracts', () => {
  it('reads the released predecessor hosting-provider shape', () => {
    const provider = readProtocolSchema<protocol.ScmHostingProviderRef>('ScmHostingProviderRefSchema').parse({
      kind: 'github',
      name: 'GitHub',
      baseUrl: 'https://github.com',
      nameWithOwner: 'happier-dev/happier',
      remoteName: 'origin',
    });

    expect(provider).toMatchObject({
      id: 'happier.scm.hosting.github/github',
      kind: 'github',
      displayName: 'GitHub',
      baseUrl: 'https://github.com',
    });
  });

  it('restores the canonical custom category from the predecessor-safe envelope', () => {
    const provider = readProtocolSchema<protocol.ScmHostingProviderRef>('ScmHostingProviderRefSchema').parse({
      id: 'acme.forge/forge',
      kind: 'unknown',
      providerKind: 'custom',
      name: 'Acme Forge',
      displayName: 'Acme Forge',
      baseUrl: 'https://forge.example.test',
    });

    expect(provider.kind).toBe('custom');
    expect(provider.id).toBe('acme.forge/forge');
  });
  it('accepts provider taxonomy and PR summaries without provider behavior', () => {
    const provider = readProtocolSchema<protocol.ScmHostingProviderRef>('ScmHostingProviderRefSchema').parse({
      id: 'azure-devops:acme/project/happier',
      kind: 'azure-devops',
      displayName: 'Azure DevOps',
      baseUrl: 'https://dev.azure.com/acme',
      nameWithOwner: 'acme/project/happier',
      remoteName: 'origin',
      futureProviderMetadata: true,
    });

    expect(provider).toMatchObject({
      kind: 'azure-devops',
      baseUrl: 'https://dev.azure.com/acme',
      urlSafety: {
        allowedSchemes: ['https:'],
      },
    });

    const summary = readProtocolSchema<protocol.ScmPullRequestSummary>('ScmPullRequestSummarySchema').parse({
      provider,
      number: 42,
      providerNativeId: '42',
      title: 'Add PR support',
      url: 'https://dev.azure.com/acme/project/_git/happier/pullrequest/42',
      baseBranch: 'main',
      headBranch: 'feature/scm-pr',
      headRepositoryNameWithOwner: 'acme/happier-fork',
      isCrossRepository: true,
      headSha: 'abc123',
      baseSha: 'def456',
      state: 'draft',
      isDraft: true,
      author: {
        login: 'leeroy',
        displayName: 'Leeroy',
      },
      checks: {
        state: 'pending',
      },
    });

    expect(summary.state).toBe('draft');
    expect(summary.provider.kind).toBe('azure-devops');
    expect(summary.headRepositoryNameWithOwner).toBe('acme/happier-fork');
    expect(summary.isCrossRepository).toBe(true);
  });

  it('accepts numeric URL and head-branch PR references', () => {
    const schema = readProtocolSchema('ScmPullRequestReferenceSchema');

    expect(schema.parse({ number: 42 })).toEqual({ number: 42 });
    expect(schema.parse({ url: 'https://gitlab.example.com/acme/app/-/merge_requests/42' }))
      .toEqual({ url: 'https://gitlab.example.com/acme/app/-/merge_requests/42' });
    expect(schema.parse({ headBranch: 'feature/scm-pr' })).toEqual({ headBranch: 'feature/scm-pr' });
    expect(schema.safeParse('#42').success).toBe(false);
  });

  it('exposes the ratified default branch push policy enum', () => {
    const schema = readProtocolSchema('ScmDefaultBranchPushPolicySchema');

    expect(schema.parse('allow')).toBe('allow');
    expect(schema.parse('requires-feature-branch')).toBe('requires-feature-branch');
    expect(schema.parse('deny')).toBe('deny');
    expect(schema.safeParse('prompt').success).toBe(false);
  });

  it('requires safe passive follow-up URL envelopes', () => {
    const schema = readProtocolSchema('ScmFollowupActionSchema');

    expect(schema.parse({
      kind: 'openUrl',
      purpose: 'pullRequest',
      url: 'https://github.com/happier-dev/happier/pull/42',
      allowedBaseUrl: 'https://github.com',
    })).toEqual({
      kind: 'openUrl',
      purpose: 'pullRequest',
      url: 'https://github.com/happier-dev/happier/pull/42',
      allowedBaseUrl: 'https://github.com',
      // urlSafety is materialized from its `.default({allowedSchemes:['https:']})` per FD-0052 Rule 13:
      // every openUrl follow-up must carry the allowed-schemes contract so the UI can validate
      // before opening, even when the server omits the field for backward compat.
      urlSafety: { allowedSchemes: ['https:'] },
    });
    // Caller-supplied urlSafety is preserved verbatim (e.g. a provider that allows http+https).
    expect(schema.parse({
      kind: 'openUrl',
      purpose: 'pullRequest',
      url: 'https://github.com/happier-dev/happier/pull/42',
      allowedBaseUrl: 'https://github.com',
      urlSafety: { allowedSchemes: ['https:', 'http:'] },
    })).toEqual({
      kind: 'openUrl',
      purpose: 'pullRequest',
      url: 'https://github.com/happier-dev/happier/pull/42',
      allowedBaseUrl: 'https://github.com',
      urlSafety: { allowedSchemes: ['https:', 'http:'] },
    });
    expect(schema.parse({ kind: 'none' })).toEqual({ kind: 'none' });
    expect(schema.safeParse({
      kind: 'openUrl',
      purpose: 'pullRequest',
      url: 'https://github.com/happier-dev/happier/pull/42',
    }).success).toBe(false);
  });

  it('requires runStacked success responses to include a follow-up action', () => {
    const schema = readProtocolSchema<protocol.ScmPullRequestRunStackedResponse>(
      'ScmPullRequestRunStackedResponseSchema',
    );

    expect(schema.safeParse({
      success: true,
      events: [],
    }).success).toBe(false);

    const parsed = schema.parse({
      success: true,
      branch: 'feature/scm-pr',
      commitSha: 'abc123',
      nextAction: { kind: 'none' },
      events: [
        {
          kind: 'phase_started',
          phase: 'push',
          timestamp: 1,
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.nextAction).toEqual({ kind: 'none' });
      expect(parsed.events[0]?.phase).toBe('push');
    }
  });

  it('keeps pull-request request schemas on the existing cwd convention', () => {
    const request = readProtocolSchema<protocol.ScmPullRequestOpenOrReuseRequest>(
      'ScmPullRequestOpenOrReuseRequestSchema',
    ).parse({
      cwd: '/repo',
      base: 'main',
      head: 'feature/scm-pr',
      title: 'Add PR support',
      body: 'Protocol-only body',
    });

    expect(request.cwd).toBe('/repo');
    expect('workingDirectory' in request).toBe(false);
  });

  it('normalizes and validates branch refs across pull-request request schemas', () => {
    const listRequest = readProtocolSchema<protocol.ScmPullRequestListRequest>(
      'ScmPullRequestListRequestSchema',
    ).parse({
      cwd: '/repo',
      base: ' main ',
      head: ' feature/scm-pr ',
    });
    expect(listRequest).toMatchObject({
      base: 'main',
      head: 'feature/scm-pr',
    });

    const composeRequest = readProtocolSchema<protocol.ScmPullRequestOpenComposeRequest>(
      'ScmPullRequestOpenComposeRequestSchema',
    ).parse({
      cwd: '/repo',
      base: ' main ',
      head: ' feature/scm-pr ',
    });
    expect(composeRequest).toMatchObject({
      base: 'main',
      head: 'feature/scm-pr',
    });

    const reuseRequest = readProtocolSchema<protocol.ScmPullRequestOpenOrReuseRequest>(
      'ScmPullRequestOpenOrReuseRequestSchema',
    ).parse({
      cwd: '/repo',
      base: ' main ',
      head: ' feature/scm-pr ',
    });
    expect(reuseRequest).toMatchObject({
      base: 'main',
      head: 'feature/scm-pr',
    });

    const forkReuseRequest = readProtocolSchema<protocol.ScmPullRequestOpenOrReuseRequest>(
      'ScmPullRequestOpenOrReuseRequestSchema',
    ).parse({
      cwd: '/repo',
      base: 'main',
      head: 'feature/scm-pr',
      headRepositoryNameWithOwner: ' acme/fork ',
    });
    expect(forkReuseRequest).toMatchObject({
      headRepositoryNameWithOwner: 'acme/fork',
    });

    const stackedRequest = readProtocolSchema<protocol.ScmPullRequestRunStackedRequest>(
      'ScmPullRequestRunStackedRequestSchema',
    ).parse({
      cwd: '/repo',
      action: 'openOrReuse',
      base: ' main ',
      head: ' feature/scm-pr ',
    });
    expect(stackedRequest).toMatchObject({
      base: 'main',
      head: 'feature/scm-pr',
    });

    const stackedFeatureBranchRequest = readProtocolSchema<protocol.ScmPullRequestRunStackedRequest>(
      'ScmPullRequestRunStackedRequestSchema',
    ).parse({
      cwd: '/repo',
      action: 'commitPushAndOpenOrReuse',
      base: 'main',
      featureBranch: ' feature/scm-pr ',
    });
    expect(stackedFeatureBranchRequest).toMatchObject({
      featureBranch: 'feature/scm-pr',
    });

    expect(readProtocolSchema('ScmPullRequestOpenComposeRequestSchema').safeParse({
      cwd: '/repo',
      base: 'main',
      head: 'feature\n--upload-pack=evil',
    }).success).toBe(false);
    expect(readProtocolSchema('ScmPullRequestOpenOrReuseRequestSchema').safeParse({
      cwd: '/repo',
      base: 'main',
      head: 'feature\n--upload-pack=evil',
    }).success).toBe(false);
    expect(readProtocolSchema('ScmPullRequestRunStackedRequestSchema').safeParse({
      cwd: '/repo',
      action: 'openOrReuse',
      base: 'main',
      head: 'feature\n--upload-pack=evil',
    }).success).toBe(false);
    expect(readProtocolSchema('ScmPullRequestRunStackedRequestSchema').safeParse({
      cwd: '/repo',
      action: 'commitPushAndOpenOrReuse',
      base: 'main',
      featureBranch: 'feature\n--upload-pack=evil',
    }).success).toBe(false);
    for (const filePath of [':', ':(top)*', '.', './', '../src/a.ts']) {
      expect(readProtocolSchema('ScmPullRequestRunStackedRequestSchema').safeParse({
        cwd: '/repo',
        action: 'commitPushAndOpenOrReuse',
        base: 'main',
        featureBranch: 'feature/scm-pr',
        filePaths: [filePath],
      }).success).toBe(false);
    }
    expect(readProtocolSchema('ScmPullRequestGetRequestSchema').safeParse({
      cwd: '/repo',
      prReference: { headBranch: 'feature\n--upload-pack=evil' },
    }).success).toBe(false);
    expect(readProtocolSchema('ScmPullRequestGetRequestSchema').safeParse({
      cwd: '/repo',
      prReference: { number: 7, headBranch: 'feature\n--upload-pack=evil' },
    }).success).toBe(false);
    expect(readProtocolSchema('ScmPullRequestCheckoutRequestSchema').safeParse({
      cwd: '/repo',
      prReference: { headBranch: 'feature\n--upload-pack=evil' },
    }).success).toBe(false);
  });
});
