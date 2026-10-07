import { readRuntimeDescriptorV1FromMetadata, type RuntimeDescriptorMetadataCarrier } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';
import { readAgentRuntimeFacetsV1, type AgentRuntimeFacetsV1 } from '@happier-dev/protocol/sessions/metadata/agentRuntimeFacetsV1';
import type { RuntimeDescriptorV1 } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';

type RuntimePublicationMetadata = RuntimeDescriptorMetadataCarrier & Readonly<{
    agentRuntimeCapabilitiesV1?: unknown;
    agentRuntimeFacetsV1?: unknown;
}>;

export type SessionRuntimePublicationState = Readonly<{
    descriptor: RuntimeDescriptorV1 | null;
    capabilities: unknown;
    facets: AgentRuntimeFacetsV1 | null;
}>;

export function readSessionRuntimePublicationState(
    metadata: RuntimePublicationMetadata | null | undefined,
): SessionRuntimePublicationState {
    return {
        descriptor: readRuntimeDescriptorV1FromMetadata(metadata),
        capabilities: metadata?.agentRuntimeCapabilitiesV1 ?? null,
        facets: readAgentRuntimeFacetsV1(metadata?.agentRuntimeFacetsV1),
    };
}
