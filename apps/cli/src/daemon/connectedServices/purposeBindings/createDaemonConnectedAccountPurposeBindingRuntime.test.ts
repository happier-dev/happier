import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ConnectedServiceAuthGroupV1Schema,
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
import { createStablePluginConnectedAccountsHost } from '@/plugins/runtime/invocation/services/connectedAccounts';
import {
  resolveQualifiedConnectedAccountPeerOperationTransport,
} from '@/api/client/qualifiedConnectedAccountApi';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import {
  createQualifiedConnectedAccountEstablishedRuntimeOwner,
  createRevisionedLegacyConnectedAccountMaterializationOwner,
} from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import type { ConnectedAccountPurposeBindingStore } from './ConnectedAccountPurposeBindingOwner';
import { createDaemonConnectedAccountPurposeBindingRuntime } from './createDaemonConnectedAccountPurposeBindingRuntime';

const purpose = {
  consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
  purpose: 'realtime_upstream',
} as const;
const openAiService = {
  pluginId: 'happier.voice.openai',
  localId: 'openai',
} as const;
const githubService = {
  pluginId: 'happier.scm.hosting.github',
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
  sessionConnectionEpoch: 4,
  socket: { connected: true },
};
const advertisedMaterializationTransport = () => ({ kind: 'v4' as const });
const unavailableLegacyMaterializationOwner = {
  async invoke(): Promise<never> {
    throw new Error('legacy materialization must not be invoked');
  },
};
const primaryOpenAiGroup = ConnectedServiceAuthGroupV1Schema.parse({
  v: 1,
  serviceId: 'openai',
  groupId: 'primary',
  displayName: 'Primary upstreams',
  policy: {},
  activeProfileId: 'standard-openai',
  generation: 1,
  runtimeStateRevision: 0,
  state: {},
  createdAt: 1,
  updatedAt: 1,
  members: [{
    v: 1,
    serviceId: 'openai',
    groupId: 'primary',
    profileId: 'standard-openai',
    priority: 1,
    enabled: true,
    state: {},
    createdAt: 1,
    updatedAt: 1,
  }],
});

