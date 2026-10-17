import { isDeepStrictEqual } from 'node:util';

import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { Metadata } from '@/api/types';
import type { RuntimeTurnOperations, RuntimeTurnMessageHandler } from '@/agent/runtime/turns/runtimeTurnOperations';
import type { SessionStateSyncEngine } from '@happier-dev/agents';
import { SessionCapabilityAgentFactsV1Schema, type CapabilityApplyTimingInputV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';
import type { RuntimeDescriptorV1 } from '@happier-dev/protocol';
import { logger } from '@/ui/logger';

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
  runtime: Pick<RuntimeTurnOperations, 'readSessionIdentity' | 'subscribeRuntimeIdentityPublication'>;
  providerSessionMetadataKey?: string | null;
  /** Shared-editor runtimes retain runtime-local publications but cannot write owner metadata. */
  publishOwnerMetadata?: boolean;
  capabilitySelection?: CapabilityApplyTimingInputV1['agent'];
  resolveCapabilitySelectionForDescriptor?: (descriptor: RuntimeDescriptorV1) => Promise<CapabilityApplyTimingInputV1['agent']>;
}>): (() => void) & Readonly<{ observeRuntimeEvent: RuntimeTurnMessageHandler }> {
  let lastPublishedNativeIdentity: string | null = null;
  let lastPublishedDescriptor: unknown = undefined;
  let lastPublishedCapabilities: unknown = undefined;
  let lastPublishedFacets: unknown = undefined;
  let capabilitySelection = params.capabilitySelection;
  let disposed = false;
  const publishCapabilitySelection = (): void => {
    if (!capabilitySelection || params.publishOwnerMetadata === false || disposed) return;
    const facts = SessionCapabilityAgentFactsV1Schema.parse(capabilitySelection);
    void params.session.updateMetadata(metadata => {
      const capabilities = metadata.agentRuntimeCapabilitiesV1;
      return { ...metadata, agentRuntimeCapabilitiesV1: { ...(capabilities ?? {}), capabilitySelection: facts } };
    }).catch(() => {
      logger.debug('[RuntimePublication] Capability selection facts publication unavailable');
    });
  };
  publishCapabilitySelection();

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
    // The Agent minted this id; Happier stores it and hands it straight back.
    // Presence is the only judgement made here -- the bytes are identity.
    const providerSessionId = readNonBlankOpaqueIdentifier(rawProviderSessionId);
    if (providerSessionId === null) {
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

  // The Session lifecycle feeds this observer from its canonical event watch.
  const observeRuntimeEvent: RuntimeTurnMessageHandler = (message) => {
    if (disposed) return;
    if (message.kind === 'provider-session-id') {
      publishProviderSessionId(
        message.providerSessionId,
        'nativeSessionLogPath' in message ? message.nativeSessionLogPath : null,
      );
    }
  };

  const unsubscribeIdentityPublication = params.runtime.subscribeRuntimeIdentityPublication?.(
    (publication) => {
      if (publication.fact === 'runtimeDescriptor') {
        const nextDescriptor = publication.value;
        if (isDeepStrictEqual(lastPublishedDescriptor, nextDescriptor)) {
          return;
        }
        const previousDescriptor = lastPublishedDescriptor;
        lastPublishedDescriptor = nextDescriptor;
        if (params.resolveCapabilitySelectionForDescriptor) {
          void params.resolveCapabilitySelectionForDescriptor(nextDescriptor).then(facts => {
            if (disposed || !isDeepStrictEqual(lastPublishedDescriptor, nextDescriptor)) return;
            capabilitySelection = SessionCapabilityAgentFactsV1Schema.parse(facts);
            publishCapabilitySelection();
          }).catch(() => {
            if (disposed || !isDeepStrictEqual(lastPublishedDescriptor, nextDescriptor) || !capabilitySelection) return;
            capabilitySelection = { ...capabilitySelection, vendorResume: 'unsupported' };
            publishCapabilitySelection();
          });
        }
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

      if (publication.fact === 'runtimeCapabilities') {
        if (params.publishOwnerMetadata === false) return;
        const nativeCapabilities = publication.value;
        const nextCapabilities = capabilitySelection ? {
          ...(nativeCapabilities !== null && typeof nativeCapabilities === 'object' && !Array.isArray(nativeCapabilities) ? nativeCapabilities : {}),
          capabilitySelection,
        } : nativeCapabilities ?? null;
        if (isDeepStrictEqual(lastPublishedCapabilities, nextCapabilities)) {
          return;
        }
        lastPublishedCapabilities = nextCapabilities;
        void params.session.updateMetadata((metadata) => updateRuntimePublicationMetadata(
          metadata,
          'agentRuntimeCapabilitiesV1',
          nextCapabilities,
        )).catch(() => {
          logger.debug('[RuntimePublication] Native capabilities publication unavailable');
        });
        return;
      }

      const nextFacets = publication.value;
      if (params.publishOwnerMetadata === false) return;
      if (isDeepStrictEqual(lastPublishedFacets, nextFacets)) {
        return;
      }
      lastPublishedFacets = nextFacets;
      void params.session.updateMetadata((metadata) => updateRuntimePublicationMetadata(
        metadata,
        'agentRuntimeFacetsV1',
        nextFacets,
      ));
    },
  );

  return Object.assign(() => {
    disposed = true;
    unsubscribeIdentityPublication?.();
  }, { observeRuntimeEvent });
}
