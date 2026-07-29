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

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildRuntimeDescriptor(
  resolution: EngineAdapterResolution,
  descriptorSchemaId: string,
): RuntimeDescriptorV1 | null {
  const agentId = normalizeNonEmptyString(resolution.agentId ?? resolution.agent?.id);
  const backendId = normalizeNonEmptyString(resolution.backendId ?? resolution.backend?.id);
  const runtimeKind = normalizeNonEmptyString(resolution.backend?.runtimeKind);
  if (!agentId || !backendId || !runtimeKind) return null;

  return {
    v: 1,
    agentId,
    agent: {
      backendMode: runtimeKind,
      agentExtra: {
        owner: 'happier',
        schemaId: descriptorSchemaId,
        v: 1,
        runtimeHandle: {
          backendId,
          agentId,
          // Prefer the shared provenance model over legacy built_in/plugin source strings.
          provenance: resolution.provenance,
        },
      },
    },
  };
}

function buildRuntimeCapabilities(
  resolution: EngineAdapterResolution,
  includeExecutionRun: boolean,
): unknown {
  const backendCapabilities = resolution.backend?.capabilities;
  const executionRunSupported = backendCapabilities?.executionRun?.supported !== false;
  return {
    ...(includeExecutionRun ? { executionRun: { supported: executionRunSupported } } : {}),
    ...(backendCapabilities && Object.keys(backendCapabilities).length > 0
      ? { backend: backendCapabilities }
      : {}),
  };
}

export function buildRuntimePublicationFromEngineResolution(
  resolution: EngineAdapterResolution,
  options?: Readonly<{
    descriptorSchemaId?: string;
    includeExecutionRun?: boolean;
  }>,
): EngineRuntimePublication {
  return {
    runtimeDescriptor: buildRuntimeDescriptor(
      resolution,
      options?.descriptorSchemaId ?? 'happier.executionRunRuntimeIdentity',
    ),
    runtimeCapabilities: buildRuntimeCapabilities(
      resolution,
      options?.includeExecutionRun ?? true,
    ),
    runtimeFacets: buildPublishedRuntimeFacetsV1(resolution.engineAdapter.facets),
  };
}
