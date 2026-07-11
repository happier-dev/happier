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

describe('bundled GitHub SCM hosting provider plugin', () => {
  it('declares a first-party SCM hosting-provider manifest contribution with URL safety metadata', async () => {
    const mod = await import('./manifest.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.PLUGIN_MANIFEST).toMatchObject({
      id: 'happier.scm.hosting.github',
      source: {
        kind: 'package',
        locator: '@happier-dev/plugins-scm-github',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
      uses: ['scmHostingProviders', 'connectedAccountDescriptors'],
      contributes: {
        scmHostingProviders: [
          {
            id: 'scm.github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.com',
            remoteHostMatchers: {
              exactHosts: ['github.com'],
            },
            urlSafety: {
              allowedSchemes: ['https:'],
              allowedBaseUrls: ['https://github.com'],
              allowedOrigins: ['https://github.com'],
            },
            capabilities: expect.objectContaining({
              compareUrl: true,
              openUrl: true,
              repositoryProvisioning: {
                describeTargets: true,
                createRepository: true,
                publish: false,
              },
            }),
          },
        ],
        connectedAccountDescriptors: [
          expect.objectContaining({
            id: 'github',
            materialization: expect.objectContaining({
              materializationKinds: expect.arrayContaining(['scm_hosting_token']),
              hookKey: 'connectedServices.materialization.githubScmHostingToken',
            }),
          }),
        ],
      },
    });
    expect(mod.PLUGIN_MANIFEST.contributes).not.toHaveProperty('hooks');
    const [provider] = mod.PLUGIN_MANIFEST.contributes.scmHostingProviders;
    const shippedValues = [
      ...(provider.remoteHostMatchers?.exactHosts ?? []),
      ...(provider.urlSafety?.allowedBaseUrls ?? []),
      ...(provider.urlSafety?.allowedOrigins ?? []),
    ];
    expect(shippedValues).not.toContain('github.company.com');
    expect(shippedValues).not.toContain('ghe.internal.test');
    expect(shippedValues).not.toContain('https://github.company.com');
    expect(shippedValues).not.toContain('https://ghe.internal.test');
    for (const value of shippedValues) {
      expect(value).not.toMatch(/(?:^|[.:/])(?:[^/]*\.test|[^/]*\.company\.com)(?:$|[/:])/);
    }
  }, 30_000);

  it('registers the manifest-declared GitHub adapter during activation', async () => {
    const mod = await import('./activate.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const registered: unknown[] = [];
    const hooks: unknown[] = [];
    mod.activate({
      registerScmHostingProvider(registration: unknown) {
        registered.push(registration);
        return () => undefined;
      },
      registerHook(registration: unknown) {
        hooks.push(registration);
        return () => undefined;
      },
    });

    expect(registered).toEqual([
      expect.objectContaining({
        id: 'scm.github',
        auth: {
          tokenMaterializer: expect.objectContaining({
            serviceId: 'github',
            materialize: expect.any(Function),
          }),
        },
        adapter: expect.objectContaining({
          detectRemote: expect.any(Function),
          buildCompareUrl: expect.any(Function),
          listPullRequests: expect.any(Function),
          getPullRequest: expect.any(Function),
          createPullRequest: expect.any(Function),
          getDefaultBranch: expect.any(Function),
          resolvePullRequestCheckoutReference: expect.any(Function),
          describePublishTargets: expect.any(Function),
          describeCloneTargets: expect.any(Function),
          createRepository: expect.any(Function),
          getRepository: expect.any(Function),
        }),
      }),
    ]);
    expect(hooks).toEqual([]);
  });

  it('registered repository hooks consume operation-scoped runtime services', async () => {
    const mod = await import('./activate.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const registered: Array<Readonly<{ adapter: Readonly<Record<string, unknown>> }>> = [];
    mod.activate({
      registerScmHostingProvider(registration: Readonly<{ adapter: Readonly<Record<string, unknown>> }>) {
        registered.push(registration);
        return () => undefined;
      },
      registerHook() {
        return () => undefined;
      },
    });

    const describePublishTargets = registered[0]?.adapter.describePublishTargets;
    expect(describePublishTargets).toEqual(expect.any(Function));
    if (typeof describePublishTargets !== 'function') return;

    await expect(describePublishTargets({
      provider: {
        id: 'scm.github',
        kind: 'github',
        displayName: 'GitHub',
        baseUrl: 'https://github.com',
        urlSafety: { allowedSchemes: ['https:'] },
      },
      defaultRepositoryName: 'happier',
      runtimeServices: {
        resolveScmHostingTokenMaterialization: async () => ({
          kind: 'missing',
          reason: 'credential_unavailable',
        }),
        resolveInstallableCommand: async () => ({
          kind: 'available',
          source: 'managed',
          binPath: '/managed/gh/current/bin/gh',
        }),
        runCommand: async (request: Readonly<{ args: readonly string[] }>) => {
          if (request.args[0] === 'auth') {
            return { ok: true, stdout: '', stderr: '', exitCode: 0 };
          }
          if (request.args.join(' ') === 'api user --hostname github.com') {
            return { ok: true, stdout: JSON.stringify({ login: 'octocat' }), stderr: '', exitCode: 0 };
          }
          return { ok: true, stdout: '[]', stderr: '', exitCode: 0 };
        },
      },
    })).resolves.toMatchObject({
      auth: { state: 'authenticated', profileKind: 'provider_cli' },
      targets: [
        expect.objectContaining({ owner: 'octocat' }),
      ],
    });
  });

  it('detects bundled GitHub remotes and supports enterprise hosts through test-local options', async () => {
    const mod = await import('./adapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.githubHostingProviderAdapter as Adapter;
    const enterpriseAdapter = mod.createGithubScmHostingProviderAdapter({
      exactHosts: ['github.company.com', 'ghe.internal.test'],
    }) as Adapter;

    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://github.com/happier-dev/happier.git',
    })).toMatchObject({
      id: 'scm.github',
      kind: 'github',
      baseUrl: 'https://github.com',
      nameWithOwner: 'happier-dev/happier',
      remoteName: 'origin',
    });
    expect(adapter.detectRemote({
      remoteName: 'upstream',
      remoteUrl: 'git@github.com:happier-dev/happier.git',
    })).toMatchObject({
      id: 'scm.github',
      nameWithOwner: 'happier-dev/happier',
      remoteName: 'upstream',
    });
    expect(enterpriseAdapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'ssh://git@github.company.com/happier-dev/happier.git',
    })).toMatchObject({
      id: 'scm.github',
      baseUrl: 'https://github.company.com',
      nameWithOwner: 'happier-dev/happier',
    });
    expect(enterpriseAdapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'ssh://git@ghe.internal.test/happier-dev/happier.git',
    })).toMatchObject({
      id: 'scm.github',
      baseUrl: 'https://ghe.internal.test',
      nameWithOwner: 'happier-dev/happier',
      urlSafety: {
        allowedSchemes: ['https:'],
        allowedBaseUrls: ['https://ghe.internal.test'],
        allowedOrigins: ['https://ghe.internal.test'],
      },
    });
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'ftp://github.com/happier-dev/happier.git',
    })).toBeNull();
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'file:///github.com/happier-dev/happier.git',
    })).toBeNull();
  });

  it('builds encoded GitHub compare URLs and rejects unknown provider projections', async () => {
    const mod = await import('./adapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.githubHostingProviderAdapter as Adapter;
    const provider = adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://github.com/happier-dev/happier.git',
    });

    expect(provider).not.toBeNull();
    if (!provider) return;

    expect(adapter.buildCompareUrl({
      provider,
      base: 'release/2026',
      head: 'space branch',
    })).toBe('https://github.com/happier-dev/happier/compare/release%2F2026...space%20branch');
    expect(adapter.buildCompareUrl({
      provider: {
        id: 'unknown',
        kind: 'unknown',
        displayName: 'Unknown',
        baseUrl: 'https://example.com',
      },
      base: 'main',
      head: 'feature/pr-support',
    })).toBeNull();
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
        baseUrl: 'https://github.com:8443',
      },
      base: 'main',
      head: 'feature/pr-support',
    })).toBeNull();
    expect(adapter.buildCompareUrl({
      provider: {
        ...provider,
        nameWithOwner: 'happier-dev/../happier',
      },
      base: 'main',
      head: 'feature/pr-support',
    })).toBeNull();
  });
});
