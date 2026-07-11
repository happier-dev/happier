import { describe, expect, it, vi } from 'vitest';

import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';

import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import { resolveDefaultScmBackendRegistry } from './scmBackendCatalog';

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
    agentRuntimes: Object.freeze([]),
    actions: Object.freeze([]),
    resources: Object.freeze([]),
    uiDescriptors: Object.freeze([]),
    activationTargets: Object.freeze([]),
    hookRegistrations: Object.freeze([]),
    surfaceHandlersByBackendId: new Map(),
    catalogEntriesById: Object.freeze({}),
    agentDefinitionsById: new Map(),
    agentRuntimeDefinitionsById: new Map(),
    pluginDiagnosticsByPluginId: Object.freeze({}),
  };
}

function createRuntimeRegistry(contributes: ResolvedContributionRegistry): ResolvedExecutablePluginRuntimeRegistry {
  return {
    contributes,
    actionHandlersByActionId: new Map(),
    hookHandlersByHookId: new Map(),
    runtimeCoreHandlersByBackendId: new Map(),
    agentRuntimesByAgentId: new Map(),
    scmHostingProvidersById: new Map(),
    scmBackendsById: new Map(),
    scmBackendRegistrations: Object.freeze([]),
    networkAllowedUrlOriginsByPluginId: new Map(),
    processSpawnAllowedPathsByPluginId: new Map(),
    pluginDiagnosticsByPluginId: Object.freeze({}),
    activatedPluginIds: new Set(),
    activatePluginsByEvent: async () => [],
    addRuntimeDisposable: (_pluginId, disposable) => disposable,
    readHookEventEnvelopeV1,
    dispose: async () => {},
  };
}

describe('resolveDefaultScmBackendRegistry runtime lease convergence', () => {
  it('uses the authoritative plugin runtime lease for the default backend registry', async () => {
    const runtimeRegistry = createRuntimeRegistry(createContributionRegistry('authoritative-scm-runtime'));
    acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({
      registry: runtimeRegistry,
      source: 'active',
      release: releaseLeaseMock,
    });
    releaseLeaseMock.mockResolvedValue(undefined);

    await resolveDefaultScmBackendRegistry();

    expect(acquireAuthoritativePluginRuntimeRegistryLeaseMock).toHaveBeenCalledTimes(1);
    expect(releaseLeaseMock).toHaveBeenCalledTimes(1);
  });
});
