import type { AgentMessage } from '@/agent/core/AgentMessage';
import { isDeepStrictEqual } from 'node:util';
import { readRuntimeDescriptorV1 } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { readAgentRuntimeFacetsV1 } from '@happier-dev/protocol/sessions/metadata/agentRuntimeFacetsV1';
import type { AgentRuntimeFacetsV1, RuntimeDescriptorV1 } from '@happier-dev/protocol';

export type NormalizedRuntimeEventPublication = Readonly<{
  runtimeDescriptor: RuntimeDescriptorV1 | null;
  runtimeCapabilities: unknown;
  runtimeFacets: unknown;
}>;

/**
 * One typed host-private publication result per host-owned runtime fact.
 *
 * Host identity/capability/facet publication is not part of any Agent-authored
 * event union: the strict canonical `AgentSessionRuntimeEvent` family stays
 * exactly what an Agent may emit, and host-owned facts travel this typed
 * channel instead of a `{ type: 'event', name: 'runtime.*' }` pseudo-event
 * grafted beside it.
 */
export type NormalizedRuntimeIdentityPublicationV1 =
  | Readonly<{ fact: 'runtimeDescriptor'; value: RuntimeDescriptorV1 }>
  | Readonly<{ fact: 'runtimeCapabilities'; value: unknown }>
  | Readonly<{ fact: 'runtimeFacets'; value: AgentRuntimeFacetsV1 }>;

export type NormalizedRuntimeIdentityPublicationFact =
  NormalizedRuntimeIdentityPublicationV1['fact'];

const RUNTIME_IDENTITY_PUBLICATION_EVENT_NAME_BY_FACT = {
  runtimeDescriptor: 'runtime.descriptor',
  runtimeCapabilities: 'runtime.capabilities',
  runtimeFacets: 'runtime.facets',
} as const satisfies Readonly<Record<NormalizedRuntimeIdentityPublicationFact, string>>;

/**
 * Adapter for the legacy host-private `AgentMessage` transport, whose generic
 * `EventMessage` member is a real part of that family. The execution-run bridge
 * keeps consuming it; the strict Agent Session bridge does not.
 */
export function toRuntimeIdentityPublicationAgentMessage(
  publication: NormalizedRuntimeIdentityPublicationV1,
): Extract<AgentMessage, Readonly<{ type: 'event' }>> {
  return {
    type: 'event',
    name: RUNTIME_IDENTITY_PUBLICATION_EVENT_NAME_BY_FACT[publication.fact],
    payload: publication.value,
  };
}

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
  publishIdentity: (publication: NormalizedRuntimeIdentityPublicationV1) => void;
  identity: NormalizedRuntimeEventPublicationInput;
}>): RuntimeEventWriterState {
  let lastRuntimeDescriptor: RuntimeDescriptorV1 | null = null;
  let runtimeDescriptorSource: 'none' | 'fallback' | 'upstream' = 'none';
  let runtimeCapabilitiesPublished = false;
  let runtimeFacetsPublished = false;

  const readIdentity = (): NormalizedRuntimeEventPublication =>
    typeof params.identity === 'function' ? params.identity() : params.identity;

  const publishRuntimeDescriptor = (
    descriptor: RuntimeDescriptorV1,
    source: Exclude<typeof runtimeDescriptorSource, 'none'>,
  ): void => {
    runtimeDescriptorSource = source;
    if (lastRuntimeDescriptor && isDeepStrictEqual(lastRuntimeDescriptor, descriptor)) return;
    lastRuntimeDescriptor = descriptor;
    params.publishIdentity({ fact: 'runtimeDescriptor', value: descriptor });
  };

  const publishRuntimeCapabilities = (value: unknown): void => {
    if (runtimeCapabilitiesPublished) return;
    runtimeCapabilitiesPublished = true;
    params.publishIdentity({ fact: 'runtimeCapabilities', value });
  };

  const publishRuntimeFacets = (value: AgentRuntimeFacetsV1): void => {
    if (runtimeFacetsPublished) return;
    runtimeFacetsPublished = true;
    params.publishIdentity({ fact: 'runtimeFacets', value });
  };

  const handleMessage = (message: AgentMessage): void => {
    if (isRuntimeDescriptorEvent(message)) {
      const normalizedDescriptor = readRuntimeDescriptorV1(message.payload);
      if (!normalizedDescriptor) return;
      publishRuntimeDescriptor(normalizedDescriptor, 'upstream');
      return;
    }
    if (isRuntimeCapabilitiesEvent(message)) {
      publishRuntimeCapabilities(message.payload);
      return;
    }
    if (isRuntimeFacetsEvent(message)) {
      const normalizedFacets = readAgentRuntimeFacetsV1(message.payload);
      if (!normalizedFacets) return;
      publishRuntimeFacets(normalizedFacets);
      return;
    }
    params.dispatch(message);
  };

  const publishFallbackIdentity = (): void => {
    const identity = readIdentity();
    if (runtimeDescriptorSource !== 'upstream' && identity.runtimeDescriptor) {
      publishRuntimeDescriptor(identity.runtimeDescriptor, 'fallback');
    }
    if (identity.runtimeCapabilities !== null && identity.runtimeCapabilities !== undefined) {
      publishRuntimeCapabilities(identity.runtimeCapabilities);
    }
    const fallbackFacets = readAgentRuntimeFacetsV1(identity.runtimeFacets);
    if (fallbackFacets) {
      publishRuntimeFacets(fallbackFacets);
    }
  };

  return {
    handleMessage,
    publishFallbackIdentity,
  };
}
