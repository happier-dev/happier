import { isDeepStrictEqual } from 'node:util';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { Metadata } from '@/api/types';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import type { RuntimePublicationEvent } from '@/agent/runtime/turns/runtimeTurnOperations';
import {
  readRuntimeDescriptorV1,
  readAgentRuntimeFacetsV1,
} from '@happier-dev/protocol';
import type { SessionStateSyncEngine } from '@happier-dev/agents';

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
  session: Pick<ApiSessionClient, 'sessionId' | 'updateMetadata'>;
  sessionState: Pick<SessionStateSyncEngine, 'writeHappierField'>;
  runtime: RuntimeTurnOperations;
  providerSessionMetadataKey?: string | null;
}>): () => void {
  let lastPublishedProviderSessionId: string | null = null;
  let lastPublishedDescriptor: unknown = undefined;
  let lastPublishedCapabilities: unknown = undefined;
  let lastPublishedFacets: unknown = undefined;

  const publishProviderSessionId = (rawProviderSessionId: unknown): void => {
    const metadataKey = typeof params.providerSessionMetadataKey === 'string'
      ? params.providerSessionMetadataKey.trim()
      : '';
    const providerSessionId = typeof rawProviderSessionId === 'string'
      ? rawProviderSessionId.trim()
      : '';
    if (!metadataKey || !providerSessionId || lastPublishedProviderSessionId === providerSessionId) {
      return;
    }
    const previousProviderSessionId = lastPublishedProviderSessionId;
    lastPublishedProviderSessionId = providerSessionId;
    void params.sessionState.writeHappierField({
      sessionId: params.session.sessionId,
      fieldId: 'identity.providerSessionId',
      value: { metadataKey, value: providerSessionId },
      reason: 'reconciliation',
      metadataReason: 'runtime-provider-session-id',
      mirrorToProvider: false,
    }).then((result) => {
      if (!result.ok && lastPublishedProviderSessionId === providerSessionId) {
        lastPublishedProviderSessionId = previousProviderSessionId;
      }
    }).catch(() => {
      if (lastPublishedProviderSessionId === providerSessionId) {
        lastPublishedProviderSessionId = previousProviderSessionId;
      }
    });
  };

  try {
    publishProviderSessionId(params.runtime.readSessionIdentity().sessionId);
  } catch {
    // A later runtime event can still publish identity after cold-read failure.
  }

  return params.runtime.subscribeRuntimeEvents((message) => {
    if ('kind' in message && message.kind === 'session-id-publish') {
      publishProviderSessionId(message.publishedSessionId);
      return;
    }

    if (!isRuntimePublicationEvent(message)) {
      return;
    }

    if (message.name === 'runtime.descriptor') {
      const nextDescriptor = readRuntimeDescriptorV1(message.payload);
      if (isDeepStrictEqual(lastPublishedDescriptor, nextDescriptor)) {
        return;
      }
      const previousDescriptor = lastPublishedDescriptor;
      lastPublishedDescriptor = nextDescriptor;
      void params.sessionState.writeHappierField({
        sessionId: params.session.sessionId,
        fieldId: 'identity.runtimeDescriptor',
        value: nextDescriptor,
        reason: 'reconciliation',
        metadataReason: 'runtime-identity-publication',
      }).then((result) => {
        if (!result.ok && isDeepStrictEqual(lastPublishedDescriptor, nextDescriptor)) {
          lastPublishedDescriptor = previousDescriptor;
        }
      }).catch(() => {
        if (isDeepStrictEqual(lastPublishedDescriptor, nextDescriptor)) {
          lastPublishedDescriptor = previousDescriptor;
        }
      });
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
