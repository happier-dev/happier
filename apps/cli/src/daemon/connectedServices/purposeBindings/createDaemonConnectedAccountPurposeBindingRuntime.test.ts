import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ConnectedServiceCredentialRecordV1Schema,
  FeaturesResponseSchema,
  sealQualifiedConnectedAccountContentEnvelope,
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
import {
  resolveQualifiedConnectedAccountPeerOperationTransport,
  type QualifiedConnectedAccountPeerOperationTransport,
} from '@/api/client/qualifiedConnectedAccountApi';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import {
  createQualifiedConnectedAccountEstablishedRuntimeOwner,
  createRevisionedLegacyConnectedAccountMaterializationOwner,
  type QualifiedConnectedAccountEstablishedRuntimeOwner,
} from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
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
const revisionedServerSnapshot = {
  status: 'ready' as const,
  features: FeaturesResponseSchema.parse({
    features: {},
    capabilities: {
      connectedServices: {
        credentialDelete: { revisionGuard: true },
      },
    },
  }),
};
const exactOldServerSnapshot = {
  status: 'ready' as const,
  features: FeaturesResponseSchema.parse({
    features: {
      sharing: {
        pendingQueueV2: { enabled: true },
      },
    },
    capabilities: {},
  }),
};
const exactOldServerContract = {
  mode: 'released_server_v0_2_1' as const,
  runtimeActivity: 'legacy' as const,
  pendingInput: 'released_server_v0_2_1' as const,
  publisherAuthority: 'indeterminate' as const,
  sessionConnectionEpoch: 4,
  socket: { connected: true },
};
const advertisedMaterializationTransport = () => ({ kind: 'v4' as const });
const unavailableLegacyMaterializationOwner = {
  async invokeWithReceipt(): Promise<never> {
    throw new Error('legacy materialization must not be invoked');
  },
  async invoke(): Promise<never> {
    throw new Error('legacy materialization must not be invoked');
  },
};
function testQualifiedProfile(input: Readonly<{
  accountId?: string;
  status?: QualifiedConnectedAccountProfileV4['status'];
  expiresAt?: number | null;
  displayName?: string;
}> = {}): QualifiedConnectedAccountProfileV4 {
  return {
    ref: { service: openAiService, accountId: input.accountId ?? 'standard-openai' },
    status: input.status ?? 'connected',
    authenticationModeId: 'api-key',
    revisionSemantics: 'revisioned',
    credentialRevision: 'csr_abcdefghijklmnopqrstuv',
    configurationReady: true,
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
) {
  return createDaemonConnectedAccountPurposeBindingRuntime({
    resolveQualifiedConnectedAccountV4Support: () => v4Support,
    resolveQualifiedConnectedAccountMaterializationTransport: () =>
      v4Support === 'advertised'
        ? advertisedMaterializationTransport()
        : {
            kind: 'legacy' as const,
            peerClass: 'exact_v0_2_1' as const,
            serviceId: 'openai' as const,
          },
    establishedRuntimeOwner: {
      async invokeWithReceipt() {
        throw new Error('selection must not materialize a credential');
      },
    },
    revisionedLegacyMaterializationOwner:
      unavailableLegacyMaterializationOwner,
    qualifiedApi,
    api: {
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai' as const,
        profiles: [{
          profileId: 'standard-openai',
          status: 'connected' as const,
          kind: 'token' as const,
          providerAccountId: 'acct-standard',
          providerEmail: 'user@example.test',
          expiresAt: null,
        }, {
          profileId: 'needs-reauth',
          status: 'needs_reauth' as const,
          kind: 'token' as const,
        }],
      })),
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    },
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
                legacyServiceId: 'openai' as const,
                availability: 'available' as const,
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
  originsByAccountId?: Readonly<Record<string, readonly string[]>>;
  omitOriginReader?: boolean;
  invokeWithReceipt?: () => Promise<unknown>;
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
  const resolveConnectedAccountEndpoints = vi.fn(async (
    request: Readonly<{ account: { accountId: string } }>,
  ) => {
    input.onOriginsRead?.();
    return (input.originsByAccountId?.[request.account.accountId] ?? [])
      .map((value) => normalizeConnectedAccountConfiguredBase(value));
  });
  const runtime = createDaemonConnectedAccountPurposeBindingRuntime({
    resolveQualifiedConnectedAccountV4Support: () => 'advertised',
    resolveQualifiedConnectedAccountMaterializationTransport:
      advertisedMaterializationTransport,
    establishedRuntimeOwner: { invokeWithReceipt } as unknown as Pick<
      QualifiedConnectedAccountEstablishedRuntimeOwner,
      'invokeWithReceipt'
    >,
    revisionedLegacyMaterializationOwner: unavailableLegacyMaterializationOwner,
    qualifiedApi,
    ...(input.omitOriginReader ? {} : { resolveConnectedAccountEndpoints }),
    api: {
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai' as const,
        profiles: [],
      })),
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    },
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
                legacyServiceId: 'openai' as const,
                availability: 'available' as const,
              }
            : null,
          release: vi.fn(async () => {}),
        };
      },
    },
  });
  return { runtime, qualifiedApi, invokeWithReceipt, resolveConnectedAccountEndpoints };
}

