import { beforeEach, describe, expect, it, vi } from 'vitest';


import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ScmBackendPluginRuntimeRegistry } from './pluginBackends/runtimeRegistry';

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

function createContributionRegistry(): ResolvedContributionRegistry {
  return createResolvedContributionRegistry({});
}

function createRuntimeRegistry(contributes: ResolvedContributionRegistry): ScmBackendPluginRuntimeRegistry & Pick<ResolvedExecutablePluginRuntimeRegistry, 'activateContributionsOnDemand'> {
  return {
    contributes,
    scmHostingProvidersById: new Map(),
    scmBackendsById: new Map(),
    scmBackendRegistrations: Object.freeze([]),
    activateContributionsOnDemand: async () => [],
  };
}

describe('SCM backend registry runtime lease convergence', () => {
  beforeEach(() => {
    acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockReset();
    releaseLeaseMock.mockReset();
  });

  it('activates hosting-provider producers before backend consumers and then re-reads the authoritative registry', async () => {
    const contributes = {
      ...createContributionRegistry(),
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

  it('can prepare a Workflow checkout while optional hosting providers are unavailable', async () => {
    const contributes = {
      ...createContributionRegistry(),
      scmHostingProviders: Object.freeze([{
        pluginId: 'acme.hosting',
        definition: { id: 'forge' },
      }]),
    } as unknown as ResolvedContributionRegistry;
    const runtimeRegistry = createRuntimeRegistry(contributes);
    vi.spyOn(runtimeRegistry, 'activateContributionsOnDemand').mockRejectedValue(new Error('hosting unavailable'));
    acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({
      registry: runtimeRegistry, source: 'active', release: releaseLeaseMock,
    });

    const { prepareWorkflowAcceptedWorkspaceTarget } = await import('@/daemon/workflows/resolveWorkflowWorkspace');
    await expect(prepareWorkflowAcceptedWorkspaceTarget({
      projectTarget: { machineId: 'machine-1', directory: process.cwd() },
      definition: { version: 1, inputs: [], defaults: {}, blocks: [
        { kind: 'action', id: 'machines', actionId: 'machines.list', input: {} },
      ] },
    })).resolves.toMatchObject({ ok: true, workspaceTarget: { project: { directory: process.cwd() } } });
  });

  it('retains the authoritative runtime lease until the complete SCM operation settles', async () => {
    const runtimeRegistry = createRuntimeRegistry(createContributionRegistry());
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
    const runtimeRegistry = createRuntimeRegistry(createContributionRegistry());
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
      ...createContributionRegistry(),
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
