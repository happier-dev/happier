import { describe, expect, it } from 'vitest';
import { ingestPluginManifestV2 } from '@happier-dev/protocol';

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
  it('declares a strict target SCM hosting-provider contribution with configured-origin access', async () => {
    const mod = await import('./manifest.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.PLUGIN_MANIFEST).toMatchObject({
      id: 'happier.scm.forge.github',
      entrypoints: { daemon: './.happier-plugin/daemon.js' },
      hostAccess: {
        required: expect.arrayContaining([expect.objectContaining({
          id: 'github-api',
          capability: 'network',
          scope: expect.objectContaining({
            targets: expect.arrayContaining([{ kind: 'scmProviderOrigin', provider: 'github' }]),
            // Still an EXACT set, deliberately: widening this grant is a real
            // capability change and must stay visible here. PUT, PATCH and DELETE
            // were added for the approved pull-request mutations — PUT for merge
            // and update-branch, PATCH for close/reopen, DELETE for the reviewer
            // withdrawal, which is the only declared Action that sends it. No verb
            // is present that no declared write consumes.
            methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
          }),
        })]),
        optional: [],
      },
      contributes: {
        ui: {
          // Contribution local IDs share one plugin-wide namespace, so the
          // Settings identity cannot reuse the SCM provider's `github` id.
          settingsGroups: [{ id: 'github-triage' }],
          settingsPages: [expect.objectContaining({
            group: { kind: 'plugin', localId: 'github-triage' },
          })],
        },
        scmHostingProviders: [
          {
            id: 'github',
            kind: 'github',
            title: 'GitHub',
            capabilities: expect.arrayContaining(['detect', 'pullRequest']),
            authService: 'github-account',
          },
        ],
        connectedAccountDescriptors: [
          expect.objectContaining({
            id: 'github-account',
            authentication: {
              defaultModeId: 'fine-grained-pat',
              modes: [expect.objectContaining({
                id: 'fine-grained-pat',
                kind: 'manual',
                outcomeReconciliation: 'none',
                fields: [expect.objectContaining({ id: 'token', secret: true })],
              })],
            },
          }),
        ],
      },
    });
    expect(mod.PLUGIN_MANIFEST).not.toHaveProperty('source');
    expect(mod.PLUGIN_MANIFEST).not.toHaveProperty('uses');
    expect(mod.PLUGIN_MANIFEST).not.toHaveProperty('permissions');
    expect(mod.PLUGIN_MANIFEST).not.toHaveProperty('activationEvents');
    expect(mod.PLUGIN_MANIFEST.entrypoints).not.toHaveProperty('main');
    expect(ingestPluginManifestV2(mod.PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    // This direct cold manifest retains author-declared shape. Canonical host
    // ingestion later normalizes an undeclared hooks family to an empty array.
    expect(mod.PLUGIN_MANIFEST.contributes).not.toHaveProperty('hooks');
    expect(mod.PLUGIN_MANIFEST.contributes.hooks).toBeUndefined();
  }, 30_000);

  it('rejects dangling auth refs and wildcard SCM access', async () => {
    const { PLUGIN_MANIFEST } = await import('./manifest.js');
    expect(ingestPluginManifestV2({
      ...PLUGIN_MANIFEST,
      contributes: { ...PLUGIN_MANIFEST.contributes, scmHostingProviders: [{ ...(PLUGIN_MANIFEST.contributes.scmHostingProviders ?? [])[0], authService: 'missing' }] },
    })).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: 'plugin_manifest_dangling_reference' })] });
    expect(ingestPluginManifestV2({
      ...PLUGIN_MANIFEST,
      contributes: { ...PLUGIN_MANIFEST.contributes, scmHostingProviders: [{ ...(PLUGIN_MANIFEST.contributes.scmHostingProviders ?? [])[0], authService: 'github' }] },
    })).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: 'plugin_manifest_wrong_family_reference' })] });
    expect(ingestPluginManifestV2({
      ...PLUGIN_MANIFEST,
      hostAccess: { required: [{ id: 'bad', capability: 'network', reason: 'Bad', scope: { targets: [{ kind: 'fixedOrigin', origin: '*' }] } }], optional: [] },
    })).toMatchObject({ ok: false });
  }, 30_000);

  it('registers the manifest-declared GitHub adapter during activation', async () => {
    const mod = await import('./activate.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const registered: unknown[] = [];
    const hooks: unknown[] = [];
    // Boundary fixture intentionally supplies only the activation surface exercised here.
    const cleanup = await mod.activate({
      actions: { register() {} },
      backgroundServices: { register() {} },
      scm: {
        registerHostingProvider(id: string, runtime: Readonly<Record<string, unknown>>) {
          registered.push({ id, ...runtime });
          return { dispose() {} };
        },
      },
      hooks: {
        register(id: string, handler: unknown) {
          hooks.push({ id, handler });
          return { dispose() {} };
        },
      },
      connectedAccounts: {
        register() {
          return { dispose() {} };
        },
      },
    } as unknown as Parameters<typeof mod.activate>[0]);

    try {
      expect(registered).toEqual([
        expect.objectContaining({
          id: 'github',
          adapter: expect.objectContaining({
            routing: expect.objectContaining({
              detectRemote: expect.any(Function),
              buildCompareUrl: expect.any(Function),
            }),
            pullRequests: expect.objectContaining({
              listPullRequests: expect.any(Function),
              getPullRequest: expect.any(Function),
              createPullRequest: expect.any(Function),
            }),
            pullRequestCheckout: expect.objectContaining({
              resolvePullRequestCheckoutReference: expect.any(Function),
            }),
            repositoryPublishing: expect.objectContaining({
              describePublishTargets: expect.any(Function),
              createRepository: expect.any(Function),
              getRepository: expect.any(Function),
            }),
            repositoryClone: expect.objectContaining({
              describeCloneTargets: expect.any(Function),
            }),
          }),
        }),
      ]);
      expect(registered[0]).not.toHaveProperty('auth');
      expect(registered.map((registration) => (registration as Readonly<{ id: string }>).id))
        .toEqual(((await import('./manifest.js')).PLUGIN_MANIFEST.contributes.scmHostingProviders ?? []).map(({ id }) => id));
      expect(hooks).toEqual([]);
    } finally {
      if (typeof cleanup === 'function') await cleanup();
    }
  });

  it('discovers publish targets without ambient CLI credentials when no bound account materializes', async () => {
    const mod = await import('./activate.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const registered: Array<Readonly<{ id: string; adapter: Readonly<Record<string, unknown>> }>> = [];
    // Boundary fixture intentionally supplies only the activation surface exercised here.
    const cleanup = await mod.activate({
      actions: { register() {} },
      backgroundServices: { register() {} },
      scm: {
        registerHostingProvider(
          id: string,
          runtime: Readonly<{ adapter: Readonly<Record<string, unknown>> }>,
        ) {
          registered.push({ id, ...runtime });
          return { dispose() {} };
        },
      },
      connectedAccounts: {
        register() {
          return { dispose() {} };
        },
      },
    } as unknown as Parameters<typeof mod.activate>[0]);

    try {
      const executedCommands: string[] = [];
      const describePublishTargets = (
        registered[0]?.adapter.repositoryPublishing as Readonly<Record<string, unknown>> | undefined
      )?.describePublishTargets;
      expect(describePublishTargets).toEqual(expect.any(Function));
      if (typeof describePublishTargets !== 'function') return;

      await expect(describePublishTargets({
        provider: {
          id: 'happier.scm.forge.github/github',
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
          // The bound Connected Account is the only authenticated authority: a
          // machine-local `gh` must never be reached, so any invocation fails here.
          executeCommand: async (request: Readonly<{ args: readonly string[] }>) => {
            executedCommands.push(request.args.join(' '));
            return { ok: true, stdout: '', stderr: '', exitCode: 0 };
          },
        },
      })).resolves.toMatchObject({
        auth: { state: 'authentication_required', profileKind: 'no_auth' },
        targets: [],
      });
      expect(executedCommands).toEqual([]);
    } finally {
      if (typeof cleanup === 'function') await cleanup();
    }
  });

  it('detects bundled GitHub remotes and supports enterprise hosts through test-local options', async () => {
    const mod = await import('./adapter.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const adapter = mod.githubHostingProviderAdapter as unknown as Adapter;
    const enterpriseAdapter = mod.createGithubScmHostingProviderAdapter({
      exactHosts: ['github.company.com', 'ghe.internal.test'],
    }) as unknown as Adapter;

    expect(adapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://github.com/happier-dev/happier.git',
    })).toMatchObject({
      id: 'happier.scm.forge.github/github',
      kind: 'github',
      baseUrl: 'https://github.com',
      nameWithOwner: 'happier-dev/happier',
      remoteName: 'origin',
    });
    expect(adapter.detectRemote({
      remoteName: 'upstream',
      remoteUrl: 'git@github.com:happier-dev/happier.git',
    })).toMatchObject({
      id: 'happier.scm.forge.github/github',
      nameWithOwner: 'happier-dev/happier',
      remoteName: 'upstream',
    });
    expect(enterpriseAdapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'ssh://git@github.company.com/happier-dev/happier.git',
    })).toMatchObject({
      id: 'happier.scm.forge.github/github',
      baseUrl: 'https://github.company.com',
      nameWithOwner: 'happier-dev/happier',
    });
    expect(enterpriseAdapter.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'ssh://git@ghe.internal.test/happier-dev/happier.git',
    })).toMatchObject({
      id: 'happier.scm.forge.github/github',
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

    const adapter = mod.githubHostingProviderAdapter as unknown as Adapter;
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
