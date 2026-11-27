import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  bindHostedSessionId,
  runAddedHostedSession,
} from '@/agent/runtime/lifecycle/hostedSessionScope';

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
  githubRepositoryProvisioningAdapter,
} from '@happier-dev/plugins-scm-github';
import { PLUGIN_MANIFEST as AZURE_PLUGIN_MANIFEST, azureDevopsOperationsAdapter } from '@happier-dev/plugins-scm-azure-devops';

import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';

import { runWithHostingProviderExecutionAuthority } from './executionAuthority';
import { createHostScmHostingProviderRuntimeServices } from './runtimeServices';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { readCurrentHostingProviderRuntimeServices, runWithHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/scm/hosting/runtime';

type RuntimeServicesInput = Parameters<typeof createHostScmHostingProviderRuntimeServices>[0];

it.skipIf(process.platform !== 'linux')('resolves hosting-provider tools from each invoking hosted Session rather than registry construction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-hosting-session-'));
  try {
    const input = createRuntimeInput();
    const registration = [...input.scmHostingProvidersById.values()][0]!;
    const services = createHostScmHostingProviderRuntimeServices({ ...input,
      contributes: { ...input.contributes, systemTools: [{ pluginId: registration.pluginId,
        provenance: 'external', source: { kind: 'path' }, definition: { id: 'session-forge', title: 'Session forge',
          executableNames: ['session-forge'], platforms: ['linux'] } }] } });
    for (const value of ['first', 'second']) {
      const bin = join(directory, value);
      await mkdir(bin);
      await writeFile(join(bin, 'session-forge'), `#!/bin/sh\nprintf '%s' '${value}'\n`, { mode: 0o755 });
      const result = await runAddedHostedSession({ environment: { ...process.env,
        PATH: [bin, process.env.PATH].join(delimiter) },
        workingDirectory: directory, end() {} }, () => runWithHostingProviderExecutionAuthority({
          pluginId: registration.pluginId, contributionId: registration.registration.id,
          occurrenceId: registration.occurrenceId,
        }, () => services.executeCommand!({ executable: { kind: 'systemTool', id: 'session-forge' }, args: [], timeoutMs: 2_000 })));
      expect(result).toMatchObject({ ok: true, stdout: value });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('refuses an unmapped Azure Team selection before native effects while preserving personal operations', async () => {
  const descriptor = (AZURE_PLUGIN_MANIFEST.contributes.scmHostingProviders ?? [])[0]!;
  const providerId = `${AZURE_PLUGIN_MANIFEST.id}/${descriptor.id}`;
  const purpose = { consumer: { pluginId: AZURE_PLUGIN_MANIFEST.id, localId: descriptor.id }, purpose: 'authentication' };
  let durable: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [], teamResourceSelections: [{
    purpose, teamId: 'shared-team', selection: { source: 'team_resource', resourceId: 'source-credential', deliveryMode: 'brokered' },
  }] };
  let selectionReads = 0;
  const owner = createConnectedAccountPurposeBindingOwner({
    store: { read: async () => { selectionReads += 1; return durable; }, update: async mutate => { durable = mutate(durable); return durable; }, subscribe: () => ({ dispose() {} }) },
    selectTarget: async () => { throw new Error('Unexpected selection'); },
    resolveTarget: async () => null,
    assertTargetAccountMaterializable: async () => undefined,
    materializeAccount: async () => { throw new Error('Azure native operation must not open an Account credential'); },
    projectTargetAccounts: async () => { throw new Error('Unexpected target account projection'); },
  });
  const services = createHostScmHostingProviderRuntimeServices({
    contributes: {
      scmHostingProviders: [{ id: descriptor.id, provenance: 'external', source: { kind: 'path' }, pluginId: AZURE_PLUGIN_MANIFEST.id,
        definition: ScmHostingProviderContributionSchema.parse(descriptor) }],
      connectedAccountDescriptors: (AZURE_PLUGIN_MANIFEST.contributes.connectedAccountDescriptors ?? []).map(definition => ({
        provenance: 'external' as const, source: { kind: 'path' as const }, pluginId: AZURE_PLUGIN_MANIFEST.id,
        definition: PluginConnectedAccountDescriptorContributionV2Schema.parse(definition),
      })),
    },
    scmHostingProvidersById: new Map([[providerId, { pluginId: AZURE_PLUGIN_MANIFEST.id, occurrenceId: 'azure-current',
      registration: { id: descriptor.id, adapter: { pullRequests: azureDevopsOperationsAdapter } } }]]),
    resolveConnectedAccountPurposeBindingOwner: () => owner,
  });
  let nativeEffects = 0;
  const registry = await services.resolveScmHostingProviderRegistry!();
  selectionReads = 0;
  const list = registry.getPullRequests(providerId)!.listPullRequests;
  const input = { provider: { id: providerId, kind: 'azure-devops', displayName: 'Azure DevOps',
      baseUrl: 'https://dev.azure.com/team', nameWithOwner: 'team/project/repository', urlSafety: { allowedSchemes: ['https:'] } }, head: 'feature',
    runtimeServices: { executeCommand: async () => { nativeEffects += 1; return { ok: true, stdout: '[]', stderr: '', exitCode: 0 }; } } } as const;
  await expect(list(input)).rejects.toMatchObject({ code: 'plugin_connected_account_team_resource_unavailable' });
  expect(nativeEffects).toBe(0);
  expect(selectionReads).toBe(1);
  durable = { v: 1, bindings: [] };
  await expect(list(input)).resolves.toEqual([]);
  expect(nativeEffects).toBe(1);
  expect(selectionReads).toBe(2);
});

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
  projectTargetAccounts?: Parameters<typeof createConnectedAccountPurposeBindingOwner>[0]['projectTargetAccounts'],
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
    projectTargetAccounts: projectTargetAccounts ?? (async ({ target }) => ({
      status: 'complete' as const,
      accounts: accounts.filter(({ account }) => target.kind === 'account'
        && account.service.pluginId === target.account.service.pluginId)
        .map(({ entry, account }) => createListedDeploymentAccount(account.service, account.accountId, entry.base)),
    })),
    assertTargetAccountMaterializable: async () => undefined,
    materializeAccount,
  });
}

