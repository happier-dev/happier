import { describe, expect, it, vi } from 'vitest';

import { resolveSessionPluginProjectAdmissionV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { PluginMcpServerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/mcp';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createProviderLaunchResourceScope, type ProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';

const hoisted = vi.hoisted(() => ({
  acquireAuthoritativePluginRuntimeRegistryLease: vi.fn(),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease:
    hoisted.acquireAuthoritativePluginRuntimeRegistryLease,
}));

vi.mock('@/configuration', () => ({
  configuration: {
    happyHomeDir: '/tmp/happier-home',
  },
}));

import { createSpawnPluginRuntimeLease } from './spawnPluginRuntimeLease';

describe('spawn plugin runtime lease', () => {
  it('uses one accepted Project per launch and keeps that result for the admitted lease', async () => {
    const restricted = 'example.restricted';
    const unrestricted = 'example.unrestricted';
    const alsoRestricted = 'example.also-restricted';
    const projectScope = { kind: 'only', projectKeys: ['chosen'] } as const;
    const mcpServer = (pluginId: string) => ({
      pluginId, provenance: 'external' as const, source: { kind: 'path' as const },
      definition: PluginMcpServerContributionV1Schema.parse({
        id: 'search', title: 'Search', kind: 'static',
        transport: { kind: 'http', url: 'https://mcp.example.test/' },
      }),
    });
    const registry = { contributes: createResolvedContributionRegistry({
      mcpServers: [mcpServer(restricted), mcpServer(unrestricted), mcpServer(alsoRestricted)],
    }) };
    hoisted.acquireAuthoritativePluginRuntimeRegistryLease.mockResolvedValue({
      registry, source: 'active', release: async () => undefined,
    });
    let acceptedProject: string | null = null;
    const readAcceptedProjectKey = vi.fn(async () => acceptedProject);
    const launch = () => createSpawnPluginRuntimeLease(createProviderLaunchResourceScope(), () =>
      resolveSessionPluginProjectAdmissionV1({
        scopesByPluginId: [[restricted, { ...projectScope, projectKeys: [...projectScope.projectKeys] }],
          [alsoRestricted, { kind: 'only', projectKeys: ['different'] }]], readAcceptedProjectKey,
      }));
    const pluginIds = (lease: Awaited<ReturnType<ReturnType<typeof launch>['acquire']>>) =>
      lease.registry.contributes.mcpServers?.map(entry => entry.pluginId);
    const withoutProject = launch();
    const withProject = launch();
    try {
      expect(pluginIds(await withoutProject.acquire())).toEqual([unrestricted]);
      expect(withoutProject.projectRefusals?.get(restricted)).toBe('plugin_limited_to_other_projects');
      acceptedProject = 'chosen';
      expect(pluginIds(await withoutProject.acquire())).toEqual([unrestricted]);
      expect(readAcceptedProjectKey).toHaveBeenCalledTimes(1);
      expect(pluginIds(await withProject.acquire())).toEqual([restricted, unrestricted]);
      expect(readAcceptedProjectKey).toHaveBeenCalledTimes(2);
      await resolveSessionPluginProjectAdmissionV1({ scopesByPluginId: [], readAcceptedProjectKey });
      expect(readAcceptedProjectKey).toHaveBeenCalledTimes(2);
    } finally {
      await withoutProject.release();
      await withProject.release();
      hoisted.acquireAuthoritativePluginRuntimeRegistryLease.mockReset();
    }
  });

  it('shares one accepted generation until release and cannot carry it into the next acquisition', async () => {
    const releaseA = vi.fn(async () => undefined);
    const releaseB = vi.fn(async () => undefined);
    const registryA = Object.freeze({ generation: 'A' });
    const registryB = Object.freeze({ generation: 'B' });
    const leaseA = Object.freeze({
      registry: registryA,
      source: 'active' as const,
      release: releaseA,
    });
    const leaseB = Object.freeze({
      registry: registryB,
      source: 'active' as const,
      release: releaseB,
    });
    hoisted.acquireAuthoritativePluginRuntimeRegistryLease
      .mockResolvedValueOnce(leaseA)
      .mockResolvedValueOnce(leaseB);
    const register = vi.fn();
    // This owner only consumes resource registration in the lease unit.
    const scope = Object.freeze({ register }) as unknown as ProviderLaunchResourceScope;
    const lease = createSpawnPluginRuntimeLease(scope);

    const acceptedA = await lease.acquire();
    const repeatedA = await lease.acquire();

    expect(acceptedA).toBe(leaseA);
    expect(repeatedA).toBe(leaseA);
    expect(lease.currentRegistry).toBe(registryA);
    expect(hoisted.acquireAuthoritativePluginRuntimeRegistryLease).toHaveBeenCalledTimes(1);

    await lease.release();

    expect(releaseA).toHaveBeenCalledTimes(1);
    expect(lease.currentRegistry).toBeNull();

    const acceptedB = await lease.acquire();

    expect(acceptedB).toBe(leaseB);
    expect(lease.currentRegistry).toBe(registryB);
    expect(hoisted.acquireAuthoritativePluginRuntimeRegistryLease).toHaveBeenCalledTimes(2);
    expect(releaseA).toHaveBeenCalledTimes(1);

    await lease.release();
    await lease.release();

    expect(releaseB).toHaveBeenCalledTimes(1);
    expect(lease.currentRegistry).toBeNull();
    expect(register).toHaveBeenCalledTimes(2);
  });
});
