import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';

import { describe, expect, it, vi } from 'vitest';

import {
  MAX_INTERACTION_TRANSIENT_CHOICES_V1,
  PluginConnectedAccountAuthenticationV2Schema,
  sealQualifiedConnectedAccountContentEnvelope,
  type PluginConnectedAccountAuthenticationV2,
  type QualifiedConnectedAccountGroupV4,
  type QualifiedConnectedAccountProfileV4,
  type QualifiedConnectedAccountPurposeBindingsV1,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';
import type {
  HostCurrentSessionInteractionsService,
  HostSessionApprovalRequest,
  HostSessionApprovalResult,
  HostSessionConfirmationRequest,
  HostSessionConfirmationResult,
  HostSessionInteractionRequest,
  HostSessionInteractionResult,
  HostSessionQuestionsRequest,
  HostSessionQuestionsResult,
} from '@/agent/runtime/state/currentSessionUiTypes';
import {
  normalizeConnectedAccountConfiguredBase,
} from '@/plugins/runtime/connectedAccounts/configuredOrigins';
import { createStablePluginConnectedAccountsHost } from '@/plugins/runtime/invocation/services/connectedAccounts';
import { listQualifiedConnectedAccountsV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import {
  createQualifiedConnectedAccountEstablishedRuntimeOwner,
  type QualifiedConnectedAccountEstablishedRuntimeOwner,
} from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { materializeQualifiedConnectedAccountLaunchUses } from '../materialize/materializeQualifiedConnectedAccountLaunchUses';
import type { ConnectedAccountPurposeBindingStore } from './ConnectedAccountPurposeBindingOwner';
import {
  createDaemonConnectedAccountPurposeBindingRuntime,
  type DaemonConnectedAccountRuntimeRegistry,
} from './createDaemonConnectedAccountPurposeBindingRuntime';

const purpose = {
  consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
  purpose: 'realtime_upstream',
} as const;
const openAiService = {
  pluginId: 'happier.voice.openai',
  localId: 'openai',
} as const;
const githubService = {
  pluginId: 'happier.scm.forge.github',
  localId: 'github-account',
} as const;
const unavailableDirectMaterial = async (): Promise<never> => {
  throw new Error('direct Team materialization must not be invoked');
};
const resolveDevelopmentSourceAuthority = ({
  pluginId,
  rootPath,
}: Readonly<{ pluginId: string; rootPath: string }>) => Object.freeze({
  kind: 'development' as const,
  registeredRootId: `purpose-binding-fixture:${pluginId}`,
  canonicalRoot: rootPath,
  observedRevision: 1,
});
const testAuthentication = PluginConnectedAccountAuthenticationV2Schema.parse({
  defaultModeId: 'api-key',
  modes: [{
    id: 'api-key',
    kind: 'manual',
    outcomeReconciliation: 'none',
    fields: [{
      id: 'token',
      title: 'Token',
      schema: { type: 'string', minLength: 1 },
      secret: true,
    }],
  }],
});
const accountScopedConfigurationAuthentication =
  PluginConnectedAccountAuthenticationV2Schema.parse({
    defaultModeId: 'configured',
    modes: [{
      id: 'configured',
      kind: 'oauthDeviceCode',
      outcomeReconciliation: 'none',
      configuration: {
        scope: 'account',
        changeBehavior: 'refresh',
        fields: [{
          id: 'tenant',
          title: 'Tenant',
          schema: { type: 'string', minLength: 1 },
          secret: false,
          default: 'main',
          required: true,
          presentation: { control: 'text' },
        }],
      },
    }],
  });
function testQualifiedProfile(input: Readonly<{
  accountId?: string;
  status?: QualifiedConnectedAccountProfileV4['status'];
  expiresAt?: number | null;
  displayName?: string;
  authenticationModeId?: string | null;
  configurationReady?: boolean;
}> = {}): QualifiedConnectedAccountProfileV4 {
  return {
    ref: { service: openAiService, accountId: input.accountId ?? 'standard-openai' },
    status: input.status ?? 'connected',
    authenticationModeId: input.authenticationModeId ?? 'api-key',
    revisionSemantics: 'revisioned',
    credentialRevision: 'csr_abcdefghijklmnopqrstuv',
    configurationReady: input.configurationReady ?? true,
    configurationRevision: null,
    kind: 'token',
    expiresAt: input.expiresAt ?? null,
    providerIdentity: {
      accountId: 'acct-standard',
      email: 'user@example.test',
    },
    displayName: input.displayName ?? 'acct-standard',
    scopes: [],
  };
}

function testQualifiedApi(input: Readonly<{
  expiresAt?: number | null;
  accounts?: readonly QualifiedConnectedAccountProfileV4[];
  group?: QualifiedConnectedAccountGroupV4;
  resultService?: QualifiedConnectedAccountProfileV4['ref']['service'];
}> = {}) {
  const accounts = input.accounts ?? [testQualifiedProfile({ expiresAt: input.expiresAt })];
  const group: QualifiedConnectedAccountGroupV4 = input.group ?? {
    v: 1,
    ref: { service: openAiService, groupId: 'primary' },
    incarnation: 'qualified-group-row-primary',
    displayName: 'Primary upstreams',
    policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
    activeConnectedAccountId: 'standard-openai',
    generation: 1,
    runtimeStateRevision: 0,
    state: {},
    createdAt: 1,
    updatedAt: 1,
    members: [{
      v: 1,
      connectedAccountId: 'standard-openai',
      priority: 1,
      enabled: true,
      state: {},
      createdAt: 1,
      updatedAt: 1,
    }],
  };
  return {
    listAccounts: vi.fn(async () => ({
      service: input.resultService ?? openAiService,
      accounts,
    })),
    listGroups: vi.fn(async () => ({ groups: [group] })),
    readGroup: vi.fn(async () => group),
  };
}

function testQualifiedGroup(input: Readonly<{
  activeAccountId: string;
  generation?: number;
  members: readonly Readonly<{
    accountId: string;
    enabled?: boolean;
  }>[];
}>): QualifiedConnectedAccountGroupV4 {
  return {
    v: 1,
    ref: { service: openAiService, groupId: 'primary' },
    incarnation: 'qualified-group-row-primary',
    displayName: 'Primary upstreams',
    policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
    activeConnectedAccountId: input.activeAccountId,
    generation: input.generation ?? 1,
    runtimeStateRevision: 0,
    state: {},
    createdAt: 1,
    updatedAt: 1,
    members: input.members.map((member, index) => ({
      v: 1,
      connectedAccountId: member.accountId,
      priority: index + 1,
      enabled: member.enabled ?? true,
      state: {},
      createdAt: 1,
      updatedAt: 1,
    })),
  };
}

function selectedStore(
  account: Readonly<{
    service: { pluginId: string; localId: string };
    accountId: string;
  }> = {
    service: openAiService,
    accountId: 'standard-openai',
  },
): ConnectedAccountPurposeBindingStore & Readonly<{
  current(): QualifiedConnectedAccountPurposeBindingsV1;
}> {
  let current: QualifiedConnectedAccountPurposeBindingsV1 = {
    v: 1,
    bindings: [{
      purpose,
      target: {
        kind: 'account',
        account,
      },
    }],
  };
  const listeners = new Set<() => void>();
  return {
    read: async () => current,
    update: async (mutate) => {
      current = mutate(current);
      for (const listener of listeners) listener();
      return current;
    },
    subscribe(listener) {
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        },
      };
    },
    current: () => current,
  };
}

function selectedGroupStore(
  groupId = 'primary',
): ConnectedAccountPurposeBindingStore & Readonly<{
  current(): QualifiedConnectedAccountPurposeBindingsV1;
}> {
  let current: QualifiedConnectedAccountPurposeBindingsV1 = {
    v: 1,
    bindings: [{
      purpose,
      target: { kind: 'group', service: openAiService, groupId },
    }],
  };
  const listeners = new Set<() => void>();
  return {
    read: async () => current,
    update: async (mutate) => {
      current = mutate(current);
      for (const listener of listeners) listener();
      return current;
    },
    subscribe(listener) {
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        },
      };
    },
    current: () => current,
  };
}

function emptyStore(): ConnectedAccountPurposeBindingStore & Readonly<{
  current(): QualifiedConnectedAccountPurposeBindingsV1;
}> {
  let current: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [] };
  const listeners = new Set<() => void>();
  return {
    read: async () => current,
    update: async (mutate) => {
      current = mutate(current);
      for (const listener of listeners) listener();
      return current;
    },
    subscribe(listener) {
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        },
      };
    },
    current: () => current,
  };
}

function unavailableConnectedAccountActivationCandidate() {
  const manifest = readCanonicalPluginManifest(createPluginManifestV2Fixture({
    id: 'acme.unavailable.connected-account',
    hostAccess: {
      required: [{
        id: 'maintain-account',
        capability: 'connectedAccounts',
        reason: 'Maintain the selected account',
        scope: {
          serviceRefs: ['account'],
          operations: ['use'],
        },
      }],
      optional: [],
    },
    contributes: {
      connectedAccountDescriptors: [{
        id: 'account',
        title: 'Account',
        authentication: {
          defaultModeId: 'manual',
          modes: [{
            id: 'manual',
            kind: 'manual',
            outcomeReconciliation: 'none',
            fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
          }],
        },
      }],
      backgroundServices: [{ id: 'maintain' }],
    },
  }));
  if (!manifest) throw new Error('Expected canonical unavailable-plugin manifest');
  return createResolvedContributionRegistry({
    activationTargets: [{
      pluginId: manifest.id,
      manifestPath: '/fixture/.happier-plugin/plugin.json',
      daemonEntryPath: '/fixture/daemon.mjs',
      manifest,
      source: { kind: 'path' },
      provenance: 'external',
      sourceSpec: {
        kind: 'path',
        locator: '/fixture',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
      },
    }],
  });
}

class TestInteractions implements HostCurrentSessionInteractionsService {
  constructor(
    private readonly handle: (
      request: HostSessionInteractionRequest,
    ) => Promise<HostSessionInteractionResult>,
  ) {}

  request(request: HostSessionApprovalRequest, options?: { signal?: AbortSignal }): Promise<HostSessionApprovalResult>;
  request(request: HostSessionQuestionsRequest, options?: { signal?: AbortSignal }): Promise<HostSessionQuestionsResult>;
  request(request: HostSessionConfirmationRequest, options?: { signal?: AbortSignal }): Promise<HostSessionConfirmationResult>;
  request(
    request: HostSessionInteractionRequest,
    _options?: { signal?: AbortSignal },
  ): Promise<HostSessionInteractionResult> {
    return this.handle(request);
  }
}