type ActionFormRuntimeParams = Parameters<typeof createDaemonConnectedAccountPurposeBindingRuntime>[0];
type LegacyActionFormProfiles = Awaited<
  ReturnType<ActionFormRuntimeParams['api']['listConnectedServiceProfiles']>
>['profiles'];

function createActionFormRuntime(input: Readonly<{
  transport?: QualifiedConnectedAccountPeerOperationTransport;
  qualifiedApi?: ReturnType<typeof testQualifiedApi>;
  runtimeRegistry?: DaemonConnectedAccountRuntimeRegistry;
  legacyProfiles?: LegacyActionFormProfiles;
}> = {}) {
  const transport = input.transport ?? advertisedMaterializationTransport();
  return createDaemonConnectedAccountPurposeBindingRuntime({
    resolveQualifiedConnectedAccountV4Support: () => transport.kind === 'v4' ? 'advertised' : 'absent',
    resolveQualifiedConnectedAccountMaterializationTransport: () => transport,
    establishedRuntimeOwner: {
      async invokeWithReceipt() {
        throw new Error('Action-form option listing must not materialize a credential');
      },
    },
    revisionedLegacyMaterializationOwner: unavailableLegacyMaterializationOwner,
    qualifiedApi: input.qualifiedApi ?? testQualifiedApi(),
    api: {
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai' as const,
        profiles: input.legacyProfiles ?? [],
      })),
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    },
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
                legacyServiceId: 'openai' as const,
                availability: 'available' as const,
              }
            : null,
          release: vi.fn(async () => {}),
        };
      },
    },
  });
}

