import type { AgentMessage } from '@/agent/core/AgentBackend';
import {
  readRuntimeDescriptorV1,
  readAgentRuntimeFacetsV1,
  type RuntimeDescriptorV1,
} from '@happier-dev/protocol';

export type NormalizedRuntimeEventPublication = Readonly<{
  runtimeDescriptor: RuntimeDescriptorV1 | null;
  runtimeCapabilities: unknown;
  runtimeFacets: unknown;
}>;

type RuntimeEventWriterState = Readonly<{
  handleMessage: (message: AgentMessage) => void;
  publishFallbackIdentity: () => void;
}>;

type RuntimeEventMessage = Extract<AgentMessage, Readonly<{ type: 'event' }>>;

function isRuntimeDescriptorEvent(message: AgentMessage): message is RuntimeEventMessage & Readonly<{ name: 'runtime.descriptor' }> {
  return message.type === 'event' && message.name === 'runtime.descriptor';
}

function isRuntimeCapabilitiesEvent(message: AgentMessage): message is RuntimeEventMessage & Readonly<{ name: 'runtime.capabilities' }> {
  return message.type === 'event' && message.name === 'runtime.capabilities';
}

function isRuntimeFacetsEvent(message: AgentMessage): message is RuntimeEventMessage & Readonly<{ name: 'runtime.facets' }> {
  return message.type === 'event' && message.name === 'runtime.facets';
}

/**
 * Canonical normalized runtime identity/capability/facet writer shared by the host bridges.
 * This is the concrete owner behind the superseded March `AgentConversationEventWriter` noun; it
 * only normalizes runtime publication events and does not imply a richer shared transcript/event
 * family beyond those published runtime surfaces.
 */
export function createNormalizedRuntimeEventWriter(params: Readonly<{
  dispatch: (message: AgentMessage) => void;
  identity: NormalizedRuntimeEventPublication;
}>): RuntimeEventWriterState {
  let runtimeDescriptorPublished = false;
  let runtimeCapabilitiesPublished = false;
  let runtimeFacetsPublished = false;

  const handleMessage = (message: AgentMessage): void => {
    if (isRuntimeDescriptorEvent(message)) {
      const normalizedDescriptor = readRuntimeDescriptorV1(message.payload);
      if (!normalizedDescriptor || runtimeDescriptorPublished) return;
      runtimeDescriptorPublished = true;
      params.dispatch({
        ...message,
        payload: normalizedDescriptor,
      });
      return;
    }
    if (isRuntimeCapabilitiesEvent(message)) {
      if (runtimeCapabilitiesPublished) return;
      runtimeCapabilitiesPublished = true;
      params.dispatch(message);
      return;
    }
    if (isRuntimeFacetsEvent(message)) {
      const normalizedFacets = readAgentRuntimeFacetsV1(message.payload);
      if (!normalizedFacets || runtimeFacetsPublished) return;
      runtimeFacetsPublished = true;
      params.dispatch({
        ...message,
        payload: normalizedFacets,
      });
      return;
    }
    params.dispatch(message);
  };

  const publishFallbackIdentity = (): void => {
    if (!runtimeDescriptorPublished && params.identity.runtimeDescriptor) {
      runtimeDescriptorPublished = true;
      params.dispatch({
        type: 'event',
        name: 'runtime.descriptor',
        payload: params.identity.runtimeDescriptor,
      });
    }
    if (!runtimeCapabilitiesPublished && params.identity.runtimeCapabilities !== null && params.identity.runtimeCapabilities !== undefined) {
      runtimeCapabilitiesPublished = true;
      params.dispatch({
        type: 'event',
        name: 'runtime.capabilities',
        payload: params.identity.runtimeCapabilities,
      });
    }
    if (!runtimeFacetsPublished && params.identity.runtimeFacets !== null && params.identity.runtimeFacets !== undefined) {
      runtimeFacetsPublished = true;
      params.dispatch({
        type: 'event',
        name: 'runtime.facets',
        payload: params.identity.runtimeFacets,
      });
    }
  };

  return {
    handleMessage,
    publishFallbackIdentity,
  };
}
