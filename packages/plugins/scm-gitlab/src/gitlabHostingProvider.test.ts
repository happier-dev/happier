import { describe, expect, it } from 'vitest';

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
    const mod = await import('./manifest.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.PLUGIN_MANIFEST).toMatchObject({
      id: 'scm-gitlab',
      source: {
        kind: 'package',
        locator: '@happier-dev/plugins-scm-gitlab',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
      runtime: {
        apiVersion: 1,
        capabilities: ['scmHostingProviders'],
      },
      contributes: {
        scmHostingProviders: [
          {
            id: 'scm.gitlab',
            kind: 'gitlab',
            displayName: 'GitLab',
            baseUrl: 'https://gitlab.com',
            remoteHostMatchers: {
              exactHosts: expect.arrayContaining(['gitlab.com', 'gitlab.company.com', 'code.internal.test']),
            },
            urlSafety: {
              allowedSchemes: ['https:'],
              allowedBaseUrls: expect.arrayContaining([
                'https://gitlab.com',
                'https://gitlab.company.com',
                'https://code.internal.test',
              ]),
              allowedOrigins: expect.arrayContaining([
                'https://gitlab.com',
                'https://gitlab.company.com',
                'https://code.internal.test',
              ]),
            },
            capabilities: expect.objectContaining({
              compareUrl: true,
              openUrl: true,
            }),
          },
        ],
      },
    });
  });

  it('detects GitLab remotes and preserves multi-segment group paths', async () => {
    const mod = await import('./adapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.gitlabHostingProviderAdapter as Adapter;

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
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://gitlab.company.com/platform/happier/app.git',
    })).toMatchObject({
      id: 'scm.gitlab',
      baseUrl: 'https://gitlab.company.com',
      nameWithOwner: 'platform/happier/app',
    });
    expect(adapter.detectRemote({
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
    const mod = await import('./adapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.gitlabHostingProviderAdapter as Adapter & Record<string, unknown>;
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
    expect(adapter[`create${'PullRequest'}`]).toBeUndefined();
    expect(adapter[`listOpen${'PullRequests'}`]).toBeUndefined();
  });
});