function testQualifiedApi() {
  const profile: QualifiedConnectedAccountProfileV4 = {
    ref: { service: openAiService, accountId: 'standard-openai' },
    status: 'connected',
    authenticationModeId: 'api-key',
    credentialRevision: 'csr_abcdefghijklmnopqrstuv',
    configurationReady: true,
    configurationRevision: null,
    kind: 'token',
    expiresAt: null,
    providerIdentity: {
      accountId: 'acct-standard',
      email: 'user@example.test',
    },
    displayName: 'acct-standard',
    scopes: [],
  };
  const group: QualifiedConnectedAccountGroupV4 = {
    v: 1,
    ref: { service: openAiService, groupId: 'primary' },
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
      service: openAiService,
      accounts: [profile],
    })),
    listGroups: vi.fn(async () => ({ groups: [group] })),
    readGroup: vi.fn(async () => group),
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
      async invoke() {
        throw new Error('selection must not materialize a credential');
      },
    },
    revisionedLegacyMaterializationOwner:
      unavailableLegacyMaterializationOwner,
    qualifiedApi: testQualifiedApi(),
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
      listConnectedServiceAuthGroups: vi.fn(async () => [primaryOpenAiGroup]),
      getConnectedServiceAuthGroup: vi.fn(async () => primaryOpenAiGroup),
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    },
    store,
    runtimeRegistry: {
      subscribe: () => () => undefined,
      async acquire() {
        return {
          generation: 'generation-1',
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

  it('contracts a persisted removed consumer during cold recovery before publishing', async () => {
    const store = selectedStore();
    const runtimeOwner = createSelectionRuntime(store);
    const publish = vi.fn();

    await runtimeOwner.reconcileRegistryPublication({
      previous: null,
      candidate: createResolvedContributionRegistry({}),
      resolveOptionalAccess: () => [],
      publish,
    });

    expect(publish).toHaveBeenCalledOnce();
    expect(store.current().bindings).toEqual([]);
  });

  it('materializes the exact selected qualified OpenAI account through the current plugin generation', async () => {
    const listeners = new Set<() => void>();
    let generationCurrent = true;
    const invoke = vi.fn(async (input: Readonly<{
      account: { service: typeof openAiService; accountId: string };
      operation: {
        kind: 'materialize';
        request: { kind: 'environment'; keys: readonly string[] };
      };
    }>) => {
      if (!generationCurrent) {
        throw new Error("Connected-account runtime generation 'generation-1' is no longer current");
      }
      expect(input.account).toEqual({
        service: openAiService,
        accountId: 'standard-openai',
      });
      expect(input.operation).toEqual({
        kind: 'materialize',
        request: { kind: 'environment', keys: ['OPENAI_API_KEY'] },
      });
      return { kind: 'environment' as const, env: { OPENAI_API_KEY: 'sk-standard' } };
    });
    const runtimeOwner = createDaemonConnectedAccountPurposeBindingRuntime({
      resolveQualifiedConnectedAccountV4Support: () => 'advertised',
      resolveQualifiedConnectedAccountMaterializationTransport:
        advertisedMaterializationTransport,
      establishedRuntimeOwner: { invoke },
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
        listConnectedServiceAuthGroups: vi.fn(async () => []),
        getConnectedServiceAuthGroup: vi.fn(async () => null),
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
            generation: 'generation-1',
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
    expect(invoke).toHaveBeenCalledOnce();

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
      listConnectedServiceAuthGroups: vi.fn(async () => []),
      getConnectedServiceAuthGroup: vi.fn(async () => null),
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
      invoke: vi.fn(async (): Promise<never> => {
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
      expect(establishedRuntimeOwner.invoke).not.toHaveBeenCalled();
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
        pluginId: 'happier.scm.hosting.bitbucket',
        localId: 'bitbucket-account',
      },
      'bitbucket',
      revisionedServerSnapshot,
      null,
    ],
    [
      'exact Bitbucket',
      {
        pluginId: 'happier.scm.hosting.bitbucket',
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
      const establishedInvoke = vi.fn();
      const revisionedLegacyInvoke = vi.fn();
      const runtimeOwner =
        createDaemonConnectedAccountPurposeBindingRuntime({
          api: {
            listConnectedServiceProfiles,
            listConnectedServiceAuthGroups: vi.fn(),
            getConnectedServiceAuthGroup: vi.fn(),
            getAccountEncryptionMode: vi.fn(),
            getConnectedServiceCredentialPlain,
            getConnectedServiceCredentialSealed: vi.fn(),
          },
          establishedRuntimeOwner: { invoke: establishedInvoke },
          revisionedLegacyMaterializationOwner: {
            invoke: revisionedLegacyInvoke,
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
                generation: 'generation-1',
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
      expect(establishedInvoke).not.toHaveBeenCalled();
      expect(revisionedLegacyInvoke).not.toHaveBeenCalled();
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
        listConnectedServiceAuthGroups: vi.fn(async () => []),
        getConnectedServiceAuthGroup: vi.fn(async () => null),
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
      if (!question || question.selection !== 'single') throw new Error('single choice expected');
      const chosen = question.choices.find((choice) => choice.label === 'Primary upstreams');
      if (!chosen) throw new Error('group choice expected');
      return {
        kind: 'questions',
        status: 'answered',
        answers: [{
          questionId: question.id,
          selection: 'single',
          answer: { kind: 'choice', choiceId: chosen.id },
        }],
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

  it('returns typed cancellation and never persists a selection', async () => {
    const store = emptyStore();
    const runtimeOwner = createSelectionRuntime(store);
    const interactions = new TestInteractions(async (request) => {
      if (request.kind !== 'questions') throw new Error('questions expected');
      return { kind: 'questions', status: 'cancelled' };
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
        kind: 'questions',
        status: 'answered',
        answers: [{
          questionId: request.questions[0].id,
          selection: 'single',
          answer: { kind: 'choice', choiceId: 'target-0-forged-suffix' },
        }],
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
      if (question.selection !== 'single') throw new Error('single choice expected');
      return {
        kind: 'questions',
        status: 'answered',
        answers: [{
          questionId: question.id,
          selection: 'single',
          answer: { kind: 'choice', choiceId: question.choices[0].id },
        }],
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
        async invoke() {
          throw new Error('no-session selection must fail before materialization');
        },
      },
      revisionedLegacyMaterializationOwner:
        unavailableLegacyMaterializationOwner,
      api: {
        listConnectedServiceProfiles: vi.fn(),
        listConnectedServiceAuthGroups: vi.fn(),
        getConnectedServiceAuthGroup: vi.fn(),
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
});
