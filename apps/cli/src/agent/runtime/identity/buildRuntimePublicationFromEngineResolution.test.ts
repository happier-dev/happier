import { describe, expect, it } from 'vitest';
import { normalizePluginBackendCapabilitiesV1 } from '@happier-dev/protocol';

import { createEmptyBackendExecutionSurfaces, type EngineAdapterResolution } from '@/agent/runtime/registry/engineRegistryTypes';
import { buildRuntimePublicationFromEngineResolution } from './buildRuntimePublicationFromEngineResolution';

function createEngineResolution(
  backendCapabilities: EngineAdapterResolution['backend']['capabilities'],
): EngineAdapterResolution {
  return {
    backendId: 'acme.backend',
    providerId: 'acme.provider',
    provenance: 'external',
    runtimeOwner: {
      backendId: 'acme.backend',
      selected: {
        kind: 'plugin_engine',
        ownerId: 'acme.plugin',
        provenance: 'external',
        pluginId: 'acme.plugin',
      },
      candidates: [{
        kind: 'plugin_engine',
        ownerId: 'acme.plugin',
        provenance: 'external',
        pluginId: 'acme.plugin',
      }],
    },
    backend: {
      id: 'acme.backend',
      providerId: 'acme.provider',
      provenance: 'external',
      source: { kind: 'path' },
      definition: {
        kindVersion: 1,
        id: 'acme.backend',
        providerId: 'acme.provider',
      },
      runtimeKind: 'plugin',
      capabilities: backendCapabilities,
    },
    provider: {
      id: 'acme.provider',
      provenance: 'external',
      source: { kind: 'path' },
      definition: {
        kindVersion: 1,
        id: 'acme.provider',
        ownedBackendIds: ['acme.backend'],
      },
    },
    engineAdapter: {
      runtimeCore: {
        createSessionRuntime() {
          throw new Error('unused test runtime');
        },
        createExecutionRunBackend() {
          throw new Error('unused test runtime');
        },
      },
    },
    executionSurfaces: createEmptyBackendExecutionSurfaces(),
    diagnostics: [],
  };
}

describe('buildRuntimePublicationFromEngineResolution', () => {
  it('uses nested backend execution-run capability as canonical publication support', () => {
    const publication = buildRuntimePublicationFromEngineResolution(
      createEngineResolution(normalizePluginBackendCapabilitiesV1({
        executionRun: { supported: false },
      })),
      { includeExecutionRun: true },
    );

    expect(publication.runtimeCapabilities).toEqual({
      executionRun: { supported: false },
      backend: {
        executionRun: { supported: false },
        session: {
          media: {
            acceptsImageInput: { supported: false },
            emitsSessionMedia: { supported: false },
            nativeImageGeneration: { supported: false },
          },
        },
      },
    });
  });
});
