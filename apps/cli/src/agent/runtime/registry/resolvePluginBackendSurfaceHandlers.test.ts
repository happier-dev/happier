import { describe, expect, it } from 'vitest';

import { createResolvedContributionRegistry } from '../../../plugins/projection/registry/createResolvedContributionRegistry';
import type {
  ResolvedAgentContribution,
  ResolvedAgentRuntimeContribution,
} from '../../../plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

import { resolvePluginBackendSurfaceHandlers } from './resolvePluginBackendSurfaceHandlers';

function createAgentContribution(): ResolvedAgentContribution {
  return {
    id: 'acme.runtime',
    provenance: 'external',
    source: { kind: 'path' },
    definition: {
      kindVersion: 1,
      id: 'acme.runtime',
      ownedBackendIds: ['acme.runtime.backend'],
    },
  };
}

function createBackendContribution(): ResolvedAgentRuntimeContribution {
  return {
    id: 'acme.runtime.backend',
    agentId: 'acme.runtime',
    provenance: 'external',
    source: { kind: 'path' },
    definition: {
      kindVersion: 1,
      id: 'acme.runtime.backend',
      agentId: 'acme.runtime',
    },
    runtimeKind: 'acp',
    pluginId: 'acme.runtime',
  };
}

function createRuntimeRegistry(
  backend: ResolvedAgentRuntimeContribution,
  agent: ResolvedAgentContribution,
): ResolvedExecutablePluginRuntimeRegistry {
  return {
    contributes: createResolvedContributionRegistry({
      agents: [agent],
    }),
    resolvePromptAssetBlocks: async () => [],
    activatedPluginIds: new Set(),
    activateContributionsOnDemand: async () => [],
    hookHandlersByHookId: new Map(),
    agentRuntimesByAgentId: new Map(),
    scmHostingProvidersById: new Map(),
    pluginDiagnosticsByPluginId: Object.freeze({}),
    addRuntimeDisposable: (_pluginId, disposable) => disposable,
    createAgentInvocationServices: async () => createUnavailablePluginServices(),
    retireConsumers: () => undefined,
    dispose: async () => undefined,
  };
}

describe('resolvePluginBackendSurfaceHandlers', () => {
  it('keeps registered activated Agent runtimes off the retired static handler path', async () => {
    const backend = createBackendContribution();
    const agent = createAgentContribution();

    const result = await resolvePluginBackendSurfaceHandlers({
      backend,
      agent,
      runtimeRegistry: createRuntimeRegistry(backend, agent),
      hasRegisteredAgentRuntime: true,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result).not.toHaveProperty('surfaces');
  });

  it('reports an unregistered runtime without reconstructing a static handler registry', async () => {
    const backend = createBackendContribution();
    const agent = createAgentContribution();

    const result = await resolvePluginBackendSurfaceHandlers({
      backend,
      agent,
      runtimeRegistry: createRuntimeRegistry(backend, agent),
    });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'engine_plugin_backend_surface_missing',
        backendId: backend.id,
        agentId: agent.id,
        pluginId: backend.pluginId,
      }),
    ]);
  });
});
