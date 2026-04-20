import { isDeepStrictEqual } from 'node:util';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { Metadata } from '@/api/types';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import {
  readRuntimeDescriptorV1,
  readAgentRuntimeFacetsV1,
  writeRuntimeDescriptorV1ToMetadata,
} from '@happier-dev/protocol';

type RuntimePublicationEvent = Readonly<{
  type: 'event';
  name: 'runtime.descriptor' | 'runtime.capabilities' | 'runtime.facets';
  payload?: unknown;
}>;

function isRuntimePublicationEvent(message: unknown): message is RuntimePublicationEvent {
  if (!message || typeof message !== 'object') return false;
  const record = message as Readonly<Record<string, unknown>>;
  if (record.type !== 'event') return false;
  return record.name === 'runtime.descriptor'
    || record.name === 'runtime.capabilities'
    || record.name === 'runtime.facets';
}

function updateRuntimePublicationMetadata(
  metadata: Metadata,
  key: 'agentRuntimeCapabilitiesV1' | 'agentRuntimeFacetsV1',
  value: unknown,
): Metadata {
  if (value === null || value === undefined) {
    const { [key]: _removed, ...rest } = metadata as Metadata & Record<string, unknown>;
    return rest as Metadata;
  }
  return {
    ...metadata,
    [key]: value,
  };
}

export function subscribeSessionRuntimePublicationToMetadata(params: Readonly<{
  session: Pick<ApiSessionClient, 'updateMetadata'>;
  runtime: RuntimeTurnOperations;
}>): () => void {
  let lastPublishedDescriptor: unknown = undefined;
  let lastPublishedCapabilities: unknown = undefined;
  let lastPublishedFacets: unknown = undefined;

  return params.runtime.subscribeRuntimeMessages((message) => {
    if (!isRuntimePublicationEvent(message)) {
      return;
    }

    if (message.name === 'runtime.descriptor') {
      const nextDescriptor = readRuntimeDescriptorV1(message.payload);
      if (isDeepStrictEqual(lastPublishedDescriptor, nextDescriptor)) {
        return;
      }
      lastPublishedDescriptor = nextDescriptor;
      void params.session.updateMetadata((metadata) => writeRuntimeDescriptorV1ToMetadata(
        metadata as Metadata & Record<string, unknown>,
        nextDescriptor,
      ) as Metadata);
      return;
    }

    if (message.name === 'runtime.capabilities') {
      const nextCapabilities = message.payload ?? null;
      if (isDeepStrictEqual(lastPublishedCapabilities, nextCapabilities)) {
        return;
      }
      lastPublishedCapabilities = nextCapabilities;
      void params.session.updateMetadata((metadata) => updateRuntimePublicationMetadata(
        metadata,
        'agentRuntimeCapabilitiesV1',
        nextCapabilities,
      ));
      return;
    }

    const nextFacets = readAgentRuntimeFacetsV1(message.payload);
    if (isDeepStrictEqual(lastPublishedFacets, nextFacets)) {
      return;
    }
    lastPublishedFacets = nextFacets;
    void params.session.updateMetadata((metadata) => updateRuntimePublicationMetadata(
      metadata,
      'agentRuntimeFacetsV1',
      nextFacets,
    ));
  });
}