describe('createHostScmHostingProviderRuntimeServices', () => {
  it('keeps the finite clone Account ahead of the hosted Session selection for a later SCM push', async () => {
    const service = { pluginId: GITHUB_PLUGIN_MANIFEST.id, localId: 'github-account' };
    const purpose = {
      consumer: { pluginId: GITHUB_PLUGIN_MANIFEST.id, localId: 'github' },
      purpose: 'authentication' as const,
    };
    let bindings: QualifiedConnectedAccountPurposeBindingsV1 = {
      v: 1,
      bindings: [{
        purpose,
        target: { kind: 'account', account: { service, accountId: 'durable-default' } },
      }],
    };
    let materializationAttempt = 0;
    const materializeAccount = vi.fn(async ({ account }: Readonly<{ account: Readonly<{ accountId: string }> }>) => ({
      kind: 'httpHeaders' as const,
      headers: { Authorization: `Bearer ${account.accountId}-${++materializationAttempt}` },
    }));
    const owner = createConnectedAccountPurposeBindingOwner({
      store: {
        read: async () => bindings,
        update: async (mutate) => { bindings = mutate(bindings); return bindings; },
        subscribe: () => ({ dispose() {} }),
      },
      selectTarget: async () => { throw new Error('SCM materialization does not select accounts'); },
      resolveTarget: async (target) => target.kind === 'account'
        ? { displayName: target.account.accountId, account: target.account }
        : null,
      projectTargetAccounts: async ({ target }) => target.kind === 'account'
        ? {
          status: 'complete' as const,
          accounts: [createListedDeploymentAccount(service, target.account.accountId, 'https://github.com')],
        }
        : { status: 'complete' as const, accounts: [] },
      assertTargetAccountMaterializable: async () => undefined,
      materializeAccount,
    });
    const sessionLease = owner.activateSessionPurposeBindings({
      sessionId: 'project-files-selected-account',
      purposes: [purpose],
      bindings: [{
        purpose,
        target: { kind: 'account', account: { service, accountId: 'project-files-account' } },
      }],
    });
    const services = createHostScmHostingProviderRuntimeServices({
      ...createRuntimeInput(),
      resolveConnectedAccountPurposeBindingOwner: () => owner,
    });
    const cloneSelection = await owner.prepareOperationSelection({
      purpose,
      serviceRefs: [service],
      account: { service, accountId: 'clone-account' },
      operationId: 'project-files-clone',
      signal: new AbortController().signal,
    });
    let cloneSelectionDisposed = false;
    const cloneServices = createHostScmHostingProviderRuntimeServices({
      ...createRuntimeInput(),
      resolveConnectedAccountPurposeBindingOwner: () => cloneSelection.owner,
    });
    const request = {
      kind: 'scm_hosting_token' as const,
      providerId: GITHUB_SCM_HOSTING_PROVIDER_ID,
      host: 'github.com',
      provider: githubProvider,
    };
    try {
      await expect(runAddedHostedSession({
        environment: process.env,
        workingDirectory: process.cwd(),
        end() {},
      }, async () => {
        bindHostedSessionId('project-files-selected-account');
        const clone = await runAsHostingProvider(GITHUB_PLUGIN_MANIFEST.id, 'github', () => (
          cloneServices.resolveScmHostingTokenMaterialization!(request)
        ));
        cloneSelection.dispose();
        cloneSelectionDisposed = true;
        const laterPush = await runAsHostingProvider(GITHUB_PLUGIN_MANIFEST.id, 'github', () => (
          services.resolveScmHostingTokenMaterialization!(request)
        ));
        return { clone, laterPush };
      })).resolves.toEqual({
        clone: {
          kind: 'available',
          token: 'clone-account-1',
          account: { service, accountId: 'clone-account' },
        },
        laterPush: {
          kind: 'available',
          token: 'project-files-account-2',
          account: { service, accountId: 'project-files-account' },
        },
      });
      expect(bindings.bindings[0]?.target).toEqual({
        kind: 'account', account: { service, accountId: 'durable-default' },
      });
    } finally {
      if (!cloneSelectionDisposed) cloneSelection.dispose();
      sessionLease.dispose();
    }

    await expect(runAsHostingProvider(GITHUB_PLUGIN_MANIFEST.id, 'github', () => (
      services.resolveScmHostingTokenMaterialization!(request)
    ))).resolves.toEqual({
      kind: 'available',
      token: 'durable-default-3',
      account: { service, accountId: 'durable-default' },
    });
  });

  it('materializes private Git clone authentication through the registered provider and bound Account owner', async () => {
    const owner = createAuthenticationBindingOwner(async input => {
      expect(input.account.accountId).toBe('bound-account');
      expect(input.request).toMatchObject({ kind: 'httpHeaders', origin: 'https://github.com' });
      return { kind: 'httpHeaders', headers: { Authorization: 'Bearer connected-clone-token' } };
    });
    const runtimeInput = createRuntimeInput();
    const registration = runtimeInput.scmHostingProvidersById.get(GITHUB_SCM_HOSTING_PROVIDER_ID)!;
    const services = createHostScmHostingProviderRuntimeServices({ ...runtimeInput,
      scmHostingProvidersById: new Map([[GITHUB_SCM_HOSTING_PROVIDER_ID, { ...registration,
        registration: { ...registration.registration, adapter: { repositoryClone: githubRepositoryProvisioningAdapter } },
      }]]), resolveConnectedAccountPurposeBindingOwner: () => owner,
    });
    const registry = await services.resolveScmHostingProviderRegistry!();
    await expect(registry.getRepositoryClone(GITHUB_SCM_HOSTING_PROVIDER_ID)?.resolveCloneAuthentication?.({
      provider: githubProvider,
    })).resolves.toEqual({ kind: 'available',
      authorizationHeader: `Basic ${Buffer.from('x-access-token:connected-clone-token').toString('base64')}` });
  });

  it('discovers independent hosting deployments concurrently without materializing credentials', async () => {
    const entered = new Set<string>();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const owner = createAuthenticationBindingOwner(
      async () => { throw new Error('Deployment discovery must not materialize credentials'); },
      async ({ target }) => {
        if (target.kind !== 'account') throw new Error('Expected an Account-bound inventory');
        entered.add(target.account.service.pluginId);
        await held;
        return { status: 'complete', accounts: [createListedDeploymentAccount(
          target.account.service, target.account.accountId,
          target.account.service.pluginId === GITHUB_PLUGIN_MANIFEST.id ? 'https://github.com' : 'https://bitbucket.org',
        )] };
      },
    );
    const services = createHostScmHostingProviderRuntimeServices({
      ...createCrossProviderRuntimeInput(), resolveConnectedAccountPurposeBindingOwner: () => owner,
    });
    const pending = services.resolveScmHostingProviderRegistry!();
    try {
      // The metadata transport is held; all deterministic owner work drains first.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(entered).toEqual(new Set([GITHUB_PLUGIN_MANIFEST.id, BITBUCKET_PLUGIN_MANIFEST.id]));
    } finally { release(); }
    expect((await pending).providers).toHaveLength(2);
  });

  it('cancels in-flight deployment discovery with its hosting operation without publishing late inventory', async () => {
    const controller = new AbortController();
    const reason = new Error('compose observation retired');
    let releaseMetadata!: () => void;
    let metadataEntered!: () => void;
    const heldMetadata = new Promise<void>(resolve => { releaseMetadata = resolve; });
    const entered = new Promise<void>(resolve => { metadataEntered = resolve; });
    let metadataReads = 0;
    const owner = createAuthenticationBindingOwner(
      async () => { throw new Error('Registry discovery must not materialize credentials'); },
      async ({ target }) => {
        metadataReads += 1;
        if (metadataReads === 1) {
          metadataEntered();
          // A late HTTP response may still arrive after cancellation. The real
          // purpose owner and host must not publish it.
          await heldMetadata;
        }
        return { status: 'complete', accounts: target.kind === 'account' ? [
          createListedDeploymentAccount(target.account.service, target.account.accountId, 'https://forge.example.test'),
        ] : [] };
      },
    );
    const services = createHostScmHostingProviderRuntimeServices({
      ...createCrossProviderRuntimeInput(),
      resolveConnectedAccountPurposeBindingOwner: () => owner,
    });
    const readRegistry = () => {
      const current = readCurrentHostingProviderRuntimeServices();
      if (!current?.resolveScmHostingProviderRegistry) throw new Error('Missing hosting registry service');
      return current.resolveScmHostingProviderRegistry();
    };
    try {
      const pending = runWithHostingProviderRuntimeServices(services, readRegistry, { signal: controller.signal });
      await entered;
      await new Promise<void>(resolve => setImmediate(resolve));
      controller.abort(reason);
      releaseMetadata();
      await expect(pending).rejects.toBe(reason);
      expect(metadataReads).toBe(2);
      const registry = await runWithHostingProviderRuntimeServices(services, readRegistry, { signal: new AbortController().signal });
      expect(registry.diagnostics).toEqual([]);
      expect(metadataReads).toBe(4);
    } finally {
      releaseMetadata();
    }
  });

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
      await expect(result).resolves.toEqual({
        kind: 'available',
        token: 'exact-bound-token',
        account: { service, accountId: 'exact-deployment' },
      });
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
      materializeNative: async () => ({ kind: 'httpHeaders', headers: {} }),
      assertTargetAccountMaterializable: async () => undefined,
    });
    const request = { kind: 'scm_hosting_token' as const, boundAccountOnly: true as const, providerId: GITHUB_SCM_HOSTING_PROVIDER_ID,
      host: 'github.com', provider: githubProvider };
    const unbound = createHostScmHostingProviderRuntimeServices({ ...createRuntimeInput(),
      resolveConnectedAccountPurposeBindingOwner: () => owner });
    await expect(runAsHostingProvider(GITHUB_PLUGIN_MANIFEST.id, 'github',
      () => unbound.resolveScmHostingTokenMaterialization!(request)))
      .resolves.toEqual({ kind: 'missing', reason: 'account_unbound' });
    const { boundAccountOnly: _boundAccountOnly, ...nativeRequest } = request;
    await expect(runAsHostingProvider(GITHUB_PLUGIN_MANIFEST.id, 'github',
      () => unbound.resolveScmHostingTokenMaterialization!(nativeRequest)))
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

  it('executes only inside the exact current hosting-provider generation', async () => {
    const release = vi.fn();
    const resolveExecutable = vi.fn(async () => ({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("ok")'],
      release,
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
    const commandResults: unknown[] = [];
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
              commandResults.push(await services.executeCommand?.({
                executable: { kind: 'managedDependency', id: 'forge-cli' },
                args: [],
                timeoutMs: 2_000,
              }));
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
      managedDependencies: { resolveExecutable },
    });

    await expect(services.executeCommand?.({
      executable: { kind: 'managedDependency', id: 'forge-cli' },
      args: [],
      timeoutMs: 2_000,
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
    expect(commandResults).toEqual([{ ok: true, stdout: 'ok', stderr: '', exitCode: 0 }]);
    expect(release).toHaveBeenCalledOnce();

    // A reload publishes a new generation; the adapter bound to the retired one must not run commands.
    registrations.set(GITHUB_SCM_HOSTING_PROVIDER_ID, {
      ...registrations.get(GITHUB_SCM_HOSTING_PROVIDER_ID)!,
      occurrenceId: 'next-generation',
    });
    await expect(adapter?.listPullRequests({ provider: githubProvider, head: 'feature' }))
      .rejects.toThrow('generation is stale');
    expect(resolveExecutable).toHaveBeenCalledOnce();
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
      undefined,
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

  it('reads the purpose binding and the account inventory concurrently for one credential request', async () => {
    const owner = createAuthenticationBindingOwner(async () => ({ kind: 'httpHeaders', headers: { Authorization: 'Bearer ghp_concurrent' } }));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let bindingHeld = false;
    let listedWhileBindingHeld = 0;
    const services = createHostScmHostingProviderRuntimeServices({
      ...createRuntimeInput(),
      resolveConnectedAccountPurposeBindingOwner: () => ({ ...owner,
        getBinding: async request => { bindingHeld = true; await held; bindingHeld = false; return await owner.getBinding(request); },
        listAccounts: async request => { if (bindingHeld) listedWhileBindingHeld++; return await owner.listAccounts(request); },
      }),
    });
    const pending = runAsHostingProvider(GITHUB_PLUGIN_MANIFEST.id, 'github', () => services.resolveScmHostingTokenMaterialization?.({
      kind: 'scm_hosting_token', providerId: GITHUB_SCM_HOSTING_PROVIDER_ID, host: 'github.com', provider: githubProvider }));
    try {
      for (let turn = 0; turn < 20 && !listedWhileBindingHeld; turn++) await new Promise<void>(resolve => setImmediate(resolve));
      expect(listedWhileBindingHeld).toBe(1);
    } finally { release(); }
    await expect(pending).resolves.toMatchObject({ kind: 'available', token: 'ghp_concurrent' });
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

  it('recognizes a configured deployment beyond the old metadata ceiling', async () => {
    const service = { pluginId: GITHUB_PLUGIN_MANIFEST.id, localId: 'github-account' } as const;
    const accounts = Array.from({ length: 300 }, (_, index) => createListedDeploymentAccount(
      service,
      `account-${index}`,
      `https://forge-${index}.example.test`,
    ));
    const listAccounts = vi.fn(async (
      input: Readonly<{ limit?: number }>,
    ): Promise<ConfiguredDeploymentListing> => {
      // This transport fixture honors caller demand and reports any elision.
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

    expect(registry?.detectRemote({
      remoteName: 'origin',
      remoteUrl: 'https://forge-299.example.test/team/repository.git',
    })).toMatchObject({
      kind: 'resolved',
      providerId: GITHUB_SCM_HOSTING_PROVIDER_ID,
      provider: { baseUrl: 'https://forge-299.example.test' },
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
