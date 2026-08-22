import { describe, expect, it, vi } from 'vitest';

import type {
  ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import type {
  ManagedProviderRuntime } from '@happier-dev/plugin-sdk/providers';
import type {
  ManagedServiceHandle,
  ManagedServices,
} from '@happier-dev/plugin-sdk/managed-services';
import {
  type QualifiedConnectedAccountPurposeBindingsV1,
} from '@happier-dev/protocol';

import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import {
  createPluginReloadController,
  type PluginReloadController,
} from '@/plugins/runtime/reload/controller';
import type {
  ManagedProviderExplicitStartJoinInput,
  ManagedProviderExplicitStartJoinResult,
  ResolvedExecutablePluginRuntimeRegistry,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import { createPublicManagedProviderRuntimeStartOperation } from './publicManagedRuntimeStart';

function managedServiceHandle(dispose: () => Promise<void>): ManagedServiceHandle {
  const snapshot = Object.freeze({
    id: 'managed-provider',
    state: 'healthy' as const,
    mode: 'spawn' as const,
    baseUrl: 'http://127.0.0.1:45123',
    startedAtMs: 10,
    lastHealthyAtMs: 11,
    diagnostics: Object.freeze([]),
    diagnosticsTruncated: false,
  });
  return Object.freeze({
    snapshot: () => snapshot,
    observe(listener: Parameters<ManagedServiceHandle['observe']>[0]) {
      listener(snapshot);
      return Object.freeze({ dispose() {} });
    },
    async waitUntilHealthy() { return snapshot; },
    async request() { throw new Error('Unexpected managed service request'); },
    async stop() { return Object.freeze({ status: 'stopped' as const }); },
    dispose,
  });
}

function connectedAccounts(): ConnectedAccountsService {
  return Object.freeze({
    async getBinding() { return null; },
    async requestSelection() { throw new Error('selection unavailable'); },
    async materialize() { throw new Error('materialization unavailable'); },
    listAccounts: async () => {
        throw new Error('Connected Account listing is outside this fixture');
    },
    materializeListedAccount: async () => {
        throw new Error('Exact-listed Connected Account materialization is outside this fixture');
    },
    watch() { return Object.freeze({ dispose() {} }); },
  });
}

function managedServices(): ManagedServices {
  const unavailable = async (): Promise<never> => {
    throw new Error('not used by the fixture runtime');
  };
  return Object.freeze({
    dependencies: Object.freeze({
      status: unavailable,
      ensure: unavailable,
      update: unavailable,
      remove: unavailable,
    }),
    supervise: unavailable,
  });
}

function runtimeRegistry(input: Readonly<{
  pluginId: string;
  localId: string;
  runtime: ManagedProviderRuntime;
  invocationCleanup: () => void;
  projectEndpointAccess: ReturnType<typeof vi.fn>;
  acquireRuntime: ReturnType<typeof vi.fn>;
  createInvocationServices: ReturnType<typeof vi.fn>;
  addRuntimeDisposable: ReturnType<typeof vi.fn>;
  settleRetiredBackgroundServices: ReturnType<typeof vi.fn>;
  disposeRegistry: ReturnType<typeof vi.fn>;
  runManagedProviderExplicitStart?: (
    operation: ManagedProviderExplicitStartJoinInput,
  ) => Promise<ManagedProviderExplicitStartJoinResult>;
}>): ResolvedExecutablePluginRuntimeRegistry {
  return {
    contributes: {
      agents: Object.freeze([]),
      actions: Object.freeze([]),
      resources: Object.freeze([]),
      uiViewsV2: Object.freeze([]),
      uiRenderersV2: Object.freeze([]),
      uiTranslationsV2: Object.freeze([]),
      activationTargets: Object.freeze([]),
      catalogEntriesById: Object.freeze({}),
      agentDefinitionsById: new Map(),
      pluginDiagnosticsByPluginId: Object.freeze({}),
    },
    hookHandlersByHookId: new Map(),
    agentRuntimesByAgentId: new Map(),
    scmHostingProvidersById: new Map(),
    pluginDiagnosticsByPluginId: Object.freeze({}),
    activatedPluginIds: new Set([input.pluginId]),
    activateContributionsOnDemand: async () => [],
    acquireManagedProviderRuntime: input.acquireRuntime,
    createManagedProviderRuntimeInvocationServices: input.createInvocationServices,
    ...(input.runManagedProviderExplicitStart
      ? { runManagedProviderExplicitStart: input.runManagedProviderExplicitStart }
      : {}),
    resolvePromptAssetBlocks: async () => [],
    addRuntimeDisposable: input.addRuntimeDisposable,
    createAgentInvocationServices: async () => createUnavailablePluginServices(),
    retirePluginConsumers: () => {},
    settleRetiredBackgroundServices: input.settleRetiredBackgroundServices,
    retireConsumers: () => {},
    dispose: input.disposeRegistry,
  };
}

async function establishManagedProviderExplicitStart(
  operation: ManagedProviderExplicitStartJoinInput,
): Promise<ManagedProviderExplicitStartJoinResult> {
  const controller = new AbortController();
  return Object.freeze({
    status: 'established' as const,
    value: await operation.establish(Object.freeze({
      signal: controller.signal,
      async release() {
        controller.abort('managed Provider explicit-start retired');
      },
    })),
  });
}

describe('public managed Provider explicit-start production operation', () => {
  it.each([
    ['bundled', 'happier.provider.ollama'],
    ['external', 'acme.provider.external'],
    ['development', 'acme.provider.development'],
  ] as const)('uses the same public runtime and SVC09 path for %s plugins', async (_provenance, pluginId) => {
    const localId = 'managed';
    const purposeBindings: QualifiedConnectedAccountPurposeBindingsV1 = {
      v: 1,
      bindings: [{
        purpose: {
          consumer: { pluginId, localId },
          purpose: 'upstream',
        },
        target: {
          kind: 'account',
          account: {
            service: {
              pluginId: 'happier.connected-account.openai',
              localId: 'openai',
            },
            accountId: 'work',
          },
        },
      }],
    };
    const serviceDispose = vi.fn(async () => undefined);
    const service = managedServiceHandle(serviceDispose);
    const start = vi.fn<ManagedProviderRuntime['start']>(async (request) => {
      expect(request).toEqual({
        reason: 'explicitStartLocal',
        endpointTemplateIds: ['chat'],
      });
      return Object.freeze({
        service,
        endpoints: Object.freeze([Object.freeze({
          endpointTemplateId: 'chat',
          endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
        })]),
      });
    });
    const runtime = Object.freeze({ start });
    const acquiredRuntime = Object.freeze({
      runtime,
      activationGeneration: 'activation-7',
      immutableGenerationId: 'immutable-7',
      isCurrent: () => true,
    });
    const acquireRuntime = vi.fn(async () => acquiredRuntime);
    const invocationCleanup = vi.fn();
    const projectionCleanup = vi.fn();
    const projectEndpointAccess = vi.fn(async () => Object.freeze({
      access: Object.freeze({ endpointUrl: () => 'http://127.0.0.1:45123/v1' }),
      isCurrent: () => true,
      cleanup: projectionCleanup,
    }));
    const accounts = connectedAccounts();
    const services = managedServices();
    const createInvocationServices = vi.fn(async () => Object.freeze({
      connectedAccounts: accounts,
      managedServices: services,
      projectEndpointAccess,
      cleanup: invocationCleanup,
    }));
    const runtimeDisposables: Array<Readonly<{ dispose(): void | Promise<void> }>> = [];
    const addRuntimeDisposable = vi.fn((_registeredPluginId, disposable) => {
      runtimeDisposables.push(disposable);
      return disposable;
    });
    const disposeRegistry = vi.fn(async () => {
      for (const disposable of runtimeDisposables.splice(0).reverse()) {
        await disposable.dispose();
      }
    });
    const settleRetiredBackgroundServices = vi.fn(async () => {
      for (const disposable of runtimeDisposables.splice(0).reverse()) {
        await disposable.dispose();
      }
    });
    const registry = runtimeRegistry({
      pluginId,
      localId,
      runtime,
      invocationCleanup,
      projectEndpointAccess,
      acquireRuntime,
      createInvocationServices,
      runManagedProviderExplicitStart: establishManagedProviderExplicitStart,
      addRuntimeDisposable,
      settleRetiredBackgroundServices,
      disposeRegistry,
    });
    const controller = createPluginReloadController();
    await controller.adoptPreparedRuntimeRegistry({
      registry,
      changedPluginIds: Object.freeze([pluginId]),
      durableRevision: 1,
      runningSessionDisposition: 'retainRunningSessions',
    });
    const startExplicit = createPublicManagedProviderRuntimeStartOperation({
      machineId: 'machine-a',
      happyHomeDir: '/tmp/happier-managed-provider-test',
      controller,
    });

    await expect(startExplicit({
      contributionKey: `${pluginId}/${localId}`,
      identity: Object.freeze({ pluginId, localId }),
      request: Object.freeze({
        reason: 'explicitStartLocal',
        endpointTemplateIds: Object.freeze(['chat']),
      }),
      purposeBindings,
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
    })).resolves.toEqual({ status: 'running' });

    expect(start).toHaveBeenCalledOnce();
    expect(acquireRuntime).toHaveBeenCalledTimes(2);
    expect(createInvocationServices).toHaveBeenCalledWith(expect.objectContaining({
      identity: { pluginId, localId },
      purposeBindings,
      operationClaim: {
        kind: 'explicitStart',
        machineId: 'machine-a',
      },
      signal: expect.any(AbortSignal),
      isCurrent: expect.any(Function),
    }));
    expect(projectEndpointAccess).toHaveBeenCalledOnce();
    expect(addRuntimeDisposable).toHaveBeenCalledOnce();
    expect(addRuntimeDisposable).toHaveBeenCalledWith(
      pluginId,
      expect.objectContaining({ dispose: expect.any(Function) }),
    );
    expect(serviceDispose).not.toHaveBeenCalled();
    expect(invocationCleanup).not.toHaveBeenCalled();

    const replacementDispose = vi.fn(async () => undefined);
    const replacementRegistry: ResolvedExecutablePluginRuntimeRegistry = {
      ...registry,
      contributes: registry.contributes,
      dispose: replacementDispose,
    };
    await controller.adoptPreparedRuntimeRegistry({
      registry: replacementRegistry,
      changedPluginIds: Object.freeze([pluginId]),
      durableRevision: 2,
      runningSessionDisposition: 'retainRunningSessions',
    });

    expect(settleRetiredBackgroundServices).toHaveBeenCalledWith([pluginId]);
    expect(projectionCleanup).toHaveBeenCalledOnce();
    expect(serviceDispose).toHaveBeenCalledOnce();
    expect(invocationCleanup).toHaveBeenCalledOnce();

    await controller.shutdown({ timeoutMs: 0 });
    expect(replacementDispose).toHaveBeenCalledOnce();
  });

  it('joins exact pending and settled explicit starts before invocation authority is created', async () => {
    const pluginId = 'acme.provider.exact-start';
    const localId = 'managed';
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const serviceDispose = vi.fn(async () => undefined);
    const service = managedServiceHandle(serviceDispose);
    const start = vi.fn<ManagedProviderRuntime['start']>(async () => {
      await startGate;
      return Object.freeze({
        service,
        endpoints: Object.freeze([Object.freeze({
          endpointTemplateId: 'chat',
          endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
        })]),
      });
    });
    const acquiredRuntime = Object.freeze({
      runtime: Object.freeze({ start }),
      activationGeneration: 'activation-7',
      immutableGenerationId: 'immutable-7',
      isCurrent: () => true,
    });
    const acquireRuntime = vi.fn(async () => acquiredRuntime);
    const invocationCleanup = vi.fn(async () => undefined);
    const projectionCleanup = vi.fn(async () => undefined);
    const projectEndpointAccess = vi.fn(async () => Object.freeze({
      access: Object.freeze({ endpointUrl: () => 'http://127.0.0.1:45123/v1' }),
      isCurrent: () => true,
      cleanup: projectionCleanup,
    }));
    const createInvocationServices = vi.fn(async () => Object.freeze({
      connectedAccounts: connectedAccounts(),
      managedServices: managedServices(),
      projectEndpointAccess,
      cleanup: invocationCleanup,
    }));
    const pendingByOperation = new Map<string, Promise<
      Awaited<ReturnType<ManagedProviderExplicitStartJoinInput['establish']>>
    >>();
    const runManagedProviderExplicitStart = vi.fn(async (
      operation: ManagedProviderExplicitStartJoinInput,
    ): Promise<ManagedProviderExplicitStartJoinResult> => {
      if (!operation.isCurrent()) {
        return Object.freeze({ status: 'not_current' as const });
      }
      const key = JSON.stringify([
        operation.machineId,
        operation.identity.pluginId,
        operation.identity.localId,
        operation.purposeBindings,
      ]);
      let pending = pendingByOperation.get(key);
      if (!pending) {
        const controller = new AbortController();
        pending = operation.establish(Object.freeze({
          signal: controller.signal,
          async release() {
            controller.abort('managed Provider explicit-start retired');
          },
        }));
        pendingByOperation.set(key, pending);
      }
      try {
        return Object.freeze({
          status: 'established' as const,
          value: await pending,
        });
      } catch (error) {
        pendingByOperation.delete(key);
        throw error;
      }
    });
    const runtimeDisposables: Array<Readonly<{
      dispose(): void | Promise<void>;
    }>> = [];
    const addRuntimeDisposable = vi.fn((_registeredPluginId, disposable) => {
      runtimeDisposables.push(disposable);
      return disposable;
    });
    const registry = runtimeRegistry({
      pluginId,
      localId,
      runtime: acquiredRuntime.runtime,
      invocationCleanup,
      projectEndpointAccess,
      acquireRuntime,
      createInvocationServices,
      runManagedProviderExplicitStart,
      addRuntimeDisposable,
      settleRetiredBackgroundServices: vi.fn(async () => undefined),
      disposeRegistry: vi.fn(async () => undefined),
    });
    const controller = createPluginReloadController();
    await controller.adoptPreparedRuntimeRegistry({
      registry,
      changedPluginIds: Object.freeze([pluginId]),
      durableRevision: 1,
      runningSessionDisposition: 'retainRunningSessions',
    });
    const startExplicit = createPublicManagedProviderRuntimeStartOperation({
      machineId: 'machine-a',
      happyHomeDir: '/tmp/happier-managed-provider-test',
      controller,
    });
    const purposeBindings: QualifiedConnectedAccountPurposeBindingsV1 = {
      v: 1,
      bindings: [],
    };
    const request = () => Object.freeze({
      contributionKey: `${pluginId}/${localId}`,
      identity: Object.freeze({ pluginId, localId }),
      request: Object.freeze({
        reason: 'explicitStartLocal' as const,
        endpointTemplateIds: Object.freeze(['chat']),
      }),
      purposeBindings,
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
    });

    const first = startExplicit(request());
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const concurrentRetry = startExplicit(request());
    releaseStart();

    await expect(Promise.all([first, concurrentRetry])).resolves.toEqual([
      { status: 'running' },
      { status: 'running' },
    ]);
    await expect(startExplicit(request())).resolves.toEqual({ status: 'running' });

    expect(runManagedProviderExplicitStart).toHaveBeenCalledTimes(3);
    expect(createInvocationServices).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(addRuntimeDisposable).toHaveBeenCalledOnce();

    await Promise.all(runtimeDisposables.map(async (disposable) => {
      await disposable.dispose();
    }));
    await controller.shutdown({ timeoutMs: 0 });
  });

  it('settles a registered live effect even when the operation lease release rejects', async () => {
    const pluginId = 'acme.provider.release-failure';
    const localId = 'managed';
    const serviceDispose = vi.fn(async () => undefined);
    const service = managedServiceHandle(serviceDispose);
    const start = vi.fn<ManagedProviderRuntime['start']>(async () => Object.freeze({
      service,
      endpoints: Object.freeze([Object.freeze({
        endpointTemplateId: 'chat',
        endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
      })]),
    }));
    const acquiredRuntime = Object.freeze({
      runtime: Object.freeze({ start }),
      activationGeneration: 'activation-7',
      immutableGenerationId: 'immutable-7',
      isCurrent: () => true,
    });
    const acquireRuntime = vi.fn(async () => acquiredRuntime);
    const invocationCleanup = vi.fn();
    const projectionCleanup = vi.fn();
    const projectEndpointAccess = vi.fn(async () => Object.freeze({
      access: Object.freeze({ endpointUrl: () => 'http://127.0.0.1:45123/v1' }),
      isCurrent: () => true,
      cleanup: projectionCleanup,
    }));
    const createInvocationServices = vi.fn(async () => Object.freeze({
      connectedAccounts: connectedAccounts(),
      managedServices: managedServices(),
      projectEndpointAccess,
      cleanup: invocationCleanup,
    }));
    const runtimeDisposables: Array<Readonly<{ dispose(): void | Promise<void> }>> = [];
    const addRuntimeDisposable = vi.fn((_registeredPluginId, disposable) => {
      runtimeDisposables.push(disposable);
      return disposable;
    });
    const registry = runtimeRegistry({
      pluginId,
      localId,
      runtime: acquiredRuntime.runtime,
      invocationCleanup,
      projectEndpointAccess,
      acquireRuntime,
      createInvocationServices,
      runManagedProviderExplicitStart: establishManagedProviderExplicitStart,
      addRuntimeDisposable,
      settleRetiredBackgroundServices: vi.fn(async () => undefined),
      disposeRegistry: vi.fn(async () => undefined),
    });
    const release = vi.fn(async () => {
      throw new Error('lease release acknowledgement failed');
    });
    const baseController = createPluginReloadController();
    const controller: PluginReloadController = Object.freeze({
      ...baseController,
      tryAcquireRuntimeRegistry: () => Object.freeze({
        registry,
        source: 'active' as const,
        release,
      }),
    });
    const startExplicit = createPublicManagedProviderRuntimeStartOperation({
      machineId: 'machine-a',
      happyHomeDir: '/tmp/happier-managed-provider-test',
      controller,
    });

    await expect(startExplicit({
      contributionKey: `${pluginId}/${localId}`,
      identity: Object.freeze({ pluginId, localId }),
      request: Object.freeze({
        reason: 'explicitStartLocal',
        endpointTemplateIds: Object.freeze(['chat']),
      }),
      purposeBindings: { v: 1, bindings: [] },
      isAuthorizationCurrent: () => true,
      revalidateAuthorization: async () => true,
    })).resolves.toEqual({ status: 'running' });

    expect(release).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(addRuntimeDisposable).toHaveBeenCalledOnce();
    expect(serviceDispose).not.toHaveBeenCalled();

    await runtimeDisposables[0]!.dispose();
    expect(projectionCleanup).toHaveBeenCalledOnce();
    expect(serviceDispose).toHaveBeenCalledOnce();
    expect(invocationCleanup).toHaveBeenCalledOnce();
    await baseController.shutdown({ timeoutMs: 0 });
  });

  it('never orphans a transferred live effect when authority changes at the transfer boundary', async () => {
    const pluginId = 'acme.provider.transfer-race';
    const localId = 'managed';
    const serviceDispose = vi.fn(async () => undefined);
    const service = managedServiceHandle(serviceDispose);
    const start = vi.fn<ManagedProviderRuntime['start']>(async () => Object.freeze({
      service,
      endpoints: Object.freeze([Object.freeze({
        endpointTemplateId: 'chat',
        endpoint: Object.freeze({ kind: 'servicePath' as const, path: '/v1' }),
      })]),
    }));
    const acquiredRuntime = Object.freeze({
      runtime: Object.freeze({ start }),
      activationGeneration: 'activation-7',
      immutableGenerationId: 'immutable-7',
      isCurrent: () => true,
    });
    const acquireRuntime = vi.fn(async () => acquiredRuntime);
    const invocationCleanup = vi.fn();
    const projectionCleanup = vi.fn();
    const projectEndpointAccess = vi.fn(async () => Object.freeze({
      access: Object.freeze({ endpointUrl: () => 'http://127.0.0.1:45123/v1' }),
      isCurrent: () => true,
      cleanup: projectionCleanup,
    }));
    const createInvocationServices = vi.fn(async () => Object.freeze({
      connectedAccounts: connectedAccounts(),
      managedServices: managedServices(),
      projectEndpointAccess,
      cleanup: invocationCleanup,
    }));
    const runtimeDisposables: Array<Readonly<{ dispose(): void | Promise<void> }>> = [];
    // The account authority changes in the exact tick the launch resources stop
    // being the caller's and become the runtime disposable registry's.
    let authorizationCurrent = true;
    const addRuntimeDisposable = vi.fn((_registeredPluginId, disposable) => {
      runtimeDisposables.push(disposable);
      authorizationCurrent = false;
      return disposable;
    });
    const registry = runtimeRegistry({
      pluginId,
      localId,
      runtime: acquiredRuntime.runtime,
      invocationCleanup,
      projectEndpointAccess,
      acquireRuntime,
      createInvocationServices,
      runManagedProviderExplicitStart: establishManagedProviderExplicitStart,
      addRuntimeDisposable,
      settleRetiredBackgroundServices: vi.fn(async () => undefined),
      disposeRegistry: vi.fn(async () => undefined),
    });
    const controller = createPluginReloadController();
    await controller.adoptPreparedRuntimeRegistry({
      registry,
      changedPluginIds: Object.freeze([pluginId]),
      durableRevision: 1,
      runningSessionDisposition: 'retainRunningSessions',
    });
    const startExplicit = createPublicManagedProviderRuntimeStartOperation({
      machineId: 'machine-a',
      happyHomeDir: '/tmp/happier-managed-provider-test',
      controller,
    });
    const revalidateAuthorization = vi.fn(async () => authorizationCurrent);

    await expect(startExplicit({
      contributionKey: `${pluginId}/${localId}`,
      identity: Object.freeze({ pluginId, localId }),
      request: Object.freeze({
        reason: 'explicitStartLocal',
        endpointTemplateIds: Object.freeze(['chat']),
      }),
      purposeBindings: { v: 1, bindings: [] },
      isAuthorizationCurrent: () => authorizationCurrent,
      revalidateAuthorization,
    })).resolves.toEqual({ status: 'running' });

    expect(addRuntimeDisposable).toHaveBeenCalledOnce();
    expect(serviceDispose).not.toHaveBeenCalled();
    expect(invocationCleanup).not.toHaveBeenCalled();
    expect(projectionCleanup).not.toHaveBeenCalled();

    await runtimeDisposables[0]!.dispose();
    expect(projectionCleanup).toHaveBeenCalledOnce();
    expect(serviceDispose).toHaveBeenCalledOnce();
    expect(invocationCleanup).toHaveBeenCalledOnce();
    await controller.shutdown({ timeoutMs: 0 });
  });
});
