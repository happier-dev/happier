import { describe, expect, it, vi } from 'vitest';

import {
  PluginConnectedAccountDescriptorContributionV2Schema,
  type ScmHostingProviderRef,
} from '@happier-dev/protocol';
import {
  BITBUCKET_SCM_HOSTING_PROVIDER_ID,
  PLUGIN_MANIFEST as BITBUCKET_PLUGIN_MANIFEST,
  bitbucketApiAdapter,
} from '@happier-dev/plugins-scm-bitbucket';
import {
  GITHUB_SCM_HOSTING_PROVIDER_ID,
  PLUGIN_MANIFEST as GITHUB_PLUGIN_MANIFEST,
  githubPullRequestAdapter,
} from '@happier-dev/plugins-scm-github';

import { runWithHostingProviderExecutionAuthority } from './executionAuthority';
import { createHostScmHostingProviderRuntimeServices } from './runtimeServices';

type RuntimeServicesInput = Parameters<typeof createHostScmHostingProviderRuntimeServices>[0];

function createRuntimeInput(): RuntimeServicesInput {
  return {
    contributes: {
      scmHostingProviders: [{
        id: 'github',
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: GITHUB_PLUGIN_MANIFEST.id,
        definition: GITHUB_PLUGIN_MANIFEST.contributes.scmHostingProviders[0]!,
      }],
      connectedAccountDescriptors: [{
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: GITHUB_PLUGIN_MANIFEST.id,
        definition: PluginConnectedAccountDescriptorContributionV2Schema.parse(
          GITHUB_PLUGIN_MANIFEST.contributes.connectedAccountDescriptors[0],
        ),
      }],
    },
    scmHostingProvidersById: new Map([[
      GITHUB_SCM_HOSTING_PROVIDER_ID,
      {
        pluginId: GITHUB_PLUGIN_MANIFEST.id,
        generation: 'test-generation',
        registration: {
          id: 'github',
          adapter: {},
        },
      },
    ]]),
  };
}

const githubProvider = {
  id: GITHUB_SCM_HOSTING_PROVIDER_ID,
  kind: 'github',
  displayName: 'GitHub',
  baseUrl: 'https://github.com',
  nameWithOwner: 'happier-dev/happier',
  urlSafety: { allowedSchemes: ['https:'] },
} satisfies ScmHostingProviderRef;

function runAsHostingProvider<T>(
  pluginId: string,
  contributionId: string,
  callback: () => T,
): T {
  return runWithHostingProviderExecutionAuthority({
    pluginId,
    contributionId,
    generation: 'test-generation',
  }, callback);
}

