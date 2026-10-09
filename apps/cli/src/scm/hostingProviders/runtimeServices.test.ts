import { describe, expect, it, vi } from 'vitest';

import {
  PluginConnectedAccountDescriptorContributionV2Schema,
  ScmHostingProviderContributionSchema,
  type QualifiedConnectedAccountPurposeBindingsV1,
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

import {
  CONNECTED_ACCOUNT_METADATA_LIST_MAX_LIMIT,
  type StablePluginConnectedAccountsOwner,
} from '@/plugins/runtime/invocation/services/connectedAccounts';

import { runWithHostingProviderExecutionAuthority } from './executionAuthority';
import { createHostScmHostingProviderRuntimeServices } from './runtimeServices';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';

type RuntimeServicesInput = Parameters<typeof createHostScmHostingProviderRuntimeServices>[0];

function createRuntimeInput(): RuntimeServicesInput {
  return {
    contributes: {
      scmHostingProviders: [{
        id: 'github',
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: GITHUB_PLUGIN_MANIFEST.id,
        definition: ScmHostingProviderContributionSchema.parse(
          (GITHUB_PLUGIN_MANIFEST.contributes.scmHostingProviders ?? [])[0],
        ),
      }],
      connectedAccountDescriptors: [{
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: GITHUB_PLUGIN_MANIFEST.id,
        definition: PluginConnectedAccountDescriptorContributionV2Schema.parse(
          (GITHUB_PLUGIN_MANIFEST.contributes.connectedAccountDescriptors ?? [])[0],
        ),
      }],
    },
    scmHostingProvidersById: new Map([[
      GITHUB_SCM_HOSTING_PROVIDER_ID,
      {
        pluginId: GITHUB_PLUGIN_MANIFEST.id,
        occurrenceId: 'test-generation',
        registration: {
          id: 'github',
          adapter: {},
        },
      },
    ]]),
  };
}

function createCrossProviderRuntimeInput(): RuntimeServicesInput {
  return {
    contributes: {
      scmHostingProviders: [{
        id: 'github',
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: GITHUB_PLUGIN_MANIFEST.id,
        definition: ScmHostingProviderContributionSchema.parse(
          (GITHUB_PLUGIN_MANIFEST.contributes.scmHostingProviders ?? [])[0],
        ),
      }, {
        id: 'bitbucket',
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: BITBUCKET_PLUGIN_MANIFEST.id,
        definition: ScmHostingProviderContributionSchema.parse(
          (BITBUCKET_PLUGIN_MANIFEST.contributes.scmHostingProviders ?? [])[0],
        ),
      }],
      connectedAccountDescriptors: [{
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: GITHUB_PLUGIN_MANIFEST.id,
        definition: PluginConnectedAccountDescriptorContributionV2Schema.parse(
          (GITHUB_PLUGIN_MANIFEST.contributes.connectedAccountDescriptors ?? [])[0],
        ),
      }, {
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: BITBUCKET_PLUGIN_MANIFEST.id,
        definition: PluginConnectedAccountDescriptorContributionV2Schema.parse(
          (BITBUCKET_PLUGIN_MANIFEST.contributes.connectedAccountDescriptors ?? [])[0],
        ),
      }],
    },
    scmHostingProvidersById: new Map([
      [
        GITHUB_SCM_HOSTING_PROVIDER_ID,
        {
          pluginId: GITHUB_PLUGIN_MANIFEST.id,
          occurrenceId: 'test-generation',
          registration: {
            id: 'github',
            adapter: {},
          },
        },
      ],
      [
        BITBUCKET_SCM_HOSTING_PROVIDER_ID,
        {
          pluginId: BITBUCKET_PLUGIN_MANIFEST.id,
          occurrenceId: 'test-generation',
          registration: {
            id: 'bitbucket',
            adapter: {},
          },
        },
      ],
    ]),
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

type ConfiguredDeploymentListing = Awaited<
  ReturnType<NonNullable<StablePluginConnectedAccountsOwner['listAccounts']>>
>;

function createListedDeploymentAccount(
  service: Readonly<{ pluginId: string; localId: string }>,
  accountId: string,
  base: string,
): ConfiguredDeploymentListing['accounts'][number] {
  return {
    account: { service, accountId },
    displayName: accountId,
    state: 'connected',
    connectedAccountOrigins: [new URL(base).origin],
    connectedAccountBases: [base],
  };
}

/**
 * A routing adapter that can only recognize its remotes through the host-supplied configured
 * deployment bases — the self-managed forge the listing exists for.
 */
function createConfiguredBaseRoutingRegistration(id: string, kind: string) {
  return {
    id,
    adapter: {
      routing: {
        detectRemote: (input: Readonly<{
          remoteName: string | null;
          remoteUrl: string;
          connectedAccountBases?: readonly string[];
        }>) => {
          const base = (input.connectedAccountBases ?? []).find(
            (candidate) => input.remoteUrl.startsWith(`${candidate}/`),
          );
          return base
            ? {
              id,
              kind,
              displayName: id,
              baseUrl: base,
              nameWithOwner: 'team/repository',
            }
            : null;
        },
        buildCompareUrl: () => null,
      },
    },
  };
}

function runAsHostingProvider<T>(
  pluginId: string,
  contributionId: string,
  callback: () => T,
): T {
  return runWithHostingProviderExecutionAuthority({
    pluginId,
    contributionId,
    occurrenceId: 'test-generation',
  }, callback);
}


// Existing scenarios use the real binding owner too; only persistence, Account
// projection and credential transport are replaced at their system boundaries.
function createAuthenticationBindingOwner(
  materializeAccount: Parameters<typeof createConnectedAccountPurposeBindingOwner>[0]['materializeAccount'],
) {
  const definitions = [
    { pluginId: GITHUB_PLUGIN_MANIFEST.id, localId: 'github', serviceId: 'github-account', base: 'https://github.com' },
    { pluginId: BITBUCKET_PLUGIN_MANIFEST.id, localId: 'bitbucket', serviceId: 'bitbucket-account', base: 'https://bitbucket.org' },
  ];
  const accounts = definitions.map((entry) => ({
    entry, account: { service: { pluginId: entry.pluginId, localId: entry.serviceId }, accountId: 'bound-account' },
  }));
  let bindings: QualifiedConnectedAccountPurposeBindingsV1 = {
    v: 1, bindings: accounts.map(({ entry, account }) => ({
      purpose: { consumer: { pluginId: entry.pluginId, localId: entry.localId }, purpose: 'authentication' },
      target: { kind: 'account' as const, account },
    })),
  };
  return createConnectedAccountPurposeBindingOwner({
    store: {
      read: async () => bindings,
      update: async (mutate) => { bindings = mutate(bindings); return bindings; },
      subscribe: () => ({ dispose() {} }),
    },
    selectTarget: async () => { throw new Error('Authentication cannot select a new Account'); },
    resolveTarget: async (target) => target.kind === 'account'
      ? { displayName: 'Bound Account', account: target.account } : null,
    projectTargetAccounts: async ({ target }) => ({
      status: 'complete' as const,
      accounts: accounts.filter(({ account }) => target.kind === 'account'
        && account.service.pluginId === target.account.service.pluginId)
        .map(({ entry, account }) => createListedDeploymentAccount(account.service, account.accountId, entry.base)),
    }),
    assertTargetAccountMaterializable: async () => undefined,
    materializeAccount,
  });
}

describe('createHostScmHostingProviderRuntimeServices', () => {
  it('uses a declared machine-native credential for an unbound GitHub Enterprise purpose without storing it', async () => {
    const service = { pluginId: GITHUB_PLUGIN_MANIFEST.id, localId: 'github-account' };
    let bindings: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [] };
    const owner = createConnectedAccountPurposeBindingOwner({
      store: {
        read: async () => bindings,
        update: async (mutate) => { bindings = mutate(bindings); return bindings; },
        subscribe: () => ({ dispose() {} }),
      },
      selectTarget: async () => { throw new Error('A source read must not select an account'); },
      resolveTarget: async () => null,
      materializeAccount: async () => { throw new Error('No account was selected'); },
      // The native materializer is the OS credential boundary; the purpose owner and SCM host are real.
      materializeNative: async (input) => {
        expect(input.service).toEqual(service);
        expect(input.request).toMatchObject({ kind: 'httpHeaders', origin: 'https://github.example.test' });
        return { kind: 'httpHeaders', headers: { Authorization: 'Bearer ephemeral-enterprise-token' } };
      },
      projectTargetAccounts: async () => { throw new Error('Native login is not an account inventory'); },
      assertTargetAccountMaterializable: async () => undefined,
    });
    const runtimeInput = createRuntimeInput();
    const descriptors = runtimeInput.contributes.connectedAccountDescriptors ?? [];
    const descriptor = descriptors[0];
    if (!descriptor) throw new Error('GitHub descriptor fixture is missing');
    const services = createHostScmHostingProviderRuntimeServices({
      ...runtimeInput,
      contributes: {
        ...runtimeInput.contributes,
        connectedAccountDescriptors: [{
          ...descriptor,
          definition: {
            ...descriptor.definition,
            authentication: { ...descriptor.definition.authentication, native: { systemTool: 'gh' } },
          },
        }],
      },
      resolveConnectedAccountPurposeBindingOwner: () => owner,
    });
    await expect(runAsHostingProvider(GITHUB_PLUGIN_MANIFEST.id, 'github', () => (
      services.resolveScmHostingTokenMaterialization?.({
        kind: 'scm_hosting_token', providerId: GITHUB_SCM_HOSTING_PROVIDER_ID,
        host: 'github.example.test', provider: { ...githubProvider, baseUrl: 'https://github.example.test' },
      })
    ))).resolves.toEqual({ kind: 'available', token: 'ephemeral-enterprise-token' });
    expect(bindings).toEqual({ v: 1, bindings: [] });
    expect(JSON.stringify(bindings)).not.toContain('ephemeral-enterprise-token');
  });

  it.each([
    { selected: 'other-deployment', rotate: false, expected: 'missing' },
    { selected: 'exact-deployment', rotate: false, expected: 'available' },
    { selected: 'exact-deployment', rotate: true, expected: 'rejected' },
  ])('binds deployment credentials to the exact selected group account ($selected, rotate=$rotate)', async ({ selected, rotate, expected }) => {
    const service = { pluginId: GITHUB_PLUGIN_MANIFEST.id, localId: 'github-account' };
    const deployment = 'https://forge.example.test:8443/GitLab';
    let currentAccountId = selected;
    let bindings: QualifiedConnectedAccountPurposeBindingsV1 = {
      v: 1,
      bindings: [{
        purpose: { consumer: { pluginId: GITHUB_PLUGIN_MANIFEST.id, localId: 'github' }, purpose: 'authentication' },
        target: { kind: 'group', service, groupId: 'forge-accounts' },
      }],
    };
    // Persistent binding storage and the Account metadata/credential transport are
    // genuine boundaries. The binding owner and SCM host below are both real.
    const materializeAccount = vi.fn(async () => ({
      kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer exact-bound-token' },
    }));
    const owner = createConnectedAccountPurposeBindingOwner({
      store: {
        read: async () => bindings,
        update: async (mutate) => { bindings = mutate(bindings); return bindings; },
        subscribe: () => ({ dispose() {} }),
      },
      selectTarget: async () => { throw new Error('This invocation cannot select an account'); },
      resolveTarget: async () => ({ displayName: 'Selected forge account', account: { service, accountId: currentAccountId } }),
      materializeAccount,
      projectTargetAccounts: async () => {
        if (rotate) currentAccountId = 'other-deployment';
        return {
          status: 'complete' as const,
          accounts: [
            createListedDeploymentAccount(service, 'other-deployment', 'https://forge.example.test:8443/Other'),
            createListedDeploymentAccount(service, 'exact-deployment', deployment),
          ],
        };
      },
      assertTargetAccountMaterializable: async () => undefined,
    });
    const services = createHostScmHostingProviderRuntimeServices({
      ...createRuntimeInput(), resolveConnectedAccountPurposeBindingOwner: () => owner,
    });
    const result = runAsHostingProvider(GITHUB_PLUGIN_MANIFEST.id, 'github', () => services.resolveScmHostingTokenMaterialization?.({
      kind: 'scm_hosting_token', providerId: GITHUB_SCM_HOSTING_PROVIDER_ID,
      host: 'forge.example.test:8443', provider: { ...githubProvider, baseUrl: deployment },
    }));
    if (expected === 'rejected') {
      await expect(result).rejects.toThrow();
      expect(materializeAccount).not.toHaveBeenCalled();
    } else if (expected === 'missing') {
      await expect(result).resolves.toMatchObject({ kind: 'missing' });
      expect(materializeAccount).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toEqual({ kind: 'available', token: 'exact-bound-token' });
    }
  });

  it('distinguishes an absent account binding from unavailable bound credentials', async () => {
    const owner = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }),
        update: async mutate => mutate({ v: 1, bindings: [] }), subscribe: () => ({ dispose() {} }) },
      selectTarget: async () => { throw new Error('A read cannot select an account'); },
      resolveTarget: async () => null,
      projectTargetAccounts: async () => ({ status: 'complete', accounts: [] }),
      materializeAccount: async () => { throw new Error('There is no selected account'); },
      assertTargetAccountMaterializable: async () => undefined,
    });
    const request = { kind: 'scm_hosting_token' as const, boundAccountOnly: true as const, providerId: GITHUB_SCM_HOSTING_PROVIDER_ID,
      host: 'github.com', provider: githubProvider };
    const unbound = createHostScmHostingProviderRuntimeServices({ ...createRuntimeInput(),
      resolveConnectedAccountPurposeBindingOwner: () => owner });
    await expect(runAsHostingProvider(GITHUB_PLUGIN_MANIFEST.id, 'github',
      () => unbound.resolveScmHostingTokenMaterialization!(request)))
      .resolves.toEqual({ kind: 'missing', reason: 'account_unbound' });
    const unavailable = createHostScmHostingProviderRuntimeServices(createRuntimeInput());
    await expect(runAsHostingProvider(GITHUB_PLUGIN_MANIFEST.id, 'github',
      () => unavailable.resolveScmHostingTokenMaterialization!(request)))
      .resolves.toEqual({ kind: 'missing', reason: 'credential_unavailable' });
  });

  it('does not expose connected-account credentials outside a provider-qualified invocation', async () => {
    const materialize = vi.fn(async () => ({
      kind: 'httpHeaders' as const,
      headers: { Authorization: 'Bearer ghp_cross_plugin' },
    }));
    const services = createHostScmHostingProviderRuntimeServices({
      ...createRuntimeInput(),
      resolveConnectedAccountPurposeBindingOwner: () => createAuthenticationBindingOwner(materialize),
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
      resolveConnectedAccountPurposeBindingOwner: () => createAuthenticationBindingOwner(materialize),
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
      account: { service: { pluginId: GITHUB_PLUGIN_MANIFEST.id, localId: 'github-account' }, accountId: 'bound-account' },
      request: {
        kind: 'httpHeaders',
        origin: 'https://github.com',
        headerNames: ['authorization'],
      },
      signal: expect.any(AbortSignal),
    });
  });

  it('rejects an accessor-backed provider identity before cross-plugin credential dispatch', async () => {
    let providerIdReads = 0;
    const request = Object.defineProperty({
      kind: 'scm_hosting_token',
      host: 'github.com',
      provider: githubProvider,
    }, 'providerId', {
      enumerable: true,
      get() {
        providerIdReads += 1;
        return providerIdReads === 1
          ? GITHUB_SCM_HOSTING_PROVIDER_ID
          : BITBUCKET_SCM_HOSTING_PROVIDER_ID;
      },
    }) as Parameters<
      NonNullable<
        ReturnType<typeof createHostScmHostingProviderRuntimeServices>[
          'resolveScmHostingTokenMaterialization'
        ]
      >
    >[0];
    const materialize = vi.fn(async () => ({
      kind: 'httpHeaders' as const,
      headers: { Authorization: 'Bearer cross-plugin-secret' },
    }));
    const services = createHostScmHostingProviderRuntimeServices({
      ...createCrossProviderRuntimeInput(),
      resolveConnectedAccountPurposeBindingOwner: () => createAuthenticationBindingOwner(materialize),
    });

    await expect(runAsHostingProvider(
      GITHUB_PLUGIN_MANIFEST.id,
      'github',
      () => services.resolveScmHostingTokenMaterialization?.(request),
    )).rejects.toThrow('plain data');
    expect(providerIdReads).toBe(0);
    expect(materialize).not.toHaveBeenCalled();
  });

  it('rechecks provider generation after snapshotting a crafted materialization result', async () => {
    const baseInput = createRuntimeInput();
    const registrations = new Map(baseInput.scmHostingProvidersById);
    const materialize = vi.fn(async () => new Proxy({
      kind: 'httpHeaders' as const,
      headers: { Authorization: 'Bearer stale-generation-secret' },
    }, {
      ownKeys(target) {
        registrations.delete(GITHUB_SCM_HOSTING_PROVIDER_ID);
        return Reflect.ownKeys(target);
      },
    }));
    const services = createHostScmHostingProviderRuntimeServices({
      ...baseInput,
      scmHostingProvidersById: registrations,
      resolveConnectedAccountPurposeBindingOwner: () => createAuthenticationBindingOwner(materialize),
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
    )).rejects.toThrow('generation is stale');
  });

  it('does not let an explicit profile bypass the canonical SCM purpose binding', async () => {
    const materialize = vi.fn(async () => ({
      kind: 'httpHeaders' as const,
      headers: { Authorization: 'Bearer ghp_wrong_account' },
    }));
    const services = createHostScmHostingProviderRuntimeServices({
      ...createRuntimeInput(),
      resolveConnectedAccountPurposeBindingOwner: () => createAuthenticationBindingOwner(materialize),
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
          pullRequests: {
            getPullRequestAuthProfileKey: () => null,
            async listPullRequests() {
              await services.resolveScmHostingTokenMaterialization?.({
                kind: 'scm_hosting_token',
                providerId: GITHUB_SCM_HOSTING_PROVIDER_ID,
                host: 'github.com',
                provider: githubProvider,
              });
              return [];
            },
            getPullRequest: async () => null,
            createPullRequest: async () => { throw new Error('not used'); },
          },
        },
      },
    });
    services = createHostScmHostingProviderRuntimeServices({
      ...baseInput,
      scmHostingProvidersById: registrations,
      resolveConnectedAccountPurposeBindingOwner: () => createAuthenticationBindingOwner(materialize),
    });
    const registry = await services.resolveScmHostingProviderRegistry?.();
    const adapter = registry?.getPullRequests(GITHUB_SCM_HOSTING_PROVIDER_ID);

    const pending = adapter!.listPullRequests({ provider: githubProvider, head: 'feature' });
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
          pullRequests: {
            getPullRequestAuthProfileKey: () => null,
            async listPullRequests() {
              await services.executeCommand?.({
                executable: { kind: 'systemTool', id: 'github-cli' },
                args: ['--version'],
                timeoutMs: 1_000,
              });
              return [];
            },
            getPullRequest: async () => null,
            createPullRequest: async () => { throw new Error('not used'); },
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
    expect(registry?.getProvider(GITHUB_SCM_HOSTING_PROVIDER_ID)).toMatchObject({
      urlSafety: {
        allowedSchemes: ['https:'],
        allowedBaseUrls: [],
        allowedOrigins: [],
      },
    });
    const adapter = registry?.getPullRequests(GITHUB_SCM_HOSTING_PROVIDER_ID);
    await expect(adapter?.listPullRequests({ provider: githubProvider, head: 'feature' })).resolves.toEqual([]);
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
        occurrenceId: 'test-generation',
        registration: {
          id: 'scm.github',
          adapter: {
            pullRequests: {
              getPullRequestAuthProfileKey: () => null,
              async listPullRequests() {
                await services.executeCommand?.({
                  executable: { kind: 'managedDependency', id: 'forge-cli' },
                  args: [],
                  timeoutMs: 2_000,
                });
                return [];
              },
              getPullRequest: async () => null,
              createPullRequest: async () => { throw new Error('not used'); },
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
    const adapter = registry?.getPullRequests('scm-github/scm.github');

    await expect(adapter?.listPullRequests({ provider: githubProvider, head: 'feature' })).resolves.toEqual([]);
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
      resolveConnectedAccountPurposeBindingOwner: () => createAuthenticationBindingOwner(materialize),
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
          definition: ScmHostingProviderContributionSchema.parse(
            (BITBUCKET_PLUGIN_MANIFEST.contributes.scmHostingProviders ?? [])[0],
          ),
        }],
        connectedAccountDescriptors: [{
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: BITBUCKET_PLUGIN_MANIFEST.id,
          definition: PluginConnectedAccountDescriptorContributionV2Schema.parse(
            (BITBUCKET_PLUGIN_MANIFEST.contributes.connectedAccountDescriptors ?? [])[0],
          ),
        }],
      },
      scmHostingProvidersById: new Map([[
        BITBUCKET_SCM_HOSTING_PROVIDER_ID,
        {
          pluginId: BITBUCKET_PLUGIN_MANIFEST.id,
          occurrenceId: 'test-generation',
          registration: {
            id: 'bitbucket',
            adapter: {},
          },
        },
      ]]),
      resolveConnectedAccountPurposeBindingOwner: () => createAuthenticationBindingOwner(materialize),
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
      account: { service: { pluginId: BITBUCKET_PLUGIN_MANIFEST.id, localId: 'bitbucket-account' }, accountId: 'bound-account' },
      request: {
        kind: 'httpHeaders',
        origin: 'https://bitbucket.org',
        headerNames: ['authorization'],
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
        occurrenceId: 'test-generation',
        registration: {
          id: 'github',
          adapter: { pullRequests: githubPullRequestAdapter },
        },
      });
      const services = createHostScmHostingProviderRuntimeServices({
        ...baseInput,
        scmHostingProvidersById: registrations,
        resolveConnectedAccountPurposeBindingOwner: () => createAuthenticationBindingOwner(materialize),
      });
      const registry = await services.resolveScmHostingProviderRegistry?.();
      const adapter = registry?.getPullRequests(
        GITHUB_SCM_HOSTING_PROVIDER_ID,
      );

      await expect(adapter!.listPullRequests({
        provider: githubProvider,
        head: 'feature/connected-account',
        runtimeServices: services,
      })).resolves.toEqual([]);

      expect(materialize).toHaveBeenCalledWith({
        account: { service: { pluginId: GITHUB_PLUGIN_MANIFEST.id, localId: 'github-account' }, accountId: 'bound-account' },
        request: {
          kind: 'httpHeaders',
          origin: 'https://github.com',
          headerNames: ['authorization'],
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
            definition: ScmHostingProviderContributionSchema.parse(
              (BITBUCKET_PLUGIN_MANIFEST.contributes.scmHostingProviders ?? [])[0],
            ),
          }],
          connectedAccountDescriptors: [{
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: BITBUCKET_PLUGIN_MANIFEST.id,
            definition: PluginConnectedAccountDescriptorContributionV2Schema.parse(
              (BITBUCKET_PLUGIN_MANIFEST.contributes.connectedAccountDescriptors ?? [])[0],
            ),
          }],
        },
        scmHostingProvidersById: new Map([[
          BITBUCKET_SCM_HOSTING_PROVIDER_ID,
          {
            pluginId: BITBUCKET_PLUGIN_MANIFEST.id,
            occurrenceId: 'test-generation',
            registration: {
              id: 'bitbucket',
              adapter: { pullRequests: bitbucketApiAdapter },
            },
          },
        ]]),
        resolveConnectedAccountPurposeBindingOwner: () => createAuthenticationBindingOwner(materialize),
      });
      const registry = await services.resolveScmHostingProviderRegistry?.();
      const adapter = registry?.getPullRequests(
        BITBUCKET_SCM_HOSTING_PROVIDER_ID,
      );

      await expect(adapter!.listPullRequests({
        provider: bitbucketProvider,
        head: 'feature/connected-account',
        runtimeServices: services,
      })).resolves.toEqual([]);

      expect(materialize).toHaveBeenCalledWith({
        account: { service: { pluginId: BITBUCKET_PLUGIN_MANIFEST.id, localId: 'bitbucket-account' }, accountId: 'bound-account' },
        request: {
          kind: 'httpHeaders',
          origin: 'https://bitbucket.org',
          headerNames: ['authorization'],
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

  it('recognizes a configured deployment anywhere inside the canonical authorized inventory bound', async () => {
    const service = { pluginId: GITHUB_PLUGIN_MANIFEST.id, localId: 'github-account' } as const;
    // A user whose 21st authorized deployment is still far below the canonical Connected
    // Account metadata ceiling must not lose recognition of it.
    const accounts = Array.from({ length: 21 }, (_, index) => createListedDeploymentAccount(
      service,
      `account-${index}`,
      `https://forge-${index}.example.test`,
    ));
    const listAccounts = vi.fn(async (
      input: Readonly<{ limit: number }>,
    ): Promise<ConfiguredDeploymentListing> => {
      // The canonical owner clamps and then reports its own elision; it has no cursor.
      const admitted = accounts.slice(0, input.limit);
      return {
        status: admitted.length < accounts.length ? 'truncated' : 'complete',
        accounts: admitted,
      };
    });
    const baseInput = createRuntimeInput();
    const services = createHostScmHostingProviderRuntimeServices({
      ...baseInput,
      scmHostingProvidersById: new Map([[
        GITHUB_SCM_HOSTING_PROVIDER_ID,
        {
          pluginId: GITHUB_PLUGIN_MANIFEST.id,
          occurrenceId: 'test-generation',
          registration: createConfiguredBaseRoutingRegistration('github', 'github'),
        },
      ]]),
      resolveConnectedAccountPurposeBindingOwner: () => ({
        materialize: async () => { throw new Error('not used'); },
        listAccounts,
      }),
    });

    const registry = await services.resolveScmHostingProviderRegistry?.();

    expect(listAccounts).toHaveBeenCalledWith(expect.objectContaining({
      limit: CONNECTED_ACCOUNT_METADATA_LIST_MAX_LIMIT,
    }));
    expect(registry?.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://forge-20.example.test/team/repository.git',
    })).toMatchObject({
      kind: 'resolved',
      providerId: GITHUB_SCM_HOSTING_PROVIDER_ID,
      provider: { baseUrl: 'https://forge-20.example.test' },
    });
    expect(registry?.diagnostics).toEqual([]);
  });

  it('keeps a truncated deployment listing usable without asserting that nothing is configured', async () => {
    const service = { pluginId: GITHUB_PLUGIN_MANIFEST.id, localId: 'github-account' } as const;
    const listAccounts = vi.fn(async (): Promise<ConfiguredDeploymentListing> => ({
      status: 'truncated',
      accounts: [createListedDeploymentAccount(
        service,
        'account-known',
        'https://known.example.test',
      )],
    }));
    const baseInput = createRuntimeInput();
    const services = createHostScmHostingProviderRuntimeServices({
      ...baseInput,
      scmHostingProvidersById: new Map([[
        GITHUB_SCM_HOSTING_PROVIDER_ID,
        {
          pluginId: GITHUB_PLUGIN_MANIFEST.id,
          occurrenceId: 'test-generation',
          registration: createConfiguredBaseRoutingRegistration('github', 'github'),
        },
      ]]),
      resolveConnectedAccountPurposeBindingOwner: () => ({
        materialize: async () => { throw new Error('not used'); },
        listAccounts,
      }),
    });

    const registry = await services.resolveScmHostingProviderRegistry?.();

    // A base the elided listing did publish stays usable.
    expect(registry?.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://known.example.test/team/repository.git',
    })).toMatchObject({ kind: 'resolved', providerId: GITHUB_SCM_HOSTING_PROVIDER_ID });
    // A base it could not publish is not evidence that no deployment is configured.
    expect(registry?.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://elided.example.test/team/repository.git',
    })).toEqual({
      kind: 'unknown',
      provider: expect.objectContaining({
        id: 'unknown',
        unsupportedReason: 'configured_deployment_listing_incomplete',
      }),
    });
    expect(registry?.diagnostics).toEqual([expect.objectContaining({
      code: 'scm_hosting_provider_configured_deployments_truncated',
      pluginId: GITHUB_PLUGIN_MANIFEST.id,
      providerId: 'github',
    })]);
  });

  it('keeps one provider\'s unreadable deployment listing from hiding another provider\'s', async () => {
    const bitbucketService = {
      pluginId: BITBUCKET_PLUGIN_MANIFEST.id,
      localId: 'bitbucket-account',
    } as const;
    const listAccounts = vi.fn(async (
      input: Readonly<{ purpose: Readonly<{ consumer: Readonly<{ pluginId: string }> }> }>,
    ): Promise<ConfiguredDeploymentListing> => {
      if (input.purpose.consumer.pluginId === GITHUB_PLUGIN_MANIFEST.id) {
        throw new Error('connected account listing is unavailable');
      }
      return {
        status: 'complete',
        accounts: [createListedDeploymentAccount(
          bitbucketService,
          'account-bitbucket',
          'https://bitbucket.example.test',
        )],
      };
    });
    const baseInput = createCrossProviderRuntimeInput();
    const services = createHostScmHostingProviderRuntimeServices({
      ...baseInput,
      scmHostingProvidersById: new Map([
        [
          GITHUB_SCM_HOSTING_PROVIDER_ID,
          {
            pluginId: GITHUB_PLUGIN_MANIFEST.id,
            occurrenceId: 'test-generation',
            registration: createConfiguredBaseRoutingRegistration('github', 'github'),
          },
        ],
        [
          BITBUCKET_SCM_HOSTING_PROVIDER_ID,
          {
            pluginId: BITBUCKET_PLUGIN_MANIFEST.id,
            occurrenceId: 'test-generation',
            registration: createConfiguredBaseRoutingRegistration('bitbucket', 'bitbucket'),
          },
        ],
      ]),
      resolveConnectedAccountPurposeBindingOwner: () => ({
        materialize: async () => { throw new Error('not used'); },
        listAccounts,
      }),
    });

    const registry = await services.resolveScmHostingProviderRegistry?.();

    expect(registry?.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://bitbucket.example.test/team/repository.git',
    })).toMatchObject({
      kind: 'resolved',
      providerId: BITBUCKET_SCM_HOSTING_PROVIDER_ID,
    });
    expect(registry?.getProvider(GITHUB_SCM_HOSTING_PROVIDER_ID))
      .not.toHaveProperty('connectedAccountBases');
    expect(registry?.diagnostics).toEqual([expect.objectContaining({
      code: 'scm_hosting_provider_configured_deployments_unavailable',
      pluginId: GITHUB_PLUGIN_MANIFEST.id,
      providerId: 'github',
    })]);
  });
});
