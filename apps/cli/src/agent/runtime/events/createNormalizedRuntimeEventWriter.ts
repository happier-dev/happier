import type { AgentMessage } from '@/agent/core/AgentMessage';
import { isDeepStrictEqual } from 'node:util';
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

export type NormalizedRuntimeEventPublicationInput =
  | NormalizedRuntimeEventPublication
  | (() => NormalizedRuntimeEventPublication);

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
  identity: NormalizedRuntimeEventPublicationInput;
}>): RuntimeEventWriterState {
  let lastRuntimeDescriptor: RuntimeDescriptorV1 | null = null;
  let runtimeDescriptorSource: 'none' | 'fallback' | 'upstream' = 'none';
  let runtimeCapabilitiesPublished = false;
  let runtimeFacetsPublished = false;

  const readIdentity = (): NormalizedRuntimeEventPublication =>
    typeof params.identity === 'function' ? params.identity() : params.identity;

  const publishRuntimeDescriptor = (
    message: RuntimeEventMessage & Readonly<{ name: 'runtime.descriptor' }>,
    descriptor: RuntimeDescriptorV1,
    source: Exclude<typeof runtimeDescriptorSource, 'none'>,
  ): void => {
    runtimeDescriptorSource = source;
    if (lastRuntimeDescriptor && isDeepStrictEqual(lastRuntimeDescriptor, descriptor)) return;
    lastRuntimeDescriptor = descriptor;
    params.dispatch({
      ...message,
      payload: descriptor,
    });
  };

  const handleMessage = (message: AgentMessage): void => {
    if (isRuntimeDescriptorEvent(message)) {
      const normalizedDescriptor = readRuntimeDescriptorV1(message.payload);
      if (!normalizedDescriptor) return;
      publishRuntimeDescriptor(message, normalizedDescriptor, 'upstream');
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
    const identity = readIdentity();
    if (runtimeDescriptorSource !== 'upstream' && identity.runtimeDescriptor) {
      publishRuntimeDescriptor({
        type: 'event',
        name: 'runtime.descriptor',
        payload: identity.runtimeDescriptor,
      }, identity.runtimeDescriptor, 'fallback');
    }
    if (!runtimeCapabilitiesPublished && identity.runtimeCapabilities !== null && identity.runtimeCapabilities !== undefined) {
      runtimeCapabilitiesPublished = true;
      params.dispatch({
        type: 'event',
        name: 'runtime.capabilities',
        payload: identity.runtimeCapabilities,
      });
    }
    if (!runtimeFacetsPublished && identity.runtimeFacets !== null && identity.runtimeFacets !== undefined) {
      runtimeFacetsPublished = true;
      params.dispatch({
        type: 'event',
        name: 'runtime.facets',
        payload: identity.runtimeFacets,
      });
    }
  };

  return {
    handleMessage,
    publishFallbackIdentity,
  };
}
