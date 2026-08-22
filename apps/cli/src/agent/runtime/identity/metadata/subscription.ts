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
  let lastPublishedNativeIdentity: string | null = null;
  let lastPublishedDescriptor: unknown = undefined;
  let lastPublishedCapabilities: unknown = undefined;
  let lastPublishedFacets: unknown = undefined;

  const publishProviderSessionId = (
    rawProviderSessionId: unknown,
    rawNativeSessionLogPath?: unknown,
  ): void => {
    // An Agent with no catalog-declared flat `<vendor>SessionId` slot — every
    // external, manifest-contributed Agent — still publishes its native id
    // through the documented `provider-session-id` channel. Dropping the write
    // for want of a bundled key is what made an external Agent's Session
    // unresumable; the session-state binding owns where the id lands.
    const metadataKey = typeof params.providerSessionMetadataKey === 'string'
      && params.providerSessionMetadataKey.trim().length > 0
      ? params.providerSessionMetadataKey.trim()
      : null;
    const providerSessionId = typeof rawProviderSessionId === 'string'
      ? rawProviderSessionId.trim()
      : '';
    if (!providerSessionId) {
      return;
    }
    const nativeSessionLogPath = typeof rawNativeSessionLogPath === 'string'
      ? rawNativeSessionLogPath.trim() || null
      : null;
    // Dedupe on the matched PAIR, not the id alone. A runtime publishes its id
    // as soon as it knows it and the path of that session's log only once the
    // conversation materializes, so an id-keyed dedupe would suppress the very
    // update that carries the path and the successor Agent would be offered no
    // log to read.
    const nativeIdentityKey = `${providerSessionId}\u0000${nativeSessionLogPath ?? ''}`;
    if (lastPublishedNativeIdentity === nativeIdentityKey) {
      return;
    }
    const previousNativeIdentity = lastPublishedNativeIdentity;
    lastPublishedNativeIdentity = nativeIdentityKey;
    void params.sessionState.writeHappierField({
      sessionId: params.session.sessionId,
      fieldId: 'identity.providerSessionId',
      value: { metadataKey, value: providerSessionId, nativeSessionLogPath },
      reason: 'reconciliation',
      metadataReason: 'runtime-provider-session-id',
      mirrorToProvider: false,
    }).then((result) => {
      if (!result.ok && lastPublishedNativeIdentity === nativeIdentityKey) {
        lastPublishedNativeIdentity = previousNativeIdentity;
      }
    }).catch(() => {
      if (lastPublishedNativeIdentity === nativeIdentityKey) {
        lastPublishedNativeIdentity = previousNativeIdentity;
      }
    });
  };

  try {
    publishProviderSessionId(params.runtime.readSessionIdentity().sessionId);
  } catch {
    // A later runtime event can still publish identity after cold-read failure.
  }

  return params.runtime.subscribeRuntimeEvents((message) => {
    if ('kind' in message && message.kind === 'provider-session-id') {
      publishProviderSessionId(
        message.providerSessionId,
        'nativeSessionLogPath' in message ? message.nativeSessionLogPath : null,
      );
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
