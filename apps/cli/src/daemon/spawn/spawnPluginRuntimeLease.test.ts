import { describe, expect, it, vi } from 'vitest';

import type { ProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';

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