describe('createHostScmHostingProviderRuntimeServices', () => {
  it('does not expose connected-account credentials outside a provider-qualified invocation', async () => {
    const materialize = vi.fn(async () => ({
      kind: 'httpHeaders' as const,
      headers: { Authorization: 'Bearer ghp_cross_plugin' },
    }));
    const services = createHostScmHostingProviderRuntimeServices({
      ...createRuntimeInput(),
      resolveConnectedAccountPurposeBindingOwner: () => ({ materialize }),
    });

    await expect(services.resolveScmHostingTokenMaterialization?.({
      kind: 'scm_hosting_token',
      providerId: GITHUB_SCM_HOSTING_PROVIDER_ID,
      host: 'github.com',
      provider: githubProvider,
    })).rejects.toThrow('provider-qualified');
    expect(materialize).not.toHaveBeenCalled();
  });

  it('materializes SCM authentication through the canonical durable purpose binding', async () => {
    const service = {
      pluginId: GITHUB_PLUGIN_MANIFEST.id,
      localId: 'github-account',
    } as const;
    const materialize = vi.fn(async () => ({
      kind: 'httpHeaders' as const,
      headers: { Authorization: 'Bearer ghp_exact' },
    }));

    const baseInput = createRuntimeInput();
    const services = createHostScmHostingProviderRuntimeServices({
      ...baseInput,
      resolveConnectedAccountPurposeBindingOwner: () => ({ materialize }),
    });

    await expect(runAsHostingProvider(
      GITHUB_PLUGIN_MANIFEST.id,
      'github',
      () => services.resolveScmHostingTokenMaterialization?.({
        kind: 'scm_hosting_token',
        providerId: GITHUB_SCM_HOSTING_PROVIDER_ID,
        host: 'github.com',
        provider: githubProvider,
      }),
    )).resolves.toEqual({
      kind: 'available',
      token: 'ghp_exact',
    });
    expect(materialize).toHaveBeenCalledWith({
      purpose: {
        consumer: {
          pluginId: GITHUB_PLUGIN_MANIFEST.id,
          localId: 'github',
        },
        purpose: 'authentication',
      },
      serviceRefs: [service],
      request: {
        kind: 'httpHeaders',
        origin: 'https://github.com',
        headerNames: ['Authorization'],
      },
      signal: expect.any(AbortSignal),
    });
  });

  it('does not let an explicit profile bypass the canonical SCM purpose binding', async () => {
    const materialize = vi.fn(async () => ({
      kind: 'httpHeaders' as const,
      headers: { Authorization: 'Bearer ghp_wrong_account' },
    }));
    const services = createHostScmHostingProviderRuntimeServices({
      ...createRuntimeInput(),
      resolveConnectedAccountPurposeBindingOwner: () => ({ materialize }),
    });

    await expect(runAsHostingProvider(
      GITHUB_PLUGIN_MANIFEST.id,
      'github',
      () => services.resolveScmHostingTokenMaterialization?.({
        kind: 'scm_hosting_token',
        providerId: GITHUB_SCM_HOSTING_PROVIDER_ID,
        host: 'github.com',
        provider: githubProvider,
        profileId: 'first-by-server-order',
      }),
    )).resolves.toEqual({
      kind: 'missing',
      reason: 'credential_unavailable',
    });
    expect(materialize).not.toHaveBeenCalled();
  });

  it('rejects hosting authentication before credential effects when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const services = createHostScmHostingProviderRuntimeServices(createRuntimeInput());

    await expect(runAsHostingProvider(
      GITHUB_PLUGIN_MANIFEST.id,
      'github',
      () => services.resolveScmHostingTokenMaterialization?.({
        kind: 'scm_hosting_token',
        providerId: GITHUB_SCM_HOSTING_PROVIDER_ID,
        host: 'github.com',
        provider: githubProvider,
      }, { signal: controller.signal }),
    )).rejects.toThrow('aborted');
  });

  it('rejects authentication when its qualified provider generation retires during an await', async () => {
    let releaseMaterialize!: () => void;
    const materializePending = new Promise<void>((resolve) => {
      releaseMaterialize = resolve;
    });
    const materialize = vi.fn(async () => {
      await materializePending;
      return {
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer ghp_exact' },
      };
    });
    const registrations: RuntimeServicesInput['scmHostingProvidersById'] extends ReadonlyMap<string, infer T>
      ? Map<string, T>
      : never = new Map();
    const baseInput = createRuntimeInput();
    const baseRegistration = baseInput.scmHostingProvidersById.get(
      GITHUB_SCM_HOSTING_PROVIDER_ID,
    )!;
    let services!: ReturnType<typeof createHostScmHostingProviderRuntimeServices>;
    registrations.set(GITHUB_SCM_HOSTING_PROVIDER_ID, {
      ...baseRegistration,
      registration: {
        id: 'github',
        adapter: {
          async probe() {
            return await services.resolveScmHostingTokenMaterialization?.({
              kind: 'scm_hosting_token',
              providerId: GITHUB_SCM_HOSTING_PROVIDER_ID,
              host: 'github.com',
              provider: githubProvider,
            });
          },
        },
      },
    });
    services = createHostScmHostingProviderRuntimeServices({
      ...baseInput,
      scmHostingProvidersById: registrations,
      resolveConnectedAccountPurposeBindingOwner: () => ({ materialize }),
    });
    const registry = await services.resolveScmHostingProviderRegistry?.();
    const adapter = registry?.getAdapter(
      GITHUB_SCM_HOSTING_PROVIDER_ID,
    ) as Readonly<{ probe(): Promise<unknown> }>;

    const pending = adapter.probe();
    await vi.waitFor(() => {
      expect(materialize).toHaveBeenCalledOnce();
    });
    registrations.delete(GITHUB_SCM_HOSTING_PROVIDER_ID);
    releaseMaterialize();

    await expect(pending).rejects.toThrow('generation is stale');
  });

  it('executes only inside the exact current hosting-provider generation without exposing a path', async () => {
    const executeCommand = vi.fn(async () => ({
      ok: true,
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    }));
    const baseInput = createRuntimeInput();
    const input: RuntimeServicesInput = {
      ...baseInput,
      contributes: {
        ...baseInput.contributes,
        scmHostingProviders: [{
          id: 'github',
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: GITHUB_PLUGIN_MANIFEST.id,
          definition: {
            id: 'github',
            title: 'GitHub',
            kind: 'github',
            capabilities: ['detect'],
            authService: 'github-account',
          },
        }],
      },
    };
    let services!: ReturnType<typeof createHostScmHostingProviderRuntimeServices>;
    const registrations = new Map(input.scmHostingProvidersById);
    const originalRegistration = registrations.get(GITHUB_SCM_HOSTING_PROVIDER_ID)!;
    registrations.set(GITHUB_SCM_HOSTING_PROVIDER_ID, {
      ...originalRegistration,
      registration: {
        id: 'github',
        adapter: {
          async probe() {
            return await services.executeCommand?.({
              executable: { kind: 'systemTool', id: 'github-cli' },
              args: ['--version'],
              timeoutMs: 1_000,
            });
          },
        },
      },
    });
    services = createHostScmHostingProviderRuntimeServices({
      ...input,
      scmHostingProvidersById: registrations,
      executeCommand,
    });

    await expect(services.executeCommand?.({
      executable: { kind: 'systemTool', id: 'github-cli' },
      args: ['--version'],
      timeoutMs: 1_000,
    })).rejects.toThrow('provider-qualified');

    const registry = await services.resolveScmHostingProviderRegistry?.();
    expect(registry?.providers.map((provider) => provider.id)).toEqual([GITHUB_SCM_HOSTING_PROVIDER_ID]);
    expect(registry?.getProvider(GITHUB_SCM_HOSTING_PROVIDER_ID)?.runtime).toBeDefined();
    expect(registry?.getProvider(GITHUB_SCM_HOSTING_PROVIDER_ID)).toMatchObject({
      urlSafety: {
        allowedSchemes: ['https:'],
        allowedBaseUrls: [],
        allowedOrigins: [],
      },
    });
    const adapter = registry?.getAdapter(GITHUB_SCM_HOSTING_PROVIDER_ID) as Readonly<{
      probe(): Promise<unknown>;
    }>;
    await expect(adapter.probe()).resolves.toMatchObject({ ok: true, stdout: 'ok' });
    expect(executeCommand).toHaveBeenCalledWith(expect.objectContaining({
      executable: { kind: 'systemTool', id: 'github-cli' },
    }), undefined);
  });

  it('routes a declared managed dependency through the shared executable and process owners', async () => {
    const release = vi.fn();
    const resolveExecutable = vi.fn(async () => ({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("managed-ok")'],
      release,
    }));
    let services!: ReturnType<typeof createHostScmHostingProviderRuntimeServices>;
    const registrations = new Map([[
      'scm-github/scm.github',
      {
        pluginId: 'scm-github',
        generation: 'test-generation',
        registration: {
          id: 'scm.github',
          adapter: {
            async probe() {
              return await services.executeCommand?.({
                executable: { kind: 'managedDependency', id: 'forge-cli' },
                args: [],
                timeoutMs: 2_000,
              });
            },
          },
        },
      },
    ]] as const);
    services = createHostScmHostingProviderRuntimeServices({
      contributes: {
        connectedAccountDescriptors: [],
        scmHostingProviders: [{
          id: 'scm.github',
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: 'scm-github',
          definition: {
            id: 'scm.github', title: 'GitHub', kind: 'github', capabilities: ['detect'], authService: 'github-account',
          },
        }],
      },
      scmHostingProvidersById: registrations,
      managedDependencies: { resolveExecutable },
    });
    const registry = await services.resolveScmHostingProviderRegistry?.();
    const adapter = registry?.getAdapter('scm-github/scm.github') as Readonly<{ probe(): Promise<unknown> }>;

    await expect(adapter.probe()).resolves.toMatchObject({ ok: true, stdout: 'managed-ok' });
    expect(resolveExecutable).toHaveBeenCalledWith(
      { kind: 'managedDependency', id: 'forge-cli' },
      'scm-github',
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('re-materializes the current durable purpose binding on every request', async () => {
    const materialize = vi.fn()
      .mockResolvedValueOnce({
        kind: 'httpHeaders',
        headers: { Authorization: 'Bearer ghp_first' },
      })
      .mockResolvedValueOnce({
        kind: 'httpHeaders',
        headers: { Authorization: 'Bearer ghp_second' },
      });
    const services = createHostScmHostingProviderRuntimeServices({
      ...createRuntimeInput(),
      resolveConnectedAccountPurposeBindingOwner: () => ({ materialize }),
    });
    const request = {
      kind: 'scm_hosting_token' as const,
      providerId: GITHUB_SCM_HOSTING_PROVIDER_ID,
      host: 'github.com',
      provider: githubProvider,
    };

    await expect(runAsHostingProvider(
      GITHUB_PLUGIN_MANIFEST.id,
      'github',
      () => services.resolveScmHostingTokenMaterialization?.(request),
    ))
      .resolves.toMatchObject({ kind: 'available', token: 'ghp_first' });
    await expect(runAsHostingProvider(
      GITHUB_PLUGIN_MANIFEST.id,
      'github',
      () => services.resolveScmHostingTokenMaterialization?.(request),
    ))
      .resolves.toMatchObject({ kind: 'available', token: 'ghp_second' });

    expect(materialize).toHaveBeenCalledTimes(2);
  });

  it('materializes Bitbucket basic auth through its canonical durable purpose binding', async () => {
    const service = {
      pluginId: BITBUCKET_PLUGIN_MANIFEST.id,
      localId: 'bitbucket-account',
    } as const;
    const materialize = vi.fn(async () => ({
      kind: 'httpHeaders' as const,
      headers: {
        Authorization: `Basic ${Buffer.from('alice@example.test:bb-secret').toString('base64')}`,
      },
    }));
    const services = createHostScmHostingProviderRuntimeServices({
      contributes: {
        scmHostingProviders: [{
          id: 'bitbucket',
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: BITBUCKET_PLUGIN_MANIFEST.id,
          definition: BITBUCKET_PLUGIN_MANIFEST.contributes.scmHostingProviders[0]!,
        }],
        connectedAccountDescriptors: [{
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: BITBUCKET_PLUGIN_MANIFEST.id,
          definition: PluginConnectedAccountDescriptorContributionV2Schema.parse(
            BITBUCKET_PLUGIN_MANIFEST.contributes.connectedAccountDescriptors[0],
          ),
        }],
      },
      scmHostingProvidersById: new Map([[
        BITBUCKET_SCM_HOSTING_PROVIDER_ID,
        {
          pluginId: BITBUCKET_PLUGIN_MANIFEST.id,
          generation: 'test-generation',
          registration: {
            id: 'bitbucket',
            adapter: {},
          },
        },
      ]]),
      resolveConnectedAccountPurposeBindingOwner: () => ({ materialize }),
    });

    await expect(runAsHostingProvider(
      BITBUCKET_PLUGIN_MANIFEST.id,
      'bitbucket',
      () => services.resolveScmHostingBasicAuthMaterialization?.({
        kind: 'scm_hosting_basic_auth',
        providerId: BITBUCKET_SCM_HOSTING_PROVIDER_ID,
        host: 'bitbucket.org',
        provider: {
          id: BITBUCKET_SCM_HOSTING_PROVIDER_ID,
          kind: 'bitbucket',
          displayName: 'Bitbucket',
          baseUrl: 'https://bitbucket.org',
          urlSafety: { allowedSchemes: ['https:'] },
        },
      }),
    )).resolves.toEqual({
      kind: 'available',
      username: 'alice@example.test',
      password: 'bb-secret',
    });
    expect(materialize).toHaveBeenCalledWith({
      purpose: {
        consumer: {
          pluginId: BITBUCKET_PLUGIN_MANIFEST.id,
          localId: 'bitbucket',
        },
        purpose: 'authentication',
      },
      serviceRefs: [service],
      request: {
        kind: 'httpHeaders',
        origin: 'https://bitbucket.org',
        headerNames: ['Authorization'],
      },
      signal: expect.any(AbortSignal),
    });
  });

  it('routes a registered GitHub REST operation through the canonical purpose binding owner', async () => {
    const materialize = vi.fn(async () => ({
      kind: 'httpHeaders' as const,
      headers: { Authorization: 'Bearer ghp_operation' },
    }));
    const fetcher = vi.fn(async () => new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetcher);

    try {
      const baseInput = createRuntimeInput();
      const registrations = new Map(baseInput.scmHostingProvidersById);
      registrations.set(GITHUB_SCM_HOSTING_PROVIDER_ID, {
        pluginId: GITHUB_PLUGIN_MANIFEST.id,
        generation: 'test-generation',
        registration: {
          id: 'github',
          adapter: githubPullRequestAdapter,
        },
      });
      const services = createHostScmHostingProviderRuntimeServices({
        ...baseInput,
        scmHostingProvidersById: registrations,
        resolveConnectedAccountPurposeBindingOwner: () => ({ materialize }),
      });
      const registry = await services.resolveScmHostingProviderRegistry?.();
      const adapter = registry?.getAdapter(
        GITHUB_SCM_HOSTING_PROVIDER_ID,
      ) as typeof githubPullRequestAdapter;

      await expect(adapter.listPullRequests({
        provider: githubProvider,
        head: 'feature/connected-account',
        runtimeServices: services,
      })).resolves.toEqual([]);

      expect(materialize).toHaveBeenCalledWith({
        purpose: {
          consumer: {
            pluginId: GITHUB_PLUGIN_MANIFEST.id,
            localId: 'github',
          },
          purpose: 'authentication',
        },
        serviceRefs: [{
          pluginId: GITHUB_PLUGIN_MANIFEST.id,
          localId: 'github-account',
        }],
        request: {
          kind: 'httpHeaders',
          origin: 'https://github.com',
          headerNames: ['Authorization'],
        },
        signal: expect.any(AbortSignal),
      });
      expect(fetcher).toHaveBeenCalledWith(
        expect.stringContaining('https://api.github.com/repos/happier-dev/happier/pulls?'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer ghp_operation',
          }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('routes a registered Bitbucket API operation through the canonical purpose binding owner', async () => {
    const bitbucketProvider = {
      id: BITBUCKET_SCM_HOSTING_PROVIDER_ID,
      kind: 'bitbucket',
      displayName: 'Bitbucket',
      baseUrl: 'https://bitbucket.org',
      nameWithOwner: 'happier-dev/happier',
      urlSafety: { allowedSchemes: ['https:'] },
    } satisfies ScmHostingProviderRef;
    const materialize = vi.fn(async () => ({
      kind: 'httpHeaders' as const,
      headers: {
        Authorization: `Basic ${Buffer.from('alice@example.test:bb-operation').toString('base64')}`,
      },
    }));
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ values: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetcher);

    try {
      const services = createHostScmHostingProviderRuntimeServices({
        contributes: {
          scmHostingProviders: [{
            id: 'bitbucket',
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: BITBUCKET_PLUGIN_MANIFEST.id,
            definition: BITBUCKET_PLUGIN_MANIFEST.contributes.scmHostingProviders[0]!,
          }],
          connectedAccountDescriptors: [{
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: BITBUCKET_PLUGIN_MANIFEST.id,
            definition: PluginConnectedAccountDescriptorContributionV2Schema.parse(
              BITBUCKET_PLUGIN_MANIFEST.contributes.connectedAccountDescriptors[0],
            ),
          }],
        },
        scmHostingProvidersById: new Map([[
          BITBUCKET_SCM_HOSTING_PROVIDER_ID,
          {
            pluginId: BITBUCKET_PLUGIN_MANIFEST.id,
            generation: 'test-generation',
            registration: {
              id: 'bitbucket',
              adapter: bitbucketApiAdapter,
            },
          },
        ]]),
        resolveConnectedAccountPurposeBindingOwner: () => ({ materialize }),
      });
      const registry = await services.resolveScmHostingProviderRegistry?.();
      const adapter = registry?.getAdapter(
        BITBUCKET_SCM_HOSTING_PROVIDER_ID,
      ) as typeof bitbucketApiAdapter;

      await expect(adapter.listPullRequests({
        provider: bitbucketProvider,
        head: 'feature/connected-account',
        runtimeServices: services,
      })).resolves.toEqual([]);

      expect(materialize).toHaveBeenCalledWith({
        purpose: {
          consumer: {
            pluginId: BITBUCKET_PLUGIN_MANIFEST.id,
            localId: 'bitbucket',
          },
          purpose: 'authentication',
        },
        serviceRefs: [{
          pluginId: BITBUCKET_PLUGIN_MANIFEST.id,
          localId: 'bitbucket-account',
        }],
        request: {
          kind: 'httpHeaders',
          origin: 'https://bitbucket.org',
          headerNames: ['Authorization'],
        },
        signal: expect.any(AbortSignal),
      });
      expect(fetcher).toHaveBeenCalledWith(
        expect.stringContaining('https://api.bitbucket.org/2.0/repositories/happier-dev/happier/pullrequests?'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Basic ${Buffer.from('alice@example.test:bb-operation').toString('base64')}`,
          }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
