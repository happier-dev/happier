import type { EngineAdapterResolution } from '@/agent/runtime/registry/engineRegistryTypes';
import type {
  AgentRuntimeFacetsV1,
  RuntimeDescriptorV1,
} from '@happier-dev/protocol';

import { buildPublishedRuntimeFacetsV1 } from '@/agent/runtime/facets/runtimeFacetsPublication';

export type EngineRuntimePublication = Readonly<{
  runtimeDescriptor: RuntimeDescriptorV1 | null;
  runtimeCapabilities: unknown;
  runtimeFacets: AgentRuntimeFacetsV1 | null;
}>;

function buildRuntimeCapabilities(
  resolution: EngineAdapterResolution,
  includeExecutionRun: boolean,
): unknown {
  const backendCapabilities = resolution.backend?.capabilities;
  if (!backendCapabilities) {
    return includeExecutionRun ? { executionRun: { supported: true } } : {};
  }
  const executionRunSupported = backendCapabilities?.executionRun?.supported !== false;
  // Catalog normalization defaults this leaf to false; only the opened dispatcher
  // knows whether this concrete transport accepts images.
  const { acceptsImageInput: _catalogImageInput, ...media } = backendCapabilities.session.media;
  return {
    ...(includeExecutionRun ? { executionRun: { supported: executionRunSupported } } : {}),
    backend: { ...backendCapabilities, session: { ...backendCapabilities.session, media } },
  };
}

export function buildRuntimePublicationFromEngineResolution(
  resolution: EngineAdapterResolution,
  options?: Readonly<{
    includeExecutionRun?: boolean;
  }>,
): EngineRuntimePublication {
  return {
    runtimeDescriptor: null,
    runtimeCapabilities: buildRuntimeCapabilities(
      resolution,
      options?.includeExecutionRun ?? true,
    ),
    runtimeFacets: buildPublishedRuntimeFacetsV1(resolution.engineAdapter.facets),
  };
}
