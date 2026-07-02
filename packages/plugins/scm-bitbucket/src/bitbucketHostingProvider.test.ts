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
  listPullRequests?: unknown;
  getPullRequest?: unknown;
  createPullRequest?: unknown;
  resolvePullRequestCheckoutReference?: unknown;
  describePublishTargets?: unknown;
  createRepository?: unknown;
  getRepository?: unknown;
}>;

describe('bundled Bitbucket SCM hosting provider plugin', () => {
  it('declares a first-party SCM hosting-provider manifest contribution with URL safety metadata', async () => {
    const mod = await import('./manifest.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.PLUGIN_MANIFEST).toMatchObject({
      id: 'happier.scm.hosting.bitbucket',
      source: {
        kind: 'package',
        locator: '@happier-dev/plugins-scm-bitbucket',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
      runtime: {
        apiVersion: 1,
        capabilities: ['scmHostingProviders', 'connectedAccountDescriptors'],
      },
      contributes: {
        scmHostingProviders: [
          {
            id: 'scm.bitbucket',
            kind: 'bitbucket',
            displayName: 'Bitbucket',
            baseUrl: 'https://bitbucket.org',
            remoteHostMatchers: {
              exactHosts: ['bitbucket.org'],
            },
            urlSafety: {
              allowedSchemes: ['https:'],
              allowedBaseUrls: ['https://bitbucket.org'],
              allowedOrigins: ['https://bitbucket.org'],
            },
            capabilities: expect.objectContaining({
              compareUrl: true,
              openUrl: true,
              pullRequests: {
                list: true,
                get: true,
                create: true,
                checkout: true,
                prepareWorktree: false,
                runStacked: false,
              },
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
            id: 'bitbucket',
            kind: 'auth.connectedAccount',
            tokenSetup: expect.objectContaining({
              tokenKind: 'api-token',
              credentialPayloadKind: 'bitbucket_basic_auth',
              identity: expect.objectContaining({
                kind: 'email_or_username',
              }),
            }),
            materialization: expect.objectContaining({
              materializationKinds: ['scm_hosting_basic_auth'],
            }),
          }),
        ],
      },
    });
    expect(mod.PLUGIN_MANIFEST.contributes).not.toHaveProperty('hooks');
  });

  it('detects only Bitbucket Cloud remotes with owner and repository path segments', async () => {
    const mod = await import('./adapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.bitbucketHostingProviderAdapter as Adapter;

    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://bitbucket.org/happier-dev/happier.git',
    })).toMatchObject({
      id: 'scm.bitbucket',
      kind: 'bitbucket',
      baseUrl: 'https://bitbucket.org',
      nameWithOwner: 'happier-dev/happier',
      remoteName: 'origin',
      urlSafety: {
        allowedSchemes: ['https:'],
        allowedBaseUrls: ['https://bitbucket.org'],
        allowedOrigins: ['https://bitbucket.org'],
      },
    });
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://bitbucket.org/workspace/project/repository.git',
    })).toBeNull();
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'ftp://bitbucket.org/happier-dev/happier.git',
    })).toBeNull();
    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'file:///bitbucket.org/happier-dev/happier.git',
    })).toBeNull();
  });

  it('builds encoded Bitbucket compare URLs and registers operation behavior at activation', async () => {
    const mod = await import('./adapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.bitbucketHostingProviderAdapter as Adapter & Record<string, unknown>;
    const provider = adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'git@bitbucket.org:happier-dev/happier.git',
    });

    expect(provider).not.toBeNull();
    if (!provider) return;

    expect(adapter.buildCompareUrl({
      provider,
      base: 'release/2026',
      head: 'space branch',
    })).toBe('https://bitbucket.org/happier-dev/happier/branch/space%20branch?dest=release%2F2026');
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
        baseUrl: 'https://bitbucket.org:8443',
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

  it('registers the Bitbucket API operations adapter during plugin activation', async () => {
    const mod = await import('./activate.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const registrations: Array<Readonly<{ id: string; adapter: Adapter }>> = [];
    const hooks: Array<Readonly<{ hookId: string; handler: unknown }>> = [];
    mod.activate({
      registerScmHostingProvider(registration: Readonly<{ id: string; adapter: Adapter }>) {
        registrations.push(registration);
        return { dispose() {} };
      },
      registerHook(registration: Readonly<{ hookId: string; handler: unknown }>) {
        hooks.push(registration);
        return { dispose() {} };
      },
    });

    expect(registrations).toHaveLength(1);
    expect(hooks).toEqual([]);
    expect(registrations[0]?.id).toBe('scm.bitbucket');
    expect(registrations[0]).toMatchObject({
      auth: {
        basicAuthMaterializer: {
          serviceId: 'bitbucket',
          materialize: expect.any(Function),
        },
      },
    });
    expect(registrations[0]?.adapter).toMatchObject({
      detectRemote: expect.any(Function),
      buildCompareUrl: expect.any(Function),
      listPullRequests: expect.any(Function),
      getPullRequest: expect.any(Function),
      createPullRequest: expect.any(Function),
      resolvePullRequestCheckoutReference: expect.any(Function),
      describePublishTargets: expect.any(Function),
      createRepository: expect.any(Function),
      getRepository: expect.any(Function),
    });
  });
});
