import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExternalSessionExecutionSurface } from '@/session/external/providerOps';

const {
  resolveExecutionSurfacesMock,
  activateAgentRuntimeContributionOnDemandMock,
  acquireAuthoritativePluginRuntimeRegistryLeaseMock,
} = vi.hoisted(() => ({
  resolveExecutionSurfacesMock: vi.fn(),
  activateAgentRuntimeContributionOnDemandMock: vi.fn(
    async (_registry: unknown, _agentId: unknown) => {},
  ),
  acquireAuthoritativePluginRuntimeRegistryLeaseMock: vi.fn(),
}));

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
  getSessionHostBridge: () => ({
    resolveExecutionSurfaces: (...args: unknown[]) => resolveExecutionSurfacesMock(...args),
  }),
}));

vi.mock('@/agent/runtime/registry/activationDemand', () => ({
  activateAgentRuntimeContributionOnDemand:
    (registry: unknown, agentId: unknown) =>
      activateAgentRuntimeContributionOnDemandMock(registry, agentId),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease:
    () => acquireAuthoritativePluginRuntimeRegistryLeaseMock(),
}));

describe('resolveExternalSessionSurfaceOps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('demands the exact Agent and resolves ordinary operations from the held current lease', async () => {
    const retirement = new AbortController();
    const runtimeLease = {
      generation: 'plugin-generation-1',
      retirementSignal: retirement.signal,
      isCurrent: () => true,
      externalSessions: {},
    };
    const registry = {
      agentRuntimesByAgentId: new Map([['opencode', runtimeLease]]),
    };
    const release = vi.fn(async () => {});
    acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({ registry, release });
    const fallbackOps: ExternalSessionExecutionSurface = {};
    resolveExecutionSurfacesMock.mockResolvedValue({
      externalSession: fallbackOps,
    });

    const { resolveExternalSessionSurfaceOps } = await import('./providerOpsResolution');
    const resolved = await resolveExternalSessionSurfaceOps('opencode');
    expect(resolved).not.toBe(fallbackOps);
    expect(resolved.externalLinkedTakeoverWriterSafety).toBe('unsupported');
    expect(activateAgentRuntimeContributionOnDemandMock).toHaveBeenCalledWith(
      registry,
      'opencode',
    );
    expect(resolveExecutionSurfacesMock).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each(['absent', 'stale', 'retired'] as const)(
    'fails closed when the held lease contribution is %s even if bridge re-resolution could succeed',
    async (state) => {
      const retirement = new AbortController();
      if (state === 'retired') retirement.abort();
      const runtimeLease = {
        generation: 'plugin-generation-1',
        retirementSignal: retirement.signal,
        isCurrent: () => state !== 'stale',
        ...(state === 'absent' ? {} : { externalSessions: {} }),
      };
      const release = vi.fn(async () => {});
      const registry = {
        agentRuntimesByAgentId: new Map([['opencode', runtimeLease]]),
      };
      acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({
        registry,
        release,
      });
      resolveExecutionSurfacesMock.mockResolvedValue({
        externalSession: {} satisfies ExternalSessionExecutionSurface,
      });

      const { resolveExternalSessionSurfaceOps } = await import('./providerOpsResolution');
      await expect(resolveExternalSessionSurfaceOps('opencode')).rejects.toThrow(
        /missing current external-session Agent operations/i,
      );
      expect(resolveExecutionSurfacesMock).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it('fails closed for follow when the held lease has no contribution instead of mixing generations', async () => {
    const retirement = new AbortController();
    const release = vi.fn(async () => {});
    const runtimeLease = {
      generation: 'plugin-generation-1',
      retirementSignal: retirement.signal,
      isCurrent: () => true,
    };
    const registry = {
      agentRuntimesByAgentId: new Map([['opencode', runtimeLease]]),
    };
    acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({
      registry,
      release,
    });
    resolveExecutionSurfacesMock.mockResolvedValue({
      externalSession: {} satisfies ExternalSessionExecutionSurface,
    });

    const { resolveGenerationBoundExternalSessionFollowSurface } =
      await import('./providerOpsResolution');
    await expect(resolveGenerationBoundExternalSessionFollowSurface(
      'opencode',
      'link-generation-1',
    )).rejects.toThrow(/missing current external-session Agent operations/i);
    expect(resolveExecutionSurfacesMock).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('binds follow operations and lifecycle coordinates to the same current lease', async () => {
    const retirement = new AbortController();
    const release = vi.fn(async () => {});
    const runtimeLease = {
      generation: 'plugin-generation-1',
      retirementSignal: retirement.signal,
      isCurrent: () => true,
      externalSessions: {},
    };
    const registry = {
      agentRuntimesByAgentId: new Map([['opencode', runtimeLease]]),
    };
    acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({
      registry,
      release,
    });
    const fallbackOps: ExternalSessionExecutionSurface = {};
    resolveExecutionSurfacesMock.mockResolvedValue({ externalSession: fallbackOps });

    const { resolveGenerationBoundExternalSessionFollowSurface } =
      await import('./providerOpsResolution');
    const resolved = await resolveGenerationBoundExternalSessionFollowSurface(
      'opencode',
      'link-generation-1',
    );
    expect(resolved.providerOps).not.toBe(fallbackOps);
    expect(resolved.providerOps.externalLinkedTakeoverWriterSafety).toBe('unsupported');
    expect(resolved.resource).toEqual({
      linkGeneration: 'link-generation-1',
      pluginGeneration: 'plugin-generation-1',
      retirementSignal: retirement.signal,
    });
    expect(activateAgentRuntimeContributionOnDemandMock).toHaveBeenCalledWith(
      registry,
      'opencode',
    );
    expect(resolveExecutionSurfacesMock).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

});