function createSelectionRuntime(
  store: ConnectedAccountPurposeBindingStore,
  v4Support: 'advertised' | 'absent' | 'indeterminate' = 'advertised',
  qualifiedApi = testQualifiedApi(),
  authentication: PluginConnectedAccountAuthenticationV2 = testAuthentication,
) {
  return createDaemonConnectedAccountPurposeBindingRuntime({
    resolveQualifiedConnectedAccountV4Support: () => v4Support,
    establishedRuntimeOwner: {
      async invokeWithReceipt() {
        throw new Error('selection must not materialize a credential');
      },
      invokeDirectMaterial: unavailableDirectMaterial,
    },
    qualifiedApi: v4Support === 'advertised' ? qualifiedApi : undefined,
    store,
    runtimeRegistry: {
      subscribe: () => () => undefined,
      async acquire() {
        return {
          isCurrent: () => true,
          resolveService: (service) => service.pluginId === openAiService.pluginId
            && service.localId === openAiService.localId
            ? {
                service: openAiService,
                availability: 'available' as const,
                authentication,
              }
            : null,
          release: vi.fn(async () => {}),
        };
      },
    },
  });
}

function createInventoryRuntime(input: Readonly<{
  accounts?: readonly QualifiedConnectedAccountProfileV4[];
  group?: QualifiedConnectedAccountGroupV4;
  store?: ConnectedAccountPurposeBindingStore;
  authentication?: PluginConnectedAccountAuthenticationV2;
  originsByAccountId?: Readonly<Record<string, readonly string[]>>;
  omitOriginReader?: boolean;
  invokeWithReceipt?: () => Promise<unknown>;
  invokeDirectMaterial?: (
    input: Parameters<QualifiedConnectedAccountEstablishedRuntimeOwner['invokeDirectMaterial']>[0],
  ) => Promise<unknown>;
  openTeamDirect?: Parameters<typeof createDaemonConnectedAccountPurposeBindingRuntime>[0]['openTeamDirect'];
  onOriginsRead?: () => void;
}> = {}) {
  const qualifiedApi = testQualifiedApi(
    input.accounts || input.group
      ? {
          ...(input.accounts ? { accounts: input.accounts } : {}),
          ...(input.group ? { group: input.group } : {}),
        }
      : {},
  );
  const invokeWithReceipt = vi.fn(input.invokeWithReceipt ?? (async () => ({
    result: { kind: 'environment' as const, env: { OPENAI_API_KEY: 'sk-listed' } },
    basis: { credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' },
  })));
  const invokeDirectMaterial = vi.fn(input.invokeDirectMaterial ?? (async () => ({
    kind: 'environment' as const,
    env: { OPENAI_API_KEY: 'sk-team-direct' },
  })));
  const resolveConnectedAccountEndpoints = vi.fn(async (
    request: Readonly<{ account: { accountId: string } }>,
  ) => {
    input.onOriginsRead?.();
    return (input.originsByAccountId?.[request.account.accountId] ?? [])
      .map((value) => normalizeConnectedAccountConfiguredBase(value));
  });
  const runtime = createDaemonConnectedAccountPurposeBindingRuntime({
    resolveQualifiedConnectedAccountV4Support: () => 'advertised',
    establishedRuntimeOwner: { invokeWithReceipt, invokeDirectMaterial } as unknown as Pick<
      QualifiedConnectedAccountEstablishedRuntimeOwner,
      'invokeWithReceipt' | 'invokeDirectMaterial'
    >,
    ...(input.openTeamDirect ? { openTeamDirect: input.openTeamDirect } : {}),
    qualifiedApi,
    ...(input.omitOriginReader ? {} : { resolveConnectedAccountEndpoints }),
    store: input.store ?? selectedStore(),
    runtimeRegistry: {
      subscribe: () => () => undefined,
      async acquire() {
        return {
          isCurrent: () => true,
          resolveService: (service) => service.pluginId === openAiService.pluginId
            && service.localId === openAiService.localId
            ? {
                service: openAiService,
                availability: 'available' as const,
                authentication: input.authentication ?? testAuthentication,
              }
            : null,
          release: vi.fn(async () => {}),
        };
      },
    },
  });
  return { runtime, qualifiedApi, invokeWithReceipt, invokeDirectMaterial, resolveConnectedAccountEndpoints };
}

function createActionFormRuntime(input: Readonly<{
  qualifiedApi?: ReturnType<typeof testQualifiedApi>;
  runtimeRegistry?: DaemonConnectedAccountRuntimeRegistry;
}> = {}) {
  return createDaemonConnectedAccountPurposeBindingRuntime({
    resolveQualifiedConnectedAccountV4Support: () => 'advertised',
    establishedRuntimeOwner: {
      async invokeWithReceipt() {
        throw new Error('Action-form option listing must not materialize a credential');
      },
      invokeDirectMaterial: unavailableDirectMaterial,
    },
    qualifiedApi: input.qualifiedApi ?? testQualifiedApi(),
    store: emptyStore(),
    runtimeRegistry: input.runtimeRegistry ?? {
      subscribe: () => () => undefined,
      async acquire() {
        return {
          isCurrent: () => true,
          resolveService: (service) => service.pluginId === openAiService.pluginId
            && service.localId === openAiService.localId
            ? {
                service: openAiService,
                availability: 'available' as const,
                authentication: testAuthentication,
              }
            : null,
          release: vi.fn(async () => {}),
        };
      },
    },
  });
}

describe('createDaemonConnectedAccountPurposeBindingRuntime', () => {
  it('refuses custodian native login for an isolated requester before invoking the OS credential owner', async () => {
    const runGhCommand = vi.fn(async () => ({ ok: true as const, stdout: 'alice-token', stderr: '', exitCode: 0 }));
    const runtime = createDaemonConnectedAccountPurposeBindingRuntime({
      store: emptyStore(), allowNativeAccountCredentials: false,
      establishedRuntimeOwner: { invokeWithReceipt: async () => { throw new Error('Unexpected stored Account read'); },
        invokeDirectMaterial: unavailableDirectMaterial },
      resolveQualifiedConnectedAccountV4Support: () => 'advertised',
      runtimeRegistry: { subscribe: () => () => undefined, acquire: async () => ({
        isCurrent: () => true, resolveService: () => ({ service: githubService, availability: 'available' as const,
          authentication: { ...testAuthentication, native: { systemTool: 'gh' as const } } }), release: async () => undefined,
      }) },
      // Genuine OS/executable boundary; purpose authorization remains real.
      ghDependencies: { resolveSystemGhBinPath: async () => '/fixture/gh', resolveManagedGhBinPath: async () => null, runGhCommand },
    });
    await expect(runtime.owner.materialize({ purpose, serviceRefs: [githubService], nativeService: githubService,
      request: { kind: 'httpHeaders', origin: 'https://api.github.com', headerNames: ['authorization'] },
      signal: new AbortController().signal })).rejects.toMatchObject({ code: 'plugin_connected_account_binding_out_of_scope' });
    expect(runGhCommand).not.toHaveBeenCalled();
  });
  it.each([
    { origin: 'https://api.github.com', hostname: 'github.com' },
    { origin: 'https://github.example.test', hostname: 'github.example.test' },
  ])('materializes machine GitHub login for $hostname without reading or writing server credentials', async ({ origin, hostname }) => {
    const store = emptyStore();
    const runtime = createDaemonConnectedAccountPurposeBindingRuntime({
      store,
      establishedRuntimeOwner: {
        invokeWithReceipt: async () => { throw new Error('Native login must not materialize a stored account'); },
        invokeDirectMaterial: unavailableDirectMaterial,
      },
      resolveQualifiedConnectedAccountV4Support: () => 'advertised',
      runtimeRegistry: {
        subscribe: () => () => undefined,
        acquire: async () => ({
          isCurrent: () => true,
          resolveService: () => ({
            service: githubService, availability: 'available' as const,
            authentication: { ...testAuthentication, native: { systemTool: 'gh' as const } },
          }),
          release: async () => undefined,
        }),
      },
      // Only executable lookup and the OS command are faked; GH selection and purpose logic are real.
      ghDependencies: {
        resolveSystemGhBinPath: async () => '/fixture/gh',
        resolveManagedGhBinPath: async () => null,
        runGhCommand: async ({ args }) => {
          expect(args).toEqual(['auth', args[1], '--hostname', hostname]);
          return { ok: true, stdout: args[1] === 'token' ? 'ephemeral-gh-token\n' : '', stderr: '', exitCode: 0 };
        },
      },
    });
    await expect(runtime.owner.materialize({
      purpose, serviceRefs: [githubService], nativeService: githubService,
      request: { kind: 'httpHeaders', origin, headerNames: ['authorization'] },
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'httpHeaders', headers: { Authorization: 'Bearer ephemeral-gh-token' } });
    expect(store.current()).toEqual({ v: 1, bindings: [] });
  });

  it('preserves Team authentication operation errors through Connected Service materialization', async () => {
    const { runtime, invokeDirectMaterial } = createInventoryRuntime({
      openTeamDirect: async () => ({
        ok: false,
        operationError: { error: 'team_authentication_policy_unavailable' },
      }),
    });
    const sessionLease = runtime.activateSessionPurposeBindings({
      sessionId: 'session-team-direct-auth', purposes: [purpose],
      bindings: [{ purpose, target: { kind: 'account', account: { service: openAiService, accountId: 'standard-openai' } } }],
      directMaterialOrigins: [{
        purpose, resourceId: 'resource-1',
        disclosedMember: { service: openAiService, accountId: 'standard-openai' },
      }],
    });

    await expect(runtime.owner.materialize({
      purpose, serviceRefs: [openAiService], sessionId: 'session-team-direct-auth',
      request: { kind: 'environment', keys: ['OPENAI_API_KEY'] }, signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'team_authentication_policy_unavailable',
      retryable: false,
      remediation: { kind: 'openSettings', path: '/settings/teams/authentication' },
    });
    expect(invokeDirectMaterial).not.toHaveBeenCalled();
    sessionLease.dispose();
  });

  it.each([
    ['temporarily_unavailable', 'plugin_connected_account_direct_material_temporarily_unavailable', true, { kind: 'retry' }],
    ['source_changed', 'plugin_connected_account_direct_material_source_changed', true, { kind: 'retry' }],
    ['recipient_binding_changed', 'plugin_connected_account_direct_material_recipient_binding_changed', false, { kind: 'openSettings', path: '/settings/account/security' }],
    ['access_removed', 'plugin_connected_account_direct_access_removed', false, { kind: 'selectAccount', service: openAiService }],
    ['unsupported_direct_source', 'plugin_connected_account_direct_material_unsupported', false, { kind: 'selectAccount', service: openAiService }],
    ['resource_corrupt', 'plugin_connected_account_direct_resource_corrupt', false, undefined],
  ] as const)(
    'preserves Team direct failure %s as Connected Account outcome %s without materialization',
    async (reason, code, retryable, remediation) => {
      const { runtime, invokeDirectMaterial } = createInventoryRuntime({
        openTeamDirect: async () => ({ ok: false, reason }),
      });
      const sessionLease = runtime.activateSessionPurposeBindings({
        sessionId: 'session-team-direct',
        purposes: [purpose],
        bindings: [{
          purpose,
          target: {
            kind: 'account',
            account: { service: openAiService, accountId: 'standard-openai' },
          },
        }],
        directMaterialOrigins: [{
          purpose,
          resourceId: 'resource-1',
          disclosedMember: { service: openAiService, accountId: 'standard-openai' },
        }],
      });

      await expect(runtime.owner.materialize({
        purpose,
        serviceRefs: [openAiService],
        sessionId: 'session-team-direct',
        request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
        signal: new AbortController().signal,
      })).rejects.toMatchObject({
        code,
        retryable,
        ...(remediation ? { remediation } : {}),
      } satisfies Partial<PluginError>);
      expect(invokeDirectMaterial).not.toHaveBeenCalled();
      sessionLease.dispose();
    },
  );

  it('preserves a typed Team direct failure from the materialization currentness check', async () => {
    let openCount = 0;
    const { runtime } = createInventoryRuntime({
      openTeamDirect: async () => {
        openCount += 1;
        if (openCount > 1) return { ok: false, reason: 'source_changed' } as const;
        return {
          ok: true,
          payload: {
            v: 1,
            domain: 'happier.team-credential-direct-material',
            homeServerIdentityId: 'home-1',
            teamId: 'team-1',
            resourceId: 'resource-1',
            resourceRevision: 1,
            recipientAccountId: 'recipient-1',
            sourceMember: {
              kind: 'connected_account',
              service: openAiService,
              connectedAccountId: 'standard-openai',
            },
            sourceVersion: 'source-version-1',
            material: {
              kind: 'qualified_connected_account',
              credential: { v: 1, values: { token: 'direct-token' } },
              configuration: null,
              authenticationModeId: 'api_key',
            },
          },
        } as const;
      },
      invokeDirectMaterial: async (input) => {
        await input.isCurrent();
        return { kind: 'environment', env: { OPENAI_API_KEY: 'should-not-return' } };
      },
    });
    const sessionLease = runtime.activateSessionPurposeBindings({
      sessionId: 'session-team-direct-currentness',
      purposes: [purpose],
      bindings: [{
        purpose,
        target: {
          kind: 'account',
          account: { service: openAiService, accountId: 'standard-openai' },
        },
      }],
      directMaterialOrigins: [{
        purpose,
        resourceId: 'resource-1',
        disclosedMember: { service: openAiService, accountId: 'standard-openai' },
      }],
    });

    await expect(runtime.owner.materialize({
      purpose,
      serviceRefs: [openAiService],
      sessionId: 'session-team-direct-currentness',
      request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'plugin_connected_account_direct_material_source_changed',
      retryable: true,
      remediation: { kind: 'retry' },
    } satisfies Partial<PluginError>);
    expect(openCount).toBe(2);
    sessionLease.dispose();
  });

  it('materializes a Session direct Team selection only through its materialization origin and the Session Team-binding admission', async () => {
    const opened: unknown[] = [];
    const disclosedMember = { service: openAiService, accountId: 'source-member' };
    const { runtime, invokeDirectMaterial } = createInventoryRuntime({
      openTeamDirect: async (request) => {
        if (!('disclosedMember' in request)) {
          throw new Error('expected a Connected Account purpose direct-material request');
        }
        opened.push({
          resourceId: request.resourceId,
          consumer: request.consumer,
          slot: request.slot,
          disclosedMember: request.disclosedMember,
        });
        return {
          ok: true,
          payload: {
            v: 1,
            domain: 'happier.team-credential-direct-material',
            homeServerIdentityId: 'home-1',
            teamId: 'team-1',
            resourceId: 'resource-1',
            resourceRevision: 1,
            recipientAccountId: 'recipient-1',
            sourceMember: {
              kind: 'connected_account',
              service: openAiService,
              connectedAccountId: 'source-member',
            },
            sourceVersion: 'source-version-1',
            material: {
              kind: 'qualified_connected_account',
              credential: { v: 1, values: { token: 'direct-token' } },
              configuration: null,
              authenticationModeId: 'api_key',
            },
          },
        } as const;
      },
    });
    const sessionLease = runtime.activateSessionPurposeBindings({
      sessionId: 'session-team-purpose',
      purposes: [purpose],
      bindings: [{ purpose, target: { kind: 'account', account: disclosedMember } }],
      directMaterialOrigins: [{ purpose, resourceId: 'resource-1', disclosedMember }],
    });

    await expect(runtime.owner.materialize({
      purpose,
      serviceRefs: [openAiService],
      sessionId: 'session-team-purpose',
      request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'environment', env: { OPENAI_API_KEY: 'sk-team-direct' } });
    expect(opened[0]).toEqual({
      resourceId: 'resource-1',
      consumer: { kind: 'session', sessionId: 'session-team-purpose' },
      slot: { kind: 'connected_service_purpose', purpose },
      disclosedMember,
    });
    expect(invokeDirectMaterial).toHaveBeenCalledOnce();
    sessionLease.dispose();
  });

  it('opens a direct Team purpose target at pre-spawn launch materialization through the Session it launches', async () => {
    const opened: unknown[] = [];
    const disclosedMember = { service: openAiService, accountId: 'source-member' };
    const { runtime, invokeDirectMaterial } = createInventoryRuntime({
      openTeamDirect: async (request) => {
        opened.push({ consumer: request.consumer, resourceId: request.resourceId });
        return {
          ok: true,
          payload: {
            v: 1,
            domain: 'happier.team-credential-direct-material',
            homeServerIdentityId: 'home-1',
            teamId: 'team-1',
            resourceId: 'resource-1',
            resourceRevision: 1,
            recipientAccountId: 'recipient-1',
            sourceMember: {
              kind: 'connected_account',
              service: openAiService,
              connectedAccountId: 'source-member',
            },
            sourceVersion: 'source-version-1',
            material: {
              kind: 'qualified_connected_account',
              credential: { v: 1, values: { token: 'direct-token' } },
              configuration: null,
              authenticationModeId: 'api_key',
            },
          },
        } as const;
      },
    });
    const bindings = [{ purpose, target: { kind: 'account' as const, account: disclosedMember } }];
    const directMaterialOrigins = [{ purpose, resourceId: 'resource-1', disclosedMember }];
    // The exact pre-spawn subject the daemon spawn owner activates: one
    // launch operation, whose direct material belongs to the committed Session.
    const launchLease = runtime.activatePurposeBindings({
      subject: {
        kind: 'operation',
        operationId: 'materialization-identity-1',
        consumer: purpose.consumer,
        sessionId: 'session-committed-before-launch',
        isCurrent: () => true,
      },
      purposes: [purpose],
      bindings,
      directMaterialOrigins,
    });

    await expect(materializeQualifiedConnectedAccountLaunchUses({
      connectedAccountsOwner: runtime.owner,
      snapshot: {
        purposes: [purpose],
        bindings,
        environmentUses: [{ purpose, serviceRefs: [openAiService], environmentKey: 'OPENAI_API_KEY' }],
      },
      exactPurposeBindingSubjectId: launchLease.subjectId,
      signal: new AbortController().signal,
    })).resolves.toEqual({ OPENAI_API_KEY: 'sk-team-direct' });
    expect(opened[0]).toEqual({
      consumer: { kind: 'session', sessionId: 'session-committed-before-launch' },
      resourceId: 'resource-1',
    });
    expect(invokeDirectMaterial).toHaveBeenCalledOnce();
    launchLease.dispose();

    // An operation that launches no Session has no Home-admitted consumer.
    expect(() => runtime.activatePurposeBindings({
      subject: {
        kind: 'operation',
        operationId: 'materialization-identity-2',
        consumer: purpose.consumer,
        isCurrent: () => true,
      },
      purposes: [purpose],
      bindings,
      directMaterialOrigins,
    })).toThrow('connected_account_operation_binding_direct_material_consumer_unsupported');
  });

  it('lists only safe exact refs for an Action form purpose scope', async () => {
    const runtimeOwner = createSelectionRuntime(emptyStore());

    await expect(runtimeOwner.listActionFormConnectedAccountOptions({
      purpose,
      serviceRefs: [openAiService],
      signal: new AbortController().signal,
    })).resolves.toEqual([{
      value: {
        service: openAiService,
        accountId: 'standard-openai',
      },
      label: 'acct-standard',
    }]);
  });

  it('omits disconnected and expired accounts from Action-form options', async () => {
    const runtimeOwner = createActionFormRuntime({
      qualifiedApi: testQualifiedApi({
        accounts: [
          testQualifiedProfile({ accountId: 'expired', expiresAt: Date.now() - 1 }),
          testQualifiedProfile({ accountId: 'reauth', status: 'needs_reauth' }),
        ],
      }),
    });

    await expect(runtimeOwner.listActionFormConnectedAccountOptions({
      purpose,
      serviceRefs: [openAiService],
      signal: new AbortController().signal,
    })).resolves.toEqual([]);
  });

  it('omits legacy-unfenced V4 accounts from Action-form options', async () => {
    const legacyUnfenced: QualifiedConnectedAccountProfileV4 = {
      ...testQualifiedProfile(),
      revisionSemantics: 'legacy_unfenced',
      credentialRevision: null,
    };
    const runtimeOwner = createActionFormRuntime({
      qualifiedApi: testQualifiedApi({ accounts: [legacyUnfenced] }),
    });

    await expect(runtimeOwner.listActionFormConnectedAccountOptions({
      purpose,
      serviceRefs: [openAiService],
      signal: new AbortController().signal,
    })).resolves.toEqual([]);
  });

  it('deduplicates repeated authorized service inventory results by exact qualified ref', async () => {
    const qualifiedApi = testQualifiedApi();
    const runtimeOwner = createActionFormRuntime({ qualifiedApi });

    await expect(runtimeOwner.listActionFormConnectedAccountOptions({
      purpose,
      serviceRefs: [openAiService, openAiService],
      signal: new AbortController().signal,
    })).resolves.toEqual([{
      value: { service: openAiService, accountId: 'standard-openai' },
      label: 'acct-standard',
    }]);
    expect(qualifiedApi.listAccounts).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the authorized Action-form inventory exceeds its bounded response', async () => {
    const runtimeOwner = createActionFormRuntime({
      qualifiedApi: testQualifiedApi({
        accounts: Array.from({ length: 257 }, (_, index) => testQualifiedProfile({
          accountId: `account-${index}`,
          displayName: `Account ${index}`,
        })),
      }),
    });

    await expect(runtimeOwner.listActionFormConnectedAccountOptions({
      purpose,
      serviceRefs: [openAiService],
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'plugin_ui_unavailable',
    } satisfies Partial<PluginError>);
  });

  it('rejects inventory that is no longer current after an account-list await', async () => {
    let current = true;
    const runtimeRegistry: DaemonConnectedAccountRuntimeRegistry = {
      subscribe: () => () => undefined,
      async acquire() {
        return {
          isCurrent: () => current,
          resolveService: () => ({
            service: openAiService,
            availability: 'available',
            authentication: testAuthentication,
          }),
          release: vi.fn(async () => {}),
        };
      },
    };
    const qualifiedApi = testQualifiedApi();
    qualifiedApi.listAccounts.mockImplementation(async () => {
      current = false;
      return {
        service: openAiService,
        accounts: [testQualifiedProfile()],
      };
    });
    const runtimeOwner = createActionFormRuntime({ runtimeRegistry, qualifiedApi });

    await expect(runtimeOwner.listActionFormConnectedAccountOptions({
      purpose,
      serviceRefs: [openAiService],
      signal: new AbortController().signal,
    })).rejects.toThrow('no longer current');
  });

  it('rejects an inventory response for a different Connected Account service', async () => {
    const runtimeOwner = createActionFormRuntime({
      qualifiedApi: testQualifiedApi({ resultService: githubService }),
    });

    await expect(runtimeOwner.listActionFormConnectedAccountOptions({
      purpose,
      serviceRefs: [openAiService],
      signal: new AbortController().signal,
    })).rejects.toThrow('different service');
  });

  it('publishes projection invalidation through the canonical host subscription and detaches it', () => {
    const runtimeOwner = createSelectionRuntime(selectedStore());
    const listener = vi.fn();
    const detach = runtimeOwner.subscribeInvalidations(listener);

    runtimeOwner.invalidate();
    expect(listener).toHaveBeenCalledOnce();

    detach();
    runtimeOwner.invalidate();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('preserves a machine B binding omitted from machine A\'s cold registry before publishing', async () => {
    const backingStore = selectedStore();
    let updateCalls = 0;
    const store: ConnectedAccountPurposeBindingStore & Readonly<{
      current(): QualifiedConnectedAccountPurposeBindingsV1;
    }> = {
      read: backingStore.read,
      async update(mutate, signal) {
        updateCalls += 1;
        return await backingStore.update(mutate, signal);
      },
      subscribe: backingStore.subscribe,
      current: backingStore.current,
    };
    const runtimeOwner = createSelectionRuntime(store);
    const publish = vi.fn();
    const persisted = store.current();

    await runtimeOwner.reconcileRegistryPublication({
      previous: null,
      candidate: createResolvedContributionRegistry({}),
      resolveOptionalAccess: () => [],
      publish,
    });

    expect(publish).toHaveBeenCalledOnce();
    expect(updateCalls).toBe(0);
    expect(store.current()).toEqual(persisted);
  });

  it('contracts a persisted binding after an authoritative local uninstall', async () => {
    const previous = unavailableConnectedAccountActivationCandidate();
    const consumer = {
      pluginId: 'acme.unavailable.connected-account',
      localId: 'maintain',
    } as const;
    const persisted: QualifiedConnectedAccountPurposeBindingsV1 = {
      v: 1,
      bindings: [{
        purpose: {
          consumer,
          purpose: 'maintain-account',
        },
        target: {
          kind: 'account',
          account: {
            service: { pluginId: consumer.pluginId, localId: 'account' },
            accountId: 'retained-account',
          },
        },
      }],
    };
    let current = persisted;
    let updateCalls = 0;
    const store: ConnectedAccountPurposeBindingStore = {
      read: async () => current,
      async update(mutate, signal) {
        updateCalls += 1;
        current = mutate(current);
        signal?.throwIfAborted();
        return current;
      },
      subscribe() {
        return { dispose() {} };
      },
    };
    const runtimeOwner = createSelectionRuntime(store);
    const publish = vi.fn();

    await runtimeOwner.reconcileRegistryPublication({
      previous,
      candidate: createResolvedContributionRegistry({}),
      resolveOptionalAccess: () => [],
      publish,
    });

    expect(updateCalls).toBe(1);
    expect(current.bindings).toEqual([]);
    expect(publish).toHaveBeenCalledOnce();
  });

  it('publishes cold startup without a Settings mutation for a declared but unavailable plugin consumer', async () => {
    const candidate = unavailableConnectedAccountActivationCandidate();
    const consumer = {
      pluginId: 'acme.unavailable.connected-account',
      localId: 'maintain',
    } as const;
    const persisted: QualifiedConnectedAccountPurposeBindingsV1 = {
      v: 1,
      bindings: [{
        purpose: {
          consumer,
          purpose: 'maintain-account',
        },
        target: {
          kind: 'account',
          account: {
            service: { pluginId: consumer.pluginId, localId: 'account' },
            accountId: 'retained-account',
          },
        },
      }],
    };
    let updateCalls = 0;
    const store: ConnectedAccountPurposeBindingStore = {
      read: async () => persisted,
      async update() {
        updateCalls += 1;
        throw new Error('Connected Account binding settings are unavailable');
      },
      subscribe() {
        return { dispose() {} };
      },
    };
    const runtimeOwner = createSelectionRuntime(store);
    const publish = vi.fn();

    await expect(runtimeOwner.reconcileRegistryPublication({
      previous: null,
      candidate,
      candidateActivePluginIds: new Set(),
      resolveOptionalAccess: () => [],
      publish,
    })).resolves.toBeUndefined();

    expect(updateCalls).toBe(0);
    expect(publish).toHaveBeenCalledOnce();
  });

  it('materializes the exact selected qualified OpenAI account through the current plugin generation', async () => {
    const listeners = new Set<() => void>();
    let generationCurrent = true;
    const invokeWithReceipt = vi.fn(async () => ({
      result: { kind: 'environment' as const, env: { OPENAI_API_KEY: 'sk-standard' } },
      basis: { credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' },
    }));
    const runtimeOwner = createDaemonConnectedAccountPurposeBindingRuntime({
      resolveQualifiedConnectedAccountV4Support: () => 'advertised',
      // This fixture exercises only environment materialization.
      establishedRuntimeOwner: { invokeWithReceipt, invokeDirectMaterial: unavailableDirectMaterial } as unknown as Pick<
        QualifiedConnectedAccountEstablishedRuntimeOwner,
        'invokeWithReceipt' | 'invokeDirectMaterial'
      >,
      qualifiedApi: testQualifiedApi(),
      store: selectedStore(),
      runtimeRegistry: {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async acquire() {
          return {
            isCurrent: () => generationCurrent,
            resolveService: (service) => service.pluginId === openAiService.pluginId
              && service.localId === openAiService.localId
              ? {
                  service: openAiService,
                  availability: 'available' as const,
                  authentication: testAuthentication,
                }
              : null,
            release: vi.fn(async () => {}),
          };
        },
      },
    });
    const signal = new AbortController().signal;
    const requestSessionRestart = vi.fn();
    runtimeOwner.bindSessionRestartOwner(requestSessionRestart);

    await expect(runtimeOwner.owner.getBinding({
      purpose,
      serviceRefs: [openAiService],
      signal,
    })).resolves.toEqual({
      purpose: 'realtime_upstream',
      service: openAiService,
      account: { service: openAiService, accountId: 'standard-openai' },
      target: { kind: 'account', displayName: 'acct-standard' },
    });
    await expect(runtimeOwner.owner.materialize({
      purpose,
      serviceRefs: [openAiService],
      request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
      signal,
    })).resolves.toEqual({
      kind: 'environment',
      env: { OPENAI_API_KEY: 'sk-standard' },
    });
    expect(invokeWithReceipt).toHaveBeenCalledOnce();
    expect(invokeWithReceipt).toHaveBeenCalledWith(expect.objectContaining({
      account: { service: openAiService, accountId: 'standard-openai' },
      operation: {
        kind: 'materialize',
        request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
      },
    }));

    const deliveryReleases: Array<() => void> = [];
    const invalidated = vi.fn(() => new Promise<void>((resolve) => {
      deliveryReleases.push(resolve);
    }));
    const invocationController = new AbortController();
    const connectedAccounts = createStablePluginConnectedAccountsHost(runtimeOwner.owner).bind({
      plugin: { id: purpose.consumer.pluginId, version: '1.0.0' },
      contribution: {
        id: purpose.consumer.localId,
        qualifiedId: `${purpose.consumer.pluginId}/agents/${purpose.consumer.localId}`,
      },
      occurrenceId: 'generation-1',
      correlationId: 'correlation-1',
      surface: 'agent',
      session: { id: 'session-1' },
      signal: invocationController.signal,
      isOccurrenceCurrent: () => !invocationController.signal.aborted,
    }, [{
      purpose: purpose.purpose,
      serviceRefs: [openAiService],
      operations: ['use'],
    }]);
    const watch = connectedAccounts.watch(purpose.purpose, invalidated);
    await vi.waitFor(() => expect(invalidated).toHaveBeenCalledOnce());
    expect(requestSessionRestart).not.toHaveBeenCalled();
    deliveryReleases.shift()?.();
    await Promise.resolve();

    runtimeOwner.invalidate();
    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(invalidated).toHaveBeenCalledTimes(2));
    expect(requestSessionRestart).not.toHaveBeenCalled();
    deliveryReleases.shift()?.();
    await vi.waitFor(() => expect(requestSessionRestart).toHaveBeenCalledOnce());
    expect(requestSessionRestart).toHaveBeenCalledWith({
      sessionId: 'session-1',
      purpose,
    });
    watch.dispose();

    generationCurrent = false;
    await expect(runtimeOwner.owner.materialize({
      purpose,
      serviceRefs: [openAiService],
      request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
      signal,
    })).rejects.toThrow('no longer current');
  });

  it('rejects a connected but expired exact qualified account before V4 materialization', async () => {
    const invokeWithReceipt = vi.fn(async () => ({
      result: {
        kind: 'environment' as const,
        env: { OPENAI_API_KEY: 'must-not-materialize' },
      },
      basis: { credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' },
    }));
    const runtimeOwner = createDaemonConnectedAccountPurposeBindingRuntime({
      resolveQualifiedConnectedAccountV4Support: () => 'advertised',
      // This fixture rejects before any established operation can run.
      establishedRuntimeOwner: { invokeWithReceipt, invokeDirectMaterial: unavailableDirectMaterial } as unknown as Pick<
        QualifiedConnectedAccountEstablishedRuntimeOwner,
        'invokeWithReceipt' | 'invokeDirectMaterial'
      >,
      qualifiedApi: testQualifiedApi({ expiresAt: Date.now() - 1 }),
      store: selectedStore(),
      runtimeRegistry: {
        subscribe: () => () => undefined,
        async acquire() {
          return {
            isCurrent: () => true,
            resolveService: (service) => service.pluginId === openAiService.pluginId
              && service.localId === openAiService.localId
              ? {
                  service: openAiService,
                  availability: 'available' as const,
                  authentication: testAuthentication,
                }
              : null,
            release: vi.fn(async () => {}),
          };
        },
      },
    });

    await expect(runtimeOwner.owner.materialize({
      purpose,
      serviceRefs: [openAiService],
      expectedAccount: { service: openAiService, accountId: 'standard-openai' },
      request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'plugin_host_access_resource_not_selected',
    });
    expect(invokeWithReceipt).not.toHaveBeenCalled();
  });

  it('fails owned-account materialization closed when the qualified inventory is unavailable', async () => {
    const runtimeOwner = createSelectionRuntime(selectedStore(), 'absent');

    await expect(runtimeOwner.owner.materialize({
      purpose,
      serviceRefs: [openAiService],
      request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      name: 'PluginError',
      code: 'plugin_host_access_resource_not_selected',
      retryable: false,
    });
  });

  it('reads current qualified GitHub credentials through the real purpose owner and registered runtime leaf', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-purpose-github-account-'),
    );
    const registry = await resolveExecutablePluginRuntimeRegistry({
      happyHomeDir,
      pluginIds: [githubService.pluginId],
      resolveDevelopmentSourceAuthority,
    });
    let generationCurrent = true;
    const release = vi.fn(async () => undefined);
    const reloadController = {
      async acquireRuntimeRegistry() {
        return {
          registry,
          source: 'active' as const,
          durableRevision: registry.durableRevision ?? -1,
          release,
        };
      },
      isRuntimeRegistryCurrent(candidate: typeof registry) {
        return generationCurrent && candidate === registry;
      },
      subscribe() {
        return () => undefined;
      },
    };
    const account = { service: githubService, accountId: 'github-work' };
    const profile: QualifiedConnectedAccountProfileV4 = {
      ref: account,
      authenticationModeId: 'fine-grained-pat',
      status: 'connected',
      kind: 'token',
      revisionSemantics: 'revisioned',
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      configurationRevision: null,
      configurationReady: true,
      expiresAt: null,
      providerIdentity: { accountId: 'github-account-id' },
      scopes: [],
    };
    const credentialContent = sealQualifiedConnectedAccountContentEnvelope({
      kind: 'credential',
      accountMode: 'plain',
      payload: { v: 1, values: { token: 'github-token' } },
      randomBytes: (length) => new Uint8Array(length),
    });
    let driftAfterFirstCredentialRead = false;
    let credentialReads = 0;
    // HTTP is the boundary: keep the qualified parser, persistence reader and runtime real.
    const credentialHttp = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (url.includes('/v4/connect/qualified/accounts?')) {
        return { status: 200, data: { service: githubService, accounts: [profile] } };
      }
      if (!url.includes('/v4/connect/qualified/credential?')) {
        throw new Error(`Unexpected Connected Account route: ${url}`);
      }
      credentialReads += 1;
      return {
        status: 200,
        data: {
          ref: account,
          authenticationModeId: 'fine-grained-pat',
          revisionSemantics: 'revisioned',
          credentialRevision: driftAfterFirstCredentialRead && credentialReads > 1
            ? 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1'
            : 'csr_0123456789ABCDEFGHJKMNPQRS',
          configurationRevision: null,
          content: credentialContent,
          metadata: { scopes: [] },
        },
      };
    });
    const configuration = {
      read: vi.fn(async () => null),
      secrets: {
        admit: vi.fn(async () => undefined),
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
    };
    const credentials = {
      token: 'happier-token',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array([1, 2, 3]),
      },
    };
    const establishedRuntimeOwner =
      createQualifiedConnectedAccountEstablishedRuntimeOwner({
        reloadController,
        credentials,
        getAccountEncryptionMode: async () => 'plain',
        configuration,
      });
    const runtimeOwner = createDaemonConnectedAccountPurposeBindingRuntime({
      establishedRuntimeOwner,
      resolveQualifiedConnectedAccountV4Support: () => 'advertised',
      qualifiedApi: {
        ...testQualifiedApi(),
        async listAccounts(service, signal) {
          return await listQualifiedConnectedAccountsV4({
            token: credentials.token,
            service,
            signal,
          });
        },
      },
      store: selectedStore({
        service: githubService,
        accountId: 'github-work',
      }),
      reloadController,
    });
    const materializationRequest = {
      kind: 'httpHeaders' as const,
      origin: 'https://github.com',
      headerNames: ['authorization'],
    };

    try {
      await expect(runtimeOwner.owner.materialize({
        purpose,
        serviceRefs: [githubService],
        request: materializationRequest,
        signal: new AbortController().signal,
      })).resolves.toEqual({
        kind: 'httpHeaders',
        headers: { Authorization: 'Bearer github-token' },
      });
      expect(credentialHttp).toHaveBeenCalled();

      credentialReads = 0;
      driftAfterFirstCredentialRead = true;
      await expect(runtimeOwner.owner.materialize({
        purpose,
        serviceRefs: [githubService],
        request: materializationRequest,
        signal: new AbortController().signal,
      })).rejects.toThrow('no longer current');

      driftAfterFirstCredentialRead = false;
      const profileReadsBeforeRetirement =
        credentialHttp.mock.calls.length;
      generationCurrent = false;
      await expect(runtimeOwner.owner.materialize({
        purpose,
        serviceRefs: [githubService],
        request: materializationRequest,
        signal: new AbortController().signal,
      })).rejects.toThrow('no longer current');
      expect(credentialHttp).toHaveBeenCalledTimes(
        profileReadsBeforeRetirement,
      );
    } finally {
      credentialHttp.mockRestore();
      await registry.dispose();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('materializes the declared OpenAI API-key descriptor through its registered plugin runtime', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-purpose-account-'));
    const registry = await resolveExecutablePluginRuntimeRegistry({
      happyHomeDir,
      pluginIds: [openAiService.pluginId],
      resolveDevelopmentSourceAuthority,
    });
    let generationCurrent = true;
    const release = vi.fn(async () => undefined);
    const reloadController = {
      async acquireRuntimeRegistry() {
        return {
          registry,
          source: 'active' as const,
          durableRevision: registry.durableRevision ?? -1,
          release,
        };
      },
      isRuntimeRegistryCurrent(candidate: typeof registry) {
        return generationCurrent && candidate === registry;
      },
      subscribe() {
        return () => undefined;
      },
    };
    const credentialContent = sealQualifiedConnectedAccountContentEnvelope({
      kind: 'credential',
      accountMode: 'plain',
      payload: {
        v: 1,
        values: { token: 'sk-host-adapter' },
      },
      randomBytes: (length) => new Uint8Array(length),
    });
    const readCredential = vi.fn(async () => ({
      ref: {
        service: openAiService,
        accountId: 'standard-openai',
      },
      authenticationModeId: 'api-key',
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'credential-1',
      configurationRevision: null,
      content: credentialContent,
      metadata: { scopes: [] },
    }));
    const readConfiguration = vi.fn(async () => null);
    const establishedRuntimeOwner =
      createQualifiedConnectedAccountEstablishedRuntimeOwner({
        reloadController,
        credentials: {
          token: 'happier-token',
          encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
        },
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        readCredential,
        readConfiguration,
        configuration: {
          read: vi.fn(async () => null),
          secrets: {
            admit: vi.fn(async () => undefined),
            has: vi.fn(async () => false),
            read: vi.fn(async () => null),
          },
        },
      });
    const runtimeOwner = createDaemonConnectedAccountPurposeBindingRuntime({
      resolveQualifiedConnectedAccountV4Support: () => 'advertised',
      establishedRuntimeOwner,
      qualifiedApi: testQualifiedApi(),
      store: selectedStore(),
      reloadController,
    });
    const signal = new AbortController().signal;

    try {
      await expect(runtimeOwner.owner.materialize({
        purpose,
        serviceRefs: [openAiService],
        request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
        signal,
      })).resolves.toEqual({
        kind: 'environment',
        env: { OPENAI_API_KEY: 'sk-host-adapter' },
      });
      await expect(runtimeOwner.owner.materialize({
        purpose,
        serviceRefs: [openAiService],
        request: {
          kind: 'httpHeaders',
          origin: 'https://api.openai.com',
          headerNames: ['authorization'],
        },
        signal,
      })).resolves.toEqual({
        kind: 'httpHeaders',
        headers: { Authorization: 'Bearer sk-host-adapter' },
      });
      await expect(runtimeOwner.owner.materialize({
        purpose,
        serviceRefs: [openAiService],
        request: {
          kind: 'httpHeaders',
          origin: 'https://example.test',
          headerNames: ['authorization'],
        },
        signal,
      })).rejects.toThrow(/origin/i);
      expect(readCredential).toHaveBeenCalled();
      expect(readConfiguration).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalled();

      generationCurrent = false;
      await expect(runtimeOwner.owner.materialize({
        purpose,
        serviceRefs: [openAiService],
        request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
        signal,
      })).rejects.toThrow('no longer current');
    } finally {
      await registry.dispose();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('asks through the current-session interaction owner and persists the exact authorized target', async () => {
    const store = emptyStore();
    const seenRequests: HostSessionInteractionRequest[] = [];
    const interactions = new TestInteractions(async (request) => {
      seenRequests.push(request);
      if (request.kind !== 'questions') throw new Error('questions expected');
      const question = request.questions[0];
      if (!question || question.type !== 'singleChoice') throw new Error('single choice expected');
      const chosen = question.choices.find((choice) => choice.label === 'Primary upstreams');
      if (!chosen) throw new Error('group choice expected');
      return {
        requestId: 'test-request-1',
        kind: 'questions',
        status: 'answered',
        answers: {
          [question.id]: {
            kind: 'singleChoice',
            answer: { kind: 'choice', choiceId: chosen.id },
          },
        },
      };
    });
    const runtimeOwner = createSelectionRuntime(store);

    await expect(runtimeOwner.owner.requestSelection({
      purpose,
      serviceRefs: [openAiService],
      currentSession: { interactions },
      assertGenerationCurrent: () => undefined,
      reason: 'Choose realtime auth',
      signal: new AbortController().signal,
    })).resolves.toEqual({
      purpose: 'realtime_upstream',
      service: openAiService,
      account: {
        service: openAiService,
        accountId: 'standard-openai',
      },
      target: { kind: 'group', displayName: 'Primary upstreams' },
    });

    expect(seenRequests).toHaveLength(1);
    expect(JSON.stringify(seenRequests[0])).not.toContain('needs-reauth');
    expect(store.current()).toEqual({
      v: 1,
      bindings: [{
        purpose,
        target: {
          kind: 'group',
          service: openAiService,
          groupId: 'primary',
        },
      }],
    });
  });

  it.each([64, 65, 256, 501])(
    'pages %i authorized targets through bounded transient questions',
    async (candidateCount) => {
      const store = emptyStore();
      const seenRequests: HostSessionQuestionsRequest[] = [];
      const interactions = new TestInteractions(async (request) => {
        if (request.kind !== 'questions') throw new Error('questions expected');
        seenRequests.push(request);
        const question = request.questions[0];
        if (!question || question.type !== 'singleChoice') {
          throw new Error('single choice expected');
        }
        expect(question.choices.length).toBeLessThanOrEqual(
          MAX_INTERACTION_TRANSIENT_CHOICES_V1,
        );
        const target = question.choices.find(
          (choice) => choice.label === `Account ${candidateCount - 1}`,
        );
        const choice = target ?? question.choices.find((candidate) => candidate.label === 'Next page');
        if (!choice) throw new Error('target or next-page choice expected');
        return {
          requestId: `test-request-${seenRequests.length}`,
          kind: 'questions',
          status: 'answered',
          answers: {
            [question.id]: {
              kind: 'singleChoice',
              answer: { kind: 'choice', choiceId: choice.id },
            },
          },
        };
      });
      const runtimeOwner = createSelectionRuntime(
        store,
        'advertised',
        testQualifiedApi({
          accounts: Array.from({ length: candidateCount }, (_, index) =>
            testQualifiedProfile({
              accountId: `account-${index}`,
              displayName: `Account ${index}`,
            })),
        }),
      );

      await expect(runtimeOwner.owner.requestSelection({
        purpose,
        serviceRefs: [openAiService],
        currentSession: { interactions },
        assertGenerationCurrent: () => undefined,
        reason: 'Choose realtime auth',
        signal: new AbortController().signal,
      })).resolves.toMatchObject({
        account: { accountId: `account-${candidateCount - 1}` },
      });

      expect(seenRequests).toHaveLength(
        candidateCount <= MAX_INTERACTION_TRANSIENT_CHOICES_V1
          ? 1
          : Math.ceil(candidateCount / (MAX_INTERACTION_TRANSIENT_CHOICES_V1 - 2)),
      );
      expect(store.current().bindings).toEqual([{
        purpose,
        target: {
          kind: 'account',
          account: {
            service: openAiService,
            accountId: `account-${candidateCount - 1}`,
          },
        },
      }]);
    },
  );

  it('supports previous and next navigation without changing candidate authority', async () => {
    const store = emptyStore();
    const visitedPages: string[][] = [];
    const interactions = new TestInteractions(async (request) => {
      if (request.kind !== 'questions') throw new Error('questions expected');
      const question = request.questions[0];
      if (!question || question.type !== 'singleChoice') throw new Error('single choice expected');
      visitedPages.push(question.choices.map((choice) => choice.label ?? choice.id));
      const desiredLabel = visitedPages.length === 1
        ? 'Next page'
        : visitedPages.length === 2
          ? 'Previous page'
          : visitedPages.length === 3
            ? 'Next page'
            : 'Account 64';
      const choice = question.choices.find((candidate) => candidate.label === desiredLabel);
      if (!choice) throw new Error(`${desiredLabel} choice expected`);
      return {
        requestId: `test-request-${visitedPages.length}`,
        kind: 'questions',
        status: 'answered',
        answers: {
          [question.id]: {
            kind: 'singleChoice',
            answer: { kind: 'choice', choiceId: choice.id },
          },
        },
      };
    });
    const runtimeOwner = createSelectionRuntime(
      store,
      'advertised',
      testQualifiedApi({
        accounts: Array.from({ length: 65 }, (_, index) => testQualifiedProfile({
          accountId: `account-${index}`,
          displayName: `Account ${index}`,
        })),
      }),
    );

    await expect(runtimeOwner.owner.requestSelection({
      purpose,
      serviceRefs: [openAiService],
      currentSession: { interactions },
      assertGenerationCurrent: () => undefined,
      reason: 'Choose realtime auth',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ account: { accountId: 'account-64' } });
    expect(visitedPages).toHaveLength(4);
  });

  it('rejects a choice id replayed from a different page', async () => {
    const store = emptyStore();
    let firstPageTargetId: string | null = null;
    let requestCount = 0;
    const interactions = new TestInteractions(async (request) => {
      if (request.kind !== 'questions') throw new Error('questions expected');
      const question = request.questions[0];
      if (!question || question.type !== 'singleChoice') throw new Error('single choice expected');
      requestCount += 1;
      if (requestCount === 1) {
        firstPageTargetId = question.choices[0]?.id ?? null;
        const next = question.choices.find((choice) => choice.label === 'Next page');
        if (!next) throw new Error('next-page choice expected');
        return {
          requestId: 'test-request-1',
          kind: 'questions',
          status: 'answered',
          answers: {
            [question.id]: {
              kind: 'singleChoice',
              answer: { kind: 'choice', choiceId: next.id },
            },
          },
        };
      }
      if (!firstPageTargetId) throw new Error('first-page target id expected');
      return {
        requestId: 'test-request-2',
        kind: 'questions',
        status: 'answered',
        answers: {
          [question.id]: {
            kind: 'singleChoice',
            answer: { kind: 'choice', choiceId: firstPageTargetId },
          },
        },
      };
    });
    const runtimeOwner = createSelectionRuntime(
      store,
      'advertised',
      testQualifiedApi({
        accounts: Array.from({ length: 65 }, (_, index) => testQualifiedProfile({
          accountId: `account-${index}`,
          displayName: `Account ${index}`,
        })),
      }),
    );

    await expect(runtimeOwner.owner.requestSelection({
      purpose,
      serviceRefs: [openAiService],
      currentSession: { interactions },
      assertGenerationCurrent: () => undefined,
      reason: 'Choose realtime auth',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'plugin_connected_account_binding_out_of_scope',
    } satisfies Partial<PluginError>);
    expect(store.current().bindings).toEqual([]);
  });

  it('preserves typed cancellation on a later selection page', async () => {
    const store = emptyStore();
    let requestCount = 0;
    const interactions = new TestInteractions(async (request) => {
      if (request.kind !== 'questions') throw new Error('questions expected');
      requestCount += 1;
      if (requestCount === 2) {
        return { requestId: 'test-request-2', kind: 'questions', status: 'userCancelled' };
      }
      const question = request.questions[0];
      if (!question || question.type !== 'singleChoice') throw new Error('single choice expected');
      const next = question.choices.find((choice) => choice.label === 'Next page');
      if (!next) throw new Error('next-page choice expected');
      return {
        requestId: 'test-request-1',
        kind: 'questions',
        status: 'answered',
        answers: {
          [question.id]: {
            kind: 'singleChoice',
            answer: { kind: 'choice', choiceId: next.id },
          },
        },
      };
    });
    const runtimeOwner = createSelectionRuntime(
      store,
      'advertised',
      testQualifiedApi({
        accounts: Array.from({ length: 65 }, (_, index) => testQualifiedProfile({
          accountId: `account-${index}`,
        })),
      }),
    );

    await expect(runtimeOwner.owner.requestSelection({
      purpose,
      serviceRefs: [openAiService],
      currentSession: { interactions },
      assertGenerationCurrent: () => undefined,
      reason: 'Choose realtime auth',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'plugin_ui_cancelled' } satisfies Partial<PluginError>);
    expect(requestCount).toBe(2);
    expect(store.current().bindings).toEqual([]);
  });

  it('stops paging with the exact generation-retirement failure', async () => {
    const store = emptyStore();
    let current = true;
    let requestCount = 0;
    const retired = new PluginError({
      code: 'plugin_final_generation_retired',
      message: 'Plugin generation is no longer current',
    });
    const interactions = new TestInteractions(async (request) => {
      if (request.kind !== 'questions') throw new Error('questions expected');
      requestCount += 1;
      const question = request.questions[0];
      if (!question || question.type !== 'singleChoice') throw new Error('single choice expected');
      const next = question.choices.find((choice) => choice.label === 'Next page');
      if (!next) throw new Error('next-page choice expected');
      current = false;
      return {
        requestId: 'test-request-1',
        kind: 'questions',
        status: 'answered',
        answers: {
          [question.id]: {
            kind: 'singleChoice',
            answer: { kind: 'choice', choiceId: next.id },
          },
        },
      };
    });
    const runtimeOwner = createSelectionRuntime(
      store,
      'advertised',
      testQualifiedApi({
        accounts: Array.from({ length: 65 }, (_, index) => testQualifiedProfile({
          accountId: `account-${index}`,
        })),
      }),
    );

    await expect(runtimeOwner.owner.requestSelection({
      purpose,
      serviceRefs: [openAiService],
      currentSession: { interactions },
      assertGenerationCurrent: () => {
        if (!current) throw retired;
      },
      reason: 'Choose realtime auth',
      signal: new AbortController().signal,
    })).rejects.toBe(retired);
    expect(requestCount).toBe(1);
    expect(store.current().bindings).toEqual([]);
  });

  it('preserves requester abort while advancing pages', async () => {
    const store = emptyStore();
    const abort = new AbortController();
    let requestCount = 0;
    const interactions = new TestInteractions(async (request) => {
      if (request.kind !== 'questions') throw new Error('questions expected');
      requestCount += 1;
      const question = request.questions[0];
      if (!question || question.type !== 'singleChoice') throw new Error('single choice expected');
      const next = question.choices.find((choice) => choice.label === 'Next page');
      if (!next) throw new Error('next-page choice expected');
      abort.abort();
      return {
        requestId: 'test-request-1',
        kind: 'questions',
        status: 'answered',
        answers: {
          [question.id]: {
            kind: 'singleChoice',
            answer: { kind: 'choice', choiceId: next.id },
          },
        },
      };
    });
    const runtimeOwner = createSelectionRuntime(
      store,
      'advertised',
      testQualifiedApi({
        accounts: Array.from({ length: 65 }, (_, index) => testQualifiedProfile({
          accountId: `account-${index}`,
        })),
      }),
    );

    await expect(runtimeOwner.owner.requestSelection({
      purpose,
      serviceRefs: [openAiService],
      currentSession: { interactions },
      assertGenerationCurrent: () => undefined,
      reason: 'Choose realtime auth',
      signal: abort.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestCount).toBe(1);
    expect(store.current().bindings).toEqual([]);
  });

  it('does not offer an expired account through the incumbent interactive selection path', async () => {
    const interactions = new TestInteractions(async () => {
      throw new Error('Expired accounts must be filtered before a question is presented');
    });
    const runtimeOwner = createSelectionRuntime(
      emptyStore(),
      'advertised',
      testQualifiedApi({ expiresAt: Date.now() - 1 }),
    );

    await expect(runtimeOwner.owner.requestSelection({
      purpose,
      serviceRefs: [openAiService],
      currentSession: { interactions },
      assertGenerationCurrent: () => undefined,
      reason: 'Choose realtime auth',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'plugin_host_access_resource_not_selected',
    } satisfies Partial<PluginError>);
  });

  it('returns typed cancellation and never persists a selection', async () => {
    const store = emptyStore();
    const runtimeOwner = createSelectionRuntime(store);
    const interactions = new TestInteractions(async (request) => {
      if (request.kind !== 'questions') throw new Error('questions expected');
      return { requestId: 'test-request-1', kind: 'questions', status: 'userCancelled' };
    });

    await expect(runtimeOwner.owner.requestSelection({
      purpose,
      serviceRefs: [openAiService],
      currentSession: { interactions },
      assertGenerationCurrent: () => undefined,
      reason: 'Choose realtime auth',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'plugin_ui_cancelled',
    } satisfies Partial<PluginError>);
    expect(store.current().bindings).toEqual([]);
  });

  it('rejects an unknown opaque choice and never persists a selection', async () => {
    const store = emptyStore();
    const runtimeOwner = createSelectionRuntime(store);
    const interactions = new TestInteractions(async (request) => {
      if (request.kind !== 'questions') throw new Error('questions expected');
      return {
        requestId: 'test-request-1',
        kind: 'questions',
        status: 'answered',
        answers: {
          [request.questions[0].id]: {
            kind: 'singleChoice',
            answer: { kind: 'choice', choiceId: 'target-0-forged-suffix' },
          },
        },
      };
    });

    await expect(runtimeOwner.owner.requestSelection({
      purpose,
      serviceRefs: [openAiService],
      currentSession: { interactions },
      assertGenerationCurrent: () => undefined,
      reason: 'Choose realtime auth',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'plugin_connected_account_binding_out_of_scope',
    } satisfies Partial<PluginError>);
    expect(store.current().bindings).toEqual([]);
  });

  it('does not persist the answered choice after the consumer generation retires', async () => {
    const store = emptyStore();
    const runtimeOwner = createSelectionRuntime(store);
    const interactions = new TestInteractions(async (request) => {
      if (request.kind !== 'questions') throw new Error('questions expected');
      const question = request.questions[0];
      if (question.type !== 'singleChoice') throw new Error('single choice expected');
      return {
        requestId: 'test-request-1',
        kind: 'questions',
        status: 'answered',
        answers: {
          [question.id]: {
            kind: 'singleChoice',
            answer: { kind: 'choice', choiceId: question.choices[0].id },
          },
        },
      };
    });
    const generationRetired = new PluginError({
      code: 'plugin_final_generation_retired',
      message: 'Plugin generation is no longer current',
    });

    await expect(runtimeOwner.owner.requestSelection({
      purpose,
      serviceRefs: [openAiService],
      currentSession: { interactions },
      assertGenerationCurrent: () => {
        throw generationRetired;
      },
      reason: 'Choose realtime auth',
      signal: new AbortController().signal,
    })).rejects.toBe(generationRetired);
    expect(store.current().bindings).toEqual([]);
  });

  it('fails selection typed and leaves no binding without a current session', async () => {
    const store = emptyStore();
    const runtimeOwner = createDaemonConnectedAccountPurposeBindingRuntime({
      resolveQualifiedConnectedAccountV4Support: () => 'advertised',
      establishedRuntimeOwner: {
        async invokeWithReceipt() {
          throw new Error('no-session selection must fail before materialization');
        },
        invokeDirectMaterial: unavailableDirectMaterial,
      },
      store,
      runtimeRegistry: {
        subscribe: () => () => undefined,
        async acquire() {
          throw new Error('no-session selection must fail before inventory access');
        },
      },
    });

    await expect(runtimeOwner.owner.requestSelection({
      purpose,
      serviceRefs: [openAiService],
      assertGenerationCurrent: () => undefined,
      reason: 'Choose realtime auth',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'plugin_ui_unavailable',
    } satisfies Partial<PluginError>);
    expect(store.current().bindings).toEqual([]);
  });
  it('projects only the exact current account target and never admits a same-service account', async () => {
    const store = selectedStore();
    const { runtime, resolveConnectedAccountEndpoints } = createInventoryRuntime({
      accounts: [
        testQualifiedProfile({ accountId: 'standard-openai', displayName: 'Selected account' }),
        testQualifiedProfile({ accountId: 'second-openai', displayName: 'Other account' }),
      ],
      originsByAccountId: {
        'standard-openai': ['https://eu.example.test'],
        // A path-prefixed deployment publishes both facts: HostAccess still
        // governs by the origin while a source routes by the configured base.
        'second-openai': ['https://us.example.test/acme'],
      },
      store,
    });

    await expect(runtime.owner.listAccounts({
      purpose,
      serviceRefs: [openAiService],
      limit: 256,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      status: 'complete',
      accounts: [
        {
          account: { service: openAiService, accountId: 'standard-openai' },
          displayName: 'Selected account',
          state: 'connected',
          connectedAccountOrigins: ['https://eu.example.test'],
          connectedAccountBases: ['https://eu.example.test'],
        },
      ],
    });
    expect(resolveConnectedAccountEndpoints).toHaveBeenCalledTimes(1);

    await expect(runtime.owner.materializeListedAccount({
      purpose,
      serviceRefs: [openAiService],
      account: { service: openAiService, accountId: 'second-openai' },
      request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'plugin_connected_account_binding_out_of_scope',
    } satisfies Partial<PluginError>);
  });

  it('projects only the current enabled members of a group target', async () => {
    const group: QualifiedConnectedAccountGroupV4 = {
      v: 1,
      ref: { service: openAiService, groupId: 'primary' },
      incarnation: 'qualified-group-row-primary',
      displayName: 'Primary upstreams',
      policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
      activeConnectedAccountId: 'standard-openai',
      generation: 1,
      runtimeStateRevision: 0,
      state: {},
      createdAt: 1,
      updatedAt: 1,
      members: [{
        v: 1,
        connectedAccountId: 'standard-openai',
        priority: 1,
        enabled: true,
        state: {},
        createdAt: 1,
        updatedAt: 1,
      }, {
        v: 1,
        connectedAccountId: 'backup-openai',
        priority: 2,
        enabled: true,
        state: {},
        createdAt: 1,
        updatedAt: 1,
      }, {
        v: 1,
        connectedAccountId: 'disabled-openai',
        priority: 3,
        enabled: false,
        state: {},
        createdAt: 1,
        updatedAt: 1,
      }],
    };
    const store: ConnectedAccountPurposeBindingStore = {
      read: async () => ({
        v: 1,
        bindings: [{
          purpose,
          target: { kind: 'group', service: openAiService, groupId: 'primary' },
        }],
      }),
      update: async (mutate) => mutate({
        v: 1,
        bindings: [{
          purpose,
          target: { kind: 'group', service: openAiService, groupId: 'primary' },
        }],
      }),
      subscribe: () => ({ dispose() {} }),
    };
    const { runtime } = createInventoryRuntime({
      accounts: [
        testQualifiedProfile({ accountId: 'standard-openai' }),
        testQualifiedProfile({ accountId: 'backup-openai' }),
        testQualifiedProfile({ accountId: 'disabled-openai' }),
        testQualifiedProfile({ accountId: 'unrelated-openai' }),
      ],
      group,
      store,
    });

    await expect(runtime.owner.listAccounts({
      purpose,
      serviceRefs: [openAiService],
      limit: 256,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      status: 'complete',
      accounts: [
        { account: { service: openAiService, accountId: 'backup-openai' } },
        { account: { service: openAiService, accountId: 'standard-openai' } },
      ],
    });

    await expect(runtime.owner.materializeListedAccount({
      purpose,
      serviceRefs: [openAiService],
      account: { service: openAiService, accountId: 'unrelated-openai' },
      request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'plugin_connected_account_binding_out_of_scope',
    } satisfies Partial<PluginError>);
  });

  it('fails closed when a listed materialization target changes during credential disclosure', async () => {
    const store = selectedStore();
    const { runtime, invokeWithReceipt } = createInventoryRuntime({
      accounts: [
        testQualifiedProfile({ accountId: 'standard-openai' }),
        testQualifiedProfile({ accountId: 'second-openai' }),
      ],
      store,
      invokeWithReceipt: async () => {
        await store.update(() => ({
          v: 1,
          bindings: [{
            purpose,
            target: {
              kind: 'account',
              account: { service: openAiService, accountId: 'second-openai' },
            },
          }],
        }));
        return {
          result: { kind: 'environment' as const, env: { OPENAI_API_KEY: 'sk-listed' } },
          basis: { credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' },
        };
      },
    });

    await expect(runtime.owner.materializeListedAccount({
      purpose,
      serviceRefs: [openAiService],
      account: { service: openAiService, accountId: 'standard-openai' },
      request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'plugin_connected_account_binding_out_of_scope',
    } satisfies Partial<PluginError>);
    expect(invokeWithReceipt).toHaveBeenCalledOnce();
  });

  it('fails closed when a group target generation changes during listed materialization', async () => {
    let currentGroup = testQualifiedGroup({
      activeAccountId: 'standard-openai',
      members: [{ accountId: 'standard-openai' }, { accountId: 'backup-openai' }],
    });
    const { runtime, qualifiedApi, invokeWithReceipt } = createInventoryRuntime({
      accounts: [
        testQualifiedProfile({ accountId: 'standard-openai' }),
        testQualifiedProfile({ accountId: 'backup-openai' }),
      ],
      group: currentGroup,
      store: selectedGroupStore(),
      invokeWithReceipt: async () => {
        currentGroup = testQualifiedGroup({
          activeAccountId: 'standard-openai',
          generation: 2,
          members: [{ accountId: 'standard-openai' }, { accountId: 'backup-openai' }],
        });
        return {
          result: { kind: 'environment' as const, env: { OPENAI_API_KEY: 'sk-listed' } },
          basis: { credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' },
        };
      },
    });
    qualifiedApi.readGroup.mockImplementation(async () => currentGroup);

    await expect(runtime.owner.materializeListedAccount({
      purpose,
      serviceRefs: [openAiService],
      account: { service: openAiService, accountId: 'standard-openai' },
      request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'plugin_connected_account_binding_out_of_scope',
    } satisfies Partial<PluginError>);
    expect(invokeWithReceipt).toHaveBeenCalledOnce();
  });

  it('keeps a configuration-free V4 account usable when its configuration projection is absent', async () => {
    const profile = testQualifiedProfile({ configurationReady: false });
    const selectionStore = emptyStore();
    const selectionRuntime = createSelectionRuntime(
      selectionStore,
      'advertised',
      testQualifiedApi({ accounts: [profile] }),
      testAuthentication,
    );
    const interactions = new TestInteractions(async (request) => {
      if (request.kind !== 'questions') throw new Error('questions expected');
      const question = request.questions[0];
      if (!question || question.type !== 'singleChoice') {
        throw new Error('single choice expected');
      }
      const choice = question.choices.find((candidate) => (
        candidate.label === 'acct-standard'
      ));
      if (!choice) throw new Error('configuration-free account choice expected');
      return {
        requestId: 'configuration-free-selection',
        kind: 'questions',
        status: 'answered',
        answers: {
          [question.id]: {
            kind: 'singleChoice',
            answer: { kind: 'choice', choiceId: choice.id },
          },
        },
      };
    });

    await expect(selectionRuntime.owner.requestSelection({
      purpose,
      serviceRefs: [openAiService],
      currentSession: { interactions },
      assertGenerationCurrent: () => undefined,
      reason: 'Choose configuration-free auth',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      account: { service: openAiService, accountId: 'standard-openai' },
      target: { kind: 'account' },
    });
    expect(selectionStore.current().bindings).toEqual([{
      purpose,
      target: {
        kind: 'account',
        account: { service: openAiService, accountId: 'standard-openai' },
      },
    }]);

    const { runtime, invokeWithReceipt } = createInventoryRuntime({
      accounts: [profile],
      authentication: testAuthentication,
    });
    const listed = await runtime.owner.listAccounts({
      purpose,
      serviceRefs: [openAiService],
      limit: 256,
      signal: new AbortController().signal,
    });

    expect(listed).toMatchObject({
      status: 'complete',
      accounts: [{
        account: { service: openAiService, accountId: 'standard-openai' },
        state: 'connected',
      }],
    });
    await expect(runtime.owner.materializeListedAccount({
      purpose,
      serviceRefs: [openAiService],
      account: { service: openAiService, accountId: 'standard-openai' },
      request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'environment',
      env: { OPENAI_API_KEY: 'sk-listed' },
    });
    expect(invokeWithReceipt).toHaveBeenCalledOnce();
  });

  it('excludes an unconfigured account-scoped V4 mode from selection and group resolution', async () => {
    const profile = testQualifiedProfile({
      authenticationModeId: 'configured',
      configurationReady: false,
    });
    const interactions = new TestInteractions(async () => {
      throw new Error('An account-scoped unconfigured profile must not be offered');
    });
    const selectionRuntime = createSelectionRuntime(
      emptyStore(),
      'advertised',
      testQualifiedApi({ accounts: [profile] }),
      accountScopedConfigurationAuthentication,
    );

    await expect(selectionRuntime.owner.requestSelection({
      purpose,
      serviceRefs: [openAiService],
      currentSession: { interactions },
      assertGenerationCurrent: () => undefined,
      reason: 'Choose realtime auth',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'plugin_host_access_resource_not_selected',
    } satisfies Partial<PluginError>);

    const { runtime } = createInventoryRuntime({
      accounts: [profile],
      authentication: accountScopedConfigurationAuthentication,
      store: selectedGroupStore(),
    });
    await expect(runtime.owner.getBinding({
      purpose,
      serviceRefs: [openAiService],
      signal: new AbortController().signal,
    })).resolves.toBeNull();
  });

  it('reports honest non-connected states instead of silently omitting accounts', async () => {
    const group = testQualifiedGroup({
      activeAccountId: 'standard-openai',
      members: [
        { accountId: 'standard-openai' },
        { accountId: 'expired' },
        { accountId: 'reauth' },
        { accountId: 'refreshing' },
      ],
    });
    const { runtime } = createInventoryRuntime({
      accounts: [
        testQualifiedProfile({ accountId: 'standard-openai' }),
        testQualifiedProfile({ accountId: 'expired', expiresAt: 1 }),
        testQualifiedProfile({ accountId: 'reauth', status: 'needs_reauth' }),
        testQualifiedProfile({ accountId: 'refreshing', status: 'refreshing' }),
      ],
      group,
      store: selectedGroupStore(),
    });

    const result = await runtime.owner.listAccounts({
      purpose,
      serviceRefs: [openAiService],
      limit: 256,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('complete');
    expect(result.accounts.map((account) => [account.account.accountId, account.state]))
      .toEqual([
        ['expired', 'expired'],
        ['reauth', 'reconnectRequired'],
        ['refreshing', 'unavailable'],
        ['standard-openai', 'connected'],
      ]);
  });

  it('reports an explicitly truncated listing rather than a silently short complete one', async () => {
    const group = testQualifiedGroup({
      activeAccountId: 'a',
      members: [{ accountId: 'a' }, { accountId: 'b' }, { accountId: 'c' }],
    });
    const { runtime } = createInventoryRuntime({
      accounts: [
        testQualifiedProfile({ accountId: 'a' }),
        testQualifiedProfile({ accountId: 'b' }),
        testQualifiedProfile({ accountId: 'c' }),
      ],
      group,
      store: selectedGroupStore(),
    });

    await expect(runtime.owner.listAccounts({
      purpose,
      serviceRefs: [openAiService],
      limit: 2,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      status: 'truncated',
      accounts: [
        { account: { service: openAiService, accountId: 'a' } },
        { account: { service: openAiService, accountId: 'b' } },
      ],
    });
  });

  it('reports a complete retained inventory above the removed upstream response cap', async () => {
    const accountIds = Array.from({ length: 501 }, (_unused, index) => (
      `account-${String(index).padStart(3, '0')}`
    ));
    const group = testQualifiedGroup({
      activeAccountId: accountIds[0],
      members: accountIds.map((accountId) => ({ accountId })),
    });
    const { runtime } = createInventoryRuntime({
      accounts: accountIds.map((accountId) => testQualifiedProfile({ accountId })),
      group,
      store: selectedGroupStore(),
    });

    const result = await runtime.owner.listAccounts({
      purpose,
      serviceRefs: [openAiService],
      limit: 501,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('complete');
    expect(result.accounts).toHaveLength(501);
  });

  it('fails a listing closed when no host-owned configured-origin projection is available', async () => {
    const { runtime } = createInventoryRuntime({ omitOriginReader: true });

    await expect(runtime.owner.listAccounts({
      purpose,
      serviceRefs: [openAiService],
      limit: 256,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'connected_account_configured_origins_unavailable',
    } satisfies Partial<PluginError>);
  });

  it('materializes the exact direct listed target without mutating its selected binding', async () => {
    const store = selectedStore();
    const { runtime, invokeWithReceipt } = createInventoryRuntime({
      accounts: [
        testQualifiedProfile({ accountId: 'standard-openai' }),
        testQualifiedProfile({ accountId: 'second-openai' }),
      ],
      store,
    });

    await expect(runtime.owner.materializeListedAccount({
      purpose,
      serviceRefs: [openAiService],
      account: { service: openAiService, accountId: 'standard-openai' },
      request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'environment', env: { OPENAI_API_KEY: 'sk-listed' } });

    expect(invokeWithReceipt).toHaveBeenCalledWith(expect.objectContaining({
      account: { service: openAiService, accountId: 'standard-openai' },
    }));
    expect(store.current().bindings).toEqual([{
      purpose,
      target: { kind: 'account', account: { service: openAiService, accountId: 'standard-openai' } },
    }]);
  });

  it('rejects an exact-listed materialization for an account outside the authorized set', async () => {
    const { runtime, invokeWithReceipt } = createInventoryRuntime({
      accounts: [testQualifiedProfile({ accountId: 'standard-openai' })],
    });

    await expect(runtime.owner.materializeListedAccount({
      purpose,
      serviceRefs: [openAiService],
      account: { service: openAiService, accountId: 'unlisted-openai' },
      request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'plugin_connected_account_binding_out_of_scope',
    } satisfies Partial<PluginError>);
    expect(invokeWithReceipt).not.toHaveBeenCalled();
  });

  it('rejects an exact-listed materialization for an undeclared service', async () => {
    const { runtime, invokeWithReceipt } = createInventoryRuntime();

    await expect(runtime.owner.materializeListedAccount({
      purpose,
      serviceRefs: [openAiService],
      account: { service: githubService, accountId: 'standard-openai' },
      request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'plugin_connected_account_binding_out_of_scope',
    } satisfies Partial<PluginError>);
    expect(invokeWithReceipt).not.toHaveBeenCalled();
  });

  it('admits an httpHeaders origin only from the exact account current configured origins', async () => {
    const { runtime, invokeWithReceipt } = createInventoryRuntime({
      accounts: [testQualifiedProfile({ accountId: 'standard-openai' })],
      originsByAccountId: { 'standard-openai': ['https://eu.example.test'] },
      invokeWithReceipt: async () => ({
        result: { kind: 'httpHeaders' as const, headers: { authorization: 'Bearer listed' } },
        basis: { credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' },
      }),
    });
    const listedAccount = {
      purpose,
      serviceRefs: [openAiService],
      account: { service: openAiService, accountId: 'standard-openai' },
      signal: new AbortController().signal,
    } as const;

    await expect(runtime.owner.materializeListedAccount({
      ...listedAccount,
      request: {
        kind: 'httpHeaders',
        origin: 'https://us.example.test',
        headerNames: ['authorization'],
      },
    })).rejects.toMatchObject({
      code: 'plugin_connected_account_binding_out_of_scope',
    } satisfies Partial<PluginError>);
    expect(invokeWithReceipt).not.toHaveBeenCalled();

    await expect(runtime.owner.materializeListedAccount({
      ...listedAccount,
      request: {
        kind: 'httpHeaders',
        origin: 'https://eu.example.test',
        headerNames: ['authorization'],
      },
    })).resolves.toEqual({ kind: 'httpHeaders', headers: { authorization: 'Bearer listed' } });
  });

  it('fails closed when the exact listed account leaves the authorized set during materialization', async () => {
    let listedAccountIds = ['standard-openai'];
    const qualifiedApi = testQualifiedApi();
    qualifiedApi.listAccounts.mockImplementation(async () => ({
      service: openAiService,
      accounts: listedAccountIds.map((accountId) => testQualifiedProfile({ accountId })),
    }));
    const invokeWithReceipt = vi.fn(async () => {
      listedAccountIds = [];
      return {
        result: { kind: 'environment' as const, env: { OPENAI_API_KEY: 'sk-listed' } },
        basis: { credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' },
      };
    });
    const runtime = createDaemonConnectedAccountPurposeBindingRuntime({
      resolveQualifiedConnectedAccountV4Support: () => 'advertised',
      establishedRuntimeOwner: { invokeWithReceipt, invokeDirectMaterial: unavailableDirectMaterial } as unknown as Pick<
        QualifiedConnectedAccountEstablishedRuntimeOwner,
        'invokeWithReceipt' | 'invokeDirectMaterial'
      >,
      qualifiedApi,
      resolveConnectedAccountEndpoints: async () => [],
      store: selectedStore(),
      runtimeRegistry: {
        subscribe: () => () => undefined,
        async acquire() {
          return {
            isCurrent: () => true,
            resolveService: () => ({
              service: openAiService,
              availability: 'available' as const,
              authentication: testAuthentication,
            }),
            release: vi.fn(async () => {}),
          };
        },
      },
    });

    await expect(runtime.owner.materializeListedAccount({
      purpose,
      serviceRefs: [openAiService],
      account: { service: openAiService, accountId: 'standard-openai' },
      request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'plugin_connected_account_binding_out_of_scope',
    } satisfies Partial<PluginError>);
    expect(invokeWithReceipt).toHaveBeenCalledOnce();
  });
});