describe('createDaemonConnectedAccountPurposeBindingRuntime', () => {
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

  it('admits only revisioned legacy inventory and preserves its exact service binding', async () => {
    const profiles: LegacyActionFormProfiles = [{
      profileId: 'legacy-account',
      status: 'connected',
      kind: 'token',
      providerAccountId: 'legacy-account-id',
      providerEmail: 'legacy@example.test',
      expiresAt: null,
    }];
    const revisionedRuntime = createActionFormRuntime({
      transport: {
        kind: 'legacy',
        peerClass: 'revisioned_v2_v3',
        serviceId: 'openai',
      },
      legacyProfiles: profiles,
    });
    const exactLegacyRuntime = createActionFormRuntime({
      transport: {
        kind: 'legacy',
        peerClass: 'exact_v0_2_1',
        serviceId: 'openai',
      },
      legacyProfiles: profiles,
    });
    const input = {
      purpose,
      serviceRefs: [openAiService],
      signal: new AbortController().signal,
    };

    await expect(revisionedRuntime.listActionFormConnectedAccountOptions(input)).resolves.toEqual([{
      value: { service: openAiService, accountId: 'legacy-account' },
      label: 'legacy@example.test',
    }]);
    await expect(exactLegacyRuntime.listActionFormConnectedAccountOptions(input)).resolves.toEqual([]);
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
            legacyServiceId: 'openai',
            availability: 'available',
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
      resolveQualifiedConnectedAccountMaterializationTransport:
        advertisedMaterializationTransport,
      // This fixture exercises only environment materialization.
      establishedRuntimeOwner: { invokeWithReceipt } as unknown as Pick<
        QualifiedConnectedAccountEstablishedRuntimeOwner,
        'invokeWithReceipt'
      >,
      revisionedLegacyMaterializationOwner:
        unavailableLegacyMaterializationOwner,
      api: {
        listConnectedServiceProfiles: vi.fn(async () => ({
          serviceId: 'openai' as const,
          profiles: [{
            profileId: 'standard-openai',
            status: 'connected' as const,
            kind: 'token' as const,
            providerAccountId: 'acct-standard',
            providerEmail: null,
            expiresAt: null,
          }],
        })),
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getConnectedServiceCredentialPlain: vi.fn(async () => null),
        getConnectedServiceCredentialSealed: vi.fn(async () => null),
      },
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
                  legacyServiceId: 'openai' as const,
                  availability: 'available' as const,
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
      generation: 'generation-1',
      correlationId: 'correlation-1',
      surface: 'agent',
      session: { id: 'session-1' },
      signal: invocationController.signal,
      isGenerationCurrent: () => !invocationController.signal.aborted,
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
      resolveQualifiedConnectedAccountMaterializationTransport:
        advertisedMaterializationTransport,
      // This fixture rejects before any established operation can run.
      establishedRuntimeOwner: { invokeWithReceipt } as unknown as Pick<
        QualifiedConnectedAccountEstablishedRuntimeOwner,
        'invokeWithReceipt'
      >,
      revisionedLegacyMaterializationOwner:
        unavailableLegacyMaterializationOwner,
      api: {
        listConnectedServiceProfiles: vi.fn(),
        getAccountEncryptionMode: vi.fn(),
        getConnectedServiceCredentialPlain: vi.fn(),
        getConnectedServiceCredentialSealed: vi.fn(),
      },
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
                  legacyServiceId: 'openai' as const,
                  availability: 'available' as const,
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

  it('fails qualified public materialization typed without probing raw V4 when atomic capability is absent', async () => {
    const runtimeOwner = createSelectionRuntime(selectedStore(), 'absent');

    await expect(runtimeOwner.owner.materialize({
      purpose,
      serviceRefs: [openAiService],
      request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      name: 'PluginError',
      code: 'connected_account_v4_contract_unavailable',
      retryable: false,
    });
  });

  it('translates a revision-fenced GitHub peer through the real purpose owner and registered runtime leaf', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-purpose-github-account-'),
    );
    const registry = await resolveExecutablePluginRuntimeRegistry({
      happyHomeDir,
      pluginIds: [githubService.pluginId],
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
    const record = ConnectedServiceCredentialRecordV1Schema.parse({
      v: 1,
      serviceId: 'github',
      profileId: 'github-work',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      expiresAt: null,
      kind: 'token',
      token: {
        token: 'github-token',
        providerAccountId: 'github-account-id',
        providerEmail: 'github@example.test',
        raw: null,
      },
    });
    let driftAfterFirstCredentialRead = false;
    let credentialReads = 0;
    const getConnectedServiceCredentialPlain = vi.fn(async () => {
      credentialReads += 1;
      return {
        revisionSemantics: 'revisioned' as const,
        credentialRevision:
          driftAfterFirstCredentialRead && credentialReads > 1
            ? 'csr_ZYXWVUTSRQPONMLKJHGFEDCBA1'
            : 'csr_0123456789ABCDEFGHJKMNPQRS',
        content: { t: 'plain' as const, v: record },
      };
    });
    const listConnectedServiceProfiles = vi.fn(async () => ({
      serviceId: 'github' as const,
      profiles: [{
        profileId: 'github-work',
        status: 'connected' as const,
        kind: 'token' as const,
        providerAccountId: 'github-account-id',
        providerEmail: 'github@example.test',
        expiresAt: null,
      }],
    }));
    const api = {
      listConnectedServiceProfiles,
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain,
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    };
    const configuration = {
      read: vi.fn(async () => null),
      secrets: {
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
    const revisionedLegacyMaterializationOwner =
      createRevisionedLegacyConnectedAccountMaterializationOwner({
        reloadController,
        credentials,
        api,
        getAccountEncryptionMode: api.getAccountEncryptionMode,
        configuration,
      });
    const establishedRuntimeOwner = {
      invokeWithReceipt: vi.fn(async (): Promise<never> => {
        throw new Error('revisioned GitHub must not use the V4 reader');
      }),
    };
    const runtimeOwner = createDaemonConnectedAccountPurposeBindingRuntime({
      api,
      establishedRuntimeOwner,
      revisionedLegacyMaterializationOwner,
      resolveQualifiedConnectedAccountMaterializationTransport: () => ({
        ...resolveQualifiedConnectedAccountPeerOperationTransport({
          snapshot: revisionedServerSnapshot,
          service: githubService,
          operation: 'one_shot_materialization',
        }),
      }),
      resolveQualifiedConnectedAccountV4Support: () => 'absent',
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
      expect(establishedRuntimeOwner.invokeWithReceipt).not.toHaveBeenCalled();
      expect(listConnectedServiceProfiles).toHaveBeenCalled();
      expect(getConnectedServiceCredentialPlain).toHaveBeenCalled();

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
        listConnectedServiceProfiles.mock.calls.length;
      generationCurrent = false;
      await expect(runtimeOwner.owner.materialize({
        purpose,
        serviceRefs: [githubService],
        request: materializationRequest,
        signal: new AbortController().signal,
      })).rejects.toThrow('no longer current');
      expect(listConnectedServiceProfiles).toHaveBeenCalledTimes(
        profileReadsBeforeRetirement,
      );
    } finally {
      await registry.dispose();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'exact GitHub',
      githubService,
      'github',
      exactOldServerSnapshot,
      exactOldServerContract,
    ],
    [
      'revisioned Bitbucket',
      {
        pluginId: 'happier.scm.forge.bitbucket',
        localId: 'bitbucket-account',
      },
      'bitbucket',
      revisionedServerSnapshot,
      null,
    ],
    [
      'exact Bitbucket',
      {
        pluginId: 'happier.scm.forge.bitbucket',
        localId: 'bitbucket-account',
      },
      'bitbucket',
      exactOldServerSnapshot,
      exactOldServerContract,
    ],
    [
      'indeterminate GitHub',
      githubService,
      'github',
      { status: 'error' as const, reason: 'network' },
      null,
    ],
  ] as const)(
    'refuses %s before legacy inventory, credential, or runtime effects',
    async (
      _label,
      service,
      legacyServiceId,
      snapshot,
      serverContract,
    ) => {
      const resolveTransport = vi.fn(() =>
        resolveQualifiedConnectedAccountPeerOperationTransport({
          snapshot,
          serverContract,
          service,
          operation: 'one_shot_materialization',
        })
      );
      const listConnectedServiceProfiles = vi.fn();
      const getConnectedServiceCredentialPlain = vi.fn();
      const establishedInvokeWithReceipt = vi.fn();
      const revisionedLegacyInvokeWithReceipt = vi.fn();
      const runtimeOwner =
        createDaemonConnectedAccountPurposeBindingRuntime({
          api: {
            listConnectedServiceProfiles,
            getAccountEncryptionMode: vi.fn(),
            getConnectedServiceCredentialPlain,
            getConnectedServiceCredentialSealed: vi.fn(),
          },
          establishedRuntimeOwner: { invokeWithReceipt: establishedInvokeWithReceipt },
          revisionedLegacyMaterializationOwner: {
            invokeWithReceipt: revisionedLegacyInvokeWithReceipt,
            invoke: vi.fn(),
          },
          resolveQualifiedConnectedAccountMaterializationTransport:
            resolveTransport,
          resolveQualifiedConnectedAccountV4Support: () => 'absent',
          store: selectedStore({
            service,
            accountId: 'scm-account',
          }),
          runtimeRegistry: {
            subscribe: () => () => undefined,
            async acquire() {
              return {
                isCurrent: () => true,
                resolveService: (candidate) => (
                  candidate.pluginId === service.pluginId
                  && candidate.localId === service.localId
                    ? {
                        service,
                        legacyServiceId,
                        availability: 'available' as const,
                      }
                    : null
                ),
                release: vi.fn(async () => undefined),
              };
            },
          },
        });

      await expect(runtimeOwner.owner.materialize({
        purpose,
        serviceRefs: [service],
        request: {
          kind: 'httpHeaders',
          origin: 'https://example.test',
          headerNames: ['authorization'],
        },
        signal: new AbortController().signal,
      })).rejects.toMatchObject({
        code: 'plugin_host_access_resource_not_selected',
      });
      expect(resolveTransport).toHaveBeenCalled();
      expect(listConnectedServiceProfiles).not.toHaveBeenCalled();
      expect(getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
      expect(establishedInvokeWithReceipt).not.toHaveBeenCalled();
      expect(revisionedLegacyInvokeWithReceipt).not.toHaveBeenCalled();
    },
  );

  it('materializes the declared OpenAI API-key descriptor through its registered plugin runtime', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-purpose-account-'));
    const registry = await resolveExecutablePluginRuntimeRegistry({
      happyHomeDir,
      pluginIds: [openAiService.pluginId],
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
            has: vi.fn(async () => false),
            read: vi.fn(async () => null),
          },
        },
      });
    const runtimeOwner = createDaemonConnectedAccountPurposeBindingRuntime({
      resolveQualifiedConnectedAccountV4Support: () => 'advertised',
      resolveQualifiedConnectedAccountMaterializationTransport:
        advertisedMaterializationTransport,
      establishedRuntimeOwner,
      revisionedLegacyMaterializationOwner:
        unavailableLegacyMaterializationOwner,
      api: {
        listConnectedServiceProfiles: vi.fn(async () => ({
          serviceId: 'openai' as const,
          profiles: [{
            profileId: 'standard-openai',
            status: 'connected' as const,
            kind: 'token' as const,
            providerAccountId: 'acct-standard',
            providerEmail: null,
            expiresAt: null,
          }],
        })),
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getConnectedServiceCredentialPlain: vi.fn(async () => null),
        getConnectedServiceCredentialSealed: vi.fn(async () => null),
      },
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
      resolveQualifiedConnectedAccountMaterializationTransport:
        advertisedMaterializationTransport,
      establishedRuntimeOwner: {
        async invokeWithReceipt() {
          throw new Error('no-session selection must fail before materialization');
        },
      },
      revisionedLegacyMaterializationOwner:
        unavailableLegacyMaterializationOwner,
      api: {
        listConnectedServiceProfiles: vi.fn(),
        getAccountEncryptionMode: vi.fn(),
        getConnectedServiceCredentialPlain: vi.fn(),
        getConnectedServiceCredentialSealed: vi.fn(),
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

  it('reports truncated when the bounded upstream inventory response may have elided rows', async () => {
    const accountIds = Array.from({ length: 500 }, (_unused, index) => (
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
      limit: 500,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('truncated');
    expect(result.accounts).toHaveLength(500);
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
      resolveQualifiedConnectedAccountMaterializationTransport:
        advertisedMaterializationTransport,
      establishedRuntimeOwner: { invokeWithReceipt } as unknown as Pick<
        QualifiedConnectedAccountEstablishedRuntimeOwner,
        'invokeWithReceipt'
      >,
      revisionedLegacyMaterializationOwner: unavailableLegacyMaterializationOwner,
      qualifiedApi,
      resolveConnectedAccountEndpoints: async () => [],
      api: {
        listConnectedServiceProfiles: vi.fn(async () => ({
          serviceId: 'openai' as const,
          profiles: [],
        })),
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getConnectedServiceCredentialPlain: vi.fn(async () => null),
        getConnectedServiceCredentialSealed: vi.fn(async () => null),
      },
      store: selectedStore(),
      runtimeRegistry: {
        subscribe: () => () => undefined,
        async acquire() {
          return {
            isCurrent: () => true,
            resolveService: () => ({
              service: openAiService,
              legacyServiceId: 'openai' as const,
              availability: 'available' as const,
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
