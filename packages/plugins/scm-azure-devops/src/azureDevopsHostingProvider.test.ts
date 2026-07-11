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

describe('bundled Azure DevOps SCM hosting provider plugin', () => {
  it('declares a first-party SCM hosting-provider manifest contribution with deferred write capabilities', async () => {
    const mod = await import('./manifest.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.PLUGIN_MANIFEST).toMatchObject({
      id: 'happier.scm.hosting.azure-devops',
      source: {
        kind: 'package',
        locator: '@happier-dev/plugins-scm-azure-devops',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
      uses: ['scmHostingProviders'],
      contributes: {
        scmHostingProviders: [
          {
            id: 'scm.azure-devops',
            kind: 'azure-devops',
            displayName: 'Azure DevOps',
            baseUrl: 'https://dev.azure.com',
            remoteHostMatchers: {
              exactHosts: expect.arrayContaining(['dev.azure.com', 'ssh.dev.azure.com']),
              suffixHosts: expect.arrayContaining(['.visualstudio.com']),
            },
            urlSafety: {
              allowedSchemes: ['https:'],
              allowedBaseUrls: expect.arrayContaining(['https://dev.azure.com']),
              allowedOrigins: expect.arrayContaining(['https://dev.azure.com']),
            },
            capabilities: {
              compareUrl: true,
              openUrl: true,
              pullRequests: {
                list: true,
                get: true,
                create: true,
                runStacked: false,
              },
              repositoryProvisioning: {
                describeTargets: true,
                createRepository: true,
                publish: false,
              },
              reviewThreads: {
                read: false,
                write: false,
              },
            },
          },
        ],
      },
    });
  });

  it('detects current and legacy Azure DevOps remotes with HTTPS URL safety metadata', async () => {
    const mod = await import('./detection/adapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.azureDevopsHostingProviderAdapter as Adapter;

    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://dev.azure.com/happier-dev/platform/_git/happier.git',
    })).toMatchObject({
      id: 'scm.azure-devops',
      kind: 'azure-devops',
      baseUrl: 'https://dev.azure.com/happier-dev',
      nameWithOwner: 'happier-dev/platform/happier',
      remoteName: 'origin',
      urlSafety: {
        allowedSchemes: ['https:'],
        allowedBaseUrls: ['https://dev.azure.com/happier-dev'],
        allowedOrigins: ['https://dev.azure.com'],
      },
    });
    expect(adapter.detectRemote({
      remoteName: 'upstream',
      remoteUrl: 'git@ssh.dev.azure.com:v3/happier-dev/platform/happier',
    })).toMatchObject({
      id: 'scm.azure-devops',
      baseUrl: 'https://dev.azure.com/happier-dev',
      nameWithOwner: 'happier-dev/platform/happier',
      remoteName: 'upstream',
    });
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'ssh://git@ssh.dev.azure.com/v3/happier-dev/platform/happier',
    })).toMatchObject({
      id: 'scm.azure-devops',
      baseUrl: 'https://dev.azure.com/happier-dev',
      nameWithOwner: 'happier-dev/platform/happier',
      remoteName: 'origin',
    });
    expect(adapter.detectRemote({
      remoteName: 'legacy',
      remoteUrl: 'git@happier-dev.visualstudio.com:v3/happier-dev/platform/happier',
    })).toMatchObject({
      id: 'scm.azure-devops',
      baseUrl: 'https://happier-dev.visualstudio.com',
      nameWithOwner: 'happier-dev/platform/happier',
      remoteName: 'legacy',
    });
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://happier-dev.visualstudio.com/platform/_git/happier',
    })).toMatchObject({
      id: 'scm.azure-devops',
      baseUrl: 'https://happier-dev.visualstudio.com',
      nameWithOwner: 'happier-dev/platform/happier',
      urlSafety: {
        allowedSchemes: ['https:'],
        allowedBaseUrls: ['https://happier-dev.visualstudio.com'],
        allowedOrigins: ['https://happier-dev.visualstudio.com'],
      },
    });
  });

  it('builds encoded compare URLs and treats malformed Azure-like remotes as unknown', async () => {
    const mod = await import('./detection/adapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.azureDevopsHostingProviderAdapter as Adapter & Record<string, unknown>;
    const provider = adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://dev.azure.com/happier-dev/platform/_git/happier.git',
    });

    expect(provider).not.toBeNull();
    if (!provider) return;

    expect(adapter.buildCompareUrl({
      provider,
      base: 'release/2026',
      head: 'feature/pr support',
    })).toBe('https://dev.azure.com/happier-dev/platform/_git/happier/branchCompare?baseVersion=GBrelease%2F2026&targetVersion=GBfeature%2Fpr%20support');
    expect(adapter.buildCompareUrl({
      provider: {
        ...provider,
        baseUrl: 'https://evil.example.com/happier-dev',
      },
      base: 'release/2026',
      head: 'feature/pr support',
    })).toBeNull();
    expect(adapter.buildCompareUrl({
      provider: {
        ...provider,
        baseUrl: 'http://dev.azure.com/happier-dev',
      },
      base: 'release/2026',
      head: 'feature/pr support',
    })).toBeNull();
    expect(adapter.buildCompareUrl({
      provider: {
        ...provider,
        baseUrl: 'https://dev.azure.com:8443/happier-dev',
      },
      base: 'release/2026',
      head: 'feature/pr support',
    })).toBeNull();
    expect(adapter.buildCompareUrl({
      provider: {
        ...provider,
        nameWithOwner: 'happier-dev/../happier',
      },
      base: 'release/2026',
      head: 'feature/pr support',
    })).toBeNull();
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://dev.azure.com/happier-dev/_git/happier.git',
    })).toBeNull();
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'ftp://dev.azure.com/happier-dev/platform/_git/happier.git',
    })).toBeNull();
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'ssh://git@dev.azure.com/happier-dev/platform/_git/happier.git',
    })).toBeNull();
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://ssh.dev.azure.com/v3/happier-dev/platform/happier',
    })).toBeNull();
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'git@dev.azure.com:happier-dev/platform/_git/happier.git',
    })).toBeNull();
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://not-dev.azure.com/happier-dev/platform/_git/happier.git',
    })).toBeNull();
    for (const remoteUrl of [
      'https://dev.azure.com:8443/happier-dev/platform/_git/happier.git',
      'https://dev.azure.com/happier-dev/platform/_git/happier.git?preview=1',
      'https://dev.azure.com/happier-dev/platform/_git/happier.git#refs',
      'https://user:token@dev.azure.com/happier-dev/platform/_git/happier.git',
      'ssh://git@ssh.dev.azure.com:2222/v3/happier-dev/platform/happier',
    ]) {
      expect(adapter.detectRemote({
        remoteName: 'origin',
        remoteUrl,
      })).toBeNull();
    }
    expect(adapter[`create${'PullRequest'}`]).toBeUndefined();
    expect(adapter[`create${'Repository'}`]).toBeUndefined();
  });
});
