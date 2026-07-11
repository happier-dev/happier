import { describe, expect, it } from 'vitest';

import { createGitlabScmHostingProviderAdapter, gitlabHostingProviderAdapter } from './adapter.js';
import { PLUGIN_MANIFEST } from './manifest.js';

type DetectionResult = Readonly<{
  id: string;
  kind: string;
  displayName: string;
  baseUrl: string;
  nameWithOwner?: string;
  remoteName?: string | null;
  urlSafety?: Readonly<{
    allowedSchemes: readonly string[];
    allowedBaseUrls: readonly string[];
    allowedOrigins: readonly string[];
  }>;
}>;

type Adapter = Readonly<{
  detectRemote(input: Readonly<{ remoteName: string | null; remoteUrl: string }>): DetectionResult | null;
  buildCompareUrl(input: Readonly<{ provider: DetectionResult; base: string; head: string }>): string | null;
}>;

describe('bundled GitLab SCM hosting provider plugin', () => {
  it('declares a first-party SCM hosting-provider manifest contribution with URL safety metadata', async () => {
    expect(PLUGIN_MANIFEST).toMatchObject({
      id: 'happier.scm.hosting.gitlab',
      source: {
        kind: 'package',
        locator: '@happier-dev/plugins-scm-gitlab',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
      uses: ['scmHostingProviders'],
      contributes: {
        scmHostingProviders: [
          {
            id: 'scm.gitlab',
            kind: 'gitlab',
            displayName: 'GitLab',
            baseUrl: 'https://gitlab.com',
            remoteHostMatchers: {
              exactHosts: ['gitlab.com'],
            },
            urlSafety: {
              allowedSchemes: ['https:'],
              allowedBaseUrls: ['https://gitlab.com'],
              allowedOrigins: ['https://gitlab.com'],
            },
            capabilities: expect.objectContaining({
              compareUrl: true,
              openUrl: true,
              pullRequests: {
                list: true,
                get: true,
                create: true,
                checkout: false,
                prepareWorktree: false,
                runStacked: false,
              },
            }),
          },
        ],
      },
    });
    const [provider] = PLUGIN_MANIFEST.contributes.scmHostingProviders;
    const shippedValues = [
      ...(provider.remoteHostMatchers?.exactHosts ?? []),
      ...(provider.urlSafety?.allowedBaseUrls ?? []),
      ...(provider.urlSafety?.allowedOrigins ?? []),
    ];
    expect(shippedValues).not.toContain('gitlab.company.com');
    expect(shippedValues).not.toContain('code.internal.test');
    expect(shippedValues).not.toContain('https://gitlab.company.com');
    expect(shippedValues).not.toContain('https://code.internal.test');
    for (const value of shippedValues) {
      expect(value).not.toMatch(/(?:^|[.:/])(?:[^/]*\.test|[^/]*\.company\.com)(?:$|[/:])/);
    }
  });

  it('detects bundled GitLab remotes and supports enterprise hosts through test-local options', async () => {
    const adapter = gitlabHostingProviderAdapter as Adapter;
    const enterpriseAdapter = createGitlabScmHostingProviderAdapter({
      exactHosts: ['gitlab.company.com', 'code.internal.test'],
    }) as Adapter;

    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'git@gitlab.com:happier-dev/mobile/app.git',
    })).toMatchObject({
      id: 'scm.gitlab',
      kind: 'gitlab',
      baseUrl: 'https://gitlab.com',
      nameWithOwner: 'happier-dev/mobile/app',
      remoteName: 'origin',
    });
    expect(enterpriseAdapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://gitlab.company.com/platform/happier/app.git',
    })).toMatchObject({
      id: 'scm.gitlab',
      baseUrl: 'https://gitlab.company.com',
      nameWithOwner: 'platform/happier/app',
    });
    expect(enterpriseAdapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'ssh://git@code.internal.test/platform/happier/app.git',
    })).toMatchObject({
      id: 'scm.gitlab',
      baseUrl: 'https://code.internal.test',
      nameWithOwner: 'platform/happier/app',
      urlSafety: {
        allowedSchemes: ['https:'],
        allowedBaseUrls: ['https://code.internal.test'],
        allowedOrigins: ['https://code.internal.test'],
      },
    });
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'ftp://gitlab.com/happier-dev/mobile/app.git',
    })).toBeNull();
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'file:///gitlab.com/happier-dev/mobile/app.git',
    })).toBeNull();
  });

  it('builds encoded GitLab compare URLs without write or CLI behavior', async () => {
    const adapter = gitlabHostingProviderAdapter as Adapter & Record<string, unknown>;
    const enterpriseAdapter = createGitlabScmHostingProviderAdapter({
      exactHosts: ['code.internal.test'],
    }) as Adapter;
    const provider = adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'git@gitlab.com:happier-dev/mobile/app.git',
    });

    expect(provider).not.toBeNull();
    if (!provider) return;

    expect(adapter.buildCompareUrl({
      provider,
      base: 'release/2026',
      head: 'feature/pr-support',
    })).toBe('https://gitlab.com/happier-dev/mobile/app/-/compare/release%2F2026...feature%2Fpr-support');
    expect(enterpriseAdapter.buildCompareUrl({
      provider: {
        ...provider,
        baseUrl: 'https://code.internal.test/gitlab',
        nameWithOwner: 'platform/happier/app',
        repositoryWebUrl: 'https://code.internal.test/gitlab/platform/happier/app',
      },
      base: 'release/2026',
      head: 'feature/pr-support',
    })).toBe('https://code.internal.test/gitlab/platform/happier/app/-/compare/release%2F2026...feature%2Fpr-support');
    expect(adapter.buildCompareUrl({
      provider: {
        ...provider,
        baseUrl: 'https://example.com',
      },
      base: 'main',
      head: 'feature/pr-support',
    })).toBeNull();
    expect(adapter.buildCompareUrl({
      provider: {
        ...provider,
        baseUrl: 'https://gitlab.com:8443',
      },
      base: 'main',
      head: 'feature/pr-support',
    })).toBeNull();
    expect(adapter.buildCompareUrl({
      provider: {
        ...provider,
        nameWithOwner: 'platform/../app',
      },
      base: 'main',
      head: 'feature/pr-support',
    })).toBeNull();
    expect(adapter[`create${'PullRequest'}`]).toEqual(expect.any(Function));
    expect(adapter[`list${'PullRequests'}`]).toEqual(expect.any(Function));
    expect(adapter[`get${'PullRequest'}`]).toEqual(expect.any(Function));
    expect(adapter[`get${'PullRequestAuthProfileKey'}`]).toEqual(expect.any(Function));
  });
});
