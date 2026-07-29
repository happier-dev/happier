import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';

import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

import {
  runWithScmBackendRegistryLease,
} from './scmBackendCatalog';

const {
  acquireAuthoritativePluginRuntimeRegistryLeaseMock,
  releaseLeaseMock,
} = vi.hoisted(() => ({
  acquireAuthoritativePluginRuntimeRegistryLeaseMock: vi.fn<(...args: unknown[]) => unknown>(),
  releaseLeaseMock: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease: acquireAuthoritativePluginRuntimeRegistryLeaseMock,
}));

function createContributionRegistry(generationId: string): ResolvedContributionRegistry {
  return {
    generationId,
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
  };
}

function createRuntimeRegistry(contributes: ResolvedContributionRegistry): ResolvedExecutablePluginRuntimeRegistry {
  return {
    contributes,
    resolvePromptAssetBlocks: async () => [],
    hookHandlersByHookId: new Map(),
    agentRuntimesByAgentId: new Map(),
    scmHostingProvidersById: new Map(),
    scmBackendsById: new Map(),
    scmBackendRegistrations: Object.freeze([]),
    networkAllowedUrlOriginsByPluginId: new Map(),
    processSpawnAllowedPathsByPluginId: new Map(),
    pluginDiagnosticsByPluginId: Object.freeze({}),
    activatedPluginIds: new Set(),
    activateContributionsOnDemand: async () => [],
    addRuntimeDisposable: (_pluginId, disposable) => disposable,
    createAgentInvocationServices: () => createUnavailablePluginServices(),
    readHookEventEnvelopeV1,
    retireConsumers: () => {},
    dispose: async () => {},
  };
}

describe('SCM backend registry runtime lease convergence', () => {
  beforeEach(() => {
    acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockReset();
    releaseLeaseMock.mockReset();
  });

  it('uses the authoritative plugin runtime lease for the default backend registry', async () => {
    const runtimeRegistry = createRuntimeRegistry(createContributionRegistry('authoritative-scm-runtime'));
    acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({
      registry: runtimeRegistry,
      source: 'active',
      release: releaseLeaseMock,
    });
    releaseLeaseMock.mockResolvedValue(undefined);

    await runWithScmBackendRegistryLease(undefined, async () => undefined);

    expect(acquireAuthoritativePluginRuntimeRegistryLeaseMock).toHaveBeenCalledTimes(1);
    expect(releaseLeaseMock).toHaveBeenCalledTimes(1);
  });

  it('activates hosting-provider producers before backend consumers and then re-reads the authoritative registry', async () => {
    const contributes = {
      ...createContributionRegistry('authoritative-scm-demand'),
      activationTargets: Object.freeze([
        { pluginId: 'acme.scm', manifest: { contributes: {} } },
        { pluginId: 'acme.hosting', manifest: { contributes: {} } },
      ]),
      scmBackends: Object.freeze([{
        pluginId: 'acme.scm',
        definition: { id: 'git-like' },
      }]),
      scmHostingProviders: Object.freeze([{
        pluginId: 'acme.hosting',
        definition: { id: 'forge' },
      }]),
    } as unknown as ResolvedContributionRegistry;
    const runtimeRegistry = createRuntimeRegistry(contributes);
    const order: string[] = [];
    Object.defineProperty(runtimeRegistry, 'scmBackendRegistrations', {
      configurable: true,
      get() {
        order.push('read');
        return Object.freeze([]);
      },
    });
    const demand = vi.spyOn(runtimeRegistry, 'activateContributionsOnDemand').mockImplementation(async (demands) => {
      order.push(`demand:${demands.map((entry) => entry.family).join(',')}`);
      return [];
    });
    acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({
      registry: runtimeRegistry,
      source: 'active',
      release: releaseLeaseMock,
    });
    releaseLeaseMock.mockResolvedValue(undefined);

    expect(order).toEqual([]);
    await runWithScmBackendRegistryLease(undefined, async () => undefined);

    expect(demand).toHaveBeenCalledTimes(2);
    expect(demand).toHaveBeenNthCalledWith(1, [
      { pluginId: 'acme.hosting', family: 'scmHostingProviders', localId: 'forge' },
    ]);
    expect(demand).toHaveBeenNthCalledWith(2, [
      { pluginId: 'acme.scm', family: 'scmBackends', localId: 'git-like' },
    ]);
    expect(order).toEqual([
      'demand:scmHostingProviders',
      'demand:scmBackends',
      'read',
    ]);
    expect(releaseLeaseMock).toHaveBeenCalledTimes(1);
  });

  it('retains the authoritative runtime lease until the complete SCM operation settles', async () => {
    const runtimeRegistry = createRuntimeRegistry(createContributionRegistry('authoritative-scm-operation'));
    acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({
      registry: runtimeRegistry,
      source: 'active',
      release: releaseLeaseMock,
    });
    releaseLeaseMock.mockResolvedValue(undefined);

    let finishOperation!: () => void;
    let markOperationStarted!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      markOperationStarted = resolve;
    });
    const operation = runWithScmBackendRegistryLease(undefined, async (registry) => {
      expect(registry.listBackends()).toEqual([]);
      expect(releaseLeaseMock).not.toHaveBeenCalled();
      markOperationStarted();
      await new Promise<void>((resolve) => {
        finishOperation = resolve;
      });
      expect(releaseLeaseMock).not.toHaveBeenCalled();
      return 'settled';
    });

    await operationStarted;
    expect(acquireAuthoritativePluginRuntimeRegistryLeaseMock).toHaveBeenCalledTimes(1);
    expect(releaseLeaseMock).not.toHaveBeenCalled();

    finishOperation();
    await expect(operation).resolves.toBe('settled');
    expect(releaseLeaseMock).toHaveBeenCalledTimes(1);
  });

  it('releases the authoritative runtime lease when an SCM operation fails', async () => {
    const runtimeRegistry = createRuntimeRegistry(createContributionRegistry('authoritative-scm-failure'));
    acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({
      registry: runtimeRegistry,
      source: 'active',
      release: releaseLeaseMock,
    });
    releaseLeaseMock.mockResolvedValue(undefined);

    await expect(runWithScmBackendRegistryLease(undefined, async () => {
      throw new Error('operation failed');
    })).rejects.toThrow('operation failed');

    expect(releaseLeaseMock).toHaveBeenCalledTimes(1);
  });

  it('releases the authoritative runtime lease when SCM activation fails', async () => {
    const contributes = {
      ...createContributionRegistry('authoritative-scm-activation-failure'),
      scmBackends: Object.freeze([{
        pluginId: 'acme.scm',
        definition: { id: 'failing' },
      }]),
    } as unknown as ResolvedContributionRegistry;
    const runtimeRegistry = createRuntimeRegistry(contributes);
    vi.spyOn(runtimeRegistry, 'activateContributionsOnDemand').mockRejectedValue(
      new Error('activation failed'),
    );
    acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({
      registry: runtimeRegistry,
      source: 'active',
      release: releaseLeaseMock,
    });
    releaseLeaseMock.mockResolvedValue(undefined);

    await expect(runWithScmBackendRegistryLease(undefined, async () => undefined))
      .rejects.toThrow('activation failed');

    expect(releaseLeaseMock).toHaveBeenCalledTimes(1);
  });
});
